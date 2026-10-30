// "รายงานของได้จริง" (#/received?month=YYYY-MM) — brief 2af. Optional: per requested line (ขอ > 0) the total the รพ.สต. actually got,
// for any sent month of the fy (closed rounds too). Empty box = not reported (≠ 0) · clearing a reported box removes the report.
// When the dispenser's figure is visible (unit done → request.issued) the page shows ขอ | ผู้จ่ายบันทึก | รพ.สต. แจ้ง and a yellow "ไม่ตรง".
// Saved with pcuReceivedSave (only changed rows); a reported line's requested qty is then locked on the fill page (qty_locked).
import { call, getPcuToken } from "../api.js";
import { getOrderedSteps } from "../data.js";
import { formatInt } from "../format.js";
import * as sync from "../sync.js";
import { esc, pcuCode, roundTitle, roundOf, loadOlderMonth, alertDialog, confirmDialog, formForRequest, formatThaiYmd, toast } from "./common.js";

const todayBkk = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

// keep the cached copies (home cards, fill page session) in step with what the server returned
function storeMonth(app, month, request) {
  if (app.boot.byMonth && app.boot.byMonth[month]) app.boot.byMonth[month].request = request;
  if (app.older && app.older[month]) app.older[month].request = request;
  if (request) sync.initSession(pcuCode(app), month, request);
}

