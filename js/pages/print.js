// A4 print sheet — reproduces the original xlsx layout (spec §4).
// One <table> (13 cols, A..M) per step, fixed scale s=0.74 applied via the
// --print-scale CSS custom property so every page uses the same font size.
import { ACTIVE_STEPS } from "../constants.js";
import { getStep, getItemRows } from "../data.js";
import * as store from "../store.js";
import { formatMoney, formatInt, formatThaiDateParts, THAI_MONTHS, monthKeyToParts, beYear } from "../format.js";

// Natural column widths in pt, columns A..M (sum ~601pt before scaling).
const COL_WIDTHS_PT = [40, 43.5, 47.8, 47.8, 47.8, 47.8, 47.8, 40, 47.8, 43.5, 47.8, 43.5, 55.7];

const SIG_DOTS_LONG = "………………………………………..……………..";
const SIG_NAME_LINE = "( .......................................................... )";
const SIG_DATE_LINE = "วันที่ .......... / .......... / ..........";

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fillOrDots(dots, value, fill) {
  if (!fill || value == null || value === "") return esc(dots);
  return `<span class="fill-slot" style="min-width:${(dots.length * 0.15).toFixed(1)}em">${esc(String(value))}</span>`;
}

export async function renderPrint(container, app) {
  const request = store.getOrCreateRequest(app.pcu, app.monthKey);
  const pcu = app.form.pcus.find((p) => p.code === app.pcu);
  const isDraft = request.status !== "submitted";

  const stepTotalsMap = {};
  ACTIVE_STEPS.forEach((code) => {
    const step = getStep(app.form, code);
    let sum = 0;
    getItemRows(step).forEach((item) => {
      if (store.getHiddenItems(app.pcu).includes(item.code)) return;
      const line = (request.lines && request.lines[item.code]) || {};
      sum += (Number(line.op) || 0) + (Number(line.pp) || 0);
    });
    stepTotalsMap[code] = sum;
  });

  const wrap = document.createElement("div");
  wrap.className = "print-wrap";

  const controls = document.createElement("div");
  controls.className = "print-controls no-print";
  controls.innerHTML = `
    <h2>ตัวอย่างใบพิมพ์</h2>
    <p class="muted">${isDraft ? "ยังไม่ส่งใบเบิก — ตัวอย่างนี้มีลายน้ำ “แบบร่าง – ยังไม่สมบูรณ์”" : "ใบเบิกฉบับสมบูรณ์ พร้อมพิมพ์"}</p>
    <div class="print-step-checks">
      ${ACTIVE_STEPS.map((code) => {
        const step = getStep(app.form, code);
        const checked = stepTotalsMap[code] > 0 ? "checked" : "";
        return `<label><input type="checkbox" class="print-step-chk" value="${code}" ${checked}> ${esc(step.title)}</label>`;
      }).join("")}
    </div>
    <button type="button" class="btn btn-primary" id="btn-do-print">พิมพ์</button>
  `;
  wrap.appendChild(controls);

  const pagesHost = document.createElement("div");
  pagesHost.id = "print-pages";
  wrap.appendChild(pagesHost);

  container.innerHTML = "";
  container.appendChild(wrap);

  function renderPages() {
    const checkedCodes = Array.from(document.querySelectorAll(".print-step-chk:checked")).map((c) => c.value);
    pagesHost.innerHTML = "";
    checkedCodes.forEach((code) => {
      const step = getStep(app.form, code);
      pagesHost.appendChild(buildPrintPage(app, step, request, pcu, isDraft));
    });
  }
  renderPages();

  document.querySelectorAll(".print-step-chk").forEach((chk) => chk.addEventListener("change", renderPages));
  document.getElementById("btn-do-print").addEventListener("click", () => window.print());
}

