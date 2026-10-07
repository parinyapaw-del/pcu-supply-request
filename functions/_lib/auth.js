// auth.js — HMAC tokens, PIN / backup-password hashing, Google tokeninfo, PCU + staff authorisation.
import { err, sha256Hex, jparse } from "./http.js";

export const PIN_LENGTH = 5;
export const PIN_MAX_FAIL = 5;
export const PIN_LOCK_MIN = 5;
export const PCU_TOKEN_DAYS = 7;
export const STAFF_TOKEN_HOURS = 12;
export const BACKUP_MAX_FAIL = 5;
export const BACKUP_LOCK_MIN = 15;
export const UNITS = ["พัสดุ", "จ่ายกลาง", "LAB"];
export const DEFAULT_PIN = "12345";
// pcus."group" values (2n). TRIAL_GROUP = sandbox PCUs (e.g. PCU00) — excluded from totals / budget / Excel export.
export const PCU_GROUPS = ["ทั่วไป", "พิเศษ", "ทดลอง"];
export const TRIAL_GROUP = "ทดลอง";

// ---- encoding ----------------------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlFromBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function bytesFromB64url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function constantTimeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const newSalt = () => crypto.randomUUID();
export const hashSecret = (secret, salt) => sha256Hex(`${salt}:${secret}`);

// ---- tokens ------------------------------------------------------------------------------------------
async function hmacKey(env) {
  if (!env.TOKEN_SECRET) throw err("SERVER_ERROR", "ยังไม่ได้ตั้งค่า TOKEN_SECRET");
  return crypto.subtle.importKey("raw", enc.encode(env.TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signToken(env, payload) {
  const partA = b64urlFromBytes(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(partA)));
  return `${partA}.${b64urlFromBytes(sig)}`;
}

const BAD_SESSION = "เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่";

export async function verifyToken(env, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) throw err("AUTH_EXPIRED", BAD_SESSION);
  const parts = token.split(".");
  if (parts.length !== 2) throw err("AUTH_EXPIRED", BAD_SESSION);
  const [partA, partB] = parts;
  let expected;
  try {
    expected = b64urlFromBytes(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(partA))));
  } catch (e) {
    if (e && e.code) throw e;
    throw err("AUTH_EXPIRED", BAD_SESSION);
  }
  if (!constantTimeEq(expected, partB)) throw err("AUTH_EXPIRED", BAD_SESSION);
  let payload;
  try { payload = JSON.parse(dec.decode(bytesFromB64url(partA))); } catch { throw err("AUTH_EXPIRED", BAD_SESSION); }
  if (!payload || !payload.exp || Date.now() > payload.exp) throw err("AUTH_EXPIRED", "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  return payload;
}

export async function makePcuToken(env, pcuCode, pinVersion) {
  const exp = Date.now() + PCU_TOKEN_DAYS * 86400000;
  return { token: await signToken(env, { t: "pcu", pcu: pcuCode, v: pinVersion, exp }), exp: new Date(exp).toISOString() };
}

export async function makeStaffToken(env, role, sub, backupVersion) {
  const exp = Date.now() + STAFF_TOKEN_HOURS * 3600000;
  return { token: await signToken(env, { t: role, sub, v: backupVersion || 0, exp }), exp: new Date(exp).toISOString() };
}

// ---- PCU authorisation ----------------------------------------------------------------------------------------
// Returns the pcus row. The PCU an action works on is ALWAYS this row (token.pcu), never a request param.
export async function requirePcu(env, DB, token) {
  if (!token) throw err("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบ");
  const payload = await verifyToken(env, token);
  if (payload.t !== "pcu") throw err("FORBIDDEN", "ไม่มีสิทธิ์เข้าถึง");
  const row = await DB.prepare(`SELECT code, name, print_name, "group" AS grp, pin_version, pin_custom FROM pcus WHERE code = ?`).bind(payload.pcu).first();
  if (!row) throw err("AUTH_EXPIRED", "ไม่พบ รพ.สต. นี้ กรุณาเข้าสู่ระบบใหม่");
  if (Number(payload.v) !== Number(row.pin_version || 1)) throw err("AUTH_EXPIRED", "PIN ถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่");
  return row;
}

