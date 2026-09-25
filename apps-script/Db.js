// Db.js — thin helpers over Sheets so the rest of the backend deals in plain JS objects.
//
// Pattern used everywhere: read the whole sheet once per request (cached in REQUEST_CACHE_),
// mutate an array of plain objects in memory, then write the whole table back in ONE
// setValues() call. Given the dataset size (15 PCUs × 125 items, a couple thousand rows at
// most in request_lines) this is simpler and less bug-prone than cell-level patches, while
// still satisfying "read once / write in batches, no cell-by-cell setValue loops".

var REQUEST_CACHE_ = {}; // sheetName -> {headers:[...], rows:[[...], ...]} (raw 2D, no header row)

function resetDbCache_() {
  REQUEST_CACHE_ = {};
  SHEET_OBJ_CACHE_ = {};
  FMT_PROPS_ = null;
}

function ss_() {
  return SpreadsheetApp.getActive();
}

// Returns the sheet, creating it with the given headers if missing. Never touches existing data.
var SHEET_OBJ_CACHE_ = {};
function ensureSheet_(name, headers) {
  if (SHEET_OBJ_CACHE_[name]) return SHEET_OBJ_CACHE_[name];
  var sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  SHEET_OBJ_CACHE_[name] = sh;
  return sh;
}

function headersOf_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  return sh.getRange(1, 1, 1, lastCol).getValues()[0];
}

// Raw (headers, 2D body rows) for a sheet, cached for the lifetime of this request.
function readRaw_(name) {
  if (REQUEST_CACHE_[name]) return REQUEST_CACHE_[name];
  var sh = ss_().getSheetByName(name);
  if (!sh) {
    var empty = { headers: [], rows: [] };
    REQUEST_CACHE_[name] = empty;
    return empty;
  }
  var lastRow = sh.getLastRow();
  var lastCol = Math.max(sh.getLastColumn(), 1);
  if (lastRow < 1) {
    var e2 = { headers: [], rows: [] };
    REQUEST_CACHE_[name] = e2;
    return e2;
  }
  var all = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = all[0];
  var rows = all.slice(1).filter(function (r) {
    // drop fully-blank trailing rows
    return r.some(function (v) { return v !== "" && v !== null; });
  });
  var out = { headers: headers, rows: rows };
  REQUEST_CACHE_[name] = out;
  return out;
}

// Columns stored as numbers; every other column is formatted as plain text ("@") before writing,
// otherwise Sheets auto-parses strings: "2024-10" month keys and ISO timestamps become Dates,
// digit-only strings become numbers.
var NUMERIC_COLS_ = {
  op: 1, pp: 1, stock: 1, plan_op: 1, plan_pp: 1, median_m: 1, p90_m: 1, annual_qty: 1,
  limit_month: 1, limit_year: 1, pin_version: 1, pin_fail: 1, price_2568: 1, price_2569: 1
};

// Text formats are applied to whole columns (rows 2..maxRows) once per sheet grid size, remembered
// in Script Properties — per-write formatting cost ~0.2 s per column on the real Sheet.
// Rows added by ensureCapacity_ (insertRowsAfter) inherit the formatting of the row above.
var FMT_PROPS_ = null;
function fmtProps_() {
  if (!FMT_PROPS_) FMT_PROPS_ = PropertiesService.getScriptProperties().getProperties();
  return FMT_PROPS_;
}

function setTextFormats_(sh, startRow, numRows, hdrs) {
  var name = sh.getName();
  var key = "FMT_" + name;
  var maxRows = sh.getMaxRows();
  var sig = hdrs.join(",") + "|" + maxRows;
  if (fmtProps_()[key] === sig) return;
  for (var c = 0; c < hdrs.length; c++) {
    if (!NUMERIC_COLS_[hdrs[c]] && maxRows > 1) sh.getRange(2, c + 1, maxRows - 1, 1).setNumberFormat("@");
  }
  PropertiesService.getScriptProperties().setProperty(key, sig);
  FMT_PROPS_[key] = sig;
}

// Grows the grid so rows up to `lastRowNeeded` exist (getRange beyond maxRows throws in Sheets).
function ensureCapacity_(sh, lastRowNeeded) {
  var maxRows = sh.getMaxRows();
  if (lastRowNeeded > maxRows) sh.insertRowsAfter(maxRows, lastRowNeeded - maxRows + 500);
}

// Defensive read-side normalisation for rows written before text formatting existed.
function normCell_(header, v) {
  if (v instanceof Date) {
    if (header === "month") return Utilities.formatDate(v, "Asia/Bangkok", "yyyy-MM");
    return v.toISOString();
  }
  return v;
}

function rowToObj_(headers, row) {
  var o = {};
  for (var i = 0; i < headers.length; i++) o[headers[i]] = row[i] === undefined ? "" : normCell_(headers[i], row[i]);
  return o;
}

