// Tab 1 — สถานะรอบ (phase 2.md §5.2 / functions/API.md §5 adminRequests, adminSetRound, adminLockRound, adminNote).
import { formatMoney } from "../format.js";
import { getAdminToken } from "../api.js";
import { requestPdfReady, startPdfDownload } from "../pdf_client.js";
import { DISPENSE_UNITS } from "./compute.js";
import {
  el, escapeHtml, tableScroll, formatBangkokDateTime, formatBangkokTimeSec, formatDateThai, monthLong,
  confirmDialog, formDialog, toast, errMessage, isTrialPcu, realPcus, pcuTag
} from "./util.js";

const AUTO_REFRESH_MS = 30000;
const SOURCE_LABEL = { round: "ตั้งเฉพาะรอบนี้", config: "ค่าตั้งต้นรายเดือน", month_end: "สิ้นเดือน (ค่าตั้งต้น)" };

// 2c: compact per-unit strip "พัสดุ ✓ · จ่ายกลาง – · LAB ○" from an IssueInfo
// (✓ done · ○ has requested lines but not done yet · – no requested lines for that unit).
export function unitStripHtml(issue) {
  if (!issue || !issue.units) return "";
  const parts = DISPENSE_UNITS.map((u) => {
    const x = issue.units[u];
    if (!x || !x.needed) return `<span class="unit-pill unit-none" title="ไม่มีรายการของหน่วยนี้">${escapeHtml(u)} –</span>`;
    if (x.done) {
      const who = x.done_by === "backup" ? "รหัสสำรอง" : (x.done_by || "");
      return `<span class="unit-pill unit-done" title="จ่ายแล้ว ${escapeHtml(formatBangkokDateTime(x.done_at))}${who ? " โดย " + escapeHtml(who) : ""}">${escapeHtml(u)} ✓</span>`;
    }
    return `<span class="unit-pill unit-wait" title="ยังไม่จ่าย (บันทึกแล้ว ${x.issued_lines || 0}/${x.lines || 0} รายการ)">${escapeHtml(u)} ○</span>`;
  });
  return `<span class="unit-strip" data-role="unit-strip">${parts.join('<span class="unit-sep"> · </span>')}</span>`;
}

// Status text for one request row (or null = ไม่มีใบ).
function statusCell(req) {
  const lines = req ? (req.progress && req.progress.lines) || 0 : 0;
  if (!req || (req.status === "draft" && lines === 0 && !req.last_step)) {
    return `<span class="badge badge-muted">ยังไม่เริ่ม</span>`;
  }
  if (req.status === "draft") {
    return `<span class="badge badge-warn">กำลังกรอก</span> <span class="muted small">ขั้น ${escapeHtml(req.last_step || "–")} · ${lines} รายการ</span>`;
  }
  const strip = req.issue ? `<div class="unit-strip-line">${unitStripHtml(req.issue)}</div>` : "";
  if (req.status === "submitted") {
    return `<span class="badge badge-success">ส่งแล้ว</span> <span class="small">${escapeHtml(formatBangkokDateTime(req.submitted_at))}</span>`
      + ` <span class="muted small">×${req.submit_count || 1}</span>`
      + (req.edited_after_submit ? ` <span class="badge badge-warn" title="มีการแก้ไขหลังส่งครั้งล่าสุด">แก้หลังส่ง</span>` : "")
      + strip;
  }
  if (req.status === "issued") {
    return `<span class="badge badge-issued">จ่ายแล้ว</span> <span class="small">ส่ง ${escapeHtml(formatBangkokDateTime(req.submitted_at))}</span>`
      + ` <span class="muted small">×${req.submit_count || 1}</span>`
      + (req.issued_seen_at ? ` <span class="muted small" title="รพ.สต. กดรับทราบแล้ว">รับทราบแล้ว</span>` : "")
      + strip;
  }
  return `<span class="badge badge-muted">${escapeHtml(req.status)}</span>`;
}

