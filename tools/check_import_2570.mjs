#!/usr/bin/env node
// check_import_2570.mjs — phase 2e node equivalence check for the import wizard's parser + mapper.
//
// Parses the two real FY2570 Excel files with the SAME module the browser uses (public/js/admin/import_parse.js),
// maps the items against seed/seed_2570.json's form as the "current form", simulates step 2 of the wizard
// (exact rows auto-confirmed; every other row takes the human decision recorded in phase2_seed/item_map_2570.csv,
// the map Save confirmed for the seed — or the suggestion when that CSV is absent), builds import_2570.json and
// compares it with the seed: 125 items (code, name, unit, price) + plans["2570"]. Then repeats the parse on modified
// copies of the files (renamed sheets, inserted blank columns/rows, numbers as text) and requires identical output.
//
//   node tools/check_import_2570.mjs [--form <xls>] [--plan <xls>] [--map <csv>] [--out <dir>]
//
// Exit 0 = codes, prices, units and plans equal (name/page differences are reported, see "expected differences").
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import {
  parseFormWorkbook, parsePlanWorkbook, mapItems, resolveMapping, buildImportJson, planBaht, validateImportJson, round2, cleanText, normName
} from "../public/js/admin/import_parse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const PROJ = path.resolve(REPO, "..");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FORM_XLS = arg("--form", path.join(PROJ, "1. 09.09.2569 แบบฟอร์มเบิกวัสดุทางการแพทย์ ปี 2570.xls"));
const PLAN_XLS = arg("--plan", path.join(PROJ, "2. ประมาณการเบิกวัสดุการแพทย์ ประจำปีงบ70.xls"));
const MAP_CSV = arg("--map", path.join(PROJ, "phase2_seed", "item_map_2570.csv"));
const OUT = arg("--out", path.join(os.tmpdir(), "check_import_2570"));
const SEED = JSON.parse(fs.readFileSync(path.join(REPO, "seed", "seed_2570.json"), "utf8"));
const FY = 2570;
const EXPECT_NET = { op: 1355995.02, pp: 577581.85, total: 1933576.87 }; // phase 2.md §2.1

let fails = 0;
const line = (s = "") => console.log(s);
function check(cond, label) { if (!cond) fails++; line(`${cond ? "PASS" : "FAIL"} ${label}`); return cond; }
const readWb = (file) => XLSX.read(fs.readFileSync(file), { type: "buffer" });

