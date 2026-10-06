// A4 print sheet — reproduces the original xlsx layout (spec §4, phase 2 spec §4.4).
// One <table> (13 cols, A..M) per form step, each step = one A4 page (scale s=0.73 fixed via --print-scale, so every
// page uses the same font size; the worst case 24 items + 2 section rows fits). ALL steps of the form are rendered, numbered
// "< n >" by step order; the toolbar's checkboxes choose which pages PRINT (unchecked = display:none under @media print).
// No draft watermark: printing implies the request has been sent (the print button sends first when it has not).
import { getOrderedSteps, getItemRows } from "../data.js";
import { call, getAdminToken } from "../api.js";
import { formatMoney, formatInt, THAI_MONTHS, monthKeyToParts, beYear } from "../format.js";
import { esc, requestOf, isEditable, statusText, bangkokDateParts, monthLabel, alertDialog, formForRequest } from "./common.js";
import { trySend } from "./send.js";

const COL_WIDTHS_PT = [40, 43.5, 47.8, 47.8, 47.8, 47.8, 47.8, 40, 47.8, 43.5, 47.8, 43.5, 55.7];

const SIG_DOTS_LONG = "………………………………………..……………..";
const SIG_NAME_LINE = "( .......................................................... )";
const SIG_DATE_LINE = "วันที่ .......... / .......... / ..........";

function fillOrDots(dots, value, fill) {
  if (!fill || value == null || value === "") return esc(dots);
  return `<span class="fill-slot" style="min-width:${(dots.length * 0.15).toFixed(1)}em">${esc(String(value))}</span>`;
}

function blankRequestFor(pcu, month) {
  return { pcu, month, status: "not_started", submitter_name: "", lines: {}, submitted_at: null, edited_after_submit: false };
}

const PREVIEW_KEY = "pcuSupply2:formPreview";

