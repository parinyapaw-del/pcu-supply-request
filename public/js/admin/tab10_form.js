// Tab 10 — แบบฟอร์ม (phase 2.md §5.9, briefs/2d_admin_ui.md): admin-only form editor.
// Edits a deep copy of the latest form (adminBootstrap.form, inactive steps included) and saves it as a new
// form version via adminFormSave. Older versions are viewable read-only (adminFormGet) with a diff.
// Validation / diff helpers are pure and live in form_diff.js.
import { formatMoney, fiscalYearStartMonthKey, fiscalYearEndMonthKey, nextMonthKey } from "../format.js";
import { el, escapeHtml, tableScroll, toast, errMessage, confirmDialog, formDialog, openModal, formatBangkokDateTime, monthShort } from "./util.js";
import { clearRequestCache } from "./requests.js";
import {
  DISPENSE_UNITS, MAX_ACTIVE_STEPS, MAX_ACTIVE_ITEMS, MAX_SECTIONS, STEP_CODE_RE,
  deepCopy, normalizeForm, formSignature, validateForm, diffForms, diffIsEmpty, summaryThai, diffDetailsThai,
  nextItemCode, suggestStepCode, stepCounts, isActive
} from "./form_diff.js";

const PREVIEW_KEY = "pcuSupply2:formPreview";
const DRAFT_KEY = "pcuSupply2:formEditorDraft"; // unsaved edits survive a reload / same-tab navigation

function storeDraft(baseId, draft, priceFrom) {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ base_id: baseId, steps: draft.steps, price_from: priceFrom || {} }));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch (e) { /* storage unavailable: the in-memory draft still works */ }
}
function readDraft() {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch (e) { return null; }
}
const STALE_ON_SAVE = ["tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7"];

// One beforeunload listener for the page; it watches whichever editor state rendered last.
const guard = { ts: null };
window.addEventListener("beforeunload", (ev) => {
  if (!guard.ts || !guard.ts.dirty || !document.getElementById("t10-head")) return undefined;
  ev.preventDefault();
  ev.returnValue = "";
  return "";
});

