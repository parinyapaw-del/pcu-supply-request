// Tab "จ่ายจริง" (phase 2.md §5.4, functions/API.md issue actions — 2c).
// Three modes: ต่อใบ (tab2b_sheet.js), ต่อรายการ (tab2b_item.js), ทั้งรอบ (tab2b_round.js); the line editor is tab2b_editor.js.
// A dispenser only receives lines of its own units (API filter) and may write until the end of the round month
// (round m = "ขอเบิก m": keyed in m-1, dispensed in m-1 and m) — the server answers FORBIDDEN "หมดเวลา…" afterwards (admin.js keeps the session for it).
import { compareMonthKey } from "../format.js";
import { el, escapeHtml, confirmDialog, toast, errMessage } from "./util.js";
import { DISPENSE_UNITS } from "./compute.js";
import { mountShortage } from "./shortage.js";
import { sheetMode } from "./tab2b_sheet.js";
import { itemMode } from "./tab2b_item.js";
import { roundMode } from "./tab2b_round.js";

const EXPIRED_MSG = "หมดเวลาแก้ไขการจ่าย (แก้ได้ถึงสิ้นเดือนที่ขอเบิก)";

export function renderTab2b(container, ctx) {
  const { state } = ctx;
  const me = state.me || { units: [] };
  const myUnits = state.isAdmin ? DISPENSE_UNITS : (me.units || []);
  const ts = {
    mode: "sheet", month: ctx.defaultMonth(),
    pcu: (state.bootstrap.pcus[0] || {}).code || "", itemCode: "", filter: "",
    unit: myUnits[0] || "", sheet: null, item: null, editor: null, expired: null, seq: 0, visible: false
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
    el("button", { type: "button", "data-mode": "item", id: "t2b-mode-item" }, "ต่อรายการ"),
    el("button", { type: "button", "data-mode": "round", id: "t2b-mode-round" }, "ทั้งรอบ")
  ]);
  const monthSel = el("select", { class: "select-input", id: "t2b-month", "aria-label": "เลือกเดือน" });
  const pcuSel = el("select", { class: "select-input", id: "t2b-pcu", "aria-label": "เลือก รพ.สต." });
  state.bootstrap.pcus.forEach((p) => pcuSel.appendChild(el("option", { value: p.code }, `${p.code} ${p.name}`)));
  const pcuLabel = el("label", { id: "t2b-pcu-label" }, ["รพ.สต.: ", pcuSel]);
  const filterInput = el("input", { type: "search", class: "search-input", id: "t2b-filter", placeholder: "ค้นหารหัส/ชื่อรายการ", autocomplete: "off" });
  const itemSel = el("select", { class: "select-input t2b-item-select", id: "t2b-item", "aria-label": "เลือกรายการ" });
  const itemLabel = el("label", { id: "t2b-item-label", class: "t2b-item-label" }, ["รายการ: ", itemSel]);
  const unitSel = el("select", { class: "select-input", id: "t2b-unit", "aria-label": "เลือกหน่วยจ่าย" });
  myUnits.forEach((u) => unitSel.appendChild(el("option", { value: u }, u)));
  const unitLabel = el("label", { id: "t2b-unit-label" }, ["หน่วยจ่าย: ", unitSel]);
  const refreshBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-refresh" }, "รีเฟรช");
  toolbar.appendChild(seg);
  toolbar.appendChild(el("label", {}, ["เดือน: ", monthSel]));
  toolbar.appendChild(pcuLabel);
  toolbar.appendChild(filterInput);
  toolbar.appendChild(itemLabel);
  toolbar.appendChild(unitLabel);
  toolbar.appendChild(refreshBtn);
  // brief 2s: "จ่ายไม่พอ" overview for dispensers (admins get it as a card in the แดชบอร์ด tab). Default unit = the dispenser's own
  // (the server applies it when no `unit` is sent). Separate from the issue editor below, so it never touches unsaved edits.
  const shortBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2b-shortage-btn", "aria-expanded": "false", "aria-controls": "t2b-shortage" }, "จ่ายไม่พอ");
  if (!state.isAdmin) toolbar.appendChild(shortBtn);
  container.appendChild(toolbar);
  const shortHost = el("div", { id: "t2b-shortage", class: "t2b-shortage", hidden: true });
  container.appendChild(shortHost);
  let shortage = null;
  shortBtn.addEventListener("click", () => {
    const open = shortHost.hidden;
    shortHost.hidden = !open;
    shortBtn.setAttribute("aria-expanded", String(open));
    shortBtn.classList.toggle("btn-primary", open);
    shortBtn.classList.toggle("btn-secondary", !open);
    if (!open) return;
    if (!shortage) shortage = mountShortage(shortHost, { call: ctx.adminCall, fy: ctx.fySelected(), heading: "จ่ายไม่พอ" });
    else shortage.reload();
  });
  const host = el("div", { id: "t2b-host" });
  container.appendChild(host);

  function months() {
    const set = new Set(ctx.fyMonths());
    if (ts.month) set.add(ts.month);
    return Array.from(set).sort().reverse();
  }
  function fillMonths() {
    monthSel.innerHTML = "";
    if (!months().length) { monthSel.appendChild(el("option", { value: "", disabled: true, selected: true }, "— ไม่มีรอบในปีงบนี้ —")); return; }
    months().forEach((m) => monthSel.appendChild(el("option", { value: m, selected: m === ts.month }, ctx.monthLabel(m))));
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
    unitLabel.style.display = ts.mode === "round" ? "" : "none";
  }

  function windowExpired(month) {
    return !state.isAdmin && compareMonthKey(state.bootstrap.current_month, month) > 0;
  }
  // 2ak A3: per request, like issue.js windowClosed — past the window a dispenser still records the requests an admin keyed (entry_by 'admin').
  // `ts.late` = the month is past the window · ts.expired only when none of the requests on screen is admin-keyed (else those stay editable).
  const adminKeyed = (r) => !!r && r.entry_by === "admin";
  const expiredFor = (reqs) => (ts.late && !reqs.some(adminKeyed) ? EXPIRED_MSG : null);
  const lateNote = () => el("div", { class: "notice notice-info", id: "t2b-late" }, "หมดเวลาแก้ไขการจ่ายใบที่ รพ.สต. ส่งเอง — บันทึกได้เฉพาะใบที่ admin คีย์ให้");

  async function guardDirty() {
    const n = ts.editor ? ts.editor.dirtyCount() : 0;
    if (!n) return true;
    return confirmDialog(`มีการแก้ไขที่ยังไม่บันทึก ${n} รายการ — ทิ้งการแก้ไขนี้?`, { title: "ยังไม่ได้บันทึก", okText: "ทิ้งการแก้ไข", danger: true });
  }

  function load() {
    if (!ts.month) {
      ts.editor = null;
      host.innerHTML = `<p class="admin-note">ยังไม่มีรอบหรือใบเบิกบนเว็บในปีงบ ${escapeHtml(String(ctx.fySelected()))}</p>`;
      return;
    }
    ts.late = windowExpired(ts.month);
    ts.expired = ts.late ? EXPIRED_MSG : null;
    ts.editor = null;
    (modes[ts.mode] || modes.item).load();
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
  unitSel.addEventListener("change", () => { ts.unit = unitSel.value; load(); });
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

  // 2ak D8: the three modes live in their own modules; they share this closure's state + helpers through `core`
  const core = { ctx, state, ts, host, myUnits, adminKeyed, expiredFor, lateNote, loadingHtml, writeError, footerHtml, refreshFooter, showFirstError };
  const modes = { sheet: sheetMode(core), item: itemMode(core), round: roundMode(core) };

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
