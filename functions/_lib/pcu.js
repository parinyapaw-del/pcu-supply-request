// pcu.js — PCU-facing actions (functions/API.md §4). Every action except pcuList/pcuLogin runs with ctx.pcu taken from the token.
import { err, assertQty, isStr } from "./http.js";
import {
  auditStmt, batchChunked, budgetConfig, formPublic, getConfigAll, insertStatements, latestForm, loadForm, publicConfig,
} from "./db.js";
import {
  PIN_LENGTH, PIN_LOCK_MIN, PIN_MAX_FAIL, constantTimeEq, hashSecret, makePcuToken, pcuPublic,
} from "./auth.js";
import { currentMonth, isMonth, monthFy, nowIso, prevMonth } from "./time.js";
import {
  getLines, getRequestRow, getRoundRows, issueSummary, overLimitItems, pcuMonthView, requestObj, requestId, roundInfo, REQ_COLS,
} from "./views.js";

// ---- public ------------------------------------------------------------------------------------------------------
export async function pcuList(ctx) {
  const { results } = await ctx.DB.prepare(`SELECT code, name, print_name, "group" AS grp FROM pcus ORDER BY code`).all();
  return { pcus: results.map((r) => ({ code: r.code, name: r.name, print_name: r.print_name || r.name, group: r.grp })) };
}

export async function pcuLogin(ctx, p) {
  const { DB, env } = ctx;
  const code = String(p.pcu || "");
  const pin = String(p.pin || "");
  if (!code || !new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin)) throw err("BAD_REQUEST", "กรอก รพ.สต. และ PIN 5 หลัก");
  const row = await DB.prepare(
    `SELECT code, name, print_name, "group" AS grp, pin_hash, pin_salt, pin_version, pin_fail, pin_locked_until FROM pcus WHERE code = ?`
  ).bind(code).first();
  if (!row) throw err("NOT_FOUND", "ไม่พบ รพ.สต. นี้");

  const now = Date.now();
  let fail = Number(row.pin_fail) || 0;
  if (row.pin_locked_until) {
    const until = Date.parse(row.pin_locked_until);
    if (!Number.isNaN(until) && until > now) throw err("PIN_LOCKED", "รพ.สต. นี้ถูกล็อกชั่วคราว", { until: row.pin_locked_until });
    fail = 0; // lock expired → fresh attempt window
    await DB.prepare(`UPDATE pcus SET pin_fail = 0, pin_locked_until = NULL WHERE code = ?`).bind(code).run();
  }

  const hash = await hashSecret(pin, row.pin_salt || "");
  if (constantTimeEq(hash, row.pin_hash || "")) {
    if (fail) await DB.prepare(`UPDATE pcus SET pin_fail = 0, pin_locked_until = NULL WHERE code = ?`).bind(code).run();
    const tok = await makePcuToken(env, row.code, Number(row.pin_version) || 1);
    await DB.batch([auditStmt(DB, row.code, "pcu", "pcuLogin", row.code, "", "ok")]);
    const bootstrap = await buildPcuBootstrap(ctx, row);
    return { token: tok.token, exp: tok.exp, pcu: pcuPublic(row), bootstrap };
  }

  // atomic increment so concurrent wrong attempts cannot dodge the lock
  const upd = await DB.prepare(`UPDATE pcus SET pin_fail = COALESCE(pin_fail,0) + 1 WHERE code = ? RETURNING pin_fail`).bind(code).first();
  const nf = Number(upd && upd.pin_fail) || fail + 1;
  if (nf >= PIN_MAX_FAIL) {
    const until = new Date(now + PIN_LOCK_MIN * 60000).toISOString();
    await DB.batch([
      DB.prepare(`UPDATE pcus SET pin_locked_until = ? WHERE code = ?`).bind(until, code),
      auditStmt(DB, code, "pcu", "pcuLogin", code, "", "locked"),
    ]);
    throw err("PIN_LOCKED", "ใส่ PIN ผิดครบ 5 ครั้ง ถูกล็อกชั่วคราว 5 นาที", { until });
  }
  await DB.batch([auditStmt(DB, code, "pcu", "pcuLogin", code, "", `bad_pin fail=${nf}`)]);
  throw err("BAD_PIN", "PIN ไม่ถูกต้อง", { remaining: PIN_MAX_FAIL - nf });
}