export function renderTab10(container, ctx) {
  const { state } = ctx;
  const b = () => state.bootstrap;
  container.innerHTML = "";
  container.classList.add("t10-root");
  if (!ctx.isCurrentFy()) { container.appendChild(ctx.fyNotice("แท็บ แบบฟอร์ม")); return null; }

  if (!b().form || !Array.isArray(b().form.steps)) {
    container.appendChild(el("div", { class: "notice notice-info" },
      "ยังไม่มีแบบฟอร์มในระบบ — นำเข้าข้อมูลตั้งต้นที่แท็บ \"ระบบ\" ก่อน แล้วเปิดแท็บนี้ใหม่"));
    return { onShow() { if (b().form) ctx.markStale(["tab10"]); } };
  }

  // ---- state -----------------------------------------------------------------------------------------
  const ts = {
    base: null,        // latest form as loaded (id, fy, created_at, note, steps)
    baseSig: "",
    draft: null,       // {steps} being edited
    dirty: false,
    sel: null,         // selected step code
    focusIdx: null,    // index in the selected step's rows of the focused row (section insert point)
    viewing: null,     // older version shown read-only
    saving: false,
    priceFrom: {},     // 2p: code -> "YYYY-MM" round a changed price takes effect from (default = open round)
    hist: {},          // 2p: code -> [{from_round, price, set_at, set_by}] ascending (adminFormGet.price_history of fy_current)
    histSeq: 0
  };

  // ---- 2p: price effective round --------------------------------------------------------------------------
  // Rounds of fy_current, first round .. last round of the year; default = the open round (clamped into the year).
  function fyRounds() {
    const fy = ctx.fyCurrent();
    const out = [];
    let m = fiscalYearStartMonthKey(fy);
    const end = fiscalYearEndMonthKey(fy);
    while (m <= end && out.length < 13) { out.push(m); m = nextMonthKey(m); }
    return out;
  }
  function defaultFromRound() {
    const rounds = fyRounds();
    const cur = ctx.roundMonth();
    if (!rounds.length) return cur;
    if (cur < rounds[0]) return rounds[0];
    if (cur > rounds[rounds.length - 1]) return rounds[rounds.length - 1];
    return cur;
  }
  function roundOptionLabel(m) {
    const cur = ctx.roundMonth();
    return `ขอเบิก ${monthShort(m)}` + (m === cur ? " (รอบปัจจุบัน)" : m < cur ? " (ย้อนหลัง)" : "");
  }
  function basePriceMap() {
    const map = {};
    ts.base.steps.forEach((st) => (st.rows || []).forEach((r) => { if (r.type === "item") map[r.code] = Number(r.price); }));
    return map;
  }
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  // changed prices of items that already exist in the base version: [{code, price, from_round}]
  function priceChanges() {
    const base = basePriceMap();
    const out = [];
    ts.draft.steps.forEach((st) => (st.rows || []).forEach((r) => {
      if (r.type !== "item" || !(r.code in base)) return;
      const np = Number(r.price);
      if (!Number.isFinite(np) || r2(np) === r2(base[r.code])) return;
      out.push({ code: r.code, price: r2(np), from_round: ts.priceFrom[r.code] || defaultFromRound() });
    }));
    return out;
  }
  function histText(code) {
    const h = ts.hist[code] || [];
    if (h.length < 2) return "";
    return "ราคา " + h.map((x) => `${formatMoney(x.price)} ตั้งแต่ ${monthShort(x.from_round)}`).join(" · ");
  }
  async function loadHistory() {
    const my = ++ts.histSeq;
    try {
      const res = await ctx.adminCall("adminFormGet", { id: ts.base.id });
      if (my !== ts.histSeq) return;
      const hist = {};
      (res.price_history || []).forEach((x) => { (hist[x.code] || (hist[x.code] = [])).push(x); });
      Object.values(hist).forEach((a) => a.sort((x, y) => (x.from_round < y.from_round ? -1 : x.from_round > y.from_round ? 1 : 0)));
      ts.hist = hist;
      if (!ts.viewing) drawRows();
    } catch (err) { /* history is informational only */ }
  }

  function loadFromBootstrap() {
    ts.base = deepCopy(b().form);
    ts.draft = { steps: deepCopy(ts.base.steps) };
    ts.baseSig = formSignature(ts.base);
    ts.dirty = false;
    storeDraft(null, null);
    ts.priceFrom = {};
    ts.viewing = null;
    ts.focusIdx = null;
    if (!ts.sel || !ts.draft.steps.some((s) => s.code === ts.sel)) ts.sel = ts.draft.steps.length ? ts.draft.steps[0].code : null;
  }

  function selStep() { return ts.draft.steps.find((s) => s.code === ts.sel) || null; }
  function baseItemCodes() {
    const set = new Set();
    ts.base.steps.forEach((s) => (s.rows || []).forEach((r) => { if (r.type === "item") set.add(r.code); }));
    return set;
  }
  function itemName(code) {
    for (const f of [ts.draft, ts.base, ts.viewing]) {
      if (!f) continue;
      for (const s of f.steps) for (const r of s.rows || []) if (r.type === "item" && r.code === code) return r.name;
    }
    return "";
  }

  // ---- DOM skeleton ------------------------------------------------------------------------------------
  const headCard = el("div", { class: "admin-card", id: "t10-head" });
  const stripCard = el("div", { class: "admin-card", id: "t10-pages" });
  const fieldsCard = el("div", { class: "admin-card", id: "t10-fields" });
  const rowsCard = el("div", { class: "admin-card", id: "t10-rows" });
  const roHost = el("div", { id: "t10-readonly" });
  const footer = el("div", { class: "t10-footer", id: "t10-footer" });
  [headCard, stripCard, fieldsCard, rowsCard, roHost, footer].forEach((n) => container.appendChild(n));

  const previewBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t10-preview" }, "ตัวอย่างใบพิมพ์");
  const saveBtn = el("button", { type: "button", class: "btn btn-primary", id: "t10-save" }, "บันทึกเป็น version ใหม่");
  const cancelBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t10-cancel" }, "ยกเลิกการแก้ไข");
  const footInfo = el("span", { class: "t10-foot-info muted small", id: "t10-foot-info" });
  footer.appendChild(footInfo);
  footer.appendChild(el("div", { class: "t10-foot-btns" }, [previewBtn, cancelBtn, saveBtn]));
  previewBtn.addEventListener("click", openPreview);
  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", cancelEdits);

  // ---- dirty tracking ------------------------------------------------------------------------------------
  guard.ts = ts; // the latest render owns the beforeunload guard

  function touch() {
    ts.dirty = formSignature(ts.draft) !== ts.baseSig;
    storeDraft(ts.base.id, ts.dirty ? ts.draft : null, ts.priceFrom);
    drawDirty();
  }
  function drawDirty() {
    saveBtn.disabled = !ts.dirty || ts.saving || !!ts.viewing;
    cancelBtn.disabled = !ts.dirty || ts.saving;
    const chip = headCard.querySelector("#t10-dirty");
    if (chip) chip.style.display = ts.dirty ? "" : "none";
    footInfo.textContent = ts.dirty ? summaryThai(diffForms(ts.base, ts.draft)) : "ยังไม่มีการแก้ไข";
  }

  // ---- header card ----------------------------------------------------------------------------------------
  function versionsDesc() {
    return (b().form_versions || []).slice().sort((x, y) => y.id - x.id);
  }
  function versionMeta(id) {
    return (b().form_versions || []).find((v) => v.id === id) || null;
  }
  function drawHead() {
    headCard.innerHTML = "";
    const meta = versionMeta(ts.base.id) || {};
    const by = ts.base.created_by || meta.created_by || "";
    const note = ts.base.note || meta.note || "";
    const title = el("div", { class: "t10-head-row" }, [
      el("h2", {}, "แบบฟอร์มใบเบิก"),
      el("span", { class: "badge badge-warn t10-dirty-chip", id: "t10-dirty", style: ts.dirty ? "" : "display:none" }, "ยังไม่ได้บันทึก")
    ]);
    headCard.appendChild(title);
    headCard.appendChild(el("p", { class: "t10-cur", id: "t10-cur" }, [
      el("strong", {}, `Version ปัจจุบัน #${ts.base.id}`),
      ` · ปีงบ ${ts.base.fy || "–"} · บันทึกเมื่อ ${formatBangkokDateTime(ts.base.created_at)}`,
      by ? ` โดย ${by === "backup" ? "รหัสสำรอง" : by}` : "",
      note ? ` · ${note}` : ""
    ]));

    const sel = el("select", { class: "select-input", id: "t10-version" });
    versionsDesc().forEach((v) => {
      const label = `#${v.id}${v.id === ts.base.id ? " (ปัจจุบัน)" : ""} · ${formatBangkokDateTime(v.created_at)}${v.created_by ? " · " + (v.created_by === "backup" ? "รหัสสำรอง" : v.created_by) : ""}${v.note ? " · " + v.note : ""}`;
      sel.appendChild(el("option", { value: String(v.id), selected: (ts.viewing ? ts.viewing.id : ts.base.id) === v.id }, label));
    });
    sel.addEventListener("change", () => viewVersion(Number(sel.value)));
    const diffDraft = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t10-diff-draft" }, "ดูสิ่งที่แก้ (ยังไม่บันทึก)");
    diffDraft.addEventListener("click", () => showDiff(ts.base, ts.draft, "สิ่งที่แก้ เทียบกับ version ปัจจุบัน"));
    headCard.appendChild(el("div", { class: "admin-toolbar t10-ver-bar" }, [
      el("label", {}, ["ประวัติ version", sel]),
      ts.viewing ? null : diffDraft
    ]));
  }

  async function viewVersion(id) {
    if (id === ts.base.id) { ts.viewing = null; drawAll(); return; }
    try {
      const res = await ctx.adminCall("adminFormGet", { id });
      ts.viewing = res.form;
      drawAll();
      window.scrollTo({ top: container.getBoundingClientRect().top + window.scrollY - 10, behavior: "smooth" });
    } catch (err) {
      toast("โหลด version ไม่สำเร็จ: " + errMessage(err), "err");
      drawHead();
    }
  }

  function showDiff(oldForm, newForm, title) {
    const d = diffForms(oldForm, newForm);
    const body = el("div", { id: "t10-diff-modal" });
    body.appendChild(el("p", { class: "t10-diff-summary" }, summaryThai(d)));
    if (!diffIsEmpty(d)) {
      diffDetailsThai(d, itemName).forEach((g) => {
        body.appendChild(el("h3", {}, `${g.label} (${g.lines.length})`));
        body.appendChild(el("ul", { class: "t10-diff-list" }, g.lines.map((l) => el("li", {}, l))));
      });
    }
    const actions = el("div", { class: "admin-modal-actions" });
    const close = el("button", { type: "button", class: "btn btn-primary" }, "ปิด");
    actions.appendChild(close);
    body.appendChild(actions);
    const m = openModal(title, body, { wide: true });
    close.addEventListener("click", m.close);
  }

  // ---- page strip -------------------------------------------------------------------------------------------
  function drawStrip() {
    stripCard.innerHTML = "";
    const steps = ts.draft.steps;
    const nActive = steps.filter(isActive).length;
    stripCard.appendChild(el("div", { class: "t10-head-row" }, [
      el("h2", {}, "หน้าในใบเบิก"),
      el("span", { class: "muted small", id: "t10-page-count" }, `เปิด ${nActive}/${MAX_ACTIVE_STEPS} หน้า`)
    ]));
    const strip = el("div", { class: "t10-strip", role: "tablist", id: "t10-strip" });
    let pageNo = 0;
    steps.forEach((s) => {
      const active = isActive(s);
      if (active) pageNo += 1;
      const c = stepCounts(s);
      const chip = el("button", {
        type: "button", role: "tab", "data-step": s.code,
        class: "t10-chip" + (s.code === ts.sel ? " active" : "") + (active ? "" : " closed")
      }, [
        el("span", { class: "t10-chip-no" }, active ? String(pageNo) : "–"),
        el("span", {}, `${s.code} · ${s.sheet || s.title || ""}`),
        el("span", { class: "t10-chip-n" }, active ? `${c.activeItems}` : "(ปิด)")
      ]);
      chip.addEventListener("click", () => { ts.sel = s.code; ts.focusIdx = null; drawAll(); });
      strip.appendChild(chip);
    });
    stripCard.appendChild(strip);
    const activeChip = strip.querySelector(".t10-chip.active");
    if (activeChip) strip.scrollLeft = Math.max(0, activeChip.offsetLeft - (strip.clientWidth - activeChip.offsetWidth) / 2);

    const s = selStep();
    const idx = steps.indexOf(s);
    const bar = el("div", { class: "admin-toolbar t10-page-actions" });
    const left = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t10-page-left", title: "เลื่อนหน้าไปทางซ้าย", disabled: idx <= 0 }, "◀");
    const right = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t10-page-right", title: "เลื่อนหน้าไปทางขวา", disabled: idx < 0 || idx >= steps.length - 1 }, "▶");
    left.addEventListener("click", () => movePage(-1));
    right.addEventListener("click", () => movePage(1));
    const add = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t10-page-add", disabled: nActive >= MAX_ACTIVE_STEPS }, "เพิ่มหน้า");
    add.addEventListener("click", addPage);
    bar.appendChild(left); bar.appendChild(right); bar.appendChild(add);
    if (s) {
      const isNew = !ts.base.steps.some((x) => x.code === s.code);
      const c = stepCounts(s);
      if (isNew && c.items === 0) {
        const del = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t10-page-del" }, "ลบหน้านี้ (ยังไม่บันทึก)");
        del.addEventListener("click", () => { ts.draft.steps.splice(idx, 1); ts.sel = (ts.draft.steps[Math.max(0, idx - 1)] || {}).code || null; touch(); drawAll(); });
        bar.appendChild(del);
      } else if (isActive(s)) {
        const close = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t10-page-close", disabled: c.activeItems > 0, title: c.activeItems > 0 ? "ปิดรายการทั้งหมดในหน้านี้ก่อน" : "" }, "ปิดหน้า");
        close.addEventListener("click", async () => {
          const ok = await confirmDialog(`ปิดหน้า ${s.code} (${s.sheet})?\nหน้านี้จะไม่แสดงใน รพ.สต. และใบพิมพ์ (เปิดกลับได้)`, { title: "ปิดหน้า", okText: "ปิดหน้า" });
          if (!ok) return;
          s.active = false; touch(); drawAll();
        });
        bar.appendChild(close);
        if (c.activeItems > 0) bar.appendChild(el("span", { class: "muted small" }, "ปิดหน้าได้เมื่อไม่มีรายการที่เปิดอยู่"));
      } else {
        const open = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t10-page-open", disabled: nActive >= MAX_ACTIVE_STEPS }, "เปิดหน้า");
        open.addEventListener("click", () => { s.active = true; touch(); drawAll(); });
        bar.appendChild(open);
      }
    }
    stripCard.appendChild(bar);
  }

  function movePage(delta) {
    const steps = ts.draft.steps;
    const i = steps.findIndex((s) => s.code === ts.sel);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    steps.forEach((s, k) => { s.order = k + 1; });
    touch(); drawAll();
  }

  async function addPage() {
    if (ts.draft.steps.filter(isActive).length >= MAX_ACTIVE_STEPS) { toast(`เปิดได้ไม่เกิน ${MAX_ACTIVE_STEPS} หน้า`, "err"); return; }
    const used = new Set(ts.draft.steps.map((s) => s.code).concat(ts.base.steps.map((s) => s.code)));
    const res = await formDialog("เพิ่มหน้าใหม่", [
      { key: "code", label: "รหัสหน้า (A–Z, 0–9 ไม่เกิน 6 ตัว — ใช้นำหน้ารหัสรายการ เช่น S08-01)", required: true, maxlength: 6, value: suggestStepCode(ts.draft, ts.base) }
    ], {
      okText: "เพิ่มหน้า", intro: "รหัสหน้าแก้ภายหลังไม่ได้",
      validate: (v) => {
        const code = v.code.toUpperCase();
        if (!STEP_CODE_RE.test(code)) return "รหัสหน้าต้องเป็น A–Z หรือ 0–9 ยาว 1–6 ตัว";
        if (used.has(code)) return `รหัส ${code} มีอยู่แล้ว`;
        return "";
      }
    });
    if (!res) return;
    const code = res.code.toUpperCase();
    ts.draft.steps.push({
      code, order: ts.draft.steps.length + 1, sheet: "แบบ ใหม่", title: "ใบเบิก…", subject: "",
      to: "ผู้อำนวยการโรงพยาบาลอ่างทอง", dispense_unit: "พัสดุ", active: true, rows: []
    });
    ts.sel = code; ts.focusIdx = null;
    touch(); drawAll();
    const f = fieldsCard.querySelector("#t10-f-sheet");
    if (f) { f.focus(); f.select(); }
  }

  // ---- page fields -------------------------------------------------------------------------------------------
  function drawFields() {
    fieldsCard.innerHTML = "";
    const s = selStep();
    if (!s) { fieldsCard.appendChild(el("p", { class: "muted" }, "ยังไม่มีหน้า")); return; }
    fieldsCard.appendChild(el("h2", {}, `ข้อมูลหน้า ${s.code}${isActive(s) ? "" : " (ปิด)"}`));
    const grid = el("div", { class: "t10-fields-grid" });
    const text = (key, label, maxlength) => {
      const input = el("input", { type: "text", id: "t10-f-" + key, maxlength, value: s[key] || "", autocomplete: "off" });
      input.addEventListener("input", () => {
        s[key] = input.value;
        touch();
        if (key === "sheet") {
          const chip = stripCard.querySelector(`.t10-chip[data-step="${CSS.escape(s.code)}"] span:nth-child(2)`);
          if (chip) chip.textContent = `${s.code} · ${s.sheet || s.title || ""}`;
        }
      });
      grid.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, label), input]));
    };
    text("sheet", "ชื่อใบ", 120);
    text("title", "ชื่อเรื่องบนหัวใบ *", 120);
    text("subject", "เรื่อง", 120);
    text("to", "เรียน", 120);
    const unit = el("select", { class: "select-input", id: "t10-f-unit" });
    DISPENSE_UNITS.forEach((u) => unit.appendChild(el("option", { value: u, selected: s.dispense_unit === u }, u)));
    unit.addEventListener("change", () => { s.dispense_unit = unit.value; touch(); });
    grid.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, "หน่วยจ่าย"), unit]));
    fieldsCard.appendChild(grid);
  }

  // ---- rows table ---------------------------------------------------------------------------------------------
  function drawRows() {
    rowsCard.innerHTML = "";
    const s = selStep();
    if (!s) return;
    const c = stepCounts(s);
    rowsCard.appendChild(el("div", { class: "t10-head-row" }, [
      el("h2", {}, `รายการในหน้า ${s.code}`),
      el("span", {
        class: "t10-counter" + (c.activeItems > MAX_ACTIVE_ITEMS || c.sections > MAX_SECTIONS ? " over" : ""), id: "t10-counter"
      }, `รายการเปิด ${c.activeItems}/${MAX_ACTIVE_ITEMS} · หัวหมวด ${c.sections}/${MAX_SECTIONS}`)
    ]));

    const table = el("table", { class: "admin-table t10-table", id: "t10-rows-tbl" });
    table.appendChild(el("thead", {}, el("tr", {}, [
      el("th", { class: "num" }, "ลำดับ"), el("th", { class: "left" }, "รหัส"), el("th", { class: "left" }, "รายการ"),
      el("th", { class: "left" }, "หน่วย"), el("th", { class: "num" }, "ราคา"), el("th", {}, "สถานะ"),
      el("th", {}, "เรียง"), el("th", { class: "left" }, "ย้ายไปหน้า")
    ])));
    const tbody = el("tbody");
    const baseCodes = baseItemCodes();
    const otherSteps = ts.draft.steps.filter((x) => x.code !== s.code && isActive(x));
    let seq = 0;
    s.rows.forEach((r, i) => {
      const upDown = el("td", { class: "t10-order-cell" }, [
        el("button", { type: "button", class: "t10-icon-btn", title: "เลื่อนขึ้น", "data-act": "up", disabled: i === 0 }, "▲"),
        el("button", { type: "button", class: "t10-icon-btn", title: "เลื่อนลง", "data-act": "down", disabled: i === s.rows.length - 1 }, "▼")
      ]);
      let tr;
      if (r.type === "section") {
        const title = el("input", { type: "text", class: "t10-in t10-in-section", value: r.title || "", maxlength: 80, placeholder: "ชื่อหัวหมวด", "aria-label": "ชื่อหัวหมวด" });
        title.addEventListener("input", () => { r.title = title.value; touch(); });
        const del = el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-act": "del" }, "ลบ");
        tr = el("tr", { class: "t10-section-row", "data-idx": String(i) }, [
          el("td", { class: "num muted small" }, "หมวด"),
          el("td", { class: "left", colspan: "5" }, title),
          upDown,
          el("td", { class: "left" }, del)
        ]);
        del.addEventListener("click", () => { s.rows.splice(i, 1); ts.focusIdx = null; touch(); drawAll(); });
      } else {
        seq += 1;
        const active = isActive(r);
        const name = el("input", { type: "text", class: "t10-in t10-in-name", value: r.name || "", maxlength: 200, "data-code": r.code, "aria-label": "ชื่อรายการ " + r.code });
        name.addEventListener("input", () => { r.name = name.value; touch(); });
        const unit = el("input", { type: "text", class: "t10-in t10-in-unit", value: r.unit || "", maxlength: 30, "aria-label": "หน่วย " + r.code });
        unit.addEventListener("input", () => { r.unit = unit.value; touch(); });
        const price = el("input", { type: "number", class: "t10-in t10-in-price", step: "0.01", min: "0", inputmode: "decimal", value: Number.isFinite(Number(r.price)) ? String(r.price) : "", "aria-label": "ราคา " + r.code });
        // 2p: a changed price of an existing item asks "เริ่มใช้ตั้งแต่รอบ" (hidden until the price differs from the saved one)
        const isBaseItem = baseCodes.has(r.code);
        const fromSel = el("select", { class: "select-input t10-pf", "aria-label": "เริ่มใช้ตั้งแต่รอบ " + r.code, "data-pf": r.code });
        const curFrom = ts.priceFrom[r.code] || defaultFromRound();
        fyRounds().forEach((m) => fromSel.appendChild(el("option", { value: m, selected: m === curFrom }, roundOptionLabel(m))));
        fromSel.addEventListener("change", () => { ts.priceFrom[r.code] = fromSel.value; touch(); });
        const fromBox = el("label", { class: "t10-pf-box" }, [el("span", { class: "muted small" }, "เริ่มใช้ตั้งแต่รอบ"), fromSel]);
        const syncFromBox = () => {
          const np = Number(r.price);
          const changed = isBaseItem && Number.isFinite(np) && r2(np) !== r2(basePriceMap()[r.code]);
          fromBox.hidden = !changed;
          if (!changed) delete ts.priceFrom[r.code];
          else if (!ts.priceFrom[r.code]) ts.priceFrom[r.code] = fromSel.value;
        };
        price.addEventListener("input", () => {
          const v = price.value.trim();
          r.price = v === "" ? NaN : Number(v);
          price.classList.toggle("bad", !(Number.isFinite(r.price) && r.price >= 0));
          syncFromBox();
          touch();
        });
        syncFromBox();
        const toggle = el("button", { type: "button", class: "btn btn-sm " + (active ? "btn-secondary" : "btn-primary"), "data-act": "toggle" }, active ? "ปิด" : "เปิด");
        toggle.addEventListener("click", () => {
          if (!active && stepCounts(s).activeItems >= MAX_ACTIVE_ITEMS) { toast(`หน้านี้เปิดรายการครบ ${MAX_ACTIVE_ITEMS} แล้ว`, "err"); return; }
          r.active = !active; touch(); drawAll();
        });
        const move = el("select", { class: "select-input t10-move", "aria-label": "ย้ายไปหน้า" });
        move.appendChild(el("option", { value: "" }, "—"));
        otherSteps.forEach((o) => move.appendChild(el("option", { value: o.code }, `${o.code} · ${o.sheet || ""}`)));
        move.addEventListener("change", () => {
          const target = ts.draft.steps.find((x) => x.code === move.value);
          if (!target) return;
          s.rows.splice(i, 1);
          target.rows.push(r);
          ts.focusIdx = null;
          touch(); drawAll();
          toast(`ย้าย ${r.code} ไปท้ายหน้า ${target.code} แล้ว`);
        });
        const statusCell = el("td", { class: "t10-status-cell" }, [
          el("span", { class: "badge " + (active ? "badge-success" : "badge-muted") }, active ? "เปิด" : "ปิดแล้ว"), " ", toggle
        ]);
        const moveCell = el("td", { class: "left" }, [move]);
        if (!baseCodes.has(r.code)) {
          const del = el("button", { type: "button", class: "btn btn-secondary btn-sm", "data-act": "del", title: "รายการใหม่ที่ยังไม่บันทึก — ลบได้" }, "ลบ");
          del.addEventListener("click", () => { s.rows.splice(i, 1); ts.focusIdx = null; touch(); drawAll(); });
          moveCell.appendChild(del);
        }
        tr = el("tr", { class: "t10-item-row" + (active ? "" : " t10-closed") + (baseCodes.has(r.code) ? "" : " t10-new"), "data-idx": String(i), "data-code": r.code }, [
          el("td", { class: "num" }, String(seq)),
          el("td", { class: "code-cell" }, r.code),
          el("td", { class: "left" }, histText(r.code)
            ? [name, el("div", { class: "t10-hist muted small", title: (ts.hist[r.code] || []).map((x) => `${formatMoney(x.price)} ตั้งแต่ ${monthShort(x.from_round)}${x.set_by ? " โดย " + x.set_by : ""}`).join("\n") }, histText(r.code))]
            : name),
          el("td", { class: "left" }, unit),
          el("td", { class: "num" }, [price, fromBox]),
          statusCell,
          upDown,
          moveCell
        ]);
      }
      if (i === ts.focusIdx) tr.classList.add("t10-focus");
      tr.addEventListener("focusin", () => setFocusRow(i));
      tr.addEventListener("click", () => setFocusRow(i));
      upDown.querySelector('[data-act="up"]').addEventListener("click", (ev) => { ev.stopPropagation(); moveRow(i, -1); });
      upDown.querySelector('[data-act="down"]').addEventListener("click", (ev) => { ev.stopPropagation(); moveRow(i, 1); });
      tbody.appendChild(tr);
    });
    if (!s.rows.length) tbody.appendChild(el("tr", {}, el("td", { colspan: "8", class: "left muted" }, "ยังไม่มีรายการ — กด \"เพิ่มรายการ\"")));
    table.appendChild(tbody);
    const scroll = el("div", { class: "table-scroll t10-scroll" }, table);
    rowsCard.appendChild(scroll);

    const addItem = el("button", { type: "button", class: "btn btn-secondary", id: "t10-add-item", disabled: c.activeItems >= MAX_ACTIVE_ITEMS }, "เพิ่มรายการ");
    const addSec = el("button", { type: "button", class: "btn btn-secondary", id: "t10-add-section", disabled: c.sections >= MAX_SECTIONS }, "เพิ่มหัวหมวด");
    addItem.addEventListener("click", () => addItemRow(s));
    addSec.addEventListener("click", () => addSection(s));
    const hint = el("span", { class: "muted small" }, "หัวหมวดจะแทรกก่อนแถวที่เลือกอยู่ (ไม่ได้เลือก = บนสุด) · รายการลบไม่ได้ ให้ปิดแทน");
    rowsCard.appendChild(el("div", { class: "admin-toolbar t10-row-actions" }, [addItem, addSec, hint]));
  }

  function setFocusRow(i) {
    if (ts.focusIdx === i) return;
    ts.focusIdx = i;
    rowsCard.querySelectorAll("tr[data-idx]").forEach((tr) => tr.classList.toggle("t10-focus", Number(tr.dataset.idx) === i));
  }

  function moveRow(i, delta) {
    const s = selStep();
    const j = i + delta;
    if (!s || j < 0 || j >= s.rows.length) return;
    [s.rows[i], s.rows[j]] = [s.rows[j], s.rows[i]];
    ts.focusIdx = j;
    touch(); drawAll();
    const btn = rowsCard.querySelector(`tr[data-idx="${j}"] [data-act="${delta < 0 ? "up" : "down"}"]`);
    if (btn && !btn.disabled) btn.focus();
  }

  function addItemRow(s) {
    if (stepCounts(s).activeItems >= MAX_ACTIVE_ITEMS) { toast(`หน้านี้เปิดรายการครบ ${MAX_ACTIVE_ITEMS} แล้ว`, "err"); return; }
    const code = nextItemCode(ts.draft, s.code, ts.base);
    if (!code) { toast("สร้างรหัสรายการใหม่ไม่ได้", "err"); return; }
    s.rows.push({ type: "item", code, name: "", unit: "", price: 0, active: true });
    ts.focusIdx = s.rows.length - 1;
    touch(); drawAll();
    const input = rowsCard.querySelector(`input.t10-in-name[data-code="${CSS.escape(code)}"]`);
    if (input) { input.scrollIntoView({ block: "center" }); input.focus(); }
  }

  function addSection(s) {
    if (stepCounts(s).sections >= MAX_SECTIONS) { toast(`หัวหมวดได้ไม่เกิน ${MAX_SECTIONS} หัวต่อหน้า`, "err"); return; }
    const at = ts.focusIdx !== null && ts.focusIdx >= 0 && ts.focusIdx < s.rows.length ? ts.focusIdx : 0;
    s.rows.splice(at, 0, { type: "section", title: "" });
    ts.focusIdx = at;
    touch(); drawAll();
    const input = rowsCard.querySelector(`tr[data-idx="${at}"] input`);
    if (input) input.focus();
  }

  // ---- read-only older version ---------------------------------------------------------------------------------
  function drawReadOnly() {
    roHost.innerHTML = "";
    const v = ts.viewing;
    if (!v) return;
    const card = el("div", { class: "admin-card t10-ro-card" });
    card.appendChild(el("div", { class: "notice notice-info" }, [
      el("strong", {}, `กำลังดู version #${v.id} (อ่านอย่างเดียว)`),
      ` · บันทึกเมื่อ ${formatBangkokDateTime(v.created_at)}${v.created_by ? " โดย " + v.created_by : ""}${v.note ? " · " + v.note : ""}`
    ]));
    const diffBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t10-ro-diff" }, "ดูความต่างจาก version ปัจจุบัน");
    const backBtn = el("button", { type: "button", class: "btn btn-primary", id: "t10-ro-back" }, "กลับไปแก้ version ปัจจุบัน");
    diffBtn.addEventListener("click", () => showDiff(v, ts.base, `ความต่าง: version #${v.id} → #${ts.base.id} (ปัจจุบัน)`));
    backBtn.addEventListener("click", () => { ts.viewing = null; drawAll(); });
    card.appendChild(el("div", { class: "admin-toolbar" }, [diffBtn, backBtn]));
    let pageNo = 0;
    (v.steps || []).forEach((s) => {
      const active = isActive(s);
      if (active) pageNo += 1;
      card.appendChild(el("h3", { class: active ? "" : "muted" },
        `${active ? `หน้า ${pageNo}` : "(ปิด)"} · ${s.code} · ${s.sheet || ""} — ${s.title || ""} · หน่วยจ่าย ${s.dispense_unit || "–"}`));
      let seq = 0;
      const rows = (s.rows || []).map((r) => {
        if (r.type === "section") return `<tr class="group-row"><td colspan="5">${escapeHtml(r.title)}</td></tr>`;
        seq += 1;
        return `<tr class="${isActive(r) ? "" : "t10-closed"}"><td class="num">${seq}</td><td class="code-cell">${escapeHtml(r.code)}</td><td class="left">${escapeHtml(r.name)}${isActive(r) ? "" : ' <span class="badge badge-muted">ปิด</span>'}</td><td class="left">${escapeHtml(r.unit)}</td><td class="num">${formatMoney(Number(r.price) || 0)}</td></tr>`;
      }).join("");
      const wrap = el("div");
      wrap.innerHTML = tableScroll(`<table class="admin-table"><thead><tr><th class="num">ลำดับ</th><th class="left">รหัส</th><th class="left">รายการ</th><th class="left">หน่วย</th><th class="num">ราคา</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="left muted">ไม่มีรายการ</td></tr>'}</tbody></table>`);
      card.appendChild(wrap);
    });
    roHost.appendChild(card);
  }

  // ---- preview / save / cancel ------------------------------------------------------------------------------------
  function payloadSteps() {
    return normalizeForm(ts.draft).steps;
  }

  function openPreview() {
    const form = { id: ts.base.id, fy: ts.base.fy, created_at: ts.base.created_at, note: "ตัวอย่าง (ยังไม่บันทึก)", steps: payloadSteps().filter((s) => s.active) };
    try {
      sessionStorage.setItem(PREVIEW_KEY, JSON.stringify({ form }));
    } catch (err) {
      toast("เก็บฟอร์มตัวอย่างไม่สำเร็จ: " + errMessage(err), "err");
      return;
    }
    // no "noopener": the new tab must inherit this tab's sessionStorage copy
    const w = window.open("index.html#/print?preview=1&as=admin", "_blank");
    if (!w) toast("เบราว์เซอร์บล็อกหน้าต่างใหม่ — อนุญาต pop-up แล้วลองอีกครั้ง", "err");
  }

  function jumpToError(v) {
    if (v.stepCode && ts.draft.steps.some((s) => s.code === v.stepCode)) {
      ts.sel = v.stepCode;
      ts.focusIdx = null;
      drawAll();
      if (v.code) {
        const tr = rowsCard.querySelector(`tr[data-code="${CSS.escape(v.code)}"]`);
        if (tr) {
          tr.classList.add("t10-error");
          tr.scrollIntoView({ block: "center" });
          const input = tr.querySelector("input");
          if (input) input.focus();
        }
      } else {
        stripCard.scrollIntoView({ block: "start" });
      }
    }
  }

  async function save() {
    if (!ts.dirty || ts.saving) return;
    const v = validateForm(ts.draft, ts.base);
    if (!v.ok) {
      jumpToError(v);
      toast(v.message, "err");
      return;
    }
    const d = diffForms(ts.base, ts.draft);

    // 2p: back-dated price (from_round before the open round) -> preview what it changes, then confirm
    const changes = priceChanges();
    const cur = ctx.roundMonth();
    if (changes.some((c) => c.from_round <= cur)) { // ≤: already-sent requests of the open round are re-priced too
      let pv;
      try {
        pv = await ctx.adminCall("adminPricePreview", { changes });
      } catch (err) {
        toast("ตรวจผลกระทบของราคาย้อนหลังไม่สำเร็จ: " + errMessage(err), "err");
        return;
      }
      if (pv && Number(pv.requests) > 0) {
        const [first, last] = pv.months || [];
        const range = first && last ? (first === last ? monthShort(first) : `${monthShort(first)}–${monthShort(last)}`) : "";
        const delta = Number(pv.delta_baht) || 0;
        const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
        const perCode = (pv.per_code || []).filter((x) => Number(x.n_lines) > 0).map((x) => {
          const dl = Number(x.delta) || 0;
          return `• ${x.code}${itemName(x.code) ? " " + itemName(x.code) : ""}: ${x.n_lines} รายการ ${dl > 0 ? "+" : dl < 0 ? "−" : "±"}${formatMoney(Math.abs(dl))} บาท`;
        });
        const ok = await confirmDialog(
          `จะปรับราคาใบที่ส่งแล้ว ${pv.requests} ใบ${range ? ` (รอบ ${range})` : ""} เป็นเงินเปลี่ยน ${sign}${formatMoney(Math.abs(delta))} บาท`
          + (perCode.length ? "\n\n" + perCode.join("\n") : "")
          + "\n\nใบพิมพ์/PDF ที่ส่งไปแล้วไม่เปลี่ยน · ไม่แจ้ง รพ.สต.",
          { title: "ปรับราคาย้อนหลัง", okText: "ยืนยันปรับราคาย้อนหลัง", danger: true });
        if (!ok) return;
      }
    }

    const res = await formDialog("บันทึกเป็น version ใหม่", [
      { key: "note", label: "โน้ต (ไม่บังคับ, ≤ 200 ตัวอักษร)", type: "textarea", maxlength: 200, rows: 3, placeholder: "เช่น เพิ่มหน้า S08 / ปรับราคาตามสัญญาใหม่" }
    ], {
      okText: "บันทึก",
      intro: `สรุปการแก้ไข: ${summaryThai(d)}\nใบที่ส่งแล้วไม่เปลี่ยน · แบบร่างของ รพ.สต. จะใช้ฟอร์มใหม่ทันที`,
      validate: (x) => (x.note.length > 200 ? "โน้ตยาวเกิน 200 ตัวอักษร" : "")
    });
    if (!res) return;
    ts.saving = true; drawDirty();
    saveBtn.textContent = "กำลังบันทึก...";
    try {
      const payload = { base_version_id: ts.base.id, note: res.note, form: { steps: payloadSteps() } };
      // 2p: send price_from for every changed price (even when = the open round)
      if (changes.length) {
        payload.price_from = {};
        changes.forEach((c) => { payload.price_from[c.code] = c.from_round; });
      }
      const out = await ctx.adminCall("adminFormSave", payload);
      if (out.saved) {
        toast(`บันทึกฟอร์ม version #${out.form.id} แล้ว`);
        ts.dirty = false;
        clearRequestCache(); // back-dated prices change price_snapshot without touching the requests' updated_at
        await ctx.refreshBootstrap();
        ctx.markStale(STALE_ON_SAVE);
        loadFromBootstrap();
        drawAll();
        loadHistory();
      } else if (out.same) {
        toast("ไม่มีการเปลี่ยนแปลง");
      }
    } catch (err) {
      if (err && err.code === "CONFLICT") {
        await confirmDialog(errMessage(err) + "\n\nระบบจะโหลดฟอร์มล่าสุดใหม่ (การแก้ไขที่ยังไม่บันทึกจะหายไป)", { title: "มี version ใหม่กว่า", okText: "โหลดใหม่", cancelText: "ปิด" });
        try { await ctx.refreshBootstrap(); } catch (e) { /* adminCall already handled auth */ }
        loadFromBootstrap();
        drawAll();
        loadHistory();
      } else if (err && err.code === "BAD_REQUEST") {
        toast(errMessage(err), "err");
        const m = /หน้า\s+([A-Z0-9]{1,6})/.exec(errMessage(err));
        const c = /([A-Z0-9]+-\d{2,3})/.exec(errMessage(err));
        jumpToError({ stepCode: m ? m[1] : null, code: c ? c[1] : null });
      } else {
        toast("บันทึกไม่สำเร็จ: " + errMessage(err), "err");
      }
    } finally {
      ts.saving = false;
      saveBtn.textContent = "บันทึกเป็น version ใหม่";
      drawDirty();
    }
  }

  async function cancelEdits() {
    if (!ts.dirty) return;
    const ok = await confirmDialog("ทิ้งการแก้ไขทั้งหมดที่ยังไม่บันทึก แล้วกลับไปที่ version ปัจจุบัน?", { title: "ยกเลิกการแก้ไข", okText: "ทิ้งการแก้ไข", danger: true });
    if (!ok) return;
    loadFromBootstrap();
    drawAll();
  }

  // ---- render all --------------------------------------------------------------------------------------------------
  function drawAll() {
    drawHead();
    const ro = !!ts.viewing;
    [stripCard, fieldsCard, rowsCard].forEach((n) => { n.style.display = ro ? "none" : ""; });
    previewBtn.disabled = ro;
    if (!ro) { drawStrip(); drawFields(); drawRows(); }
    drawReadOnly();
    drawDirty();
  }

  // restore unsaved edits of the same base version (e.g. after a reload)
  const stored = readDraft();
  loadFromBootstrap();
  if (stored && stored.base_id === ts.base.id && Array.isArray(stored.steps)) {
    ts.draft = { steps: stored.steps };
    ts.priceFrom = stored.price_from && typeof stored.price_from === "object" ? stored.price_from : {};
    if (!ts.draft.steps.some((s) => s.code === ts.sel)) ts.sel = ts.draft.steps.length ? ts.draft.steps[0].code : null;
    touch();
    if (ts.dirty) toast("กู้คืนการแก้ไขที่ยังไม่บันทึกแล้ว");
  }
  drawAll();
  loadHistory();

  return {
    onShow() {
      // pick up a form changed elsewhere (seed import / another tab) when nothing is being edited
      if (!ts.dirty && b().form && b().form.id !== ts.base.id) { loadFromBootstrap(); drawAll(); loadHistory(); }
    },
    onHide() { /* edits are kept in memory; the beforeunload guard and the "ยังไม่ได้บันทึก" chip remain */ }
  };
}
