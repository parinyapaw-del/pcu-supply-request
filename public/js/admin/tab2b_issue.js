// Tab "จ่ายจริง" (phase 2.md §5.4, functions/API.md issue actions — 2c).
// Two modes: ต่อใบ (one PCU + month: adminGetRequest -> issueLines / issueAll / issueDone) and
// ต่อรายการ (one item across the network: adminItemIssue -> issueItem).
// OP-first split of the issued total is shown live (compute.js splitIssued); the server applies the same rule.
// A dispenser only receives lines of its own units (API filter) and may write until the end of the month after
// the request month — the server answers FORBIDDEN "หมดเวลา…" afterwards (admin.js keeps the session for it).
import { formatInt, formatMoney, nextMonthKey, compareMonthKey } from "../format.js";
import { el, escapeHtml, tableScroll, monthLong, formatBangkokDateTime, confirmDialog, toast, errMessage } from "./util.js";
import { buildCatalog, addForm, DISPENSE_UNITS, ISSUE_REASONS, splitIssued, isUsableStatus, itemOrPlaceholder } from "./compute.js";
import { clearRequestCache } from "./requests.js";
import { unitStripHtml } from "./tab1_status.js";

const EXPIRED_MSG = "หมดเวลาแก้ไขการจ่าย (แก้ได้ถึงสิ้นเดือนถัดไป)";
const STATUS_LABEL = { draft: "แบบร่าง", submitted: "ส่งแล้ว", issued: "จ่ายแล้ว" };

function whoLabel(who) {
  if (!who) return "–";
  return who === "backup" ? "รหัสสำรอง" : who;
}

function numOrNull(v) {
  return v === null || v === undefined || v === "" ? null : Number(v);
}

