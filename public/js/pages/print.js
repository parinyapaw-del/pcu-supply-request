// A4 print sheet — reproduces the original xlsx layout (spec §4, phase 2 spec §4.4).
// One <table> (13 cols, A..M) per form step, each step = one A4 page (fixed scale --print-scale 0.78, so every page uses the
// same font size; the worst case 24 items + 2 section rows fits). ALL steps of the form are rendered, numbered "< n >" by
// step order; the toolbar's checkboxes choose which pages PRINT (unchecked = display:none under @media print).
// Every length is a multiple of --pu (1 xlsx point at the fixed scale — see css/print.css header); fitPrintPages() is the
// safety net for a sheet that still ends up too tall.
// Print paths (one engine, Blink, for every platform — see printMode()): Chromium desktop prints straight from the browser
// ("direct"); every other browser opens the server PDF (requestPdf → Browser Rendering) and prints that file ("pdf").
// Browser print in a non-Chromium browser (browserPrintFallback) is only the fallback when the PDF cannot be produced, and
// is the only place the compact (0.58) layout is switched on, so the on-screen preview always shows the real 0.78 sheet.
// No draft watermark: printing implies the request has been sent (the print button sends first when it has not).
import { getOrderedSteps, getItemRows } from "../data.js";
import { call, getAdminToken, getPcuToken } from "../api.js";
import { formatMoney, formatInt, THAI_MONTHS, monthKeyToParts, beYear } from "../format.js";
import { esc, requestOf, isEditable, statusText, monthLabel, roundTitle, roundOf, isTrialMonth, alertDialog, confirmDialog, formForRequest, requesterOf } from "./common.js";
import { trySend } from "./send.js";
import { requestPdfReady, startPdfDownload, openPdfInline, pdfErrorHtml } from "../pdf_client.js";

const COL_WIDTHS_PT = [40, 43.5, 47.8, 47.8, 47.8, 47.8, 47.8, 40, 47.8, 43.5, 47.8, 43.5, 55.7];

const SIG_DOTS_LONG = "………………………………………..……………..";
const SIG_NAME_LINE = "( .......................................................... )";
const SIG_DATE_LINE = "วันที่ .......... / .......... / ..........";
const SIG_PHONE_LINE = "โทร : ….....................................................................................";

// 2x (Q4/R6): the header has no dotted leaders — an empty slot is blank space of the same width, a filled one is plain text.
function headerSlot(value, widthEm) {
  const v = value == null || value === "" ? "&nbsp;" : esc(String(value));
  return `<span class="blank-slot" style="min-width:${widthEm.toFixed(1)}em">${v}</span>`;
}

// Steps that are printed: all of them in order, except steps switched off (`active === false`, form editor 2d) — a closed step is still printed
// when the request carries a quantity on it (2t: requests follow the latest form of their fy, so a page may close after the request was sent).
function printableSteps(form, request) {
  const lines = (request && request.lines) || {};
  const hasQty = (s) => (s.rows || []).some((r) => r.type === "item" && lines[r.code] && (Number(lines[r.code].op) || 0) + (Number(lines[r.code].pp) || 0) > 0);
  return getOrderedSteps(form).filter((s) => s.active !== false || hasQty(s));
}

function blankRequestFor(pcu, month) {
  return { pcu, month, status: "not_started", submitter_name: "", lines: {}, submitted_at: null, edited_after_submit: false };
}

const PREVIEW_KEY = "pcuSupply2:formPreview";

