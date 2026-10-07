// import_fy.js — phase 2e: open a new fiscal year. adminImportPreview (read-only report) + adminImportApply (rollover).
// Contract: functions/API.md §5.3 · file format: seed/FORMAT.md. The write path is the idempotent importer (importer.js).
// Both actions share ONE analysis (`analyse`) so the preview shows exactly what apply will do.
import { err, isStr } from "./http.js";
import { getConfigAll, latestForm, publicConfig } from "./db.js";
import { canonSteps } from "./form_editor.js";
import { adminImportSeed, formRecord, validateSeed } from "./importer.js";
import { defaultLimit } from "./admin.js";
import { currentRound, fyExcelMonths, fyMonths, monthFy, nowIso, prevMonth } from "./time.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const round2 = (x) => Math.round((x + 1e-9) * 100) / 100; // same rounding as tools/build_seed_2570.py r2()
const money = (x) => Math.round(x * 100) / 100;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const CONFIG_KEYS = ["fy_current", "limit_mode", "stock_required", "budget_op", "budget_pp", "budget_total", "deadline_day"];
const yy = (fy) => String(fy % 100).padStart(2, "0");

// ---- form rules ---------------------------------------------------------------------------------------------------------
// Mirror of validateInput() in form_editor.js (the editor's rules; that module is not touched by 2e) — keep the two in sync.
// Throws BAD_REQUEST (Thai) naming the page / item.
const UNITS = ["พัสดุ", "จ่ายกลาง", "LAB"];
const STEP_CODE_RE = /^[A-Z0-9]{1,6}$/;
const ITEM_CODE_RE = /^[A-Z0-9]+-\d{2,3}$/;
const MAX_ACTIVE_STEPS = 10, MAX_STEPS = 60, MAX_ACTIVE_ITEMS = 24, MAX_SECTIONS = 2, MAX_ROWS_PER_STEP = 200;
const txt = (v) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim());
const bad = (m) => err("BAD_REQUEST", "ฟอร์มในไฟล์: " + m);

