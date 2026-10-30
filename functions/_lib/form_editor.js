// form_editor.js — phase 2d: form editor (adminFormGet / adminFormSave) + seed export (adminExportSeed). functions/API.md §5.2.
// A form version is immutable; "editing" = inserting a new form_versions row (data = {fy, note, steps}).
// Pages and items are never deleted — only closed (`active:false`) — so every request keeps resolving its codes.
import { err, isStr, sha256Hex, stableStringify } from "./http.js";
import {
  DEFAULT_UNIT_BY_STEP, auditStmt, batchChunked, budgetConfig, formPublic, getConfigAll, insertStatements, latestForm, loadForm, publicConfig,
} from "./db.js";
import { currentRound, fyExcelMonths, fyMonths, monthFy, nowIso } from "./time.js";
import { backdateStmts, priceEffect } from "./price.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const round2 = (x) => Math.round(x * 100) / 100;
const UNITS = ["พัสดุ", "จ่ายกลาง", "LAB"];
const STEP_CODE_RE = /^[A-Z0-9]{1,6}$/;
const ITEM_CODE_RE = /^[A-Z0-9]+-\d{2,3}$/;
const MAX_ACTIVE_STEPS = 10, MAX_STEPS = 60, MAX_ACTIVE_ITEMS = 24, MAX_SECTIONS = 2, MAX_ROWS_PER_STEP = 200;
const text = (v) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());

// ---- canonical form (lenient: never throws, so it can also normalise an old base version) ---------------------------------------
// Whitelists the known fields, trims strings, defaults `active`/`dispense_unit`, and renumbers:
//   step.order = 1..n by array order · step.page_no = running number among ACTIVE steps (null for closed pages)
//   item.seq   = running number over every item row (active or closed) of the active steps in order, then of the closed steps —
//                one global sequence, as in the seed (P2 continues where P1 stops), so an unedited form keeps its numbers.
// 2v: `links` only when non-empty (sorted, unique) — an unlinked item keeps the exact shape (and hash) it had before 2v
function canonLinks(r) {
  if (!Array.isArray(r.links)) return {};
  const l = [...new Set(r.links.map(text).filter(Boolean))].sort();
  return l.length ? { links: l } : {};
}

// 2ad: `cancel_reason` (why the item was closed for good — shown grey on the PCU form) only on a closed item with a reason, so an
// item without one keeps the exact shape (and hash) it had before 2ad; reopening drops it
function canonCancel(r) {
  const t = r.active === false ? text(r.cancel_reason) : "";
  return t ? { cancel_reason: t.slice(0, 200) } : {};
}

export function canonSteps(stepsIn) {
  const steps = (Array.isArray(stepsIn) ? stepsIn : []).map((s, i) => ({
    code: text(s.code),
    order: i + 1,
    sheet: text(s.sheet),
    page_no: null,
    title: text(s.title),
    subject: text(s.subject),
    to: text(s.to),
    dispense_unit: s.dispense_unit || DEFAULT_UNIT_BY_STEP(text(s.code)),
    active: s.active !== false,
    rows: (Array.isArray(s.rows) ? s.rows : []).map((r) => (r.type === "section"
      ? { type: "section", title: text(r.title) }
      : { type: "item", code: text(r.code), seq: 0, name: text(r.name), unit: text(r.unit), price: round2(Number(r.price) || 0), active: r.active !== false, ...canonLinks(r), ...canonCancel(r) })),
  }));
  let page = 0, seq = 0;
  for (const s of steps) if (s.active) s.page_no = ++page;
  for (const pass of [true, false]) {
    for (const s of steps) {
      if (s.active !== pass) continue;
      for (const r of s.rows) if (r.type === "item") r.seq = ++seq;
    }
  }
  return steps;
}

// Every request of `fy` bound to an older version of that fy follows the new one, so admin / dispenser / PCU / print / PDF / Excel all show the
// wording, pages and order of the latest form for the whole fiscal year (sent requests included). Lines keep their own prices
// (price_snapshot / price_print), and a newer version never drops a code (items are only closed), so every line still resolves.
export const rebindStmt = (DB, fy, id) => DB.prepare(
  `UPDATE requests SET form_version_id = ? WHERE form_version_id <> ? AND form_version_id IN (SELECT id FROM form_versions WHERE fy = ?)`
).bind(id, id, fy);

