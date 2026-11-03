// tab10_pages.js — แบบฟอร์ม editor: the page strip (order / add / close pages) and the fields of the selected page.
// 2ak D8: split out of renderTab10 (tab10_form.js), no behaviour change. `core` = the editor's state + helpers (see renderTab10).
import { el, toast, confirmDialog, formDialog } from "./util.js";
import { DISPENSE_UNITS, MAX_ACTIVE_STEPS, STEP_CODE_RE, isActive, stepCounts, suggestStepCode } from "./form_diff.js";

export function pagesPart(core) {
  const { ts, stripCard, fieldsCard, selStep, touch, drawAll } = core;

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
      { key: "code", label: "รหัสหน้า (A–Z, 0–9 ไม่เกิน 6 ตัว — รายการใหม่ได้รหัส M-xxx ไม่ขึ้นกับหน้า)", required: true, maxlength: 6, value: suggestStepCode(ts.draft, ts.base) }
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
    const step = {
      code, order: ts.draft.steps.length + 1, sheet: "แบบ ใหม่", title: "ใบเบิก…", subject: "",
      to: "ผู้อำนวยการโรงพยาบาลอ่างทอง", dispense_unit: "พัสดุ", active: true, rows: []
    };
    copyGroupHeader(step); // 2x R5: a new page takes the header of its dispense unit's pages
    ts.draft.steps.push(step);
    ts.sel = code; ts.focusIdx = null;
    touch(); drawAll();
    const f = fieldsCard.querySelector("#t10-f-sheet");
    if (f) { f.focus(); f.select(); }
  }

  // ---- 2x R5: the sheet header (title / subject / to) belongs to the dispense unit: editing it on one page writes every page of that unit
  const HEADER_KEYS = ["title", "subject", "to"];
  const groupOf = (s) => ts.draft.steps.filter((x) => x.dispense_unit === s.dispense_unit);
  function copyGroupHeader(s) {
    const src = ts.draft.steps.find((x) => x !== s && x.dispense_unit === s.dispense_unit);
    if (src) HEADER_KEYS.forEach((k) => { s[k] = src[k] || ""; });
  }
  function groupLabel(s) {
    let pageNo = 0;
    const pages = [];
    ts.draft.steps.forEach((x) => {
      if (isActive(x)) pageNo += 1;
      if (x.dispense_unit === s.dispense_unit) pages.push(isActive(x) ? String(pageNo) : `${x.code} (ปิด)`);
    });
    return `หัวใบ (ชื่อเรื่อง / เรื่อง / เรียน) แก้ครั้งเดียวมีผลกับหน้า ${pages.join(", ")} (${s.dispense_unit}) ทั้งปีงบเมื่อบันทึก`;
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
        if (HEADER_KEYS.includes(key)) groupOf(s).forEach((x) => { x[key] = input.value; });
        else s[key] = input.value;
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
    unit.addEventListener("change", () => { s.dispense_unit = unit.value; copyGroupHeader(s); touch(); drawFields(); });
    grid.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, "หน่วยจ่าย"), unit]));
    fieldsCard.appendChild(grid);
    fieldsCard.appendChild(el("p", { class: "admin-note", id: "t10-head-group" }, groupLabel(s)));
  }

  return { drawStrip, drawFields };
}