function objToRow_(headers, obj) {
  return headers.map(function (h) {
    var v = obj[h];
    if (v === undefined || v === null) return "";
    return v;
  });
}

// Reads a sheet as an array of plain objects keyed by header. Cached per request.
function readTable_(name) {
  var raw = readRaw_(name);
  if (!raw.headers.length) return [];
  return raw.rows.map(function (r) { return rowToObj_(raw.headers, r); });
}

function headersFor_(name, fallbackHeaders) {
  var raw = readRaw_(name);
  return raw.headers.length ? raw.headers : fallbackHeaders;
}

// Overwrites the whole table body (below the header row) with `objects`, using `headers` as the
// canonical column order (created if the sheet is new/empty). Invalidates this sheet's cache.
function writeTable_(name, headers, objects) {
  var sh = ensureSheet_(name, headers);
  var hdrs = headersFor_(name, headers);
  var maxRows = sh.getMaxRows();
  if (maxRows > 1) {
    sh.getRange(2, 1, maxRows - 1, Math.max(sh.getLastColumn(), hdrs.length)).clearContent();
  }
  if (objects.length) {
    var body = objects.map(function (o) { return objToRow_(hdrs, o); });
    ensureCapacity_(sh, body.length + 1);
    setTextFormats_(sh, 2, body.length, hdrs);
    sh.getRange(2, 1, body.length, hdrs.length).setValues(body);
  }
  delete REQUEST_CACHE_[name];
}

// Like readTable_ but each object carries __row (its 1-based sheet row) for in-place updates.
// Reads the sheet directly (not the request cache) so row numbers are exact.
function readTableWithRows_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 1) return [];
  var all = sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), 1)).getValues();
  var headers = all[0], out = [];
  for (var i = 1; i < all.length; i++) {
    if (!all[i].some(function (v) { return v !== "" && v !== null; })) continue;
    var o = rowToObj_(headers, all[i]);
    o.__row = i + 1;
    out.push(o);
  }
  return out;
}

// Writes back only the given objects (each must carry __row), one setValues per contiguous run.
function updateRows_(name, headers, objects) {
  if (!objects.length) return;
  var sh = ensureSheet_(name, headers);
  var hdrs = headersFor_(name, headers);
  var sorted = objects.slice().sort(function (a, b) { return a.__row - b.__row; });
  var start = 0;
  for (var i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i].__row !== sorted[i - 1].__row + 1) {
      var run = sorted.slice(start, i);
      var body = run.map(function (o) { return objToRow_(hdrs, o); });
      setTextFormats_(sh, run[0].__row, body.length, hdrs);
      sh.getRange(run[0].__row, 1, body.length, hdrs.length).setValues(body);
      start = i;
    }
  }
  delete REQUEST_CACHE_[name];
}

// Appends rows (objects) after the current last row in one batch write. Used for audit_log.
function appendTable_(name, headers, objects) {
  if (!objects.length) return;
  var sh = ensureSheet_(name, headers);
  var hdrs = REQUEST_CACHE_[name] ? REQUEST_CACHE_[name].headers : headers; // sheets are created by setup() with these headers
  var startRow = sh.getLastRow() + 1;
  var body = objects.map(function (o) { return objToRow_(hdrs, o); });
  ensureCapacity_(sh, startRow + body.length - 1);
  setTextFormats_(sh, startRow, body.length, hdrs);
  sh.getRange(startRow, 1, body.length, hdrs.length).setValues(body);
  delete REQUEST_CACHE_[name];
}

function nowIso_() {
  return new Date().toISOString();
}

// Runs `fn` while holding the script lock (API.md / spec §5: every write goes through
// LockService). 20s wait, always released.
function LockService_run_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getConfigMap_() {
  var rows = readTable_(SHEET_NAMES.CONFIG);
  var map = {};
  rows.forEach(function (r) { map[r.key] = r.value; });
  return map;
}

function setConfigValue_(key, value) {
  var rows = readTable_(SHEET_NAMES.CONFIG);
  var found = false;
  rows.forEach(function (r) { if (r.key === key) { r.value = String(value); found = true; } });
  if (!found) rows.push({ key: key, value: String(value) });
  writeTable_(SHEET_NAMES.CONFIG, ["key", "value"], rows);
}

// Appends one row to audit_log. Called for every state-changing action (API.md / spec §5).
function auditLog_(actor, action, pcu, month, detail) {
  appendTable_(SHEET_NAMES.AUDIT, ["ts", "actor", "action", "pcu", "month", "detail"], [{
    ts: nowIso_(), actor: actor || "", action: action || "", pcu: pcu || "", month: month || "", detail: detail || ""
  }]);
}
