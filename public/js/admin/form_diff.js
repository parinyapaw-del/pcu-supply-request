// js/admin/form_diff.js — pure helpers for the form editor (tab 10, phase 2.md §5.9).
// No DOM, no API calls. Validation mirrors the backend rules of `adminFormSave` (briefs/2d_backend.md):
// the server is still the authority; this only gives the admin an early, page-specific message.

export const MAX_ACTIVE_STEPS = 10;
export const MAX_ACTIVE_ITEMS = 24;
export const MAX_SECTIONS = 2;
export const DISPENSE_UNITS = ["พัสดุ", "จ่ายกลาง", "LAB"];
export const STEP_CODE_RE = /^[A-Z0-9]{1,6}$/;
export const ITEM_CODE_RE = /^[A-Z0-9]+-\d{2,3}$/;

const isItem = (r) => r && r.type === "item";
const isSection = (r) => r && r.type === "section";
export const isActive = (x) => x && x.active !== false;
const str = (v) => (v === null || v === undefined ? "" : String(v));
const round2 = (n) => Math.round(Number(n) * 100) / 100;

export function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Canonical shape used for comparison / saving / preview: order = array order, page_no = running number
// among active steps, seq = running number of item rows inside a step (all items), strings trimmed, price 2 decimals.
export function normalizeForm(form) {
  let pageNo = 0;
  const steps = (form.steps || []).map((s, i) => {
    const active = s.active !== false;
    if (active) pageNo += 1;
    let seq = 0;
    const rows = (s.rows || []).map((r) => {
      if (isSection(r)) return { type: "section", title: str(r.title).trim() };
      seq += 1;
      const price = typeof r.price === "number" ? r.price : (str(r.price).trim() === "" ? NaN : Number(r.price));
      return {
        type: "item", code: str(r.code).trim(), seq, name: str(r.name).trim(), unit: str(r.unit).trim(),
        price: isFinite(price) ? round2(price) : price, active: r.active !== false
      };
    });
    return {
      code: str(s.code).trim(), order: i + 1, sheet: str(s.sheet).trim(), page_no: active ? pageNo : null,
      title: str(s.title).trim(), subject: str(s.subject).trim(), to: str(s.to).trim(),
      dispense_unit: s.dispense_unit || "พัสดุ", active, rows
    };
  });
  return { steps };
}

// Stable string of the editable content (ignores order/page_no/seq numbering) — used for the dirty flag.
export function formSignature(form) {
  const n = normalizeForm(form);
  return JSON.stringify(n.steps.map((s) => [s.code, s.sheet, s.title, s.subject, s.to, s.dispense_unit, s.active,
    s.rows.map((r) => (r.type === "section" ? ["S", r.title] : ["I", r.code, r.name, r.unit, r.price, r.active]))]));
}

function stepLabel(s, idx) {
  const name = str(s.sheet).trim() || str(s.code);
  return `หน้า ${str(s.code) || idx + 1}${name && name !== s.code ? ` (${name})` : ""}`;
}

