// js/sync.js — online-save layer (phase 1.5 §3.4/§5, replaces phase-1 js/store.js request storage).
// One "session" per (pcu, month): holds the in-memory request (server truth merged with any
// still-unsaved local edits), tracks which lines/meta are dirty, mirrors dirty data to
// localStorage so nothing is lost offline, and debounces calls to `saveLines`.
import { call, ApiError, getPcuToken } from "./api.js";
import * as store from "./store.js";

const DEBOUNCE_MS = 2000;
const RETRY_DELAYS_MS = [5000, 15000, 30000];

const sessions = new Map(); // `${pcu}:${month}` -> session

function key(pcu, month) {
  return `${pcu}:${month}`;
}

function mirrorKey(pcu, month) {
  return `pcuSupply15:mirror:${pcu}:${month}`;
}

function loadMirror(pcu, month) {
  return store.getJSON(mirrorKey(pcu, month), null);
}

function saveMirror(session) {
  const dirtyLines = {};
  session.dirtyLines.forEach((code) => {
    if (session.request.lines[code]) dirtyLines[code] = session.request.lines[code];
  });
  if (!Object.keys(dirtyLines).length && !session.dirtyMeta) {
    store.safeRemove(mirrorKey(session.pcu, session.month));
    return;
  }
  store.setJSON(mirrorKey(session.pcu, session.month), {
    lines: dirtyLines,
    last_step: session.request.last_step,
    submitter_name: session.request.submitter_name,
    dirtyMeta: session.dirtyMeta,
  });
}

function clearMirror(pcu, month) {
  store.safeRemove(mirrorKey(pcu, month));
}

function blankRequest(pcu, month) {
  return {
    pcu,
    month,
    // Virtual client-side status: nothing exists on the server for this pcu+month yet. Becomes
    // "draft" as soon as the first saveLines() call succeeds (the server always creates drafts).
    status: "not_started",
    return_reason: "",
    submitter_name: "",
    last_step: "",
    created_at: "",
    updated_at: "",
    submitted_at: "",
    received_at: "",
    lines: {},
  };
}

// Initializes (or re-initializes) a session from the server's RequestObj (or null = not started
// yet). Merges in any local mirror lines that are still dirty and newer than the server's copy —
// spec §9.5 "on load, if the local mirror has dirty lines newer than the server's, re-send them".
export function initSession(pcu, month, serverRequest) {
  const request = serverRequest
    ? JSON.parse(JSON.stringify(serverRequest))
    : blankRequest(pcu, month);

  const session = {
    pcu,
    month,
    request,
    dirtyLines: new Set(),
    dirtyMeta: false,
    saveTimer: null,
    retryTimer: null,
    retryIdx: 0,
    saving: false,
    lastSavedAt: null,
    offline: false,
    listeners: new Set(),
  };

  const mirror = loadMirror(pcu, month);
  if (mirror && mirror.lines && (request.status === "draft" || request.status === "not_started")) {
    Object.keys(mirror.lines).forEach((code) => {
      const mLine = mirror.lines[code];
      const sLine = request.lines[code];
      if (!sLine || String(mLine.updated_at || "") >= String(sLine.updated_at || "")) {
        request.lines[code] = mLine;
        session.dirtyLines.add(code);
      }
    });
    if (mirror.dirtyMeta) {
      if (mirror.last_step) request.last_step = mirror.last_step;
      if (mirror.submitter_name !== undefined) request.submitter_name = mirror.submitter_name;
      session.dirtyMeta = true;
    }
  }

  sessions.set(key(pcu, month), session);
  if (session.dirtyLines.size || session.dirtyMeta) {
    scheduleSave(session, 0);
  }
  return session;
}

export function getSession(pcu, month) {
  return sessions.get(key(pcu, month)) || null;
}

function statusOf(session, override) {
  let state = override;
  if (!state) {
    if (session.saving) state = "saving";
    else if (session.offline) state = "offline";
    else if (session.dirtyLines.size || session.dirtyMeta) state = "pending";
    else state = "idle";
  }
  return { state, lastSavedAt: session.lastSavedAt, dirty: session.dirtyLines.size > 0 || session.dirtyMeta };
}

function notify(session, override) {
  const status = statusOf(session, override);
  session.listeners.forEach((fn) => {
    try {
      fn(status);
    } catch (err) {
      console.error(err);
    }
  });
}

// Subscribes to status changes for one session; returns an unsubscribe function. Calls `fn`
// immediately with the current status.
export function subscribe(pcu, month, fn) {
  const session = getSession(pcu, month);
  if (!session) return () => {};
  session.listeners.add(fn);
  fn(statusOf(session));
  return () => session.listeners.delete(fn);
}

export function getLine(pcu, month, code) {
  const session = getSession(pcu, month);
  if (!session) return { stock: null, op: 0, pp: 0 };
  return session.request.lines[code] || { stock: null, op: 0, pp: 0 };
}

export function setLine(pcu, month, code, field, value) {
  const session = getSession(pcu, month);
  if (!session) return;
  // Always a NEW object: an in-flight save holds a snapshot of the previous one, and the
  // "unchanged since sent?" check in doSave must see edits made while the request was in flight.
  const line = { ...(session.request.lines[code] || { stock: null, op: 0, pp: 0, updated_at: "" }) };
  line[field] = value;
  line.updated_at = new Date().toISOString();
  session.request.lines[code] = line;
  session.dirtyLines.add(code);
  saveMirror(session);
  scheduleSave(session);
}

export function setLastStep(pcu, month, stepCode) {
  const session = getSession(pcu, month);
  if (!session) return;
  if (session.request.last_step === stepCode) return;
  session.request.last_step = stepCode;
  session.dirtyMeta = true;
  saveMirror(session);
}

