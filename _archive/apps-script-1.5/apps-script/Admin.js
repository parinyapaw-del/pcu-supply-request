// Admin.js — admin-facing actions (API.md "Admin actions"). `auth.adminEmail` is either a
// Google-verified admin's email or the literal string "backup" (backup password login).

function assertPcuCode_(pcu) {
  var rows = readTable_(SHEET_NAMES.PCUS);
  var found = rows.some(function (r) { return r.code === pcu; });
  if (!found) throw apiError_("NOT_FOUND", "ไม่พบ รพ.สต. นี้: " + pcu);
  return rows;
}

// Integer >= 0, or null (no limit). Throws BAD_REQUEST otherwise.
function assertLimitValue_(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n || n < 0) throw apiError_("BAD_REQUEST", "ค่าเพดานต้องเป็นจำนวนเต็ม ≥ 0 หรือว่าง");
  return n;
}

// ---- Google / backup admin login ---------------------------------------------------------------
function action_adminLoginGoogle(p) {
  if (!p.id_token) throw apiError_("BAD_REQUEST", "ต้องมี id_token");
  var data = verifyGoogleIdToken_(p.id_token);
  var email = String(data.email || "");
  var admins = readTable_(SHEET_NAMES.ADMINS);
  var ok = admins.some(function (a) { return String(a.email || "").toLowerCase() === email.toLowerCase(); });
  if (!ok) {
    auditLog_(email, "adminLoginGoogle", "", "", "forbidden");
    throw apiError_("FORBIDDEN", "บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ");
  }
  var tok = makeAdminToken_(email, 0);
  auditLog_(email, "adminLoginGoogle", "", "", "ok");
  return { token: tok.token, exp: tok.exp, email: email };
}

function action_adminLoginBackup(p) {
  var password = String(p.password || "");
  if (!password) throw apiError_("BAD_REQUEST", "กรอกรหัสผ่าน");

  return LockService_run_(function () {
    var props = PropertiesService.getScriptProperties();
    var hash = props.getProperty("BACKUP_PW_HASH");
    var salt = props.getProperty("BACKUP_PW_SALT");
    if (!hash || !salt) throw apiError_("NOT_FOUND", "ยังไม่ได้ตั้งรหัสผ่านสำรอง");

    var now = Date.now();
    var lockedUntil = props.getProperty("BACKUP_LOCKED_UNTIL");
    if (lockedUntil) {
      var until = Date.parse(lockedUntil);
      if (!isNaN(until) && until > now) throw apiError_("LOCKED", "รหัสผ่านสำรองถูกล็อกชั่วคราว", { until: lockedUntil });
      props.setProperty("BACKUP_LOCKED_UNTIL", "");
      props.setProperty("BACKUP_FAIL", "0");
    }

    var attemptHash = sha256Hex_(salt + ":" + password);
    if (constantTimeEq_(attemptHash, hash)) {
      props.setProperty("BACKUP_FAIL", "0");
      props.setProperty("BACKUP_LOCKED_UNTIL", "");
      var tok = makeAdminToken_("backup", Number(getBackupVersion_()));
      auditLog_("backup", "adminLoginBackup", "", "", "ok");
      return { token: tok.token, exp: tok.exp };
    }

    var fail = (Number(props.getProperty("BACKUP_FAIL")) || 0) + 1;
    props.setProperty("BACKUP_FAIL", String(fail));
    if (fail >= BACKUP_MAX_FAIL) {
      var untilIso = new Date(now + BACKUP_LOCK_MIN * 60 * 1000).toISOString();
      props.setProperty("BACKUP_LOCKED_UNTIL", untilIso);
      auditLog_("backup", "adminLoginBackup", "", "", "locked");
      throw apiError_("LOCKED", "ใส่รหัสผ่านผิดครบ 5 ครั้ง ถูกล็อกชั่วคราว", { until: untilIso });
    }
    auditLog_("backup", "adminLoginBackup", "", "", "bad_password fail=" + fail);
    throw apiError_("BAD_PASSWORD", "รหัสผ่านไม่ถูกต้อง", { remaining: BACKUP_MAX_FAIL - fail });
  });
}

// ---- adminBootstrap: static seed part cached in CacheService, live parts read fresh ------------
var BOOTSTRAP_CHUNK_CHARS_ = 20000; // conservative vs. the 90KB/value CacheService limit
var BOOTSTRAP_META_KEY_ = "bootstrapMeta";