// ---- validation of the editor input (first error wins; Thai messages) -------------------------------------------------------------
function validateInput(formIn) {
  if (!isObj(formIn) || !Array.isArray(formIn.steps) || !formIn.steps.length) throw err("BAD_REQUEST", "ต้องมี form.steps อย่างน้อย 1 หน้า");
  const stepsIn = formIn.steps;
  if (stepsIn.length > MAX_STEPS) throw err("BAD_REQUEST", `มีหน้ามากเกินไป (สูงสุด ${MAX_STEPS} รวมหน้าที่ปิดแล้ว)`);

  const stepCodes = new Set(), itemCodes = new Set();
  let activeSteps = 0;
  const clean = [];
  stepsIn.forEach((s, i) => {
    if (!isObj(s)) throw err("BAD_REQUEST", `หน้าที่ ${i + 1} ไม่ถูกต้อง`);
    const code = s.code;
    if (!isStr(code) || !STEP_CODE_RE.test(code)) throw err("BAD_REQUEST", `หน้าที่ ${i + 1}: รหัสหน้าต้องเป็น A–Z หรือ 0–9 ไม่เกิน 6 ตัว`);
    if (stepCodes.has(code)) throw err("BAD_REQUEST", `รหัสหน้าซ้ำ: ${code}`);
    stepCodes.add(code);
    const label = `หน้า ${code}`;

    const title = text(s.title);
    if (!isStr(s.title) || !title) throw err("BAD_REQUEST", `${label}: ต้องมีชื่อหน้า`);
    if (title.length > 120) throw err("BAD_REQUEST", `${label}: ชื่อหน้ายาวเกิน 120 ตัวอักษร`);
    for (const [k, th] of [["sheet", "ชื่อแบบ"], ["subject", "เรื่อง"], ["to", "เรียน"]]) {
      if (s[k] !== undefined && s[k] !== null && !isStr(s[k])) throw err("BAD_REQUEST", `${label}: ${th}ต้องเป็นข้อความ`);
      if (text(s[k]).length > 120) throw err("BAD_REQUEST", `${label}: ${th}ยาวเกิน 120 ตัวอักษร`);
    }
    const unit = s.dispense_unit === undefined || s.dispense_unit === null ? DEFAULT_UNIT_BY_STEP(code) : s.dispense_unit;
    if (!UNITS.includes(unit)) throw err("BAD_REQUEST", `${label}: หน่วยจ่ายต้องเป็น พัสดุ / จ่ายกลาง / LAB`);
    if (s.active !== undefined && typeof s.active !== "boolean") throw err("BAD_REQUEST", `${label}: active ต้องเป็น true/false`);
    const active = s.active !== false;
    if (active) activeSteps++;
    if (!Array.isArray(s.rows)) throw err("BAD_REQUEST", `${label}: ต้องมี rows`);
    if (s.rows.length > MAX_ROWS_PER_STEP) throw err("BAD_REQUEST", `${label}: มีแถวมากเกินไป (สูงสุด ${MAX_ROWS_PER_STEP})`);

    let sections = 0, activeItems = 0;
    for (const r of s.rows) {
      if (!isObj(r)) throw err("BAD_REQUEST", `${label}: แถวไม่ถูกต้อง`);
      if (r.type === "section") {
        const t = text(r.title);
        if (!isStr(r.title) || !t) throw err("BAD_REQUEST", `${label}: หัวหมวดต้องมีชื่อ`);
        if (t.length > 80) throw err("BAD_REQUEST", `${label}: หัวหมวด "${t.slice(0, 20)}…" ยาวเกิน 80 ตัวอักษร`);
        if (++sections > MAX_SECTIONS) throw err("BAD_REQUEST", `${label}: มีหัวหมวดได้ไม่เกิน ${MAX_SECTIONS} หัว`);
        continue;
      }
      if (r.type !== "item") throw err("BAD_REQUEST", `${label}: ชนิดแถวต้องเป็น item หรือ section`);
      const ic = r.code;
      if (!isStr(ic) || !ITEM_CODE_RE.test(ic)) throw err("BAD_REQUEST", `${label}: รหัสรายการ "${String(ic).slice(0, 20)}" ไม่ถูกต้อง (รูปแบบ P1-01)`);
      if (itemCodes.has(ic)) throw err("BAD_REQUEST", `รหัสรายการซ้ำ: ${ic}`);
      itemCodes.add(ic);
      const name = text(r.name);
      if (!isStr(r.name) || !name) throw err("BAD_REQUEST", `รายการ ${ic}: ต้องมีชื่อรายการ`);
      if (name.length > 200) throw err("BAD_REQUEST", `รายการ ${ic}: ชื่อยาวเกิน 200 ตัวอักษร`);
      if (r.unit !== undefined && r.unit !== null && !isStr(r.unit)) throw err("BAD_REQUEST", `รายการ ${ic}: หน่วยต้องเป็นข้อความ`);
      if (text(r.unit).length > 30) throw err("BAD_REQUEST", `รายการ ${ic}: หน่วยยาวเกิน 30 ตัวอักษร`);
      if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price < 0 || r.price > 1e9) throw err("BAD_REQUEST", `รายการ ${ic}: ราคาต้องเป็นตัวเลข ≥ 0`);
      if (r.active !== undefined && typeof r.active !== "boolean") throw err("BAD_REQUEST", `รายการ ${ic}: active ต้องเป็น true/false`);
      if (r.cancel_reason !== undefined && r.cancel_reason !== null && !isStr(r.cancel_reason)) throw err("BAD_REQUEST", `รายการ ${ic}: เหตุผลยกเลิกต้องเป็นข้อความ`);
      if (text(r.cancel_reason).length > 200) throw err("BAD_REQUEST", `รายการ ${ic}: เหตุผลยกเลิกยาวเกิน 200 ตัวอักษร`);
      if (r.active !== false) activeItems++;
    }
    if (activeItems > MAX_ACTIVE_ITEMS) throw err("BAD_REQUEST", `${label}: มีรายการที่เปิดใช้ได้ไม่เกิน ${MAX_ACTIVE_ITEMS} รายการ (ตอนนี้ ${activeItems}) — ปิดรายการหรือย้ายไปหน้าอื่น`);
    if (!active && activeItems) throw err("BAD_REQUEST", `${label}: ปิดหน้าไม่ได้ เพราะยังมีรายการที่เปิดใช้อยู่ ${activeItems} รายการ — ปิดรายการทั้งหมดก่อน`);
    clean.push(s);
  });
  if (activeSteps < 1) throw err("BAD_REQUEST", "ต้องมีหน้าที่เปิดใช้อย่างน้อย 1 หน้า");
  if (activeSteps > MAX_ACTIVE_STEPS) throw err("BAD_REQUEST", `มีหน้าที่เปิดใช้ได้ไม่เกิน ${MAX_ACTIVE_STEPS} หน้า (ตอนนี้ ${activeSteps})`);
  assertLinks(clean, (m) => err("BAD_REQUEST", m));
  return clean;
}