// ---- tiny CSV reader (quoted fields, "" escapes) -------------------------------------------------------------------------------
function readCsv(file) {
  const txt = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) {
      if (ch === '"' && txt[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && txt[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// ---- one full run: parse → map → simulated step 2 → JSON ---------------------------------------------------------------------
function runWizard(formWb, planWb, decisions, { quiet } = {}) {
  const form = parseFormWorkbook(formWb);
  const plan = parsePlanWorkbook(planWb, SEED.pcus);
  if (plan.error) throw new Error("plan: " + plan.error);
  const mapping = mapItems({ form, plan }, SEED.form);
  const stats = { exact: 0, fuzzy: 0, new: 0, agree: 0, overridden: [] };
  for (const it of mapping.items) {
    stats[it.suggestion.kind]++;
    const want = decisions ? decisions.get(it.seq) : undefined;
    if (it.suggestion.kind === "exact") { if (want && want !== it.suggestion.code) stats.overridden.push({ seq: it.seq, name: it.name, kind: "exact", got: it.suggestion.code, want }); continue; }
    if (want && want !== it.suggestion.code) { stats.overridden.push({ seq: it.seq, name: it.name, kind: it.suggestion.kind, got: it.suggestion.code, sim: it.suggestion.sim, want }); it.choice = { code: want }; } else stats.agree++;
    it.confirmed = true; // the human ticks ✓ (or picks the code above)
  }
  const res = resolveMapping(mapping);
  const seed = buildImportJson({ fy: FY, parsed: { form, plan }, mapping, pcus: SEED.pcus, sources: [path.basename(FORM_XLS), path.basename(PLAN_XLS)], currentForm: SEED.form });
  if (!quiet) {
    line(`form file: ${form.pages.length} pages · ${form.items} items · ${form.pages.map((p) => `${p.sheet}=${p.rows.filter((r) => r.type === "item").length}`).join(", ")}` + (form.skipped.length ? ` · skipped ${JSON.stringify(form.skipped)}` : ""));
    form.warnings.forEach((w) => line("  warn(form): " + w));
    line(`plan file: sheet "${plan.sheet}" (${plan.sheet_rule}; candidates ${plan.candidates.join(", ")}) · ${plan.pcus.length} PCUs · ${plan.items.length} items · totals row ${plan.totals.row === null ? "–" : plan.totals.row + 1}`);
    plan.warnings.forEach((w) => line("  warn(plan): " + w));
    mapping.warnings.forEach((w) => line("  note(map): " + w));
    line(`pages → steps: ${mapping.pages.map((p) => `${p.sheet}→${p.step_code} (${p.step_how})`).join(", ")}`);
  }
  return { form, plan, mapping, res, seed, stats };
}

function flatItems(form) {
  const m = new Map();
  for (const s of form.steps) {
    let section = "";
    for (const r of s.rows) {
      if (r.type === "section") { section = r.title; continue; }
      m.set(r.code, { ...r, step: s.code, section, active: r.active !== false });
    }
  }
  return m;
}
const planKey = (plans) => JSON.stringify(Object.keys(plans).sort().map((pc) => [pc, Object.keys(plans[pc]).sort().map((c) => [c, plans[pc][c]])]));

// =================================================================================================================================
line(`check_import_2570 — ${new Date().toISOString()}`);
line(`form: ${FORM_XLS}`);
line(`plan: ${PLAN_XLS}`);
let decisions = null;
if (fs.existsSync(MAP_CSV)) {
  decisions = new Map(readCsv(MAP_CSV).map((r) => [Number(r.seq_70), r.item_code.trim()]));
  line(`step-2 decisions: ${MAP_CSV} (${decisions.size} rows — the confirmed seed map; seq_70 = file seq)`);
} else line("step-2 decisions: (no item_map_2570.csv) — every suggestion accepted as is");

line("\n=== 1. parse + map the real files ===");
const run = runWizard(readWb(FORM_XLS), readWb(PLAN_XLS), decisions);
const { stats, seed, res, mapping, plan } = run;
line(`suggestions: exact ${stats.exact} (auto-confirmed) · fuzzy ${stats.fuzzy} · new ${stats.new} · non-exact suggestions equal to the confirmed map: ${stats.agree}/${stats.fuzzy + stats.new}`);
stats.overridden.forEach((o) => line(`  step 2 human choice: seq ${o.seq} "${o.name}" suggestion ${o.kind}${o.sim ? " " + Math.round(o.sim * 100) + "%" : ""} ${o.got || "(รายการใหม่)"} → chosen ${o.want}`));
check(!stats.overridden.some((o) => o.kind === "exact"), "no exact (auto-confirmed) match disagrees with the confirmed map");
check(res.ok && !res.duplicates.length, `mapping resolves: duplicates ${JSON.stringify(res.duplicates)}, unconfirmed ${res.unconfirmed}`);
check(res.missing.length === 0, `no current item missing from the file (${res.missing.map((m) => m.code).join(", ") || "none"})`);
const v = validateImportJson(seed, { pcus: SEED.pcus, fyExpected: FY });
check(!v.errors.length, `built JSON passes the client-side validator (${v.items} items)${v.errors.length ? " " + JSON.stringify(v.errors) : ""}`);

line("\n=== 2. built import_2570.json vs seed/seed_2570.json ===");
const A = flatItems(seed.form), B = flatItems(SEED.form);
const codesA = [...A.keys()].sort(), codesB = [...B.keys()].sort();
check(JSON.stringify(codesA) === JSON.stringify(codesB) && codesA.length === 125, `item codes: built ${codesA.length} / seed ${codesB.length} — identical set`);
const diff = { name: [], unit: [], price: [], step: [], section: [] };
for (const c of codesB) {
  const a = A.get(c), b = B.get(c);
  if (!a) continue;
  if (a.name !== b.name) diff.name.push([c, b.name, a.name]);
  if (cleanText(a.unit) !== cleanText(b.unit)) diff.unit.push([c, b.unit, a.unit]);
  if (round2(a.price) !== round2(b.price)) diff.price.push([c, b.price, a.price]);
  if (a.step !== b.step) diff.step.push([c, b.step, a.step]);
  if (a.section !== b.section) diff.section.push([c, b.section, a.section]);
}
check(!diff.price.length, `prices: ${125 - diff.price.length}/125 equal` + (diff.price.length ? " " + JSON.stringify(diff.price) : ""));
check(!diff.unit.length, `units: ${125 - diff.unit.length}/125 equal` + (diff.unit.length ? " " + JSON.stringify(diff.unit) : ""));
const plansA = seed.plans[String(FY)], plansB = SEED.plans[String(FY)];
let planCells = 0, planDiff = [];
for (const pc of new Set([...Object.keys(plansA), ...Object.keys(plansB)])) {
  for (const c of new Set([...Object.keys(plansA[pc] || {}), ...Object.keys(plansB[pc] || {})])) {
    planCells++;
    const a = JSON.stringify((plansA[pc] || {})[c] || null), b = JSON.stringify((plansB[pc] || {})[c] || null);
    if (a !== b) planDiff.push(`${pc}/${c}: built ${a} seed ${b}`);
  }
}
check(!planDiff.length && planKey(plansA) === planKey(plansB), `plans["2570"]: ${planCells} cells, ${planDiff.length} differ — ${planDiff.length ? planDiff.slice(0, 10).join("; ") : "identical"}`);
const tot = planBaht(seed);
check(tot.network.op === EXPECT_NET.op && tot.network.pp === EXPECT_NET.pp && tot.network.total === EXPECT_NET.total,
  `network plan baht (Σ qty × price) OP ${tot.network.op} / PP ${tot.network.pp} / total ${tot.network.total} (expect ${EXPECT_NET.total})`);
check(plan.totals.network && plan.totals.network.total === EXPECT_NET.total, `file "รวมเป็นเงิน" network cell = ${plan.totals.network && plan.totals.network.total}`);
const perBad = Object.entries(tot.per_pcu).filter(([pc, t]) => { const f = plan.totals.per_pcu[pc]; return !f || Math.abs(f.total - t.total) > 0.01 || Math.abs(f.op - t.op) > 0.01 || Math.abs(f.pp - t.pp) > 0.01; });
line(`per-PCU Σ qty×price vs the file's "รวมเป็นเงิน" row: ${15 - perBad.length}/15 match` + (perBad.length ? " · differ: " + perBad.map(([pc, t]) => `${pc} items ${JSON.stringify(t)} vs row ${JSON.stringify(plan.totals.per_pcu[pc])}`).join("; ") : ""));
const seedVerify = SEED.verify.plan_2570_per_pcu;
check(Object.entries(tot.per_pcu).every(([pc, t]) => Math.abs(seedVerify[pc].total - t.total) <= 0.01), "per-PCU plan baht = seed verify.plan_2570_per_pcu (item-row sums) for 15/15");

line("\nexpected differences (structure of the FY2570 form file ≠ the seed's form, which is form2569.json + plan-70 prices/units):");
const wsOnly = diff.name.filter(([, b, a]) => cleanText(b) === a).length;
const keyOnly = diff.name.filter(([, b, a]) => cleanText(b) !== a && normName(b) === normName(a)).length;
line(`  names: ${diff.name.length}/125 differ — the seed keeps the FY2569 names (phase 2.md §2.3); the wizard takes the names printed in the new form file`);
line(`         (${wsOnly} only by doubled/trailing spaces, ${keyOnly} only by case/quotes/spacing = same "exact" key, ${diff.name.length - wsOnly - keyOnly} reworded)`);
diff.name.slice(0, 200).forEach(([c, b, a]) => line(`    ${c}: seed "${b}" → file "${a}"`));
line(`  pages: ${diff.step.length}/125 items sit on another page in the FY2570 file (codes kept, per the brief: an existing item keeps its code)`);
diff.step.forEach(([c, b, a]) => line(`    ${c}: seed ${b} → file ${a}`));
line(`  sections: ${diff.section.length}/125 items under a differently named section heading`);
const stepsA = seed.form.steps, stepsB = SEED.form.steps;
stepsA.forEach((s) => { const o = stepsB.find((x) => x.code === s.code); if (o && (o.title !== s.title || o.subject !== s.subject || o.to !== s.to)) line(`  page ${s.code} header: title "${o.title}" → "${s.title}"${o.subject !== s.subject ? ` · subject "${o.subject}" → "${s.subject}"` : ""}${o.to !== s.to ? ` · to "${o.to}" → "${s.to}"` : ""}`); });
if (mapping.warnings.length) line(`  plan↔form name variants matched by seq: ${mapping.warnings.length} (see note(map) above)`);

// ---- 3. robustness: modified copies ---------------------------------------------------------------------------------------------
line("\n=== 3. robustness (modified copies) ===");
fs.mkdirSync(OUT, { recursive: true });
function gridOf(ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true, blankrows: true });
  return { aoa, merges: (ws["!merges"] || []).map((m) => ({ s: { ...m.s }, e: { ...m.e } })) };
}
function insertCols(g, at, n) {
  g.aoa = g.aoa.map((r) => { const x = r.slice(); while (x.length < at) x.push(""); x.splice(at, 0, ...new Array(n).fill("")); return x; });
  g.merges.forEach((m) => { if (m.s.c >= at) m.s.c += n; if (m.e.c >= at) m.e.c += n; });
}
function insertRow(g, at) {
  g.aoa.splice(at, 0, []);
  g.merges.forEach((m) => { if (m.s.r >= at) m.s.r++; if (m.e.r >= at) m.e.r++; });
}
function toSheet(g, numbersAsText) {
  const aoa = numbersAsText ? g.aoa.map((r) => r.map((v) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 6 }) : v))) : g.aoa;
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = g.merges;
  return ws;
}
function roundTrip(wb, file) {
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  fs.writeFileSync(file, buf);
  return XLSX.read(fs.readFileSync(file), { type: "buffer" });
}
const basePlan = readWb(PLAN_XLS), baseForm = readWb(FORM_XLS);
const ref = { plans: planKey(seed.plans[String(FY)]), form: JSON.stringify(seed.form.steps.map((s) => ({ ...s, rows: s.rows }))), totals: JSON.stringify(plan.totals.per_pcu), net: JSON.stringify(plan.totals.network) };
const pcuCol = (wb, sheet) => { const p = parsePlanWorkbook({ SheetNames: [sheet], Sheets: { [sheet]: wb.Sheets[sheet] } }, SEED.pcus); return Math.min(...p.pcus.map((x) => x.op_col)); };