// 2h: per-print header options chosen on the print page: the sheet's "วันที่" (free date) and "ประจำเดือน" (the round month);
// null = blank for handwriting. Not stored on the request. 2x: + phone (the "โทร" line, per print) and requester_name (who the
// request prints for — set by the admin, frozen at send; not a user option, carried here so every page builder gets it).
function normPrintOpts(opts) {
  return {
    doc_date: (opts && opts.doc_date) || null, supply_month: (opts && opts.supply_month) || null,
    phone: (opts && opts.phone) || null, requester_name: (opts && opts.requester_name) || null,
  };
}
const PHONE_RE = /^[0-9+\- ]{0,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const printOptsKey = (pcuCode, month) => `pcuSupply2:printOpts:${pcuCode}:${month}`;

/** How this browser prints: "direct" = a desktop Chromium browser (Chrome/Edge on Windows/Mac/Linux) prints the page itself
 *  with Blink at the real 0.78 layout; "pdf" = everything else (Safari, iOS, Android, Firefox — no userAgentData or a mobile /
 *  non-Chromium one) prints the server-rendered PDF so the same Blink engine produces the paper. */
export function printMode() {
  const uad = typeof navigator !== "undefined" ? navigator.userAgentData : null;
  return uad && uad.mobile === false && uad.brands.some((b) => /chromium/i.test(b.brand)) ? "direct" : "pdf";
}

/** Browser print without the PDF: switches the compact (0.58) layout on for every non-"direct" browser — its page box is
 *  shorter than A4 (iOS printable rect + header/footer band, see css/print.css) — then opens the print dialog. The compact
 *  class is added only here, never at page load, so the preview on screen is always the real layout. */
function browserPrintFallback() {
  document.documentElement.classList.toggle("print-compact", printMode() !== "direct");
  window.print();
}

// 2p: a copy of `form` whose item rows carry priceOf(row) as price.
function withPrices(form, priceOf) {
  if (!form || !Array.isArray(form.steps)) return form;
  return { ...form, steps: form.steps.map((st) => ({ ...st, rows: (st.rows || []).map((r) => (r.type === "item" ? { ...r, price: Number(priceOf(r)) || 0 } : r)) })) };
}

export async function renderPrint(container, app, params) {
  const asAdmin = params && params.get("as") === "admin";
  const isPreview = asAdmin && params.get("preview") === "1";
  let month, pcu, form, hidden, request, requester = null;
  let printOpts = normPrintOpts(null); // 2h: the 2d preview keeps these blank (no controls)

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
    request = data.request || blankRequestFor(pcuParam, month);
    requester = data.requester_name || null; // 2x
    // 2p: print the price the sheet was sent with (price_print), like the server PDF
    const ls = request.lines || {};
    form = withPrices(data.form, (r) => (ls[r.code] && (ls[r.code].price_print ?? ls[r.code].price_snapshot)) ?? r.price);
    hidden = data.hidden || [];
  } else {
    month = (params && params.get("month")) || app.monthKey;
    pcu = app.boot.pcu;
    request = requestOf(app, month) || blankRequestFor(pcu.code, month);
    // 2d: a sent request prints with the form version it was sent with; drafts print with the latest form.
    const rp = (app.boot.prices && app.boot.prices[month]) || {}; // 2p: price of this round
    form = withPrices(formForRequest(app, request), (r) => rp[r.code] ?? r.price);
    hidden = app.boot.hidden || [];
    requester = requesterOf(pcu, request); // 2x
  }

  const steps = printableSteps(form, request);
  const thisRound = !asAdmin && !isPreview && app.boot ? roundOf(app, month) : null;
  const trialRound = !!(thisRound && thisRound.trial) || (!asAdmin && !isPreview && isTrialMonth(app, month));
  const sentReq = request.status === "submitted" || request.status === "issued"; // 2x R7: the admin may rename a sent request
  const wrap = document.createElement("div");
  wrap.className = "print-wrap";

  const controls = document.createElement("div");
  controls.className = "print-controls no-print";
  controls.innerHTML = `
    <h2>ใบเบิก ${esc(roundTitle(month, trialRound))}${asAdmin ? ` — ${esc(pcu.print_name || pcu.name || "")}` : ""}</h2>
    <p class="muted" id="print-status"></p>
    <p class="muted">เลือกหน้าที่จะพิมพ์ (ค่าเริ่มต้น = ครบทุกหน้า)</p>
    <div class="print-step-checks">
      ${steps.map((step, i) => `<label><input type="checkbox" class="print-step-chk" value="${esc(step.code)}" checked> หน้า ${i + 1} · ${esc(step.sheet || step.title)}</label>`).join("")}
    </div>
    ${isPreview ? "" : `<div class="print-options">
      <label>ลงวันที่เอกสาร <input type="date" id="print-doc-date"></label>
      <label>เบิกประจำเดือน <select id="print-supply-month"><option value="">เว้นว่าง</option>${trialRound ? "" : `<option value="${esc(month)}">${esc(monthLabel(month))}</option>`}</select></label>
      <span class="muted">เว้นว่าง = เว้นที่ว่างให้เขียนเอง</span>
    </div>
    <div class="print-options">
      <label>โทร <input type="tel" id="print-phone" maxlength="30" inputmode="tel" autocomplete="tel" placeholder="เว้นว่าง = จุดให้เขียนเอง"></label>
      ${asAdmin ? "" : `<label><input type="checkbox" id="print-phone-default"> จำเป็นค่าเริ่มต้น</label>`}
      <span class="muted" id="print-requester">ผู้เบิกในใบ: ${requester ? esc(requester) : "— (ยังไม่ได้ตั้ง · ผู้ดูแลระบบตั้งให้)"}</span>
    </div>
    ${asAdmin && sentReq ? `<div class="print-options">
      <label>แก้ชื่อผู้เบิกในใบนี้ <input type="text" id="print-requester-input" maxlength="80" value="${esc(requester || "")}"></label>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-set-requester">บันทึกชื่อในใบนี้</button>
      <span class="muted">มีผลเฉพาะใบนี้ · ชื่อตั้งต้นของ รพ.สต. แก้ที่แท็บ รพ.สต.</span>
    </div>` : ""}`}
    <div class="print-actions">
      <button type="button" class="btn btn-primary" id="btn-do-print">พิมพ์</button>
      <button type="button" class="btn btn-secondary" id="btn-do-pdf">ดาวน์โหลด PDF</button>
      <button type="button" class="btn btn-secondary" id="btn-print-back">กลับ</button>
    </div>`;
  wrap.appendChild(controls);

  const pagesHost = document.createElement("div");
  pagesHost.id = "print-pages";
  wrap.appendChild(pagesHost);

  container.innerHTML = "";
  container.appendChild(wrap);
  window.addEventListener("beforeprint", () => fitPrintPages(pagesHost));

  const editable = !asAdmin && isEditable(app, month);
  if (isPreview) {
    steps.forEach((step, i) => {
      const page = buildPrintPage(step, request, pcu, hidden, month, i + 1, printOpts);
      page.dataset.step = step.code;
      pagesHost.appendChild(page);
    });
    fitWhenReady(pagesHost);
    document.getElementById("print-status").textContent = `ตัวอย่างใบพิมพ์จากฟอร์มที่กำลังแก้ (ยังไม่บันทึก) — ${steps.length} หน้า`;
    controls.querySelectorAll(".print-step-chk").forEach((chk) =>
      chk.addEventListener("change", () => {
        const page = pagesHost.querySelector(`.print-page[data-step="${chk.value}"]`);
        if (page) page.classList.toggle("print-skip", !chk.checked);
      })
    );
    const pdfBtn = document.getElementById("btn-do-pdf");
    if (pdfBtn) pdfBtn.style.display = "none"; // no PDF for an unsaved draft form
    document.getElementById("btn-do-print").addEventListener("click", browserPrintFallback); // no PDF for an unsaved form
    document.getElementById("btn-print-back").addEventListener("click", () => window.close());
    return;
  }

  const PDF_MODE_NOTE = " · อุปกรณ์นี้พิมพ์ผ่านไฟล์ PDF (ครบทุกหน้า): กดพิมพ์ → เปิดไฟล์ → สั่งพิมพ์จากไฟล์";

  function needsSend() {
    return editable && (!(request.status === "submitted" || request.status === "issued") || !!request.edited_after_submit);
  }

  function renderStatus() {
    const el = document.getElementById("print-status");
    if (asAdmin) el.textContent = request.status === "not_started" ? "ยังไม่มีใบเบิก (ดูในฐานะผู้ดูแล)" : `สถานะ: ${statusText(request)} (ดูในฐานะผู้ดูแล)`;
    else if (request.status === "not_started" || request.status === "draft") el.textContent = editable ? "ยังไม่ได้ส่งใบเบิก — กดปุ่ม พิมพ์ จะส่งใบเบิกแล้วพิมพ์" : "ไม่ได้ส่งใบเบิกในรอบนี้";
    else el.textContent = `สถานะ: ${statusText(request)}${needsSend() ? " — กดปุ่ม พิมพ์ จะส่งใหม่ก่อนพิมพ์" : ""}`;
    if (printMode() === "pdf") el.textContent += PDF_MODE_NOTE;
  }

  function renderPages() {
    const unchecked = new Set(Array.from(document.querySelectorAll(".print-step-chk:not(:checked)")).map((c) => c.value));
    pagesHost.innerHTML = "";
    steps.forEach((step, i) => {
      const page = buildPrintPage(step, request, pcu, hidden, month, i + 1, printOpts);
      page.dataset.step = step.code;
      if (unchecked.has(step.code)) page.classList.add("print-skip");
      pagesHost.appendChild(page);
    });
    fitWhenReady(pagesHost);
    renderStatus();
  }

  // 2h: restore the options last used for this PCU + round (a stale value is dropped), reflect them into the controls.
  // 2x: phone = the remembered one (same key), else the pcu's default (pcu.phone, set by the pcu or the admin).
  const docDateInput = document.getElementById("print-doc-date");
  const supplySelect = document.getElementById("print-supply-month");
  const phoneInput = document.getElementById("print-phone");
  const phoneDefault = document.getElementById("print-phone-default");
  const optsKey = printOptsKey(pcu.code, month);
  let savedPhone;
  try {
    const saved = JSON.parse(localStorage.getItem(optsKey) || "null");
    if (saved && typeof saved === "object") {
      printOpts = normPrintOpts({
        doc_date: typeof saved.doc_date === "string" && DATE_RE.test(saved.doc_date) ? saved.doc_date : null,
        supply_month: saved.supply_month === month ? saved.supply_month : null,
      });
      if (typeof saved.phone === "string" && PHONE_RE.test(saved.phone)) savedPhone = saved.phone;
    }
  } catch (e) { /* storage unavailable or corrupt: start blank */ }
  printOpts = normPrintOpts({ ...printOpts, phone: savedPhone !== undefined ? savedPhone : pcu.phone || null, requester_name: requester });
  docDateInput.value = printOpts.doc_date || "";
  supplySelect.value = printOpts.supply_month || "";
  phoneInput.value = printOpts.phone || "";

  function onPrintOptsChange() {
    const ph = phoneInput.value.trim();
    phoneInput.setCustomValidity(PHONE_RE.test(ph) ? "" : "ใช้ได้เฉพาะตัวเลข + - และช่องว่าง");
    printOpts = normPrintOpts({ doc_date: docDateInput.value, supply_month: supplySelect.value, phone: PHONE_RE.test(ph) ? ph : printOpts.phone, requester_name: requester });
    const { requester_name, ...remember } = printOpts;
    try { localStorage.setItem(optsKey, JSON.stringify({ ...remember, phone: printOpts.phone || "" })); } catch (e) { /* storage unavailable */ }
    renderPages();
  }
  docDateInput.addEventListener("change", onPrintOptsChange);
  supplySelect.addEventListener("change", onPrintOptsChange);
  phoneInput.addEventListener("change", onPrintOptsChange);
  // 2x R7: admin overrides the requester name of this sent request (adminSetRequestRequester; admin only — a dispenser gets FORBIDDEN)
  const reqBtn = document.getElementById("btn-set-requester");
  if (reqBtn) {
    reqBtn.addEventListener("click", async () => {
      const name = document.getElementById("print-requester-input").value.trim();
      if (!name) { await alertDialog("แก้ชื่อผู้เบิก", "<p>กรอกชื่อผู้เบิก</p>"); return; }
      reqBtn.disabled = true;
      try {
        const r = await call("adminSetRequestRequester", { pcu: pcu.code, month, name }, { token: getAdminToken() });
        requester = r.requester_name; printOpts.requester_name = requester;
        document.getElementById("print-requester").textContent = "ผู้เบิกในใบ: " + requester;
        renderPages();
      } catch (e) {
        await alertDialog("แก้ชื่อผู้เบิกไม่สำเร็จ", `<p>${esc((e && e.message) || "ลองใหม่อีกครั้ง")}</p>`);
      } finally { reqBtn.disabled = false; }
    });
  }
  // R8 "จำเป็นค่าเริ่มต้น": the pcu stores the number on screen as its default (pcuSetPhone); the admin sets defaults in the รพ.สต. tab
  if (phoneDefault) {
    phoneDefault.addEventListener("change", async () => {
      if (!phoneDefault.checked) return;
      onPrintOptsChange();
      try {
        const r = await call("pcuSetPhone", { phone: printOpts.phone || "" }, { token: getPcuToken() });
        pcu.phone = r.phone;
        if (app.boot && app.boot.pcu) app.boot.pcu.phone = r.phone;
      } catch (e) {
        phoneDefault.checked = false;
        await alertDialog("บันทึกเบอร์ไม่สำเร็จ", `<p>${esc((e && e.message) || "ลองใหม่อีกครั้ง")}</p>`);
      }
    });
    phoneInput.addEventListener("input", () => { phoneDefault.checked = false; });
  }

  renderPages();

  controls.querySelectorAll(".print-step-chk").forEach((chk) =>
    chk.addEventListener("change", () => {
      const page = pagesHost.querySelector(`.print-page[data-step="${chk.value}"]`);
      if (page) page.classList.toggle("print-skip", !chk.checked);
    })
  );

  const printBtn = document.getElementById("btn-do-print");
  const pdfBtn = document.getElementById("btn-do-pdf");
  // 2h: read printOpts at call time so a click always uses the options currently on screen
  const pdfParams = () => {
    const p = asAdmin ? { pcu: pcu.code, month } : { month };
    if (printOpts.doc_date) p.doc_date = printOpts.doc_date;
    if (printOpts.supply_month) p.supply_month = printOpts.supply_month;
    if (printOpts.phone) p.phone = printOpts.phone; // 2x
    return [asAdmin ? "adminRequestPdf" : "requestPdf", p];
  };
  const tokenNow = () => asAdmin ? getAdminToken() : getPcuToken();

  printBtn.addEventListener("click", async () => {
    if (!controls.querySelector(".print-step-chk:checked")) {
      await alertDialog("เลือกหน้าที่จะพิมพ์", "<p>เลือกอย่างน้อย 1 หน้า</p>");
      return;
    }
    const mode = printMode();
    printBtn.disabled = true;
    if (mode === "pdf") pdfBtn.disabled = true;
    try {
      if (needsSend()) {
        if (!(await trySend(app, month))) return;
        request = requestOf(app, month) || request;
        requester = requesterOf(pcu, request); printOpts.requester_name = requester; // 2x: frozen at send
        renderPages();
      }
      if (mode === "direct") {
        // desktop Chromium: Blink prints this page itself at the real 0.78 layout (no compact class)
        printBtn.disabled = false;
        window.print();
        return;
      }
      // every other browser: print the server PDF (same Blink engine); the file opens in this tab, then the user prints it
      const statusEl = document.getElementById("print-status");
      const token = tokenNow();
      const [action, params] = pdfParams();
      let ready;
      try {
        statusEl.textContent = "กำลังสร้าง PDF…";
        ready = await requestPdfReady(action, params, token, { onWait: (n) => { statusEl.textContent = `กำลังสร้าง PDF… (รอ ${n} วิ)`; } });
      } catch (e) {
        renderStatus();
        const msg = (e && e.message) || "สร้าง PDF ไม่สำเร็จ";
        const useBrowser = await confirmDialog(
          "สร้าง PDF ไม่สำเร็จ",
          `<p>${esc(msg)}</p><p class="muted">พิมพ์ผ่าน browser แทนได้ แต่ตัวอักษรบนกระดาษจะเล็กลงกว่าไฟล์ PDF</p>`,
          "พิมพ์ผ่าน browser แทน",
          "ยกเลิก"
        );
        if (useBrowser) browserPrintFallback();
        return;
      }
      renderStatus();
      openPdfInline(ready.url, token);
    } finally {
      printBtn.disabled = false;
      pdfBtn.disabled = false;
    }
  });

  // PDF = always all pages, rendered on the server from the same sheet (print.html). Sends the request first when needed.
  pdfBtn.addEventListener("click", async () => {
    const statusEl = document.getElementById("print-status");
    pdfBtn.disabled = true;
    printBtn.disabled = true;
    try {
      if (needsSend()) {
        if (!(await trySend(app, month))) return;
        request = requestOf(app, month) || request;
        requester = requesterOf(pcu, request); printOpts.requester_name = requester; // 2x: frozen at send
        renderPages();
      }
      const token = tokenNow();
      const [action, params] = pdfParams();
      statusEl.textContent = "กำลังสร้าง PDF…";
      const r = await requestPdfReady(action, params, token, { onWait: (n) => { statusEl.textContent = `กำลังสร้าง PDF… (รอ ${n} วิ)`; } });
      startPdfDownload(r.url, token);
      renderStatus();
      statusEl.textContent += ` — ดาวน์โหลดแล้ว: ${r.filename}`;
    } catch (e) {
      renderStatus();
      await alertDialog("ดาวน์โหลด PDF ไม่สำเร็จ", pdfErrorHtml(e && e.message, esc));
    } finally {
      pdfBtn.disabled = false;
      printBtn.disabled = false;
    }
  });

  document.getElementById("btn-print-back").addEventListener("click", () => {
    if (asAdmin) {
      if (history.length > 1) history.back(); else window.close();
    } else {
      location.hash = editable ? `#/fill/summary?month=${month}` : "#/home";
    }
  });
}