// 2v: item `links` = old codes this item replaces (same thing, new code) — its prior-year data / lines count under this item.
// A linked code: valid item code, not the item itself, linked from one item only, and not an OPEN item of the form (a closed row or
// a code that only exists in older data). Shared by the editor and the import (import_fy.js assertFormRules). `bad(msg)` → Error.
export function assertLinks(steps, bad) {
  const active = new Set(), seen = new Map();
  for (const s of steps) for (const r of s.rows || []) if (r && r.type === "item" && r.active !== false && s.active !== false) active.add(r.code);
  for (const s of steps) for (const r of s.rows || []) {
    if (!r || r.type !== "item" || r.links === undefined || r.links === null) continue;
    if (!Array.isArray(r.links) || r.links.length > 10) throw bad(`รายการ ${r.code}: links ต้องเป็นรายการรหัสเดิม (ไม่เกิน 10)`);
    for (const c0 of r.links) {
      const c = text(c0);
      if (!isStr(c0) || !ITEM_CODE_RE.test(c)) throw bad(`รายการ ${r.code}: รหัสเดิมที่เชื่อม "${String(c0).slice(0, 20)}" ไม่ถูกต้อง`);
      if (c === r.code) throw bad(`รายการ ${r.code}: เชื่อมกับรหัสตัวเองไม่ได้`);
      if (active.has(c)) throw bad(`รายการ ${r.code}: เชื่อมกับ ${c} ไม่ได้ เพราะ ${c} ยังเปิดใช้อยู่ — ปิด ${c} ก่อน`);
      if (seen.has(c) && seen.get(c) !== r.code) throw bad(`รหัสเดิม ${c} ถูกเชื่อมกับหลายรายการ (${seen.get(c)}, ${r.code})`);
      seen.set(c, r.code);
    }
  }
}