function assertFormRules(steps) {
  if (!Array.isArray(steps) || !steps.length) throw bad("ต้องมี steps อย่างน้อย 1 หน้า");
  if (steps.length > MAX_STEPS) throw bad(`มีหน้ามากเกินไป (สูงสุด ${MAX_STEPS} รวมหน้าที่ปิดแล้ว)`);
  const stepCodes = new Set(), itemCodes = new Set();
  let activeSteps = 0;
  steps.forEach((s, i) => {
    if (!isObj(s)) throw bad(`หน้าที่ ${i + 1} ไม่ถูกต้อง`);
    const code = s.code;
    if (!isStr(code) || !STEP_CODE_RE.test(code)) throw bad(`หน้าที่ ${i + 1}: รหัสหน้าต้องเป็น A–Z หรือ 0–9 ไม่เกิน 6 ตัว`);
    if (stepCodes.has(code)) throw bad(`รหัสหน้าซ้ำ: ${code}`);
    stepCodes.add(code);
    const label = `หน้า ${code}`;
    if (!isStr(s.title) || !txt(s.title)) throw bad(`${label}: ต้องมีชื่อหน้า`);
    if (txt(s.title).length > 120) throw bad(`${label}: ชื่อหน้ายาวเกิน 120 ตัวอักษร`);
    for (const [k, th] of [["sheet", "ชื่อแบบ"], ["subject", "เรื่อง"], ["to", "เรียน"]]) {
      if (s[k] !== undefined && s[k] !== null && !isStr(s[k])) throw bad(`${label}: ${th}ต้องเป็นข้อความ`);
      if (txt(s[k]).length > 120) throw bad(`${label}: ${th}ยาวเกิน 120 ตัวอักษร`);
    }
    if (!UNITS.includes(s.dispense_unit)) throw bad(`${label}: หน่วยจ่ายต้องเป็น พัสดุ / จ่ายกลาง / LAB`);
    if (typeof s.active !== "boolean") throw bad(`${label}: active ต้องเป็น true/false`);
    if (s.active) activeSteps++;
    if (!Array.isArray(s.rows)) throw bad(`${label}: ต้องมี rows`);
    if (s.rows.length > MAX_ROWS_PER_STEP) throw bad(`${label}: มีแถวมากเกินไป (สูงสุด ${MAX_ROWS_PER_STEP})`);
    let sections = 0, activeItems = 0;
    for (const r of s.rows) {
      if (!isObj(r)) throw bad(`${label}: แถวไม่ถูกต้อง`);
      if (r.type === "section") {
        const t = txt(r.title);
        if (!isStr(r.title) || !t) throw bad(`${label}: หัวหมวดต้องมีชื่อ`);
        if (t.length > 80) throw bad(`${label}: หัวหมวด "${t.slice(0, 20)}…" ยาวเกิน 80 ตัวอักษร`);
        if (++sections > MAX_SECTIONS) throw bad(`${label}: มีหัวหมวดได้ไม่เกิน ${MAX_SECTIONS} หัว`);
        continue;
      }
      if (r.type !== "item") throw bad(`${label}: ชนิดแถวต้องเป็น item หรือ section`);
      const ic = r.code;
      if (!isStr(ic) || !ITEM_CODE_RE.test(ic)) throw bad(`${label}: รหัสรายการ "${String(ic).slice(0, 20)}" ไม่ถูกต้อง (รูปแบบ P1-01)`);
      if (itemCodes.has(ic)) throw bad(`รหัสรายการซ้ำ: ${ic}`);
      itemCodes.add(ic);
      if (!isStr(r.name) || !txt(r.name)) throw bad(`รายการ ${ic}: ต้องมีชื่อรายการ`);
      if (txt(r.name).length > 200) throw bad(`รายการ ${ic}: ชื่อยาวเกิน 200 ตัวอักษร`);
      if (txt(r.unit).length > 30) throw bad(`รายการ ${ic}: หน่วยยาวเกิน 30 ตัวอักษร`);
      if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price < 0 || r.price > 1e9) throw bad(`รายการ ${ic}: ราคาต้องเป็นตัวเลข ≥ 0`);
      if (r.active !== false) activeItems++;
    }
    if (activeItems > MAX_ACTIVE_ITEMS) throw bad(`${label}: มีรายการที่เปิดใช้ได้ไม่เกิน ${MAX_ACTIVE_ITEMS} รายการ (ตอนนี้ ${activeItems}) — ปิดรายการหรือย้ายไปหน้าอื่น`);
    if (!s.active && activeItems) throw bad(`${label}: ปิดหน้าไม่ได้ เพราะยังมีรายการที่เปิดใช้อยู่ ${activeItems} รายการ`);
  });
  if (activeSteps < 1) throw bad("ต้องมีหน้าที่เปิดใช้อย่างน้อย 1 หน้า");
  if (activeSteps > MAX_ACTIVE_STEPS) throw bad(`มีหน้าที่เปิดใช้ได้ไม่เกิน ${MAX_ACTIVE_STEPS} หน้า (ตอนนี้ ${activeSteps})`);
}

// Items of a steps list: code -> {item, step}
const itemIndex = (steps) => {
  const m = new Map();
  for (const s of steps) for (const r of s.rows) if (r.type === "item") m.set(r.code, { item: r, step: s });
  return m;
};

// The form of the NEW fiscal year = the file's form + every item of the old form that the file no longer lists, kept as a closed
// item (`active:false`) in its original page (a closed page when the file dropped the page) — pages and items are never deleted, so
// old request lines, stats and actual_prev keep resolving their codes. Canonical numbering as in the form editor.
function buildNewSteps(fileSteps, oldForm) {
  const steps = JSON.parse(JSON.stringify(fileSteps));
  if (oldForm) {
    const have = itemIndex(steps);
    const byCode = new Map(steps.map((s) => [s.code, s]));
    for (const os of oldForm.steps) {
      const lost = os.rows.filter((r) => r.type === "item" && !have.has(r.code)).map((r) => ({ ...r, active: false }));
      if (!lost.length) continue;
      const target = byCode.get(os.code);
      if (target) target.rows.push(...lost);
      else {
        const closed = { ...os, active: false, rows: lost };
        steps.push(closed); byCode.set(closed.code, closed);
      }
    }
  }
  return canonSteps(steps);
}