/** Renders every printable step of `form` as an A4 page into `host` (the print shell used for the server-side PDF). */
export function renderAllPages(host, form, request, pcu, hidden, month, opts = {}) {
  const printOpts = normPrintOpts(opts);
  host.innerHTML = "";
  printableSteps(form, request).forEach((step, i) => {
    const page = buildPrintPage(step, request, pcu, hidden, month, i + 1, printOpts);
    page.dataset.step = step.code;
    host.appendChild(page);
  });
  fitPrintPages(host);
}

export function buildPrintPage(step, request, pcu, hidden, monthKey, pageNumber, opts = {}) {
  const printOpts = normPrintOpts(opts);
  const page = document.createElement("div");
  page.className = "print-page";

  const table = document.createElement("table");
  table.className = "print-table";

  const colgroup = document.createElement("colgroup");
  COL_WIDTHS_PT.forEach((w) => {
    const col = document.createElement("col");
    col.style.width = `calc(${w} * var(--pu))`;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  const tbody = document.createElement("tbody");
  tbody.appendChild(rowTitle(step));
  tbody.appendChild(rowReceiptNo());
  tbody.appendChild(rowDate(printOpts));
  tbody.appendChild(rowLabelValue("เรื่อง", step.subject));
  tbody.appendChild(rowLabelValue("เรียน", step.to));
  tbody.appendChild(rowBlank());
  tbody.appendChild(rowIKhaphachao(pcu, printOpts.requester_name));
  tbody.appendChild(rowMonthYear(printOpts));
  appendTableHeader(tbody);
  appendBodyRows(tbody, step, request, hidden);
  appendTotalRow(tbody, step, request, hidden);
  tbody.appendChild(rowBlank());
  appendSignatureBlock(tbody, step, pageNumber, printOpts);

  table.appendChild(tbody);
  const sheet = document.createElement("div");
  sheet.className = "print-sheet";
  sheet.appendChild(table);
  page.appendChild(sheet);
  return page;
}

/** Scales down any sheet whose table is taller than the printable area (.print-sheet), so it never spills onto a second
 *  page. Sheet and table are both sized from the page width, so the ratio measured on screen holds on paper. Call after
 *  rendering and again once the fonts are loaded (row heights can change with the font). */
export function fitPrintPages(host) {
  host.querySelectorAll(".print-page").forEach((page) => {
    const sheet = page.querySelector(".print-sheet");
    const table = page.querySelector(".print-table");
    if (!sheet || !table) return;
    table.style.transform = "";
    const avail = sheet.clientHeight;
    const need = table.offsetHeight;
    if (avail > 0 && need > avail) table.style.transform = `scale(${(avail / need).toFixed(4)})`;
  });
}

function fitWhenReady(host) {
  fitPrintPages(host);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitPrintPages(host));
}

function tr(className, cells, heightPt) {
  const row = document.createElement("tr");
  if (className) row.className = className;
  if (heightPt) row.style.height = `calc(${heightPt} * var(--pu))`;
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
    td(`เลขที่ใบเบิก ${headerSlot(null, 2.1)}`, { colspan: 2, cls: "cell-noborder cell-left" }),
  ], 20);
}