// ---- diff of two canonical step lists --------------------------------------------------------------------------------------------
function indexOf(steps) {
  const items = new Map();
  for (const s of steps) for (const r of s.rows) if (r.type === "item") items.set(r.code, { item: r, step: s });
  return items;
}
export function diffSteps(baseSteps, newSteps) {
  const d = {
    steps_added: [], steps_closed: [], steps_reopened: [], items_added: [], items_closed: [], items_reopened: [],
    price_changed: [], renamed: [], unit_changed: [], moved: [], linked: [],
  };
  const bs = new Map(baseSteps.map((s) => [s.code, s]));
  for (const s of newSteps) {
    const o = bs.get(s.code);
    if (!o) d.steps_added.push(s.code);
    else if (o.active && !s.active) d.steps_closed.push(s.code);
    else if (!o.active && s.active) d.steps_reopened.push(s.code);
  }
  const bi = indexOf(baseSteps);
  for (const [code, { item, step }] of indexOf(newSteps)) {
    const o = bi.get(code);
    if (!o) { d.items_added.push(code); continue; }
    if (o.item.active && !item.active) d.items_closed.push(code);
    else if (!o.item.active && item.active) d.items_reopened.push(code);
    if (o.item.price !== item.price) d.price_changed.push({ code, old: o.item.price, new: item.price });
    if (o.item.name !== item.name) d.renamed.push({ code, old: o.item.name, new: item.name });
    if (o.item.unit !== item.unit) d.unit_changed.push(code);
    if (o.step.code !== step.code) d.moved.push({ code, from: o.step.code, to: step.code });
  }
  // 2v: links added / removed per item
  for (const [code, { item }] of indexOf(newSteps)) {
    const o = bi.get(code);
    const was = (o && o.item.links) || [], now = item.links || [];
    if (was.join(",") !== now.join(",")) d.linked.push({ code, old: was, new: now });
  }
  return d;
}

// audit.detail is capped at 2000 chars by auditStmt: keep it valid JSON by falling back to counts for a huge diff
function auditDetail(id, note, diff) {
  let s = JSON.stringify({ id, note, diff });
  if (s.length <= 1900) return s;
  const counts = Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.length]));
  s = JSON.stringify({ id, note: note.slice(0, 200), diff_counts: counts, truncated: true });
  return s;
}

// ---- shapes ---------------------------------------------------------------------------------------------------------------------------
const adminForm = (form) => (form ? { ...formPublic(form), created_by: form.created_by ?? null } : null);
const versionsList = async (DB) => (await DB.prepare(`SELECT id, fy, created_at, created_by, note FROM form_versions ORDER BY id DESC`).all()).results;

// ---- actions --------------------------------------------------------------------------------------------------------------------------
export async function adminFormGet(ctx, p) {
  const id = Number(p.id);
  if (!Number.isInteger(id) || id < 1) throw err("BAD_REQUEST", "id ไม่ถูกต้อง");
  const form = await loadForm(ctx.DB, id);
  if (!form) throw err("NOT_FOUND", "ไม่พบฟอร์ม version นี้");
  return { form: adminForm(form), price_history: await priceHistoryList(ctx.DB, await fyCurrentOf(ctx.DB)) };
}

// ---- 2z: one price per fy (price_history = log only) -----------------------------------------------------------------------------
const fyCurrentOf = async (DB) => publicConfig(await getConfigAll(DB), monthFy(currentRound())).fy_current;

// adminFormGet / adminFormSave `price_history` (fy_current): [{code, from_round, price, set_at, set_by, note}] by code, from_round
async function priceHistoryList(DB, fy) {
  const { results } = await DB.prepare(
    `SELECT item_code AS code, from_round, price, set_at, set_by, note FROM price_history WHERE fy = ? ORDER BY item_code, from_round`
  ).bind(fy).all();
  return results.map((r) => ({ code: r.code, from_round: r.from_round, price: r.price, set_at: r.set_at ?? null, set_by: r.set_by ?? null, note: r.note ?? null }));
}

