// tab2b_round.js — "จ่ายจริง" mode ทั้งรอบ (2y): one unit x one round — issueDoneAll and the 3-step "ครบยกเว้น…" wizard (issueExcept).
// 2ak D8: split out of renderTab2b (tab2b_issue.js), no behaviour change. `core` = the tab's shared state + helpers (see renderTab2b).
import { formatInt } from "../format.js";
import { lineQty } from "../data.js";
import { el, escapeHtml, tableScroll, monthLong, confirmDialog, toast, errMessage } from "./util.js";
import { buildCatalog, addForm, itemOrPlaceholder } from "./compute.js";
import { clearRequestCache, loadMonth } from "./requests.js";
import { notePlaceholder } from "./tab2b_editor.js";

export function roundMode(core) {
  const { ctx, state, ts, host, myUnits, adminKeyed, expiredFor, lateNote, loadingHtml, writeError } = core;

  // ======================================== ทั้งรอบ (2y) ========================================
  // One unit x one round: "จ่ายครบทุก รพ.สต." (issueDoneAll) and the 3-step "ครบยกเว้น…" wizard (issueExcept).
  // Data = loadMonth (adminRequests + adminGetRequest per sent request, cached) -> pending = requests whose unit is needed and not done.
  const rs = { seq: 0, step: 0, data: null, pending: [], doneCount: 0, selected: new Set(), search: "", vals: new Map(), reason: "out_of_stock", note: "", skipped: null, bad: new Set() };

  async function loadRound() {
    const my = ++rs.seq;
    rs.step = 0; rs.selected = new Set(); rs.vals = new Map(); rs.search = ""; rs.note = ""; rs.reason = "out_of_stock"; rs.skipped = null; rs.bad = new Set();
    host.innerHTML = loadingHtml("กำลังโหลดใบเบิกทั้งรอบ...");
    try {
      const data = await loadMonth(ctx, ts.month);
      if (my !== rs.seq) return;
      rs.data = data;
      ts.expired = expiredFor(data.entries.map((e) => e.request));
      drawRound();
    } catch (err) {
      if (my !== rs.seq) return;
      host.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    }
  }

  // Derive pending/done requests and the unit's requested lines per pending request.
  function computeRound() {
    const unit = ts.unit;
    const cat = buildCatalog(state.bootstrap.form);
    rs.data.entries.forEach((e) => { if (e.form) addForm(cat, e.form); });
    const metaBy = new Map(rs.data.requests.map((m) => [m.pcu, m]));
    const pending = [];
    let doneCount = 0;
    rs.data.entries.forEach((e) => {
      const m = metaBy.get(e.pcu);
      const u = m && m.issue && m.issue.units && m.issue.units[unit];
      if (!u || !u.needed || !e.request) return;
      if (u.done) { doneCount += 1; return; }
      if (ts.late && !adminKeyed(e.request)) return; // past the window: only admin-keyed requests are still recordable (server skips the rest)
      const lines = {}; // code -> {req, item}
      Object.entries(e.request.lines || {}).forEach(([code, l]) => {
        const req = lineQty(l);
        const item = itemOrPlaceholder(cat, code);
        if (req > 0 && (item.dispenseUnit || "") === unit) lines[code] = { req, item };
      });
      pending.push({ pcu: e.pcu, lines });
    });
    rs.pending = pending; rs.doneCount = doneCount; rs.cat = cat;
  }
  const pcuName = (code) => (state.bootstrap.pcus.find((p) => p.code === code) || {}).name || "";

  function skippedHtml(skipped) {
    if (!skipped || !skipped.length) return "";
    return `<div class="notice notice-info" id="t2b-round-skipped">ข้าม ${skipped.length} ใบ: ${skipped.map((s) => `${escapeHtml(s.pcu)}${s.why ? ` (${escapeHtml(s.why)})` : ""}`).join(", ")}</div>`;
  }

  function drawRound() {
    computeRound();
    if (rs.step === 0) return drawRoundSummary();
    if (rs.step === 1) return drawStep1();
    if (rs.step === 2) return drawStep2();
    return drawStep3();
  }

  function drawRoundSummary() {
    const unit = ts.unit;
    const canAct = myUnits.includes(unit) && !ts.expired;
    const n = rs.pending.length;
    host.innerHTML = "";
    const card = el("div", { class: "admin-card t2b-round", id: "t2b-round" });
    card.appendChild(el("h2", {}, `ทั้งรอบ — ขอเบิก ${monthLong(ts.month)} · หน่วย ${unit}`));
    if (ts.expired) card.appendChild(el("div", { class: "notice notice-error", id: "t2b-expired" }, ts.expired + " — ดูได้อย่างเดียว"));
    else if (ts.late) card.appendChild(lateNote());
    card.insertAdjacentHTML("beforeend", `<p class="t2b-meta" id="t2b-round-sum"><span class="badge ${n ? "badge-warn" : "badge-success"}">${n} ใบรอจ่าย</span>
      <span class="badge badge-muted">${rs.doneCount} ใบจ่ายแล้ว</span></p>`);
    if (rs.skipped) card.insertAdjacentHTML("beforeend", skippedHtml(rs.skipped));
    if (n) {
      card.insertAdjacentHTML("beforeend", `<p class="small t2b-round-list" id="t2b-round-pending"><strong>รอจ่าย:</strong> ${rs.pending.map((p) => escapeHtml(`${p.pcu} ${pcuName(p.pcu)}`)).join(" · ")}</p>`);
    } else {
      card.appendChild(el("p", { class: "muted" }, "ไม่มีใบที่รอจ่ายของหน่วยนี้ในรอบนี้"));
    }
    const btns = el("div", { class: "t2b-round-btns" });
    const allBtn = el("button", { type: "button", class: "btn btn-primary", id: "t2b-done-all", disabled: !canAct || !n }, "จ่ายครบทุก รพ.สต.");
    const exBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t2b-except", disabled: !canAct || !n }, "ครบยกเว้น…");
    allBtn.addEventListener("click", doneAll);
    exBtn.addEventListener("click", () => { rs.step = 1; drawRound(); });
    btns.appendChild(allBtn); btns.appendChild(exBtn);
    card.appendChild(btns);
    card.appendChild(el("p", { class: "admin-note t2b-help" }, `"จ่ายครบทุก รพ.สต." = ช่องที่ยังว่างตั้งเป็นตามขอ (ยอดที่กรอกไว้แล้วคงเดิม) แล้วบันทึกว่าหน่วย ${unit} จ่ายใบนั้นแล้ว · "ครบยกเว้น…" = ระบุเฉพาะรายการที่ไม่ครบ ที่เหลือตั้งเป็นตามขอ`));
    host.appendChild(card);
  }

  async function doneAll() {
    const n = rs.pending.length;
    const ok = await confirmDialog(`บันทึกจ่ายครบ ${n} ใบ · ยอดที่กรอกไว้แล้วคงเดิม\n(หน่วย ${ts.unit} · ${monthLong(ts.month)})`, { title: "จ่ายครบทุก รพ.สต.", okText: "จ่ายครบทุก รพ.สต." });
    if (!ok) return;
    const btns = host.querySelectorAll("#t2b-done-all, #t2b-except");
    btns.forEach((b) => { b.disabled = true; });
    try {
      const res = await ctx.adminCall("issueDoneAll", { month: ts.month, unit: ts.unit });
      clearRequestCache();
      toast(`บันทึกจ่ายแล้ว ${(res.done || []).length} ใบ`);
      await reloadRoundKeepSkipped(res.skipped || []);
    } catch (err) {
      btns.forEach((b) => { b.disabled = false; });
      writeError(err, drawRoundSummary);
    }
  }

  async function reloadRoundKeepSkipped(skipped) {
    await loadRound();
    rs.skipped = skipped.length ? skipped : null;
    if (rs.step === 0 && rs.data) drawRoundSummary();
  }

  function wizardHead(title, stepNo) {
    return `<h2>ครบยกเว้น — หน่วย ${escapeHtml(ts.unit)} · ${escapeHtml(monthLong(ts.month))}</h2>
      <p class="t2b-meta"><span class="badge badge-muted">ขั้น ${stepNo}/3</span> <strong>${escapeHtml(title)}</strong></p>`;
  }

  // step 1: pick items (requested by at least one pending request)
  function requestedItems() {
    const map = new Map(); // code -> {item, pcus}
    rs.pending.forEach((p) => Object.entries(p.lines).forEach(([code, l]) => {
      if (!map.has(code)) map.set(code, { code, item: l.item, pcus: 0 });
      map.get(code).pcus += 1;
    }));
    return Array.from(map.values()).sort((a, b) => a.item.stepOrder - b.item.stepOrder || a.code.localeCompare(b.code));
  }

  function drawStep1() {
    host.innerHTML = "";
    const card = el("div", { class: "admin-card t2b-round", id: "t2b-wiz-1" });
    card.insertAdjacentHTML("beforeend", wizardHead("เลือกรายการที่ไม่ครบ", 1));
    const all = requestedItems();
    const search = el("input", { type: "search", class: "search-input", id: "t2b-wiz-search", placeholder: "ค้นหารหัส/ชื่อรายการ", autocomplete: "off", value: rs.search });
    card.appendChild(search);
    const list = el("div", { class: "t2b-wiz-list", id: "t2b-wiz-list" });
    card.appendChild(list);
    const foot = el("div", { class: "t2b-footer" });
    const chip = el("span", { class: "badge badge-muted", id: "t2b-wiz-count" });
    const cancel = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-wiz-cancel" }, "ยกเลิก");
    const next = el("button", { type: "button", class: "btn btn-primary", id: "t2b-wiz-next" }, "ถัดไป");
    const fb = el("span", { class: "t2b-foot-btns" }, [cancel, next]);
    foot.appendChild(chip); foot.appendChild(fb);
    card.appendChild(foot);
    host.appendChild(card);

    function drawList() {
      const f = rs.search.trim().toLowerCase();
      const shown = all.filter((x) => !f || x.code.toLowerCase().includes(f) || x.item.name.toLowerCase().includes(f));
      list.innerHTML = shown.length ? shown.map((x) => `<label class="t2b-wiz-item"><input type="checkbox" value="${escapeHtml(x.code)}" ${rs.selected.has(x.code) ? "checked" : ""}>
        <span><span class="code-cell">${escapeHtml(x.code)}</span> ${escapeHtml(x.item.name)}${x.item.unit ? ` <span class="muted small">(${escapeHtml(x.item.unit)})</span>` : ""}
        <span class="muted small">· ${x.pcus} แห่งขอ</span></span></label>`).join("") : `<p class="muted">ไม่พบรายการ</p>`;
    }
    function refreshNext() {
      chip.textContent = `เลือกแล้ว ${rs.selected.size} รายการ`;
      next.disabled = !rs.selected.size;
    }
    drawList(); refreshNext();
    search.addEventListener("input", () => { rs.search = search.value; drawList(); });
    list.addEventListener("change", (ev) => {
      const cb = ev.target;
      if (!cb || cb.type !== "checkbox") return;
      if (cb.checked) rs.selected.add(cb.value); else rs.selected.delete(cb.value);
      refreshNext();
    });
    cancel.addEventListener("click", () => { rs.step = 0; drawRound(); });
    next.addEventListener("click", () => { rs.step = 2; rs.bad = new Set(); drawRound(); });
  }

  // step 2: per-PCU figures for the selected items
  const cellKey = (code, pcu) => `${code}|${pcu}`;
  function selectedCodes() { return requestedItems().map((x) => x.code).filter((c) => rs.selected.has(c)); }

  function drawStep2() {
    const codes = selectedCodes();
    const pcus = rs.pending.filter((p) => codes.some((c) => p.lines[c]));
    host.innerHTML = "";
    const card = el("div", { class: "admin-card t2b-round", id: "t2b-wiz-2" });
    card.insertAdjacentHTML("beforeend", wizardHead("กรอกยอดที่ได้จริง (ต้องกรอกทุกช่อง)", 2));
    const head = codes.map((c) => {
      const it = rs.cat.byCode[c] || itemOrPlaceholder(rs.cat, c);
      return `<th class="num" title="${escapeHtml(it.name)}">${escapeHtml(c)}<div class="muted small t2b-wiz-colname">${escapeHtml(it.name)}</div></th>`;
    }).join("");
    const body = pcus.map((p) => `<tr data-pcu="${escapeHtml(p.pcu)}"><td class="left"><strong>${escapeHtml(p.pcu)}</strong> ${escapeHtml(pcuName(p.pcu))}</td>${codes.map((c) => {
      const l = p.lines[c];
      if (!l) return `<td class="num muted">–</td>`;
      const v = rs.vals.get(cellKey(c, p.pcu));
      return `<td class="t2b-in-cell"><div class="small">ขอ ${formatInt(l.req)}</div>
        <input class="t2b-in t2b-wiz-in${rs.bad.has(cellKey(c, p.pcu)) ? " input-error" : ""}" type="text" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="ได้"
        data-code="${escapeHtml(c)}" data-pcu="${escapeHtml(p.pcu)}" data-req="${l.req}" value="${v === undefined || v === null ? "" : v}" aria-label="ได้ ${escapeHtml(c)} ${escapeHtml(p.pcu)}"></td>`;
    }).join("")}</tr>`).join("");
    card.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table t2b-table" id="t2b-wiz-tbl"><thead><tr><th class="left">รพ.สต.</th>${head}</tr></thead><tbody>${body}</tbody></table>`));
    const zero = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-wiz-zero" }, "ตั้งทุกช่อง = 0");
    card.appendChild(el("p", {}, zero));
    card.insertAdjacentHTML("beforeend", `<div class="t2b-wiz-reason" id="t2b-wiz-reason"><strong>เหตุผลที่จ่ายไม่ครบ:</strong>
      <label><input type="radio" name="t2b-wiz-reason" value="out_of_stock" ${rs.reason === "out_of_stock" ? "checked" : ""}> ของหมด/รอจัดซื้อ</label>
      <label><input type="radio" name="t2b-wiz-reason" value="other" ${rs.reason === "other" ? "checked" : ""}> อื่น ๆ</label>
      <input class="t2b-note t2b-wiz-note" id="t2b-wiz-note" type="text" maxlength="200" placeholder="${notePlaceholder(rs.reason)}" value="${escapeHtml(rs.note)}"></div>`);
    const foot = el("div", { class: "t2b-footer" });
    const err = el("span", { class: "admin-err-text t2b-err", id: "t2b-wiz-err", hidden: true });
    const back = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-wiz-back" }, "ย้อนกลับ");
    const cancel = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-wiz-cancel" }, "ยกเลิก");
    const next = el("button", { type: "button", class: "btn btn-primary", id: "t2b-wiz-next" }, "ถัดไป");
    foot.appendChild(err); foot.appendChild(el("span", { class: "t2b-foot-btns" }, [back, cancel, next]));
    card.appendChild(foot);
    host.appendChild(card);

    card.querySelectorAll(".t2b-wiz-in").forEach((input) => {
      input.addEventListener("input", () => {
        const req = Number(input.dataset.req);
        let digits = input.value.replace(/[^0-9]/g, "").slice(0, 5);
        let v = digits === "" ? null : parseInt(digits, 10);
        if (v !== null && v > req) { v = req; digits = String(req); }
        if (digits !== input.value) input.value = digits;
        input.classList.remove("input-error");
        rs.bad.delete(cellKey(input.dataset.code, input.dataset.pcu));
        rs.vals.set(cellKey(input.dataset.code, input.dataset.pcu), v);
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        const all = Array.from(card.querySelectorAll(".t2b-wiz-in"));
        const nx = all[all.indexOf(input) + 1];
        if (nx) nx.focus();
      });
    });
    zero.addEventListener("click", () => {
      card.querySelectorAll(".t2b-wiz-in").forEach((i) => { i.value = "0"; i.classList.remove("input-error"); rs.vals.set(cellKey(i.dataset.code, i.dataset.pcu), 0); });
      rs.bad = new Set();
    });
    const noteIn = card.querySelector("#t2b-wiz-note");
    card.querySelectorAll('input[name="t2b-wiz-reason"]').forEach((r) => r.addEventListener("change", () => {
      rs.reason = r.value;
      noteIn.placeholder = notePlaceholder(rs.reason);
      if (rs.reason === "other") noteIn.focus();
    }));
    noteIn.addEventListener("input", () => { rs.note = noteIn.value; noteIn.classList.remove("input-error"); });
    back.addEventListener("click", () => { rs.step = 1; drawRound(); });
    cancel.addEventListener("click", () => { rs.step = 0; drawRound(); });
    next.addEventListener("click", () => {
      rs.bad = new Set();
      let first = null, msg = "";
      card.querySelectorAll(".t2b-wiz-in").forEach((i) => {
        if (i.value === "") { rs.bad.add(cellKey(i.dataset.code, i.dataset.pcu)); i.classList.add("input-error"); if (!first) { first = i; msg = "กรอกยอดที่ได้ให้ครบทุกช่อง (0…ขอ)"; } }
      });
      if (!first) {
        const n = rs.note.trim();
        if (!n && rs.reason === "other") { first = noteIn; msg = "ระบุเหตุผล (อื่น ๆ)"; } else if (n.length > 200) { first = noteIn; msg = "หมายเหตุยาวเกิน 200 ตัวอักษร"; }
        if (first) noteIn.classList.add("input-error");
      }
      if (first) {
        err.textContent = msg; err.hidden = false;
        first.scrollIntoView({ block: "center", behavior: "smooth" });
        first.focus();
        return;
      }
      rs.step = 3; drawRound();
    });
  }

  // step 3: summary + confirm
  function otherLineCount() {
    const sel = rs.selected;
    let x = 0;
    rs.pending.forEach((p) => Object.keys(p.lines).forEach((c) => { if (!sel.has(c)) x += 1; }));
    return x;
  }

  function drawStep3() {
    const n = rs.pending.length;
    host.innerHTML = "";
    const card = el("div", { class: "admin-card t2b-round", id: "t2b-wiz-3" });
    card.insertAdjacentHTML("beforeend", wizardHead("ตรวจสอบและยืนยัน", 3));
    const x = otherLineCount();
    card.insertAdjacentHTML("beforeend", `<ul class="t2b-wiz-sum" id="t2b-wiz-sum">
      <li>รายการที่เลือก ${rs.selected.size} รายการ ตามที่กรอก (${escapeHtml(rs.reason === "other" ? "เหตุผล: " + rs.note.trim() : "เหตุผล: ของหมด/รอจัดซื้อ" + (rs.note.trim() ? " — " + rs.note.trim() : ""))})</li>
      <li>รายการอื่น ${formatInt(x)} บรรทัด จะตั้ง = ขอ (ทับยอดที่กรอกไว้)</li>
      <li>ใบ ${n} ใบ จะเป็นจ่ายแล้ว (หน่วย ${escapeHtml(ts.unit)})</li></ul>`);
    const foot = el("div", { class: "t2b-footer" });
    const err = el("span", { class: "admin-err-text t2b-err", id: "t2b-wiz-err", hidden: true });
    const back = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-wiz-back" }, "ย้อนกลับ");
    const cancel = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-wiz-cancel" }, "ยกเลิก");
    const go = el("button", { type: "button", class: "btn btn-primary", id: "t2b-wiz-confirm" }, "ยืนยันบันทึกการจ่าย");
    foot.appendChild(err); foot.appendChild(el("span", { class: "t2b-foot-btns" }, [back, cancel, go]));
    card.appendChild(foot);
    host.appendChild(card);
    back.addEventListener("click", () => { rs.step = 2; drawRound(); });
    cancel.addEventListener("click", () => { rs.step = 0; drawRound(); });
    go.addEventListener("click", async () => {
      const items = {};
      selectedCodes().forEach((c) => {
        items[c] = {};
        rs.pending.forEach((p) => { if (p.lines[c]) items[c][p.pcu] = rs.vals.get(cellKey(c, p.pcu)); });
      });
      const params = { month: ts.month, unit: ts.unit, items, reason: rs.reason };
      if (rs.note.trim()) params.note = rs.note.trim(); // 2ae: also with "ของหมด"
      go.disabled = true;
      try {
        const res = await ctx.adminCall("issueExcept", params);
        clearRequestCache();
        toast(`บันทึกจ่ายแล้ว ${(res.done || []).length} ใบ` + (res.lines != null ? ` · ${res.lines} บรรทัด` : ""));
        await reloadRoundKeepSkipped(res.skipped || []);
      } catch (e) {
        go.disabled = false;
        if (e && e.code === "FORBIDDEN" && /หมดเวลา/.test(e.message || "")) { writeError(e, () => { rs.step = 0; drawRound(); }); return; }
        err.textContent = errMessage(e); err.hidden = false;
        toast(errMessage(e), "err");
      }
    });
  }

  return { load: loadRound };
}
