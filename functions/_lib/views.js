// views.js — shared read-side builders: RequestObj, RoundInfo, per-month PCU view, issue summaries, limit checks.
import { loadForm, latestForm, priceMap } from "./db.js";
import { computeDeadline, fyMonths, monthFy, prevMonth } from "./time.js";

export const REQ_COLS =
  "id,pcu,month,status,form_version_id,submitter_name,last_step,created_at,updated_at,first_submitted_at,submitted_at,submit_count,admin_note,admin_note_at,issued_seen_at";
export const LINE_COLS =
  "item_code,stock,op,pp,price_snapshot,updated_at,issued_total,issued_op,issued_pp,issue_reason,issue_note,issued_at,issued_by";

export const requestId = (pcu, month) => `${pcu}_${month}`;

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
  };
  if (lines) {
    const m = {};
    for (const l of lines) {
      m[l.item_code] = admin
        ? {
            stock: l.stock, op: l.op, pp: l.pp, updated_at: l.updated_at, price_snapshot: l.price_snapshot ?? null,
            issued_total: l.issued_total ?? null, issued_op: l.issued_op ?? null, issued_pp: l.issued_pp ?? null,
            issue_reason: l.issue_reason ?? null, issue_note: l.issue_note ?? null, issued_at: l.issued_at ?? null, issued_by: l.issued_by ?? null,
          }
        : { stock: l.stock, op: l.op, pp: l.pp, updated_at: l.updated_at };
    }
    out.lines = m;
  }
  return out;
}

export async function getRequestRow(DB, pcu, month) {
  return DB.prepare(`SELECT ${REQ_COLS} FROM requests WHERE pcu = ? AND month = ?`).bind(pcu, month).first();
}
export async function getLines(DB, reqId) {
  const { results } = await DB.prepare(`SELECT ${LINE_COLS} FROM request_lines WHERE request_id = ?`).bind(reqId).all();
  return results;
}

// ---- rounds ----------------------------------------------------------------------------------------------------------
export function roundInfo(month, row, deadlineDay) {
  const d = computeDeadline(month, row, deadlineDay);
  return {
    month, fy: monthFy(month), deadline_date: d.deadline_date, deadline_source: d.deadline_source,
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
export async function getRound(DB, month, deadlineDay) {
  const row = await DB.prepare(`SELECT * FROM rounds WHERE month = ?`).bind(month).first();
  return roundInfo(month, row, deadlineDay);
}

// ---- PCU month view -------------------------------------------------------------------------------------------------
// Σ(op+pp) of this PCU's submitted/issued requests in the same fiscal year as `month`, excluding `month` itself.
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

export async function prevLinesFor(DB, pcu, month) {
  const { results } = await DB.prepare(
    `SELECT l.item_code AS code, COALESCE(l.op,0) AS op, COALESCE(l.pp,0) AS pp
       FROM requests r JOIN request_lines l ON l.request_id = r.id
      WHERE r.pcu = ? AND r.month = ? AND r.status IN ('submitted','issued') AND (COALESCE(l.op,0) + COALESCE(l.pp,0)) > 0`
  ).bind(pcu, prevMonth(month)).all();
  const out = {};
  for (const r of results) out[r.code] = { op: r.op, pp: r.pp };
  return out;
}

// Issue summary of one request from its (admin-shaped) lines + issue_status units + form. null when nothing has been issued.
export async function issueSummary(DB, reqRow, lines, issuedUnits, fallbackFy) {
  if (!issuedUnits.length) return null;
  const form = reqRow.form_version_id ? await loadForm(DB, reqRow.form_version_id) : await latestForm(DB, fallbackFy);
  const unitOf = (code) => (form && form.index.get(code) ? form.index.get(code).step.dispense_unit : null);
  const needed = new Set();
  let complete = 0, incomplete = 0;
  for (const l of lines) {
    const req = (l.op || 0) + (l.pp || 0);
    if (req <= 0) continue;
    const u = unitOf(l.item_code);
    if (u) needed.add(u);
    if (l.issued_total === null || l.issued_total === undefined) continue;
    if (l.issued_total >= req) complete++; else incomplete++;
  }
  const done = [...needed].filter((u) => issuedUnits.includes(u)).length;
  return {
    units_total: needed.size, units_done: done, done: needed.size > 0 && done === needed.size,
    complete, incomplete, issued_seen_at: reqRow.issued_seen_at || null,
  };
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
      DB.prepare(`SELECT dispense_unit FROM issue_status WHERE request_id = ?`).bind(reqRow.id).all(),
    ]);
    request = requestObj(reqRow, lines, false);
    issue = await issueSummary(DB, reqRow, lines, units.results.map((u) => u.dispense_unit), fallbackFy);
  }
  const unlocks = {};
  for (const u of unlocksRes.results) unlocks[u.item_code] = u.reason || "";
  return { view: { request, used_fy: usedFy, prev_lines: prevLines, issue }, unlocks };
}

// ---- limit check (send:true, enforce / warn) -------------------------------------------------------------------------------
// Returns [{code,total,limit_month,limit_year,used_fy}] for lines over their limits, skipping unlocked items.
export async function overLimitItems(DB, pcu, month, lines) {
  const fy = monthFy(month);
  const codes = lines.filter((l) => (l.op || 0) + (l.pp || 0) > 0).map((l) => l.item_code);
  if (!codes.length) return [];
  const [limRes, unlockRes, used] = await Promise.all([
    DB.prepare(`SELECT item_code, limit_month, limit_year FROM limits WHERE fy = ? AND pcu = ?`).bind(fy, pcu).all(),
    DB.prepare(`SELECT item_code FROM limit_unlocks WHERE pcu = ? AND month = ?`).bind(pcu, month).all(),
    usedFyFor(DB, pcu, month),
  ]);
  const lim = new Map(limRes.results.map((r) => [r.item_code, r]));
  const unlocked = new Set(unlockRes.results.map((r) => r.item_code));
  const over = [];
  for (const l of lines) {
    const total = (l.op || 0) + (l.pp || 0);
    if (total <= 0 || unlocked.has(l.item_code)) continue;
    const r = lim.get(l.item_code);
    if (!r) continue;
    const lm = r.limit_month ?? null, ly = r.limit_year ?? null;
    const u = used[l.item_code] || 0;
    if ((lm !== null && total > lm) || (ly !== null && u + total > ly)) {
      over.push({ code: l.item_code, total, limit_month: lm, limit_year: ly, used_fy: u });
    }
  }
  return over;
}

export { priceMap };
