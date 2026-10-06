// Pcu.js — PCU-facing actions (API.md "PCU actions"). Every action except pcuList/pcuLogin takes
// a token; the PCU it operates on is ALWAYS token.pcu (never a request parameter), so one PCU's
// token can never read or write another PCU's data.

function pcuPublicInfo_(row) {
  return { code: row.code, name: row.name, print_name: row.print_name || row.name, group: row.group };
}

function action_pcuList() {
  var rows = readTable_(SHEET_NAMES.PCUS);
  return { pcus: rows.map(function (r) { return { code: r.code, name: r.name, group: r.group }; }) };
}

function action_pcuLogin(p) {
  var pcuCode = String(p.pcu || "");
  var pin = String(p.pin || "");
  if (!pcuCode || !/^[0-9]{5}$/.test(pin)) throw apiError_("BAD_REQUEST", "กรอก รพ.สต. และ PIN 5 หลัก");

  var res = LockService_run_(function () {
    var pcus = readTable_(SHEET_NAMES.PCUS);
    var row = null;
    for (var i = 0; i < pcus.length; i++) if (pcus[i].code === pcuCode) { row = pcus[i]; break; }
    if (!row) throw apiError_("NOT_FOUND", "ไม่พบ รพ.สต. นี้");

    var now = Date.now();
    if (row.pin_locked_until) {
      var until = Date.parse(row.pin_locked_until);
      if (!isNaN(until) && until > now) {
        throw apiError_("PIN_LOCKED", "รพ.สต. นี้ถูกล็อกชั่วคราว", { until: row.pin_locked_until });
      }
      // lock expired: clear it and give a fresh attempt window
      row.pin_locked_until = "";
      row.pin_fail = 0;
    }

    var hash = hashPin_(pin, row.pin_salt);
    if (constantTimeEq_(hash, row.pin_hash)) {
      row.pin_fail = 0;
      row.pin_locked_until = "";
      writeTable_(SHEET_NAMES.PCUS, getSheetHeaders_()[SHEET_NAMES.PCUS], pcus);
      var tok = makePcuToken_(row.code, Number(row.pin_version) || 1);
      auditLog_(row.code, "pcuLogin", row.code, "", "ok");
      return { token: tok.token, exp: tok.exp, pcu: pcuPublicInfo_(row), _row: row };
    }

    row.pin_fail = (Number(row.pin_fail) || 0) + 1;
    var locked = row.pin_fail >= PIN_MAX_FAIL;
    if (locked) {
      row.pin_locked_until = new Date(now + PIN_LOCK_MIN * 60 * 1000).toISOString();
    }
    writeTable_(SHEET_NAMES.PCUS, getSheetHeaders_()[SHEET_NAMES.PCUS], pcus);
    auditLog_(row.code, "pcuLogin", row.code, "", "bad_pin fail=" + row.pin_fail);
    if (locked) throw apiError_("PIN_LOCKED", "ใส่ PIN ผิดครบ 5 ครั้ง ถูกล็อกชั่วคราว", { until: row.pin_locked_until });
    throw apiError_("BAD_PIN", "PIN ไม่ถูกต้อง", { remaining: PIN_MAX_FAIL - row.pin_fail });
  });
  // Include the bootstrap payload (built outside the lock) so the client needs one round trip,
  // not two — each Apps Script call costs 3–15 s.
  var row = res._row;
  delete res._row;
  res.bootstrap = action_pcuBootstrap({}, { pcuRow: row });
  return res;
}

function action_pcuBootstrap(p, auth) {
  var row = auth.pcuRow;
  var cfg = getConfigMap_();
  return {
    pcu: pcuPublicInfo_(row),
    config: {
      limit_mode: cfg.limit_mode || "warn",
      cover_over: Number(cfg.cover_over || 3),
      cover_short: Number(cfg.cover_short || 0.5)
    },
    rounds: ROUNDS,
    hidden: getHiddenListForPcu_(row.code),
    never68: computeNever68_(row.code),
    limits: getLimitsForPcu_(row.code),
    byRound: buildByRoundForPcu_(row.code)
  };
}