// the price_history log row of a change: currentRound clamped into the fy's 12 rounds (PK fy,item,from_round → same round = upsert)
function logRound(fy) {
  const ms = fyMonths(fy), cur = currentRound();
  return cur < ms[0] ? ms[0] : cur > ms[11] ? ms[11] : cur;
}

// adminPricePreview{changes:[{code, price}]} — what adminFormSave will do to the SENT requests of fy_current (no write; 2z: whole fy,
// a from_round sent by an old client is ignored). → {requests, months:[first,last]|[], delta_baht, per_code:[{code, n_lines, delta, old, price, requests}]}
export async function adminPricePreview(ctx, p) {
  const { DB } = ctx;
  const fyCur = await fyCurrentOf(DB);
  const form = await latestForm(DB, fyCur);
  if (!form) throw err("NOT_FOUND", "ยังไม่มีแบบฟอร์มในระบบ");
  if (!Array.isArray(p.changes) || !p.changes.length) throw err("BAD_REQUEST", "ต้องมี changes อย่างน้อย 1 รายการ");
  if (p.changes.length > 400) throw err("BAD_REQUEST", "changes มากเกินไป");
  const seen = new Set();
  const changes = p.changes.map((c) => {
    if (!isObj(c) || !isStr(c.code) || !form.index.has(c.code)) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + String(c && c.code).slice(0, 20));
    if (seen.has(c.code)) throw err("BAD_REQUEST", "รหัสรายการซ้ำ: " + c.code);
    seen.add(c.code);
    if (typeof c.price !== "number" || !Number.isFinite(c.price) || c.price < 0 || c.price > 1e9) throw err("BAD_REQUEST", `รายการ ${c.code}: ราคาต้องเป็นตัวเลข ≥ 0`);
    return { code: c.code, price: round2(c.price) };
  });
  const e = await priceEffect(DB, fyCur, null, form, changes);
  return { ...e, per_code: e.per_code.map((x) => ({ code: x.code, n_lines: x.n_lines, delta: x.delta, old: x.old, price: x.price, requests: x.requests })) };
}

// 2x R5: the sheet header (title / subject / to) is edited per dispense unit — every page of one unit should carry the same header.
// A difference (an older form) is a warning, never an error: [Thai message per unit].
export function headerWarnings(steps) {
  const first = new Map(), bad = new Set();
  for (const s of steps) {
    const u = s.dispense_unit || "";
    const h = [s.title || "", s.subject || "", s.to || ""].join("\u0000");
    if (!first.has(u)) first.set(u, h);
    else if (first.get(u) !== h) bad.add(u);
  }
  return [...bad].map((u) => `หัวใบ (ชื่อเรื่อง/เรื่อง/เรียน) ของหน้าหน่วยจ่าย "${u}" ไม่เหมือนกันทุกหน้า`);
}