// ---- numbers of the old fiscal year (derived from the requests in the DB) -------------------------------------------------------
// numpy.percentile(..., method="linear") of an ascending array
function percentile(sorted, q) {
  const k = (sorted.length - 1) * q, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}
const median = (sorted) => { const n = sorted.length, h = n >> 1; return n % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2; };

// {months, data:{pcu:{code:{op:[12],pp:[12]}}}} + stats {pcu:{code:[median,p90,annual]}} + counts, from submitted/issued requests of `o`
// 2j: the requests counted are the 12 ROUND months of `o` (fyMonths, Nov … Oct); the block is written in Excel shape (months =
// fyExcelMonths(o), Oct … Sep) — round m lands in the column of its submission month prevMonth(m) (slot i ↔ round fyMonths(o)[i]).
// actual_months are reported in those Excel labels too (they are what the "ปีก่อน" tab will show).
async function deriveFromRequests(DB, o) {
  const months = fyMonths(o);
  const excel = fyExcelMonths(o);
  const idx = new Map(months.map((m, i) => [m, i]));
  const [lineRes, cntRes] = await Promise.all([
    DB.prepare(`SELECT r.month, r.pcu, l.item_code, COALESCE(l.op,0), COALESCE(l.pp,0)
                FROM requests r JOIN request_lines l ON l.request_id = r.id
                WHERE r.status IN ('submitted','issued') AND r.month >= ? AND r.month <= ? AND COALESCE(l.op,0) + COALESCE(l.pp,0) > 0
                ORDER BY r.pcu, l.item_code, r.month`).bind(months[0], months[11]).raw(),
    DB.prepare(`SELECT month, COUNT(*) AS n FROM requests WHERE status IN ('submitted','issued') AND month >= ? AND month <= ? GROUP BY month ORDER BY month`)
      .bind(months[0], months[11]).all(),
  ]);
  const data = {};
  for (const [month, pcu, code, op, pp] of lineRes) {
    const i = idx.get(month);
    if (i === undefined) continue;
    const e = ((data[pcu] ||= {})[code] ||= { op: new Array(12).fill(0), pp: new Array(12).fill(0) });
    e.op[i] = op; e.pp[i] = pp;
  }
  const stats = {};
  for (const [pcu, items] of Object.entries(data)) {
    for (const [code, e] of Object.entries(items)) {
      const t = e.op.map((v, i) => v + e.pp[i]);
      const annual = t.reduce((a, b) => a + b, 0);
      if (!(annual > 0)) continue;
      const sorted = [...t].sort((a, b) => a - b);
      (stats[pcu] ||= {})[code] = [round2(median(sorted)), round2(percentile(sorted, 0.9)), round2(annual)];
    }
  }
  const actualRows = Object.values(data).reduce((a, o2) => a + Object.values(o2).reduce((s, e) => s + e.op.filter((x, i) => x + e.pp[i] > 0).length, 0), 0);
  return {
    block: { months: excel, data }, stats,
    actual_rows: actualRows,
    stats_rows: Object.values(stats).reduce((a, o2) => a + Object.keys(o2).length, 0),
    requests_counted: cntRes.results.reduce((a, r) => a + r.n, 0),
    actual_months: cntRes.results.map((r) => prevMonth(r.month)),
  };
}

// ---- the shared analysis ---------------------------------------------------------------------------------------------------------
async function currentFy(DB) {
  const cfgAll = await getConfigAll(DB);
  return { cfgAll, fyCur: publicConfig(cfgAll, monthFy(currentRound())).fy_current };
}