function action_saveLines(p, auth) {
  var row = auth.pcuRow;
  assertMonth_(p.month);
  var linesIn = p.lines && typeof p.lines === "object" ? p.lines : {};
  var nowStr = nowIso_();

  // Targeted writes: only the touched request row and line rows are written (whole-table
  // rewrites made every autosave take 6–8 s on the real Sheet).
  return LockService_run_(function () {
    var requests = readTableWithRows_(SHEET_NAMES.REQUESTS);
    var allLines = readTableWithRows_(SHEET_NAMES.REQUEST_LINES);
    var reqRow = findRequestRow_(requests, row.code, p.month);
    if (reqRow && (reqRow.status === "submitted" || reqRow.status === "received")) {
      throw apiError_("CONFLICT", "แบบฟอร์มถูกส่งแล้ว แก้ไขไม่ได้");
    }
    var isNewReq = !reqRow;
    if (!reqRow) {
      reqRow = {
        id: requestId_(row.code, p.month), pcu: row.code, month: p.month, status: "draft",
        submitter_name: "", last_step: "", created_at: nowStr, updated_at: nowStr,
        submitted_at: "", received_at: "", return_reason: ""
      };
      requests.push(reqRow);
    }
    var reqId = requestId_(row.code, p.month);
    var changed = [], added = [];

    Object.keys(linesIn).forEach(function (code) {
      assertItemCode_(code);
      var incoming = linesIn[code] || {};
      var stock = assertQty_(incoming.stock);
      var op = assertQty_(incoming.op);
      var pp = assertQty_(incoming.pp);
      var updatedAt = incoming.updated_at || nowStr;

      var existing = null;
      for (var i = 0; i < allLines.length; i++) {
        if (allLines[i].request_id === reqId && allLines[i].item_code === code) { existing = allLines[i]; break; }
      }
      if (existing) {
        if (String(updatedAt) >= String(existing.updated_at || "")) {
          existing.stock = stock; existing.op = op; existing.pp = pp; existing.updated_at = updatedAt;
          if (changed.indexOf(existing) < 0) changed.push(existing);
        } // else: older write, last-write-wins keeps the existing (newer) value
      } else {
        var nl = { request_id: reqId, item_code: code, stock: stock, op: op, pp: pp, updated_at: updatedAt };
        allLines.push(nl);
        added.push(nl);
      }
    });

    reqRow.updated_at = nowStr;
    if (p.last_step) reqRow.last_step = String(p.last_step);
    if (p.submitter_name !== undefined) reqRow.submitter_name = String(p.submitter_name || "");

    var reqHeaders = getSheetHeaders_()[SHEET_NAMES.REQUESTS];
    var lineHeaders = getSheetHeaders_()[SHEET_NAMES.REQUEST_LINES];
    if (isNewReq) appendTable_(SHEET_NAMES.REQUESTS, reqHeaders, [reqRow]);
    else updateRows_(SHEET_NAMES.REQUESTS, reqHeaders, [reqRow]);
    updateRows_(SHEET_NAMES.REQUEST_LINES, lineHeaders, changed);
    appendTable_(SHEET_NAMES.REQUEST_LINES, lineHeaders, added);
    auditLog_(row.code, "saveLines", row.code, p.month, "lines=" + Object.keys(linesIn).length + " last_step=" + (reqRow.last_step || ""));

    return { saved_at: nowStr, status: reqRow.status, request: buildRequestObj_(reqRow, allLines) };
  });
}