export async function adminFormSave(ctx, p) {
  const { DB, who } = ctx;
  const baseId = p.base_version_id;
  if (!Number.isInteger(baseId) || baseId < 1) throw err("BAD_REQUEST", "ต้องมี base_version_id (จำนวนเต็ม)");
  if (p.note !== undefined && p.note !== null && !isStr(p.note)) throw err("BAD_REQUEST", "โน้ตต้องเป็นข้อความ");
  const note = text(p.note);
  if (note.length > 200) throw err("BAD_REQUEST", "โน้ตยาวเกิน 200 ตัวอักษร");
  const base = await loadForm(DB, baseId);
  if (!base) throw err("NOT_FOUND", "ไม่พบฟอร์ม version ที่ใช้เป็นฐาน");
  const latestRow = await DB.prepare(`SELECT id FROM form_versions WHERE fy = ? ORDER BY id DESC LIMIT 1`).bind(base.fy).first();
  if (!latestRow || latestRow.id !== base.id) throw err("CONFLICT", "มีการบันทึกฟอร์ม version ใหม่ไปแล้ว — โหลดใหม่ก่อนแก้");

  // 2z: `price_from` (2p) is ignored when an old client still sends it
  const fyCur = await fyCurrentOf(DB);

  const newSteps = canonSteps(validateInput(p.form));
  const baseSteps = canonSteps(base.steps);
  const bi = indexOf(baseSteps), ni = indexOf(newSteps);
  const ns = new Set(newSteps.map((s) => s.code));
  for (const s of baseSteps) if (!ns.has(s.code)) throw err("BAD_REQUEST", `ลบหน้าไม่ได้ ให้ปิดหน้าแทน: ${s.code}`);
  for (const code of bi.keys()) if (!ni.has(code)) throw err("BAD_REQUEST", `ลบรายการไม่ได้ ให้ปิดรายการแทน: ${code}`);

  // "same" = identical structure (the note is not part of the comparison)
  const [hNew, hBase] = await Promise.all([
    sha256Hex(stableStringify({ fy: base.fy, steps: newSteps })),
    sha256Hex(stableStringify({ fy: base.fy, steps: baseSteps })),
  ]);
  if (hNew === hBase) return { saved: false, same: true, form: adminForm(base), versions: await versionsList(DB) };

  // 2z: a changed price is THE price of the fy — every sent (submitted/issued) line of the fy gets it in price_snapshot AND price_print
  // (only the lines that differ are written). price_history gets a log row at currentRound (clamped into the fy). The effect is computed
  // BEFORE the write with the same function adminPricePreview uses.
  const diff = diffSteps(baseSteps, newSteps);
  const changes = diff.price_changed.map((c) => ({ code: c.code, price: c.new, from_round: logRound(base.fy) }));
  const effect = changes.length ? await priceEffect(DB, base.fy, null, base, changes) : null;

  // same hashing as the importer (importer.js): sha256(stableStringify({fy, note, steps})) — so a seed exported from this version re-imports as "same"
  const data = { fy: base.fy, note: note || null, steps: newSteps };
  const hash = await sha256Hex(stableStringify(data));
  const ts = nowIso();
  // atomic: insert only if `base` is still the latest of its fy (two admins saving at once → the second gets CONFLICT)
  const res = await DB.prepare(
    `INSERT INTO form_versions (fy,created_at,created_by,note,data,data_hash)
     SELECT ?,?,?,?,?,? WHERE (SELECT MAX(id) FROM form_versions WHERE fy = ?) = ?`
  ).bind(base.fy, ts, who.email, note || null, JSON.stringify(data), hash, base.fy, base.id).run();
  if (!res.meta || !res.meta.changes) throw err("CONFLICT", "มีการบันทึกฟอร์ม version ใหม่ไปแล้ว — โหลดใหม่ก่อนแก้");
  const newId = res.meta.last_row_id;
  const stmts = [];
  if (changes.length || diff.items_added.length) {
    const HCOLS = ["fy", "item_code", "from_round", "price", "set_by", "set_at", "note"];
    const first = fyMonths(base.fy)[0], hnote = `form v${newId}`;
    // base rows (INSERT OR IGNORE): a changed item keeps its old price from the fy's first round; an added item gets its price from there
    const baseRows = [
      ...diff.price_changed.map((c) => [base.fy, c.code, first, c.old, who.email, ts, hnote]),
      ...diff.items_added.map((code) => [base.fy, code, first, ni.get(code).item.price, who.email, ts, hnote]),
    ];
    stmts.push(...insertStatements(DB, "price_history", HCOLS, baseRows, { prefix: "INSERT OR IGNORE INTO" }));
    stmts.push(...insertStatements(DB, "price_history", HCOLS, changes.map((c) => [base.fy, c.code, c.from_round, c.price, who.email, ts, hnote]), {
      suffix: "ON CONFLICT(fy,item_code,from_round) DO UPDATE SET price=excluded.price, set_by=excluded.set_by, set_at=excluded.set_at, note=excluded.note",
    }));
  }
  const moved = effect ? effect.per_code : [];
  stmts.push(...backdateStmts(DB, moved));
  stmts.push(rebindStmt(DB, base.fy, newId));
  stmts.push(auditStmt(DB, who.email, who.role, "form_save", "", "", auditDetail(newId, note, diff)));
  for (const x of moved) {
    stmts.push(auditStmt(DB, who.email, who.role, "price_fy", "", String(base.fy), JSON.stringify({
      code: x.code, old: x.old, new: x.price, fy: base.fy, requests: x.requests, lines: x.n_lines, delta: x.delta, form_version: newId,
    })));
  }
  await batchChunked(DB, stmts);
  const form = await loadForm(DB, newId);
  return {
    saved: true, form: adminForm(form), versions: await versionsList(DB), diff, warnings: headerWarnings(newSteps),
    price_fy: moved.map((x) => ({ code: x.code, old: x.old, new: x.price, requests: x.requests, lines: x.n_lines, delta: x.delta })),
    price_history: await priceHistoryList(DB, fyCur),
  };
}