function bootstrapChunkKeys_(n) {
  var keys = [];
  for (var i = 0; i < n; i++) keys.push("bootstrapChunk_" + i);
  return keys;
}

function invalidateBootstrapCache_() {
  var cache = CacheService.getScriptCache();
  var metaStr = cache.get(BOOTSTRAP_META_KEY_);
  if (metaStr) {
    try {
      var meta = JSON.parse(metaStr);
      cache.removeAll(bootstrapChunkKeys_(meta.chunks));
    } catch (err) { /* ignore malformed meta */ }
  }
  cache.remove(BOOTSTRAP_META_KEY_);
}

// Builds the part of adminBootstrap derived purely from static (post-import) reference sheets.
function buildBootstrapStaticPart_() {
  var itemMap = readTable_(SHEET_NAMES.ITEM_MAP);
  var price2568 = {};
  var itemsExtra = {};
  itemMap.forEach(function (r) {
    if (r.match_type === "extra") {
      itemsExtra[r.item_code] = { name: r.name_2568, unit: r.unit_2569, price_2568: Number(r.price_2568) || 0 };
    } else if (r.price_2568 !== "" && r.price_2568 !== null && r.price_2568 !== undefined) {
      price2568[r.item_code] = Number(r.price_2568);
    }
  });

  var stockSimRows = readTable_(SHEET_NAMES.STOCK_SIM);
  var overSet = {}, shortSet = {};
  stockSimRows.forEach(function (r) {
    if (r.scenario === "overstock") overSet[r.pcu] = true;
    if (r.scenario === "short") shortSet[r.pcu] = true;
  });

  return {
    months: SEED_MONTHS,
    price_2568: price2568,
    items_extra: itemsExtra,
    actual: getActualMap_(),
    plan: getPlanMap_(),
    stats: getStatsMap_(),
    stock_sim: getStockSimMap_(),
    scenarios: { overstock: Object.keys(overSet), short: Object.keys(shortSet) }
  };
}

function getBootstrapStaticPart_() {
  var cache = CacheService.getScriptCache();
  var metaStr = cache.get(BOOTSTRAP_META_KEY_);
  if (metaStr) {
    try {
      var meta = JSON.parse(metaStr);
      var keys = bootstrapChunkKeys_(meta.chunks);
      var got = cache.getAll(keys);
      var parts = keys.map(function (k) { return got[k]; });
      if (parts.every(function (x) { return x !== undefined && x !== null; })) {
        return JSON.parse(parts.join(""));
      }
    } catch (err) { /* fall through to rebuild */ }
  }
  var obj = buildBootstrapStaticPart_();
  var json = JSON.stringify(obj);
  var chunks = [];
  for (var i = 0; i < json.length; i += BOOTSTRAP_CHUNK_CHARS_) chunks.push(json.substring(i, i + BOOTSTRAP_CHUNK_CHARS_));
  var keys2 = bootstrapChunkKeys_(chunks.length);
  var toPut = {};
  for (var j = 0; j < chunks.length; j++) toPut[keys2[j]] = chunks[j];
  cache.putAll(toPut, 21600); // 6h
  cache.put(BOOTSTRAP_META_KEY_, JSON.stringify({ chunks: chunks.length }), 21600);
  return obj;
}

function action_adminBootstrap(p, auth) {
  var cached = getBootstrapStaticPart_();
  var cfg = getConfigMap_();

  var pcus = readTable_(SHEET_NAMES.PCUS).map(function (r) {
    var lockedUntil = r.pin_locked_until && Date.parse(r.pin_locked_until) > Date.now() ? r.pin_locked_until : null;
    return { code: r.code, name: r.name, print_name: r.print_name || r.name, group: r.group, pin_locked_until: lockedUntil, pin_fail: Number(r.pin_fail) || 0 };
  });

  var limits = {};
  readTable_(SHEET_NAMES.LIMITS).forEach(function (r) {
    limits[r.pcu] = limits[r.pcu] || {};
    limits[r.pcu][r.item_code] = {
      limit_month: normalizeNum_(r.limit_month), limit_year: normalizeNum_(r.limit_year),
      source: r.source, updated_by: r.updated_by, updated_at: r.updated_at
    };
  });

  var hidden = {};
  readTable_(SHEET_NAMES.HIDDEN).forEach(function (r) {
    hidden[r.pcu] = hidden[r.pcu] || [];
    hidden[r.pcu].push(r.item_code);
  });

  var allLines = getAllLines_();
  var requests = getAllRequests_().map(function (r) { return buildRequestObj_(r, allLines); });

  return {
    me: { email: auth.adminEmail },
    config: {
      limit_mode: cfg.limit_mode || "warn",
      cover_over: Number(cfg.cover_over || 3),
      cover_short: Number(cfg.cover_short || 0.5),
      budget_op: Number(cfg.budget_op || 520000),
      budget_pp: Number(cfg.budget_pp || 390000),
      budget_total: Number(cfg.budget_total || 910000)
    },
    rounds: ROUNDS,
    months: cached.months,
    pcus: pcus,
    items_extra: cached.items_extra,
    price_2568: cached.price_2568,
    actual: cached.actual,
    plan: cached.plan,
    stats: cached.stats,
    stock_sim: cached.stock_sim,
    scenarios: cached.scenarios,
    limits: limits,
    hidden: hidden,
    requests: requests
  };
}

