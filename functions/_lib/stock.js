// stock.js — 2o: stock calculation (mode B). The server owns the formula (spec 2o-2s §3.2/§3.4):
//   baseline (pcu, round M, item) = the stock of the item on the pcu's prevMonth(M) request, when that request is submitted/issued and stock is not null
//   received = issued_total when the item's dispense unit is done (issue_status row) and issued_total is not null, else op+pp of that request
//   available = baseline + received + (adj ?? 0) · calc_from 'used' → stock = available − used · 'stock' → used = available − stock · negative → null
import { formForFy, linkMap, loadForm } from "./db.js";
import { currentRound, monthFy, nextMonth, prevMonth } from "./time.js";

export const CALC_FROM = ["used", "stock"];
export const ADJ_REASONS = ["received_extra", "borrow_return", "expired_damaged", "recount", "other"];
export const ADJ_REASON_TH = { received_extra: "ได้รับเพิ่ม", borrow_return: "ยืม/คืน", expired_damaged: "หมดอายุ/เสียหาย", recount: "นับใหม่", other: "อื่น ๆ" };

const reqIdOf = (pcu, month) => `${pcu}_${month}`; // = views.requestId (kept local: views.js imports this module)

// { code: {op, pp, stock, received, received_src:'issued'|'requested'} } from the pcu's prevMonth(month) request (submitted/issued only).
// Rows: op+pp > 0 or stock not null. No request / draft → {}. Issued figures only for DONE units (same rule as the PCU view, Q78).
export async function baselineFor(DB, pcu, month) {
  const pm = prevMonth(month);
  const [lineRes, doneRes] = await Promise.all([
    DB.prepare(
      `SELECT r.form_version_id AS fv, l.item_code AS code, l.stock, COALESCE(l.op,0) AS op, COALESCE(l.pp,0) AS pp, l.issued_total
         FROM requests r JOIN request_lines l ON l.request_id = r.id
        WHERE r.pcu = ? AND r.month = ? AND r.status IN ('submitted','issued') AND (l.stock IS NOT NULL OR COALESCE(l.op,0) + COALESCE(l.pp,0) > 0)`
    ).bind(pcu, pm).all(),
    DB.prepare(`SELECT dispense_unit FROM issue_status WHERE request_id = ?`).bind(reqIdOf(pcu, pm)).all(),
  ]);
  const rows = lineRes.results;
  const out = {};
  if (!rows.length) return out;
  const done = new Set(doneRes.results.map((r) => r.dispense_unit));
  let form = null;
  if (done.size) form = rows[0].fv ? await loadForm(DB, rows[0].fv) : await formForFy(DB, monthFy(pm)); // only needed to map item → unit
  for (const r of rows) {
    const ent = form && form.index.get(r.code);
    const issued = ent && done.has(ent.step.dispense_unit) && r.issued_total !== null && r.issued_total !== undefined;
    out[r.code] = {
      op: r.op, pp: r.pp, stock: r.stock ?? null,
      received: issued ? r.issued_total : r.op + r.pp, received_src: issued ? "issued" : "requested",
    };
  }
  // 2v: last round's line of a linked old code is the baseline of the item that replaces it (when that item has none of its own)
  const lf = form || (rows[0].fv ? await loadForm(DB, rows[0].fv) : await formForFy(DB, monthFy(pm)));
  for (const [o, n] of linkMap(lf)) if (out[o] && !out[n]) out[n] = out[o];
  return out;
}

// One line's stored outputs given its baseline entry (or undefined). line = {stock, used, adj, calc_from}.
// No baseline (no entry / stock null) → calc_from forced null, stock/used kept as given. calc_from null → nothing computed.
export function computeLine(base, line) {
  const stock = line.stock ?? null, used = line.used ?? null;
  if (!base || base.stock === null || base.stock === undefined) return { stock, used, calc_from: null };
  const cf = CALC_FROM.includes(line.calc_from) ? line.calc_from : null;
  if (!cf) return { stock, used, calc_from: null };
  const available = base.stock + (base.received || 0) + (line.adj ?? 0);
  if (cf === "used") {
    const s = used === null ? null : available - used;
    return { stock: s === null || s < 0 ? null : s, used, calc_from: cf };
  }
  const u = stock === null ? null : available - stock;
  return { stock, used: u === null || u < 0 ? null : u, calc_from: cf };
}

// Recomputes the calc_from lines of the pcu's request for nextMonth(fromMonth), then keeps going while that round's stock changed
// (≤ currentRound). Never bumps requests.updated_at / line updated_at, writes no audit, ignores round locks and request status.
// Lines whose baseline disappeared are left as they are. Returns the number of lines rewritten.
export async function recalcStockChain(DB, pcu, fromMonth) {
  const cap = currentRound();
  let m = fromMonth, n = 0;
  for (let guard = 0; guard < 24; guard++) {
    const nm = nextMonth(m);
    if (nm > cap) break;
    const id = reqIdOf(pcu, nm);
    const { results } = await DB.prepare(
      `SELECT item_code, stock, used, adj, calc_from FROM request_lines WHERE request_id = ? AND calc_from IS NOT NULL`
    ).bind(id).all();
    if (!results.length) break;
    const base = await baselineFor(DB, pcu, nm);
    const stmts = [];
    let stockChanged = false;
    for (const l of results) {
      const b = base[l.item_code];
      if (!b || b.stock === null) continue;
      const c = computeLine(b, l);
      if (c.stock === (l.stock ?? null) && c.used === (l.used ?? null)) continue;
      if (c.stock !== (l.stock ?? null)) stockChanged = true;
      stmts.push(DB.prepare(`UPDATE request_lines SET stock = ?, used = ? WHERE request_id = ? AND item_code = ?`).bind(c.stock, c.used, id, l.item_code));
    }
    if (stmts.length) {
      for (let i = 0; i < stmts.length; i += 100) await DB.batch(stmts.slice(i, i + 100));
      n += stmts.length;
    }
    if (!stockChanged) break;
    m = nm;
  }
  return n;
}

// After an issue write touching (pcus × month): one query finds which pcus have calc_from lines in nextMonth(month), then recalc only those.
export async function recalcAfterIssue(DB, pcus, month) {
  const list = [...new Set(pcus)].filter(Boolean);
  const nm = nextMonth(month);
  if (!list.length || nm > currentRound()) return 0;
  const { results } = await DB.prepare(
    `SELECT DISTINCT r.pcu FROM requests r JOIN request_lines l ON l.request_id = r.id
      WHERE r.month = ? AND l.calc_from IS NOT NULL AND r.pcu IN (${list.map(() => "?").join(",")})`
  ).bind(nm, ...list).all();
  let n = 0;
  for (const r of results) n += await recalcStockChain(DB, r.pcu, month);
  return n;
}