export const pcuPublic = (row) => ({ code: row.code, name: row.name, print_name: row.print_name || row.name, group: row.grp ?? row.group });

// ---- staff (admin / dispenser) ---------------------------------------------------------------------------------------
export function envAdmins(env) {
  return String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// effective role for an email: users table; when the table is empty, ADMIN_EMAILS are admins.
export async function lookupUser(env, DB, email) {
  const e = String(email || "").toLowerCase();
  const row = await DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users) AS n, (SELECT role FROM users WHERE email = ?1) AS role, (SELECT units FROM users WHERE email = ?1) AS units`
  ).bind(e).first();
  if (row && row.role) return { email: e, role: row.role, units: row.role === "admin" ? [...UNITS] : jparse(row.units, []) };
  if (row && Number(row.n) === 0 && envAdmins(env).includes(e)) return { email: e, role: "admin", units: [...UNITS] };
  return null;
}

// Verifies a staff token and returns {email, role, units, backup}. `roles` limits the allowed roles.
export async function requireStaff(env, DB, token, roles = ["admin"]) {
  if (!token) throw err("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบผู้ดูแล");
  const payload = await verifyToken(env, token);
  if (payload.t !== "admin" && payload.t !== "dispenser") throw err("FORBIDDEN", "ไม่มีสิทธิ์เข้าถึง");
  let who;
  if (payload.sub === "backup") {
    const r = await DB.prepare(`SELECT value FROM config WHERE key = 'backup_version'`).first();
    const cur = Number(jparse(r && r.value, 0)) || 0;
    if (Number(payload.v) !== cur) throw err("AUTH_EXPIRED", "รหัสสำรองถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่");
    who = { email: "backup", role: "admin", units: [...UNITS], backup: true };
  } else {
    const u = await lookupUser(env, DB, payload.sub);
    if (!u) throw err("FORBIDDEN", "บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ");
    who = { ...u, backup: false };
  }
  if (!roles.includes(who.role)) throw err("FORBIDDEN", "ไม่มีสิทธิ์ทำรายการนี้");
  return who;
}

// ---- Google ID token ---------------------------------------------------------------------------------------------------
const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo?id_token=";
const googleCache = new Map(); // id_token -> {email, until}

export async function verifyGoogleIdToken(env, idToken) {
  if (typeof idToken !== "string" || idToken.length < 4 || idToken.length > 4096) throw err("BAD_REQUEST", "id_token ไม่ถูกต้อง");
  if (env.DEV_FAKE_GOOGLE === "1" && idToken.startsWith("dev:")) {
    const email = idToken.slice(4).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw err("BAD_REQUEST", "id_token ไม่ถูกต้อง");
    return email;
  }
  const hit = googleCache.get(idToken);
  if (hit && hit.until > Date.now()) return hit.email;
  let res;
  try { res = await fetch(TOKENINFO + encodeURIComponent(idToken)); } catch { throw err("FORBIDDEN", "ยืนยันตัวตน Google ไม่สำเร็จ"); }
  if (res.status !== 200) throw err("FORBIDDEN", "ยืนยันตัวตน Google ไม่สำเร็จ");
  let info;
  try { info = await res.json(); } catch { throw err("FORBIDDEN", "ยืนยันตัวตน Google ไม่สำเร็จ"); }
  if (!env.GOOGLE_CLIENT_ID || info.aud !== env.GOOGLE_CLIENT_ID) throw err("FORBIDDEN", "Client ID ไม่ถูกต้อง");
  if (String(info.email_verified) !== "true") throw err("FORBIDDEN", "อีเมลยังไม่ยืนยัน");
  if (typeof info.email !== "string" || !info.email) throw err("FORBIDDEN", "ไม่พบอีเมลใน token");
  const email = info.email.toLowerCase();
  googleCache.set(idToken, { email, until: Date.now() + 300000 });
  if (googleCache.size > 200) googleCache.delete(googleCache.keys().next().value);
  return email;
}