// ---- progress (adminRequests) --------------------------------------------------------------------
function computeProgress_(reqRow, allLines, hiddenSet) {
  var stockRequired = ITEM_CODES.length - Object.keys(hiddenSet).length;
  if (!reqRow) return { last_step: "", stock_filled: 0, stock_required: stockRequired, items_requested: 0, baht_2569: 0 };
  var lines = linesForRequest_(allLines, requestId_(reqRow.pcu, reqRow.month));
  var stockFilled = 0, itemsRequested = 0, baht = 0;
  ITEM_CODES.forEach(function (code) {
    if (hiddenSet[code]) return;
    var l = lines[code];
    if (l && l.stock !== null) stockFilled++;
  });
  Object.keys(lines).forEach(function (code) {
    var l = lines[code];
    var total = (l.op || 0) + (l.pp || 0);
    if (total > 0) {
      itemsRequested++;
      var item = FORM_ITEM_BY_CODE_[code];
      if (item) baht += total * item.price;
    }
  });
  return { last_step: reqRow.last_step || "", stock_filled: stockFilled, stock_required: stockRequired, items_requested: itemsRequested, baht_2569: Math.round(baht * 100) / 100 };
}

function action_adminRequests(p, auth) {
  var allRequests = getAllRequests_();
  var allLines = getAllLines_();
  var hiddenByPcu = {};
  readTable_(SHEET_NAMES.HIDDEN).forEach(function (r) {
    hiddenByPcu[r.pcu] = hiddenByPcu[r.pcu] || {};
    hiddenByPcu[r.pcu][r.item_code] = true;
  });

  var list = allRequests.map(function (r) {
    var full = buildRequestObj_(r, allLines);
    var without = {};
    Object.keys(full).forEach(function (k) { if (k !== "lines") without[k] = full[k]; });
    without.progress = computeProgress_(r, allLines, hiddenByPcu[r.pcu] || {});
    return without;
  });
  return { requests: list, server_time: nowIso_() };
}

function action_adminGetRequest(p, auth) {
  var pcuRows = assertPcuCode_(p.pcu);
  assertMonth_(p.month);
  var row = pcuRows.filter(function (r) { return r.code === p.pcu; })[0];
  var allRequests = getAllRequests_();
  var allLines = getAllLines_();
  var reqRow = findRequestRow_(allRequests, p.pcu, p.month);
  return {
    request: reqRow ? buildRequestObj_(reqRow, allLines) : null,
    pcu: pcuPublicInfo_(row),
    hidden: getHiddenListForPcu_(p.pcu)
  };
}

function action_adminReceive(p, auth) {
  assertPcuCode_(p.pcu);
  assertMonth_(p.month);
  return LockService_run_(function () {
    var requests = getAllRequests_();
    var allLines = getAllLines_();
    var reqRow = findRequestRow_(requests, p.pcu, p.month);
    if (!reqRow) throw apiError_("NOT_FOUND", "ไม่พบแบบฟอร์ม");
    if (reqRow.status !== "submitted") throw apiError_("CONFLICT", "รับเรื่องได้เฉพาะแบบฟอร์มที่ส่งแล้ว");
    reqRow.status = "received";
    reqRow.received_at = nowIso_();
    reqRow.updated_at = reqRow.received_at;
    writeTable_(SHEET_NAMES.REQUESTS, getSheetHeaders_()[SHEET_NAMES.REQUESTS], requests);
    auditLog_(auth.adminEmail, "adminReceive", p.pcu, p.month, "");
    return { request: buildRequestObj_(reqRow, allLines) };
  });
}

