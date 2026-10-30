// views.js — shared read-side builders: RequestObj, RoundInfo, per-month PCU view, issue summaries, limit checks.
import { formForFy, loadForm, priceMap } from "./db.js";
import { computeDeadline, fyMonths, monthFy, prevMonth } from "./time.js";
import { UNITS } from "./auth.js";
import { baselineFor } from "./stock.js";

export const REQ_COLS =
  "id,pcu,month,status,form_version_id,submitter_name,last_step,created_at,updated_at,first_submitted_at,submitted_at,submit_count,admin_note,admin_note_at,issued_seen_at,entry_by,requester_name";
export const LINE_COLS =
  "item_code,stock,op,pp,price_snapshot,updated_at,issued_total,issued_op,issued_pp,issue_reason,issue_note,issued_at,issued_by,used,adj,adj_reason,calc_from,price_print";

export const requestId = (pcu, month) => `${pcu}_${month}`;

// 2ad: the requested quantity (op/pp) of a line is frozen once a dispenser/admin recorded its issue (issued_total set) — stock / used / adj
// stay editable until the round closes. The one place for this rule (saveLines + the PCU view's `qty_locked`); 2af adds "PCU reported received".
export function lineQtyLocked(l) {
  return !!l && l.issued_total !== null && l.issued_total !== undefined;
}

export function requestObj(row, lines, admin = false) {
  if (!row) return null;
  const out = {
    id: row.id, pcu: row.pcu, month: row.month, status: row.status,
    form_version_id: row.form_version_id ?? null,
    submitter_name: row.submitter_name || "", last_step: row.last_step || "",
    created_at: row.created_at, updated_at: row.updated_at,
    first_submitted_at: row.first_submitted_at || null, submitted_at: row.submitted_at || null,
    submit_count: Number(row.submit_count) || 0,
    admin_note: row.admin_note || null, admin_note_at: row.admin_note_at || null, issued_seen_at: row.issued_seen_at || null,
    edited_after_submit: !!(row.submitted_at && row.updated_at && row.updated_at > row.submitted_at),
    entry_by: row.entry_by || null, // 2w: 'admin' = an admin keyed/edited this request (sticky) · null = the pcu
    requester_name: row.requester_name ?? null, // 2x: name frozen at send (null = not sent yet, or sent before 2x — see requesterFor)
  };
  if (lines) {
    const m = {};
    for (const l of lines) {
      const sc = { // 2o: stock-mode fields (both views)
        used: l.used ?? null, adj: l.adj ?? null, adj_reason: l.adj_reason ?? null, calc_from: l.calc_from ?? null,
      };
      m[l.item_code] = admin
        ? {
            stock: l.stock, op: l.op, pp: l.pp, ...sc, updated_at: l.updated_at, price_snapshot: l.price_snapshot ?? null,
            price_print: l.price_print ?? null, // 2p/2z: the price printed on the sheet (= price_snapshot since 2z: a price change rewrites both)
            issued_total: l.issued_total ?? null, issued_op: l.issued_op ?? null, issued_pp: l.issued_pp ?? null,
            issue_reason: l.issue_reason ?? null, issue_note: l.issue_note ?? null, issued_at: l.issued_at ?? null, issued_by: l.issued_by ?? null,
          }
        : { stock: l.stock, op: l.op, pp: l.pp, ...sc, updated_at: l.updated_at, ...(lineQtyLocked(l) ? { qty_locked: true } : {}) };
    }
    out.lines = m;
  }
  return out;
}

// ---- 2x requester name --------------------------------------------------------------------------------------------------
// The pcu's first logged requester name (requests sent before 2x print with it), or null.
export async function firstRequester(DB, pcu) {
  const r = await DB.prepare(`SELECT name FROM requester_log WHERE pcu = ? ORDER BY set_at ASC LIMIT 1`).bind(pcu).first();
  return (r && r.name) || null;
}
// The name printed on a request: sent → requests.requester_name (frozen at send) ?? first logged name ?? the pcu's current name ·
// not sent → the pcu's current name. null = none set (the sheet prints dots / a blank).
export async function requesterFor(DB, pcuRow, reqRow) {
  const cur = (pcuRow && pcuRow.requester_name) || null;
  if (!reqRow || !(reqRow.status === "submitted" || reqRow.status === "issued")) return cur;
  if (reqRow.requester_name) return reqRow.requester_name;
  return (await firstRequester(DB, pcuRow.code)) || cur;
}

// SQL for `UPDATE requests SET requester_name = <this>` inside a send (bind: pcu, pcu, pcu). Frozen at the FIRST send — a re-send keeps it
// (Q1/Q2: a sent sheet keeps the name it was sent with; R7 adminSetRequestRequester overrides). A request sent before 2x (first_submitted_at set,
// requester_name NULL) gets what requesterFor already printed for it: the first logged name, else the current name.
export const REQUESTER_ON_SEND_SQL =
  `COALESCE(requester_name, CASE WHEN first_submitted_at IS NULL THEN (SELECT requester_name FROM pcus WHERE code = ?)
     ELSE COALESCE((SELECT name FROM requester_log WHERE pcu = ? ORDER BY set_at ASC LIMIT 1), (SELECT requester_name FROM pcus WHERE code = ?)) END)`;

