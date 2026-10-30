// pcu.js — PCU-facing actions (functions/API.md §4). Every action except pcuList/pcuLogin runs with ctx.pcu taken from the token.
import { err, assertQty, isStr, phoneParam } from "./http.js";
import {
  auditStmt, batchChunked, budgetConfig, formForFy, formPublic, getConfigAll, insertStatements, latestForm, limitModeFor, linkMap, linkedCode, loadForm,
  publicConfig,
} from "./db.js";
import {
  PIN_LENGTH, PIN_LOCK_MIN, PIN_MAX_FAIL, constantTimeEq, hashSecret, makePcuToken, newSalt, pcuPublic,
} from "./auth.js";
import { bangkokDate, currentMonth, currentRound, fyMonths, isDate, isMonth, monthFy, nextMonth, nowIso, prevMonth } from "./time.js";
import {
  getLines, getRequestRow, getRoundRows, issueSummary, lineQtyLocked, overLimitItems, pcuMonthView, requestObj, requestId, requestedQty, roundInfo, REQ_COLS,
  REQUESTER_ON_SEND_SQL, firstRequester,
} from "./views.js";
import { ADJ_REASONS, CALC_FROM, baselineFor, computeLine, recalcStockChain } from "./stock.js";
import { loadPriceHistory, priceFor, priceHistories, roundPriceOverrides } from "./price.js";
import { pcuNotices } from "./notices.js";

const PCU_FORM = { pcu: true }; // formPublic option: strip soft-deleted pages
const PIN_RE = new RegExp(`^[0-9]{${PIN_LENGTH}}$`);

// ---- public ------------------------------------------------------------------------------------------------------
export async function pcuList(ctx) {
  const { results } = await ctx.DB.prepare(`SELECT code, name, print_name, "group" AS grp FROM pcus ORDER BY code`).all();
  return { pcus: results.map((r) => ({ code: r.code, name: r.name, print_name: r.print_name || r.name, group: r.grp })) };
}

export async function pcuLogin(ctx, p) {
  const { DB, env } = ctx;
  const code = String(p.pcu || "");
  const pin = String(p.pin || "");
  if (!code || !PIN_RE.test(pin)) throw err("BAD_REQUEST", "กรอก รพ.สต. และ PIN 5 หลัก");
  const row = await DB.prepare(
    `SELECT code, name, print_name, "group" AS grp, pin_hash, pin_salt, pin_version, pin_fail, pin_locked_until, pin_custom, stock_mode, requester_name, phone FROM pcus WHERE code = ?`
  ).bind(code).first();
  if (!row) throw err("NOT_FOUND", "ไม่พบ รพ.สต. นี้");

  const now = Date.now();
  const fail = await checkPinLock(DB, row, now);

  if (await pinMatches(pin, row)) {
    if (fail) await DB.prepare(`UPDATE pcus SET pin_fail = 0, pin_locked_until = NULL WHERE code = ?`).bind(code).run();
    const tok = await makePcuToken(env, row.code, Number(row.pin_version) || 1);
    await DB.batch([
      auditStmt(DB, row.code, "pcu", "pcuLogin", row.code, "", "ok"),
      // 2m: successful PIN logins only (wrong PIN / lock / pcuChangePin / token re-bootstrap never count)
      DB.prepare(`UPDATE pcus SET login_count = login_count + 1, last_login_at = ? WHERE code = ?`).bind(nowIso(), row.code),
    ]);
    const bootstrap = await buildPcuBootstrap(ctx, row);
    return { token: tok.token, exp: tok.exp, pcu: pcuPublic(row), bootstrap };
  }
  await recordPinFailure(DB, code, "pcuLogin", fail, now, "PIN ไม่ถูกต้อง");
}

// 2k: a logged-in PCU changes its own PIN. Wrong old PIN shares pcuLogin's fail counter / lock; on success this device gets a
// fresh token carrying the new pin_version, every other token of this PCU becomes AUTH_EXPIRED (same as adminSetPin).
export async function pcuChangePin(ctx, p) {
  const { DB, env } = ctx;
  const code = ctx.pcu.code;
  const oldPin = p.old_pin, newPin = p.new_pin;
  if (!isStr(oldPin) || !isStr(newPin) || !PIN_RE.test(oldPin) || !PIN_RE.test(newPin)) {
    throw err("BAD_REQUEST", "กรอก PIN เดิมและ PIN ใหม่ให้ครบ 5 หลัก");
  }
  if (newPin === oldPin) throw err("BAD_REQUEST", "PIN ใหม่ต้องต่างจาก PIN เดิม");
  const row = await DB.prepare(`SELECT code, pin_hash, pin_salt, pin_version, pin_fail, pin_locked_until FROM pcus WHERE code = ?`)
    .bind(code).first();
  if (!row) throw err("AUTH_EXPIRED", "ไม่พบ รพ.สต. นี้ กรุณาเข้าสู่ระบบใหม่");

  const now = Date.now();
  const fail = await checkPinLock(DB, row, now);
  if (!(await pinMatches(oldPin, row))) await recordPinFailure(DB, code, "pcuChangePin", fail, now, "PIN เดิมไม่ถูกต้อง");

  const salt = newSalt();
  const res = await DB.batch([
    DB.prepare(
      `UPDATE pcus SET pin_hash = ?, pin_salt = ?, pin_version = COALESCE(pin_version,1) + 1, pin_fail = 0, pin_locked_until = NULL, pin_custom = 1 WHERE code = ? RETURNING pin_version`
    ).bind(await hashSecret(newPin, salt), salt, code),
    auditStmt(DB, code, "pcu", "pcuChangePin", code, "", "ok"),
  ]);
  const ret = res[0] && res[0].results && res[0].results[0];
  const version = Number(ret && ret.pin_version) || (Number(row.pin_version) || 1) + 1;
  const tok = await makePcuToken(env, code, version);
  return { token: tok.token, exp: tok.exp };
}