function action_adminReturn(p, auth) {
  assertPcuCode_(p.pcu);
  assertMonth_(p.month);
  var reason = String(p.reason || "").trim();
  if (!reason) throw apiError_("BAD_REQUEST", "กรุณาระบุเหตุผลที่ส่งกลับ");
  return LockService_run_(function () {
    var requests = getAllRequests_();
    var allLines = getAllLines_();
    var reqRow = findRequestRow_(requests, p.pcu, p.month);
    if (!reqRow) throw apiError_("NOT_FOUND", "ไม่พบแบบฟอร์ม");
    if (reqRow.status !== "submitted") throw apiError_("CONFLICT", "ส่งกลับได้เฉพาะแบบฟอร์มที่ส่งแล้ว");
    reqRow.status = "draft";
    reqRow.return_reason = reason;
    reqRow.updated_at = nowIso_();
    writeTable_(SHEET_NAMES.REQUESTS, getSheetHeaders_()[SHEET_NAMES.REQUESTS], requests);
    auditLog_(auth.adminEmail, "adminReturn", p.pcu, p.month, reason);
    return { request: buildRequestObj_(reqRow, allLines) };
  });
}

function action_adminSetLimit(p, auth) {
  assertPcuCode_(p.pcu);
  assertItemCode_(p.code);
  var lm = assertLimitValue_(p.limit_month);
  var ly = assertLimitValue_(p.limit_year);
  return LockService_run_(function () {
    var rows = readTable_(SHEET_NAMES.LIMITS);
    var row = getLimitRow_(rows, p.pcu, p.code);
    var nowStr = nowIso_();
    if (!row) {
      row = { pcu: p.pcu, item_code: p.code };
      rows.push(row);
    }
    row.limit_month = lm === null ? "" : lm;
    row.limit_year = ly === null ? "" : ly;
    row.source = "admin";
    row.updated_by = auth.adminEmail;
    row.updated_at = nowStr;
    writeTable_(SHEET_NAMES.LIMITS, getSheetHeaders_()[SHEET_NAMES.LIMITS], rows);
    auditLog_(auth.adminEmail, "adminSetLimit", p.pcu, "", p.code + " month=" + lm + " year=" + ly);
    return { limit: { pcu: p.pcu, code: p.code, limit_month: lm, limit_year: ly, source: "admin", updated_by: auth.adminEmail, updated_at: nowStr } };
  });
}

function action_adminResetLimit(p, auth) {
  assertPcuCode_(p.pcu);
  assertItemCode_(p.code);
  return LockService_run_(function () {
    var stats = getStatsMap_()[p.pcu] || {};
    var s = stats[p.code] || [0, 0, 0];
    var lmRaw = Math.max(0, Math.ceil(s[1] - 1e-9));
    var lyRaw = Math.max(0, Math.ceil(s[2] - 1e-9));
    var lm = lmRaw > 0 ? lmRaw : null;
    var ly = lyRaw > 0 ? lyRaw : null;
    var nowStr = nowIso_();
    var rows = readTable_(SHEET_NAMES.LIMITS);
    var filtered = rows.filter(function (r) { return !(r.pcu === p.pcu && r.item_code === p.code); });
    var limitObj = { pcu: p.pcu, code: p.code, limit_month: lm, limit_year: ly, source: "stat68", updated_by: "system", updated_at: nowStr };
    if (lm !== null || ly !== null) {
      filtered.push({
        pcu: p.pcu, item_code: p.code, limit_month: lm === null ? "" : lm, limit_year: ly === null ? "" : ly,
        source: "stat68", updated_by: "system", updated_at: nowStr
      });
    }
    writeTable_(SHEET_NAMES.LIMITS, getSheetHeaders_()[SHEET_NAMES.LIMITS], filtered);
    auditLog_(auth.adminEmail, "adminResetLimit", p.pcu, "", p.code);
    return { limit: limitObj };
  });
}

function action_adminSetMode(p, auth) {
  if (p.mode !== "warn" && p.mode !== "enforce") throw apiError_("BAD_REQUEST", "โหมดต้องเป็น warn หรือ enforce");
  return LockService_run_(function () {
    setConfigValue_("limit_mode", p.mode);
    auditLog_(auth.adminEmail, "adminSetMode", "", "", p.mode);
    var cfg = getConfigMap_();
    return {
      config: {
        limit_mode: cfg.limit_mode, cover_over: Number(cfg.cover_over || 3), cover_short: Number(cfg.cover_short || 0.5),
        budget_op: Number(cfg.budget_op || 520000), budget_pp: Number(cfg.budget_pp || 390000), budget_total: Number(cfg.budget_total || 910000)
      }
    };
  });
}

