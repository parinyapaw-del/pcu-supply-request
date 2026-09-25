// Main.js — HTTP entry points (doPost/doGet) and the action dispatch table.
// Transport: POST body is a JSON string { action, token?, ...params }; response is always HTTP 200
// with { ok:true, data } or { ok:false, error:{ code, message, ...extra } } (API.md "Transport").

var SERVICE_VERSION_ = "1.5.0";

// Built lazily (not as an eager top-level literal) so this never depends on the order Apps
// Script happens to load Admin.js/Pcu.js relative to Main.js — top-level code in one file can run
// before another file's top-level code, but by the time any function is actually CALLED (i.e. by
// the time doPost runs), every file has finished loading and every action_* function exists.
//
// auth: "public" (no token) | "pcu" (PCU token, sets auth.pcuRow) |
//       "admin" (any admin token, sets auth.adminEmail = email|"backup") |
//       "googleAdmin" (Google-signed-in admin only, e.g. for adminSetBackupPassword)
var ACTIONS_CACHE_ = null;
function getActionsMap_() {
  if (ACTIONS_CACHE_) return ACTIONS_CACHE_;
  ACTIONS_CACHE_ = {
    pcuList: { fn: action_pcuList, auth: "public" },
    pcuLogin: { fn: action_pcuLogin, auth: "public" },
    pcuBootstrap: { fn: action_pcuBootstrap, auth: "pcu" },
    saveLines: { fn: action_saveLines, auth: "pcu" },
    submit: { fn: action_submit, auth: "pcu" },
    withdraw: { fn: action_withdraw, auth: "pcu" },
    setHidden: { fn: action_setHidden, auth: "pcu" },

    adminLoginGoogle: { fn: action_adminLoginGoogle, auth: "public" },
    adminLoginBackup: { fn: action_adminLoginBackup, auth: "public" },
    adminBootstrap: { fn: action_adminBootstrap, auth: "admin" },
    adminRequests: { fn: action_adminRequests, auth: "admin" },
    adminGetRequest: { fn: action_adminGetRequest, auth: "admin" },
    adminReceive: { fn: action_adminReceive, auth: "admin" },
    adminReturn: { fn: action_adminReturn, auth: "admin" },
    adminSetLimit: { fn: action_adminSetLimit, auth: "admin" },
    adminResetLimit: { fn: action_adminResetLimit, auth: "admin" },
    adminSetMode: { fn: action_adminSetMode, auth: "admin" },
    adminSetPin: { fn: action_adminSetPin, auth: "admin" },
    adminUnlockPin: { fn: action_adminUnlockPin, auth: "admin" },
    adminSetHidden: { fn: action_adminSetHidden, auth: "admin" },
    adminSetBackupPassword: { fn: action_adminSetBackupPassword, auth: "googleAdmin" },
    adminClearTrial: { fn: action_adminClearTrial, auth: "admin" }
  };
  return ACTIONS_CACHE_;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function errorToPayload_(err) {
  var code = (err && err.code) || "SERVER_ERROR";
  var message = (err && err.message) || "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์";
  var payload = { code: code, message: message };
  if (err) {
    for (var k in err) {
      if (err.hasOwnProperty(k) && k !== "code" && k !== "message" && k !== "stack") payload[k] = err[k];
    }
  }
  return payload;
}

function handleAction_(req) {
  var entry = req && req.action ? getActionsMap_()[req.action] : null;
  if (!entry) throw apiError_("BAD_REQUEST", "ไม่รู้จักคำสั่ง: " + (req && req.action));

  var auth = {};
  if (entry.auth === "pcu") {
    auth.pcuRow = requirePcuAuth_(req.token);
  } else if (entry.auth === "admin") {
    auth.adminEmail = requireAdminAuth_(req.token).email;
  } else if (entry.auth === "googleAdmin") {
    auth.adminEmail = requireGoogleAdminAuth_(req.token).email;
  }
  return entry.fn(req, auth);
}

function doPost(e) {
  resetDbCache_();
  resetComputedCache_();
  try {
    var bodyText = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var req;
    try {
      req = JSON.parse(bodyText);
    } catch (parseErr) {
      throw apiError_("BAD_REQUEST", "รูปแบบคำขอไม่ถูกต้อง (ไม่ใช่ JSON)");
    }
    var data = handleAction_(req || {});
    return jsonOutput_({ ok: true, data: data });
  } catch (err) {
    if (!(err && err.code)) {
      try { Logger.log((err && err.stack) || String(err)); } catch (logErr) { /* ignore */ }
    }
    return jsonOutput_({ ok: false, error: errorToPayload_(err) });
  }
}

// GET is only used for a tiny health check (API.md "doGet returns a tiny JSON health").
function doGet(e) {
  return jsonOutput_({ ok: true, service: "pcu-supply", version: SERVICE_VERSION_ });
}