// mode of a file: "same_fy" (fy == fy_current) | "rollover" (fy == fy_current + 1) | BAD_REQUEST
function modeOf(seed, fyCur) {
  if (seed.fy === fyCur) return "same_fy";
  if (seed.fy === fyCur + 1) return "rollover";
  throw err("BAD_REQUEST", `ปีงบในไฟล์ (${seed.fy}) ต้องเป็นปีงบปัจจุบัน (${fyCur}) หรือปีถัดไป (${fyCur + 1})`);
}

async function analyse(DB, seed, fyCur, cfgAll, mode) {
  const fy = seed.fy;
  const warnings = [];
  if (!isObj(seed.form)) throw err("BAD_REQUEST", "ไฟล์ต้องมี form");
  if (!isObj(seed.plans) || !isObj(seed.plans[String(fy)])) throw err("BAD_REQUEST", `ไฟล์ต้องมี plans ของปีงบ ${fy}`);
  if (Number.isInteger(seed.form.fy) && seed.form.fy !== fy) throw err("BAD_REQUEST", `form.fy (${seed.form.fy}) ไม่ตรงกับ fy ของไฟล์ (${fy})`);
  const planFile = seed.plans[String(fy)];

  const [pcuRes, versRes, oldForm] = await Promise.all([
    DB.prepare(`SELECT code FROM pcus ORDER BY code`).all(),
    DB.prepare(`SELECT id, data_hash FROM form_versions WHERE fy = ?`).bind(fy).all(),
    latestForm(DB, fyCur),
  ]);
  const dbPcus = pcuRes.results.map((r) => r.code);
  const dbSet = new Set(dbPcus);
  const filePcus = Array.isArray(seed.pcus) ? seed.pcus.map((r) => r.code) : null;
  const known = new Set([...dbSet, ...(filePcus || [])]);

  // ---- pcus ----
  const pcus = filePcus
    ? { known: filePcus.filter((c) => dbSet.has(c)), new: filePcus.filter((c) => !dbSet.has(c)), missing_in_file: dbPcus.filter((c) => !filePcus.includes(c)) }
    : { known: [], new: [], missing_in_file: [] };
  if (!filePcus) warnings.push("ไฟล์ไม่มีรายการ pcus — ใช้รายชื่อ รพ.สต. เดิมในระบบ");
  if (pcus.missing_in_file.length) warnings.push(`รพ.สต. ที่มีในระบบแต่ไม่อยู่ในไฟล์ ${pcus.missing_in_file.length} แห่ง (${pcus.missing_in_file.slice(0, 5).join(", ")}) — ข้อมูลเดิมไม่ถูกลบ`);

  // ---- form ----
  // rollover: file form + closed carry-over of dropped items; same_fy: the file form as it is (what adminImportSeed would see)
  const oldFormOk = oldForm && (mode === "rollover");
  if (mode === "rollover" && !oldForm) warnings.push("ยังไม่มีฟอร์มของปีงบปัจจุบันในระบบ — เปรียบเทียบรายการ/ราคาไม่ได้");
  const fileSteps = canonSteps(seed.form.steps);
  const newSteps = mode === "rollover" ? buildNewSteps(seed.form.steps, oldFormOk ? oldForm : null) : fileSteps;
  assertFormRules(newSteps);
  // rollover: the canonical merged form is what gets stored. same_fy: hashed exactly as adminImportSeed does (raw normalised file form),
  // so "same" / "skipped_differs" agree with what the importer would report.
  const note = isStr(seed.form.note) && seed.form.note.trim() ? seed.form.note.trim().slice(0, 200) : `เปิดปีงบ ${fy}`;
  const rec = mode === "rollover" ? await formRecord({ fy, note, steps: newSteps }, fy) : await formRecord(seed.form, fy);
  let version_action = "insert";
  if (versRes.results.length) {
    version_action = versRes.results.some((r) => r.data_hash === rec.hash) ? "same" : "skipped_differs";
    if (mode === "rollover") warnings.push(`ปีงบ ${fy} มีฟอร์มอยู่แล้ว — เปิดปีงบไม่ได้ (apply จะตอบ CONFLICT)`);
  }
  const newIdx = itemIndex(newSteps);
  const oldIdx = oldForm ? itemIndex(oldForm.steps) : new Map();
  const form = { steps: newSteps.length, active_items: [...newIdx.values()].filter((x) => x.item.active !== false).length, items_new: [], items_closed: [], items_reopened: [], price_changed: [], renamed: 0, version_action };
  for (const [code, { item }] of newIdx) {
    const o = oldIdx.get(code);
    if (!o) { form.items_new.push(code); continue; }
    if (o.item.active !== false && item.active === false) form.items_closed.push(code);
    else if (o.item.active === false && item.active !== false) form.items_reopened.push(code);
    if (o.item.price !== item.price) form.price_changed.push({ code, old: o.item.price, new: item.price });
    if (o.item.name !== item.name) form.renamed++;
  }
  if (oldForm) {
    const carried = [...newIdx.keys()].filter((c) => oldIdx.has(c) && !fileHas(seed.form.steps, c)).length;
    if (mode === "rollover" && carried) warnings.push(`รายการ ${carried} รายการที่มีในฟอร์มเดิมแต่ไม่อยู่ในไฟล์ จะถูกเก็บไว้เป็นรายการที่ปิดแล้ว (active:false)`);
  }

  // ---- plans (baht = qty × price of the file's form) ----
  const price = {};
  for (const [code, { item }] of newIdx) price[code] = item.price;
  const plans = { rows: 0, per_pcu: {}, network: { op: 0, pp: 0, total: 0 } };
  const unknownPlanPcu = [], noPrice = new Set();
  for (const [pcu, items] of Object.entries(planFile)) {
    if (!known.has(pcu)) { unknownPlanPcu.push(pcu); continue; }
    let op = 0, pp = 0;
    for (const [code, v] of Object.entries(items || {})) {
      plans.rows++;
      if (!(code in price)) noPrice.add(code);
      op += num(v && v[0]) * (price[code] || 0); pp += num(v && v[1]) * (price[code] || 0);
    }
    plans.per_pcu[pcu] = { op: money(op), pp: money(pp), total: money(op + pp) };
    plans.network.op += op; plans.network.pp += pp;
  }
  plans.network = { op: money(plans.network.op), pp: money(plans.network.pp), total: money(plans.network.op + plans.network.pp) };
  if (unknownPlanPcu.length) warnings.push(`plans: ไม่พบ รพ.สต. ${unknownPlanPcu.slice(0, 5).join(", ")} — ข้าม`);
  if (noPrice.size) warnings.push(`plans: ${noPrice.size} รหัสรายการไม่อยู่ในฟอร์มของไฟล์ (คิดราคา 0): ${[...noPrice].slice(0, 5).join(", ")}`);
  const planTot = isObj(seed.config) && isObj(seed.config.plan_total) ? seed.config.plan_total[String(fy)] : null;
  if (planTot && Math.abs(plans.network.total - num(planTot.total)) > 0.01) warnings.push(`ยอดแผนที่คำนวณ ${plans.network.total} ไม่ตรงกับ config.plan_total ${planTot.total}`);

  // ---- config ----
  const will_set = [];
  for (const k of CONFIG_KEYS) {
    if (mode === "rollover" && k === "fy_current") { will_set.push(k); continue; }
    if (isObj(seed.config) && seed.config[k] !== undefined && !Object.prototype.hasOwnProperty.call(cfgAll, k)) will_set.push(k);
  }

  // ---- rollover: what is derived from the old fiscal year ----
  const out = { fy, mode, version_action, rec, newSteps, planFile, known, will_set, warnings, summary: null, derived: null };
  let rollover = null, limits;
  const limitsFile = isObj(seed.limits) && isObj(seed.limits[String(fy)]) ? seed.limits[String(fy)] : null;
  const limitsInFile = limitsFile ? Object.values(limitsFile).reduce((a, o) => a + (isObj(o) ? Object.keys(o).length : 0), 0) : 0;
  if (mode === "rollover") {
    const o = fyCur;
    const d = await deriveFromRequests(DB, o);
    const has = (k) => isObj(seed[k]) && isObj(seed[k][String(o)]);
    const src = { actual_prev: has("actual_prev") ? "file" : "db", prices_prev: has("prices_prev") ? "file" : "db", stats: has("stats") ? "file" : "db" };
    const pricesPrev = src.prices_prev === "file" ? seed.prices_prev[String(o)]
      : Object.fromEntries(oldForm ? [...oldIdx].map(([c, { item }]) => [c, item.price]) : []);
    const statsEff = src.stats === "file" ? seed.stats[String(o)] : d.stats;
    if (!d.requests_counted && (src.actual_prev === "db" || src.stats === "db")) warnings.push(`ไม่พบใบเบิกที่ส่งแล้วของปีงบ ${o} — ข้อมูลเบิกจริง/สถิติของปีนั้นจะว่าง`);
    // default limits of the new fy (only when the file has none)
    const dflt = {};
    let nDefault = 0;
    if (!limitsInFile) {
      const pairs = new Set();
      for (const [pcu, items] of Object.entries(planFile)) if (known.has(pcu)) for (const code of Object.keys(items || {})) pairs.add(pcu + "\u0000" + code);
      for (const [pcu, items] of Object.entries(statsEff || {})) if (known.has(pcu)) for (const code of Object.keys(items || {})) pairs.add(pcu + "\u0000" + code);
      for (const key of [...pairs].sort()) {
        const [pcu, code] = key.split("\u0000");
        const plan = planFile[pcu] && planFile[pcu][code];
        const st = statsEff && statsEff[pcu] && statsEff[pcu][code];
        const l = defaultLimit(num(plan && plan[0]), num(plan && plan[1]), num(st && st[1]), fy);
        if (l.lm === null && l.ly === null) continue;
        (dflt[pcu] ||= {})[code] = [l.lm, l.ly, l.source];
        nDefault++;
      }
    }
    limits = { in_file: limitsInFile, will_default: nDefault };
    rollover = { from_fy: o, actual_months: src.actual_prev === "file" ? seed.actual_prev[String(o)].months : d.actual_months, requests_counted: d.requests_counted, source: src };
    out.derived = {
      o, src, actual_prev: d.block, prices_prev: pricesPrev, stats: d.stats, limits: dflt,
      counts: {
        actual_rows: src.actual_prev === "db" ? d.actual_rows : countActual(seed.actual_prev[String(o)]),
        stats_rows: src.stats === "db" ? d.stats_rows : count2(seed.stats[String(o)]),
        prices_rows: Object.keys(pricesPrev).length,
        limits_rows: limitsInFile || nDefault,
      },
    };
  } else {
    limits = { in_file: limitsInFile, will_default: 0 };
  }
  out.summary = { pcus, form, plans, limits, config: { will_set }, rollover };
  return out;
}

