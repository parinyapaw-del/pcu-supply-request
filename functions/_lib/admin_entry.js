// admin_entry.js — 2w: an admin keys / edits / sends a request for a pcu (paper sheets of past rounds; overrides everything).
// adminSaveLines{pcu, month, lines:{code:{op,pp,stock?,used?}}, send?} — functions/API.md §5.1b. Admin only (router ADMIN table).
// month ∈ fyMonths(fy_current) · skips deadline / round lock / limits / issued pages · requests.entry_by = 'admin' (sticky) · audit admin_lines.
// Only lines whose values change are written (D1 write quota). An issued figure above the new requested qty is clamped down (`clamped`).
import { err, assertQty } from "./http.js";
import { auditStmt, batchChunked, formForFy, getConfigAll, loadForm, publicConfig } from "./db.js";
import { currentRound, fyMonths, isMonth, monthFy, nowIso } from "./time.js";
import { REQUESTER_ON_SEND_SQL, getLines, getRequestRow, requestId, requestObj } from "./views.js";
import { baselineFor, computeLine, recalcStockChain } from "./stock.js";
import { loadPriceHistory, priceFor } from "./price.js";
import { splitIssued } from "./issue.js";

const MAX_LINES = 400;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const QTY = ["stock", "op", "pp", "used"];
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export async function adminSaveLines(ctx, p) {
  const { DB, who } = ctx;
  const pcuRow = await DB.prepare(`SELECT code FROM pcus WHERE code = ?`).bind(String(p.pcu || "")).first();
  if (!pcuRow) throw err("NOT_FOUND", "ไม่พบ รพ.สต. นี้: " + p.pcu);
  const pcu = pcuRow.code, month = p.month;
  if (!isMonth(month)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง: " + month);
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentRound()));
  const ms = fyMonths(cfg.fy_current);
  if (!ms.includes(month)) throw err("BAD_REQUEST", `admin คีย์ใบแทนได้เฉพาะรอบของปีงบ ${cfg.fy_current} (${ms[0]} ถึง ${ms[11]})`);
  if (month > currentRound()) throw err("BAD_REQUEST", "ยังไม่ถึงรอบเดือนนี้");
  const linesIn = isObj(p.lines) ? p.lines : {};
  const codes = Object.keys(linesIn);
  if (codes.length > MAX_LINES) throw err("BAD_REQUEST", "จำนวนบรรทัดมากเกินไป");
  const send = p.send === true || p.send === 1 || p.send === "1";

  const fy = monthFy(month);
  const [reqRow, latest] = await Promise.all([getRequestRow(DB, pcu, month), formForFy(DB, fy, cfg.fy_current)]);
  if (!latest) throw err("NOT_FOUND", "ยังไม่มีแบบฟอร์มในระบบ");
  const bound = reqRow && reqRow.form_version_id ? await loadForm(DB, reqRow.form_version_id) : null;
  const id = requestId(pcu, month);
  const existing = new Map((reqRow ? await getLines(DB, id) : []).map((l) => [l.item_code, l]));

  // validation first — nothing is written unless every line is valid. A key not sent keeps the stored value; sending stock/used
  // means the admin typed the figure from paper → calc_from is cleared (no stock-mode calculation on that line).
  const parsed = [];
  for (const code of codes) {
    if (!latest.index.has(code) && !(bound && bound.index.has(code))) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + code);
    const l = isObj(linesIn[code]) ? linesIn[code] : {};
    const e = existing.get(code) || null;
    const v = {};
    for (const k of QTY) v[k] = has(l, k) ? assertQty(l[k]) : e ? e[k] ?? null : null;
    v.adj = e ? e.adj ?? null : null;
    v.calc_from = has(l, "stock") || has(l, "used") ? null : e ? e.calc_from ?? null : null;
    parsed.push({ code, e, v });
  }
  const base = parsed.some((x) => x.v.calc_from) ? await baselineFor(DB, pcu, month) : {};

  const now = nowIso();
  const stmts = [];
  const clamped = [];
  let qtyChanged = false, nChanged = 0;
  if (!reqRow) {
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO requests (id,pcu,month,status,created_at,updated_at,submit_count,entry_by) VALUES (?,?,?, 'draft', ?, ?, 0, 'admin')`)
      .bind(id, pcu, month, now, now));
  }
  for (const x of parsed) {
    Object.assign(x.v, computeLine(base[x.code], x.v));
    const { e, v } = x;
    const same = e ? ["stock", "op", "pp", "used", "calc_from"].every((k) => (e[k] ?? null) === (v[k] ?? null)) : QTY.every((k) => v[k] === null);
    if (same) continue;
    qtyChanged = true; nChanged++;
    stmts.push(DB.prepare(
      `INSERT INTO request_lines (request_id,item_code,stock,op,pp,used,adj,calc_from,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(request_id,item_code) DO UPDATE SET stock=excluded.stock, op=excluded.op, pp=excluded.pp, used=excluded.used,
         calc_from=excluded.calc_from, updated_at=excluded.updated_at`
    ).bind(id, x.code, v.stock, v.op, v.pp, v.used, v.adj, v.calc_from, now));
    // Q7: the admin overrides an issued line → keep the issued figure ≤ the new requested qty (OP-first split recomputed)
    if (e && e.issued_total !== null && e.issued_total !== undefined) {
      const req = (v.op || 0) + (v.pp || 0);
      const total = Math.min(e.issued_total, req);
      if (total < e.issued_total) clamped.push({ code: x.code, from: e.issued_total, to: total });
      const sp = splitIssued(v.op || 0, v.pp || 0, total);
      const full = total === req;
      stmts.push(DB.prepare(
        `UPDATE request_lines SET issued_total=?, issued_op=?, issued_pp=?, issue_reason=?, issue_note=? WHERE request_id=? AND item_code=?`
      ).bind(total, sp.issued_op, sp.issued_pp, full ? null : e.issue_reason ?? "other", full ? null : e.issue_note ?? "ปรับยอดขอโดย admin", id, x.code));
    }
  }
  const wasSent = !!reqRow && reqRow.status !== "draft";
  // 2af: the admin keyed a quantity on a "ไม่เบิก" request → it is an ordinary request again
  if (reqRow && reqRow.no_order && parsed.some((x) => (x.v.op || 0) + (x.v.pp || 0) > 0)) stmts.push(DB.prepare(`UPDATE requests SET no_order = 0 WHERE id = ?`).bind(id));
  if (stmts.length || send) {
    stmts.push(DB.prepare(`UPDATE requests SET entry_by = 'admin', updated_at = ? WHERE id = ?`).bind(now, id));
  }
  if (stmts.length) await batchChunked(DB, stmts);

  // send (or an edit of a request that was already sent): stamp the round's price on every line (as the pcu's send does, 2p)
  if (send || (wasSent && qtyChanged)) {
    const lines = await getLines(DB, id);
    const hist = await loadPriceHistory(DB, fy);
    const fin = [];
    for (const l of lines) {
      const price = priceFor(hist, latest.index.has(l.item_code) ? latest : bound, l.item_code, month);
      if (price === (l.price_snapshot ?? null) && price === (l.price_print ?? null)) continue;
      fin.push(DB.prepare(`UPDATE request_lines SET price_snapshot = ?, price_print = ? WHERE request_id = ? AND item_code = ?`).bind(price, price, id, l.item_code));
    }
    if (send) {
      fin.push(DB.prepare(
        `UPDATE requests SET status = CASE WHEN status = 'issued' THEN 'issued' ELSE 'submitted' END, form_version_id = ?, submitted_at = ?, updated_at = ?,
                first_submitted_at = COALESCE(first_submitted_at, ?), submit_count = COALESCE(submit_count,0) + 1,
                requester_name = ${REQUESTER_ON_SEND_SQL} WHERE id = ?`
      ).bind(latest.id, now, now, now, pcu, pcu, pcu, id)); // 2x: requester name frozen at the first send
    } else {
      fin.push(DB.prepare(`UPDATE requests SET submitted_at = ?, form_version_id = ? WHERE id = ?`).bind(now, latest.id, id)); // still sent, no "edited after submit"
    }
    await batchChunked(DB, fin);
  }
  const n = parsed.filter((x) => (x.v.op || 0) + (x.v.pp || 0) > 0).length;
  await DB.batch([auditStmt(DB, who.email, who.role, "admin_lines", pcu, month,
    `changed=${nChanged} items=${n} send=${send ? 1 : 0}${clamped.length ? " clamped=" + clamped.map((c) => `${c.code}:${c.from}→${c.to}`).join(",") : ""}`.slice(0, 1500))]);
  if (qtyChanged && (wasSent || send)) await recalcStockChain(DB, pcu, month); // 2o: this round is (now) a baseline

  const [row2, lines2] = await Promise.all([getRequestRow(DB, pcu, month), getLines(DB, id)]);
  return { saved_at: now, status: row2.status, submitted: send, clamped, request: requestObj(row2, lines2, true) };
}