// ---- PIN helpers (shared by pcuLogin / pcuChangePin) ----------------------------------------------------------------
const pinMatches = async (pin, row) => constantTimeEq(await hashSecret(pin, row.pin_salt || ""), row.pin_hash || "");

// Throws PIN_LOCKED while a lock is active; clears an expired lock. Returns the failure count to continue from.
async function checkPinLock(DB, row, now) {
  let fail = Number(row.pin_fail) || 0;
  if (row.pin_locked_until) {
    const until = Date.parse(row.pin_locked_until);
    if (!Number.isNaN(until) && until > now) throw err("PIN_LOCKED", "รพ.สต. นี้ถูกล็อกชั่วคราว", { until: row.pin_locked_until });
    fail = 0; // lock expired → fresh attempt window
    await DB.prepare(`UPDATE pcus SET pin_fail = 0, pin_locked_until = NULL WHERE code = ?`).bind(row.code).run();
  }
  return fail;
}

// Counts one wrong PIN for `code` (audited under `action`) and always throws: BAD_PIN{remaining}, or PIN_LOCKED{until} on the 5th.
async function recordPinFailure(DB, code, action, fail, now, badMsg) {
  // atomic increment so concurrent wrong attempts cannot dodge the lock
  const upd = await DB.prepare(`UPDATE pcus SET pin_fail = COALESCE(pin_fail,0) + 1 WHERE code = ? RETURNING pin_fail`).bind(code).first();
  const nf = Number(upd && upd.pin_fail) || fail + 1;
  if (nf >= PIN_MAX_FAIL) {
    const until = new Date(now + PIN_LOCK_MIN * 60000).toISOString();
    await DB.batch([
      DB.prepare(`UPDATE pcus SET pin_locked_until = ? WHERE code = ?`).bind(until, code),
      auditStmt(DB, code, "pcu", action, code, "", "locked"),
    ]);
    throw err("PIN_LOCKED", "ใส่ PIN ผิดครบ 5 ครั้ง ถูกล็อกชั่วคราว 5 นาที", { until });
  }
  await DB.batch([auditStmt(DB, code, "pcu", action, code, "", `bad_pin fail=${nf}`)]);
  throw err("BAD_PIN", badMsg, { remaining: PIN_MAX_FAIL - nf });
}

