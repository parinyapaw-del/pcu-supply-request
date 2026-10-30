// xlsx_export.js — client-side XLSX for the request sheets (brief 2ag). Everything is built in the browser (free-tier server CPU is
// 10 ms/request); no API of its own. Shared by the PCU print page, the PCU dashboard and the admin Excel tab.
// Row source = RequestObj lines (functions/API.md §4.1): PCU view has issued figures in `request.issued[code].total` (done units only),
// admin view in `lines[code].issued_total`. A missing figure is an EMPTY cell, never 0 (rcv_qty absent = not reported ≠ 0).
import { getOrderedSteps } from "./data.js";
import { THAI_MONTHS } from "./format.js";

// SheetJS: admin.html loads it with a <script> tag; every other page lazy-loads it from cdnjs (only when a download is asked for).
let xlsxPromise = null;
export function getXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxPromise) return xlsxPromise;
  xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error("โหลด SheetJS ไม่สำเร็จ")));
    s.onerror = () => { xlsxPromise = null; reject(new Error("โหลด SheetJS ไม่สำเร็จ (ตรวจอินเทอร์เน็ต)")); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}

export const NO_ORDER_NOTE = "เดือนนี้ไม่เบิก";
export const ROW_HEAD = ["รายการ", "หน่วย", "ราคา", "คงเหลือ", "ใช้ไป", "ขอ OP", "ขอ PP", "ผู้จ่ายบันทึก", "รพ.สต. แจ้งได้รับ", "ไม่ตรง", "มูลค่า", "หมายเหตุ"];

const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** "2026-11" -> "2569-11" (Buddhist year, sorts as text) */
export function beMonth(month) {
  const [y, m] = String(month).split("-");
  return `${Number(y) + 543}-${m}`;
}
export function monthName(month) {
  const [y, m] = String(month).split("-").map(Number);
  return `${THAI_MONTHS[m - 1]} ${y + 543}`;
}

/**
 * One request -> row objects in form order (page by page), then lines whose code is not in the form.
 * A line is listed when it carries any figure (op/pp/stock/used/received/issued). `priceOf(code, line)` -> baht.
 * A "ไม่เบิก" request gives one note row. Returns [] for no request / draft-less empty requests.
 */
export function requestRows(request, form, priceOf) {
  if (!request) return [];
  if (request.no_order) return [{ name: "", note: NO_ORDER_NOTE, price: null, value: null }];
  const lines = request.lines || {};
  const issuedMap = request.issued || {};
  const out = [], seen = new Set();
  const push = (code, name, unit) => {
    const l = lines[code];
    if (!l || seen.has(code)) return;
    seen.add(code);
    const op = numOrNull(l.op) || 0, pp = numOrNull(l.pp) || 0;
    const issued = numOrNull(l.issued_total != null ? l.issued_total : issuedMap[code] && issuedMap[code].total);
    const rcv = numOrNull(l.rcv_qty);
    const stock = numOrNull(l.stock), used = numOrNull(l.used);
    if (!op && !pp && stock == null && used == null && rcv == null && issued == null) return;
    const price = numOrNull(priceOf(code, l)) || 0;
    out.push({
      code, name: name || code, unit: unit || "", price, stock, used, op, pp, issued, rcv,
      mismatch: l.mismatch === true ? "ไม่ตรง" : null, value: (op + pp) * price, note: null,
    });
  };
  if (form && Array.isArray(form.steps)) {
    getOrderedSteps(form).forEach((step) => (step.rows || []).forEach((r) => { if (r.type === "item") push(r.code, r.name, r.unit); }));
  }
  Object.keys(lines).forEach((c) => push(c, c, ""));
  return out;
}

const rowCells = (r) => [r.name, r.unit, r.price, r.stock, r.used, r.op, r.pp, r.issued, r.rcv, r.mismatch, r.value, r.note];

function applyLayout(XLSX, ws, widths, moneyCols, rowCount) {
  ws["!cols"] = widths.map((wch) => ({ wch }));
  for (let r = 1; r <= rowCount; r++) {
    moneyCols.forEach((c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = "#,##0.00";
    });
  }
}

/** Monthly workbook: 1 sheet "ใบเบิก". `pcuName` (admin all-PCU) is not used here — one request only. */
export function monthlyWorkbook(XLSX, rows, sheetName = "ใบเบิก") {
  const aoa = [ROW_HEAD, ...rows.map(rowCells)];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  applyLayout(XLSX, ws, [44, 10, 10, 10, 10, 9, 9, 14, 18, 9, 12, 16], [2, 10], rows.length);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}

/**
 * Year workbook. `entries` = [{pcu?, pcu_name?, month, rows}] (rows = requestRows output; a month without a sent request is simply absent).
 * Sheet `data`: long (1 row = [รพ.สต.] × เดือน × รายการ). Sheet `สรุป`: rows = items, columns = months, value = Σ (op+pp) (all PCUs when
 * several); months with a sent request but no quantity for the item = 0, months without any request = empty.
 * `withPcu` adds the รพ.สต. column first (admin all-PCU version).
 */
export function yearWorkbook(XLSX, entries, { withPcu = false } = {}) {
  const head = [...(withPcu ? ["รพ.สต."] : []), "เดือน", ...ROW_HEAD];
  const aoa = [head];
  const months = [...new Set(entries.map((e) => e.month))].sort();
  const items = new Map(); // key -> {name, unit, byMonth:{month:qty}}
  entries.forEach((e) => {
    e.rows.forEach((r) => {
      aoa.push([...(withPcu ? [e.pcu_name || e.pcu || ""] : []), beMonth(e.month), ...rowCells(r)]);
      if (r.code == null) return;
      const it = items.get(r.code) || { name: r.name, unit: r.unit, byMonth: {} };
      it.byMonth[e.month] = (it.byMonth[e.month] || 0) + r.op + r.pp;
      items.set(r.code, it);
    });
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const off = withPcu ? 1 : 0;
  applyLayout(XLSX, ws, [...(withPcu ? [26] : []), 10, 44, 10, 10, 10, 10, 9, 9, 14, 18, 9, 12, 16], [3 + off, 11 + off], aoa.length - 1);

  const sentMonths = new Map(months.map((m) => [m, new Set(entries.filter((e) => e.month === m).map((e) => e.pcu || ""))]));
  const sum = [["รายการ", "หน่วย", ...months.map(beMonth), "รวม"]];
  items.forEach((it) => {
    const vals = months.map((m) => (sentMonths.get(m).size ? it.byMonth[m] || 0 : null));
    if (!vals.some((v) => v)) return;
    sum.push([it.name, it.unit, ...vals, vals.reduce((a, v) => a + (v || 0), 0)]);
  });
  const ws2 = XLSX.utils.aoa_to_sheet(sum);
  ws2["!cols"] = [{ wch: 44 }, { wch: 10 }, ...months.map(() => ({ wch: 10 })), { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "data");
  XLSX.utils.book_append_sheet(wb, ws2, "สรุป");
  return wb;
}

/** Writes `wb` and starts the browser download. */
export function saveWorkbook(XLSX, wb, filename) {
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const safeName = (s) => String(s == null ? "" : s).replace(/[\\/:*?"<>|\s]+/g, "_");
