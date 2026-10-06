// js/sync.js — online-save layer (phase 2: functions/API.md §3/§4 `saveLines`).
// One "session" per (pcu, month): holds the in-memory request (server truth merged with any still-unsaved
// local edits), tracks which lines/meta are dirty, mirrors dirty data to localStorage so nothing is lost
// offline, debounces autosave (2 s) and performs the "send" (= saveLines{send:true}, spec §4.3).
// Lines use `null` for empty (stock/op/pp) — what the server stores.
import { call, ApiError, getPcuToken } from "./api.js";
import { STORAGE_PREFIX } from "./constants.js";
import * as store from "./store.js";

const DEBOUNCE_MS = 2000;
const RETRY_DELAYS_MS = [5000, 15000, 30000];
const MIRROR_PREFIX = STORAGE_PREFIX + "mirror:";

const sessions = new Map(); // `${pcu}:${month}` -> session

function key(pcu, month) {
  return `${pcu}:${month}`;
}

function mirrorKey(pcu, month) {
  return `${MIRROR_PREFIX}${pcu}:${month}`;
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
    // Virtual client-side status: nothing exists on the server for this pcu+month yet. Becomes "draft" as soon
    // as the first saveLines() call succeeds (the server creates the row as a draft).
    status: "not_started",
    form_version_id: null,
    submitter_name: "",
    last_step: "",
    created_at: "",
    updated_at: "",
    first_submitted_at: null,
    submitted_at: null,
    submit_count: 0,
    admin_note: null,
    admin_note_at: null,
    issued_seen_at: null,
    edited_after_submit: false,
    lines: {},
  };
}

function cloneLine(l) {
  return { stock: l.stock == null ? null : l.stock, op: l.op == null ? null : l.op, pp: l.pp == null ? null : l.pp, updated_at: l.updated_at || "" };
}