// ---- bootstrap -----------------------------------------------------------------------------------------------------
export async function buildPcuBootstrap(ctx, pcuRow) {
  const { DB } = ctx;
  // 2j: cur = currentRound (open for keying), prev = prevRound = calMonth (still editable)
  const cal = currentMonth(), cur = nextMonth(cal), prev = cal;
  const cfgAll = await getConfigAll(DB);
  const cfg = publicConfig(cfgAll, monthFy(cur));
  const fy = cfg.fy_current;
  const code = pcuRow.code;
  const nxt = nextMonth(cur);
  // 2l: history = every round month from the first round of FY F-1 (F = monthFy(cur)) up to (excluding) prev, newest first
  const histFrom = fyMonths(monthFy(cur) - 1)[0];

  const [form, hiddenRes, limRes, planRes, roundRows, [histReqRes, histRoundRes], actualRes, pricesRes, curView, prevView, noticeRes, reqFirst, live] = await Promise.all([
    latestForm(DB, fy),
    DB.prepare(`SELECT item_code FROM hidden_items WHERE pcu = ?`).bind(code).all(),
    DB.prepare(`SELECT item_code, limit_month, limit_year FROM limits WHERE fy = ? AND pcu = ?`).bind(fy, code).all(),
    DB.prepare(`SELECT item_code, plan_op, plan_pp FROM plans WHERE fy = ? AND pcu = ?`).bind(fy, code).all(),
    getRoundRows(DB, [nxt, cur, prev]),
    Promise.all([
      DB.prepare(`SELECT month, status, submitted_at, no_order FROM requests WHERE pcu = ? AND month >= ? AND month < ?`).bind(code, histFrom, prev).all(),
      DB.prepare(`SELECT month, locked FROM rounds WHERE month >= ? AND month < ?`).bind(histFrom, prev).all(),
    ]),
    DB.prepare(`SELECT DISTINCT item_code FROM actual_prev WHERE fy = ? AND pcu = ? AND (COALESCE(op,0) > 0 OR COALESCE(pp,0) > 0)`).bind(fy - 1, code).all(),
    DB.prepare(`SELECT item_code FROM prices_prev WHERE fy = ?`).bind(fy - 1).all(),
    pcuMonthView(DB, code, cur, fy),
    pcuMonthView(DB, code, prev, fy),
    DB.prepare(`SELECT ${REQ_COLS} FROM requests WHERE pcu = ? AND status = 'issued' AND issued_seen_at IS NULL`).bind(code).all(),
    firstRequester(DB, code),
    pcuNotices(DB), // 2ae
  ]);

  // never_prev: active items this PCU never withdrew last fy (only meaningful when we have history for the PCU)
  let neverPrev = [];
  if (form && actualRes.results.length) {
    const lm = linkMap(form); // 2v: history of a linked old code is the history of the item that replaces it
    const had = new Set(actualRes.results.map((r) => linkedCode(lm, r.item_code)));
    const known = pricesRes.results.length ? new Set(pricesRes.results.map((r) => linkedCode(lm, r.item_code))) : null;
    for (const [c, { item }] of form.index) {
      if (item.active === false || had.has(c)) continue;
      if (known && !known.has(c)) continue; // brand-new item: no history, not "never withdrawn"
      neverPrev.push(c);
    }
  }

  const histReq = new Map(histReqRes.results.map((r) => [r.month, r]));
  const histLocked = new Map(histRoundRes.results.map((r) => [r.month, !!r.locked]));
  const history = [];
  for (let m = prevMonth(prev); m >= histFrom; m = prevMonth(m)) {
    const r = histReq.get(m);
    history.push({
      month: m, fy: monthFy(m), trial: !!cfg.trial_month && m === cfg.trial_month, locked: histLocked.get(m) || false,
      status: r ? r.status : "not_started", submitted_at: (r && r.submitted_at) || null, no_order: !!(r && r.no_order), // 2af
    });
  }

  const limits = {}, plans = {};
  for (const r of limRes.results) limits[r.item_code] = [null, r.limit_year ?? null]; // 2z (R10): the PCU never sees the monthly ceiling
  for (const r of planRes.results) plans[r.item_code] = [r.plan_op || 0, r.plan_pp || 0];

  const notices = [];
  for (const rr of noticeRes.results) {
    const [lines, units] = await Promise.all([
      getLines(DB, rr.id),
      DB.prepare(`SELECT dispense_unit FROM issue_status WHERE request_id = ?`).bind(rr.id).all(),
    ]);
    const s = await issueSummary(DB, rr, lines, units.results.map((u) => u.dispense_unit), fy);
    if (s) notices.push({ month: rr.month, complete: s.complete, incomplete: s.incomplete });
  }

  // forms bound to the shown requests when they differ from the latest (another fy's form) — PCU-stripped; 2t: also the latest form itself,
  // unstripped, when the request still carries a quantity on one of its closed pages
  const forms = {};
  const boundOf = {}; // 2p: round → [bound form] (prices that differ from it are listed too)
  for (const [m, v] of [[cur, curView.view], [prev, prevView.view]]) {
    const fid = v.request && v.request.form_version_id;
    if (fid && form && fid !== form.id) {
      const f = await loadForm(DB, fid);
      if (f) { boundOf[m] = [f]; if (!forms[fid]) forms[fid] = formPublic(f, closedPageQty(f, v.request) ? undefined : PCU_FORM); }
    } else if (fid && form && closedPageQty(form, v.request)) forms[fid] = formPublic(form);
  }
  // 2p: price of each shown round (price_history) where it differs from the form price
  const prices = await roundPriceOverrides(priceHistories(DB), form, [cur, prev], monthFy, boundOf);

  return {
    server_time: nowIso(), current_month: cal, current_round: cur,
    pcu: {
      ...pcuPublic(pcuRow), pin_custom: !!pcuRow.pin_custom, stock_mode: pcuRow.stock_mode === "B" ? "B" : "A", // 2o
      // 2x: requester name (admin sets it; the pcu only sees it) · default phone · first logged name (sheets sent before 2x print with it)
      requester_name: pcuRow.requester_name || null, phone: pcuRow.phone || null, requester_first: reqFirst,
    },
    config: cfg,
    form_version_id: form ? form.id : null,
    form: formPublic(form, PCU_FORM),
    forms,
    rounds: [cur, prev].map((m) => roundInfo(m, roundRows.get(m), cfg.deadline_day, cfg.trial_month)),
    next_round: { ...roundInfo(nxt, roundRows.get(nxt), cfg.deadline_day, cfg.trial_month), opens_on: `${cur}-01` },
    history,
    hidden: hiddenRes.results.map((r) => r.item_code),
    never_prev: neverPrev,
    limits, plans,
    unlocks: { [cur]: curView.unlocks, [prev]: prevView.unlocks },
    byMonth: { [cur]: curView.view, [prev]: prevView.view },
    issue_notices: notices,
    prices, // 2p: { round: {code: price} } — only codes whose round price differs from the form ({} per round when none)
    item_flags: live.item_flags, // 2ae: {code: {status, note, eta}} — every PCU, never blocks ordering
    announcements: live.announcements, // 2ae: live admin banners for the home page, newest first
  };
}

// 2t: does `req` carry a quantity on an item of a closed page of `form`? (a PCU-stripped copy would hide that line)
function closedPageQty(form, req) {
  const lines = req && req.lines;
  if (!form || !lines) return false;
  for (const s of form.steps) {
    if (s.active !== false) continue;
    for (const r of s.rows) if (r.type === "item" && lines[r.code] && (Number(lines[r.code].op) || 0) + (Number(lines[r.code].pp) || 0) > 0) return true;
  }
  return false;
}

export async function pcuBootstrap(ctx) {
  return buildPcuBootstrap(ctx, ctx.pcu);
}

export async function pcuGetMonth(ctx, p) {
  const { DB, pcu } = ctx;
  if (!isMonth(p.month)) throw err("BAD_REQUEST", "เดือนไม่ถูกต้อง");
  const round = currentRound();
  if (p.month > round) throw err("BAD_REQUEST", "เดือนนี้ยังไม่ถึง");
  const cfg = publicConfig(await getConfigAll(DB), monthFy(round));
  const { view, unlocks } = await pcuMonthView(DB, pcu.code, p.month, cfg.fy_current);
  const rounds = await getRoundRows(DB, [p.month]);
  const out = { month: p.month, ...view, unlocks, round: roundInfo(p.month, rounds.get(p.month), cfg.deadline_day, cfg.trial_month) };
  // the bound form version, only when it differs from the latest (2d)
  const fid = view.request && view.request.form_version_id;
  const latest = await latestForm(DB, cfg.fy_current);
  let bound = null;
  if (fid && latest && latest.id !== fid) {
    bound = await loadForm(DB, fid);
    if (bound) out.form = formPublic(bound, closedPageQty(bound, view.request) ? undefined : PCU_FORM);
  } else if (fid && latest && closedPageQty(latest, view.request)) out.form = formPublic(latest); // 2t: closed page with a quantity
  // 2p: same shape as pcuBootstrap.prices, for this month only
  out.prices = await roundPriceOverrides(priceHistories(DB), latest, [p.month], monthFy, bound ? { [p.month]: [bound] } : {});
  return out;
}

