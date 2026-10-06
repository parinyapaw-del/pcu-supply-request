// Setup.js — setup() (idempotent, run once by the owner in the Apps Script editor) and the seed
// importer it calls. Never touches requests / request_lines / pcu_hidden_items / audit_log,
// PINs that are already set, or limit rows an admin has edited (source "admin").

// Built lazily (see Main.js getActionsMap_() for why: top-level code in one file can run before
// another file's top-level code in Apps Script's multi-file V8 runtime, so nothing at top level
// may depend on another file's top-level `var`). SHEET_NAMES.* is only read once this function is
// actually called (inside setup()/importSeed_(), never at file-load time).
var SHEET_HEADERS_CACHE_ = null;
function getSheetHeaders_() {
  if (SHEET_HEADERS_CACHE_) return SHEET_HEADERS_CACHE_;
  var h = {};
  h[SHEET_NAMES.CONFIG] = ["key", "value"];
  h[SHEET_NAMES.ADMINS] = ["email", "added_at"];
  h[SHEET_NAMES.PCUS] = ["code", "name", "print_name", "group", "pin_hash", "pin_salt", "pin_version", "pin_fail", "pin_locked_until"];
  h[SHEET_NAMES.ITEM_MAP] = ["item_code", "name_2568", "name_2569", "unit_2569", "price_2568", "price_2569", "match_type"];
  h[SHEET_NAMES.ACTUAL] = ["month", "pcu", "item_code", "op", "pp"];
  h[SHEET_NAMES.PLAN] = ["pcu", "item_code", "plan_op", "plan_pp"];
  h[SHEET_NAMES.STATS] = ["pcu", "item_code", "median_m", "p90_m", "annual_qty"];
  h[SHEET_NAMES.STOCK_SIM] = ["month", "pcu", "item_code", "stock", "scenario"];
  h[SHEET_NAMES.LIMITS] = ["pcu", "item_code", "limit_month", "limit_year", "source", "updated_by", "updated_at"];
  h[SHEET_NAMES.REQUESTS] = ["id", "pcu", "month", "status", "submitter_name", "last_step", "created_at", "updated_at", "submitted_at", "received_at", "return_reason"];
  h[SHEET_NAMES.REQUEST_LINES] = ["request_id", "item_code", "stock", "op", "pp", "updated_at"];
  h[SHEET_NAMES.HIDDEN] = ["pcu", "item_code", "hidden_at", "by"];
  h[SHEET_NAMES.AUDIT] = ["ts", "actor", "action", "pcu", "month", "detail"];
  SHEET_HEADERS_CACHE_ = h;
  return h;
}

function setup() {
  resetDbCache_();
  // 1) sheets + headers
  var headers = getSheetHeaders_();
  for (var name in headers) {
    if (headers.hasOwnProperty(name)) ensureSheet_(name, headers[name]);
  }

  // 2) config defaults — only fill keys that are missing (preserve admin edits, e.g. limit_mode)
  var configRows = readTable_(SHEET_NAMES.CONFIG);
  var existingKeys = {};
  configRows.forEach(function (r) { existingKeys[r.key] = true; });
  var added = false;
  for (var k in DEFAULT_CONFIG) {
    if (DEFAULT_CONFIG.hasOwnProperty(k) && !existingKeys[k]) {
      configRows.push({ key: k, value: DEFAULT_CONFIG[k] });
      added = true;
    }
  }
  if (added) writeTable_(SHEET_NAMES.CONFIG, getSheetHeaders_()[SHEET_NAMES.CONFIG], configRows);

  // 3) admins — ensure the default owner is present, never remove others
  var admins = readTable_(SHEET_NAMES.ADMINS);
  var hasDefault = admins.some(function (a) { return String(a.email || "").toLowerCase() === DEFAULT_ADMIN_EMAIL; });
  if (!hasDefault) {
    admins.push({ email: DEFAULT_ADMIN_EMAIL, added_at: nowIso_() });
    writeTable_(SHEET_NAMES.ADMINS, getSheetHeaders_()[SHEET_NAMES.ADMINS], admins);
  }

  // 4) token secret (created once, reused forever)
  getTokenSecret_();

  // 5) seed (pcus with default PIN 12345 if not already present + reference tables + limits)
  importSeed_();
}

