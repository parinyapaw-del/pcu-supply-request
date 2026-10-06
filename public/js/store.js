// Safe localStorage primitives + tiny per-viewer preferences (last PCU used) + the cached login
// bootstrap (offline resume). Every read/write is wrapped in try/catch with an in-memory fallback so the
// app keeps working (for the current page load) if storage throws (private browsing, quota exceeded, ...).
// Request data itself is NOT stored here (the server is the source of truth) — see js/sync.js for the
// online-save layer + its local "dirty lines" mirror, which reuses these primitives.
import { LAST_PCU_KEY, STORAGE_PREFIX } from "./constants.js";

const memoryFallback = new Map();
let storageBroken = false;

export function safeGet(key) {
  try {
    if (!storageBroken) return window.localStorage.getItem(key);
  } catch (e) {
    storageBroken = true;
  }
  return memoryFallback.has(key) ? memoryFallback.get(key) : null;
}

export function safeSet(key, value) {
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

export function safeRemove(key) {
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

export function safeKeys() {
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

export function getJSON(key, fallback) {
  const raw = safeGet(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function setJSON(key, value) {
  try {
    safeSet(key, JSON.stringify(value));
  } catch (e) {
    // JSON.stringify shouldn't throw for our plain data, but stay defensive
  }
}

// ---- last-used PCU (per-viewer convenience, prefills the login page) ----
export function getLastPcu() {
  return safeGet(LAST_PCU_KEY);
}
export function setLastPcu(pcuCode) {
  safeSet(LAST_PCU_KEY, pcuCode);
}

// ---- cached bootstrap (offline resume; one per PCU — never contains PIN/token) ----
const BOOT_PREFIX = STORAGE_PREFIX + "bootstrap:";
export function getCachedBootstrap(pcuCode) {
  return getJSON(BOOT_PREFIX + pcuCode, null);
}
export function setCachedBootstrap(pcuCode, boot) {
  setJSON(BOOT_PREFIX + pcuCode, boot);
}
export function clearCachedBootstraps() {
  safeKeys().filter((k) => k.startsWith(BOOT_PREFIX)).forEach((k) => safeRemove(k));
}