export function setSubmitterName(pcu, month, name) {
  const session = getSession(pcu, month);
  if (!session) return;
  session.request.submitter_name = name;
  session.dirtyMeta = true;
  saveMirror(session);
  scheduleSave(session);
}

function scheduleSave(session, delayMs = DEBOUNCE_MS) {
  if (session.saveTimer) clearTimeout(session.saveTimer);
  session.saveTimer = setTimeout(() => {
    session.saveTimer = null;
    doSave(session);
  }, delayMs);
}

function scheduleRetry(session) {
  if (session.retryTimer) clearTimeout(session.retryTimer);
  const delay = RETRY_DELAYS_MS[Math.min(session.retryIdx, RETRY_DELAYS_MS.length - 1)];
  session.retryIdx++;
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    doSave(session);
  }, delay);
}

async function doSave(session) {
  if (session.saveTimer) {
    clearTimeout(session.saveTimer);
    session.saveTimer = null;
  }
  if (!session.dirtyLines.size && !session.dirtyMeta) return;
  if (session.saving) return;
  session.saving = true;
  notify(session, "saving");

  const linesPayload = {};
  session.dirtyLines.forEach((code) => {
    if (session.request.lines[code]) linesPayload[code] = { ...session.request.lines[code] }; // snapshot
  });
  const lastStepSent = session.request.last_step;
  const nameSent = session.request.submitter_name;

  try {
    const data = await call(
      "saveLines",
      {
        month: session.month,
        lines: linesPayload,
        last_step: lastStepSent || undefined,
        submitter_name: nameSent,
      },
      { token: getPcuToken() }
    );

    Object.keys(linesPayload).forEach((code) => {
      const cur = session.request.lines[code];
      if (cur && cur.updated_at === linesPayload[code].updated_at) session.dirtyLines.delete(code);
    });
    if (session.request.last_step === lastStepSent && session.request.submitter_name === nameSent) {
      session.dirtyMeta = false;
    }

    const serverReq = data.request;
    if (serverReq) {
      Object.keys(serverReq.lines || {}).forEach((code) => {
        if (!session.dirtyLines.has(code)) session.request.lines[code] = serverReq.lines[code];
      });
      session.request.status = serverReq.status;
      session.request.updated_at = serverReq.updated_at;
      session.request.created_at = serverReq.created_at || session.request.created_at;
      if (!session.dirtyMeta) {
        session.request.last_step = serverReq.last_step;
        session.request.submitter_name = serverReq.submitter_name;
      }
    }

    session.lastSavedAt = new Date();
    session.retryIdx = 0;
    session.offline = false;
    saveMirror(session);
    session.saving = false;
    notify(session, session.dirtyLines.size || session.dirtyMeta ? "pending" : "saved");
    if (session.dirtyLines.size || session.dirtyMeta) scheduleSave(session, 200);
  } catch (err) {
    session.saving = false;
    if (err instanceof ApiError && err.code === "NETWORK") {
      session.offline = true;
      notify(session, "offline");
      scheduleRetry(session);
    } else if (err instanceof ApiError && err.code === "CONFLICT") {
      // Someone else (or this PCU on another device) already submitted/received this request —
      // stop trying to autosave; the UI should reload the request from the server.
      session.dirtyLines.clear();
      session.dirtyMeta = false;
      clearMirror(session.pcu, session.month);
      notify(session, "conflict");
    } else {
      notify(session, "error");
      console.error("saveLines failed", err);
    }
  }
}

// Flushes any pending debounce/retry immediately (spec §5: "before submit/withdraw/navigate to
// print flush first"). Returns a promise that resolves once the in-flight save (if any) settles.
export async function flush(pcu, month) {
  const session = getSession(pcu, month);
  if (!session) return;
  if (session.saveTimer) {
    clearTimeout(session.saveTimer);
    session.saveTimer = null;
  }
  if (session.retryTimer) {
    clearTimeout(session.retryTimer);
    session.retryTimer = null;
    session.retryIdx = 0;
  }
  if (session.dirtyLines.size || session.dirtyMeta) {
    await doSave(session);
  }
}

export async function submitRequest(pcu, month) {
  await flush(pcu, month);
  const data = await call("submit", { month }, { token: getPcuToken() });
  const session = getSession(pcu, month);
  if (session) {
    session.request = data.request;
    session.dirtyLines.clear();
    session.dirtyMeta = false;
    clearMirror(pcu, month);
    notify(session, "saved");
  }
  return data.request;
}

export async function withdrawRequest(pcu, month) {
  const data = await call("withdraw", { month }, { token: getPcuToken() });
  const session = getSession(pcu, month);
  if (session) {
    session.request = data.request;
    notify(session, "saved");
  }
  return data.request;
}

export function hasDirty(pcu, month) {
  const session = getSession(pcu, month);
  return !!session && (session.dirtyLines.size > 0 || session.dirtyMeta);
}

export function anyDirty() {
  for (const session of sessions.values()) {
    if (session.dirtyLines.size > 0 || session.dirtyMeta) return true;
  }
  return false;
}

// Retries every offline session — called on the browser's `online` event.
export function retryAllOffline() {
  sessions.forEach((session) => {
    if (session.offline) {
      session.retryIdx = 0;
      doSave(session);
    }
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("online", retryAllOffline);
}

// "ล้างข้อมูลในเครื่องนี้ (ออกจากระบบ)" — wipes every local mirror (all PCUs/months this browser
// ever touched) without touching the server. Does NOT clear the PCU token; callers should also
// call clearPcuToken() from js/api.js when logging out.
export function clearAllLocalMirrors() {
  store.safeKeys()
    .filter((k) => k.startsWith("pcuSupply15:mirror:"))
    .forEach((k) => store.safeRemove(k));
  sessions.clear();
}
