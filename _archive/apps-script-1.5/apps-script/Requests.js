// Requests.js — shared helpers for requests/request_lines, reference-data lookups (actual/plan/
// stats/stock_sim/limits/hidden) and the pcuBootstrap "byRound" computation (API.md). Shared by
// Pcu.js and Admin.js so the two never disagree about what a round/request looks like.

var COMPUTED_CACHE_ = {};
function resetComputedCache_() {
  COMPUTED_CACHE_ = {};
}

function zeros12_() {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

function requestId_(pcu, month) {
  return pcu + "|" + month;
}

function normalizeNum_(v) {
  if (v === "" || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

// ---- reference data (read-only after setup/importSeed_, safe to memoize for this request) ------
function getActualMap_() {
  if (COMPUTED_CACHE_.actualMap) return COMPUTED_CACHE_.actualMap;
  var rows = readTable_(SHEET_NAMES.ACTUAL);
  var map = {};
  rows.forEach(function (r) {
    var idx = SEED_MONTHS.indexOf(r.month);
    if (idx < 0) return;
    map[r.pcu] = map[r.pcu] || {};
    map[r.pcu][r.item_code] = map[r.pcu][r.item_code] || { op: zeros12_(), pp: zeros12_() };
    map[r.pcu][r.item_code].op[idx] = Number(r.op) || 0;
    map[r.pcu][r.item_code].pp[idx] = Number(r.pp) || 0;
  });
  COMPUTED_CACHE_.actualMap = map;
  return map;
}

function getPlanMap_() {
  if (COMPUTED_CACHE_.planMap) return COMPUTED_CACHE_.planMap;
  var rows = readTable_(SHEET_NAMES.PLAN);
  var map = {};
  rows.forEach(function (r) {
    map[r.pcu] = map[r.pcu] || {};
    map[r.pcu][r.item_code] = [Number(r.plan_op) || 0, Number(r.plan_pp) || 0];
  });
  COMPUTED_CACHE_.planMap = map;
  return map;
}

function getStatsMap_() {
  if (COMPUTED_CACHE_.statsMap) return COMPUTED_CACHE_.statsMap;
  var rows = readTable_(SHEET_NAMES.STATS);
  var map = {};
  rows.forEach(function (r) {
    map[r.pcu] = map[r.pcu] || {};
    map[r.pcu][r.item_code] = [Number(r.median_m) || 0, Number(r.p90_m) || 0, Number(r.annual_qty) || 0];
  });
  COMPUTED_CACHE_.statsMap = map;
  return map;
}

function getStockSimMap_() {
  if (COMPUTED_CACHE_.stockSimMap) return COMPUTED_CACHE_.stockSimMap;
  var rows = readTable_(SHEET_NAMES.STOCK_SIM);
  var map = {};
  rows.forEach(function (r) {
    var idx = SEED_MONTHS.indexOf(r.month);
    if (idx < 0) return;
    map[r.pcu] = map[r.pcu] || {};
    map[r.pcu][r.item_code] = map[r.pcu][r.item_code] || zeros12_();
    map[r.pcu][r.item_code][idx] = Number(r.stock) || 0;
  });
  COMPUTED_CACHE_.stockSimMap = map;
  return map;
}

function getLimitsForPcu_(pcu) {
  var rows = readTable_(SHEET_NAMES.LIMITS);
  var out = {};
  rows.forEach(function (r) {
    if (r.pcu !== pcu) return;
    out[r.item_code] = [normalizeNum_(r.limit_month), normalizeNum_(r.limit_year)];
  });
  return out;
}

function getLimitRow_(allLimits, pcu, code) {
  for (var i = 0; i < allLimits.length; i++) {
    if (allLimits[i].pcu === pcu && allLimits[i].item_code === code) return allLimits[i];
  }
  return null;
}

function getHiddenListForPcu_(pcu) {
  var rows = readTable_(SHEET_NAMES.HIDDEN);
  return rows.filter(function (r) { return r.pcu === pcu; }).map(function (r) { return r.item_code; });
}

// Items on the 2569 form this PCU never withdrew during FY2568 (excludes the 2 brand-new items —
// they simply have no FY2568 history and are not "never withdrawn").
function computeNever68_(pcuCode) {
  primeStaticMapsFromCache_();
  var pcuActual = getActualMap_()[pcuCode] || {};
  return ITEM_CODES.filter(function (code) {
    return !NEW_2569_ITEMS[code] && !pcuActual[code];
  });
}

// ---- requests / request_lines --------------------------------------------------------------------
function getAllRequests_() {
  return readTable_(SHEET_NAMES.REQUESTS);
}

function getAllLines_() {
  return readTable_(SHEET_NAMES.REQUEST_LINES);
}

function findRequestRow_(requests, pcu, month) {
  for (var i = 0; i < requests.length; i++) {
    if (requests[i].pcu === pcu && requests[i].month === month) return requests[i];
  }
  return null;
}

// {code: {stock, op, pp, updated_at}} for one request id.
function linesForRequest_(allLines, reqId) {
  var out = {};
  allLines.forEach(function (l) {
    if (l.request_id !== reqId) return;
    out[l.item_code] = { stock: normalizeNum_(l.stock), op: normalizeNum_(l.op), pp: normalizeNum_(l.pp), updated_at: l.updated_at || "" };
  });
  return out;
}

function buildRequestObj_(reqRow, allLines) {
  if (!reqRow) return null;
  return {
    pcu: reqRow.pcu,
    month: reqRow.month,
    status: reqRow.status,
    return_reason: reqRow.return_reason || "",
    submitter_name: reqRow.submitter_name || "",
    last_step: reqRow.last_step || "",
    created_at: reqRow.created_at || "",
    updated_at: reqRow.updated_at || "",
    submitted_at: reqRow.submitted_at || "",
    received_at: reqRow.received_at || "",
    lines: linesForRequest_(allLines, requestId_(reqRow.pcu, reqRow.month))
  };
}

// ---- shared param validation --------------------------------------------------------------------
function assertMonth_(month) {
  var ok = ROUNDS.some(function (r) { return r.month === month; });
  if (!ok) throw apiError_("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง: " + month);
}

function assertItemCode_(code) {
  if (!ITEM_CODE_SET[code]) throw apiError_("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + code);
}

// Integer 0–99999 or null (empty). Throws BAD_REQUEST otherwise.
function assertQty_(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n || n < 0 || n > 99999) {
    throw apiError_("BAD_REQUEST", "จำนวนต้องเป็นเลขจำนวนเต็ม 0–99999 หรือว่าง");
  }
  return n;
}

// ---- byRound (API.md pcuBootstrap.byRound) ---------------------------------------------------------
// Fills the per-request reference maps from the CacheService copy used by adminBootstrap
// (built from the sheets on a miss) — avoids re-reading ~16k seed rows on every PCU call.
function primeStaticMapsFromCache_() {
  if (COMPUTED_CACHE_.actualMap) return;
  var st = getBootstrapStaticPart_();
  COMPUTED_CACHE_.actualMap = st.actual;
  COMPUTED_CACHE_.planMap = st.plan;
  COMPUTED_CACHE_.statsMap = st.stats;
  COMPUTED_CACHE_.stockSimMap = st.stock_sim;
}

// Items withdrawn in ≥ REGULAR_MIN_MONTHS of the 12 FY68 months — the only ones where a
// "months of cover" warning is meaningful (phase 1.5.md §2.3).
var REGULAR_MIN_MONTHS = 6;
function regularCodes_(pcuActual) {
  return Object.keys(pcuActual).filter(function (code) {
    var a = pcuActual[code], n = 0;
    for (var i = 0; i < 12; i++) if ((Number(a.op[i]) || 0) + (Number(a.pp[i]) || 0) > 0) n++;
    return n >= REGULAR_MIN_MONTHS;
  });
}

function buildByRoundForPcu_(pcuCode) {
  primeStaticMapsFromCache_();
  var actualMap = getActualMap_();
  var stockSimMap = getStockSimMap_();
  var statsMap = getStatsMap_();
  var planMap = getPlanMap_();
  var pcuActual = actualMap[pcuCode] || {};
  var pcuStock = stockSimMap[pcuCode] || {};
  var pcuStats = statsMap[pcuCode] || {};
  var requests = getAllRequests_();
  var allLines = getAllLines_();

  var out = {};
  ROUNDS.forEach(function (round) {
    var prevItems = {};
    var plan = null;
    var usedFy = {};
    var avg3 = {};

    if (round.fy === 2568) {
      // round "2025-09": prev = Aug 68 (index 10)
      var idx = 10;
      ITEM_CODES.forEach(function (code) {
        var a = pcuActual[code];
        var op = a ? (a.op[idx] || 0) : 0;
        var pp = a ? (a.pp[idx] || 0) : 0;
        var stock = (pcuStock[code] && pcuStock[code][idx]) || 0;
        if (op !== 0 || pp !== 0 || stock !== 0) prevItems[code] = { stock: stock, stock_src: "sim", op: op, pp: pp };
      });
      plan = {};
      Object.keys(planMap[pcuCode] || {}).forEach(function (code) { plan[code] = (planMap[pcuCode] || {})[code]; });
      ITEM_CODES.forEach(function (code) {
        var a = pcuActual[code];
        if (!a) return;
        var sum = 0;
        for (var i = 0; i <= 10; i++) sum += (a.op[i] || 0) + (a.pp[i] || 0);
        if (sum !== 0) usedFy[code] = sum;
      });
      ITEM_CODES.forEach(function (code) {
        var a = pcuActual[code];
        var sum3 = 0;
        if (a) { for (var i = 8; i <= 10; i++) sum3 += (a.op[i] || 0) + (a.pp[i] || 0); }
        var mean3 = sum3 / 3;
        if (mean3 === 0) {
          var s = pcuStats[code];
          var annualMean = s ? s[2] / 12 : 0;
          if (annualMean !== 0) avg3[code] = annualMean;
        } else {
          avg3[code] = mean3;
        }
      });
    } else {
      // round "2025-10": prev from submitted/received trial Sep request if any, else actual idx11
      var sepReq = findRequestRow_(requests, pcuCode, "2025-09");
      var sepUsable = !!sepReq && (sepReq.status === "submitted" || sepReq.status === "received");
      var sepLines = sepUsable ? linesForRequest_(allLines, requestId_(pcuCode, "2025-09")) : {};
      var idx11 = 11;
      ITEM_CODES.forEach(function (code) {
        if (sepUsable && sepLines[code]) {
          var l = sepLines[code];
          var stock = l.stock === null ? 0 : l.stock;
          var op = l.op || 0, pp = l.pp || 0;
          if (stock !== 0 || op !== 0 || pp !== 0) prevItems[code] = { stock: stock, stock_src: "trial", op: op, pp: pp };
        } else {
          var a = pcuActual[code];
          var op2 = a ? (a.op[idx11] || 0) : 0;
          var pp2 = a ? (a.pp[idx11] || 0) : 0;
          var stock2 = (pcuStock[code] && pcuStock[code][idx11]) || 0;
          if (op2 !== 0 || pp2 !== 0 || stock2 !== 0) prevItems[code] = { stock: stock2, stock_src: "sim", op: op2, pp: pp2 };
        }
      });
      plan = null;
      // sum OP+PP of this PCU's OTHER submitted/received FY2569 requests (none today; forward
      // compatible if more FY2569 rounds are ever added).
      ROUNDS.forEach(function (other) {
        if (other.fy !== round.fy || other.month === round.month) return;
        var req2 = findRequestRow_(requests, pcuCode, other.month);
        if (!req2 || (req2.status !== "submitted" && req2.status !== "received")) return;
        var lines2 = linesForRequest_(allLines, requestId_(pcuCode, other.month));
        Object.keys(lines2).forEach(function (code) {
          var l = lines2[code];
          var total = (l.op || 0) + (l.pp || 0);
          if (total) usedFy[code] = (usedFy[code] || 0) + total;
        });
      });
      ITEM_CODES.forEach(function (code) {
        var a = pcuActual[code];
        var v9 = a ? (a.op[9] || 0) + (a.pp[9] || 0) : 0;
        var v10 = a ? (a.op[10] || 0) + (a.pp[10] || 0) : 0;
        var v11;
        if (sepUsable && sepLines[code]) {
          v11 = (sepLines[code].op || 0) + (sepLines[code].pp || 0);
        } else {
          v11 = a ? (a.op[11] || 0) + (a.pp[11] || 0) : 0;
        }
        var mean3 = (v9 + v10 + v11) / 3;
        if (mean3 === 0) {
          var s = pcuStats[code];
          var annualMean = s ? s[2] / 12 : 0;
          if (annualMean !== 0) avg3[code] = annualMean;
        } else {
          avg3[code] = mean3;
        }
      });
    }

    var reqRow = findRequestRow_(requests, pcuCode, round.month);
    out[round.month] = {
      prev: { month: round.prevMonth, items: prevItems },
      plan: plan,
      used_fy: usedFy,
      avg3: avg3,
      regular: regularCodes_(actualMap[pcuCode] || {}),
      request: buildRequestObj_(reqRow, allLines)
    };
  });
  return out;
}
