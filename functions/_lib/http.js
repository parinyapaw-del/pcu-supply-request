// http.js — JSON helpers and the ApiError type shared by every action. No route is exported from this file.

export class ApiError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    this.extra = extra || null;
  }
}

export const err = (code, message, extra) => new ApiError(code, message, extra);

export function jsonResponse(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export const okResponse = (data) => jsonResponse({ ok: true, data });

export function errorBody(e, env) {
  if (e instanceof ApiError) {
    return { ok: false, error: { code: e.code, message: e.message, ...(e.extra || {}) } };
  }
  console.error("SERVER_ERROR", e && e.stack ? e.stack : e);
  const body = { ok: false, error: { code: "SERVER_ERROR", message: "ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง" } };
  if (env && env.DEV_FAKE_GOOGLE === "1") body.error.detail = String(e && e.message);
  return body;
}

export async function readJson(request, maxBytes = 50 * 1024 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) throw err("BAD_REQUEST", "ข้อมูลใหญ่เกินไป");
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw err("BAD_REQUEST", "รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)");
  }
}

// ---- small validators -------------------------------------------------------------------------
export function assertQty(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 99999) {
    throw err("BAD_REQUEST", "จำนวนต้องเป็นเลขจำนวนเต็ม 0–99999 หรือว่าง");
  }
  return n;
}

// integer >= 0 or null (limits)
export function assertLimitValue(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw err("BAD_REQUEST", "ค่าเพดานต้องเป็นจำนวนเต็ม ≥ 0 หรือว่าง");
  }
  return n;
}

export const isStr = (v) => typeof v === "string";
export const jparse = (s, fallback) => {
  try { return s === null || s === undefined ? fallback : JSON.parse(s); } catch { return fallback; }
};

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