// ---- bootstrap -----------------------------------------------------------------------------------------------------
export async function buildPcuBootstrap(ctx, pcuRow) {
  const { DB } = ctx;
  const cur = currentMonth(), prev = prevMonth(cur);
  const cfgAll = await getConfigAll(DB);
  const cfg = publicConfig(cfgAll, monthFy(cur));
  const fy = cfg.fy_current;
  const code = pcuRow.code;

  const [form, hiddenRes, limRes, planRes, roundRows, olderRes, actualRes, pricesRes, curView, prevView, noticeRes] = await Promise.all([
    latestForm(DB, fy),
    DB.prepare(`SELECT item_code FROM hidden_items WHERE pcu = ?`).bind(code).all(),
    DB.prepare(`SELECT item_code, limit_month, limit_year FROM limits WHERE fy = ? AND pcu = ?`).bind(fy, code).all(),
    DB.prepare(`SELECT item_code, plan_op, plan_pp FROM plans WHERE fy = ? AND pcu = ?`).bind(fy, code).all(),
    getRoundRows(DB, [cur, prev]),
    DB.prepare(`SELECT month FROM requests WHERE pcu = ? AND month < ? ORDER BY month DESC`).bind(code, prev).all(),
    DB.prepare(`SELECT DISTINCT item_code FROM actual_prev WHERE fy = ? AND pcu = ? AND (COALESCE(op,0) > 0 OR COALESCE(pp,0) > 0)`).bind(fy - 1, code).all(),
    DB.prepare(`SELECT item_code FROM prices_prev WHERE fy = ?`).bind(fy - 1).all(),
    pcuMonthView(DB, code, cur, fy),
    pcuMonthView(DB, code, prev, fy),
    DB.prepare(`SELECT ${REQ_COLS} FROM requests WHERE pcu = ? AND status = 'issued' AND issued_seen_at IS NULL`).bind(code).all(),
  ]);

  // never_prev: active items this PCU never withdrew last fy (only meaningful when we have history for the PCU)
  let neverPrev = [];
  if (form && actualRes.results.length) {
    const had = new Set(actualRes.results.map((r) => r.item_code));
    const known = pricesRes.results.length ? new Set(pricesRes.results.map((r) => r.item_code)) : null;
    for (const [c, { item }] of form.index) {
      if (item.active === false || had.has(c)) continue;
      if (known && !known.has(c)) continue; // brand-new item: no history, not "never withdrawn"
      neverPrev.push(c);
    }
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

  return {
    server_time: nowIso(), current_month: cur,
    pcu: pcuPublic(pcuRow),
    config: cfg,
    form_version_id: form ? form.id : null,
    form: formPublic(form),
    rounds: [cur, prev].map((m) => roundInfo(m, roundRows.get(m), cfg.deadline_day)),
    older_months: olderRes.results.map((r) => r.month),
    hidden: hiddenRes.results.map((r) => r.item_code),
    never_prev: neverPrev,
    limits, plans,
    unlocks: { [cur]: curView.unlocks, [prev]: prevView.unlocks },
    byMonth: { [cur]: curView.view, [prev]: prevView.view },
    issue_notices: notices,
  };
}

export async function pcuBootstrap(ctx) {
  return buildPcuBootstrap(ctx, ctx.pcu);
}

export async function pcuGetMonth(ctx, p) {
  const { DB, pcu } = ctx;
  if (!isMonth(p.month)) throw err("BAD_REQUEST", "เดือนไม่ถูกต้อง");
  if (p.month > currentMonth()) throw err("BAD_REQUEST", "เดือนนี้ยังไม่ถึง");
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentMonth()));
  const { view, unlocks } = await pcuMonthView(DB, pcu.code, p.month, cfg.fy_current);
  const rounds = await getRoundRows(DB, [p.month]);
  return { month: p.month, ...view, unlocks, round: roundInfo(p.month, rounds.get(p.month), cfg.deadline_day) };
}

// ---- saveLines (autosave + submit) ------------------------------------------------------------------------------------------
const MAX_LINES = 400;