// A (brief): plan sheet "รวม" renamed, 2 empty columns before the first PCU block, a blank row above the header
{
  const g = gridOf(basePlan.Sheets["รวม"]);
  const firstPcu = pcuCol(basePlan, "รวม");
  const headerRow = plan.header_row;
  insertCols(g, firstPcu, 2);
  insertRow(g, headerRow);
  const wb = { SheetNames: ["สรุปแผนทั้งหมด", "ทั่วไป", "NCD"], Sheets: { "สรุปแผนทั้งหมด": toSheet(g), "ทั่วไป": basePlan.Sheets["ทั่วไป"], NCD: basePlan.Sheets.NCD } };
  const file = path.join(OUT, "plan_A_renamed_2cols_blankrow.xlsx");
  const r = runWizard(baseForm, roundTrip(wb, file), decisions, { quiet: true });
  check(planKey(r.seed.plans[String(FY)]) === ref.plans && JSON.stringify(r.plan.totals.per_pcu) === ref.totals && JSON.stringify(r.plan.totals.network) === ref.net,
    `A plan: sheet renamed "รวม"→"สรุปแผนทั้งหมด" (picked by ${r.plan.sheet_rule}), +2 empty cols before col ${firstPcu + 1}, blank row above header → plans + "รวมเป็นเงิน" row identical  [${file}]`);
}
// B: + numbers stored as text ("1,234.5"), title row removed (sheet picked by largest total), plan sheet moved last
{
  const g = gridOf(basePlan.Sheets["รวม"]);
  insertCols(g, pcuCol(basePlan, "รวม"), 2);
  g.aoa[0] = [];
  const wb = { SheetNames: ["ทั่วไป", "NCD", "Sheet1"], Sheets: { "ทั่วไป": basePlan.Sheets["ทั่วไป"], NCD: basePlan.Sheets.NCD, Sheet1: toSheet(g, true) } };
  const file = path.join(OUT, "plan_B_text_numbers_no_title_last.xlsx");
  const r = runWizard(baseForm, roundTrip(wb, file), decisions, { quiet: true });
  check(r.plan.sheet === "Sheet1" && planKey(r.seed.plans[String(FY)]) === ref.plans && JSON.stringify(r.plan.totals.network) === ref.net,
    `B plan: numbers as text, no title, sheet "Sheet1" placed last (picked by ${r.plan.sheet_rule}) → plans identical  [${file}]`);
}
// C: form file — sheets renamed "หน้า 1…7", one empty column inserted at A, blank row above the header, numbers as text
{
  const names = baseForm.SheetNames.map((_, i) => `หน้า ${i + 1}`);
  const sheets = {};
  baseForm.SheetNames.forEach((n, i) => {
    const g = gridOf(baseForm.Sheets[n]);
    insertCols(g, 0, 1);
    insertRow(g, run.form.pages[i].header_row);
    sheets[names[i]] = toSheet(g, true);
  });
  const file = path.join(OUT, "form_C_renamed_shifted.xlsx");
  const r = runWizard(roundTrip({ SheetNames: names, Sheets: sheets }, file), basePlan, decisions, { quiet: true });
  const same = JSON.stringify(r.seed.form.steps.map((s) => ({ ...s, sheet: "" }))) === JSON.stringify(seed.form.steps.map((s) => ({ ...s, sheet: "" })));
  check(same && planKey(r.seed.plans[String(FY)]) === ref.plans,
    `C form: sheets renamed (pages → ${r.mapping.pages.map((p) => p.step_code + "/" + p.step_how).join(" ")}), +1 col at A, blank row above header, numbers as text → same form (codes/names/units/prices/sections) + plans  [${file}]`);
}

line(`\n${fails ? "SOME CHECKS FAILED" : "ALL PASS"} — codes/prices/units/plans ${fails ? "NOT " : ""}equal to seed_2570.json; names/pages differ as listed (expected).`);
process.exit(fails ? 1 : 0);