// -> {ok:true} | {ok:false, message, stepCode?, code?}  (first error wins, like the server)
export function validateForm(form, baseForm) {
  const fail = (message, stepCode, code) => ({ ok: false, message, stepCode, code });
  const steps = (form && form.steps) || [];
  const activeSteps = steps.filter(isActive);
  if (activeSteps.length < 1) return fail("ต้องมีหน้าที่เปิดอยู่อย่างน้อย 1 หน้า");
  if (activeSteps.length > MAX_ACTIVE_STEPS) return fail(`เปิดได้ไม่เกิน ${MAX_ACTIVE_STEPS} หน้า (ตอนนี้ ${activeSteps.length} หน้า) — ปิดบางหน้าก่อน`);

  const stepCodes = new Set();
  const itemCodes = new Map(); // code -> step code
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const label = stepLabel(s, i);
    const code = str(s.code).trim();
    if (!STEP_CODE_RE.test(code)) return fail(`${label}: รหัสหน้าต้องเป็น A–Z หรือ 0–9 ยาว 1–6 ตัว`, s.code);
    if (stepCodes.has(code)) return fail(`${label}: รหัสหน้า ${code} ซ้ำ`, s.code);
    stepCodes.add(code);
    const title = str(s.title).trim();
    if (!title) return fail(`${label}: ต้องกรอก "ชื่อเรื่องบนหัวใบ"`, s.code);
    if (title.length > 120) return fail(`${label}: ชื่อเรื่องบนหัวใบยาวเกิน 120 ตัวอักษร`, s.code);
    for (const [k, th] of [["sheet", "ชื่อใบ"], ["subject", "เรื่อง"], ["to", "เรียน"]]) {
      if (str(s[k]).trim().length > 120) return fail(`${label}: "${th}" ยาวเกิน 120 ตัวอักษร`, s.code);
    }
    if (!DISPENSE_UNITS.includes(s.dispense_unit)) return fail(`${label}: หน่วยจ่ายต้องเป็น ${DISPENSE_UNITS.join(" / ")}`, s.code);

    const rows = s.rows || [];
    const sections = rows.filter(isSection);
    if (sections.length > MAX_SECTIONS) return fail(`${label}: หัวหมวดได้ไม่เกิน ${MAX_SECTIONS} หัว (ตอนนี้ ${sections.length})`, s.code);
    for (const r of sections) {
      const t = str(r.title).trim();
      if (!t) return fail(`${label}: หัวหมวดต้องมีชื่อ`, s.code);
      if (t.length > 80) return fail(`${label}: ชื่อหัวหมวดยาวเกิน 80 ตัวอักษร`, s.code);
    }
    let activeItems = 0;
    for (const r of rows) {
      if (!isItem(r)) continue;
      const ic = str(r.code).trim();
      if (!ITEM_CODE_RE.test(ic)) return fail(`${label}: รหัสรายการ "${ic}" ไม่ถูกรูปแบบ (เช่น P1-23)`, s.code, ic);
      if (itemCodes.has(ic)) return fail(`${label}: รหัสรายการ ${ic} ซ้ำกับหน้า ${itemCodes.get(ic)}`, s.code, ic);
      itemCodes.set(ic, code);
      const name = str(r.name).trim();
      if (!name) return fail(`${label}: รายการ ${ic} ต้องมีชื่อรายการ`, s.code, ic);
      if (name.length > 200) return fail(`${label}: ชื่อรายการ ${ic} ยาวเกิน 200 ตัวอักษร`, s.code, ic);
      if (str(r.unit).trim().length > 30) return fail(`${label}: หน่วยของ ${ic} ยาวเกิน 30 ตัวอักษร`, s.code, ic);
      const price = typeof r.price === "number" ? r.price : (str(r.price).trim() === "" ? NaN : Number(r.price));
      if (!isFinite(price) || price < 0) return fail(`${label}: ราคาของ ${ic} ต้องเป็นตัวเลข ≥ 0`, s.code, ic);
      if (isActive(r)) activeItems += 1;
    }
    if (activeItems > MAX_ACTIVE_ITEMS) return fail(`${label}: รายการที่เปิดได้ไม่เกิน ${MAX_ACTIVE_ITEMS} รายการต่อหน้า (ตอนนี้ ${activeItems}) — ปิดหรือย้ายบางรายการ`, s.code);
    if (!isActive(s) && activeItems > 0) return fail(`${label}: ปิดหน้าไม่ได้เพราะยังมีรายการที่เปิดอยู่ ${activeItems} รายการ`, s.code);
  }

  if (baseForm) {
    for (const bs of baseForm.steps || []) {
      if (!stepCodes.has(bs.code)) return fail(`หน้า ${bs.code} หายไป — ลบหน้าไม่ได้ ให้ปิดหน้าแทน`, bs.code);
      for (const r of bs.rows || []) {
        if (isItem(r) && !itemCodes.has(r.code)) return fail(`รายการ ${r.code} หายไป — ลบรายการไม่ได้ ให้ปิดรายการแทน`, bs.code, r.code);
      }
    }
  }
  return { ok: true };
}

function indexForm(form) {
  const steps = {};
  const items = {};
  (form && form.steps ? form.steps : []).forEach((s) => {
    steps[s.code] = s;
    (s.rows || []).forEach((r) => { if (isItem(r)) items[r.code] = { ...r, stepCode: s.code }; });
  });
  return { steps, items };
}

// Same shape as the backend `diff` of adminFormSave.
export function diffForms(oldForm, newForm) {
  const a = indexForm(oldForm), b = indexForm(newForm);
  const d = {
    steps_added: [], steps_closed: [], steps_reopened: [], items_added: [], items_closed: [], items_reopened: [],
    price_changed: [], renamed: [], unit_changed: [], moved: []
  };
  Object.values(b.steps).forEach((s) => {
    const o = a.steps[s.code];
    if (!o) { d.steps_added.push(s.code); return; }
    if (isActive(o) && !isActive(s)) d.steps_closed.push(s.code);
    if (!isActive(o) && isActive(s)) d.steps_reopened.push(s.code);
  });
  Object.values(b.items).forEach((it) => {
    const o = a.items[it.code];
    if (!o) { d.items_added.push(it.code); return; }
    if (isActive(o) && !isActive(it)) d.items_closed.push(it.code);
    if (!isActive(o) && isActive(it)) d.items_reopened.push(it.code);
    const op = round2(o.price), np = round2(it.price);
    if (op !== np) d.price_changed.push({ code: it.code, old: op, new: np });
    if (str(o.name).trim() !== str(it.name).trim()) d.renamed.push({ code: it.code, old: o.name, new: it.name });
    if (str(o.unit).trim() !== str(it.unit).trim()) d.unit_changed.push(it.code);
    if (o.stepCode !== it.stepCode) d.moved.push({ code: it.code, from: o.stepCode, to: it.stepCode });
  });
  return d;
}

export function diffIsEmpty(d) {
  return Object.values(d).every((v) => !v.length);
}

function codesList(arr, max = 6) {
  const codes = arr.map((x) => (typeof x === "string" ? x : x.code));
  return codes.length > max ? `${codes.slice(0, max).join(", ")} …` : codes.join(", ");
}