// "วันที่" = the document date picked on the print page (opts.doc_date "YYYY-MM-DD"); blank when none is picked (2h, 2x no dots).
// It is no longer filled from the request's submitted_at.
function rowDate(opts) {
  let dayVal = null, monthVal = null, yearVal = null;
  const m = DATE_RE.test(opts.doc_date || "") ? opts.doc_date.split("-").map(Number) : null; // [y, mo, d]
  if (m) {
    dayVal = m[2]; monthVal = THAI_MONTHS[m[1] - 1] || null; yearVal = beYear(m[0]);
  }
  const text = `วันที่ ${headerSlot(dayVal, 1.7)} /${headerSlot(monthVal, 2.6)}/${headerSlot(yearVal, 1.8)}`;
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

function rowIKhaphachao(pcu, requester) {
  const printName = pcu ? pcu.print_name : "";
  // 2h: PCU14/PCU15 (group "พิเศษ") print the full print_name without the รพ.สต. prefix · 2x: the requester name after "ข้าพเจ้า"
  const special = !!pcu && pcu.group === "พิเศษ";
  const text = `ข้าพเจ้า ${headerSlot(requester, 9)} ผู้มีสิทธิเบิกวัสดุของ${special ? "" : "สถานพยาบาลโรงพยาบาลส่งเสริมสุขภาพตำบล"} ${headerSlot(printName, 3.9)}`;
  return tr("row-h20", [
    td("", { colspan: 1, cls: "cell-noborder" }),
    td(text, { colspan: 12, cls: "cell-noborder cell-left" }),
  ], 20);
}

// "ประจำเดือน … พ.ศ. …" = opts.supply_month ("YYYY-MM" = the round month itself, brief 2j); both slots blank when null.
function rowMonthYear(opts) {
  let monthName = null, be = null;
  if (opts.supply_month) {
    const { year, month } = monthKeyToParts(opts.supply_month);
    monthName = THAI_MONTHS[month - 1] || null;
    be = beYear(year);
  }
  const text = `มีความประสงค์จะขอเบิกวัสดุเพื่อใช้ในงานราชการ  ประจำเดือน ${headerSlot(monthName, 6)} พ.ศ. ${headerSlot(be, 3.9)} ดังรายการต่อไปนี้`;
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
// 2x: dotted leaders stay here; the requester name replaces the dots in "( … )" under ผู้เบิก, and the "โทร :" line (xls row 45) under
// the receiver carries opts.phone (dots when none).
function appendSignatureBlock(tbody, step, pageNumber, opts = {}) {
  const requesterLine = opts.requester_name ? esc(`( ${opts.requester_name} )`) : SIG_NAME_LINE;
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
    td(requesterLine, { colspan: 4, cls: "cell-noborder cell-center" }),
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
  tbody.appendChild(tr("row-h20", [
    td(opts.phone ? `โทร : ${esc(opts.phone)}` : SIG_PHONE_LINE, { colspan: 6, cls: "cell-noborder cell-left" }),
    gap(7),
  ], 20));
  tbody.appendChild(tr("row-h23", [
    td(`&lt; ${pageNumber} &gt;`, { colspan: 13, cls: "cell-noborder cell-center" }),
  ], 23));
}
