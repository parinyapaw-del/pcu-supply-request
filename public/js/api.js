// js/api.js — browser client for the Apps Script backend (API.md "Transport").
// Shared by both frontends (index.html PCU pages + admin.html). Do not add PCU/admin-specific
// logic here — this file only knows how to call the API and store tokens.
import { API_URL } from "./config.js";

const TIMEOUT_MS = 30000;
const STORAGE_PREFIX = "pcuSupply15:";
const PCU_TOKEN_KEY = STORAGE_PREFIX + "pcuToken";
const PCU_TOKEN_EXP_KEY = STORAGE_PREFIX + "pcuTokenExp";
const ADMIN_TOKEN_KEY = STORAGE_PREFIX + "adminToken";
const ADMIN_TOKEN_EXP_KEY = STORAGE_PREFIX + "adminTokenExp";

export class ApiError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = "ApiError";
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/**
 * Calls one backend action.
 * @param {string} action
 * @param {object} [params]
 * @param {{token?: string}} [opts]
 * @returns {Promise<object>} the `data` field of a successful response
 * @throws {ApiError}
 */
export async function call(action, params = {}, opts = {}) {
  const body = JSON.stringify({ action, token: opts.token, ...params });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      signal: controller.signal
    });
  } catch (err) {
    throw new ApiError("NETWORK", "ติดต่อเซิร์ฟเวอร์ไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ต", { cause: String(err && err.message) });
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new ApiError("NETWORK", "เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง");
  }

  if (!json || json.ok !== true) {
    const err = (json && json.error) || {};
    throw new ApiError(err.code || "SERVER_ERROR", err.message || "เกิดข้อผิดพลาด", err);
  }
  return json.data;
}

// ---- token storage (localStorage; every access wrapped so a private/blocked browser never throws) ----
function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch (err) { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch (err) { /* ignore (private mode, quota, ...) */ }
}
function storageRemove(key) {
  try { window.localStorage.removeItem(key); } catch (err) { /* ignore */ }
}

export function getPcuToken() { return storageGet(PCU_TOKEN_KEY); }
export function setPcuToken(token, exp) {
  storageSet(PCU_TOKEN_KEY, token);
  if (exp) storageSet(PCU_TOKEN_EXP_KEY, exp);
}
export function clearPcuToken() {
  storageRemove(PCU_TOKEN_KEY);
  storageRemove(PCU_TOKEN_EXP_KEY);
}

export function getAdminToken() { return storageGet(ADMIN_TOKEN_KEY); }
export function setAdminToken(token, exp) {
  storageSet(ADMIN_TOKEN_KEY, token);
  if (exp) storageSet(ADMIN_TOKEN_EXP_KEY, exp);
}
export function clearAdminToken() {
  storageRemove(ADMIN_TOKEN_KEY);
  storageRemove(ADMIN_TOKEN_EXP_KEY);
}

/**
 * Decodes a token's payload WITHOUT verifying its signature — for display only (exp, pcu, ...).
 * Never trust this for authorization; the server re-verifies on every call.
 */
export function decodeTokenPayload(token) {
  if (!token || typeof token !== "string") return null;
  const partA = token.split(".")[0];
  if (!partA) return null;
  try {
    const b64 = partA.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}