// Current DB state in the `pcu-supply-import/1` shape (seed/FORMAT.md) so the seed JSON can be regenerated from the live system.
export async function adminExportSeed(ctx, p) {
  const { DB } = ctx;
  const cfgAll = await getConfigAll(DB);
  const cfg = { ...publicConfig(cfgAll, monthFy(currentRound())), ...budgetConfig(cfgAll) };
  let fy = cfg.fy_current;
  if (p.fy !== undefined && p.fy !== null) {
    fy = Number(p.fy);
    if (!Number.isInteger(fy) || fy < 2500 || fy > 2700) throw err("BAD_REQUEST", "fy ไม่ถูกต้อง (พ.ศ.)");
  }

  const [pcuRes, planRes, priceRes, actRes, statRes, limRes, fvRow] = await Promise.all([
    DB.prepare(`SELECT code, name, print_name, "group" AS grp FROM pcus ORDER BY code`).all(),
    DB.prepare(`SELECT fy, pcu, item_code, plan_op, plan_pp FROM plans ORDER BY fy, pcu, item_code`).raw(),
    DB.prepare(`SELECT fy, item_code, price FROM prices_prev ORDER BY fy, item_code`).raw(),
    DB.prepare(`SELECT fy, month, pcu, item_code, op, pp FROM actual_prev ORDER BY fy, pcu, item_code, month`).raw(),
    DB.prepare(`SELECT fy, pcu, item_code, median_m, p90_m, annual_qty FROM stats ORDER BY fy, pcu, item_code`).raw(),
    DB.prepare(`SELECT pcu, item_code, limit_month, limit_year, source FROM limits WHERE fy = ? ORDER BY pcu, item_code`).bind(fy).raw(),
    DB.prepare(`SELECT id FROM form_versions WHERE fy = ? ORDER BY id DESC LIMIT 1`).bind(fy).first(),
  ]);

  const seed = {
    format: "pcu-supply-import/1", fy, generated_at: nowIso(), generated_by: "adminExportSeed", sources: ["D1 export"],
    pcus: pcuRes.results.map((r) => ({ code: r.code, name: r.name, print_name: r.print_name || r.name, group: r.grp })),
  };
  if (fvRow) {
    const f = await loadForm(DB, fvRow.id);
    seed.form = { fy: f.fy, note: f.note ?? null, steps: f.steps };
  }
  const nest = (rows, valueOf) => {
    const out = {};
    for (const r of rows) {
      const [f, pcu, code] = r;
      ((out[f] ||= {})[pcu] ||= {})[code] = valueOf(r);
    }
    return out;
  };
  seed.plans = nest(planRes, (r) => [r[3] || 0, r[4] || 0]);
  seed.prices_prev = {};
  for (const [f, code, price] of priceRes) (seed.prices_prev[f] ||= {})[code] = price || 0;
  seed.actual_prev = {};
  for (const [f, month, pcu, code, op, pp] of actRes) {
    const blk = (seed.actual_prev[f] ||= { months: fyExcelMonths(Number(f)), data: {} }); // Excel columns Oct … Sep
    const i = blk.months.indexOf(month);
    if (i < 0) continue; // a month outside the fy's 12 cannot be represented
    const e = ((blk.data[pcu] ||= {})[code] ||= { op: new Array(12).fill(0), pp: new Array(12).fill(0) });
    e.op[i] = op || 0; e.pp[i] = pp || 0;
  }
  seed.stats = nest(statRes, (r) => [r[3] || 0, r[4] || 0, r[5] || 0]);
  const lim = {};
  for (const [pcu, code, lm, ly, source] of limRes) ((lim[pcu] ||= {})[code] = [lm ?? null, ly ?? null, source || "import"]);
  seed.limits = { [fy]: lim };
  seed.config = {
    // 2ad: the STORED limit_mode (cfg.limit_mode is the effective one — always "off" from fy 2570)
    fy_current: cfg.fy_current, limit_mode: cfgAll.limit_mode === "off" ? "off" : "warn", stock_required: cfg.stock_required,
    budget_op: cfg.budget_op, budget_pp: cfg.budget_pp, budget_total: cfg.budget_total, deadline_day: cfg.deadline_day,
  };
  return { seed };
}