export async function renderReceived(container, app, params) {
  const month = params.get("month") || (app.boot.rounds[0] && app.boot.rounds[0].month);
  await loadOlderMonth(app, month);
  const data = await call("pcuGetMonth", { month }, { token: getPcuToken() });
  if (data.form && data.form.id) { app.boot.forms = app.boot.forms || {}; app.boot.forms[data.form.id] = data.form; }
  let request = data.request;
  storeMonth(app, month, request);
  const title = roundTitle(month, data.round || roundOf(app, month));

  const box = document.createElement("div");
  box.className = "received-page";
  container.innerHTML = "";
  container.appendChild(box);

  // 2ai: any request with a requested line (own or keyed by admin, sent or not) — not a "ไม่เบิก" month
  const anyReq = !!request && Object.values(request.lines || {}).some((l) => (Number(l && l.op) || 0) + (Number(l && l.pp) || 0) > 0);
  if (!anyReq || request.no_order) {
    box.innerHTML = `<h2>รายงานของได้จริง ${esc(title)}</h2>
      <p class="muted">${request && request.no_order ? 'เดือนนี้แจ้ง "ไม่เบิก" — ไม่มีรายการให้รายงาน' : "เดือนนี้ยังไม่มียอดขอเบิก — ไม่มีรายการให้รายงาน"}</p>
      <p><a class="btn btn-secondary" href="#/home">กลับหน้าหลัก</a></p>`;
    return;
  }

  // requested lines in form order, grouped by page
  const form = formForRequest(app, request);
  const groups = [], seen = new Set();
  const lineOf = (code) => (request.lines || {})[code];
  const req = (l) => (Number(l && l.op) || 0) + (Number(l && l.pp) || 0);
  getOrderedSteps(form).forEach((step) => {
    const rows = [];
    (step.rows || []).forEach((r) => {
      if (r.type !== "item" || seen.has(r.code) || req(lineOf(r.code)) <= 0) return;
      seen.add(r.code);
      rows.push({ code: r.code, name: r.name, unit: r.unit || "" });
    });
    if (rows.length) groups.push({ title: step.sheet || step.title || step.code, rows });
  });
  const extra = Object.keys(request.lines || {}).filter((c) => !seen.has(c) && req(lineOf(c)) > 0).map((c) => ({ code: c, name: c, unit: "" }));
  if (extra.length) groups.push({ title: "อื่น ๆ", rows: extra });
  const all = groups.flatMap((g) => g.rows);

  const render = () => {
    const issued = request.issued || {};
    const anyIssued = all.some((r) => issued[r.code]);
    const reported = all.filter((r) => lineOf(r.code).rcv_qty !== undefined).length;
    const mism = all.filter((r) => lineOf(r.code).mismatch === true).length;
    box.innerHTML = `
      <h2>รายงานของได้จริง ${esc(title)}</h2>
      <p class="muted small">ไม่บังคับ · กรอกจำนวนที่ได้รับจริงรวม (OP+PP) ต่อรายการ · ช่องว่าง = ยังไม่แจ้ง (ต่างจาก 0) · ลบตัวเลขออกแล้วบันทึก = ยกเลิกการแจ้ง ·
        แจ้งแล้วยอดขอของรายการนั้นจะคงไว้ตามเดิม</p>
      <p class="rcv-summary" id="rcv-summary">แจ้งแล้ว ${reported}/${all.length} รายการ${mism ? ` · <span class="badge badge-warn">ไม่ตรง ${mism}</span>` : ""}</p>
      <div class="rcv-tools">
        <label class="field-label rcv-date-label">วันที่รับ <input type="date" id="rcv-date" value="${esc(todayBkk())}" max="${esc(todayBkk())}"></label>
        <button type="button" class="btn btn-secondary" id="rcv-fill">ได้ครบตามขอ</button>
      </div>
      ${groups.map((g) => `
        <h3 class="rcv-group">${esc(g.title)}</h3>
        <div class="rcv-list">${g.rows.map((r) => {
          const l = lineOf(r.code), got = issued[r.code];
          const has = l.rcv_qty !== undefined;
          return `<div class="rcv-row${l.mismatch ? " rcv-mismatch" : ""}" data-code="${esc(r.code)}">
            <div class="rcv-name">${esc(r.name)} <span class="muted small">${esc(r.unit)}</span></div>
            <div class="rcv-nums">
              <span class="rcv-cell"><span class="rcv-lbl">ขอ</span><strong>${formatInt(req(l))}</strong></span>
              ${anyIssued ? `<span class="rcv-cell"><span class="rcv-lbl">ผู้จ่ายบันทึก</span>${got ? `<strong>${formatInt(got.total)}</strong>` : '<span class="muted">—</span>'}</span>` : ""}
              <label class="rcv-cell"><span class="rcv-lbl">รพ.สต. แจ้ง</span>
                <input type="number" inputmode="numeric" min="0" step="1" class="num-input rcv-qty" data-qty="${esc(r.code)}" value="${has ? esc(l.rcv_qty) : ""}" aria-label="ได้รับจริง ${esc(r.name)}"></label>
              <span class="badge badge-warn rcv-flag"${l.mismatch ? "" : " hidden"}>ไม่ตรง</span>
            </div>
            <input type="text" class="rcv-note" data-note="${esc(r.code)}" maxlength="200" placeholder="หมายเหตุ (ถ้ามี)" value="${esc(l.rcv_note || "")}">
            ${has ? `<div class="muted small rcv-meta">แจ้งแล้ว · รับวันที่ ${esc(formatThaiYmd(l.rcv_date))}</div>` : ""}
          </div>`;
        }).join("")}</div>`).join("")}
      <div class="summary-actions rcv-actions">
        <button type="button" class="btn btn-secondary" id="rcv-back">กลับหน้าหลัก</button>
        <span class="muted small" id="rcv-dirty"></span>
        <button type="button" class="btn btn-primary" id="rcv-save">บันทึก</button>
      </div>`;
    wire(issued);
  };

  // {code: {qty, note, qtyChanged}} for rows whose box differs from what is stored
  const changes = () => {
    const out = [];
    for (const r of all) {
      const l = lineOf(r.code);
      const qIn = box.querySelector(`[data-qty="${CSS.escape(r.code)}"]`), nIn = box.querySelector(`[data-note="${CSS.escape(r.code)}"]`);
      const raw = qIn.value.trim();
      const qty = raw === "" ? null : Number(raw);
      const note = nIn.value.trim() || null;
      const was = l.rcv_qty === undefined ? null : l.rcv_qty;
      if (qty === null && was === null) continue; // a note alone (no qty) is not a report
      if (qty === was && (qty === null || note === (l.rcv_note || null))) continue;
      out.push({ code: r.code, qty, note, qtyChanged: qty !== was });
    }
    return out;
  };

  function wire(issued) {
    const dirtyEl = box.querySelector("#rcv-dirty");
    const refresh = (row) => {
      if (row) {
        const code = row.dataset.code, got = issued[code];
        const v = row.querySelector(".rcv-qty").value.trim();
        const mm = !!got && v !== "" && Number(v) !== Number(got.total);
        row.classList.toggle("rcv-mismatch", mm);
        row.querySelector(".rcv-flag").hidden = !mm;
      }
      const n = changes().length;
      dirtyEl.textContent = n ? `ยังไม่บันทึก ${n} รายการ` : "";
    };
    box.querySelectorAll(".rcv-qty, .rcv-note").forEach((inp) => inp.addEventListener("input", () => refresh(inp.closest(".rcv-row"))));
    box.querySelector("#rcv-back").addEventListener("click", async () => {
      if (changes().length && !(await confirmDialog("ยังไม่ได้บันทึก", "<p>ออกจากหน้านี้โดยไม่บันทึกตัวเลขที่กรอก?</p>", "ออก", "อยู่ต่อ"))) return;
      location.hash = "#/home";
    });
    // "ได้ครบตามขอ" fills only the boxes still empty with the requested total — what was already typed/reported is never overwritten
    box.querySelector("#rcv-fill").addEventListener("click", () => {
      let n = 0;
      box.querySelectorAll(".rcv-row").forEach((row) => {
        const inp = row.querySelector(".rcv-qty");
        if (inp.value.trim() !== "") return;
        inp.value = String(req(lineOf(row.dataset.code)));
        refresh(row); n++;
      });
      toast(n ? `เติมยอดตามขอ ${n} รายการ (ช่องที่กรอกไว้แล้วไม่เปลี่ยน) — กดบันทึก` : "ทุกช่องกรอกไว้แล้ว");
    });
    box.querySelector("#rcv-save").addEventListener("click", async (ev) => {
      const list = changes();
      if (!list.length) { toast("ไม่มีอะไรเปลี่ยน"); return; }
      const bad = list.find((x) => x.qty !== null && !(Number.isInteger(x.qty) && x.qty >= 0 && x.qty <= 99999));
      if (bad) { await alertDialog("ตัวเลขไม่ถูกต้อง", "<p>จำนวนที่ได้รับต้องเป็นเลขจำนวนเต็ม 0–99999</p>"); return; }
      const date = box.querySelector("#rcv-date").value || todayBkk();
      ev.currentTarget.disabled = true;
      try {
        const res = await call("pcuReceivedSave", {
          month,
          lines: list.map((x) => (x.qty === null ? { code: x.code, qty: null } : { code: x.code, qty: x.qty, note: x.note, ...(x.qtyChanged ? { received_date: date } : {}) })),
        }, { token: getPcuToken() });
        request = res.request;
        storeMonth(app, month, request);
        toast(`บันทึกแล้ว ${res.changed} รายการ`);
        render();
      } catch (err) {
        if (err && String(err.code || "").startsWith("AUTH_")) throw err;
        await alertDialog("บันทึกไม่สำเร็จ", `<p>${esc(err.message || "")}</p>`);
        const b = box.querySelector("#rcv-save");
        if (b) b.disabled = false;
      }
    });
    refresh(null);
  }

  render();
}