function action_adminSetPin(p, auth) {
  assertPcuCode_(p.pcu);
  var pin = String(p.pin || "");
  if (!/^[0-9]{5}$/.test(pin)) throw apiError_("BAD_REQUEST", "PIN ต้องเป็นเลข 5 หลัก");
  return LockService_run_(function () {
    var pcus = readTable_(SHEET_NAMES.PCUS);
    var row = null;
    for (var i = 0; i < pcus.length; i++) if (pcus[i].code === p.pcu) { row = pcus[i]; break; }
    if (!row) throw apiError_("NOT_FOUND", "ไม่พบ รพ.สต. นี้");
    var salt = randomSalt_();
    row.pin_hash = hashPin_(pin, salt);
    row.pin_salt = salt;
    row.pin_version = (Number(row.pin_version) || 1) + 1;
    row.pin_fail = 0;
    row.pin_locked_until = "";
    writeTable_(SHEET_NAMES.PCUS, getSheetHeaders_()[SHEET_NAMES.PCUS], pcus);
    auditLog_(auth.adminEmail, "adminSetPin", p.pcu, "", "");
    return { ok: true };
  });
}

function action_adminUnlockPin(p, auth) {
  assertPcuCode_(p.pcu);
  return LockService_run_(function () {
    var pcus = readTable_(SHEET_NAMES.PCUS);
    var row = null;
    for (var i = 0; i < pcus.length; i++) if (pcus[i].code === p.pcu) { row = pcus[i]; break; }
    if (!row) throw apiError_("NOT_FOUND", "ไม่พบ รพ.สต. นี้");
    row.pin_fail = 0;
    row.pin_locked_until = "";
    writeTable_(SHEET_NAMES.PCUS, getSheetHeaders_()[SHEET_NAMES.PCUS], pcus);
    auditLog_(auth.adminEmail, "adminUnlockPin", p.pcu, "", "");
    return { ok: true };
  });
}

function action_adminSetHidden(p, auth) {
  assertPcuCode_(p.pcu);
  var codes = Array.isArray(p.codes) ? p.codes : [];
  codes.forEach(assertItemCode_);
  var uniq = codes.filter(function (c, i) { return codes.indexOf(c) === i; });
  return LockService_run_(function () {
    var rows = readTable_(SHEET_NAMES.HIDDEN).filter(function (r) { return r.pcu !== p.pcu; });
    var nowStr = nowIso_();
    uniq.forEach(function (code) { rows.push({ pcu: p.pcu, item_code: code, hidden_at: nowStr, by: auth.adminEmail }); });
    writeTable_(SHEET_NAMES.HIDDEN, getSheetHeaders_()[SHEET_NAMES.HIDDEN], rows);
    auditLog_(auth.adminEmail, "adminSetHidden", p.pcu, "", "count=" + uniq.length);
    return { hidden: uniq };
  });
}

function action_adminSetBackupPassword(p, auth) {
  var password = String(p.password || "");
  if (password.length < 8) throw apiError_("BAD_REQUEST", "รหัสผ่านสำรองต้องยาวอย่างน้อย 8 ตัวอักษร");
  return LockService_run_(function () {
    setBackupPassword_(password, auth.adminEmail);
    auditLog_(auth.adminEmail, "adminSetBackupPassword", "", "", "");
    return { ok: true };
  });
}

function action_adminClearTrial(p, auth) {
  if (p.confirm !== "ล้างข้อมูล") throw apiError_("BAD_REQUEST", "พิมพ์คำว่า \"ล้างข้อมูล\" เพื่อยืนยัน");
  return LockService_run_(function () {
    var requests = getAllRequests_();
    var lines = getAllLines_();
    var deletedRequests = requests.length;
    var deletedLines = lines.length;
    writeTable_(SHEET_NAMES.REQUESTS, getSheetHeaders_()[SHEET_NAMES.REQUESTS], []);
    writeTable_(SHEET_NAMES.REQUEST_LINES, getSheetHeaders_()[SHEET_NAMES.REQUEST_LINES], []);
    auditLog_(auth.adminEmail, "adminClearTrial", "", "", "deleted_requests=" + deletedRequests + " deleted_lines=" + deletedLines);
    return { deleted_requests: deletedRequests, deleted_lines: deletedLines };
  });
}
