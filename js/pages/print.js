// A4 print sheet — reproduces the original xlsx layout (spec §4, phase 1.5 §3.5).
// One <table> (13 cols, A..M) per step, fixed scale s=0.73 applied via the --print-scale CSS
// custom property so every page uses the same font size. All 7 steps ticked by default; every
// page prints every row (blank cells when nothing requested, incl. hidden items) — spec F1/Q61.
import { FORM_STEPS } from "../constants.js";
import { getStep, getItemRows, loadFormData } from "../data.js";
import { call, getAdminToken } from "../api.js";
import * as sync from "../sync.js";
import { formatMoney, formatInt, formatThaiDateParts, THAI_MONTHS, monthKeyToParts, beYear } from "../format.js";

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

export async function renderPrint(container, app, params) {
  const asAdmin = params && params.get("as") === "admin";
  const form = app.form || (app.form = await loadFormData());

  let month, pcu, request, hidden;

  if (asAdmin) {
    const adminToken = getAdminToken();
    const pcuCode = params.get("pcu");
    month = params.get("month");
    if (!adminToken) {
      container.innerHTML = '<div class="notice notice-error">ต้องเข้าสู่ระบบผู้ดูแล</div>';
      return;
    }
    let data;
    try {
      data = await call("adminGetRequest", { pcu: pcuCode, month }, { token: adminToken });
    } catch (err) {
      container.innerHTML = `<div class="notice notice-error">โหลดใบเบิกไม่สำเร็จ: ${esc(err.message)}</div>`;
      return;
    }
    pcu = data.pcu;
    request = data.request || blankRequestFor(pcuCode, month);
    hidden = data.hidden || [];
  } else {
    month = (params && params.get("month")) || app.monthKey;
    pcu = app.boot.pcu;
    const session = sync.getSession(pcu.code, month);
    request = session ? session.request : blankRequestFor(pcu.code, month);
    hidden = app.boot.hidden || [];
  }

  const isDraft = request.status !== "submitted" && request.status !== "received";

  const wrap = document.createElement("div");
  wrap.className = "print-wrap";

  const controls = document.createElement("div");
  controls.className = "print-controls no-print";
  controls.innerHTML = `
    <h2>ตัวอย่างใบพิมพ์</h2>
    <p class="muted">${isDraft ? "ยังไม่ส่งใบเบิก — ตัวอย่างนี้มีลายน้ำ “แบบร่าง – ยังไม่สมบูรณ์”" : "ใบเบิกฉบับสมบูรณ์ พร้อมพิมพ์"}</p>
    <div class="print-step-checks">
      ${FORM_STEPS.map((code) => {
        const step = getStep(form, code);
        return `<label><input type="checkbox" class="print-step-chk" value="${code}" checked> ${esc(step.title)} (${esc(code)})</label>`;
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
    const checkedCodes = FORM_STEPS.filter((code) =>
      Array.from(document.querySelectorAll(".print-step-chk:checked")).some((c) => c.value === code)
    );
    pagesHost.innerHTML = "";
    checkedCodes.forEach((code, i) => {
      const step = getStep(form, code);
      pagesHost.appendChild(buildPrintPage(step, request, pcu, hidden, isDraft, month, i + 1));
    });
  }
  renderPages();

  document.querySelectorAll(".print-step-chk").forEach((chk) => chk.addEventListener("change", renderPages));
  document.getElementById("btn-do-print").addEventListener("click", () => window.print());
}

function blankRequestFor(pcuCode, month) {
  return { pcu: pcuCode, month, status: "not_started", return_reason: "", submitter_name: "", lines: {}, submitted_at: "" };
}

function buildPrintPage(step, request, pcu, hidden, isDraft, monthKey, pageNumber) {
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
  tbody.appendChild(rowMonthYear(monthKey));
  appendTableHeader(tbody);
  appendBodyRows(tbody, step, request, hidden);
  appendTotalRow(tbody, step, request, hidden);
  tbody.appendChild(rowBlank());
  appendSignatureBlock(tbody, step, pageNumber);

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

function appendBodyRows(tbody, step, request, hidden) {
  const hiddenSet = new Set(hidden || []);
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
    const isHidden = hiddenSet.has(row.code);
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

function appendTotalRow(tbody, step, request, hidden) {
  const hiddenSet = new Set(hidden || []);
  let op = 0, pp = 0, money = 0;
  getItemRows(step).forEach((item) => {
    if (hiddenSet.has(item.code)) return;
    const line = (request.lines && request.lines[item.code]) || {};
    const o = Number(line.op) || 0, p = Number(line.pp) || 0;
    op += o; pp += p; money += (o + p) * item.price;
  });
  const qty = op + pp;
  tbody.appendChild(tr("row-h21", [
    td("<strong>รวม</strong>", { colspan: 9, cls: "cell-border cell-center" }),
    td(qty ? `<strong>${formatInt(op)}</strong>` : "", { cls: "cell-border cell-center" }),
    td(qty ? `<strong>${formatInt(pp)}</strong>` : "", { cls: "cell-border cell-center" }),
    td(qty ? `<strong>${formatInt(qty)}</strong>` : "", { cls: "cell-border cell-center" }),
    td(qty ? `<strong>${formatMoney(money)}</strong>` : "", { cls: "cell-border cell-right" }),
  ], 21));
}

function gap(n) {
  return td("", { colspan: n, cls: "cell-noborder" });
}

// Column index reference: A0 B1 C2 D3 E4 F5 G6 H7 I8 J9 K10 L11 M12 (13 total).
// Every row below must sum its colspans to exactly 13.
function appendSignatureBlock(tbody, step, pageNumber) {
  tbody.appendChild(tr("row-h20", [
    td("ลงชื่อ", { cls: "cell-noborder cell-right" }),
    td(SIG_DOTS_LONG, { colspan: 4, cls: "cell-noborder cell-center" }),
    td("ผู้เบิก", { cls: "cell-noborder cell-left" }),
    gap(1),
    td("ลงชื่อ", { cls: "cell-noborder cell-right" }),
    td(SIG_DOTS_LONG, { colspan: 4, cls: "cell-noborder cell-center" }),
    td("ผู้จ่าย", { cls: "cell-noborder cell-left" }),
  ], 20));
  tbody.appendChild(tr("row-h20", [
    gap(1),
    td(SIG_NAME_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1), gap(1), gap(1),
    td(SIG_NAME_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1),
  ], 20));
  tbody.appendChild(tr("row-h20", [
    gap(8),
    td(SIG_DATE_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1),
  ], 20));
  tbody.appendChild(tr("row-h20", [
    td("ข้าพเจ้าได้รับของตามจำนวนและรายการที่จ่ายเรียบร้อยแล้ว", { colspan: 6, cls: "cell-noborder cell-center" }),
    gap(7),
  ], 20));
  tbody.appendChild(tr("row-h20", [
    gap(7),
    td("ลงชื่อ", { cls: "cell-noborder cell-right" }),
    td(SIG_DOTS_LONG, { colspan: 4, cls: "cell-noborder cell-center" }),
    td("ผู้อนุมัติ", { cls: "cell-noborder cell-left" }),
  ], 20));
  tbody.appendChild(tr("row-h20", [
    td("ลงชื่อ", { cls: "cell-noborder cell-right" }),
    td(SIG_DOTS_LONG, { colspan: 4, cls: "cell-noborder cell-center" }),
    td("ผู้รับ", { cls: "cell-noborder cell-left" }),
    gap(1), gap(1),
    td(SIG_NAME_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1),
  ], 20));
  tbody.appendChild(tr("row-h20", [
    gap(1),
    td(SIG_NAME_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1), gap(1), gap(1),
    td(SIG_DATE_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(1),
  ], 20));
  tbody.appendChild(tr("row-h20", [
    gap(1),
    td(SIG_DATE_LINE, { colspan: 4, cls: "cell-noborder cell-center" }),
    gap(8),
  ], 20));
  tbody.appendChild(tr("row-h23", [
    td(`&lt; ${pageNumber} &gt;`, { colspan: 13, cls: "cell-noborder cell-center" }),
  ], 23));
}