function loadSeedJson_() {
  var content;
  try {
    content = HtmlService.createHtmlOutputFromFile("_seed").getContent();
  } catch (err) {
    throw apiError_("SERVER_ERROR", "ไม่พบไฟล์ _seed.html — รัน tools/make_seed_html.py ก่อน");
  }
  return JSON.parse(content);
}

// Imports pcus (PIN 12345 for new PCUs only) + item_map + actual_2568 + plan_2568 + stats_2568 +
// stock_sim_2568 + limits (merged so admin-edited limits survive) from phase15_seed/seed_2568.json
// (packaged as apps-script/_seed.html by tools/make_seed_html.py).
function importSeed_() {
  var seed = loadSeedJson_();

  // ---- pcus (only add PCUs that don't exist yet; never touch existing PIN/lock state) --------
  var pcus = readTable_(SHEET_NAMES.PCUS);
  var byCode = {};
  pcus.forEach(function (p) { byCode[p.code] = p; });
  var pcuChanged = false;
  (seed.pcus || []).forEach(function (p) {
    if (byCode[p.code]) return;
    var salt = randomSalt_();
    var row = {
      code: p.code, name: p.name, print_name: p.print_name || p.name, group: p.group || "ทั่วไป",
      pin_hash: hashPin_("12345", salt), pin_salt: salt, pin_version: 1, pin_fail: 0, pin_locked_until: ""
    };
    pcus.push(row);
    byCode[p.code] = row;
    pcuChanged = true;
  });
  if (pcuChanged) writeTable_(SHEET_NAMES.PCUS, getSheetHeaders_()[SHEET_NAMES.PCUS], pcus);

  // ---- item_map (static reference data — safe to fully rebuild every run) ---------------------
  var price68 = seed.price_2568 || {};
  var itemMapRows = FORM_ITEMS.map(function (it) {
    var isNew = !!NEW_2569_ITEMS[it.code];
    return {
      item_code: it.code,
      name_2568: "",
      name_2569: it.name,
      unit_2569: it.unit,
      price_2568: isNew ? "" : (price68[it.code] !== undefined ? price68[it.code] : ""),
      price_2569: it.price,
      match_type: isNew ? "new_2569" : "mapped"
    };
  });
  // Extra (non-form) item(s), e.g. "X-113" — counted only in admin baht totals, never a valid
  // request item code. Stored as an item_map row (match_type "extra") so adminBootstrap can
  // rebuild items_extra without a separate sheet.
  var extraItems = seed.extra_items || {};
  Object.keys(extraItems).forEach(function (key) {
    var e = extraItems[key];
    itemMapRows.push({
      item_code: EXTRA_ITEM_CODE, name_2568: e.name, name_2569: "", unit_2569: e.unit,
      price_2568: e.price_2568, price_2569: "", match_type: "extra"
    });
  });
  writeTable_(SHEET_NAMES.ITEM_MAP, getSheetHeaders_()[SHEET_NAMES.ITEM_MAP], itemMapRows);

  // ---- actual_2568 (non-zero rows only, includes X-113) ----------------------------------------
  var actualRows = [];
  var actual = seed.actual || {};
  Object.keys(actual).forEach(function (pcu) {
    var codes = actual[pcu];
    Object.keys(codes).forEach(function (code) {
      var a = codes[code];
      for (var i = 0; i < SEED_MONTHS.length; i++) {
        var op = a.op[i] || 0, pp = a.pp[i] || 0;
        if (op !== 0 || pp !== 0) actualRows.push({ month: SEED_MONTHS[i], pcu: pcu, item_code: code, op: op, pp: pp });
      }
    });
  });
  var actualExtra = seed.actual_extra || {};
  Object.keys(actualExtra).forEach(function (pcu) {
    // iterate every extra-item key present (seed currently only has "113" -> EXTRA_ITEM_CODE)
    Object.keys(actualExtra[pcu]).forEach(function (extraKey) {
      var e = actualExtra[pcu][extraKey];
      for (var i = 0; i < SEED_MONTHS.length; i++) {
        var op = e.op[i] || 0, pp = e.pp[i] || 0;
        if (op !== 0 || pp !== 0) actualRows.push({ month: SEED_MONTHS[i], pcu: pcu, item_code: EXTRA_ITEM_CODE, op: op, pp: pp });
      }
    });
  });
  writeTable_(SHEET_NAMES.ACTUAL, getSheetHeaders_()[SHEET_NAMES.ACTUAL], actualRows);

  // ---- plan_2568 ---------------------------------------------------------------------------------
  var planRows = [];
  var plan = seed.plan || {};
  Object.keys(plan).forEach(function (pcu) {
    Object.keys(plan[pcu]).forEach(function (code) {
      var pl = plan[pcu][code];
      planRows.push({ pcu: pcu, item_code: code, plan_op: pl[0], plan_pp: pl[1] });
    });
  });
  writeTable_(SHEET_NAMES.PLAN, getSheetHeaders_()[SHEET_NAMES.PLAN], planRows);

  // ---- stats_2568 --------------------------------------------------------------------------------
  var statsRows = [];
  var stats = seed.stats || {};
  Object.keys(stats).forEach(function (pcu) {
    Object.keys(stats[pcu]).forEach(function (code) {
      var s = stats[pcu][code];
      statsRows.push({ pcu: pcu, item_code: code, median_m: s[0], p90_m: s[1], annual_qty: s[2] });
    });
  });
  writeTable_(SHEET_NAMES.STATS, getSheetHeaders_()[SHEET_NAMES.STATS], statsRows);

  // ---- stock_sim_2568 -----------------------------------------------------------------------------
  var stockRows = [];
  var stockSim = seed.stock_sim || {};
  var scenarioItems = (seed.stock_scenarios && seed.stock_scenarios.items) || {};
  Object.keys(stockSim).forEach(function (pcu) {
    Object.keys(stockSim[pcu]).forEach(function (code) {
      var arr = stockSim[pcu][code];
      var scenario = scenarioItems[pcu + "|" + code] || "normal";
      for (var i = 0; i < SEED_MONTHS.length; i++) {
        stockRows.push({ month: SEED_MONTHS[i], pcu: pcu, item_code: code, stock: arr[i], scenario: scenario });
      }
    });
  });
  writeTable_(SHEET_NAMES.STOCK_SIM, getSheetHeaders_()[SHEET_NAMES.STOCK_SIM], stockRows);

  // ---- limits (merge: keep any row an admin has already edited) ----------------------------------
  var existingLimits = readTable_(SHEET_NAMES.LIMITS);
  var limitsByKey = {};
  existingLimits.forEach(function (r) { limitsByKey[r.pcu + "|" + r.item_code] = r; });
  var seedLimits = seed.limits || {};
  Object.keys(seedLimits).forEach(function (pcu) {
    Object.keys(seedLimits[pcu]).forEach(function (code) {
      var key = pcu + "|" + code;
      var existing = limitsByKey[key];
      if (existing && existing.source === "admin") return; // preserve admin edit
      var pair = seedLimits[pcu][code];
      limitsByKey[key] = {
        pcu: pcu, item_code: code,
        limit_month: pair[0] === null || pair[0] === undefined ? "" : pair[0],
        limit_year: pair[1] === null || pair[1] === undefined ? "" : pair[1],
        source: "stat68", updated_by: "system", updated_at: nowIso_()
      };
    });
  });
  var mergedLimits = Object.keys(limitsByKey).map(function (k) { return limitsByKey[k]; });
  writeTable_(SHEET_NAMES.LIMITS, getSheetHeaders_()[SHEET_NAMES.LIMITS], mergedLimits);

  invalidateBootstrapCache_();
}