const fileHas = (steps, code) => steps.some((s) => s.rows.some((r) => r.type === "item" && r.code === code));
const count2 = (byPcu) => Object.values(byPcu || {}).reduce((a, o) => a + (isObj(o) ? Object.keys(o).length : 0), 0);
const countActual = (blk) => {
  let n = 0;
  for (const items of Object.values((blk && blk.data) || {})) for (const v of Object.values(items || {})) for (let i = 0; i < 12; i++) if (num(v && v.op && v.op[i]) > 0 || num(v && v.pp && v.pp[i]) > 0) n++;
  return n;
};

// ---- actions ----------------------------------------------------------------------------------------------------------------------
export async function adminImportPreview(ctx, p) {
  const { DB } = ctx;
  const seed = p.seed;
  validateSeed(seed);
  const { cfgAll, fyCur } = await currentFy(DB);
  const mode = modeOf(seed, fyCur);
  const a = await analyse(DB, seed, fyCur, cfgAll, mode);
  return { fy: seed.fy, fy_current: fyCur, mode, summary: a.summary, warnings: a.warnings };
}

export async function adminImportApply(ctx, p) {
  const { DB, who } = ctx;
  const seed = p.seed;
  validateSeed(seed);
  const { cfgAll, fyCur } = await currentFy(DB);
  const fy = seed.fy;

  // ---- 1. guards ----
  if (fy === fyCur) throw err("CONFLICT", `ปีงบ ${fy} เปิดแล้ว — ใช้ adminImportSeed สำหรับนำเข้าข้อมูลเพิ่มในปีงบปัจจุบัน`);
  modeOf(seed, fyCur); // BAD_REQUEST unless fy == fy_current + 1
  const exists = await DB.prepare(`SELECT 1 AS x FROM form_versions WHERE fy = ? LIMIT 1`).bind(fy).first();
  if (exists) throw err("CONFLICT", `ปีงบ ${fy} เปิดแล้ว`);
  if (p.confirm !== `เปิดปีงบ ${fy}`) throw err("BAD_REQUEST", `ต้องพิมพ์ยืนยัน "เปิดปีงบ ${fy}"`);

  const a = await analyse(DB, seed, fyCur, cfgAll, "rollover");
  if (a.version_action !== "insert") throw err("CONFLICT", `ปีงบ ${fy} เปิดแล้ว`);
  const dv = a.derived, o = dv.o, k = String(o), nk = String(fy);

  // ---- 2-3. old-fy numbers + default limits, added to the file (a block the file already has is kept as it is) ----
  const full = { ...seed };
  delete full.form; // the form version is committed last, together with fy_current (below)
  full.actual_prev = { ...(isObj(seed.actual_prev) ? seed.actual_prev : {}) };
  full.prices_prev = { ...(isObj(seed.prices_prev) ? seed.prices_prev : {}) };
  full.stats = { ...(isObj(seed.stats) ? seed.stats : {}) };
  full.limits = { ...(isObj(seed.limits) ? seed.limits : {}) };
  if (dv.src.actual_prev === "db") full.actual_prev[k] = dv.actual_prev;
  if (dv.src.prices_prev === "db") full.prices_prev[k] = dv.prices_prev;
  if (dv.src.stats === "db") full.stats[k] = dv.stats;
  if (!(isObj(full.limits[nk]) && Object.keys(full.limits[nk]).length)) full.limits[nk] = dv.limits;

  // ---- 4. write: every table through the idempotent importer first (re-runnable), then ONE atomic commit ----
  // The commit (form version 1 of the new fy + config.fy_current + audit) is a single D1 batch whose later statements only run when
  // the guarded form insert took effect, so two admins applying at once cannot both open the year, and an interrupted apply
  // (nothing committed yet) can simply be repeated.
  const imp = await adminImportSeed(ctx, { seed: full });
  const ts = nowIso();
  const counts = dv.counts;
  const detail = JSON.stringify({ fy, from_fy: o, ...counts, items_new: a.summary.form.items_new.length, items_closed: a.summary.form.items_closed.length });
  const res = await DB.batch([
    DB.prepare(`INSERT INTO form_versions (fy,created_at,created_by,note,data,data_hash)
                SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM form_versions WHERE fy = ?)`)
      .bind(fy, ts, who.email, a.rec.data.note, a.rec.dataJson, a.rec.hash, fy),
    DB.prepare(`INSERT INTO config (key,value) SELECT 'fy_current', ? WHERE changes() = 1
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(JSON.stringify(fy)),
    DB.prepare(`INSERT INTO audit_log (ts,actor,role,action,pcu,month,detail) SELECT ?,?,?,?,?,?,? WHERE changes() = 1`)
      .bind(ts, who.email || "", who.role || "", "fy_open", "", "", detail.slice(0, 2000)),
  ]);
  if (!res[0].meta || res[0].meta.changes !== 1) throw err("CONFLICT", `ปีงบ ${fy} เปิดแล้ว`);
  // (no per-isolate cache is keyed by fy: loadForm's cache is by immutable version id)

  const imported = { ...imp.imported, form: "inserted", config_set: [...new Set([...imp.imported.config_set, "fy_current"])] };
  return {
    fy_current: fy,
    imported,
    rollover: { ...counts, form_version_id: res[0].meta.last_row_id },
    warnings: [...new Set([...a.warnings, ...imp.warnings])],
  };
}