// Initializes (or refreshes) a session from the server's RequestObj (or null = not started yet).
// - New session: merges in any local mirror lines that are still dirty and newer than the server's copy
//   ("on load, if the local mirror has dirty lines newer than the server's, re-send them").
// - Existing session (bootstrap refresh on the home page): server meta (status, admin_note, ...) is taken from
//   the server, but lines that are dirty / in flight locally are kept — a refresh must never eat typed values.
export function initSession(pcu, month, serverRequest) {
  const existing = sessions.get(key(pcu, month));
  const request = serverRequest ? JSON.parse(JSON.stringify(serverRequest)) : blankRequest(pcu, month);
  request.lines = request.lines || {};

  if (existing) {
    existing.dirtyLines.forEach((code) => {
      if (existing.request.lines[code]) request.lines[code] = existing.request.lines[code];
    });
    if (existing.dirtyMeta) {
      request.last_step = existing.request.last_step;
      request.submitter_name = existing.request.submitter_name;
    }
    if (existing.dirtyLines.size && request.submitted_at) request.edited_after_submit = true;
    existing.request = request;
    return existing;
  }

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
    savePromise: null,
    lastOutcome: "ok", // ok | offline | error | conflict
    lastSavedAt: null,
    offline: false,
    conflict: false, // server said CONFLICT: round locked (or step already issued) -> read-only
    listeners: new Set(),
  };

  const mirror = loadMirror(pcu, month);
  if (mirror && mirror.lines) {
    Object.keys(mirror.lines).forEach((code) => {
      const mLine = mirror.lines[code];
      const sLine = request.lines[code];
      if (!sLine || String(mLine.updated_at || "") >= String(sLine.updated_at || "")) {
        request.lines[code] = mLine;
        session.dirtyLines.add(code);
      }
    });
    if (session.dirtyLines.size && request.submitted_at) request.edited_after_submit = true;
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
    if (session.conflict) state = "conflict";
    else if (session.saving) state = "saving";
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

// Subscribes to status changes for one session; returns an unsubscribe function. Calls `fn` immediately.
export function subscribe(pcu, month, fn) {
  const session = getSession(pcu, month);
  if (!session) return () => {};
  session.listeners.add(fn);
  fn(statusOf(session));
  return () => session.listeners.delete(fn);
}

export function getLine(pcu, month, code) {
  const session = getSession(pcu, month);
  if (!session) return { stock: null, op: null, pp: null };
  return session.request.lines[code] || { stock: null, op: null, pp: null };
}

// value: integer or null (empty).
export function setLine(pcu, month, code, field, value) {
  const session = getSession(pcu, month);
  if (!session || session.conflict) return;
  // Always a NEW object: an in-flight save holds a snapshot of the previous one, and the
  // "unchanged since sent?" check in doSave must see edits made while the request was in flight.
  const line = { ...(session.request.lines[code] || { stock: null, op: null, pp: null, updated_at: "" }) };
  line[field] = value;
  line.updated_at = new Date().toISOString();
  session.request.lines[code] = line;
  session.dirtyLines.add(code);
  // Editing a submitted request: shown as "ส่งแล้ว (มีการแก้ไขยังไม่บันทึก)" until the next send.
  if (session.request.submitted_at) session.request.edited_after_submit = true;
  saveMirror(session);
  scheduleSave(session);
}

export function setLastStep(pcu, month, stepCode) {
  const session = getSession(pcu, month);
  if (!session || session.conflict) return;
  if (session.request.last_step === stepCode) return;
  session.request.last_step = stepCode;
  session.dirtyMeta = true;
  saveMirror(session);
}

export function setSubmitterName(pcu, month, name) {
  const session = getSession(pcu, month);
  if (!session || session.conflict) return;
  session.request.submitter_name = name;
  session.dirtyMeta = true;
  saveMirror(session);
  scheduleSave(session);
}

function scheduleSave(session, delayMs = DEBOUNCE_MS) {
  if (session.conflict) return;
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

// Applies the RequestObj the server returned to the session without clobbering still-dirty lines.
function applyServerRequest(session, serverReq) {
  if (!serverReq) return;
  Object.keys(serverReq.lines || {}).forEach((code) => {
    if (!session.dirtyLines.has(code)) session.request.lines[code] = serverReq.lines[code];
  });
  const r = session.request;
  r.status = serverReq.status;
  r.updated_at = serverReq.updated_at;
  r.created_at = serverReq.created_at || r.created_at;
  r.form_version_id = serverReq.form_version_id;
  r.first_submitted_at = serverReq.first_submitted_at;
  r.submitted_at = serverReq.submitted_at;
  r.submit_count = serverReq.submit_count;
  r.admin_note = serverReq.admin_note;
  r.admin_note_at = serverReq.admin_note_at;
  r.issued_seen_at = serverReq.issued_seen_at;
  r.edited_after_submit = !!serverReq.edited_after_submit || (!!r.submitted_at && session.dirtyLines.size > 0);
  if (!session.dirtyMeta) {
    r.last_step = serverReq.last_step;
    r.submitter_name = serverReq.submitter_name;
  }
}

function doSave(session) {
  if (session.saving) return session.savePromise;
  if (session.saveTimer) {
    clearTimeout(session.saveTimer);
    session.saveTimer = null;
  }
  if (session.conflict || (!session.dirtyLines.size && !session.dirtyMeta)) return Promise.resolve();
  session.saving = true;
  notify(session, "saving");
  session.savePromise = runSave(session).finally(() => {
    session.saving = false;
    session.savePromise = null;
  });
  return session.savePromise;
}

async function runSave(session) {
  // Snapshot what is being sent (spec 1.5 §10.4 bug 3): later edits create NEW line objects, so the
  // "unchanged since sent?" check below keeps lines edited while this request was in flight dirty.
  const linesPayload = {};
  session.dirtyLines.forEach((code) => {
    if (session.request.lines[code]) linesPayload[code] = cloneLine(session.request.lines[code]);
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

    applyServerRequest(session, data.request);

    session.lastSavedAt = new Date();
    session.retryIdx = 0;
    session.offline = false;
    session.lastOutcome = "ok";
    saveMirror(session);
    notify(session, session.dirtyLines.size || session.dirtyMeta ? "pending" : "saved");
    if (session.dirtyLines.size || session.dirtyMeta) scheduleSave(session, 200);
  } catch (err) {
    if (err instanceof ApiError && err.code === "NETWORK") {
      session.offline = true;
      session.lastOutcome = "offline";
      notify(session, "offline");
      scheduleRetry(session);
    } else if (err instanceof ApiError && err.code === "CONFLICT") {
      // Round locked (or the step was already issued): nothing more can be saved — go read-only; the UI
      // shows "รอบนี้ปิดรับแล้ว". Unsaved local edits are dropped (the server refused them).
      session.conflict = true;
      session.conflictMessage = err.message || "";
      session.lastOutcome = "conflict";
      session.dirtyLines.clear();
      session.dirtyMeta = false;
      clearMirror(session.pcu, session.month);
      notify(session, "conflict");
    } else {
      session.lastOutcome = "error";
      notify(session, "error");
      console.error("saveLines failed", err);
    }
  }
}

// Flushes any pending debounce/retry immediately and waits until everything dirty is on the server (or a
// save failed — check `lastOutcome`/`hasDirty` afterwards). Safe to call while a save is in flight.
export async function flush(pcu, month) {
  const session = getSession(pcu, month);
  if (!session) return;
  for (let i = 0; i < 6; i++) {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
    }
    if (session.retryTimer) {
      clearTimeout(session.retryTimer);
      session.retryTimer = null;
      session.retryIdx = 0;
    }
    if (session.saving) await session.savePromise;
    if (!session.dirtyLines.size && !session.dirtyMeta) return;
    if (session.conflict) return;
    await doSave(session);
    if (session.lastOutcome !== "ok") return;
  }
}

/**
 * Send = saveLines{send:true} (what บันทึก / พิมพ์ do). Flushes autosave first, then sends. Throws ApiError:
 * INCOMPLETE{missing} · OVER_LIMIT{items} · CONFLICT · NETWORK (also thrown when the flush could not reach the server).
 * @returns {Promise<{submitted:boolean, over_limit:Array, request:object}>}
 */
export async function sendRequest(pcu, month) {
  await flush(pcu, month);
  const session = getSession(pcu, month);
  if (!session) throw new ApiError("NOT_FOUND", "ไม่พบข้อมูลรอบนี้");
  if (session.conflict) throw new ApiError("CONFLICT", session.conflictMessage || "รอบนี้ปิดรับแล้ว");
  if (session.dirtyLines.size || session.dirtyMeta) {
    throw new ApiError("NETWORK", "ยังบันทึกขึ้น server ไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
  }
  const r = session.request;
  try {
    const data = await call(
      "saveLines",
      { month, lines: {}, last_step: r.last_step || undefined, submitter_name: r.submitter_name || "", send: true },
      { token: getPcuToken() }
    );
    applyServerRequest(session, data.request);
    session.lastSavedAt = new Date();
    notify(session, "saved");
    return data;
  } catch (err) {
    if (err instanceof ApiError && err.code === "CONFLICT") {
      session.conflict = true;
      session.conflictMessage = err.message || "";
      notify(session, "conflict");
    }
    throw err;
  }
}

/**
 * Discards local state of a month and re-reads it from the server (pcuGetMonth) — used after a CONFLICT (round locked),
 * when the server refused the local edits. Keeps `conflict` set. Returns the pcuGetMonth data (incl. `round`).
 */
export async function reloadSession(pcu, month) {
  const session = getSession(pcu, month);
  if (!session) return null;
  const data = await call("pcuGetMonth", { month }, { token: getPcuToken() });
  session.dirtyLines.clear();
  session.dirtyMeta = false;
  clearMirror(pcu, month);
  session.request = data.request ? JSON.parse(JSON.stringify(data.request)) : blankRequest(pcu, month);
  session.request.lines = session.request.lines || {};
  notify(session);
  return data;
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

// Forgets every session (logout) — pending local mirrors stay in localStorage so unsent edits survive a re-login.
export function resetSessions() {
  sessions.forEach((s) => {
    if (s.saveTimer) clearTimeout(s.saveTimer);
    if (s.retryTimer) clearTimeout(s.retryTimer);
  });
  sessions.clear();
}

// "ล้างข้อมูลในเครื่องนี้ (ออกจากระบบ)" — wipes every local mirror (all PCUs/months this browser ever touched)
// without touching the server. Callers should also clear the PCU token.
export function clearAllLocalMirrors() {
  store.safeKeys()
    .filter((k) => k.startsWith(MIRROR_PREFIX))
    .forEach((k) => store.safeRemove(k));
  resetSessions();
}