function action_submit(p, auth) {
  var row = auth.pcuRow;
  assertMonth_(p.month);

  return LockService_run_(function () {
    var requests = getAllRequests_();
    var allLines = getAllLines_();
    var reqRow = findRequestRow_(requests, row.code, p.month);
    if (reqRow && (reqRow.status === "submitted" || reqRow.status === "received")) {
      throw apiError_("CONFLICT", "แบบฟอร์มถูกส่งแล้ว");
    }
    var reqId = requestId_(row.code, p.month);
    var lines = linesForRequest_(allLines, reqId);
    var hiddenSet = {};
    getHiddenListForPcu_(row.code).forEach(function (c) { hiddenSet[c] = true; });

    var missing = ITEM_CODES.filter(function (code) {
      if (hiddenSet[code]) return false;
      var l = lines[code];
      return !l || l.stock === null || l.stock === undefined;
    });
    if (missing.length) throw apiError_("INCOMPLETE", "กรอกคงเหลือให้ครบทุกรายการก่อนส่ง", { missing: missing });

    var cfg = getConfigMap_();
    if ((cfg.limit_mode || "warn") === "enforce") {
      var limitsMap = getLimitsForPcu_(row.code);
      var round = ROUNDS.filter(function (r) { return r.month === p.month; })[0];
      var byRound = buildByRoundForPcu_(row.code);
      var usedFy = (byRound[p.month] && byRound[p.month].used_fy) || {};
      var overItems = [];
      Object.keys(lines).forEach(function (code) {
        var l = lines[code];
        var total = (l.op || 0) + (l.pp || 0);
        if (!total) return;
        var lim = limitsMap[code] || [null, null];
        var lm = lim[0], ly = lim[1];
        var used = usedFy[code] || 0;
        var overMonth = lm !== null && total > lm;
        var overYear = ly !== null && (used + total) > ly;
        if (overMonth || overYear) overItems.push({ code: code, total: total, limit_month: lm, limit_year: ly, used_fy: used });
      });
      if (overItems.length) throw apiError_("OVER_LIMIT", "มีรายการเกินเพดานเบิก", { items: overItems });
    }

    var nowStr = nowIso_();
    if (!reqRow) {
      reqRow = {
        id: requestId_(row.code, p.month), pcu: row.code, month: p.month, status: "draft",
        submitter_name: "", last_step: "", created_at: nowStr, updated_at: nowStr,
        submitted_at: "", received_at: "", return_reason: ""
      };
      requests.push(reqRow);
    }
    reqRow.status = "submitted";
    reqRow.submitted_at = nowStr;
    reqRow.updated_at = nowStr;
    reqRow.return_reason = "";
    writeTable_(SHEET_NAMES.REQUESTS, getSheetHeaders_()[SHEET_NAMES.REQUESTS], requests);
    auditLog_(row.code, "submit", row.code, p.month, "items=" + Object.keys(lines).length);

    return { request: buildRequestObj_(reqRow, allLines) };
  });
}

function action_withdraw(p, auth) {
  var row = auth.pcuRow;
  assertMonth_(p.month);

  return LockService_run_(function () {
    var requests = getAllRequests_();
    var allLines = getAllLines_();
    var reqRow = findRequestRow_(requests, row.code, p.month);
    if (!reqRow) throw apiError_("NOT_FOUND", "ไม่พบแบบฟอร์ม");
    if (reqRow.status === "received") throw apiError_("CONFLICT", "admin รับเรื่องแล้ว ถอนไม่ได้");
    if (reqRow.status !== "submitted") throw apiError_("CONFLICT", "แบบฟอร์มยังไม่ได้ส่ง");

    reqRow.status = "draft";
    reqRow.updated_at = nowIso_();
    writeTable_(SHEET_NAMES.REQUESTS, getSheetHeaders_()[SHEET_NAMES.REQUESTS], requests);
    auditLog_(row.code, "withdraw", row.code, p.month, "");

    return { request: buildRequestObj_(reqRow, allLines) };
  });
}

function action_setHidden(p, auth) {
  var row = auth.pcuRow;
  var codes = Array.isArray(p.codes) ? p.codes : [];
  codes.forEach(assertItemCode_);
  var uniq = codes.filter(function (c, i) { return codes.indexOf(c) === i; });

  return LockService_run_(function () {
    var rows = readTable_(SHEET_NAMES.HIDDEN).filter(function (r) { return r.pcu !== row.code; });
    var nowStr = nowIso_();
    uniq.forEach(function (code) { rows.push({ pcu: row.code, item_code: code, hidden_at: nowStr, by: row.code }); });
    writeTable_(SHEET_NAMES.HIDDEN, getSheetHeaders_()[SHEET_NAMES.HIDDEN], rows);
    auditLog_(row.code, "setHidden", row.code, "", "count=" + uniq.length);
    return { hidden: uniq };
  });
}