// ---- saveLines (autosave + submit) ------------------------------------------------------------------------------------------
const MAX_LINES = 400;

export async function saveLines(ctx, p) {
  const { DB, pcu } = ctx;
  const month = p.month;
  if (!isMonth(month)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง");
  const cal = currentMonth(), cur = nextMonth(cal); // 2j: writable = currentRound (cur) and prevRound (cal)
  if (month > cur) throw err("BAD_REQUEST", "ยังไม่ถึงรอบเดือนนี้");
  const linesIn = p.lines && typeof p.lines === "object" && !Array.isArray(p.lines) ? p.lines : {};
  const codes = Object.keys(linesIn);
  if (codes.length > MAX_LINES) throw err("BAD_REQUEST", "จำนวนบรรทัดมากเกินไป");
  const now = nowIso();

  // pure validation first. 2o: used / adj / adj_reason / calc_from are optional — a key that is not sent keeps the stored value.
  const parsed = codes.map((code) => {
    const l = linesIn[code] && typeof linesIn[code] === "object" ? linesIn[code] : {};
    let ua = l.updated_at;
    if (typeof ua === "number" && Number.isFinite(ua)) ua = new Date(ua).toISOString();
    if (!isStr(ua) || !ua) ua = now;
    return {
      code, stock: assertQty(l.stock), op: assertQty(l.op), pp: assertQty(l.pp), updated_at: ua,
      used: has(l, "used") ? assertQty(l.used) : undefined,
      adj: has(l, "adj") ? assertAdj(l.adj) : undefined,
      adj_reason: has(l, "adj_reason") ? assertAdjReason(l.adj_reason) : undefined,
      calc_from: has(l, "calc_from") ? assertCalcFrom(l.calc_from) : undefined,
    };
  });

  const cfgAll = await getConfigAll(DB);
  const cfg = publicConfig(cfgAll, monthFy(cur));
  const fy = monthFy(month);
  const [reqRow, roundRow, latest] = await Promise.all([
    getRequestRow(DB, pcu.code, month),
    DB.prepare(`SELECT locked FROM rounds WHERE month = ?`).bind(month).first(),
    formForFy(DB, fy, cfg.fy_current),
  ]);
  if (!reqRow && month !== cur && month !== cal) throw err("BAD_REQUEST", "เดือนนี้ไม่เปิดให้กรอก");
  if (roundRow && roundRow.locked) throw err("CONFLICT", "รอบนี้ปิดรับแล้ว แก้ไขไม่ได้");
  if (!latest) throw err("NOT_FOUND", "ยังไม่มีแบบฟอร์มในระบบ");
  const bound = reqRow && reqRow.form_version_id ? await loadForm(DB, reqRow.form_version_id) : null;
  for (const l of parsed) {
    if (!latest.index.has(l.code) && !(bound && bound.index.has(l.code))) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + l.code);
  }

  const id = requestId(pcu.code, month);

  // 2o: merge omitted fields with the stored line, then the server computes the outputs (never trusts client-computed values)
  const existingRows = reqRow && parsed.length ? await getLines(DB, id) : [];
  const existing = new Map(existingRows.map((l) => [l.item_code, l]));
  const keep = (l, e, k) => (l[k] !== undefined ? l[k] : e ? e[k] ?? null : null);
  for (const l of parsed) {
    const e = existing.get(l.code);
    l.used = keep(l, e, "used"); l.adj = keep(l, e, "adj"); l.adj_reason = keep(l, e, "adj_reason"); l.calc_from = keep(l, e, "calc_from");
    l.sent = { stock: l.stock, used: l.used };
  }
  const base = parsed.some((l) => l.calc_from) ? await baselineFor(DB, pcu.code, month) : {};
  for (const l of parsed) Object.assign(l, computeLine(base[l.code], l));

  // 2ad: per line, not per page (the 2c page lock is gone) — the requested quantity of a line with a recorded issue stays as it is
  // (stock / used / adj still change), and a permanently cancelled item (active:false in the latest form) takes no new quantity.
  // Every offending line is listed with its stored op/pp so the client can put them back in one go (sync.js).
  // 2af: a "ไม่เบิก" month takes no requested quantity (stock / used still change) until the PCU cancels it (pcuNoOrderCancel).
  const qtyLocked = [], cancelled = [], noOrder = [];
  for (const l of parsed) {
    const e = existing.get(l.code);
    const sameQty = (e ? e.op ?? null : null) === l.op && (e ? e.pp ?? null : null) === l.pp;
    if (sameQty) continue;
    if (lineQtyLocked(e)) { qtyLocked.push({ code: l.code, op: e.op ?? null, pp: e.pp ?? null }); continue; }
    if (reqRow && reqRow.no_order && (l.op || 0) + (l.pp || 0) > 0) { noOrder.push({ code: l.code, op: e ? e.op ?? null : null, pp: e ? e.pp ?? null : null }); continue; }
    const ent = latest.index.get(l.code);
    if (ent && ent.item.active === false && (l.op || 0) + (l.pp || 0) > 0) cancelled.push({ code: l.code, op: e ? e.op ?? null : null, pp: e ? e.pp ?? null : null });
  }
  if (qtyLocked.length) {
    throw err("LINE_LOCKED", "รายการนี้บันทึกรับของแล้ว ยอดขอคงไว้ตามเดิม (แก้คงเหลือ/ใช้ไปได้)", { items: qtyLocked });
  }
  if (cancelled.length) throw err("ITEM_CANCELLED", "รายการนี้ยกเลิกถาวรแล้ว ขอเพิ่มไม่ได้", { items: cancelled });
  if (noOrder.length) throw err("NO_ORDER", "เดือนนี้แจ้ง \"ไม่เบิก\" ไว้ — กดยกเลิก \"ไม่เบิก\" ก่อนจึงกรอกยอดขอได้ (คงเหลือกรอกได้ตามปกติ)", { items: noOrder });

  // ---- write lines (per-line last-write-wins in SQL) ----
  const stmts = [];
  if (!reqRow) {
    stmts.push(DB.prepare(
      `INSERT OR IGNORE INTO requests (id,pcu,month,status,created_at,updated_at,submit_count) VALUES (?,?,?, 'draft', ?, ?, 0)`
    ).bind(id, pcu.code, month, now, now));
  }
  const nLineStart = stmts.length;
  for (const l of parsed) {
    stmts.push(DB.prepare(
      `INSERT INTO request_lines (request_id,item_code,stock,op,pp,used,adj,adj_reason,calc_from,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(request_id,item_code) DO UPDATE SET stock=excluded.stock, op=excluded.op, pp=excluded.pp, used=excluded.used, adj=excluded.adj,
         adj_reason=excluded.adj_reason, calc_from=excluded.calc_from, updated_at=excluded.updated_at
       WHERE request_lines.updated_at IS NULL OR excluded.updated_at > request_lines.updated_at`
    ).bind(id, l.code, l.stock, l.op, l.pp, l.used, l.adj, l.adj_reason, l.calc_from, l.updated_at));
  }
  const metaSets = [], metaVals = [];
  if (p.last_step !== undefined && p.last_step !== null && String(p.last_step)) { metaSets.push("last_step = ?"); metaVals.push(String(p.last_step).slice(0, 64)); }
  if (p.submitter_name !== undefined && p.submitter_name !== null) { metaSets.push("submitter_name = ?"); metaVals.push(String(p.submitter_name).slice(0, 120)); }
  if (metaSets.length) stmts.push(DB.prepare(`UPDATE requests SET ${metaSets.join(", ")} WHERE id = ?`).bind(...metaVals, id));

  let changed = 0, qtyChanged = false;
  const recalc = {}; // 2o: written lines whose stored stock/used differ from what the client sent
  if (stmts.length) {
    const res = await batchChunked(DB, stmts);
    parsed.forEach((l, i) => {
      const n = (res[nLineStart + i] && res[nLineStart + i].meta && res[nLineStart + i].meta.changes) || 0;
      if (!n) return;
      changed += n;
      const e = existing.get(l.code) || {};
      if (["stock", "op", "pp", "used", "adj"].some((k) => (e[k] ?? null) !== l[k])) qtyChanged = true;
      if (l.stock !== l.sent.stock || l.used !== l.sent.used) recalc[l.code] = { stock: l.stock, used: l.used };
    });
  }
  if (changed > 0) {
    await DB.prepare(`UPDATE requests SET updated_at = ? WHERE id = ?`).bind(now, id).run();
  }
  // 2o: the next rounds' calc lines use this round as baseline (only once it is sent) — recalc them (no updated_at bump, no audit)
  const wasSent = !!reqRow && reqRow.status !== "draft";
  if (qtyChanged && wasSent) await recalcStockChain(DB, pcu.code, month);

  // ---- send: validate + stamp the submission ----
  let submitted = false, overLimit = [];
  if (p.send === true || p.send === 1 || p.send === "1") {
    const lines = await getLines(DB, id);
    if (cfg.stock_required === 1) {
      const { results: hid } = await DB.prepare(`SELECT item_code FROM hidden_items WHERE pcu = ?`).bind(pcu.code).all();
      const hidden = new Set(hid.map((r) => r.item_code));
      const have = new Map(lines.map((l) => [l.item_code, l]));
      const missing = [];
      for (const [c, { item }] of latest.index) {
        if (item.active === false || hidden.has(c)) continue;
        const l = have.get(c);
        if (!l || l.stock === null || l.stock === undefined) missing.push(c);
      }
      if (missing.length) throw err("INCOMPLETE", "กรอกคงเหลือให้ครบทุกรายการก่อนส่ง", { missing });
    }
    // 2z (Q10): over the yearly ceiling is information only — never blocks the send · 2ad: off from fy 2570 (limitModeFor)
    if (limitModeFor(cfgAll, fy) !== "off") overLimit = await overLimitItems(DB, pcu.code, month, lines);
    // 2z: the price of the fy (its latest form) — both the calculation price (price_snapshot) and the printed price (price_print); a later
    // price change rewrites both on every sent line of the fy (adminFormSave)
    const hist = await loadPriceHistory(DB, fy);
    const fin = [];
    for (const l of lines) {
      const c = l.item_code;
      const price = priceFor(hist, latest.index.has(c) ? latest : bound, c, month);
      fin.push(DB.prepare(`UPDATE request_lines SET price_snapshot = ?, price_print = ? WHERE request_id = ? AND item_code = ?`).bind(price, price, id, c));
    }
    fin.push(DB.prepare(
      `UPDATE requests SET status = CASE WHEN status = 'issued' THEN 'issued' ELSE 'submitted' END, form_version_id = ?, submitted_at = ?, updated_at = ?,
              first_submitted_at = COALESCE(first_submitted_at, ?), submit_count = COALESCE(submit_count,0) + 1,
              requester_name = ${REQUESTER_ON_SEND_SQL} WHERE id = ?`
    ).bind(latest.id, now, now, now, pcu.code, pcu.code, pcu.code, id)); // 2x: requester name frozen at the first send
    const n = lines.filter((l) => (l.op || 0) + (l.pp || 0) > 0).length;
    fin.push(auditStmt(DB, pcu.code, "pcu", "submit", pcu.code, month, `items=${n} form_version=${latest.id}`));
    await batchChunked(DB, fin);
    submitted = true;
    if (!wasSent) await recalcStockChain(DB, pcu.code, month); // first send: this round just became a baseline
  }

  const [row2, lines2] = await Promise.all([getRequestRow(DB, pcu.code, month), getLines(DB, id)]);
  return { saved_at: now, status: row2.status, submitted, over_limit: overLimit, request: requestObj(row2, lines2, false), recalc };
}

