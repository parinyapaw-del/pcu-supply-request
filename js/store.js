// localStorage access layer. Every read/write is wrapped in try/catch so the app
// keeps working (in-memory only, for the current page load) if storage throws
// (private browsing, quota exceeded, disabled cookies, etc).
import { STORAGE_PREFIX, LIMIT_MODE_KEY, LAST_PCU_KEY, DEFAULT_LIMIT_MODE } from "./constants.js";

// In-memory fallback store, used only when localStorage itself is unavailable.
const memoryFallback = new Map();
let storageBroken = false;

function rawGet(key) {
  try {
    if (!storageBroken) return window.localStorage.getItem(key);
  } catch (e) {
    storageBroken = true;
  }
  return memoryFallback.has(key) ? memoryFallback.get(key) : null;
}

function rawSet(key, value) {
  try {
    if (!storageBroken) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch (e) {
    storageBroken = true;
  }
  memoryFallback.set(key, value);
}

function rawRemove(key) {
  try {
    if (!storageBroken) {
      window.localStorage.removeItem(key);
      return;
    }
  } catch (e) {
    storageBroken = true;
  }
  memoryFallback.delete(key);
}

function rawKeys() {
  try {
    if (!storageBroken) return Object.keys(window.localStorage);
  } catch (e) {
    storageBroken = true;
  }
  return Array.from(memoryFallback.keys());
}

export function isStorageBroken() {
  return storageBroken;
}

function getJSON(key, fallback) {
  const raw = rawGet(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function setJSON(key, value) {
  try {
    rawSet(key, JSON.stringify(value));
  } catch (e) {
    // JSON.stringify shouldn't throw for our plain data, but stay defensive
  }
}

// ---- last-used PCU (per-viewer convenience) ----
export function getLastPcu() {
  return rawGet(LAST_PCU_KEY);
}
export function setLastPcu(pcuCode) {
  rawSet(LAST_PCU_KEY, pcuCode);
}

// ---- global demo limit-mode toggle (read by PCU side, set by fake admin page) ----
export function getLimitMode() {
  return rawGet(LIMIT_MODE_KEY) || DEFAULT_LIMIT_MODE;
}
export function setLimitMode(mode) {
  rawSet(LIMIT_MODE_KEY, mode === "enforce" ? "enforce" : "warn");
}

// ---- hidden items, permanent per PCU (all months) ----
function hiddenKey(pcu) {
  return `${STORAGE_PREFIX}hidden:${pcu}`;
}
export function getHiddenItems(pcu) {
  return getJSON(hiddenKey(pcu), []);
}
export function setHiddenItems(pcu, codes) {
  setJSON(hiddenKey(pcu), Array.from(new Set(codes)));
}
export function hideItem(pcu, itemCode) {
  const cur = getHiddenItems(pcu);
  if (!cur.includes(itemCode)) setHiddenItems(pcu, [...cur, itemCode]);
}
export function unhideItem(pcu, itemCode) {
  setHiddenItems(pcu, getHiddenItems(pcu).filter((c) => c !== itemCode));
}

// ---- request records: one per PCU x month, covering every active step ----
function requestKey(pcu, monthKey) {
  return `${STORAGE_PREFIX}request:${pcu}:${monthKey}`;
}

export function getRequest(pcu, monthKey) {
  return getJSON(requestKey(pcu, monthKey), null);
}

export function saveRequest(pcu, monthKey, request) {
  setJSON(requestKey(pcu, monthKey), request);
}

export function deleteRequest(pcu, monthKey) {
  rawRemove(requestKey(pcu, monthKey));
}

function blankRequest(pcu, monthKey) {
  return {
    pcu,
    monthKey,
    status: "draft", // draft | submitted
    submitter_name: "",
    lines: {}, // item_code -> { stock: number|null, op: number, pp: number }
    price_snapshot: {}, // item_code -> price, filled at submit time
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    submitted_at: null,
    late: false,
  };
}

export function getOrCreateRequest(pcu, monthKey) {
  return getRequest(pcu, monthKey) || blankRequest(pcu, monthKey);
}

// All requests for a PCU, keyed by monthKey (only ones that actually exist).
export function listRequestsForPcu(pcu) {
  const prefix = `${STORAGE_PREFIX}request:${pcu}:`;
  const out = {};
  for (const key of rawKeys()) {
    if (key.startsWith(prefix)) {
      const monthKey = key.slice(prefix.length);
      const val = getJSON(key, null);
      if (val) out[monthKey] = val;
    }
  }
  return out;
}

// ---- wipe every demo key (used by "ล้างข้อมูลทดลองทั้งหมด") ----
export function clearAllDemoData() {
  for (const key of rawKeys()) {
    if (key.startsWith(STORAGE_PREFIX)) rawRemove(key);
  }
  memoryFallback.clear();
}