export async function getRequestRow(DB, pcu, month) {
  return DB.prepare(`SELECT ${REQ_COLS} FROM requests WHERE pcu = ? AND month = ?`).bind(pcu, month).first();
}
export async function getLines(DB, reqId) {
  const { results } = await DB.prepare(`SELECT ${LINE_COLS} FROM request_lines WHERE request_id = ?`).bind(reqId).all();
  return results;
}

// ---- rounds ----------------------------------------------------------------------------------------------------------
// RoundInfo of a round month. `trialMonth` = config.trial_month (2j) → `trial: month === trialMonth`.
export function roundInfo(month, row, deadlineDay, trialMonth) {
  const d = computeDeadline(month, row, deadlineDay);
  return {
    month, fy: monthFy(month), deadline_date: d.deadline_date, deadline_source: d.deadline_source,
    trial: !!trialMonth && month === trialMonth,
    locked: !!(row && row.locked), locked_at: (row && row.locked_at) || null, locked_by: (row && row.locked_by) || null,
    note: (row && row.note) || null,
  };
}
export async function getRoundRows(DB, months) {
  const map = new Map();
  if (!months.length) return map;
  const { results } = await DB.prepare(`SELECT * FROM rounds WHERE month IN (${months.map(() => "?").join(",")})`).bind(...months).all();
  for (const r of results) map.set(r.month, r);
  return map;
}
export async function getRound(DB, month, deadlineDay, trialMonth) {
  const row = await DB.prepare(`SELECT * FROM rounds WHERE month = ?`).bind(month).first();
  return roundInfo(month, row, deadlineDay, trialMonth);
}

// ---- PCU month view -------------------------------------------------------------------------------------------------
// Σ(op+pp) of this PCU's submitted/issued requests in the same fiscal year as `month`, excluding `month` itself.
// FY = round FY (2w): fyMonths(monthFy(month)) = Oct … Sep round months.
export async function usedFyFor(DB, pcu, month) {
  const ms = fyMonths(monthFy(month));
  const { results } = await DB.prepare(
    `SELECT l.item_code AS code, SUM(COALESCE(l.op,0)+COALESCE(l.pp,0)) AS q
       FROM requests r JOIN request_lines l ON l.request_id = r.id
      WHERE r.pcu = ? AND r.month >= ? AND r.month <= ? AND r.month != ? AND r.status IN ('submitted','issued')
      GROUP BY l.item_code HAVING q > 0`
  ).bind(pcu, ms[0], ms[11], month).all();
  const out = {};
  for (const r of results) out[r.code] = r.q;
  return out;
}

// 2o: { code: {op, pp, stock, received, received_src} } of the previous round (stock.js baselineFor) — rows with op+pp > 0 or stock set.
export const prevLinesFor = (DB, pcu, month) => baselineFor(DB, pcu, month);

// ---- issue (2c) -------------------------------------------------------------------------------------------------------
// The form a request resolves its codes against: the bound version, else formForFy (latest of the round's fy → fy_current → newest).
export async function formOfRequest(DB, reqRow, fallbackFy) {
  return reqRow.form_version_id ? loadForm(DB, reqRow.form_version_id) : formForFy(DB, fallbackFy ?? monthFy(reqRow.month));
}
export const unitOfCode = (form, code) => (form && form.index.get(code) ? form.index.get(code).step.dispense_unit : null);
export const requestedQty = (l) => (l.op || 0) + (l.pp || 0);

// Dispense units that have at least one requested line (op+pp > 0) → Set.
export function neededUnits(form, lines) {
  const needed = new Set();
  for (const l of lines) {
    if (requestedQty(l) <= 0) continue;
    const u = unitOfCode(form, l.item_code);
    if (u) needed.add(u);
  }
  return needed;
}

