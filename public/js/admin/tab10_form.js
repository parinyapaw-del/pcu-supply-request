// Tab 10 — แบบฟอร์ม (phase 2.md §5.9, briefs/2d_admin_ui.md): admin-only form editor.
// Edits a deep copy of the latest form (adminBootstrap.form, inactive steps included) and saves it as a new
// form version via adminFormSave. Older versions are viewable read-only (adminFormGet) with a diff.
// Validation / diff helpers are pure and live in form_diff.js.
import { formatMoney } from "../format.js";
import { el, escapeHtml, tableScroll, toast, errMessage, confirmDialog, formDialog, openModal, formatBangkokDateTime } from "./util.js";
import { clearRequestCache } from "./requests.js";
import {
  deepCopy, normalizeForm, formSignature, validateForm, diffForms, diffIsEmpty, summaryThai, diffDetailsThai, isActive,
} from "./form_diff.js";
import { pagesPart } from "./tab10_pages.js";
import { rowsPart } from "./tab10_rows.js";

const PREVIEW_KEY = "pcuSupply2:formPreview";
const DRAFT_KEY = "pcuSupply2:formEditorDraft"; // unsaved edits survive a reload / same-tab navigation

function storeDraft(baseId, draft) {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ base_id: baseId, steps: draft.steps }));
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
    hist: {},          // 2p/2z: code -> [{from_round, price, set_at, set_by}] by set_at (adminFormGet.price_history of fy_current — a log only)
    histSeq: 0
  };

  // ---- 2z: one price per fiscal year (a changed price applies to every request of the fy, sent sheets included) -----------------
  function basePriceMap() {
    const map = {};
    ts.base.steps.forEach((st) => (st.rows || []).forEach((r) => { if (r.type === "item") map[r.code] = Number(r.price); }));
    return map;
  }
  const r2 = (n) => Math.round(Number(n) * 100) / 100;
  // changed prices of items that already exist in the base version: [{code, price}]
  function priceChanges() {
    const base = basePriceMap();
    const out = [];
    ts.draft.steps.forEach((st) => (st.rows || []).forEach((r) => {
      if (r.type !== "item" || !(r.code in base)) return;
      const np = Number(r.price);
      if (!Number.isFinite(np) || r2(np) === r2(base[r.code])) return;
      out.push({ code: r.code, price: r2(np) });
    }));
    return out;
  }
  function histText(code) {
    const h = ts.hist[code] || [];
    if (h.length < 2) return "";
    return "ประวัติราคา " + h.map((x) => `${formatMoney(x.price)}${x.set_at ? ` (ตั้งเมื่อ ${setDate(x.set_at)})` : ""}`).join(" → ");
  }
  function setDate(iso) { // "29/10/2569 14:05" → "29/10/2569"
    return String(formatBangkokDateTime(iso) || "").split(" ")[0];
  }
  async function loadHistory() {
    const my = ++ts.histSeq;
    try {
      const res = await ctx.adminCall("adminFormGet", { id: ts.base.id });
      if (my !== ts.histSeq) return;
      const hist = {};
      (res.price_history || []).forEach((x) => { (hist[x.code] || (hist[x.code] = [])).push(x); });
      const k = (x) => `${x.set_at || ""}|${x.from_round}`;
      Object.values(hist).forEach((a) => a.sort((x, y) => (k(x) < k(y) ? -1 : k(x) > k(y) ? 1 : 0)));
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
    storeDraft(ts.base.id, ts.dirty ? ts.draft : null);
    drawDirty();
  }
  function drawDirty() {
    saveBtn.disabled = !ts.dirty || ts.saving || !!ts.viewing;
    cancelBtn.disabled = !ts.dirty || ts.saving;
    const chip = headCard.querySelector("#t10-dirty");
    if (chip) chip.style.display = ts.dirty ? "" : "none";
    footInfo.textContent = ts.dirty ? summaryThai(diffForms(ts.base, ts.draft)) : "ยังไม่มีการแก้ไข";
  }

  // 2ak D8: the page strip + page fields (tab10_pages.js) and the rows table (tab10_rows.js) are modules sharing this closure through `core`
  const core = { ts, stripCard, fieldsCard, rowsCard, selStep, baseItemCodes, histText, touch, drawAll };
  const { drawStrip, drawFields } = pagesPart(core);
  const { drawRows } = rowsPart(core);

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

    // 2z: a changed price is the price of the whole fy — preview what it changes on the sent requests (sheets/PDF included), then confirm
    const changes = priceChanges();
    if (changes.length) {
      let pv;
      try {
        pv = await ctx.adminCall("adminPricePreview", { changes });
      } catch (err) {
        toast("ตรวจผลกระทบของราคาใหม่ไม่สำเร็จ: " + errMessage(err), "err");
        return;
      }
      if (pv && Number(pv.requests) > 0) {
        const delta = Number(pv.delta_baht) || 0;
        const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
        const perCode = (pv.per_code || []).filter((x) => Number(x.n_lines) > 0).map((x) => {
          const dl = Number(x.delta) || 0;
          return `• ${x.code}${itemName(x.code) ? " " + itemName(x.code) : ""}: ${x.requests} ใบ ${dl > 0 ? "+" : dl < 0 ? "−" : "±"}${formatMoney(Math.abs(dl))} บาท`;
        });
        const ok = await confirmDialog(
          `ราคาใหม่มีผลทั้งปีงบ ${ctx.fyCurrent()} — ใบที่ส่งแล้ว ${pv.requests} ใบ เป็นเงินเปลี่ยน ${sign}${formatMoney(Math.abs(delta))} บาท (รวมใบพิมพ์/PDF ที่ส่งแล้ว)`
          + (perCode.length ? "\n\n" + perCode.join("\n") : "")
          + "\n\nไม่แจ้ง รพ.สต.",
          { title: "ราคาใหม่ทั้งปีงบ", okText: "ยืนยันราคาใหม่" });
        if (!ok) return;
      }
    }

    const res = await formDialog("บันทึกเป็น version ใหม่", [
      { key: "note", label: "โน้ต (ไม่บังคับ, ≤ 200 ตัวอักษร)", type: "textarea", maxlength: 200, rows: 3, placeholder: "เช่น เพิ่มหน้า S08 / ปรับราคาตามสัญญาใหม่" }
    ], {
      okText: "บันทึก",
      intro: `สรุปการแก้ไข: ${summaryThai(d)}\n${changes.length ? "ราคาใหม่ใช้กับทุกใบของปีงบ (รวมใบที่ส่งแล้ว)" : "ใบที่ส่งแล้วไม่เปลี่ยน"} · แบบร่างของ รพ.สต. จะใช้ฟอร์มใหม่ทันที`,
      validate: (x) => (x.note.length > 200 ? "โน้ตยาวเกิน 200 ตัวอักษร" : "")
    });
    if (!res) return;
    ts.saving = true; drawDirty();
    saveBtn.textContent = "กำลังบันทึก...";
    try {
      const payload = { base_version_id: ts.base.id, note: res.note, form: { steps: payloadSteps() } };
      const out = await ctx.adminCall("adminFormSave", payload);
      if (out.saved) {
        // 2x R5: out.warnings = a unit whose pages carry different headers (an older form) — shown, never blocks
        toast(`บันทึกฟอร์ม version #${out.form.id} แล้ว${out.warnings && out.warnings.length ? " · ⚠ " + out.warnings.join(" · ") : ""}`);
        ts.dirty = false;
        clearRequestCache(); // 2z: a new price rewrites price_snapshot/price_print without touching the requests' updated_at
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