export async function renderPrint(container, app, params) {
  const asAdmin = params && params.get("as") === "admin";
  const isPreview = asAdmin && params.get("preview") === "1";
  let month, pcu, form, hidden, request;

  if (isPreview) {
    // 2d form editor preview: the admin page stores the draft form in sessionStorage and opens this route.
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem(PREVIEW_KEY) || "null"); } catch (e) { stored = null; }
    if (!stored || !stored.form || !Array.isArray(stored.form.steps)) {
      container.innerHTML = '<div class="notice notice-error">ไม่พบฟอร์มตัวอย่าง — เปิดจากปุ่ม "ตัวอย่างใบพิมพ์" ในหน้าผู้ดูแลระบบ</div>';
      return;
    }
    form = stored.form;
    month = stored.month || (app.boot && app.boot.rounds ? app.boot.rounds[0].month : new Date().toISOString().slice(0, 7));
    pcu = { code: "", name: "(ตัวอย่าง)", print_name: stored.print_name || "(ตัวอย่าง)", group: "" };
    request = blankRequestFor("", month);
    hidden = [];
  } else if (asAdmin) {
    // Admin reprint (linked from the admin page): adminGetRequest also returns the form version bound to the request.
    const adminToken = getAdminToken();
    const pcuParam = params.get("pcu");
    month = params.get("month");
    if (!adminToken) {
      container.innerHTML = '<div class="notice notice-error">ต้องเข้าสู่ระบบผู้ดูแล</div>';
      return;
    }
    let data;
    try {
      data = await call("adminGetRequest", { pcu: pcuParam, month }, { token: adminToken });
    } catch (err) {
      container.innerHTML = `<div class="notice notice-error">โหลดใบเบิกไม่สำเร็จ: ${esc(err.message)}</div>`;
      return;
    }
    pcu = data.pcu;
    form = data.form;
    request = data.request || blankRequestFor(pcuParam, month);
    hidden = data.hidden || [];
  } else {
    month = (params && params.get("month")) || app.monthKey;
    pcu = app.boot.pcu;
    request = requestOf(app, month) || blankRequestFor(pcu.code, month);
    // 2d: a sent request prints with the form version it was sent with; drafts print with the latest form.
    form = formForRequest(app, request);
    hidden = app.boot.hidden || [];
  }

  const steps = getOrderedSteps(form).filter((s) => s.active !== false); // 2d: closed pages are not printed
  const wrap = document.createElement("div");
  wrap.className = "print-wrap";

  const controls = document.createElement("div");
  controls.className = "print-controls no-print";
  controls.innerHTML = `
    <h2>ใบเบิก ${esc(monthLabel(month))}${asAdmin ? ` — ${esc(pcu.print_name || pcu.name || "")}` : ""}</h2>
    <p class="muted" id="print-status"></p>
    <p class="muted">เลือกหน้าที่จะพิมพ์ (ค่าเริ่มต้น = ครบทุกหน้า)</p>
    <div class="print-step-checks">
      ${steps.map((step, i) => `<label><input type="checkbox" class="print-step-chk" value="${esc(step.code)}" checked> หน้า ${i + 1} · ${esc(step.sheet || step.title)}</label>`).join("")}
    </div>
    <div class="print-actions">
      <button type="button" class="btn btn-primary" id="btn-do-print">พิมพ์</button>
      <button type="button" class="btn btn-secondary" id="btn-print-back">กลับ</button>
      <!-- 2b: "ดาวน์โหลด PDF" button goes here (requestPdf{pcu,month}; always all pages, spec §4.4). Not in 2a. -->
    </div>`;
  wrap.appendChild(controls);

  const pagesHost = document.createElement("div");
  pagesHost.id = "print-pages";
  wrap.appendChild(pagesHost);

  container.innerHTML = "";
  container.appendChild(wrap);

  const editable = !asAdmin && isEditable(app, month);
  if (isPreview) {
    steps.forEach((step, i) => {
      const page = buildPrintPage(step, request, pcu, hidden, month, i + 1);
      page.dataset.step = step.code;
      pagesHost.appendChild(page);
    });
    document.getElementById("print-status").textContent = `ตัวอย่างใบพิมพ์จากฟอร์มที่กำลังแก้ (ยังไม่บันทึก) — ${steps.length} หน้า`;
    controls.querySelectorAll(".print-step-chk").forEach((chk) =>
      chk.addEventListener("change", () => {
        const page = pagesHost.querySelector(`.print-page[data-step="${chk.value}"]`);
        if (page) page.classList.toggle("print-skip", !chk.checked);
      })
    );
    document.getElementById("btn-do-print").addEventListener("click", () => window.print());
    document.getElementById("btn-print-back").addEventListener("click", () => window.close());
    return;
  }

  function needsSend() {
    return editable && (!(request.status === "submitted" || request.status === "issued") || !!request.edited_after_submit);
  }

  function renderStatus() {
    const el = document.getElementById("print-status");
    if (asAdmin) el.textContent = request.status === "not_started" ? "ยังไม่มีใบเบิก (ดูในฐานะผู้ดูแล)" : `สถานะ: ${statusText(request)} (ดูในฐานะผู้ดูแล)`;
    else if (request.status === "not_started" || request.status === "draft") el.textContent = editable ? "ยังไม่ได้ส่งใบเบิก — กดปุ่ม พิมพ์ จะส่งใบเบิกแล้วพิมพ์" : "ไม่ได้ส่งใบเบิกในรอบนี้";
    else el.textContent = `สถานะ: ${statusText(request)}${needsSend() ? " — กดปุ่ม พิมพ์ จะส่งใหม่ก่อนพิมพ์" : ""}`;
  }

  function renderPages() {
    const unchecked = new Set(Array.from(document.querySelectorAll(".print-step-chk:not(:checked)")).map((c) => c.value));
    pagesHost.innerHTML = "";
    steps.forEach((step, i) => {
      const page = buildPrintPage(step, request, pcu, hidden, month, i + 1);
      page.dataset.step = step.code;
      if (unchecked.has(step.code)) page.classList.add("print-skip");
      pagesHost.appendChild(page);
    });
    renderStatus();
  }
  renderPages();

  controls.querySelectorAll(".print-step-chk").forEach((chk) =>
    chk.addEventListener("change", () => {
      const page = pagesHost.querySelector(`.print-page[data-step="${chk.value}"]`);
      if (page) page.classList.toggle("print-skip", !chk.checked);
    })
  );

  const printBtn = document.getElementById("btn-do-print");
  printBtn.addEventListener("click", async () => {
    if (!controls.querySelector(".print-step-chk:checked")) {
      await alertDialog("เลือกหน้าที่จะพิมพ์", "<p>เลือกอย่างน้อย 1 หน้า</p>");
      return;
    }
    if (needsSend()) {
      printBtn.disabled = true;
      let ok = false;
      try {
        ok = await trySend(app, month);
      } finally {
        printBtn.disabled = false;
      }
      if (!ok) return;
      request = requestOf(app, month) || request;
      renderPages();
    }
    window.print();
  });

  document.getElementById("btn-print-back").addEventListener("click", () => {
    if (asAdmin) {
      if (history.length > 1) history.back(); else window.close();
    } else {
      location.hash = editable ? `#/fill/summary?month=${month}` : "#/home";
    }
  });
}

function buildPrintPage(step, request, pcu, hidden, monthKey, pageNumber) {
  const page = document.createElement("div");
  page.className = "print-page";

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
  tbody.appendChild(rowDate(request));
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

// "วันที่" = the day the request was last sent (Asia/Bangkok); dotted until it has been sent.
function rowDate(request) {
  let dayVal = null, monthVal = null, yearVal = null;
  if (request.submitted_at) {
    const parts = bangkokDateParts(request.submitted_at);
    dayVal = parts.day; monthVal = parts.monthName; yearVal = parts.beYear;
  }
  const text = `วันที่ ${fillOrDots("...........", dayVal, true)} /${fillOrDots(".................", monthVal, true)}/${fillOrDots("............", yearVal, true)}`;
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
    if (row.active === false && op + pp === 0) return; // inactive items are not on the sheet (unless they still carry a quantity)
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
