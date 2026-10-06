// Auth.js — PIN hashing, HMAC tokens, Google tokeninfo verification, backup admin password.

// ---- generic API error (thrown, caught by Main.js doPost) -----------------------------------
function apiError_(code, message, extra) {
  var e = new Error(message);
  e.code = code;
  if (extra) {
    for (var k in extra) if (extra.hasOwnProperty(k)) e[k] = extra[k];
  }
  return e;
}

// ---- hashing ----------------------------------------------------------------------------------
function bytesToHex_(bytes) {
  var hex = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    var h = b.toString(16);
    hex += h.length === 1 ? "0" + h : h;
  }
  return hex;
}

function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

function hmacHex_(str, secret) {
  var bytes = Utilities.computeHmacSha256Signature(str, secret, Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

function randomSalt_() {
  return Utilities.getUuid();
}

function hashPin_(pin, salt) {
  return sha256Hex_(salt + ":" + pin);
}

// Not truly constant-time (JS can't guarantee that) but avoids the obvious short-circuit
// early-return-on-first-mismatch pattern.
function constantTimeEq_(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Script Properties ------------------------------------------------------------------------
function getTokenSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("TOKEN_SECRET");
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("TOKEN_SECRET", secret);
  }
  return secret;
}

// ---- tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret)) ----------
function b64url_(str) {
  return Utilities.base64EncodeWebSafe(str, Utilities.Charset.UTF_8);
}

function signToken_(payload) {
  var partA = b64url_(JSON.stringify(payload));
  var sigBytes = Utilities.computeHmacSha256Signature(partA, getTokenSecret_(), Utilities.Charset.UTF_8);
  var partB = Utilities.base64EncodeWebSafe(sigBytes);
  return partA + "." + partB;
}

// Verifies signature + returns the decoded payload, or throws apiError_ AUTH_EXPIRED.
function decodeAndVerifyToken_(token) {
  if (!token || typeof token !== "string" || token.indexOf(".") === -1) {
    throw apiError_("AUTH_EXPIRED", "เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่");
  }
  var parts = token.split(".");
  if (parts.length !== 2) throw apiError_("AUTH_EXPIRED", "เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่");
  var partA = parts[0], partB = parts[1];
  var expectedSigBytes = Utilities.computeHmacSha256Signature(partA, getTokenSecret_(), Utilities.Charset.UTF_8);
  var expectedSig = Utilities.base64EncodeWebSafe(expectedSigBytes);
  if (!constantTimeEq_(expectedSig, partB)) {
    throw apiError_("AUTH_EXPIRED", "เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่");
  }
  var jsonStr;
  var payload;
  try {
    var decodedBytes = Utilities.base64DecodeWebSafe(partA);
    jsonStr = Utilities.newBlob(decodedBytes).getDataAsString();
    payload = JSON.parse(jsonStr);
  } catch (err) {
    throw apiError_("AUTH_EXPIRED", "เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่");
  }
  if (!payload || !payload.exp || Date.now() > payload.exp) {
    throw apiError_("AUTH_EXPIRED", "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  }
  return payload;
}

function makePcuToken_(pcuCode, pinVersion) {
  var exp = Date.now() + PCU_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  var payload = { t: "pcu", pcu: pcuCode, v: pinVersion, exp: exp };
  return { token: signToken_(payload), exp: new Date(exp).toISOString() };
}

function makeAdminToken_(sub, backupVersion) {
  var exp = Date.now() + ADMIN_TOKEN_HOURS * 60 * 60 * 1000;
  var payload = { t: "admin", sub: sub, v: backupVersion || 0, exp: exp };
  return { token: signToken_(payload), exp: new Date(exp).toISOString() };
}

// Verifies a PCU token, checks pin_version still matches the stored pcu row (invalidated when
// admin changes the PIN), and returns { pcu: <pcu row object> }. A PCU token can only ever act on
// its own pcu — every PCU action reads pcu from the TOKEN, never from a request parameter.
function requirePcuAuth_(token) {
  if (!token) throw apiError_("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบ");
  var payload = decodeAndVerifyToken_(token);
  if (payload.t !== "pcu") throw apiError_("FORBIDDEN", "ไม่มีสิทธิ์เข้าถึง");
  var pcus = readTable_(SHEET_NAMES.PCUS);
  var row = null;
  for (var i = 0; i < pcus.length; i++) {
    if (pcus[i].code === payload.pcu) { row = pcus[i]; break; }
  }
  if (!row) throw apiError_("AUTH_EXPIRED", "ไม่พบ รพ.สต. นี้ กรุณาเข้าสู่ระบบใหม่");
  var storedVersion = Number(row.pin_version || 1);
  if (Number(payload.v) !== storedVersion) {
    throw apiError_("AUTH_EXPIRED", "PIN ถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่");
  }
  return row;
}

// Verifies an admin token (Google-signed-in admin OR backup password admin).
// Returns { email: <string|"backup"> }.
function requireAdminAuth_(token) {
  if (!token) throw apiError_("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบผู้ดูแล");
  var payload = decodeAndVerifyToken_(token);
  if (payload.t !== "admin") throw apiError_("FORBIDDEN", "ไม่มีสิทธิ์เข้าถึง");
  if (payload.sub === "backup") {
    var curVersion = Number(getBackupVersion_());
    if (Number(payload.v) !== curVersion) {
      throw apiError_("AUTH_EXPIRED", "รหัสสำรองถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่");
    }
    return { email: "backup" };
  }
  // Google-signed-in admin: must still be listed in `admins`.
  var admins = readTable_(SHEET_NAMES.ADMINS);
  var found = admins.some(function (a) { return String(a.email || "").toLowerCase() === String(payload.sub).toLowerCase(); });
  if (!found) throw apiError_("FORBIDDEN", "บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ");
  return { email: payload.sub };
}

// Requires a Google-signed-in admin specifically (not the backup password) — used for
// adminSetBackupPassword so the backup password can't be used to change itself.
function requireGoogleAdminAuth_(token) {
  var admin = requireAdminAuth_(token);
  if (admin.email === "backup") throw apiError_("FORBIDDEN", "ต้อง Sign in with Google เท่านั้น");
  return admin;
}

// ---- backup admin password (Script Properties) -------------------------------------------------
function getBackupVersion_() {
  return PropertiesService.getScriptProperties().getProperty("BACKUP_VERSION") || "0";
}

function setBackupPassword_(password, updatedBy) {
  var salt = randomSalt_();
  var hash = sha256Hex_(salt + ":" + password);
  var props = PropertiesService.getScriptProperties();
  var nextVersion = String(Number(getBackupVersion_()) + 1);
  props.setProperties({
    BACKUP_PW_HASH: hash,
    BACKUP_PW_SALT: salt,
    BACKUP_VERSION: nextVersion,
    BACKUP_FAIL: "0",
    BACKUP_LOCKED_UNTIL: ""
  });
}

// Google ID token verification via tokeninfo (cached 5 min per id_token).
function verifyGoogleIdToken_(idToken) {
  var cache = CacheService.getScriptCache();
  var cacheKey = "gtok:" + sha256Hex_(idToken);
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  var resp = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken), {
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw apiError_("FORBIDDEN", "ยืนยันตัวตน Google ไม่สำเร็จ");
  }
  var data = JSON.parse(resp.getContentText());
  if (data.aud !== GOOGLE_CLIENT_ID) throw apiError_("FORBIDDEN", "Client ID ไม่ถูกต้อง");
  if (String(data.email_verified) !== "true") throw apiError_("FORBIDDEN", "อีเมลยังไม่ยืนยัน");
  cache.put(cacheKey, JSON.stringify(data), 300);
  return data;
}