// "เพิ่ม 2 รายการ (S08-01, P1-23) · ราคาเปลี่ยน 3 รายการ · ปิด 1 รายการ"
export function summaryThai(d) {
  const parts = [];
  if (d.steps_added.length) parts.push(`เพิ่ม ${d.steps_added.length} หน้า (${codesList(d.steps_added)})`);
  if (d.steps_closed.length) parts.push(`ปิด ${d.steps_closed.length} หน้า (${codesList(d.steps_closed)})`);
  if (d.steps_reopened.length) parts.push(`เปิดหน้าอีกครั้ง ${d.steps_reopened.length} หน้า (${codesList(d.steps_reopened)})`);
  if (d.items_added.length) parts.push(`เพิ่ม ${d.items_added.length} รายการ (${codesList(d.items_added)})`);
  if (d.price_changed.length) parts.push(`ราคาเปลี่ยน ${d.price_changed.length} รายการ`);
  if (d.renamed.length) parts.push(`แก้ชื่อ ${d.renamed.length} รายการ`);
  if (d.unit_changed.length) parts.push(`แก้หน่วย ${d.unit_changed.length} รายการ`);
  if (d.moved.length) parts.push(`ย้ายหน้า ${d.moved.length} รายการ`);
  if (d.items_closed.length) parts.push(`ปิด ${d.items_closed.length} รายการ`);
  if (d.items_reopened.length) parts.push(`เปิดอีกครั้ง ${d.items_reopened.length} รายการ`);
  return parts.length ? parts.join(" · ") : "ไม่มีการเปลี่ยนแปลง";
}

// Detailed groups for the diff modal: [{label, lines:[string]}]. `nameOf(code)` resolves an item name.
export function diffDetailsThai(d, nameOf = () => "") {
  const nm = (code) => { const n = nameOf(code); return n ? `${code} ${n}` : code; };
  const money = (n) => Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const groups = [
    ["หน้าที่เพิ่ม", d.steps_added.map((c) => `หน้า ${c}`)],
    ["หน้าที่ปิด", d.steps_closed.map((c) => `หน้า ${c}`)],
    ["หน้าที่เปิดอีกครั้ง", d.steps_reopened.map((c) => `หน้า ${c}`)],
    ["รายการที่เพิ่ม", d.items_added.map(nm)],
    ["ราคาเปลี่ยน", d.price_changed.map((x) => `${nm(x.code)}: ${money(x.old)} → ${money(x.new)} บาท`)],
    ["แก้ชื่อรายการ", d.renamed.map((x) => `${x.code}: "${x.old}" → "${x.new}"`)],
    ["แก้หน่วย", d.unit_changed.map(nm)],
    ["ย้ายหน้า", d.moved.map((x) => `${nm(x.code)}: หน้า ${x.from} → หน้า ${x.to}`)],
    ["รายการที่ปิด", d.items_closed.map(nm)],
    ["รายการที่เปิดอีกครั้ง", d.items_reopened.map(nm)]
  ];
  return groups.filter(([, lines]) => lines.length).map(([label, lines]) => ({ label, lines }));
}

// Next item code for a step: prefix = most common prefix of the step's items (else the step code),
// number = max used anywhere (draft + base) for that prefix + 1, zero-padded to 2 (3 above 99).
export function nextItemCode(form, stepCode, baseForm) {
  const step = (form.steps || []).find((s) => s.code === stepCode);
  const counts = {};
  ((step && step.rows) || []).forEach((r) => {
    if (!isItem(r)) return;
    const p = str(r.code).split("-")[0];
    if (p) counts[p] = (counts[p] || 0) + 1;
  });
  let prefix = stepCode;
  let best = 0;
  Object.entries(counts).forEach(([p, n]) => { if (n > best || (n === best && p === stepCode)) { prefix = p; best = n; } });
  let max = 0;
  [form, baseForm].forEach((f) => (f && f.steps ? f.steps : []).forEach((s) => (s.rows || []).forEach((r) => {
    if (!isItem(r)) return;
    const m = /^([A-Z0-9]+)-(\d{2,3})$/.exec(str(r.code));
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  })));
  const n = max + 1;
  if (n > 999) return null;
  return `${prefix}-${String(n).padStart(n > 99 ? 3 : 2, "0")}`;
}

// Suggested code for a new page: "S" + two digits, starting at (number of steps + 1), first unused.
export function suggestStepCode(form, baseForm) {
  const used = new Set();
  [form, baseForm].forEach((f) => (f && f.steps ? f.steps : []).forEach((s) => used.add(s.code)));
  for (let n = (form.steps || []).length + 1; n < 100; n++) {
    const c = "S" + String(n).padStart(2, "0");
    if (!used.has(c)) return c;
  }
  return "";
}

// Item counters of one step: {activeItems, items, sections}
export function stepCounts(step) {
  const rows = (step && step.rows) || [];
  return {
    activeItems: rows.filter((r) => isItem(r) && isActive(r)).length,
    items: rows.filter(isItem).length,
    sections: rows.filter(isSection).length
  };
}