function buildPrintPage(app, step, request, pcu, isDraft) {
  const page = document.createElement("div");
  page.className = "print-page";

  if (isDraft) {
    const wm = document.createElement("div");
    wm.className = "draft-watermark";
    wm.textContent = "แบบร่าง – ยังไม่สมบูรณ์";
    page.appendChild(wm);
  }

  const table = document.createElement("table");
  table.className = "print-table";

  const colgroup = document.createElement("colgroup");
  COL_WIDTHS_PT.forEach((w) => {
    const col = document.createElement("col");
    col.style.width = `calc(${w}pt * var(--print-scale))`;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  const tbody = document.createElement("tbody");
  tbody.appendChild(rowTitle(step));
  tbody.appendChild(rowReceiptNo());
  tbody.appendChild(rowDate(request, isDraft));
  tbody.appendChild(rowLabelValue("เรื่อง", step.subject));
  tbody.appendChild(rowLabelValue("เรียน", step.to));
  tbody.appendChild(rowBlank());
  tbody.appendChild(rowIKhaphachao(pcu));
  tbody.appendChild(rowMonthYear(app.monthKey));
  appendTableHeader(tbody);
  appendBodyRows(tbody, app, step);
  appendTotalRow(tbody, app, step);
  tbody.appendChild(rowBlank());
  appendSignatureBlock(tbody, step);

  table.appendChild(tbody);
  page.appendChild(table);
  return page;
}

function tr(className, cells, heightPt) {
  const row = document.createElement("tr");
  if (className) row.className = className;
  if (heightPt) row.style.height = `calc(${heightPt}pt * var(--print-scale))`;
  cells.forEach((c) => row.appendChild(c));
  return row;
}

function td(html, { colspan = 1, rowspan = 1, cls = "", align = "" } = {}) {
  const cell = document.createElement("td");
  if (colspan > 1) cell.colSpan = colspan;
  if (rowspan > 1) cell.rowSpan = rowspan;
  if (cls) cell.className = cls;
  if (align) cell.style.textAlign = align;
  cell.innerHTML = html;
  return cell;
}

function rowTitle(step) {
  return tr("row-h20", [td(`<strong>${esc(step.title)}</strong>`, { colspan: 13, cls: "cell-noborder cell-center" })], 20);
}

function rowReceiptNo() {
  return tr("row-h20", [
    td("", { colspan: 11, cls: "cell-noborder" }),
    td("เลขที่ใบเบิก ..............", { colspan: 2, cls: "cell-noborder cell-left" }),
  ], 20);
}

function rowDate(request, isDraft) {
  let dayVal = null, monthVal = null, yearVal = null;
  if (!isDraft && request.submitted_at) {
    const parts = formatThaiDateParts(new Date(request.submitted_at));
    dayVal = parts.day; monthVal = parts.monthName; yearVal = parts.beYear;
  }
  const text = `วันที่ ${fillOrDots("...........", dayVal, !isDraft)} /${fillOrDots(".................", monthVal, !isDraft)}/${fillOrDots("............", yearVal, !isDraft)}`;
  return tr("row-h20", [
    td("", { colspan: 7, cls: "cell-noborder" }),
    td(text, { colspan: 3, cls: "cell-noborder cell-left" }),
    td("", { colspan: 3, cls: "cell-noborder" }),
  ], 20);
}

function rowLabelValue(label, value) {
  return tr("row-h20", [
    td(`<strong>${esc(label)}</strong>`, { colspan: 1, cls: "cell-noborder" }),
    td(esc(value || ""), { colspan: 6, cls: "cell-noborder cell-left" }),
    td("", { colspan: 6, cls: "cell-noborder" }),
  ], 20);
}

function rowBlank() {
  return tr("row-h20", [td("", { colspan: 13, cls: "cell-noborder" })], 20);
}

function rowIKhaphachao(pcu) {
  const printName = pcu ? pcu.print_name : "";
  const text = `ข้าพเจ้า ${SIG_DOTS_LONG} ผู้มีสิทธิเบิกวัสดุของสถานพยาบาลโรงพยาบาลส่งเสริมสุขภาพตำบล ${fillOrDots("..........................", printName, true)}`;
  return tr("row-h20", [
    td("", { colspan: 1, cls: "cell-noborder" }),
    td(text, { colspan: 12, cls: "cell-noborder cell-left" }),
  ], 20);
}

function rowMonthYear(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  const monthName = THAI_MONTHS[month - 1];
  const be = beYear(year);
  const text = `มีความประสงค์จะขอเบิกวัสดุเพื่อใช้ในงานราชการ  ประจำเดือน ${fillOrDots("........................................", monthName, true)} พ.ศ. ${fillOrDots("..........................", be, true)} ดังรายการต่อไปนี้`;
  return tr("row-h20", [td(text, { colspan: 13, cls: "cell-noborder cell-left" })], 20);
}

function appendTableHeader(tbody) {
  const r9 = tr("row-h20", [
    td("ลำ<br>ดับ", { rowspan: 3, cls: "cell-border cell-center cell-bold" }),
    td("รายการ", { colspan: 6, rowspan: 3, cls: "cell-border cell-center cell-bold" }),
    td("หน่วย", { rowspan: 3, cls: "cell-border cell-center cell-bold" }),
    td("ราคา", { cls: "cell-border-lr cell-center cell-bold cell-i-top" }),
    td("เบิกเพื่อใช้ในงาน", { colspan: 4, cls: "cell-border cell-center cell-bold" }),
  ], 20);
  const r10 = tr("row-h20", [
    td("/", { cls: "cell-border-lr cell-center cell-bold" }),
    td("OP", { cls: "cell-border cell-center cell-bold cell-jm-top" }),
    td("PP", { cls: "cell-border cell-center cell-bold cell-jm-top" }),
    td("รวม", { cls: "cell-border cell-center cell-bold cell-jm-top" }),
    td("เป็นเงิน", { cls: "cell-border cell-center cell-bold cell-jm-top" }),
  ], 20);
  const r11 = tr("row-h20", [
    td("หน่วย", { cls: "cell-border-lr cell-center cell-bold cell-i-bottom" }),
    td("(จำนวน)", { cls: "cell-border cell-center cell-bold" }),
    td("(จำนวน)", { cls: "cell-border cell-center cell-bold" }),
    td("(จำนวน)", { cls: "cell-border cell-center cell-bold" }),
    td("( บาท )", { cls: "cell-border cell-center cell-bold" }),
  ], 20);
  tbody.appendChild(r9);
  tbody.appendChild(r10);
  tbody.appendChild(r11);
}

function appendBodyRows(tbody, app, step) {
  const hidden = store.getHiddenItems(app.pcu);
  step.rows.forEach((row) => {
    if (row.type === "section") {
      tbody.appendChild(tr("row-h21", [
        td("", { cls: "cell-border" }),
        td(`<strong>${esc(row.title)}</strong>`, { colspan: 6, cls: "cell-border cell-center cell-bold" }),
        td("", { cls: "cell-border" }),
        td("", { cls: "cell-border" }),
        td("", { cls: "cell-border" }),
        td("", { cls: "cell-border" }),
        td("", { cls: "cell-border" }),
        td("", { cls: "cell-border" }),
      ], 21));
      return;
    }
    const isHidden = hidden.includes(row.code);
    const request = store.getOrCreateRequest(app.pcu, app.monthKey);
    const line = isHidden ? { op: 0, pp: 0 } : (request.lines && request.lines[row.code]) || { op: 0, pp: 0 };
    const op = Number(line.op) || 0;
    const pp = Number(line.pp) || 0;
    const qty = op + pp;
    const money = qty * row.price;
    tbody.appendChild(tr("row-h21", [
      td(String(row.seq), { cls: "cell-border cell-center" }),
      td(esc(row.name), { colspan: 6, cls: "cell-border cell-left" }),
      td(esc(row.unit || ""), { cls: "cell-border cell-center" }),
      td(formatMoney(row.price), { cls: "cell-border cell-right" }),
      td(op ? formatInt(op) : "", { cls: "cell-border cell-center" }),
      td(pp ? formatInt(pp) : "", { cls: "cell-border cell-center" }),
      td(qty ? formatInt(qty) : "", { cls: "cell-border cell-center" }),
      td(qty ? formatMoney(money) : "", { cls: "cell-border cell-right" }),
    ], 21));
  });
}

function appendTotalRow(tbody, app, step) {
  const hidden = store.getHiddenItems(app.pcu);
  const request = store.getOrCreateRequest(app.pcu, app.monthKey);
  let op = 0, pp = 0, money = 0;
  getItemRows(step).forEach((item) => {
    if (hidden.includes(item.code)) return;
    const line = (request.lines && request.lines[item.code]) || {};
    const o = Number(line.op) || 0, p = Number(line.pp) || 0;
    op += o; pp += p; money += (o + p) * item.price;
  });
  const qty = op + pp;
  tbody.appendChild(tr("row-h21", [
    td("<strong>รวม</strong>", { colspan: 9, cls: "cell-border cell-center" }),
    td(`<strong>${formatInt(op)}</strong>`, { cls: "cell-border cell-center" }),
    td(`<strong>${formatInt(pp)}</strong>`, { cls: "cell-border cell-center" }),
    td(`<strong>${formatInt(qty)}</strong>`, { cls: "cell-border cell-center" }),
    td(`<strong>${formatMoney(money)}</strong>`, { cls: "cell-border cell-right" }),
  ], 21));
}

function gap(n) {
  return td("", { colspan: n, cls: "cell-noborder" });
}

// Column index reference: A0 B1 C2 D3 E4 F5 G6 H7 I8 J9 K10 L11 M12 (13 total).
// Every row below must sum its colspans to exactly 13.
function appendSignatureBlock(tbody, step) {
  // r+0: A ลงชื่อ | B:E dots | F ผู้เบิก | G gap | H ลงชื่อ | I:L dots | M ผู้จ่าย
  tbody.appendChild(tr("row-h20", [
    td("ลงชื่อ", { cls: "cell-noborder cell-right" }),
    td(SIG_DOTS_LONG, { colspan: 4, cls: "cell-noborder cell-center" }),
    td("ผู้เบิก", { cls: "cell-noborder cell-left" }),
    gap(1),
    td("ลงชื่อ", { cls: "cell-noborder cell-right" }),
    td(SIG_DOTS_LONG, { colspan: 4, cls: "cell-noborder cell-center" }),
    td("ผู้จ่าย", { cls: "cell-noborder cell-left" }),
  ], 20));
  // r+1: gap | B:E (name) | F,G,H gap | I:L (name) | M gap
  tbody.appendChild(tr("row-h20", [
    gap(1),
    td(SIG_NAME_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1), gap(1), gap(1),
    td(SIG_NAME_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1),
  ], 20));
  // r+2: A:H gap | I:L วันที่ | M gap
  tbody.appendChild(tr("row-h20", [
    gap(8),
    td(SIG_DATE_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1),
  ], 20));
  // r+3: A:F statement | G:M gap
  tbody.appendChild(tr("row-h20", [
    td("ข้าพเจ้าได้รับของตามจำนวนและรายการที่จ่ายเรียบร้อยแล้ว", { colspan: 6, cls: "cell-noborder cell-center" }),
    gap(7),
  ], 20));
  // r+4: A:G gap | H ลงชื่อ | I:L dots | M ผู้อนุมัติ
  tbody.appendChild(tr("row-h20", [
    gap(7),
    td("ลงชื่อ", { cls: "cell-noborder cell-right" }),
    td(SIG_DOTS_LONG, { colspan: 4, cls: "cell-noborder cell-center" }),
    td("ผู้อนุมัติ", { cls: "cell-noborder cell-left" }),
  ], 20));
  // r+5: A ลงชื่อ | B:E dots | F ผู้รับ | G,H gap | I:L (name) | M gap
  tbody.appendChild(tr("row-h20", [
    td("ลงชื่อ", { cls: "cell-noborder cell-right" }),
    td(SIG_DOTS_LONG, { colspan: 4, cls: "cell-noborder cell-center" }),
    td("ผู้รับ", { cls: "cell-noborder cell-left" }),
    gap(1), gap(1),
    td(SIG_NAME_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1),
  ], 20));
  // r+6: gap | B:E (name) | F,G,H gap | I:L วันที่ | M gap
  tbody.appendChild(tr("row-h20", [
    gap(1),
    td(SIG_NAME_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1), gap(1), gap(1),
    td(SIG_DATE_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1),
  ], 20));
  // r+7: gap | B:E วันที่ | F:M gap
  tbody.appendChild(tr("row-h20", [
    gap(1),
    td(SIG_DATE_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(8),
  ], 20));
  // r+8: A:M "< n >"
  tbody.appendChild(tr("row-h23", [
    td(`&lt; ${step.page_no} &gt;`, { colspan: 13, cls: "cell-noborder cell-center" }),
  ], 23));
}
