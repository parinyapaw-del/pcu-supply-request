// tab2b_sheet.js — "จ่ายจริง" mode ต่อใบ: one PCU + round (adminGetRequest -> issueLines / issueAll / issueDone).
// 2ak D8: split out of renderTab2b (tab2b_issue.js), no behaviour change. `core` = the tab's shared state + helpers (see renderTab2b).
import { formatInt } from "../format.js";
import { el, escapeHtml, tableScroll, monthLong, formatBangkokDateTime, confirmDialog, toast, errMessage } from "./util.js";
import { buildCatalog, addForm, DISPENSE_UNITS, isUsableStatus, itemOrPlaceholder } from "./compute.js";
import { clearRequestCache } from "./requests.js";
import { unitStripHtml } from "./tab1_status.js";
import { STATUS_LABEL, createEditor, gotCells, inputCell, numOrNull, rcvHtml, reasonCell, whoLabel } from "./tab2b_editor.js";

export function sheetMode(core) {
  const { ctx, state, ts, host, myUnits, expiredFor, footerHtml, loadingHtml, refreshFooter, showFirstError, writeError } = core;

  // ======================================== ต่อใบ ========================================
  async function loadSheet() {
    const my = ++ts.seq;
    host.innerHTML = loadingHtml("กำลังโหลดใบเบิก...");
    try {
      const data = await ctx.adminCall("adminGetRequest", { pcu: ts.pcu, month: ts.month });
      if (my !== ts.seq) return;
      ts.sheet = { request: data.request, form: data.form, issue: data.issue || null };
      ts.expired = expiredFor([data.request]);
      drawSheet();
    } catch (err) {
      if (my !== ts.seq) return;
      host.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    }
  }

  function applyWrite(data) {
    clearRequestCache();
    if (data.request) ts.sheet.request = data.request;
    ts.sheet.issue = data.issue || null;
    drawSheet();
  }

  function drawSheet() {
    const { request, form, issue } = ts.sheet;
    const pcu = state.bootstrap.pcus.find((p) => p.code === ts.pcu) || { code: ts.pcu, name: "" };
    host.innerHTML = "";
    ts.editor = null;
    const head = el("div", { class: "admin-card t2b-head", id: "t2b-sheet-head" });
    head.appendChild(el("h2", {}, `${pcu.code} ${pcu.name} — ขอเบิก ${monthLong(ts.month)}`));
    host.appendChild(head);
    if (!request || !isUsableStatus(request.status)) {
      head.appendChild(el("div", { class: "notice notice-info", id: "t2b-not-sent" },
        "ยังไม่ได้ส่งใบเบิก" + (request && request.status === "draft" ? " (แบบร่าง — ยังบันทึกการจ่ายไม่ได้)" : "")));
      return;
    }
    if (request.no_order) { // 2af
      head.appendChild(el("div", { class: "notice notice-info", id: "t2b-no-order" }, `รพ.สต. แจ้ง "ไม่เบิก" เดือนนี้ (${formatBangkokDateTime(request.submitted_at)}) — ไม่มีรายการให้จ่าย`));
      return;
    }
    head.insertAdjacentHTML("beforeend", `<p class="t2b-meta"><span class="badge ${request.status === "issued" ? "badge-success" : "badge-muted"}">${escapeHtml(STATUS_LABEL[request.status] || request.status)}</span>
      <span class="small">ส่งเมื่อ ${escapeHtml(formatBangkokDateTime(request.submitted_at))}</span>
      ${issue ? `<span class="small t2b-sum">· จ่ายแล้ว ${issue.units_done}/${issue.units_total} หน่วย · ครบ ${issue.complete} · ไม่ครบ ${issue.incomplete} รายการ</span>` : ""}
      ${request.mismatch_count ? `<span class="badge badge-warn" id="t2b-mismatch">รพ.สต. แจ้งได้รับไม่ตรง ${request.mismatch_count} รายการ</span>` : ""}</p>
      ${issue ? `<div class="t2b-strip">${unitStripHtml(issue)}</div>` : ""}`);
    if (ts.expired) head.appendChild(el("div", { class: "notice notice-error", id: "t2b-expired" }, ts.expired + " — ดูได้อย่างเดียว"));

    const cat = buildCatalog(form || state.bootstrap.form);
    addForm(cat, state.bootstrap.form);
    const lines = Object.entries(request.lines || {})
      .map(([code, l]) => ({ code, l, item: itemOrPlaceholder(cat, code), op: Number(l.op) || 0, pp: Number(l.pp) || 0 }))
      .filter((x) => x.op + x.pp > 0);
    if (!lines.length) {
      host.appendChild(el("div", { class: "admin-card" }, el("p", { class: "muted" }, state.isAdmin
        ? "ใบนี้ไม่มีรายการที่ขอเบิก"
        : "ใบนี้ไม่มีรายการที่ขอเบิกในหน่วยของท่าน")));
      return;
    }
    lines.sort((a, b) => a.item.stepOrder - b.item.stepOrder || (cat.items.indexOf(a.item) - cat.items.indexOf(b.item)));

    // group by dispense unit, then page
    const unitOrder = DISPENSE_UNITS.concat(Array.from(new Set(lines.map((x) => x.item.dispenseUnit))).filter((u) => !DISPENSE_UNITS.includes(u)));
    const rowsAll = [];
    const blocks = [];
    unitOrder.forEach((unit) => {
      const ul = lines.filter((x) => (x.item.dispenseUnit || "") === unit);
      if (!ul.length) return;
      const info = (issue && issue.units && issue.units[unit]) || null;
      const done = !!(info && info.done);
      const canAct = myUnits.includes(unit) && !ts.expired;
      const rows = ul.map((x) => ({
        key: x.code, label: x.code, op: x.op, pp: x.pp, req: x.op + x.pp,
        base: { total: numOrNull(x.l.issued_total), reason: x.l.issue_reason || null, note: x.l.issue_note || "" },
        disabled: done || !canAct, x
      }));
      rowsAll.push(...rows);
      blocks.push({ unit, info, done, canAct, rows });
    });

    const editor = createEditor(rowsAll, { onChange: refreshFooter });
    ts.editor = editor;

    blocks.forEach(({ unit, info, done, canAct, rows }) => {
      const card = el("div", { class: "admin-card t2b-unit" + (done ? " t2b-unit-done" : ""), "data-unit": unit });
      const uh = el("div", { class: "t2b-unit-head" });
      uh.appendChild(el("h3", {}, `หน่วยจ่าย: ${unit}`));
      uh.appendChild(el("span", { class: "badge " + (done ? "badge-success" : "badge-muted"), "data-role": "unit-badge" },
        done ? `จ่ายแล้ว ${formatBangkokDateTime(info.done_at)} โดย ${whoLabel(info.done_by)}` : "ยังไม่จ่าย"));
      if (info) uh.appendChild(el("span", { class: "muted small" }, `บันทึกแล้ว ${info.issued_lines}/${info.lines} รายการ`));
      if (canAct) {
        const btns = el("span", { class: "t2b-unit-btns" });
        const allBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-act": "issue-all", "data-unit": unit, disabled: done }, `จ่ายครบทุกรายการ (หน่วย ${unit})`);
        allBtn.addEventListener("click", () => issueAll(unit));
        const doneBtn = el("button", { type: "button", class: "btn btn-sm " + (done ? "btn-secondary" : "btn-primary"), "data-act": "issue-done", "data-unit": unit },
          done ? "ยกเลิก (ยังไม่จ่าย)" : `หน่วย ${unit} จ่ายใบนี้แล้ว`);
        doneBtn.addEventListener("click", () => issueDone(unit, !done));
        btns.appendChild(allBtn); btns.appendChild(doneBtn);
        uh.appendChild(btns);
      }
      card.appendChild(uh);

      const body = [];
      let stepKey = null;
      rows.forEach((r) => {
        const it = r.x.item;
        if (it.stepCode !== stepKey) {
          stepKey = it.stepCode;
          body.push(`<tr class="group-row"><td colspan="8">หน้า ${escapeHtml(it.pageNo)} — ${escapeHtml(it.sheet)}${it.title ? " · " + escapeHtml(it.title) : ""} — หน่วยจ่าย ${escapeHtml(unit)}</td></tr>`);
        }
        const l = r.x.l;
        const by = l.issued_at ? ` title="บันทึก ${escapeHtml(formatBangkokDateTime(l.issued_at))} โดย ${escapeHtml(whoLabel(l.issued_by))}"` : "";
        body.push(`<tr data-key="${escapeHtml(r.key)}"${by}>
          <td class="left name-cell"><span class="code-cell">${escapeHtml(it.code)}</span> ${escapeHtml(it.name)}${it.unit ? ` <span class="muted small">(${escapeHtml(it.unit)})</span>` : ""}${usedAdjHtml(l)}${rcvHtml(l)}</td>
          <td class="num">${formatInt(r.op)}</td><td class="num">${formatInt(r.pp)}</td><td class="num"><strong>${formatInt(r.req)}</strong></td>
          ${inputCell(r)}${gotCells()}${reasonCell(r)}</tr>`);
      });
      card.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table t2b-table" data-unit="${escapeHtml(unit)}">
        <thead><tr><th class="left">รายการ</th><th class="num">ขอ OP</th><th class="num">ขอ PP</th><th class="num">ขอรวม</th>
        <th class="num">จ่ายจริง</th><th class="num">ได้ OP</th><th class="num">ได้ PP</th><th class="left">เหตุผล</th></tr></thead>
        <tbody>${body.join("")}</tbody></table>`));
      host.appendChild(card);
    });

    host.insertAdjacentHTML("beforeend", `<p class="admin-note t2b-help">ช่อง "จ่ายจริง" ว่าง = ยังไม่บันทึก (กด "หน่วย X จ่ายใบนี้แล้ว" แล้วรายการที่ว่างจะถือว่าจ่ายครบตามขอ) · จ่ายน้อยกว่าขอต้องเลือกเหตุผล · หักจาก OP ก่อน PP</p>`);
    host.insertAdjacentHTML("beforeend", footerHtml(""));
    editor.wire(host);
    host.querySelector('[data-act="save"]').addEventListener("click", saveSheet);
    host.querySelector('[data-act="revert"]').addEventListener("click", () => editor.revert());
    refreshFooter();
  }

  // 2o: ใช้ไป / ปรับยอด (เหตุผล) of a request line — shown when present (never on the printed form, Q16)
  const ADJ_REASON_LABEL = { received_extra: "ได้รับเพิ่ม", borrow_return: "ยืม/คืน", expired_damaged: "หมดอายุ/เสียหาย", recount: "นับใหม่", other: "อื่น ๆ" };
  function usedAdjHtml(l) {
    const parts = [];
    if (l.used != null) parts.push(`ใช้ไป ${formatInt(l.used)}`);
    const adj = Number(l.adj) || 0;
    if (adj) parts.push(`ปรับยอด ${adj > 0 ? "+" : "−"}${formatInt(Math.abs(adj))}${l.adj_reason ? ` (${escapeHtml(ADJ_REASON_LABEL[l.adj_reason] || l.adj_reason)})` : ""}`);
    return parts.length ? `<div class="muted small t2b-usedadj">${parts.join(" · ")}</div>` : "";
  }

  async function saveSheet() {
    const editor = ts.editor;
    if (!editor) return;
    const problem = editor.validate();
    if (problem) { showFirstError(problem); return; }
    const lines = editor.payload();
    const n = Object.keys(lines).length;
    if (!n) return;
    const btn = host.querySelector('[data-act="save"]');
    if (btn) btn.disabled = true;
    try {
      const data = await ctx.adminCall("issueLines", { pcu: ts.pcu, month: ts.month, lines });
      applyWrite(data);
      toast(`บันทึกการจ่ายแล้ว ${n} รายการ`);
    } catch (err) {
      if (btn) btn.disabled = false;
      writeError(err, drawSheet);
    }
  }

  async function issueAll(unit) {
    if (ts.editor && ts.editor.dirtyCount()) { toast("มีการแก้ไขที่ยังไม่บันทึก — กดบันทึกการจ่าย หรือคืนค่าเดิมก่อน", "err"); return; }
    const ok = await confirmDialog(`ตั้งจ่ายจริง = ขอ ทุกรายการของหน่วย ${unit}?\n(เหตุผลที่บันทึกไว้ของหน่วยนี้จะถูกล้าง)`, { title: "จ่ายครบทุกรายการ", okText: "จ่ายครบทุกรายการ" });
    if (!ok) return;
    try {
      const data = await ctx.adminCall("issueAll", { pcu: ts.pcu, month: ts.month, unit });
      applyWrite(data);
      toast(`บันทึกจ่ายครบทุกรายการของหน่วย ${unit} แล้ว`);
    } catch (err) { writeError(err, drawSheet); }
  }

  async function issueDone(unit, done) {
    if (ts.editor && ts.editor.dirtyCount()) { toast("มีการแก้ไขที่ยังไม่บันทึก — กดบันทึกการจ่าย หรือคืนค่าเดิมก่อน", "err"); return; }
    const pcu = state.bootstrap.pcus.find((p) => p.code === ts.pcu) || { name: ts.pcu };
    const ok = await confirmDialog(done
      ? `ยืนยัน: หน่วย ${unit} จ่ายใบของ ${pcu.name} (${monthLong(ts.month)}) แล้ว?\nรายการที่ยังไม่บันทึกจะถือว่าจ่ายครบตามขอ และ รพ.สต. จะแก้หน้านี้ไม่ได้อีก`
      : `ยกเลิกสถานะ "จ่ายแล้ว" ของหน่วย ${unit}?\nรพ.สต. จะกลับมาแก้หน้าของหน่วยนี้ได้ (ยอดจ่ายที่บันทึกไว้ยังอยู่)`,
    { title: done ? "หน่วยจ่ายใบนี้แล้ว" : "ยกเลิกสถานะจ่ายแล้ว", okText: done ? "ยืนยันจ่ายแล้ว" : "ยกเลิกสถานะจ่าย", danger: !done });
    if (!ok) return;
    try {
      const data = await ctx.adminCall("issueDone", { pcu: ts.pcu, month: ts.month, unit, done: done ? 1 : 0 });
      applyWrite(data);
      toast(done ? `หน่วย ${unit}: บันทึกว่าจ่ายแล้ว` : `หน่วย ${unit}: ยกเลิกสถานะจ่ายแล้ว`);
    } catch (err) { writeError(err, drawSheet); }
  }

  return { load: loadSheet };
}
