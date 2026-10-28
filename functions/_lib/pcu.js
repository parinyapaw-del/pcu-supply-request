// pcu.js — PCU-facing actions (functions/API.md §4). Every action except pcuList/pcuLogin runs with ctx.pcu taken from the token.
import { err, assertQty, isStr } from "./http.js";
import {
  auditStmt, batchChunked, budgetConfig, formForFy, formPublic, getConfigAll, insertStatements, latestForm, linkMap, linkedCode, loadForm, publicConfig,
} from "./db.js";
import {
  PIN_LENGTH, PIN_LOCK_MIN, PIN_MAX_FAIL, constantTimeEq, hashSecret, makePcuToken, newSalt, pcuPublic,
} from "./auth.js";
import { currentMonth, currentRound, fyMonths, isMonth, monthFy, nextMonth, nowIso, prevMonth } from "./time.js";
import {
  getLines, getRequestRow, getRoundRows, issueSummary, overLimitItems, pcuMonthView, requestObj, requestId, roundInfo, REQ_COLS,
} from "./views.js";
import { ADJ_REASONS, CALC_FROM, baselineFor, computeLine, recalcStockChain } from "./stock.js";
import { loadPriceHistory, priceFor, priceHistories, roundPriceOverrides } from "./price.js";

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
    `SELECT code, name, print_name, "group" AS grp, pin_hash, pin_salt, pin_version, pin_fail, pin_locked_until, pin_custom, stock_mode FROM pcus WHERE code = ?`
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

  const [form, hiddenRes, limRes, planRes, roundRows, [histReqRes, histRoundRes], actualRes, pricesRes, curView, prevView, noticeRes] = await Promise.all([
    latestForm(DB, fy),
    DB.prepare(`SELECT item_code FROM hidden_items WHERE pcu = ?`).bind(code).all(),
    DB.prepare(`SELECT item_code, limit_month, limit_year FROM limits WHERE fy = ? AND pcu = ?`).bind(fy, code).all(),
    DB.prepare(`SELECT item_code, plan_op, plan_pp FROM plans WHERE fy = ? AND pcu = ?`).bind(fy, code).all(),
    getRoundRows(DB, [nxt, cur, prev]),
    Promise.all([
      DB.prepare(`SELECT month, status, submitted_at FROM requests WHERE pcu = ? AND month >= ? AND month < ?`).bind(code, histFrom, prev).all(),
      DB.prepare(`SELECT month, locked FROM rounds WHERE month >= ? AND month < ?`).bind(histFrom, prev).all(),
    ]),
    DB.prepare(`SELECT DISTINCT item_code FROM actual_prev WHERE fy = ? AND pcu = ? AND (COALESCE(op,0) > 0 OR COALESCE(pp,0) > 0)`).bind(fy - 1, code).all(),
    DB.prepare(`SELECT item_code FROM prices_prev WHERE fy = ?`).bind(fy - 1).all(),
    pcuMonthView(DB, code, cur, fy),
    pcuMonthView(DB, code, prev, fy),
    DB.prepare(`SELECT ${REQ_COLS} FROM requests WHERE pcu = ? AND status = 'issued' AND issued_seen_at IS NULL`).bind(code).all(),
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
      status: r ? r.status : "not_started", submitted_at: (r && r.submitted_at) || null,
    });
  }

  const limits = {}, plans = {};
  for (const r of limRes.results) limits[r.item_code] = [r.limit_month ?? null, r.limit_year ?? null];
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
    pcu: { ...pcuPublic(pcuRow), pin_custom: !!pcuRow.pin_custom, stock_mode: pcuRow.stock_mode === "B" ? "B" : "A" }, // 2o
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
  const [existingRows, iuRes] = reqRow && parsed.length
    ? await Promise.all([getLines(DB, id), DB.prepare(`SELECT dispense_unit FROM issue_status WHERE request_id = ?`).bind(id).all()])
    : [[], { results: [] }];
  const existing = new Map(existingRows.map((l) => [l.item_code, l]));
  const keep = (l, e, k) => (l[k] !== undefined ? l[k] : e ? e[k] ?? null : null);
  for (const l of parsed) {
    const e = existing.get(l.code);
    l.used = keep(l, e, "used"); l.adj = keep(l, e, "adj"); l.adj_reason = keep(l, e, "adj_reason"); l.calc_from = keep(l, e, "calc_from");
    l.sent = { stock: l.stock, used: l.used };
  }
  const base = parsed.some((l) => l.calc_from) ? await baselineFor(DB, pcu.code, month) : {};
  for (const l of parsed) Object.assign(l, computeLine(base[l.code], l));

  // 2c hook: a step whose dispense unit is already issued cannot change (2o: incl. used / adj / adj_reason / calc_from)
  if (iuRes.results.length) {
    const locked = new Set(iuRes.results.map((r) => r.dispense_unit));
    const form = bound || latest;
    for (const l of parsed) {
      const ent = form.index.get(l.code);
      if (!ent || !locked.has(ent.step.dispense_unit)) continue;
      const e = existing.get(l.code);
      if (!sameLine(e, l)) throw err("CONFLICT", `หน้า "${ent.step.dispense_unit}" ถูกจ่ายแล้ว แก้ไขรายการไม่ได้`);
    }
  }

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
    if (cfg.limit_mode !== "off") {
      overLimit = await overLimitItems(DB, pcu.code, month, lines);
      if (cfg.limit_mode === "enforce" && overLimit.length) throw err("OVER_LIMIT", "มีรายการเกินเพดานเบิก", { items: overLimit });
    }
    // 2p: the price of THIS round (price_history of the round's fy, fallback the form price) — both the calculation price (price_snapshot,
    // later moved by a back-date) and the printed price (price_print, frozen until the next send)
    const hist = await loadPriceHistory(DB, fy);
    const fin = [];
    for (const l of lines) {
      const c = l.item_code;
      const price = priceFor(hist, latest.index.has(c) ? latest : bound, c, month);
      fin.push(DB.prepare(`UPDATE request_lines SET price_snapshot = ?, price_print = ? WHERE request_id = ? AND item_code = ?`).bind(price, price, id, c));
    }
    fin.push(DB.prepare(
      `UPDATE requests SET status = CASE WHEN status = 'issued' THEN 'issued' ELSE 'submitted' END, form_version_id = ?, submitted_at = ?, updated_at = ?,
              first_submitted_at = COALESCE(first_submitted_at, ?), submit_count = COALESCE(submit_count,0) + 1 WHERE id = ?`
    ).bind(latest.id, now, now, now, id));
    const n = lines.filter((l) => (l.op || 0) + (l.pp || 0) > 0).length;
    fin.push(auditStmt(DB, pcu.code, "pcu", "submit", pcu.code, month, `items=${n} form_version=${latest.id}`));
    await batchChunked(DB, fin);
    submitted = true;
    if (!wasSent) await recalcStockChain(DB, pcu.code, month); // first send: this round just became a baseline
  }

  const [row2, lines2] = await Promise.all([getRequestRow(DB, pcu.code, month), getLines(DB, id)]);
  return { saved_at: now, status: row2.status, submitted, over_limit: overLimit, request: requestObj(row2, lines2, false), recalc };
}

// ---- 2o: stock mode + saveLines field rules ------------------------------------------------------------------------------------
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const LINE_FIELDS = ["stock", "op", "pp", "used", "adj", "adj_reason", "calc_from"];
const sameLine = (e, l) => (e ? LINE_FIELDS.every((k) => (e[k] ?? null) === l[k]) : LINE_FIELDS.every((k) => l[k] === null));

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