// IssueInfo (API.md §4.1) from already-loaded data. `doneRows` = issue_status rows [{dispense_unit, done_at?, done_by?}] (or plain unit names).
// pcuView: the PCU only sees what belongs to units already marked done (Q78) → counts are restricted to done units, done_by is hidden,
// and the result is null until at least one unit is done. Staff view: null only when the request has no requested line.
export function issueInfoFrom(form, issuedSeenAt, lines, doneRows, opts = {}) {
  const pcuView = !!opts.pcuView;
  const rows = doneRows.map((r) => (typeof r === "string" ? { dispense_unit: r } : r));
  if (pcuView && !rows.length) return null;
  const doneBy = new Map(rows.map((r) => [r.dispense_unit, r]));
  const units = {};
  const unit = (u) => (units[u] ||= {
    needed: false, done: doneBy.has(u),
    done_at: (doneBy.get(u) && doneBy.get(u).done_at) || null,
    done_by: pcuView ? null : (doneBy.get(u) && doneBy.get(u).done_by) || null,
    lines: 0, issued_lines: 0,
  });
  for (const u of UNITS) unit(u);
  let complete = 0, incomplete = 0, any = false;
  for (const l of lines) {
    const req = requestedQty(l);
    if (req <= 0) continue;
    const u = unitOfCode(form, l.item_code);
    if (!u) continue;
    any = true;
    const e = unit(u);
    e.needed = true; e.lines++;
    if (l.issued_total === null || l.issued_total === undefined) continue;
    if (pcuView && !e.done) continue;
    e.issued_lines++;
    if (l.issued_total >= req) complete++; else incomplete++;
  }
  if (!any) return null;
  const needed = Object.keys(units).filter((u) => units[u].needed);
  const done = needed.filter((u) => units[u].done).length;
  return {
    units_total: needed.length, units_done: done, done: needed.length > 0 && done === needed.length,
    complete, incomplete, issued_seen_at: issuedSeenAt || null, units,
  };
}

// PCU-facing summary of one request (null until a unit is done). Kept for callers that only hold the lines + unit names.
export async function issueSummary(DB, reqRow, lines, issuedUnits, fallbackFy) {
  if (!issuedUnits.length) return null;
  const form = await formOfRequest(DB, reqRow, fallbackFy);
  return issueInfoFrom(form, reqRow.issued_seen_at, lines, issuedUnits, { pcuView: true });
}

// request.issued for the PCU view: { code: {total, op, pp, reason, note} } for lines of DONE units only (Q78: `lines` stay unchanged).
export function pcuIssuedMap(form, lines, doneRows) {
  const done = new Set(doneRows.map((r) => (typeof r === "string" ? r : r.dispense_unit)));
  const out = {};
  for (const l of lines) {
    if (requestedQty(l) <= 0 || l.issued_total === null || l.issued_total === undefined) continue;
    if (!done.has(unitOfCode(form, l.item_code))) continue;
    out[l.item_code] = { total: l.issued_total, op: l.issued_op ?? 0, pp: l.issued_pp ?? 0, reason: l.issue_reason ?? null, note: l.issue_note ?? null };
  }
  return out;
}

// The PCU-facing view of one month (shared by pcuBootstrap.byMonth and pcuGetMonth).
export async function pcuMonthView(DB, pcu, month, fallbackFy) {
  const [reqRow, usedFy, prevLines, unlocksRes] = await Promise.all([
    getRequestRow(DB, pcu, month),
    usedFyFor(DB, pcu, month),
    prevLinesFor(DB, pcu, month),
    DB.prepare(`SELECT item_code, reason FROM limit_unlocks WHERE pcu = ? AND month = ?`).bind(pcu, month).all(),
  ]);
  let request = null, issue = null;
  if (reqRow) {
    const [lines, units] = await Promise.all([
      getLines(DB, reqRow.id),
      DB.prepare(`SELECT dispense_unit, done_at, done_by FROM issue_status WHERE request_id = ?`).bind(reqRow.id).all(),
    ]);
    request = requestObj(reqRow, lines, false);
    if (units.results.length) { // 2c: something has been issued → expose the done units' figures
      const form = await formOfRequest(DB, reqRow, fallbackFy);
      issue = issueInfoFrom(form, reqRow.issued_seen_at, lines, units.results, { pcuView: true });
      request.issued = pcuIssuedMap(form, lines, units.results);
    }
  }
  const unlocks = {};
  for (const u of unlocksRes.results) unlocks[u.item_code] = u.reason || "";
  return { view: { request, used_fy: usedFy, prev_lines: prevLines, issue }, unlocks };
}

// ---- limit check (send:true, warn) --------------------------------------------------------------------------------------------
// Returns [{code,total,limit_year,used_fy}] for lines over their YEARLY limit — information only, never blocks (2z Q10).
// limit_month is not checked nor returned (2z R10/R11: hidden from every UI; the column stays in the DB). limit_unlocks are ignored (2z).
export async function overLimitItems(DB, pcu, month, lines) {
  const fy = monthFy(month);
  const codes = lines.filter((l) => (l.op || 0) + (l.pp || 0) > 0).map((l) => l.item_code);
  if (!codes.length) return [];
  const [limRes, used] = await Promise.all([
    DB.prepare(`SELECT item_code, limit_year FROM limits WHERE fy = ? AND pcu = ?`).bind(fy, pcu).all(),
    usedFyFor(DB, pcu, month),
  ]);
  const lim = new Map(limRes.results.map((r) => [r.item_code, r]));
  const over = [];
  for (const l of lines) {
    const total = (l.op || 0) + (l.pp || 0);
    if (total <= 0) continue;
    const r = lim.get(l.item_code);
    const ly = r ? r.limit_year ?? null : null;
    const u = used[l.item_code] || 0;
    if (ly !== null && u + total > ly) over.push({ code: l.item_code, total, limit_year: ly, used_fy: u });
  }
  return over;
}

export { priceMap };