// ---- line editor (shared by both modes) -------------------------------------------------------------
// rows: [{key, label, op, pp, req, base:{total, reason, note}, disabled}]. Rows are <tr data-key="…"> rendered by
// the caller with inputCell / gotCells / reasonCell; wire(host) attaches the listeners.
function createEditor(rows, { onChange } = {}) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const draft = new Map(rows.map((r) => [r.key, { ...r.base }]));
  let host = null;

  const isShort = (d, r) => d.total !== null && d.total < r.req;
  function norm(d, r) {
    if (!isShort(d, r)) return { total: d.total, reason: null, note: null };
    const reason = d.reason || null;
    return { total: d.total, reason, note: reason === "other" ? ((d.note || "").trim() || null) : null };
  }
  const same = (a, b) => a.total === b.total && a.reason === b.reason && a.note === b.note;
  function isChanged(key) {
    const r = byKey.get(key);
    return !same(norm(draft.get(key), r), norm(r.base, r));
  }
  function changedKeys() { return rows.filter((r) => !r.disabled && isChanged(r.key)).map((r) => r.key); }

  const q = (key, sel) => host && host.querySelector(`tr[data-key="${CSS.escape(key)}"] ${sel}`);

  function refreshRow(key) {
    const r = byKey.get(key);
    const d = draft.get(key);
    const got = splitIssued(r.op, r.pp, d.total);
    const gop = q(key, ".t2b-gop"), gpp = q(key, ".t2b-gpp");
    if (gop) gop.textContent = got ? formatInt(got.op) : "—";
    if (gpp) gpp.textContent = got ? formatInt(got.pp) : "—";
    const short = isShort(d, r);
    const sel = q(key, ".t2b-reason"), note = q(key, ".t2b-note");
    if (sel) { sel.disabled = r.disabled || !short; sel.value = short ? (d.reason || "") : ""; }
    if (note) { note.hidden = !(short && d.reason === "other"); note.disabled = r.disabled; }
    const tr = host && host.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
    if (tr) {
      tr.classList.toggle("t2b-changed", !r.disabled && isChanged(key));
      tr.classList.toggle("t2b-short", short);
    }
  }

  function setHint(key, text) {
    const h = q(key, ".t2b-hint");
    if (!h) return;
    h.textContent = text || "";
    clearTimeout(h._t);
    if (text) h._t = setTimeout(() => { h.textContent = ""; }, 3000);
  }

  function wire(container) {
    host = container;
    rows.forEach((r) => {
      const input = q(r.key, ".t2b-in");
      const sel = q(r.key, ".t2b-reason");
      const note = q(r.key, ".t2b-note");
      if (input) {
        input.addEventListener("input", () => {
          let digits = input.value.replace(/[^0-9]/g, "").slice(0, 5);
          let v = digits === "" ? null : parseInt(digits, 10);
          if (v !== null && v > r.req) {
            v = r.req; digits = String(r.req);
            setHint(r.key, `จ่ายเกินขอไม่ได้ (ขอ ${formatInt(r.req)})`);
          }
          if (digits !== input.value) input.value = digits;
          input.classList.remove("input-error");
          draft.get(r.key).total = v;
          refreshRow(r.key);
          if (onChange) onChange();
        });
        input.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter") return;
          ev.preventDefault();
          const all = Array.from(host.querySelectorAll(".t2b-in:not([disabled])"));
          const next = all[all.indexOf(input) + 1];
          if (next) next.focus();
        });
      }
      if (sel) sel.addEventListener("change", () => {
        sel.classList.remove("input-error");
        draft.get(r.key).reason = sel.value || null;
        refreshRow(r.key);
        if (sel.value === "other" && note) note.focus();
        if (onChange) onChange();
      });
      if (note) note.addEventListener("input", () => {
        note.classList.remove("input-error");
        draft.get(r.key).note = note.value;
        refreshRow(r.key);
        if (onChange) onChange();
      });
      refreshRow(r.key);
    });
  }

  // First problem among changed rows (in row order) -> {key, msg, el} or null.
  function validate() {
    for (const key of changedKeys()) {
      const r = byKey.get(key), d = draft.get(key);
      if (d.total !== null && d.total > r.req) return { key, msg: `${r.label}: จ่ายเกินขอไม่ได้ (ขอ ${r.req})`, el: q(key, ".t2b-in") };
      if (!isShort(d, r)) continue;
      if (!d.reason) return { key, msg: `${r.label}: จ่ายไม่ครบ — เลือกเหตุผล`, el: q(key, ".t2b-reason") };
      if (d.reason === "other") {
        const n = (d.note || "").trim();
        if (!n) return { key, msg: `${r.label}: ระบุเหตุผล (อื่น ๆ)`, el: q(key, ".t2b-note") };
        if (n.length > 200) return { key, msg: `${r.label}: เหตุผลยาวเกิน 200 ตัวอักษร`, el: q(key, ".t2b-note") };
      }
    }
    return null;
  }

  function payload() {
    const out = {};
    changedKeys().forEach((key) => {
      const n = norm(draft.get(key), byKey.get(key));
      out[key] = { issued_total: n.total, reason: n.reason, note: n.note };
    });
    return out;
  }

  function setValue(key, total, reason, note) {
    const r = byKey.get(key);
    if (!r || r.disabled) return;
    draft.set(key, { total, reason, note: note || "" });
    const input = q(key, ".t2b-in");
    if (input) input.value = total === null ? "" : String(total);
    const n = q(key, ".t2b-note");
    if (n) n.value = note || "";
    refreshRow(key);
  }

  return {
    wire, validate, payload, changedKeys,
    dirtyCount: () => changedKeys().length,
    draftOf: (key) => draft.get(key),
    setAllZero() { rows.forEach((r) => setValue(r.key, 0, r.req > 0 ? "out_of_stock" : null, "")); if (onChange) onChange(); },
    revert() { rows.forEach((r) => setValue(r.key, r.base.total, r.base.reason, r.base.note)); if (onChange) onChange(); }
  };
}