// ---- 2af: เดือนนี้ไม่เบิก ----------------------------------------------------------------------------------------------------------
// The writable window of a month is saveLines' (currentRound / prevRound, or an existing request) and closes with the round (CONFLICT).
async function noOrderContext(ctx, month) {
  const { DB, pcu } = ctx;
  if (!isMonth(month)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง");
  const cal = currentMonth(), cur = nextMonth(cal);
  if (month > cur) throw err("BAD_REQUEST", "ยังไม่ถึงรอบเดือนนี้");
  const [reqRow, roundRow] = await Promise.all([
    getRequestRow(DB, pcu.code, month),
    DB.prepare(`SELECT locked FROM rounds WHERE month = ?`).bind(month).first(),
  ]);
  if (!reqRow && month !== cur && month !== cal) throw err("BAD_REQUEST", "เดือนนี้ไม่เปิดให้กรอก");
  if (roundRow && roundRow.locked) throw err("CONFLICT", "รอบนี้ปิดรับแล้ว เปลี่ยนแปลงไม่ได้");
  return { reqRow, id: requestId(pcu.code, month) };
}

// pcuNoOrder{month} — send the month as "ไม่เบิก": every requested quantity is cleared (op/pp → null, only rows that had one are written),
// the request becomes 'submitted' with no_order = 1 (counts as sent, no issue work). stock / used stay as they are and editable.
// A line whose quantity is locked (issue recorded / received reported — lineQtyLocked) → HAS_LOCKED_LINES{items:[codes]}, nothing written.
export async function pcuNoOrder(ctx, p) {
  const { DB, pcu } = ctx;
  const month = p.month;
  const { reqRow, id } = await noOrderContext(ctx, month);
  const lines = reqRow ? await getLines(DB, id) : [];
  if (reqRow && reqRow.no_order) return { request: requestObj(reqRow, lines, false), cleared: 0 };
  const locked = lines.filter((l) => lineQtyLocked(l)).map((l) => l.item_code);
  if (locked.length) {
    throw err("HAS_LOCKED_LINES", "แจ้ง \"ไม่เบิก\" ไม่ได้ เพราะมีรายการที่บันทึกจ่ายหรือแจ้งได้รับแล้ว — ใบเดือนนี้คงไว้ตามเดิม", { items: locked });
  }
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentRound()));
  const latest = await formForFy(DB, monthFy(month), cfg.fy_current);
  if (!latest) throw err("NOT_FOUND", "ยังไม่มีแบบฟอร์มในระบบ");
  const now = nowIso();
  const cleared = lines.filter((l) => requestedQty(l) > 0).length;
  const stmts = [];
  if (!reqRow) {
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO requests (id,pcu,month,status,created_at,updated_at,submit_count) VALUES (?,?,?, 'draft', ?, ?, 0)`)
      .bind(id, pcu.code, month, now, now));
  }
  if (cleared) {
    stmts.push(DB.prepare(`UPDATE request_lines SET op = NULL, pp = NULL, updated_at = ? WHERE request_id = ? AND (COALESCE(op,0) <> 0 OR COALESCE(pp,0) <> 0)`)
      .bind(now, id));
  }
  stmts.push(DB.prepare(
    `UPDATE requests SET no_order = 1, status = CASE WHEN status = 'issued' THEN 'issued' ELSE 'submitted' END, form_version_id = ?, submitted_at = ?,
            updated_at = ?, first_submitted_at = COALESCE(first_submitted_at, ?), submit_count = COALESCE(submit_count,0) + 1 WHERE id = ?`
  ).bind(latest.id, now, now, now, id));
  stmts.push(auditStmt(DB, pcu.code, "pcu", "pcuNoOrder", pcu.code, month, `cleared=${cleared}`));
  await DB.batch(stmts);
  await recalcStockChain(DB, pcu.code, month); // this round is now a baseline with nothing received
  const [row2, lines2] = await Promise.all([getRequestRow(DB, pcu.code, month), getLines(DB, id)]);
  return { request: requestObj(row2, lines2, false), cleared };
}

// pcuNoOrderCancel{month} — back to an ordinary draft (fill + send again) until the round closes. Not "ไม่เบิก" → BAD_REQUEST.
export async function pcuNoOrderCancel(ctx, p) {
  const { DB, pcu } = ctx;
  const month = p.month;
  const { reqRow, id } = await noOrderContext(ctx, month);
  if (!reqRow || !reqRow.no_order) throw err("BAD_REQUEST", "เดือนนี้ไม่ได้แจ้ง \"ไม่เบิก\"");
  const now = nowIso();
  await DB.batch([
    DB.prepare(`UPDATE requests SET no_order = 0, status = CASE WHEN status = 'issued' THEN 'issued' ELSE 'draft' END, updated_at = ? WHERE id = ?`).bind(now, id),
    auditStmt(DB, pcu.code, "pcu", "pcuNoOrderCancel", pcu.code, month, ""),
  ]);
  await recalcStockChain(DB, pcu.code, month); // no longer a sent baseline
  const [row2, lines2] = await Promise.all([getRequestRow(DB, pcu.code, month), getLines(DB, id)]);
  return { request: requestObj(row2, lines2, false) };
}

// ---- 2af: รายงานของได้จริง ---------------------------------------------------------------------------------------------------------
// pcuReceivedSave{month, lines:[{code, qty|null, received_date?, note?}]} — what the PCU actually got, per requested line (op+pp > 0) of a
// sent request of fy_current or the fy before (any month, closed rounds too). qty null = remove the report (back to "not reported").
// received_date defaults to today (Bangkok), never in the future. Stored in received_reports only (issued_* untouched); only rows whose
// values change are written. A reported line's requested quantity is then locked (lineQtyLocked).
const RCV_NOTE_MAX = 200;
export async function pcuReceivedSave(ctx, p) {
  const { DB, pcu } = ctx;
  const month = p.month;
  if (!isMonth(month)) throw err("BAD_REQUEST", "เดือนไม่ถูกต้อง");
  if (month > currentRound()) throw err("BAD_REQUEST", "เดือนนี้ยังไม่ถึง");
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentRound()));
  const fy = monthFy(month);
  if (fy !== cfg.fy_current && fy !== cfg.fy_current - 1) throw err("BAD_REQUEST", `แจ้งได้รับได้เฉพาะเดือนของปีงบ ${cfg.fy_current - 1}–${cfg.fy_current}`);
  const linesIn = Array.isArray(p.lines) ? p.lines : null;
  if (!linesIn || !linesIn.length) throw err("BAD_REQUEST", "ไม่มีรายการที่จะบันทึก");
  if (linesIn.length > MAX_LINES) throw err("BAD_REQUEST", "จำนวนบรรทัดมากเกินไป");
  const reqRow = await getRequestRow(DB, pcu.code, month);
  if (!reqRow || !(reqRow.status === "submitted" || reqRow.status === "issued")) throw err("NOT_FOUND", "ยังไม่ได้ส่งใบเบิกเดือนนี้ จึงแจ้งได้รับไม่ได้");
  const lines = await getLines(DB, reqRow.id);
  const byCode = new Map(lines.map((l) => [l.item_code, l]));
  const today = bangkokDate();

  const plan = [], seen = new Set();
  for (const raw of linesIn) {
    const r = raw && typeof raw === "object" ? raw : {};
    const code = r.code;
    if (!isStr(code) || !code) throw err("BAD_REQUEST", "ต้องระบุ code");
    if (seen.has(code)) throw err("BAD_REQUEST", "รหัสรายการซ้ำ: " + code);
    seen.add(code);
    const l = byCode.get(code);
    if (!l || requestedQty(l) <= 0) throw err("BAD_REQUEST", `รายการ ${code} ไม่ได้ขอในเดือนนี้ จึงแจ้งได้รับไม่ได้`, { item_code: code });
    if (!has(r, "qty")) throw err("BAD_REQUEST", "ต้องระบุ qty (จำนวนเต็ม หรือ null เพื่อลบการแจ้ง)");
    const qty = r.qty === null ? null : assertQty(r.qty === "" ? undefined : r.qty);
    if (r.qty !== null && qty === null) throw err("BAD_REQUEST", "จำนวนที่ได้รับต้องเป็นเลขจำนวนเต็ม 0–99999 (null = ลบการแจ้ง)");
    if (qty === null) { if (l.rcv_qty !== null && l.rcv_qty !== undefined) plan.push({ code, del: true }); continue; }
    let date = r.received_date === undefined || r.received_date === null || r.received_date === "" ? (l.rcv_date || today) : r.received_date;
    if (!isDate(date)) throw err("BAD_REQUEST", "วันที่รับไม่ถูกต้อง (YYYY-MM-DD)");
    if (date > today) throw err("BAD_REQUEST", "วันที่รับต้องไม่เกินวันนี้");
    let note = r.note === undefined ? l.rcv_note ?? null : r.note;
    if (note !== null && !isStr(note)) throw err("BAD_REQUEST", "หมายเหตุต้องเป็นข้อความ");
    note = note === null ? null : note.trim().slice(0, RCV_NOTE_MAX) || null;
    if (l.rcv_qty === qty && (l.rcv_date ?? null) === date && (l.rcv_note ?? null) === note) continue; // unchanged → no write
    plan.push({ code, qty, date, note });
  }

  if (plan.length) {
    const now = nowIso();
    const stmts = plan.map((x) => x.del
      ? DB.prepare(`DELETE FROM received_reports WHERE request_id = ? AND item_code = ?`).bind(reqRow.id, x.code)
      : DB.prepare(
          `INSERT INTO received_reports (request_id,item_code,qty,received_date,note,reported_by,reported_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(request_id,item_code) DO UPDATE SET qty=excluded.qty, received_date=excluded.received_date, note=excluded.note,
             reported_by=excluded.reported_by, reported_at=excluded.reported_at`
        ).bind(reqRow.id, x.code, x.qty, x.date, x.note, pcu.code, now));
    stmts.push(auditStmt(DB, pcu.code, "pcu", "pcuReceivedSave", pcu.code, month,
      plan.map((x) => (x.del ? `${x.code}=null` : `${x.code}=${x.qty}`)).join(" ").slice(0, 1500)));
    await batchChunked(DB, stmts);
  }
  const { view } = await pcuMonthView(DB, pcu.code, month, cfg.fy_current);
  return { changed: plan.length, request: view.request, issue: view.issue };
}

// ---- 2o: stock mode + saveLines field rules ------------------------------------------------------------------------------------
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function assertAdj(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < -99999 || n > 99999) throw err("BAD_REQUEST", "ปรับยอดต้องเป็นเลขจำนวนเต็ม −99999 ถึง 99999 หรือว่าง");
  return n;
}
function assertAdjReason(v) {
  if (v === null || v === undefined || v === "") return null;
  if (!ADJ_REASONS.includes(v)) throw err("BAD_REQUEST", "เหตุผลปรับยอดไม่ถูกต้อง (ได้รับเพิ่ม · ยืม/คืน · หมดอายุ/เสียหาย · นับใหม่ · อื่น ๆ)");
  return v;
}
function assertCalcFrom(v) {
  if (v === null || v === undefined || v === "") return null;
  if (!CALC_FROM.includes(v)) throw err("BAD_REQUEST", "ช่องที่ใช้คำนวณต้องเป็น ใช้ไป (used) หรือ คงเหลือ (stock) หรือว่าง");
  return v;
}

// pcuSetStockMode{mode:'A'|'B'} — A = กรอกคงเหลือเอง · B = คำนวณคงเหลือจากยอดใช้ไป (stored per PCU; switching never touches line values)
export async function pcuSetStockMode(ctx, p) {
  const { DB, pcu } = ctx;
  if (p.mode !== "A" && p.mode !== "B") throw err("BAD_REQUEST", "โหมดต้องเป็น A หรือ B");
  await DB.batch([
    DB.prepare(`UPDATE pcus SET stock_mode = ? WHERE code = ?`).bind(p.mode, pcu.code),
    auditStmt(DB, pcu.code, "pcu", "pcuSetStockMode", pcu.code, "", p.mode),
  ]);
  return { stock_mode: p.mode };
}

// 2x R8: pcuSetPhone{phone} — the pcu's default "โทร" number ("จำเป็นค่าเริ่มต้น" on the print page). "" clears it. Writes only on change.
export async function pcuSetPhone(ctx, p) {
  const { DB, pcu } = ctx;
  const phone = phoneParam(p.phone);
  if ((pcu.phone || null) === phone) return { phone };
  await DB.batch([
    DB.prepare(`UPDATE pcus SET phone = ? WHERE code = ?`).bind(phone, pcu.code),
    auditStmt(DB, pcu.code, "pcu", "pcuSetPhone", pcu.code, "", phone || ""),
  ]);
  return { phone };
}

// ---- hidden ---------------------------------------------------------------------------------------------------------------------
export async function setHidden(ctx, p) {
  const { DB, pcu } = ctx;
  const codes = Array.isArray(p.codes) ? p.codes : [];
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentRound()));
  const form = await latestForm(DB, cfg.fy_current);
  for (const c of codes) if (!isStr(c) || !form || !form.index.has(c)) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + c);
  const uniq = [...new Set(codes)];
  // Full replacement in the contract, but write only the diff: the UI sends the whole list on every toggle, and
  // DELETE-all + re-INSERT cost ~400 D1 rows written per click at ~100 hidden items (2026-10-26: 90k/day of the 100k free tier).
  const { results: curRows } = await DB.prepare(`SELECT item_code FROM hidden_items WHERE pcu = ?`).bind(pcu.code).all();
  const cur = new Set(curRows.map((r) => r.item_code));
  const want = new Set(uniq);
  const removed = [...cur].filter((c) => !want.has(c));
  const added = uniq.filter((c) => !cur.has(c));
  const stmts = removed.map((c) => DB.prepare(`DELETE FROM hidden_items WHERE pcu = ? AND item_code = ?`).bind(pcu.code, c));
  const ts = nowIso();
  stmts.push(...insertStatements(DB, "hidden_items", ["pcu", "item_code", "hidden_at", "by"], added.map((c) => [pcu.code, c, ts, pcu.code]),
    { prefix: "INSERT OR IGNORE INTO" }));
  stmts.push(auditStmt(DB, pcu.code, "pcu", "setHidden", pcu.code, "", `count=${uniq.length}`));
  await batchChunked(DB, stmts);
  return { hidden: uniq };
}

// ---- acknowledge issue notice -------------------------------------------------------------------------------------------------------
export async function pcuAck(ctx, p) {
  const { DB, pcu } = ctx;
  if (!isMonth(p.month)) throw err("BAD_REQUEST", "เดือนไม่ถูกต้อง");
  const ts = nowIso();
  const res = await DB.batch([
    DB.prepare(`UPDATE requests SET issued_seen_at = ? WHERE pcu = ? AND month = ?`).bind(ts, pcu.code, p.month),
    auditStmt(DB, pcu.code, "pcu", "pcuAck", pcu.code, p.month, ""),
  ]);
  if (!res[0].meta.changes) throw err("NOT_FOUND", "ไม่พบใบเบิกเดือนนี้");
  return { issued_seen_at: ts };
}

export { budgetConfig };