export async function saveLines(ctx, p) {
  const { DB, pcu } = ctx;
  const month = p.month;
  if (!isMonth(month)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง");
  const cur = currentMonth();
  if (month > cur) throw err("BAD_REQUEST", "ยังไม่ถึงรอบเดือนนี้");
  const linesIn = p.lines && typeof p.lines === "object" && !Array.isArray(p.lines) ? p.lines : {};
  const codes = Object.keys(linesIn);
  if (codes.length > MAX_LINES) throw err("BAD_REQUEST", "จำนวนบรรทัดมากเกินไป");
  const now = nowIso();

  // pure validation first
  const parsed = codes.map((code) => {
    const l = linesIn[code] && typeof linesIn[code] === "object" ? linesIn[code] : {};
    let ua = l.updated_at;
    if (typeof ua === "number" && Number.isFinite(ua)) ua = new Date(ua).toISOString();
    if (!isStr(ua) || !ua) ua = now;
    return { code, stock: assertQty(l.stock), op: assertQty(l.op), pp: assertQty(l.pp), updated_at: ua };
  });

  const cfgAll = await getConfigAll(DB);
  const cfg = publicConfig(cfgAll, monthFy(cur));
  const fy = monthFy(month);
  const [reqRow, roundRow, latest] = await Promise.all([
    getRequestRow(DB, pcu.code, month),
    DB.prepare(`SELECT locked FROM rounds WHERE month = ?`).bind(month).first(),
    latestForm(DB, fy),
  ]);
  if (!reqRow && month !== cur && month !== prevMonth(cur)) throw err("BAD_REQUEST", "เดือนนี้ไม่เปิดให้กรอก");
  if (roundRow && roundRow.locked) throw err("CONFLICT", "รอบนี้ปิดรับแล้ว แก้ไขไม่ได้");
  if (!latest) throw err("NOT_FOUND", "ยังไม่มีแบบฟอร์มในระบบ");
  const bound = reqRow && reqRow.form_version_id ? await loadForm(DB, reqRow.form_version_id) : null;
  for (const l of parsed) {
    if (!latest.index.has(l.code) && !(bound && bound.index.has(l.code))) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + l.code);
  }

  const id = requestId(pcu.code, month);

  // 2c hook: a step whose dispense unit is already issued cannot change
  if (reqRow && parsed.length) {
    const { results: iu } = await DB.prepare(`SELECT dispense_unit FROM issue_status WHERE request_id = ?`).bind(id).all();
    if (iu.length) {
      const locked = new Set(iu.map((r) => r.dispense_unit));
      const form = bound || latest;
      const existing = new Map((await getLines(DB, id)).map((l) => [l.item_code, l]));
      for (const l of parsed) {
        const ent = form.index.get(l.code);
        if (!ent || !locked.has(ent.step.dispense_unit)) continue;
        const e = existing.get(l.code);
        const same = e ? (e.stock ?? null) === l.stock && (e.op ?? null) === l.op && (e.pp ?? null) === l.pp : l.stock === null && l.op === null && l.pp === null;
        if (!same) throw err("CONFLICT", `หน้า "${ent.step.dispense_unit}" ถูกจ่ายแล้ว แก้ไขรายการไม่ได้`);
      }
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
      `INSERT INTO request_lines (request_id,item_code,stock,op,pp,updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(request_id,item_code) DO UPDATE SET stock=excluded.stock, op=excluded.op, pp=excluded.pp, updated_at=excluded.updated_at
       WHERE request_lines.updated_at IS NULL OR excluded.updated_at > request_lines.updated_at`
    ).bind(id, l.code, l.stock, l.op, l.pp, l.updated_at));
  }
  const metaSets = [], metaVals = [];
  if (p.last_step !== undefined && p.last_step !== null && String(p.last_step)) { metaSets.push("last_step = ?"); metaVals.push(String(p.last_step).slice(0, 64)); }
  if (p.submitter_name !== undefined && p.submitter_name !== null) { metaSets.push("submitter_name = ?"); metaVals.push(String(p.submitter_name).slice(0, 120)); }
  if (metaSets.length) stmts.push(DB.prepare(`UPDATE requests SET ${metaSets.join(", ")} WHERE id = ?`).bind(...metaVals, id));

  let changed = 0;
  if (stmts.length) {
    const res = await batchChunked(DB, stmts);
    for (let i = nLineStart; i < nLineStart + parsed.length; i++) changed += (res[i] && res[i].meta && res[i].meta.changes) || 0;
  }
  if (changed > 0) {
    await DB.prepare(`UPDATE requests SET updated_at = ? WHERE id = ?`).bind(now, id).run();
  }

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
    const prices = {};
    if (bound) for (const [c, { item }] of bound.index) prices[c] = Number(item.price) || 0;
    for (const [c, { item }] of latest.index) prices[c] = Number(item.price) || 0;
    const fin = [];
    for (const l of lines) {
      fin.push(DB.prepare(`UPDATE request_lines SET price_snapshot = ? WHERE request_id = ? AND item_code = ?`).bind(prices[l.item_code] ?? null, id, l.item_code));
    }
    fin.push(DB.prepare(
      `UPDATE requests SET status = CASE WHEN status = 'issued' THEN 'issued' ELSE 'submitted' END, form_version_id = ?, submitted_at = ?, updated_at = ?,
              first_submitted_at = COALESCE(first_submitted_at, ?), submit_count = COALESCE(submit_count,0) + 1 WHERE id = ?`
    ).bind(latest.id, now, now, now, id));
    const n = lines.filter((l) => (l.op || 0) + (l.pp || 0) > 0).length;
    fin.push(auditStmt(DB, pcu.code, "pcu", "submit", pcu.code, month, `items=${n} form_version=${latest.id}`));
    await batchChunked(DB, fin);
    submitted = true;
  }

  const [row2, lines2] = await Promise.all([getRequestRow(DB, pcu.code, month), getLines(DB, id)]);
  return { saved_at: now, status: row2.status, submitted, over_limit: overLimit, request: requestObj(row2, lines2, false) };
}

// ---- hidden ---------------------------------------------------------------------------------------------------------------------
export async function setHidden(ctx, p) {
  const { DB, pcu } = ctx;
  const codes = Array.isArray(p.codes) ? p.codes : [];
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentMonth()));
  const form = await latestForm(DB, cfg.fy_current);
  for (const c of codes) if (!isStr(c) || !form || !form.index.has(c)) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + c);
  const uniq = [...new Set(codes)];
  const stmts = [DB.prepare(`DELETE FROM hidden_items WHERE pcu = ?`).bind(pcu.code)];
  const ts = nowIso();
  stmts.push(...insertStatements(DB, "hidden_items", ["pcu", "item_code", "hidden_at", "by"], uniq.map((c) => [pcu.code, c, ts, pcu.code])));
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