function inputCell(r) {
  const d = r.base;
  return `<td class="t2b-in-cell"><input class="t2b-in" type="text" inputmode="numeric" maxlength="5" autocomplete="off"
    placeholder="${r.req}" value="${d.total === null ? "" : d.total}" aria-label="จ่ายจริง ${escapeHtml(r.label)}" ${r.disabled ? "disabled" : ""}>
    <div class="t2b-hint" aria-live="polite"></div></td>`;
}
function gotCells() {
  return `<td class="num t2b-gop">—</td><td class="num t2b-gpp">—</td>`;
}
function reasonCell(r) {
  const opts = [`<option value="">—</option>`]
    .concat(Object.entries(ISSUE_REASONS).map(([v, label]) => `<option value="${v}">${escapeHtml(label)}</option>`)).join("");
  return `<td class="left t2b-reason-cell"><select class="t2b-reason select-input" aria-label="เหตุผล ${escapeHtml(r.label)}" disabled>${opts}</select>
    <input class="t2b-note" type="text" maxlength="200" placeholder="ระบุเหตุผล" value="${escapeHtml(r.base.note || "")}" hidden ${r.disabled ? "disabled" : ""}></td>`;
}

export function renderTab2b(container, ctx) {
  const { state } = ctx;
  const me = state.me || { units: [] };
  const myUnits = state.isAdmin ? DISPENSE_UNITS : (me.units || []);
  const ts = {
    mode: "sheet", month: state.bootstrap.current_month,
    pcu: (state.bootstrap.pcus[0] || {}).code || "", itemCode: "", filter: "",
    sheet: null, item: null, editor: null, expired: null, seq: 0, visible: false
  };

  container.innerHTML = "";
  if (!state.bootstrap.pcus || !state.bootstrap.pcus.length) {
    container.appendChild(el("div", { class: "notice notice-info" }, "ยังไม่มี รพ.สต. ในระบบ — นำเข้าข้อมูลตั้งต้นก่อน"));
    return null;
  }

  // ---- toolbar -----------------------------------------------------------------------------------------
  const toolbar = el("div", { class: "admin-toolbar" });
  const seg = el("div", { class: "admin-seg", role: "group", id: "t2b-mode" }, [
    el("button", { type: "button", "data-mode": "sheet", class: "active", id: "t2b-mode-sheet" }, "ต่อใบ"),
    el("button", { type: "button", "data-mode": "item", id: "t2b-mode-item" }, "ต่อรายการ")
  ]);
  const monthSel = el("select", { class: "select-input", id: "t2b-month", "aria-label": "เลือกเดือน" });
  const pcuSel = el("select", { class: "select-input", id: "t2b-pcu", "aria-label": "เลือก รพ.สต." });
  state.bootstrap.pcus.forEach((p) => pcuSel.appendChild(el("option", { value: p.code }, `${p.code} ${p.name}`)));
  const pcuLabel = el("label", { id: "t2b-pcu-label" }, ["รพ.สต.: ", pcuSel]);
  const filterInput = el("input", { type: "search", class: "search-input", id: "t2b-filter", placeholder: "ค้นหารหัส/ชื่อรายการ", autocomplete: "off" });
  const itemSel = el("select", { class: "select-input t2b-item-select", id: "t2b-item", "aria-label": "เลือกรายการ" });
  const itemLabel = el("label", { id: "t2b-item-label", class: "t2b-item-label" }, ["รายการ: ", itemSel]);
  const refreshBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-refresh" }, "รีเฟรช");
  toolbar.appendChild(seg);
  toolbar.appendChild(el("label", {}, ["เดือน: ", monthSel]));
  toolbar.appendChild(pcuLabel);
  toolbar.appendChild(filterInput);
  toolbar.appendChild(itemLabel);
  toolbar.appendChild(refreshBtn);
  container.appendChild(toolbar);
  const host = el("div", { id: "t2b-host" });
  container.appendChild(host);

  function months() {
    const set = new Set((state.bootstrap.rounds || []).map((r) => r.month));
    set.add(state.bootstrap.current_month); set.add(ts.month);
    return Array.from(set).sort().reverse();
  }
  function fillMonths() {
    monthSel.innerHTML = "";
    months().forEach((m) => monthSel.appendChild(el("option", { value: m, selected: m === ts.month }, monthLong(m) + (m === state.bootstrap.current_month ? " (เดือนนี้)" : ""))));
  }

  // items for the ต่อรายการ select — dispenser: only items of its units
  function fillItems() {
    const f = ts.filter.trim().toLowerCase();
    const items = state.cat.items.filter((it) => myUnits.includes(it.dispenseUnit)
      && (!f || it.code.toLowerCase().includes(f) || it.name.toLowerCase().includes(f)));
    itemSel.innerHTML = "";
    itemSel.appendChild(el("option", { value: "" }, items.length ? `— เลือกรายการ (${items.length}) —` : "— ไม่พบรายการ —"));
    let group = null, groupKey = null;
    items.forEach((it) => {
      if (it.stepCode !== groupKey) {
        groupKey = it.stepCode;
        group = el("optgroup", { label: `หน้า ${it.pageNo ?? "–"} — ${it.sheet} (${it.dispenseUnit})` });
        itemSel.appendChild(group);
      }
      group.appendChild(el("option", { value: it.code, selected: it.code === ts.itemCode },
        `${it.code} — ${it.name}${it.unit ? ` (${it.unit})` : ""}${it.active ? "" : " [ปิดแล้ว]"}`));
    });
    if (ts.itemCode && !items.some((it) => it.code === ts.itemCode)) {
      const it = state.cat.byCode[ts.itemCode];
      if (it) itemSel.appendChild(el("option", { value: it.code, selected: true }, `${it.code} — ${it.name}`));
    }
  }

  function showModeControls() {
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === ts.mode));
    pcuLabel.style.display = ts.mode === "sheet" ? "" : "none";
    filterInput.style.display = ts.mode === "item" ? "" : "none";
    itemLabel.style.display = ts.mode === "item" ? "" : "none";
  }

  function windowExpired(month) {
    return !state.isAdmin && compareMonthKey(state.bootstrap.current_month, nextMonthKey(month)) > 0;
  }

  async function guardDirty() {
    const n = ts.editor ? ts.editor.dirtyCount() : 0;
    if (!n) return true;
    return confirmDialog(`มีการแก้ไขที่ยังไม่บันทึก ${n} รายการ — ทิ้งการแก้ไขนี้?`, { title: "ยังไม่ได้บันทึก", okText: "ทิ้งการแก้ไข", danger: true });
  }

  function load() {
    ts.expired = windowExpired(ts.month) ? EXPIRED_MSG : null;
    ts.editor = null;
    if (ts.mode === "sheet") loadSheet(); else loadItem();
  }

  // control events (each guarded by the dirty check; a refused change restores the select)
  seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.mode === ts.mode) return;
    if (!(await guardDirty())) return;
    ts.mode = b.dataset.mode;
    showModeControls();
    if (ts.mode === "item") fillItems();
    load();
  }));
  monthSel.addEventListener("change", async () => {
    if (!(await guardDirty())) { monthSel.value = ts.month; return; }
    ts.month = monthSel.value; load();
  });
  pcuSel.addEventListener("change", async () => {
    if (!(await guardDirty())) { pcuSel.value = ts.pcu; return; }
    ts.pcu = pcuSel.value; load();
  });
  itemSel.addEventListener("change", async () => {
    if (!(await guardDirty())) { itemSel.value = ts.itemCode; return; }
    ts.itemCode = itemSel.value; load();
  });
  filterInput.addEventListener("input", () => { ts.filter = filterInput.value; fillItems(); });
  refreshBtn.addEventListener("click", async () => { if (await guardDirty()) load(); });

  function loadingHtml(msg) { return `<div class="admin-loading-block"><div class="admin-spinner"></div>${escapeHtml(msg)}</div>`; }

  // Writes: FORBIDDEN "หมดเวลา…" -> notice + read-only; anything else -> toast + footer message.
  function writeError(err, redraw) {
    if (err && err.code === "FORBIDDEN" && /หมดเวลา/.test(err.message || "")) {
      ts.expired = err.message;
      toast(err.message, "err");
      redraw();
      return;
    }
    toast(errMessage(err), "err");
    const box = host.querySelector(".t2b-err");
    if (box) { box.textContent = errMessage(err); box.hidden = false; }
  }

  function footerHtml(extraButtons) {
    return `<div class="t2b-footer">
      <span class="badge badge-warn t2b-dirty" hidden></span>
      <span class="admin-err-text t2b-err" hidden></span>
      <span class="t2b-foot-btns">${extraButtons}
        <button type="button" class="btn btn-secondary btn-sm" data-act="revert" disabled>คืนค่าเดิม</button>
        <button type="button" class="btn btn-primary" data-act="save" disabled>บันทึกการจ่าย</button></span></div>`;
  }
  function refreshFooter() {
    const n = ts.editor ? ts.editor.dirtyCount() : 0;
    const chip = host.querySelector(".t2b-dirty");
    if (chip) { chip.hidden = !n; chip.textContent = `ยังไม่บันทึก ${n} รายการ`; }
    host.querySelectorAll('[data-act="save"], [data-act="revert"]').forEach((b) => { b.disabled = !n || !!ts.expired; });
    const err = host.querySelector(".t2b-err");
    if (err && !n) err.hidden = true;
  }
  function showFirstError(problem) {
    const box = host.querySelector(".t2b-err");
    if (box) { box.textContent = problem.msg; box.hidden = false; }
    if (problem.el) {
      problem.el.classList.add("input-error");
      problem.el.scrollIntoView({ block: "center", behavior: "smooth" });
      problem.el.focus();
    }
  }

  // ======================================== ต่อใบ ========================================
  async function loadSheet() {
    const my = ++ts.seq;
    host.innerHTML = loadingHtml("กำลังโหลดใบเบิก...");
    try {
      const data = await ctx.adminCall("adminGetRequest", { pcu: ts.pcu, month: ts.month });
      if (my !== ts.seq) return;
      ts.sheet = { request: data.request, form: data.form, issue: data.issue || null };
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
    head.appendChild(el("h2", {}, `${pcu.code} ${pcu.name} — ${monthLong(ts.month)}`));
    host.appendChild(head);
    if (!request || !isUsableStatus(request.status)) {
      head.appendChild(el("div", { class: "notice notice-info", id: "t2b-not-sent" },
        "ยังไม่ได้ส่งใบเบิก" + (request && request.status === "draft" ? " (แบบร่าง — ยังบันทึกการจ่ายไม่ได้)" : "")));
      return;
    }
    head.insertAdjacentHTML("beforeend", `<p class="t2b-meta"><span class="badge ${request.status === "issued" ? "badge-success" : "badge-muted"}">${escapeHtml(STATUS_LABEL[request.status] || request.status)}</span>
      <span class="small">ส่งเมื่อ ${escapeHtml(formatBangkokDateTime(request.submitted_at))}</span>
      ${issue ? `<span class="small t2b-sum">· จ่ายแล้ว ${issue.units_done}/${issue.units_total} หน่วย · ครบ ${issue.complete} · ไม่ครบ ${issue.incomplete} รายการ</span>` : ""}</p>
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
          <td class="left name-cell"><span class="code-cell">${escapeHtml(it.code)}</span> ${escapeHtml(it.name)}${it.unit ? ` <span class="muted small">(${escapeHtml(it.unit)})</span>` : ""}</td>
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

  // ======================================== ต่อรายการ ========================================
  async function loadItem() {
    const my = ++ts.seq;
    if (!ts.itemCode) {
      ts.item = null;
      host.innerHTML = `<div class="admin-card"><p class="muted">เลือกรายการเพื่อบันทึกการจ่ายทุก รพ.สต. ในเดือนนี้</p></div>`;
      return;
    }
    host.innerHTML = loadingHtml("กำลังโหลด...");
    try {
      const data = await ctx.adminCall("adminItemIssue", { month: ts.month, item_code: ts.itemCode });
      if (my !== ts.seq) return;
      ts.item = data;
      drawItem();
    } catch (err) {
      if (my !== ts.seq) return;
      if (err && err.code === "FORBIDDEN") { host.innerHTML = `<div class="notice notice-error">${escapeHtml(errMessage(err))}</div>`; return; }
      host.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    }
  }

  function drawItem(skipped) {
    const { item, rows } = ts.item;
    host.innerHTML = "";
    ts.editor = null;
    const head = el("div", { class: "admin-card t2b-head", id: "t2b-item-head" });
    head.appendChild(el("h2", {}, `${item.code} ${item.name}`));
    head.appendChild(el("p", { class: "t2b-meta small" },
      `${monthLong(ts.month)} · หน่วย ${item.unit || "–"} · ราคา ${formatMoney(item.price)} บาท · หน้า ${item.step || "–"}${item.step_title ? " " + item.step_title : ""} · หน่วยจ่าย ${item.dispense_unit || "–"}`));
    if (ts.expired) head.appendChild(el("div", { class: "notice notice-error", id: "t2b-expired" }, ts.expired + " — ดูได้อย่างเดียว"));
    host.appendChild(head);
    if (skipped && skipped.length) {
      const names = skipped.map((s) => `${s.pcu}${s.why ? ` (${s.why})` : ""}`).join(", ");
      host.appendChild(el("div", { class: "notice notice-info", id: "t2b-skipped" }, `ข้าม ${skipped.length} แห่ง: ${names}`));
    }
    if (!rows.length) {
      host.appendChild(el("div", { class: "admin-card" }, el("p", { class: "muted" }, "ไม่มี รพ.สต. ที่ขอรายการนี้ในเดือนนี้ (นับเฉพาะใบที่ส่งแล้ว)")));
      return;
    }
    const pcuName = (code) => (state.bootstrap.pcus.find((p) => p.code === code) || {}).name || "";
    const canAct = myUnits.includes(item.dispense_unit) && !ts.expired;
    const erows = rows.map((r) => ({
      key: r.pcu, label: r.pcu, op: Number(r.op) || 0, pp: Number(r.pp) || 0, req: Number(r.requested) || ((Number(r.op) || 0) + (Number(r.pp) || 0)),
      base: { total: numOrNull(r.issued_total), reason: r.reason || null, note: r.note || "" },
      disabled: !!r.unit_done || !canAct, r
    }));
    const editor = createEditor(erows, { onChange: () => { refreshFooter(); refreshItemTotals(); } });
    ts.editor = editor;
    let sOp = 0, sPp = 0;
    const body = erows.map((er) => {
      const r = er.r;
      sOp += er.op; sPp += er.pp;
      return `<tr data-key="${escapeHtml(er.key)}">
        <td class="left"><strong>${escapeHtml(r.pcu)}</strong> ${escapeHtml(r.pcu_name || pcuName(r.pcu))}</td>
        <td class="left"><span class="badge ${r.status === "issued" ? "badge-success" : "badge-muted"}">${escapeHtml(STATUS_LABEL[r.status] || r.status)}</span></td>
        <td class="num">${formatInt(er.op)}</td><td class="num">${formatInt(er.pp)}</td><td class="num"><strong>${formatInt(er.req)}</strong></td>
        ${inputCell(er)}${gotCells()}${reasonCell(er)}
        <td class="t2b-done-cell">${r.unit_done ? '<span class="badge badge-success" title="หน่วยจ่ายบันทึกว่าจ่ายใบนี้แล้ว — แก้ที่โหมดต่อใบหลังยกเลิกสถานะ">✓</span>' : '<span class="muted">○</span>'}</td></tr>`;
    }).join("");
    const card = el("div", { class: "admin-card" });
    card.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table t2b-table" id="t2b-item-tbl">
      <thead><tr><th class="left">รพ.สต.</th><th class="left">สถานะใบ</th><th class="num">ขอ OP</th><th class="num">ขอ PP</th><th class="num">ขอรวม</th>
      <th class="num">จ่ายจริง</th><th class="num">ได้ OP</th><th class="num">ได้ PP</th><th class="left">เหตุผล / หมายเหตุ</th><th>หน่วยจ่ายแล้ว</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr class="grand-row"><td class="left" colspan="2">รวม ${erows.length} แห่ง</td><td class="num">${formatInt(sOp)}</td><td class="num">${formatInt(sPp)}</td><td class="num">${formatInt(sOp + sPp)}</td>
      <td class="num" id="t2b-item-sum">—</td><td colspan="4"></td></tr></tfoot></table>`));
    host.appendChild(card);
    const zeroBtn = canAct ? `<button type="button" class="btn btn-secondary btn-sm" data-act="zero" id="t2b-zero">ตั้งทุกแห่ง = 0 (ของหมด)</button>` : "";
    host.insertAdjacentHTML("beforeend", footerHtml(zeroBtn));
    editor.wire(host);
    const z = host.querySelector('[data-act="zero"]');
    if (z) z.addEventListener("click", () => editor.setAllZero());
    host.querySelector('[data-act="save"]').addEventListener("click", saveItem);
    host.querySelector('[data-act="revert"]').addEventListener("click", () => editor.revert());
    refreshFooter();
    refreshItemTotals();
  }

  function refreshItemTotals() {
    const cell = host.querySelector("#t2b-item-sum");
    if (!cell || !ts.editor || !ts.item) return;
    let sum = 0, any = false;
    ts.item.rows.forEach((r) => { const d = ts.editor.draftOf(r.pcu); if (d && d.total !== null) { sum += d.total; any = true; } });
    cell.textContent = any ? formatInt(sum) : "—";
  }

  async function saveItem() {
    const editor = ts.editor;
    if (!editor) return;
    const problem = editor.validate();
    if (problem) { showFirstError(problem); return; }
    const entries = editor.payload();
    if (!Object.keys(entries).length) return;
    const btn = host.querySelector('[data-act="save"]');
    if (btn) btn.disabled = true;
    try {
      const res = await ctx.adminCall("issueItem", { month: ts.month, item_code: ts.itemCode, entries });
      clearRequestCache();
      const updated = res.updated || [], skipped = res.skipped || [];
      toast(`บันทึกแล้ว ${updated.length} แห่ง` + (skipped.length ? ` · ข้าม ${skipped.length} แห่ง` : ""));
      const data = await ctx.adminCall("adminItemIssue", { month: ts.month, item_code: ts.itemCode });
      ts.item = data;
      drawItem(skipped);
    } catch (err) {
      if (btn) btn.disabled = false;
      writeError(err, () => drawItem());
    }
  }

  // ---- lifecycle -----------------------------------------------------------------------------------
  // "#issue?pcu=PCU02&month=2026-10" (from the status tab's "จ่าย" button) preselects ต่อใบ.
  function readParams() {
    const h = location.hash;
    const i = h.indexOf("?");
    if (i < 0 || !h.startsWith("#issue")) return null;
    const sp = new URLSearchParams(h.slice(i + 1));
    const pcu = sp.get("pcu"), month = sp.get("month");
    if (!pcu && !month) return null;
    return { pcu, month };
  }

  function onBeforeUnload(ev) {
    if (ts.visible && ts.editor && ts.editor.dirtyCount()) { ev.preventDefault(); ev.returnValue = ""; }
  }
  window.addEventListener("beforeunload", onBeforeUnload);

  fillMonths();
  pcuSel.value = ts.pcu;
  showModeControls();
  let loaded = false;

  return {
    async onShow() {
      ts.visible = true;
      const p = readParams(); // read before the first await: admin.js strips the params right after onShow
      if (p) {
        if (await guardDirty()) {
          ts.mode = "sheet";
          if (p.pcu && state.bootstrap.pcus.some((x) => x.code === p.pcu)) ts.pcu = p.pcu;
          if (p.month && /^\d{4}-\d{2}$/.test(p.month)) ts.month = p.month;
          fillMonths(); pcuSel.value = ts.pcu; showModeControls();
          loaded = true;
          load();
          return;
        }
      }
      fillMonths();
      if (!loaded) { loaded = true; load(); }
    },
    onHide() { ts.visible = false; }
  };
}
