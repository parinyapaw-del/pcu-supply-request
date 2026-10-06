// export.js — Excel export (spec §5.8): 3 sheets built with SheetJS. See functions/API.md §6.
import * as XLSX from "xlsx";
import { err } from "./http.js";
import { latestForm, loadForm } from "./db.js";
import { bangkokDateTime, fyMonths, monthFy } from "./time.js";

const STATUS_TH = { draft: "กำลังกรอก", submitted: "ส่งแล้ว", issued: "จ่ายแล้ว" };
const REASON_TH = { out_of_stock: "ของหมด/รอจัดซื้อ" };
const round2 = (x) => Math.round(x * 100) / 100;
const nz = (v) => (v === null || v === undefined ? 0 : v);

function colWidths(ws, widths) {
  ws["!cols"] = widths.map((w) => ({ wch: w }));
}

export async function buildExport(DB, { month, fy }) {
  const months = month ? [month] : fyMonths(fy);
  const scopeFy = month ? monthFy(month) : fy;
  const ph = months.map(() => "?").join(",");

  const [pcuRes, reqRes, lineRes, planRes, scopeForm] = await Promise.all([
    DB.prepare(`SELECT code, name FROM pcus ORDER BY code`).all(),
    DB.prepare(`SELECT id, pcu, month, status, form_version_id, submitted_at FROM requests WHERE month IN (${ph}) ORDER BY month, pcu`).bind(...months).all(),
    DB.prepare(`SELECT request_id, item_code, op, pp, price_snapshot, issued_total, issued_op, issued_pp, issue_reason, issue_note
                  FROM request_lines WHERE request_id IN (SELECT id FROM requests WHERE month IN (${ph}))`).bind(...months).all(),
    DB.prepare(`SELECT pcu, item_code, plan_op, plan_pp FROM plans WHERE fy = ?`).bind(scopeFy).all(),
    latestForm(DB, scopeFy),
  ]);
  const pcus = pcuRes.results;
  const pcuName = new Map(pcus.map((p) => [p.code, p.name]));
  const linesBy = new Map();
  for (const l of lineRes.results) { if (!linesBy.has(l.request_id)) linesBy.set(l.request_id, []); linesBy.get(l.request_id).push(l); }

  const formCache = new Map();
  const formOf = async (r) => {
    const k = r.form_version_id || "latest:" + monthFy(r.month);
    if (!formCache.has(k)) formCache.set(k, r.form_version_id ? await loadForm(DB, r.form_version_id) : await latestForm(DB, monthFy(r.month)));
    return formCache.get(k);
  };

  // ---- sheet 1: per line ----
  const head1 = ["เดือน", "รหัส รพ.สต.", "รพ.สต.", "หน้า", "รหัสรายการ", "รายการ", "หน่วย", "ราคา/หน่วย", "OP", "PP", "รวม", "เป็นเงิน",
    "จ่ายจริง OP", "จ่ายจริง PP", "จ่ายจริงรวม", "เหตุผล", "สถานะ", "เวลาส่ง (เวลาไทย)", "form version"];
  const rows1 = [head1];
  const reqAgg = []; // submitted/issued per request for sheets 2/3
  for (const r of reqRes.results) {
    const form = await formOf(r);
    const order = new Map(); // code -> sort key
    if (form) { let i = 0; for (const s of form.steps) for (const row of s.rows) if (row.type === "item") order.set(row.code, i++); }
    const lines = (linesBy.get(r.id) || []).filter((l) => (l.op || 0) + (l.pp || 0) > 0 || l.issued_total !== null)
      .sort((a, b) => (order.get(a.item_code) ?? 9999) - (order.get(b.item_code) ?? 9999));
    for (const l of lines) {
      const ent = form && form.index.get(l.item_code);
      const price = l.price_snapshot ?? (ent ? Number(ent.item.price) || 0 : 0);
      const rowNo = rows1.length + 1;
      const op = nz(l.op), pp = nz(l.pp);
      const issued = l.issued_total !== null && l.issued_total !== undefined;
      rows1.push([
        r.month, r.pcu, pcuName.get(r.pcu) || r.pcu, ent ? ent.step.sheet || ent.step.code : "", l.item_code, ent ? ent.item.name : "", ent ? ent.item.unit : "", price,
        op, pp, { t: "n", v: op + pp, f: `I${rowNo}+J${rowNo}` }, { t: "n", v: round2((op + pp) * price), f: `K${rowNo}*H${rowNo}` },
        issued ? nz(l.issued_op) : "", issued ? nz(l.issued_pp) : "", issued ? l.issued_total : "",
        issued ? (l.issue_reason === "other" ? l.issue_note || "อื่น ๆ" : REASON_TH[l.issue_reason] || l.issue_reason || "") : "",
        STATUS_TH[r.status] || r.status, bangkokDateTime(r.submitted_at), r.form_version_id ?? "",
      ]);
    }
    if (r.status === "submitted" || r.status === "issued") reqAgg.push({ r, form, lines: linesBy.get(r.id) || [] });
  }
  const ws1 = XLSX.utils.aoa_to_sheet(rows1);
  colWidths(ws1, [9, 9, 16, 12, 10, 44, 8, 10, 8, 8, 8, 12, 11, 11, 11, 18, 10, 18, 11]);

  // ---- sheet 2: PCU × item ----
  const itemList = []; // {code,name,unit}
  const seen = new Set();
  if (scopeForm) for (const s of scopeForm.steps) for (const row of s.rows) if (row.type === "item") { itemList.push({ code: row.code, name: row.name, unit: row.unit }); seen.add(row.code); }
  for (const a of reqAgg) for (const l of a.lines) if (!seen.has(l.item_code)) {
    const ent = a.form && a.form.index.get(l.item_code);
    itemList.push({ code: l.item_code, name: ent ? ent.item.name : "", unit: ent ? ent.item.unit : "" }); seen.add(l.item_code);
  }
  const reqQty = new Map(), issQty = new Map(); // `${code}|${pcu}` -> qty
  for (const a of reqAgg) for (const l of a.lines) {
    const k = `${l.item_code}|${a.r.pcu}`;
    reqQty.set(k, (reqQty.get(k) || 0) + nz(l.op) + nz(l.pp));
    issQty.set(k, (issQty.get(k) || 0) + nz(l.issued_total));
  }
  const head2 = ["รหัสรายการ", "รายการ", "หน่วย", ...pcus.map((p) => p.name), "รวม"];
  const block = (title, map, offset) => {
    const out = [[title], head2];
    for (const it of itemList) {
      const vals = pcus.map((p) => map.get(`${it.code}|${p.code}`) || 0);
      const r = offset + out.length + 1;
      const sumF = vals.length ? `SUM(D${r}:${XLSX.utils.encode_col(2 + pcus.length)}${r})` : "0";
      out.push([it.code, it.name, it.unit, ...vals, { t: "n", v: vals.reduce((a, b) => a + b, 0), f: sumF }]);
    }
    return out;
  };
  const b1 = block("จำนวนที่ขอ (OP+PP) — เฉพาะใบที่ส่งแล้ว/จ่ายแล้ว", reqQty, 0);
  const b2 = block("จำนวนที่จ่ายจริง", issQty, b1.length + 1);
  const ws2 = XLSX.utils.aoa_to_sheet([...b1, [], ...b2]);
  colWidths(ws2, [10, 44, 8, ...pcus.map(() => 11), 9]);

  // ---- sheet 3: money per PCU ----
  const prices = {};
  if (scopeForm) for (const [c, { item }] of scopeForm.index) prices[c] = Number(item.price) || 0;
  const plan = new Map(); // pcu -> {op,pp}
  for (const p of planRes.results) {
    const e = plan.get(p.pcu) || { op: 0, pp: 0 };
    e.op += nz(p.plan_op) * (prices[p.item_code] || 0); e.pp += nz(p.plan_pp) * (prices[p.item_code] || 0);
    plan.set(p.pcu, e);
  }
  const req = new Map(), iss = new Map();
  for (const a of reqAgg) {
    const e = req.get(a.r.pcu) || { op: 0, pp: 0 }, ie = iss.get(a.r.pcu) || { op: 0, pp: 0 };
    for (const l of a.lines) {
      const ent = a.form && a.form.index.get(l.item_code);
      const price = l.price_snapshot ?? (ent ? Number(ent.item.price) || 0 : 0);
      e.op += nz(l.op) * price; e.pp += nz(l.pp) * price;
      ie.op += nz(l.issued_op) * price; ie.pp += nz(l.issued_pp) * price;
    }
    req.set(a.r.pcu, e); iss.set(a.r.pcu, ie);
  }
  const scopeLabel = month ? `เดือน ${month}` : `ปีงบ ${fy}`;
  const head3 = ["รหัส รพ.สต.", "รพ.สต.", "แผน OP (บาท)", "แผน PP (บาท)", "แผนรวม", "ขอ OP (บาท)", "ขอ PP (บาท)", "ขอรวม", "จ่ายจริง OP", "จ่ายจริง PP", "จ่ายจริงรวม", "ส่วนต่าง (แผน − ขอ)"];
  const rows3 = [[`สรุปเงินต่อ รพ.สต. — ขอ/จ่ายจริง: ${scopeLabel} · แผน: ปีงบ ${scopeFy} (ราคาตามฟอร์มปีงบ)`], head3];
  const first = 3;
  pcus.forEach((p, i) => {
    const r = first + i;
    const pl = plan.get(p.code) || { op: 0, pp: 0 }, rq = req.get(p.code) || { op: 0, pp: 0 }, is = iss.get(p.code) || { op: 0, pp: 0 };
    rows3.push([
      p.code, p.name, round2(pl.op), round2(pl.pp), { t: "n", v: round2(pl.op + pl.pp), f: `C${r}+D${r}` },
      round2(rq.op), round2(rq.pp), { t: "n", v: round2(rq.op + rq.pp), f: `F${r}+G${r}` },
      round2(is.op), round2(is.pp), { t: "n", v: round2(is.op + is.pp), f: `I${r}+J${r}` },
      { t: "n", v: round2(pl.op + pl.pp - rq.op - rq.pp), f: `E${r}-H${r}` },
    ]);
  });
  const last = first + pcus.length - 1;
  const sumCol = (c, idx) => ({ t: "n", v: round2(rows3.slice(2).reduce((a, r) => a + (typeof r[idx] === "object" ? r[idx].v : r[idx]), 0)), f: `SUM(${c}${first}:${c}${last})` });
  rows3.push(["", "รวม", sumCol("C", 2), sumCol("D", 3), sumCol("E", 4), sumCol("F", 5), sumCol("G", 6), sumCol("H", 7), sumCol("I", 8), sumCol("J", 9), sumCol("K", 10), sumCol("L", 11)]);
  const ws3 = XLSX.utils.aoa_to_sheet(rows3);
  colWidths(ws3, [12, 16, 14, 14, 14, 14, 14, 14, 14, 14, 14, 18]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, "รายบรรทัด");
  XLSX.utils.book_append_sheet(wb, ws2, "รพ.สต. × รายการ");
  XLSX.utils.book_append_sheet(wb, ws3, "สรุปเงินต่อ รพ.สต.");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
  const filename = month ? `เบิกวัสดุ_${month}.xlsx` : `เบิกวัสดุ_ปีงบ${fy}.xlsx`;
  return { bytes, filename };
}

export function parseExportScope(url) {
  const month = url.searchParams.get("month");
  const fy = url.searchParams.get("fy");
  if (month) {
    if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) throw err("BAD_REQUEST", "month ต้องเป็นรูปแบบ YYYY-MM");
    return { month };
  }
  if (fy) {
    const n = Number(fy);
    if (!Number.isInteger(n) || n < 2560 || n > 2700) throw err("BAD_REQUEST", "fy ต้องเป็นปี พ.ศ. เช่น 2570");
    return { fy: n };
  }
  throw err("BAD_REQUEST", "ต้องระบุ month=YYYY-MM หรือ fy=2570");
}