export function renderTab1(container, ctx) {
  const { state } = ctx;
  const isAdmin = state.isAdmin;
  const tabState = { month: ctx.defaultMonth(), data: null, loading: false, timer: null, visible: false };

  container.innerHTML = "";
  const toolbar = el("div", { class: "admin-toolbar" });
  const select = el("select", { class: "select-input", id: "t1-month", "aria-label": "เลือกรอบ" });
  const refreshBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t1-refresh" }, "รีเฟรช");
  const stamp = el("span", { class: "muted small", id: "t1-stamp" });
  toolbar.appendChild(el("label", {}, ["รอบ: ", select]));
  toolbar.appendChild(refreshBtn);
  toolbar.appendChild(stamp);
  container.appendChild(toolbar);

  const header = el("div", { class: "admin-card", id: "t1-header" });
  const tableHost = el("div", { id: "t1-table" });
  container.appendChild(header);
  container.appendChild(tableHost);

  function monthOptions() {
    const months = new Set(ctx.fyMonths());
    if (tabState.month) months.add(tabState.month);
    return Array.from(months).sort().reverse();
  }
  function fillSelect() {
    select.innerHTML = "";
    const opts = monthOptions();
    if (!opts.length) { select.appendChild(el("option", { value: "", disabled: true, selected: true }, "— ไม่มีรอบในปีงบนี้ —")); return; }
    opts.forEach((m) => {
      const label = ctx.monthLabel(m);
      select.appendChild(el("option", { value: m, selected: m === tabState.month }, label));
    });
  }
  fillSelect();
  select.addEventListener("change", () => { tabState.month = select.value; load(true); });
  refreshBtn.addEventListener("click", () => load(true));

  function currentRound() {
    const fromData = tabState.data && tabState.data.rounds.find((r) => r.month === tabState.month);
    if (fromData) return fromData;
    return (state.bootstrap.rounds || []).find((r) => r.month === tabState.month) || null;
  }

  // keep bootstrap.rounds in sync with the latest RoundInfo we saw (the PCU list / other tabs read it)
  function syncRound(round) {
    if (!round) return;
    const list = state.bootstrap.rounds || (state.bootstrap.rounds = []);
    const i = list.findIndex((r) => r.month === round.month);
    if (i >= 0) list[i] = round; else list.push(round);
    list.sort((a, b) => (a.month < b.month ? 1 : -1));
    if (tabState.data) {
      const j = tabState.data.rounds.findIndex((r) => r.month === round.month);
      if (j >= 0) tabState.data.rounds[j] = round; else tabState.data.rounds.push(round);
    }
  }

  function drawEmptyFy() {
    header.innerHTML = "";
    header.appendChild(el("h2", {}, `ปีงบ ${ctx.fySelected()}`));
    header.appendChild(el("p", { class: "muted" }, `ยังไม่มีรอบหรือใบเบิกบนเว็บในปีงบ ${ctx.fySelected()} — ข้อมูลเบิกจริงที่นำเข้าจาก Excel ดูที่แท็บ "ปีก่อน"`));
    tableHost.innerHTML = "";
    stamp.textContent = "";
  }

  async function load(showSpinner) {
    if (tabState.loading) return;
    if (!tabState.month) { tabState.data = null; drawEmptyFy(); return; }
    tabState.loading = true;
    if (showSpinner && !tabState.data) tableHost.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังโหลด...</div>';
    try {
      const data = await ctx.adminCall("adminRequests", { month: tabState.month });
      tabState.data = data;
      (data.rounds || []).forEach(syncRound);
      stamp.textContent = `อัปเดต ${formatBangkokTimeSec(data.server_time)}`;
      draw();
    } catch (err) {
      if (!tabState.data) tableHost.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
      else stamp.textContent = "รีเฟรชไม่สำเร็จ — " + errMessage(err);
    } finally {
      tabState.loading = false;
    }
  }

  // ---- round header ---------------------------------------------------------------------------------
  function drawHeader() {
    const round = currentRound();
    header.innerHTML = "";
    const title = el("h2", {}, `รอบ ขอเบิก ${monthLong(tabState.month)}`);
    if (round && round.trial) title.appendChild(el("span", { class: "badge badge-warn badge-trial", id: "t1-trial-badge" }, "ทดลอง"));
    header.appendChild(title);
    if (!round) { header.appendChild(el("p", { class: "muted" }, "ไม่มีข้อมูลรอบ")); return; }
    const row = el("div", { class: "round-row" });
    const deadlineBox = el("div", { class: "round-box" });
    deadlineBox.appendChild(el("span", { class: "round-label" }, "กำหนดส่ง"));
    deadlineBox.appendChild(el("strong", { id: "t1-deadline" }, formatDateThai(round.deadline_date)));
    deadlineBox.appendChild(el("span", { class: "muted small", id: "t1-deadline-src" }, SOURCE_LABEL[round.deadline_source] || round.deadline_source || ""));
    if (isAdmin) {
      const edit = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t1-edit-deadline" }, "แก้");
      edit.addEventListener("click", () => editDeadline(round));
      deadlineBox.appendChild(edit);
      if (round.deadline_source === "round") {
        const clear = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t1-clear-deadline" }, "ล้าง");
        clear.title = "กลับไปใช้ค่าตั้งต้น";
        clear.addEventListener("click", () => setDeadline(round, null));
        deadlineBox.appendChild(clear);
      }
    }
    row.appendChild(deadlineBox);

    const lockBox = el("div", { class: "round-box" });
    lockBox.appendChild(el("span", { class: "round-label" }, "สถานะรอบ"));
    lockBox.appendChild(el("span", { class: "badge " + (round.locked ? "badge-danger" : "badge-success"), id: "t1-lock-badge" },
      round.locked ? "ล็อกแล้ว — รพ.สต. แก้ไม่ได้" : "เปิดรับ"));
    if (round.locked && round.locked_at) lockBox.appendChild(el("span", { class: "muted small" }, `เมื่อ ${formatBangkokDateTime(round.locked_at)}`));
    if (isAdmin) {
      const lockBtn = el("button", { type: "button", class: "btn btn-sm " + (round.locked ? "btn-secondary" : "btn-primary"), id: "t1-lock" },
        round.locked ? "ปลดล็อกรอบ" : "ล็อกรอบ");
      lockBtn.addEventListener("click", () => toggleLock(round));
      lockBox.appendChild(lockBtn);
    }
    row.appendChild(lockBox);
    header.appendChild(row);
    if (round.note) header.appendChild(el("p", { class: "muted small" }, "หมายเหตุรอบ: " + round.note));
  }

  async function editDeadline(round) {
    const res = await formDialog(`กำหนดส่ง ${monthLong(round.month)}`, [
      { key: "date", label: "วันที่กำหนดส่ง", type: "date", value: round.deadline_date || "", required: true }
    ], { okText: "บันทึก", intro: "ตั้งเฉพาะรอบนี้ — กด \"ล้าง\" เพื่อกลับไปใช้ค่าตั้งต้น (สิ้นเดือน)" });
    if (res) setDeadline(round, res.date);
  }

  async function setDeadline(round, date) {
    try {
      const data = await ctx.adminCall("adminSetRound", { month: round.month, deadline_date: date });
      syncRound(data.round);
      toast(date ? "บันทึกกำหนดส่งแล้ว" : "ล้างกำหนดส่งแล้ว (ใช้ค่าตั้งต้น)");
      drawHeader();
    } catch (err) { toast(errMessage(err), "err"); }
  }

  async function toggleLock(round) {
    const lockNow = !round.locked;
    const ok = await confirmDialog(lockNow
      ? `ล็อกรอบ ${monthLong(round.month)}?\nรพ.สต. จะบันทึก/ส่งใบเบิกของรอบนี้ไม่ได้จนกว่าจะปลดล็อก`
      : `ปลดล็อกรอบ ${monthLong(round.month)}?\nรพ.สต. จะกลับมาแก้ไข/ส่งใบเบิกได้`,
    { title: lockNow ? "ล็อกรอบ" : "ปลดล็อกรอบ", okText: lockNow ? "ล็อกรอบ" : "ปลดล็อก", danger: lockNow });
    if (!ok) return;
    try {
      const data = await ctx.adminCall("adminLockRound", { month: round.month, locked: lockNow ? 1 : 0 });
      syncRound(data.round);
      toast(lockNow ? "ล็อกรอบแล้ว" : "ปลดล็อกรอบแล้ว");
      drawHeader();
    } catch (err) { toast(errMessage(err), "err"); }
  }

  // ---- table ---------------------------------------------------------------------------------------
  function draw() {
    drawHeader();
    const reqs = {};
    (tabState.data ? tabState.data.requests : []).forEach((r) => { reqs[r.pcu] = r; });
    const rows = state.bootstrap.pcus.map((pcu) => {
      const req = reqs[pcu.code] || null;
      const baht = req && req.progress ? req.progress.baht : 0;
      const showBaht = req && (req.status === "submitted" || req.status === "issued" || (req.progress && req.progress.lines > 0));
      const printUrl = `index.html#/print?pcu=${encodeURIComponent(pcu.code)}&month=${encodeURIComponent(tabState.month)}&as=admin`;
      const noteHtml = req && req.admin_note
        ? `<div class="note-line" data-note="${pcu.code}">โน้ต: ${escapeHtml(req.admin_note)} <span class="muted small">(${escapeHtml(formatBangkokDateTime(req.admin_note_at))})</span></div>` : "";
      const canOpen = req && (req.status !== "draft" || (req.progress && req.progress.lines > 0));
      const actions = [
        canOpen ? `<a class="btn btn-secondary btn-sm" href="${printUrl}" target="_blank" rel="noopener" data-act="open" data-pcu="${pcu.code}">เปิดใบ</a>` : `<span class="muted small">–</span>`
      ];
      if (req && (req.status === "submitted" || req.status === "issued")) {
        actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="pdf" data-pcu="${pcu.code}" title="ดาวน์โหลดใบเบิกเป็น PDF">PDF</button>`);
        actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="issue" data-pcu="${pcu.code}" title="บันทึกจ่ายจริงของใบนี้">จ่าย</button>`);
      }
      if (isAdmin) {
        actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="note" data-pcu="${pcu.code}">โน้ตขอให้แก้</button>`);
        if (req && req.admin_note) actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="clear-note" data-pcu="${pcu.code}">ล้างโน้ต</button>`);
      }
      return `<tr data-pcu="${pcu.code}">
        <td class="left"><strong>${pcu.code}</strong> ${escapeHtml(pcu.name)}${pcuTag(pcu)}</td>
        <td class="left status-cell">${statusCell(req)}${noteHtml}</td>
        <td class="num">${showBaht ? formatMoney(baht) : "–"}</td>
        <td class="left actions-cell">${actions.join(" ")}</td>
      </tr>`;
    }).join("");

    const trialCodes = new Set(state.bootstrap.pcus.filter(isTrialPcu).map((p) => p.code));
    const submittedAll = Object.values(reqs).filter((r) => r.status === "submitted" || r.status === "issued");
    const submitted = submittedAll.filter((r) => !trialCodes.has(r.pcu));
    const trialSubmitted = submittedAll.length - submitted.length;
    const issuedN = submitted.filter((r) => r.status === "issued").length;
    const totalBaht = submitted.reduce((s, r) => s + ((r.progress && r.progress.baht) || 0), 0);
    const curRound = currentRound();
    const trialBadge = curRound && curRound.trial ? ' <span class="badge badge-warn badge-trial" id="t1-summary-trial">ทดลอง</span>' : "";
    const summary = `${trialBadge}ส่งแล้ว ${submitted.length}/${realPcus(state.bootstrap.pcus).length} แห่ง · จ่ายแล้ว ${issuedN} แห่ง · ยอดรวม ${formatMoney(totalBaht)} บาท`
      + (trialSubmitted ? ` · ทดลอง ${trialSubmitted} แห่ง (ไม่นับ)` : "");

    tableHost.innerHTML = `<p class="admin-note" id="t1-summary">${summary}</p>` + tableScroll(`<table class="admin-table" id="t1-tbl">
      <thead><tr><th class="left">รพ.สต.</th><th class="left">สถานะ</th><th class="num">บาท</th><th class="left">การดำเนินการ</th></tr></thead>
      <tbody>${rows}</tbody></table>`);

    tableHost.querySelectorAll('[data-act="pdf"]').forEach((b) => b.addEventListener("click", () => downloadPdf(b)));
    tableHost.querySelectorAll('[data-act="issue"]').forEach((b) => b.addEventListener("click", () => {
      location.hash = `#issue?pcu=${encodeURIComponent(b.dataset.pcu)}&month=${encodeURIComponent(tabState.month)}`;
    }));
    tableHost.querySelectorAll('[data-act="note"]').forEach((b) => b.addEventListener("click", () => editNote(b.dataset.pcu, reqs[b.dataset.pcu])));
    tableHost.querySelectorAll('[data-act="clear-note"]').forEach((b) => b.addEventListener("click", () => saveNote(b.dataset.pcu, "")));
  }

  // PDF of one request (adminRequestPdf → pending/ready; the file is then fetched with the admin token)
  async function downloadPdf(btn) {
    const pcu = btn.dataset.pcu;
    const token = getAdminToken();
    const label = btn.textContent;
    btn.disabled = true;
    try {
      toast(`กำลังสร้าง PDF ${pcu}…`);
      const r = await requestPdfReady("adminRequestPdf", { pcu, month: tabState.month }, token, {
        onWait: (n) => { btn.textContent = `รอ ${n} วิ`; },
        callFn: (a, p) => ctx.adminCall(a, p)
      });
      startPdfDownload(r.url, token);
      toast(`ดาวน์โหลด ${r.filename}`);
    } catch (err) {
      toast(errMessage(err), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function editNote(pcu, req) {
    const name = (state.bootstrap.pcus.find((p) => p.code === pcu) || {}).name || pcu;
    const res = await formDialog(`โน้ตขอให้แก้ — ${pcu} ${name}`, [
      { key: "note", label: "ข้อความถึง รพ.สต.", type: "textarea", value: (req && req.admin_note) || "", required: true, maxlength: 500 }
    ], { intro: "รพ.สต. จะเห็นข้อความนี้ในใบเบิก — ไม่เปลี่ยนสถานะใบ", okText: "บันทึกโน้ต" });
    if (res) saveNote(pcu, res.note);
  }

  async function saveNote(pcu, note) {
    try {
      await ctx.adminCall("adminNote", { pcu, month: tabState.month, note });
      toast(note ? "บันทึกโน้ตแล้ว" : "ล้างโน้ตแล้ว");
      load(false);
    } catch (err) { toast(errMessage(err), "err"); }
  }

  function startTimer() {
    stopTimer();
    tabState.timer = setInterval(() => {
      if (document.hidden || !tabState.visible) return; // pause when the browser tab is hidden
      load(false);
    }, AUTO_REFRESH_MS);
  }
  function stopTimer() { if (tabState.timer) { clearInterval(tabState.timer); tabState.timer = null; } }
  function onVisibility() { if (!document.hidden && tabState.visible) load(false); }
  document.addEventListener("visibilitychange", onVisibility);

  load(true);
  return {
    onShow() { tabState.visible = true; fillSelect(); startTimer(); if (tabState.data) load(false); },
    onHide() { tabState.visible = false; stopTimer(); }
  };
}
