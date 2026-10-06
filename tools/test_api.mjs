#!/usr/bin/env node
// test_api.mjs — plain-assert HTTP test suite for the Cloudflare Pages Functions backend (phase 2a).
// Prints "PASS …" / "FAIL …" lines and exits non-zero if anything failed.
//
//   npm test                          (starts `wrangler pages dev` itself if nothing listens on API_BASE)
//   API_BASE=http://localhost:8788 node tools/test_api.mjs     (use an already running `npm run dev`)
//
// WARNING: the suite calls the dev-only action `devReset`, which WIPES the database it talks to.
// Needs DEV_FAKE_GOOGLE=1 in .dev.vars (dev:<email> id_tokens, devReset, X-Dev-Month header).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const BASE = (process.env.API_BASE || "http://localhost:8788").replace(/\/$/, "");
const CUR = "2026-11", PREV = "2026-10", NEXT = "2026-12"; // pinned "current month" (X-Dev-Month) → deterministic fiscal-year edges
const ADMIN_EMAIL = "parinya.paw@gmail.com";

// ---- dev vars ------------------------------------------------------------------------------------------------------
function readDevVars() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(REPO, ".dev.vars"), "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch { /* fine */ }
  return out;
}
const DEV = readDevVars();
const BACKUP_KEY = process.env.BACKUP_KEY || DEV.BACKUP_KEY || "dev-backup-key";
const TOKEN_SECRET = process.env.TOKEN_SECRET || DEV.TOKEN_SECRET || "";

// ---- tiny assert framework -----------------------------------------------------------------------------------------
let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("PASS " + label); } else { fail++; console.log("FAIL " + label); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, label + (a === e ? "" : ` (got ${a}, expected ${e})`));
}
const near = (a, b, tol = 0.005) => typeof a === "number" && Math.abs(a - b) <= tol;
function expectErr(res, code, label) {
  ok(res && res.ok === false && res.error && res.error.code === code, `${label} → ${code}` + (res && res.error && res.error.code !== code ? ` (got ${res.error && res.error.code}: ${res.error && res.error.message})` : ""));
}
function section(t) { console.log("\n=== " + t + " ==="); }

// ---- http ----------------------------------------------------------------------------------------------------------------
let devMonth = CUR;
async function api(action, params = {}, token, opts = {}) {
  const res = await fetch(BASE + "/api", {
    method: "POST",
    headers: { "content-type": opts.json ? "application/json" : "text/plain;charset=utf-8", "x-dev-month": opts.month || devMonth },
    body: JSON.stringify({ action, token, ...params }),
  });
  return res.json();
}
async function mustOk(action, params, token, label) {
  const r = await api(action, params, token);
  if (!r.ok) { console.log(`FAIL ${label || action} (unexpected ${r.error && r.error.code}: ${r.error && r.error.message})`); fail++; throw new Error("fatal: " + action); }
  return r.data;
}
async function get(url, headers = {}) {
  return fetch(BASE + url, { headers: { "x-dev-month": devMonth, ...headers } });
}

// ---- token forging (tests that need an expired / tampered token) -------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function forgeToken(payload, secret = TOKEN_SECRET) {
  const a = b64u(JSON.stringify(payload));
  return a + "." + b64u(crypto.createHmac("sha256", secret).update(a).digest());
}

// ---- server lifecycle ------------------------------------------------------------------------------------------------------
let server = null;
async function reachable() {
  try { const r = await fetch(BASE + "/api"); return r.ok; } catch { return false; }
}
async function ensureServer() {
  if (await reachable()) { console.log(`using running server at ${BASE}`); return; }
  const u = new URL(BASE);
  if (!["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error(`no server at ${BASE}`);
  const state = path.join(REPO, ".wrangler", "test-state");
  fs.rmSync(state, { recursive: true, force: true });
  console.log(`starting wrangler pages dev on :${u.port || 8788} (persist: .wrangler/test-state) …`);
  server = spawn("npx", ["wrangler", "pages", "dev", "public", "--local", "--port", String(u.port || 8788), "--r2", "FILES", "--persist-to", state], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    if (await reachable()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(log.slice(-2000));
  throw new Error("wrangler did not become ready");
}
function stopServer() {
  if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ } }
}

// ---- fixture ---------------------------------------------------------------------------------------------------------------------
const fyMonths = (fy) => { const out = []; let y = fy - 543 - 1, m = 10; for (let i = 0; i < 12; i++) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m === 13) { m = 1; y++; } } return out; };
const ceil = (x) => Math.ceil(x - 1e-9);

function pct(sorted, q) { // linear interpolation percentile
  const k = (sorted.length - 1) * q, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

function buildSyntheticSeed() {
  const f = JSON.parse(fs.readFileSync(path.join(REPO, "public", "data", "form2569.json"), "utf8"));
  const steps = f.steps.map((s) => ({
    ...s,
    dispense_unit: s.code === "CS" ? "จ่ายกลาง" : s.code === "LAB" ? "LAB" : "พัสดุ",
    rows: s.rows.map((r) => (r.type === "item" ? { ...r, active: true } : r)),
  }));
  const items = steps.flatMap((s) => s.rows.filter((r) => r.type === "item"));
  const plans70 = {}, plans69 = {}, actual = {}, stats = {}, limits = {};
  const months69 = fyMonths(2569);
  f.pcus.forEach((p, i) => {
    plans70[p.code] = {}; plans69[p.code] = {}; actual[p.code] = {}; stats[p.code] = {}; limits[p.code] = {};
    items.forEach((it, j) => {
      let plan = null;
      if ((i + j) % 4 === 0) { plan = [(j % 6) + 1, j % 3]; plans70[p.code][it.code] = plan; }
      if ((i + j) % 3 === 0) plans69[p.code][it.code] = [(j % 5) + 2, 1];
      let sums = null;
      if ((i * 3 + j) % 5 === 0) {
        const op = months69.map((_, m) => ((j + m) % 4 === 0 ? (j % 7) + 1 : 0));
        const pp = months69.map((_, m) => (m % 5 === 0 ? 2 : 0));
        actual[p.code][it.code] = { op, pp };
        sums = op.map((v, m) => v + pp[m]);
        const sorted = [...sums].sort((a, b) => a - b);
        stats[p.code][it.code] = [pct(sorted, 0.5), pct(sorted, 0.9), sums.reduce((a, b) => a + b, 0)];
      }
      const st = stats[p.code][it.code];
      if (plan || st) {
        const d = defaultLimitRule(plan, st, 2570);
        if (d.lm !== null || d.ly !== null) limits[p.code][it.code] = [d.lm, d.ly, d.source];
      }
    });
  });
  const prices = Object.fromEntries(items.map((it) => [it.code, Math.round(it.price * 0.9 * 100) / 100]));
  return {
    format: "pcu-supply-import/1", fy: 2570, generated_at: "2026-10-06T00:00:00Z", generated_by: "tools/test_api.mjs (synthetic)",
    pcus: f.pcus,
    form: { fy: 2570, note: "synthetic test form", steps },
    plans: { 2570: plans70, 2569: plans69 },
    prices_prev: { 2569: prices },
    actual_prev: { 2569: { months: months69, data: actual } },
    stats: { 2569: stats },
    limits: { 2570: limits },
    config: { fy_current: 2570, limit_mode: "warn", stock_required: 0, budget_op: 520000, budget_pp: 390000, budget_total: 910000, deadline_day: null },
  };
}
// same rule as FORMAT.md / backend defaultLimit()
function defaultLimitRule(plan, stat, fy) {
  const yy = (n) => String(n % 100).padStart(2, "0");
  const sum = plan ? plan[0] + plan[1] : 0;
  const ly = sum > 0 ? ceil(sum) : null;
  let lm = null, source = `plan${yy(fy)}`;
  if (stat && stat[1] > 0) { lm = ceil(stat[1]); source = `stat${yy(fy - 1)}`; }
  else if (ly) lm = ceil((ly / 12) * 2);
  return { lm, ly, source };
}

// ====================================================================================================================================
async function main() {
  await ensureServer();
  const realSeedPath = path.join(REPO, "seed", "seed_2570.json");
  const useReal = fs.existsSync(realSeedPath) && process.env.FORCE_SYNTHETIC !== "1";
  const seed = useReal ? JSON.parse(fs.readFileSync(realSeedPath, "utf8")) : buildSyntheticSeed();
  console.log(`fixture: ${useReal ? "seed/seed_2570.json (real)" : "synthetic seed built from public/data/form2569.json"}`);
  const pcuCodes = seed.pcus.map((p) => p.code);
  const itemsOf = (form) => form.steps.flatMap((s) => s.rows.filter((r) => r.type === "item").map((r) => ({ ...r, step: s.code, unit_of: s.dispense_unit })));
  const seedItems = itemsOf(seed.form);
  const A = seedItems.find((i) => i.step === "P1"), B = seedItems.find((i) => i.step === "P2");
  const CSI = seedItems.find((i) => i.step === "CS"), LABI = seedItems.find((i) => i.step === "LAB");

  // ------------------------------------------------------------------------------------------------------------------------
  section("transport / routing");
  {
    const h = await (await fetch(BASE + "/api")).json();
    ok(h.ok && h.data.service === "pcu-supply", "GET /api health check");
    expectErr(await api("nope"), "BAD_REQUEST", "unknown action");
    const sub = await api("submit", { month: CUR });
    expectErr(sub, "BAD_REQUEST", "removed action submit");
    ok(/saveLines/.test(sub.error.message), "submit message points to saveLines (Thai hint)");
    expectErr(await api("withdraw", { month: CUR }), "BAD_REQUEST", "removed action withdraw");
    expectErr(await api("requestPdf", {}), "AUTH_REQUIRED", "requestPdf is a PCU action (2b)");
    expectErr(await api("adminFormSave", {}), "AUTH_REQUIRED", "adminFormSave needs a token (2d is live)");
    expectErr(await api("adminFormDelete", {}), "BAD_REQUEST", "unknown adminForm* action is a plain unknown action");
    expectErr(await api("issueLines", {}), "AUTH_REQUIRED", "issueLines is a staff action (2c is live)");
    const bad = await (await fetch(BASE + "/api", { method: "POST", body: "{not json" })).json();
    expectErr(bad, "BAD_REQUEST", "malformed JSON body");
    const pdf = await get("/api/pdf/abc");
    eq(pdf.status, 401, "GET /api/pdf/:id without a token → HTTP 401 (2b)");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("devReset + admin login (env admins) + seed import");
  expectErr(await api("adminBootstrap", {}), "AUTH_REQUIRED", "adminBootstrap without token");
  ok((await api("devReset")).ok, "devReset wipes D1 and recreates the schema");
  eq((await mustOk("pcuList")).pcus.length, 0, "pcuList empty after reset");
  const bad1 = await api("adminLoginGoogle", { id_token: "dev:stranger@example.com" });
  expectErr(bad1, "FORBIDDEN", "Google login of a non-admin e-mail");
  const login = await api("adminLoginGoogle", { id_token: "dev:" + ADMIN_EMAIL }, undefined, { json: true });
  ok(login.ok && login.data.role === "admin" && login.data.token, "adminLoginGoogle (ADMIN_EMAILS, users table empty), application/json body");
  const ADM = login.data.token;
  expectErr(await api("adminImportSeed", { seed }, undefined), "AUTH_REQUIRED", "import without token");
  expectErr(await api("adminImportSeed", { seed: { format: "x", fy: 2570 } }, ADM), "BAD_REQUEST", "import rejects wrong format");
  const imp = await mustOk("adminImportSeed", { seed }, ADM, "import");
  eq(imp.imported.pcus, 15, "import: 15 pcus");
  eq(imp.imported.form, "inserted", "import: form version inserted");
  ok(imp.imported.plans > 0 && imp.imported.actual_rows > 0 && imp.imported.stats > 0, "import: plans/actual_prev/stats rows written");
  ok(imp.imported.limits_inserted > 0, "import: limits inserted");
  ok(imp.imported.config_set.includes("fy_current"), "import: fy_current set (config was empty)");
  eq(imp.warnings, [], "import: no warnings");

  let boot = await mustOk("adminBootstrap", {}, ADM);
  eq(boot.pcus.length, 15, "adminBootstrap: 15 pcus");
  eq(boot.me, { email: ADMIN_EMAIL, role: "admin", units: ["พัสดุ", "จ่ายกลาง", "LAB"] }, "adminBootstrap: me");
  eq(boot.config.fy_current, 2570, "config.fy_current = 2570");
  eq(boot.config.limit_mode, "warn", "config.limit_mode default warn");
  eq(boot.config.stock_required, 0, "config.stock_required default 0");
  eq(boot.config.budget_total, 910000, "config.budget_total");
  ok(boot.form && boot.form.id && boot.form.steps.length === seed.form.steps.length, "adminBootstrap: form (latest of fy_current)");
  eq(boot.form_versions.length, 1, "form_versions list has 1 version");
  let expectedTotal = 0;
  for (const [pcu, byItem] of Object.entries(seed.plans["2570"])) for (const [code, v] of Object.entries(byItem)) {
    const it = seedItems.find((x) => x.code === code); expectedTotal += (v[0] + v[1]) * (it ? it.price : 0);
  }
  expectedTotal = Math.round(expectedTotal * 100) / 100;
  if (useReal) ok(near(boot.plan_totals.total, 1933576.87), "plan total = 1,933,576.87 (real seed)");
  else ok(near(boot.plan_totals.total, expectedTotal), `plan total = Σ plan × price (${expectedTotal}) (synthetic seed)`);
  ok(boot.prev["2569"] && boot.prev["2569"].months.length === 12 && Object.keys(boot.prev["2569"].actual).length > 0, "adminBootstrap: prev[2569] actual/plans/prices present");
  ok(Object.keys(boot.prev["2569"].prices).length > 100, "adminBootstrap: prev prices");
  eq(boot.stats.fy, 2569, "adminBootstrap: stats basis fy = 2569");
  ok(Object.keys(boot.limits).length > 0, "adminBootstrap: limits present");
  eq(boot.users_source, "env", "adminBootstrap: users from env while table empty");
  ok(boot.rounds.some((r) => r.month === CUR) && boot.rounds.some((r) => r.month === PREV), "adminBootstrap: rounds include current + previous month");

  // ------------------------------------------------------------------------------------------------------------------------
  section("PCU login / PIN lock / PIN change");
  const lst = await mustOk("pcuList");
  eq(lst.pcus.length, 15, "pcuList: 15 pcus");
  ok(lst.pcus[0].code && lst.pcus[0].name, "pcuList: code+name");
  const l1 = await api("pcuLogin", { pcu: "PCU01", pin: "12345" });
  ok(l1.ok && l1.data.token && l1.data.exp && l1.data.pcu.code === "PCU01", "pcuLogin PCU01 default PIN 12345");
  ok(l1.data.bootstrap && l1.data.bootstrap.pcu.code === "PCU01", "pcuLogin includes bootstrap");
  const T1 = l1.data.token;
  expectErr(await api("pcuLogin", { pcu: "PCU01", pin: "12a45" }), "BAD_REQUEST", "pcuLogin malformed PIN");
  expectErr(await api("pcuLogin", { pcu: "PCU99", pin: "12345" }), "NOT_FOUND", "pcuLogin unknown PCU");
  const w1 = await api("pcuLogin", { pcu: "PCU02", pin: "00000" });
  expectErr(w1, "BAD_PIN", "wrong PIN"); eq(w1.error.remaining, 4, "BAD_PIN remaining = 4");
  let last;
  for (let i = 0; i < 4; i++) last = await api("pcuLogin", { pcu: "PCU02", pin: "00000" });
  ok(!last.ok && last.error.code === "PIN_LOCKED" && last.error.until, "5th wrong PIN → PIN_LOCKED with until");
  expectErr(await api("pcuLogin", { pcu: "PCU02", pin: "12345" }), "PIN_LOCKED", "correct PIN still locked during lock");
  eq((await mustOk("adminBootstrap", {}, ADM)).pcus.find((p) => p.code === "PCU02").pin_locked_until !== null, true, "adminBootstrap shows pin_locked_until");
  ok((await api("adminUnlockPin", { pcu: "PCU02" }, ADM)).ok, "adminUnlockPin");
  ok((await api("pcuLogin", { pcu: "PCU02", pin: "12345" })).ok, "login works again after adminUnlockPin");
  const l7 = await mustOk("pcuLogin", { pcu: "PCU07", pin: "12345" });
  expectErr(await api("adminSetPin", { pcu: "PCU07", pin: "123" }, ADM), "BAD_REQUEST", "adminSetPin rejects 3 digits");
  ok((await api("adminSetPin", { pcu: "PCU07", pin: "54321" }, ADM)).ok, "adminSetPin PCU07");
  expectErr(await api("pcuBootstrap", {}, l7.token), "AUTH_EXPIRED", "old token invalid after PIN change");
  expectErr(await api("pcuLogin", { pcu: "PCU07", pin: "12345" }), "BAD_PIN", "old PIN rejected");
  ok((await api("pcuLogin", { pcu: "PCU07", pin: "54321" })).ok, "new PIN accepted");
  eq((await mustOk("adminBootstrap", {}, ADM)).pcus.find((p) => p.code === "PCU07").pin_custom, true, "adminBootstrap: pin_custom true after adminSetPin");

  // ------------------------------------------------------------------------------------------------------------------------
  section("token scoping");
  expectErr(await api("saveLines", { month: CUR, lines: {} }), "AUTH_REQUIRED", "PCU action without token");
  expectErr(await api("pcuBootstrap", {}, "garbage"), "AUTH_EXPIRED", "garbage token");
  expectErr(await api("pcuBootstrap", {}, T1.slice(0, -3) + "AAA"), "AUTH_EXPIRED", "tampered signature");
  if (TOKEN_SECRET) {
    expectErr(await api("pcuBootstrap", {}, forgeToken({ t: "pcu", pcu: "PCU01", v: 1, exp: Date.now() - 1000 })), "AUTH_EXPIRED", "expired token (correctly signed)");
    ok((await api("pcuBootstrap", {}, forgeToken({ t: "pcu", pcu: "PCU01", v: 1, exp: Date.now() + 60000 }))).ok, "forged-with-secret token verifies (sanity: HMAC format is the documented one)");
  } else { ok(true, "(skipped expired-token test: no TOKEN_SECRET readable)"); ok(true, "(skipped)"); }
  expectErr(await api("adminBootstrap", {}, T1), "FORBIDDEN", "PCU token on admin action");
  expectErr(await api("adminNote", { pcu: "PCU01", month: CUR, note: "x" }, T1), "FORBIDDEN", "PCU token on adminNote");
  expectErr(await api("pcuBootstrap", {}, ADM), "FORBIDDEN", "admin token on PCU action");
  const leak = await mustOk("saveLines", { month: CUR, pcu: "PCU02", lines: { [A.code]: { op: 1, pp: 0, stock: null, updated_at: "2026-11-01T00:00:00.000Z" } } }, T1);
  eq(leak.request.pcu, "PCU01", "saveLines ignores a pcu param — token decides the PCU");
  eq((await mustOk("adminGetRequest", { pcu: "PCU02", month: CUR }, ADM)).request, null, "PCU02 has no request after PCU01's call");

  // ------------------------------------------------------------------------------------------------------------------------
  section("PCU bootstrap shape");
  const pb = await mustOk("pcuBootstrap", {}, T1);
  for (const k of ["server_time", "current_month", "pcu", "config", "form_version_id", "form", "rounds", "older_months", "hidden", "never_prev", "limits", "plans", "unlocks", "byMonth", "issue_notices"]) ok(k in pb, `bootstrap has "${k}"`);
  eq(pb.current_month, CUR, "bootstrap.current_month honours X-Dev-Month");
  eq(pb.config, { limit_mode: "warn", stock_required: 0, deadline_day: null, fy_current: 2570 }, "bootstrap.config");
  eq(pb.rounds.map((r) => r.month), [CUR, PREV], "bootstrap.rounds = [current, previous]");
  eq(pb.rounds[0].deadline_date, "2026-11-30", "deadline = last day of month by default");
  eq(pb.rounds[0].deadline_source, "month_end", "deadline_source month_end");
  eq(pb.form_version_id, pb.form.id, "form_version_id = form.id");
  eq(pb.form.steps.length, seed.form.steps.length, "form steps");
  ok(pb.form.steps.every((s) => s.dispense_unit) && pb.form.steps[0].rows.some((r) => r.type === "item" && r.active === true), "form carries dispense_unit + item.active");
  ok(Object.keys(pb.plans).length > 0 && Object.values(pb.plans)[0].length === 2, "bootstrap.plans {code:[op,pp]}");
  ok(Object.values(pb.limits).every((v) => Array.isArray(v) && v.length === 2), "bootstrap.limits {code:[month,year]}");
  ok(Array.isArray(pb.never_prev) && Array.isArray(pb.hidden), "never_prev / hidden arrays");
  eq(pb.older_months, [], "older_months empty");
  const nev = pb.never_prev;
  const hadAny = new Set(Object.keys(seed.actual_prev["2569"].data["PCU01"] || {}).filter((c) => (seed.actual_prev["2569"].data["PCU01"][c].op.some((x) => x > 0) || seed.actual_prev["2569"].data["PCU01"][c].pp.some((x) => x > 0))));
  ok(nev.length > 0 && nev.every((c) => !hadAny.has(c)) && !nev.includes([...hadAny][0]), "never_prev = items with no FY2569 withdrawal in actual_prev");
  eq(pb.byMonth[CUR].used_fy, {}, "byMonth.used_fy empty");
  eq(pb.byMonth[CUR].prev_lines, {}, "byMonth.prev_lines empty");
  eq(Object.keys(pb.byMonth), [CUR, PREV], "byMonth keys");
  eq(pb.issue_notices, [], "issue_notices empty in 2a");

  // ------------------------------------------------------------------------------------------------------------------------
  section("saveLines: autosave, last-write-wins, validation");
  const t = (s) => `2026-11-10T10:00:0${s}.000Z`;
  expectErr(await api("saveLines", { month: NEXT, lines: {} }, T1), "BAD_REQUEST", "future month rejected");
  expectErr(await api("saveLines", { month: "2026-08", lines: {} }, T1), "BAD_REQUEST", "old month without a request rejected");
  expectErr(await api("saveLines", { month: "2026-13", lines: {} }, T1), "BAD_REQUEST", "invalid month");
  expectErr(await api("saveLines", { month: CUR, lines: { "ZZ-99": { op: 1, updated_at: t(1) } } }, T1), "BAD_REQUEST", "unknown item code");
  expectErr(await api("saveLines", { month: CUR, lines: { [A.code]: { op: -1 } } }, T1), "BAD_REQUEST", "negative qty rejected");
  expectErr(await api("saveLines", { month: CUR, lines: { [A.code]: { op: 1.5 } } }, T1), "BAD_REQUEST", "fractional qty rejected");
  let r = await mustOk("saveLines", { month: CUR, lines: { [A.code]: { stock: 2, op: 5, pp: 1, updated_at: t(1) }, [B.code]: { op: 3, pp: null, updated_at: t(1) } }, last_step: "P2", submitter_name: "สมชาย" }, T1);
  eq(r.status, "draft", "first autosave creates a draft");
  eq(r.submitted, false, "autosave is not a submit");
  eq(r.request.lines[A.code], { stock: 2, op: 5, pp: 1, updated_at: t(1) }, "line stored (PCU view has no price/issued fields)");
  eq([r.request.last_step, r.request.submitter_name], ["P2", "สมชาย"], "last_step + submitter_name stored");
  eq(r.request.form_version_id, null, "draft has no form_version_id yet");
  r = await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 9, updated_at: t(0) } } }, T1);
  eq(r.request.lines[A.code].op, 5, "older updated_at ignored (last-write-wins per line)");
  r = await mustOk("saveLines", { month: CUR, lines: { [A.code]: { stock: 2, op: 7, pp: 1, updated_at: t(2) } } }, T1);
  eq(r.request.lines[A.code].op, 7, "newer updated_at wins");
  eq(r.request.lines[B.code].op, 3, "other lines untouched");
  const tAfter = (await mustOk("adminGetRequest", { pcu: "PCU01", month: CUR }, ADM)).request.updated_at;
  await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 99, updated_at: t(0) } } }, T1);
  eq((await mustOk("adminGetRequest", { pcu: "PCU01", month: CUR }, ADM)).request.updated_at, tAfter, "stale-only autosave does not bump request.updated_at");
  ok((await mustOk("saveLines", { month: PREV, lines: {} }, T1)).status === "draft", "previous month accepted (empty autosave creates draft)");

  // ------------------------------------------------------------------------------------------------------------------------
  section("submit = saveLines{send:true}");
  const s1 = await mustOk("saveLines", { month: CUR, lines: {}, send: true }, T1);
  eq(s1.status, "submitted", "send → submitted");
  eq(s1.submitted, true, "response.submitted");
  ok(s1.request.submitted_at && s1.request.first_submitted_at === s1.request.submitted_at, "submitted_at + first_submitted_at set");
  eq(s1.request.submit_count, 1, "submit_count = 1");
  eq(s1.request.form_version_id, pb.form_version_id, "form_version_id = latest version");
  eq(s1.request.edited_after_submit, false, "not edited right after submit");
  const adm1 = await mustOk("adminGetRequest", { pcu: "PCU01", month: CUR }, ADM);
  eq(adm1.request.lines[A.code].price_snapshot, A.price, "price_snapshot per line = form price");
  eq(adm1.request.lines[B.code].price_snapshot, B.price, "price_snapshot on every line");
  eq(adm1.form_version_id, pb.form_version_id, "adminGetRequest.form_version_id");
  ok(adm1.form && adm1.form.steps.length === seed.form.steps.length && adm1.hidden && adm1.pcu.code === "PCU01", "adminGetRequest: form + hidden + pcu");
  r = await mustOk("saveLines", { month: CUR, lines: { [A.code]: { stock: 2, op: 8, pp: 1, updated_at: t(5) } } }, T1);
  eq(r.status, "submitted", "autosave after submit keeps status submitted");
  eq(r.request.edited_after_submit, true, "edit after submit → edited_after_submit");
  eq(r.request.submitted_at, s1.request.submitted_at, "submitted_at unchanged by autosave");
  const s2 = await mustOk("saveLines", { month: CUR, lines: {}, send: true }, T1);
  eq(s2.request.submit_count, 2, "resubmit: submit_count 2");
  eq(s2.request.edited_after_submit, false, "resubmit clears edited_after_submit");
  ok(s2.request.submitted_at > s1.request.submitted_at, "resubmit: new submitted_at");
  eq(s2.request.first_submitted_at, s1.request.first_submitted_at, "resubmit: first_submitted_at unchanged");
  eq((await mustOk("adminGetRequest", { pcu: "PCU01", month: CUR }, ADM)).request.lines[A.code].op, 8, "resubmit overwrote with the edited value");
  ok((await mustOk("pcuAck", { month: CUR }, T1)).issued_seen_at, "pcuAck sets issued_seen_at");
  expectErr(await api("pcuAck", { month: "2026-05" }, T1), "NOT_FOUND", "pcuAck without request");
  const pbAfter = await mustOk("pcuBootstrap", {}, T1);
  eq(pbAfter.byMonth[CUR].request.status, "submitted", "bootstrap returns the request (submitted)");
  eq(pbAfter.byMonth[PREV].request.status, "draft", "bootstrap returns previous-month request");
  const gm = await mustOk("pcuGetMonth", { month: CUR }, T1);
  ok(gm.request && "used_fy" in gm && "prev_lines" in gm && gm.round.month === CUR, "pcuGetMonth returns the month view");

  // ------------------------------------------------------------------------------------------------------------------------
  section("hidden items + stock_required");
  const T4 = (await mustOk("pcuLogin", { pcu: "PCU04", pin: "12345" })).token;
  expectErr(await api("setHidden", { codes: ["ZZ-99"] }, T4), "BAD_REQUEST", "setHidden rejects unknown code");
  eq((await mustOk("setHidden", { codes: [B.code, B.code, CSI.code] }, T4)).hidden, [B.code, CSI.code], "setHidden: dedup + full replacement");
  eq((await mustOk("pcuBootstrap", {}, T4)).hidden.sort(), [B.code, CSI.code].sort(), "bootstrap.hidden");
  eq((await mustOk("adminSetHidden", { pcu: "PCU04", codes: [B.code] }, ADM)).hidden, [B.code], "adminSetHidden");
  await mustOk("setHidden", { codes: [B.code, CSI.code] }, T4);
  expectErr(await api("adminSetConfig", { key: "stock_required", value: 2 }, ADM), "BAD_REQUEST", "stock_required must be 0/1");
  expectErr(await api("adminSetConfig", { key: "backup_pw_hash", value: "x" }, ADM), "BAD_REQUEST", "secret config keys are not settable");
  eq((await mustOk("adminSetConfig", { key: "stock_required", value: 1 }, ADM)).config.stock_required, 1, "adminSetConfig stock_required=1");
  await mustOk("saveLines", { month: CUR, lines: { [A.code]: { stock: 1, op: 2, pp: 0, updated_at: t(1) } } }, T4);
  const inc = await api("saveLines", { month: CUR, lines: {}, send: true }, T4);
  expectErr(inc, "INCOMPLETE", "send with missing stock");
  ok(Array.isArray(inc.error.missing) && inc.error.missing.length === seedItems.length - 3, "INCOMPLETE.missing = all non-hidden items without stock (minus A, minus 2 hidden)");
  ok(!inc.error.missing.includes(B.code) && !inc.error.missing.includes(CSI.code) && !inc.error.missing.includes(A.code), "hidden items and filled items not in missing");
  eq((await mustOk("adminGetRequest", { pcu: "PCU04", month: CUR }, ADM)).request.status, "draft", "failed send leaves status draft");
  const allStock = Object.fromEntries(seedItems.filter((i) => i.code !== A.code).map((i) => [i.code, { stock: 1, op: null, pp: null, updated_at: t(3) }]));
  const full = await mustOk("saveLines", { month: CUR, lines: allStock, send: true }, T4);
  eq(full.status, "submitted", "send succeeds once every non-hidden item has stock");
  await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM);
  const T5 = (await mustOk("pcuLogin", { pcu: "PCU05", pin: "12345" })).token;
  eq((await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 1, updated_at: t(1) } }, send: true }, T5)).status, "submitted", "stock_required=0 → submit without stock");

  // ------------------------------------------------------------------------------------------------------------------------
  section("limits: off / warn / enforce, used_fy, unlock");
  const T3 = (await mustOk("pcuLogin", { pcu: "PCU03", pin: "12345" })).token;
  const adminSetLimit = await mustOk("adminSetLimit", { pcu: "PCU03", code: A.code, limit_month: 100, limit_year: 20 }, ADM);
  eq([adminSetLimit.limit.source, adminSetLimit.limit.limit_year], ["admin", 20], "adminSetLimit (source admin)");
  expectErr(await api("adminSetLimit", { pcu: "PCU03", code: A.code, limit_month: -1 }, ADM), "BAD_REQUEST", "adminSetLimit rejects negative");
  expectErr(await api("adminSetLimit", { pcu: "PCU03", code: "ZZ-1", limit_month: 1 }, ADM), "BAD_REQUEST", "adminSetLimit unknown item");
  expectErr(await api("adminSetLimitMode", { mode: "strict" }, ADM), "BAD_REQUEST", "invalid limit mode");
  await mustOk("adminSetLimitMode", { mode: "off" }, ADM);
  const prevSubmit = await mustOk("saveLines", { month: PREV, lines: { [A.code]: { op: 10, pp: 5, updated_at: t(1) } }, send: true }, T3);
  eq(prevSubmit.over_limit, [], "mode off: over_limit empty and submit ok (previous month, 15 units)");
  eq((await mustOk("pcuBootstrap", {}, T3)).byMonth[CUR].used_fy[A.code], 15, "used_fy[current] = Σ other months of the fiscal year (15)");
  eq((await mustOk("pcuBootstrap", {}, T3)).byMonth[CUR].prev_lines[A.code], { op: 10, pp: 5 }, "prev_lines from previous month's submitted request");
  await mustOk("adminSetLimitMode", { mode: "enforce" }, ADM);
  await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 4, pp: 2, updated_at: t(1) } } }, T3);
  const ol = await api("saveLines", { month: CUR, lines: {}, send: true }, T3);
  expectErr(ol, "OVER_LIMIT", "enforce: 15 used + 6 > limit_year 20");
  eq(ol.error.items, [{ code: A.code, total: 6, limit_month: 100, limit_year: 20, used_fy: 15 }], "OVER_LIMIT.items detail");
  eq((await mustOk("adminGetRequest", { pcu: "PCU03", month: CUR }, ADM)).request.status, "draft", "OVER_LIMIT leaves request a draft");
  await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 3, pp: 2, updated_at: t(2) } } }, T3);
  eq((await mustOk("saveLines", { month: CUR, lines: {}, send: true }, T3)).status, "submitted", "enforce: 15 + 5 = limit (boundary) is allowed");
  await mustOk("adminSetLimit", { pcu: "PCU03", code: A.code, limit_month: 4, limit_year: null }, ADM);
  expectErr(await api("saveLines", { month: CUR, lines: {}, send: true }, T3), "OVER_LIMIT", "enforce: monthly limit 4 < total 5");
  expectErr(await api("adminUnlockLimit", { pcu: "PCU03", item_code: A.code, month: CUR, reason: "  " }, ADM), "BAD_REQUEST", "unlock needs a reason");
  const ul = await mustOk("adminUnlockLimit", { pcu: "PCU03", item_code: A.code, month: CUR, reason: "โรคระบาด" }, ADM);
  eq(ul.unlock.reason, "โรคระบาด", "adminUnlockLimit");
  eq((await mustOk("pcuBootstrap", {}, T3)).unlocks[CUR], { [A.code]: "โรคระบาด" }, "bootstrap.unlocks shows the reason");
  eq((await mustOk("saveLines", { month: CUR, lines: {}, send: true }, T3)).status, "submitted", "limit_unlocks row bypasses enforce for that month");
  ok((await mustOk("adminBootstrap", {}, ADM)).unlocks.some((u) => u.pcu === "PCU03" && u.item_code === A.code && u.month === CUR), "adminBootstrap lists unlocks");
  ok((await api("adminRemoveUnlock", { pcu: "PCU03", item_code: A.code, month: CUR }, ADM)).ok, "adminRemoveUnlock");
  expectErr(await api("adminRemoveUnlock", { pcu: "PCU03", item_code: A.code, month: CUR }, ADM), "NOT_FOUND", "adminRemoveUnlock twice");
  expectErr(await api("saveLines", { month: CUR, lines: {}, send: true }, T3), "OVER_LIMIT", "removing the unlock re-enables enforcement");
  await mustOk("adminSetLimitMode", { mode: "warn" }, ADM);
  const wr = await mustOk("saveLines", { month: CUR, lines: {}, send: true }, T3);
  ok(wr.status === "submitted" && wr.over_limit.length === 1 && wr.over_limit[0].code === A.code, "warn: submit succeeds and over_limit lists the item");
  await mustOk("adminSetLimitMode", { mode: "off" }, ADM);
  eq((await mustOk("saveLines", { month: CUR, lines: {}, send: true }, T3)).over_limit, [], "off: over_limit empty");
  await mustOk("adminSetLimitMode", { mode: "warn" }, ADM);

  // ------------------------------------------------------------------------------------------------------------------------
  section("rounds: deadline, lock");
  const T6 = (await mustOk("pcuLogin", { pcu: "PCU06", pin: "12345" })).token;
  expectErr(await api("adminSetRound", { month: CUR, deadline_date: "30/11/2026" }, ADM), "BAD_REQUEST", "adminSetRound bad date");
  expectErr(await api("adminLockRound", { month: CUR, locked: 5 }, ADM), "BAD_REQUEST", "adminLockRound bad value");
  expectErr(await api("adminSetRound", { month: "2026-1", deadline_date: null }, ADM), "BAD_REQUEST", "adminSetRound bad month");
  let rd = await mustOk("adminSetRound", { month: CUR, deadline_date: "2026-11-20", note: "ส่งก่อนวันที่ 20" }, ADM);
  eq([rd.round.deadline_date, rd.round.deadline_source, rd.round.note], ["2026-11-20", "round", "ส่งก่อนวันที่ 20"], "adminSetRound: deadline + note");
  eq((await mustOk("pcuBootstrap", {}, T6)).rounds[0].deadline_date, "2026-11-20", "PCU bootstrap shows the round deadline");
  rd = await mustOk("adminSetRound", { month: CUR, deadline_date: null }, ADM);
  eq([rd.round.deadline_date, rd.round.deadline_source], ["2026-11-30", "month_end"], "deadline override cleared → month end");
  eq(rd.round.note, "ส่งก่อนวันที่ 20", "note untouched when the key is absent");
  expectErr(await api("adminSetConfig", { key: "deadline_day", value: 40 }, ADM), "BAD_REQUEST", "deadline_day out of range");
  await mustOk("adminSetConfig", { key: "deadline_day", value: 25 }, ADM);
  let pr = (await mustOk("pcuBootstrap", {}, T6)).rounds;
  eq([pr[0].deadline_date, pr[0].deadline_source], ["2026-11-25", "config"], "config.deadline_day=25 → 25th");
  await mustOk("adminSetConfig", { key: "deadline_day", value: 31 }, ADM);
  eq((await mustOk("pcuBootstrap", {}, T6)).rounds[0].deadline_date, "2026-11-30", "deadline_day 31 clamps to the month length (Nov has 30)");
  await mustOk("adminSetConfig", { key: "deadline_day", value: null }, ADM);
  await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 1, updated_at: t(1) } } }, T6);
  eq((await mustOk("adminLockRound", { month: CUR, locked: 1 }, ADM)).round.locked, true, "adminLockRound locks");
  expectErr(await api("saveLines", { month: CUR, lines: { [A.code]: { op: 2, updated_at: t(2) } } }, T6), "CONFLICT", "locked round: autosave → CONFLICT");
  expectErr(await api("saveLines", { month: CUR, lines: {}, send: true }, T6), "CONFLICT", "locked round: send → CONFLICT");
  eq((await mustOk("pcuBootstrap", {}, T6)).rounds[0].locked, true, "bootstrap.rounds[].locked");
  ok((await mustOk("saveLines", { month: PREV, lines: {} }, T6)).status === "draft", "other months are unaffected by the lock");
  await mustOk("adminLockRound", { month: CUR, locked: 0 }, ADM);
  ok((await api("saveLines", { month: CUR, lines: { [A.code]: { op: 2, updated_at: t(2) } } }, T6)).ok, "unlocked round accepts edits again");

  // ------------------------------------------------------------------------------------------------------------------------
  section("admin note");
  const T8 = (await mustOk("pcuLogin", { pcu: "PCU08", pin: "12345" })).token;
  await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 1, updated_at: t(1) } }, send: true }, T8);
  const n1 = await mustOk("adminNote", { pcu: "PCU08", month: CUR, note: "  กรุณาตรวจจำนวน  " }, ADM);
  eq([n1.request.admin_note, n1.request.status, n1.request.edited_after_submit], ["กรุณาตรวจจำนวน", "submitted", false], "adminNote: trimmed, status unchanged, not 'edited'");
  ok(n1.request.admin_note_at, "admin_note_at set");
  eq((await mustOk("pcuBootstrap", {}, T8)).byMonth[CUR].request.admin_note, "กรุณาตรวจจำนวน", "PCU bootstrap shows admin_note");
  eq((await mustOk("adminNote", { pcu: "PCU08", month: CUR, note: "" }, ADM)).request.admin_note, null, "empty note clears");
  const n3 = await mustOk("adminNote", { pcu: "PCU09", month: CUR, note: "ยังไม่ส่ง" }, ADM);
  eq([n3.request.status, n3.request.admin_note], ["draft", "ยังไม่ส่ง"], "note on a not-started PCU creates a draft row");
  expectErr(await api("adminNote", { pcu: "PCU99", month: CUR, note: "x" }, ADM), "NOT_FOUND", "adminNote unknown PCU");

  // ------------------------------------------------------------------------------------------------------------------------
  section("admin request views");
  const ar = await mustOk("adminRequests", {}, ADM);
  ok(ar.requests.length >= 5 && ar.requests.every((x) => !("lines" in x)), "adminRequests: list without lines");
  const p01 = ar.requests.find((x) => x.pcu === "PCU01" && x.month === CUR);
  ok(p01 && p01.pcu_name && p01.progress.items_requested === 2 && p01.progress.stock_filled === 1, "adminRequests: progress (2 items requested, 1 stock filled)");
  ok(near(p01.progress.baht, (8 + 1) * A.price + 3 * B.price), "adminRequests: progress.baht uses price_snapshot");
  eq(ar.rounds.map((x) => x.month), [CUR, PREV], "adminRequests: rounds default current + previous");
  eq((await mustOk("adminRequests", { month: PREV }, ADM)).requests.every((x) => x.month === PREV), true, "adminRequests{month} filter");
  expectErr(await api("adminRequests", { month: "bad" }, ADM), "BAD_REQUEST", "adminRequests bad month");
  eq((await mustOk("adminGetRequest", { pcu: "PCU12", month: CUR }, ADM)).request, null, "adminGetRequest without a request → null");
  expectErr(await api("adminGetRequest", { pcu: "PCU99", month: CUR }, ADM), "NOT_FOUND", "adminGetRequest unknown PCU");
  boot = await mustOk("adminBootstrap", {}, ADM);
  ok(boot.months.includes(CUR) && boot.months.includes(PREV), "adminBootstrap.months lists months with requests");
  const rr = boot.rounds.find((x) => x.month === CUR);
  ok(rr && rr.note === "ส่งก่อนวันที่ 20" && rr.locked === false, "adminBootstrap.rounds has lazily created round rows");

  // ------------------------------------------------------------------------------------------------------------------------
  section("limits: reset + upload");
  let tgt = null, none = null;
  for (const p of pcuCodes) for (const it of seedItems) {
    const plan = (seed.plans["2570"][p] || {})[it.code], st = (seed.stats["2569"][p] || {})[it.code];
    if (!tgt && plan && st && st[1] > 0) tgt = { pcu: p, code: it.code, plan, st };
    if (!none && !plan && !st) none = { pcu: p, code: it.code };
  }
  ok(tgt && none, "fixture has an item with plan+stat and one with neither");
  await mustOk("adminSetLimit", { pcu: tgt.pcu, code: tgt.code, limit_month: 1, limit_year: 1 }, ADM);
  const exp = defaultLimitRule(tgt.plan, tgt.st, 2570);
  const rs = await mustOk("adminResetLimit", { pcu: tgt.pcu, code: tgt.code }, ADM);
  eq([rs.limit.limit_month, rs.limit.limit_year, rs.limit.source], [exp.lm, exp.ly, exp.source], "adminResetLimit recomputes from plans/stats (FORMAT.md rule)");
  await mustOk("adminSetLimit", { pcu: none.pcu, code: none.code, limit_month: 3, limit_year: 9 }, ADM);
  eq((await mustOk("adminResetLimit", { pcu: none.pcu, code: none.code }, ADM)).limit, null, "adminResetLimit with no plan/stat removes the row");
  eq(((await mustOk("adminBootstrap", {}, ADM)).limits[none.pcu] || {})[none.code], undefined, "…and adminBootstrap no longer lists it");

  const L = [
    { pcu_code: "PCU01", item_code: A.code, limit_month: 7, limit_year: 30, note: "ok" },
    { pcu_code: "PCU02", item_code: A.code, limit_month: "", limit_year: 12 },
    { pcu_code: "PCU99", item_code: A.code, limit_month: 1, limit_year: 1 },
    { pcu_code: "PCU01", item_code: "ZZ-99", limit_month: 1, limit_year: 1 },
    { pcu_code: "PCU03", item_code: B.code, limit_month: -2, limit_year: 5 },
    { pcu_code: "PCU03", item_code: B.code, limit_month: 1.5, limit_year: 5 },
    { pcu_code: "PCU04", item_code: A.code, limit_month: 5, limit_year: 2 },
    { pcu_code: "PCU05", item_code: A.code, limit_month: 5, limit_year: 50, item_name: "ชื่อไม่ตรง" },
    { pcu_code: "PCU05", item_code: B.code, limit_month: 5, limit_year: 50 },
    { pcu_code: "PCU05", item_code: B.code, limit_month: 6, limit_year: 50 },
    { pcu_code: "", item_code: "", limit_month: "", limit_year: "" },
    { pcu_code: "PCU06", item_code: B.code, limit_month: "abc", limit_year: 5 },
  ];
  const dry = await mustOk("adminLimitsUpload", { rows: L, dry_run: true }, ADM);
  eq(dry.applied, false, "limits upload dry_run applies nothing");
  const errRows = dry.errors.map((e) => e.row);
  eq(errRows, [4, 5, 6, 7, 10, 11, 13], "errors: unknown pcu(4), unknown item(5), negative(6), decimal(7), duplicate pair ×2 (10,11), text(13)");
  ok(dry.warnings.some((w) => w.row === 8) && dry.warnings.some((w) => w.row === 9 && /item_name/.test(w.warning)), "warnings: year<month and item_name mismatch");
  ok(!dry.errors.some((e) => e.row === 12) && !dry.warnings.some((w) => w.row === 12), "empty row (12) skipped silently");
  ok(((await mustOk("adminBootstrap", {}, ADM)).limits.PCU01 || {})[A.code]?.limit_month !== 7, "dry run left the database untouched");
  const ap = await mustOk("adminLimitsUpload", { rows: L }, ADM);
  ok(ap.applied && ap.added + ap.updated >= 3, "limits upload (merge) applies the valid rows");
  let lm = (await mustOk("adminBootstrap", {}, ADM)).limits;
  eq([lm.PCU01[A.code].limit_month, lm.PCU01[A.code].limit_year, lm.PCU01[A.code].source, lm.PCU01[A.code].note], [7, 30, "admin", "ok"], "merge: row written with source admin + note");
  const keepM = ((seed.limits["2570"].PCU02 || {})[A.code] || [null])[0];
  eq(lm.PCU02[A.code].limit_year, 12, "merge: blank limit_month leaves old month untouched, year updated");
  if (keepM !== null) eq(lm.PCU02[A.code].limit_month, keepM, "merge: blank month keeps the old value");
  else ok(true, "(PCU02 had no old month limit in fixture)");
  const clr = await mustOk("adminLimitsUpload", { rows: [{ pcu_code: "PCU01", item_code: A.code, limit_month: "CLEAR", limit_year: "" }] }, ADM);
  lm = (await mustOk("adminBootstrap", {}, ADM)).limits;
  eq([clr.updated, lm.PCU01[A.code].limit_month, lm.PCU01[A.code].limit_year], [1, null, 30], "merge: CLEAR nulls just that column");
  const rep = await mustOk("adminLimitsUpload", { rows: [{ pcu_code: "PCU01", item_code: B.code, limit_month: 2, limit_year: 4 }], mode: "replace" }, ADM);
  lm = (await mustOk("adminBootstrap", {}, ADM)).limits;
  eq(Object.keys(lm), ["PCU01"], "replace mode wipes every other pair of the fiscal year");
  eq(Object.keys(lm.PCU01), [B.code], "replace mode keeps only the uploaded rows");
  ok(rep.deleted > 0 && rep.added + rep.updated === 1, "replace: counts (deleted>0, exactly one row written)");
  expectErr(await api("adminLimitsUpload", { rows: "x" }, ADM), "BAD_REQUEST", "limits upload needs rows[]");

  // ------------------------------------------------------------------------------------------------------------------------
  section("users, roles, dispenser permissions");
  expectErr(await api("adminUsersAdd", { email: "nope", role: "admin" }, ADM), "BAD_REQUEST", "adminUsersAdd bad email");
  expectErr(await api("adminUsersAdd", { email: "d@example.com", role: "dispenser", units: [] }, ADM), "BAD_REQUEST", "dispenser needs ≥ 1 unit");
  expectErr(await api("adminUsersAdd", { email: "d@example.com", role: "dispenser", units: ["โกดัง"] }, ADM), "BAD_REQUEST", "unknown unit rejected");
  const ul0 = await mustOk("adminUsersList", {}, ADM);
  eq([ul0.source, ul0.users.map((u) => u.email)], ["env", [ADMIN_EMAIL]], "users list falls back to ADMIN_EMAILS while the table is empty");
  const ua = await mustOk("adminUsersAdd", { email: "Dispenser.Lab@Example.com", role: "dispenser", units: ["LAB"] }, ADM);
  eq(ua.users.map((u) => u.email).sort(), [ADMIN_EMAIL, "dispenser.lab@example.com"].sort(), "adding a user materialises env admins (admin not locked out)");
  eq((await mustOk("adminUsersList", {}, ADM)).source, "table", "users list now from the table");
  const dl = await mustOk("adminLoginGoogle", { id_token: "dev:dispenser.lab@example.com" });
  eq([dl.role, dl.units], ["dispenser", ["LAB"]], "dispenser Google login");
  const DSP = dl.token;
  ok((await api("adminLoginGoogle", { id_token: "dev:" + ADMIN_EMAIL })).ok, "admin still logs in after materialisation");
  const FORBID = [
    ["adminNote", { pcu: "PCU01", month: CUR, note: "x" }], ["adminSetRound", { month: CUR, deadline_date: null }], ["adminLockRound", { month: CUR, locked: 1 }],
    ["adminSetLimitMode", { mode: "off" }], ["adminSetConfig", { key: "stock_required", value: 1 }], ["adminSetLimit", { pcu: "PCU01", code: A.code, limit_month: 1 }],
    ["adminResetLimit", { pcu: "PCU01", code: A.code }], ["adminLimitsUpload", { rows: [] }], ["adminUnlockLimit", { pcu: "PCU01", item_code: A.code, month: CUR, reason: "x" }],
    ["adminRemoveUnlock", { pcu: "PCU01", item_code: A.code, month: CUR }], ["adminSetPin", { pcu: "PCU01", pin: "11111" }], ["adminUnlockPin", { pcu: "PCU01" }],
    ["adminSetHidden", { pcu: "PCU01", codes: [] }], ["adminSetBackupPassword", { password: "longenough1" }], ["adminUsersList", {}],
    ["adminUsersAdd", { email: "x@y.zz", role: "admin" }], ["adminUsersRemove", { email: "x@y.zz" }], ["adminImportSeed", { seed }], ["adminClearTrial", { confirm: "ล้างข้อมูล" }],
    ["adminBackupNow", {}], ["adminAuditLog", {}],
  ];
  let allForbidden = true;
  for (const [a, p] of FORBID) { const x = await api(a, p, DSP); if (!(x.ok === false && x.error.code === "FORBIDDEN")) { allForbidden = false; console.log(`  (not forbidden: ${a} → ${JSON.stringify(x).slice(0, 120)})`); } }
  ok(allForbidden, `dispenser FORBIDDEN on all ${FORBID.length} admin-only actions`);
  const db1 = await mustOk("adminBootstrap", {}, DSP);
  ok(db1.me.role === "dispenser" && db1.form && db1.pcus.length === 15 && !("plans" in db1) && !("users" in db1) && !("limits" in db1) && !("prev" in db1), "dispenser adminBootstrap is reduced (no plans/limits/prev/users)");
  ok(!("pin_fail" in db1.pcus[0]), "dispenser adminBootstrap hides pin state");
  ok((await api("adminRequests", {}, DSP)).ok, "dispenser may call adminRequests");
  const dg = await mustOk("adminGetRequest", { pcu: "PCU04", month: CUR }, DSP);
  ok(dg.request && Object.keys(dg.request.lines).every((c) => seedItems.find((i) => i.code === c).unit_of === "LAB"), "dispenser adminGetRequest only shows lines of its own dispense units");
  const dx = await get(`/api/export.xlsx?month=${CUR}`, { authorization: "Bearer " + DSP });
  eq(dx.status, 200, "dispenser may download the Excel export");
  expectErr(await api("adminBootstrap", {}, T1), "FORBIDDEN", "PCU token on adminBootstrap");
  ok((await api("adminUsersAdd", { email: "dispenser.lab@example.com", role: "dispenser", units: ["LAB", "พัสดุ"] }, ADM)).ok, "adminUsersAdd upserts (units changed)");
  eq((await mustOk("adminLoginGoogle", { id_token: "dev:dispenser.lab@example.com" })).units, ["LAB", "พัสดุ"], "dispenser units updated");
  ok((await api("adminUsersRemove", { email: "dispenser.lab@example.com" }, ADM)).ok, "adminUsersRemove dispenser");
  expectErr(await api("adminBootstrap", {}, DSP), "FORBIDDEN", "removed user's token is rejected (role re-read per call)");
  expectErr(await api("adminUsersRemove", { email: ADMIN_EMAIL }, ADM), "CONFLICT", "cannot remove the last admin");
  expectErr(await api("adminUsersRemove", { email: "ghost@example.com" }, ADM), "NOT_FOUND", "remove unknown user");
  expectErr(await api("adminUsersAdd", { email: ADMIN_EMAIL, role: "dispenser", units: ["LAB"] }, ADM), "CONFLICT", "cannot demote the last admin");
  ok((await mustOk("adminUsersAdd", { email: "second.admin@example.com", role: "admin" }, ADM)).users.length === 2, "add a second admin");
  const adm2 = (await mustOk("adminLoginGoogle", { id_token: "dev:second.admin@example.com" })).token;
  ok((await api("adminUsersRemove", { email: ADMIN_EMAIL }, adm2)).ok, "with two admins, one can be removed");
  expectErr(await api("adminBootstrap", {}, ADM), "FORBIDDEN", "removed admin's token is rejected");
  expectErr(await api("adminLoginGoogle", { id_token: "dev:" + ADMIN_EMAIL }), "FORBIDDEN", "removed admin can no longer log in (users table non-empty ⇒ ADMIN_EMAILS ignored)");
  ok((await api("adminUsersAdd", { email: ADMIN_EMAIL, role: "admin" }, adm2)).ok, "re-add the original admin");
  const ADM2 = (await mustOk("adminLoginGoogle", { id_token: "dev:" + ADMIN_EMAIL })).token;

  // ------------------------------------------------------------------------------------------------------------------------
  section("import idempotency");
  const counts = async () => {
    const b = await mustOk("adminBootstrap", {}, ADM2);
    const n = (o) => Object.values(o).reduce((a, v) => a + Object.keys(v).length, 0);
    const prevN = Object.values(b.prev["2569"].actual).reduce((a, o) => a + Object.values(o).reduce((s, e) => s + e.op.filter((x, i) => x > 0 || e.pp[i] > 0).length, 0), 0);
    return { pcus: b.pcus.length, plans: n(b.plans), limits: n(b.limits), stats: n(b.stats.data), versions: b.form_versions.length, actual: prevN, prices: Object.keys(b.prev["2569"].prices).length };
  };
  await mustOk("adminImportSeed", { seed }, ADM2); // restores the seed limits wiped by the replace-mode upload above (admin rows stay)
  const before = await counts();
  const keptLimit = (await mustOk("adminBootstrap", {}, ADM2)).limits.PCU01[B.code];
  const seedPcu = Object.keys(seed.limits["2570"]).find((p) => Object.keys(seed.limits["2570"][p]).length);
  const seedCode = Object.keys(seed.limits["2570"][seedPcu])[0];
  await mustOk("adminSetLimit", { pcu: seedPcu, code: seedCode, limit_month: 777, limit_year: 888 }, ADM2);
  const l3 = (await mustOk("pcuLogin", { pcu: "PCU07", pin: "54321" })).token;
  const reqsBefore = (await mustOk("adminRequests", { month: CUR }, ADM2)).requests.length;
  const imp2 = await mustOk("adminImportSeed", { seed }, ADM2);
  eq(imp2.imported.form, "same", "re-import: identical form → same (no new version)");
  eq(imp2.imported.plans, imp.imported.plans, "re-import: same plans count");
  eq(imp2.imported.actual_rows, imp.imported.actual_rows, "re-import: same actual_prev rows");
  eq(await counts(), before, "re-import: every table has the same number of rows");
  eq((await mustOk("adminBootstrap", {}, ADM2)).limits.PCU01[B.code], keptLimit, "re-import keeps the admin-edited limit");
  ok(imp2.imported.limits_kept_admin >= 1, "re-import reports limits_kept_admin");
  const kept2 = (await mustOk("adminBootstrap", {}, ADM2)).limits[seedPcu][seedCode];
  eq([kept2.limit_month, kept2.limit_year, kept2.source], [777, 888, "admin"], "re-import does not overwrite an admin-edited limit that is also in the seed");
  ok((await api("pcuBootstrap", {}, l3)).ok, "re-import keeps PIN (old token still valid)");
  ok((await api("pcuLogin", { pcu: "PCU07", pin: "54321" })).ok, "re-import keeps the admin-set PIN");
  eq((await mustOk("adminRequests", { month: CUR }, ADM2)).requests.length, reqsBefore, "re-import leaves requests alone");
  ok((await mustOk("adminBootstrap", {}, ADM2)).users.length === 2, "re-import leaves users alone");
  const changed = JSON.parse(JSON.stringify(seed));
  changed.form.steps[0].rows.find((x) => x.type === "item").price += 1;
  const imp3 = await mustOk("adminImportSeed", { seed: changed }, ADM2);
  ok(imp3.imported.form === "skipped_differs" && imp3.warnings.some((w) => /form/.test(w)), "differing form is NOT overwritten (skipped_differs + warning)");
  eq((await counts()).versions, 1, "no extra form version created");
  const sf = await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: 2571, config: { fy_current: 2571 } }, set_current_fy: true }, ADM2);
  ok(sf.imported.config_set.includes("fy_current"), "set_current_fy sets fy_current");
  eq((await mustOk("adminBootstrap", {}, ADM2)).config.fy_current, 2571, "fy_current = 2571 after set_current_fy");
  await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: 2570 }, set_current_fy: true }, ADM2);
  eq((await mustOk("adminBootstrap", {}, ADM2)).config.fy_current, 2570, "fy_current restored");
  const impC = await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: 2570, config: { limit_mode: "enforce", budget_op: 1 } } }, ADM2);
  eq(impC.imported.config_set, [], "config import never overwrites existing values");
  eq((await mustOk("adminBootstrap", {}, ADM2)).config.limit_mode, "warn", "limit_mode untouched");

  // ------------------------------------------------------------------------------------------------------------------------
  section("fiscal-year edge: previous month in FY2569 (form fallback)");
  {
    const T9 = (await mustOk("pcuLogin", { pcu: "PCU09", pin: "12345" }, undefined)).token;
    const o = { month: "2026-10" };
    const eb = await api("pcuBootstrap", {}, T9, o);
    ok(eb.ok && eb.data.rounds[0].month === "2026-10" && eb.data.rounds[1].month === "2026-09", "dev month 2026-10: rounds = [2026-10, 2026-09]");
    const e1 = await api("saveLines", { month: "2026-09", lines: { [A.code]: { op: 1, updated_at: t(1) } }, send: true }, T9, o);
    ok(e1.ok && e1.data.status === "submitted" && e1.data.request.form_version_id === eb.data.form_version_id, "FY2569 month falls back to the newest form version (no 2569 form exists)");
    const e2 = await api("pcuBootstrap", {}, T9, o);
    eq(e2.data.byMonth["2026-10"].used_fy, {}, "FY2570 used_fy ignores the FY2569 month (Sep 2026)");
    eq(e2.data.byMonth["2026-10"].prev_lines[A.code], { op: 1, pp: 0 }, "…but prev_lines still reads the previous calendar month");
    ok((await api("saveLines", { month: "2026-10", lines: {} }, T9, o)).ok, "saving in the first month of the FY works");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("Excel export");
  {
    const reqs = (await mustOk("adminRequests", { month: CUR }, ADM2)).requests;
    const lineRows = reqs.reduce((a, x) => a + x.progress.items_requested, 0);
    const submittedBaht = reqs.filter((x) => x.status === "submitted" || x.status === "issued").reduce((a, x) => a + x.progress.baht, 0);
    const x0 = await get(`/api/export.xlsx?month=${CUR}&token=${encodeURIComponent(ADM2)}`);
    eq(x0.status, 200, "GET /api/export.xlsx?month= → 200");
    ok(/spreadsheetml/.test(x0.headers.get("content-type") || ""), "content-type = xlsx");
    const cd = x0.headers.get("content-disposition") || "";
    ok(/attachment/.test(cd) && /filename\*=UTF-8''/.test(cd), "Content-Disposition: attachment + filename*=UTF-8''");
    eq(decodeURIComponent(cd.split("filename*=UTF-8''")[1]), `เบิกวัสดุ_${CUR}.xlsx`, "Thai filename เบิกวัสดุ_YYYY-MM.xlsx");
    const buf = Buffer.from(await x0.arrayBuffer());
    eq(buf.subarray(0, 2).toString("latin1"), "PK", "file is a zip (starts with PK)");
    const wb = XLSX.read(buf, { type: "buffer" });
    eq(wb.SheetNames, ["รายบรรทัด", "รพ.สต. × รายการ", "สรุปเงินต่อ รพ.สต."], "3 sheets with Thai names");
    const s1 = XLSX.utils.sheet_to_json(wb.Sheets["รายบรรทัด"], { header: 1 });
    eq(s1[0].slice(0, 12), ["เดือน", "รหัส รพ.สต.", "รพ.สต.", "หน้า", "รหัสรายการ", "รายการ", "หน่วย", "ราคา/หน่วย", "OP", "PP", "รวม", "เป็นเงิน"], "sheet 1 Thai header");
    eq(s1.length - 1, lineRows, `sheet 1: one row per requested line (${lineRows})`);
    const rowA = s1.find((r) => r[1] === "PCU01" && r[4] === A.code);
    ok(rowA && rowA[8] === 8 && rowA[9] === 1 && rowA[10] === 9 && near(rowA[11], 9 * A.price), "sheet 1: PCU01 line values (OP 8, PP 1, total 9, baht)");
    const s2 = XLSX.utils.sheet_to_json(wb.Sheets["รพ.สต. × รายการ"], { header: 1 });
    eq(s2[1].length, 3 + 15 + 1, "sheet 2: 15 PCU columns + total");
    const aRow = s2.find((r) => r[0] === A.code);
    ok(aRow && aRow[aRow.length - 1] >= 9, "sheet 2: requested qty total for item A");
    ok(s2.some((r) => r[0] && String(r[0]).startsWith("จำนวนที่จ่ายจริง")), "sheet 2: second block for issued qty");
    const s3 = XLSX.utils.sheet_to_json(wb.Sheets["สรุปเงินต่อ รพ.สต."], { header: 1 });
    ok(s3[1][2] === "แผน OP (บาท)" && s3[1][5] === "ขอ OP (บาท)" && s3[1][8] === "จ่ายจริง OP", "sheet 3 Thai headers (plan / requested / issued)");
    const tot = s3[s3.length - 1];
    ok(tot[1] === "รวม" && near(tot[7], submittedBaht, 0.05), `sheet 3: requested total = Σ submitted baht (${submittedBaht})`);
    ok(near(tot[4], boot.plan_totals.total, 0.05), "sheet 3: plan total = bootstrap plan total");
    eq(tot[10], 0, "sheet 3: issued total is 0 in 2a");
    const xf = await get(`/api/export.xlsx?fy=2570`, { authorization: "Bearer " + ADM2 });
    eq(xf.status, 200, "export by fiscal year → 200");
    ok(/ปีงบ2570/.test(decodeURIComponent((xf.headers.get("content-disposition") || "").split("''")[1] || "")), "fy filename เบิกวัสดุ_ปีงบ2570.xlsx");
    eq((await get(`/api/export.xlsx?month=${CUR}`)).status, 401, "export without a token → 401");
    eq((await get(`/api/export.xlsx?month=${CUR}&token=${encodeURIComponent(T1)}`)).status, 403, "export with a PCU token → 403");
    eq((await get(`/api/export.xlsx`, { authorization: "Bearer " + ADM2 })).status, 400, "export without month/fy → 400");
    eq((await get(`/api/export.xlsx?month=2026-99`, { authorization: "Bearer " + ADM2 })).status, 400, "export with a bad month → 400");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("backup password (admin fallback login)");
  expectErr(await api("adminLoginBackup", { password: "whatever12" }), "NOT_FOUND", "no backup password set yet");
  expectErr(await api("adminSetBackupPassword", { password: "short" }, ADM2), "BAD_REQUEST", "backup password ≥ 8 chars");
  ok((await api("adminSetBackupPassword", { password: "correct-horse-1" }, ADM2)).ok, "adminSetBackupPassword (Google admin)");
  const bl = await api("adminLoginBackup", { password: "correct-horse-1" });
  ok(bl.ok && bl.data.role === "admin", "adminLoginBackup ok → admin token");
  const BK = bl.data.token;
  ok((await api("adminBootstrap", {}, BK)).ok, "backup-password admin can use admin actions");
  expectErr(await api("adminSetBackupPassword", { password: "another-pass-2" }, BK), "FORBIDDEN", "backup-password session cannot change the backup password");
  ok((await api("adminUsersAdd", { email: "x.dispenser@example.com", role: "dispenser", units: ["พัสดุ"] }, BK)).ok, "backup admin may manage users");
  await api("adminUsersRemove", { email: "x.dispenser@example.com" }, BK);
  ok((await api("adminSetBackupPassword", { password: "correct-horse-2" }, ADM2)).ok, "backup password changed");
  expectErr(await api("adminBootstrap", {}, BK), "AUTH_EXPIRED", "changing the backup password invalidates backup sessions");
  const bw = await api("adminLoginBackup", { password: "wrong-password" });
  expectErr(bw, "BAD_PASSWORD", "wrong backup password"); eq(bw.error.remaining, 4, "BAD_PASSWORD remaining 4");
  let lk;
  for (let i = 0; i < 4; i++) lk = await api("adminLoginBackup", { password: "wrong-password" });
  ok(!lk.ok && lk.error.code === "LOCKED" && lk.error.until, "5th wrong backup password → LOCKED (15 min)");
  expectErr(await api("adminLoginBackup", { password: "correct-horse-2" }), "LOCKED", "correct password still locked");

  // ------------------------------------------------------------------------------------------------------------------------
  section("backup to R2 (cron endpoint + adminBackupNow)");
  {
    const post = (headers) => fetch(BASE + "/api/cron/backup", { method: "POST", headers });
    eq((await post({})).status, 403, "cron/backup without key → 403");
    eq((await post({ "x-backup-key": "wrong" })).status, 403, "cron/backup wrong key → 403");
    eq((await fetch(BASE + "/api/cron/backup", { headers: { "x-backup-key": BACKUP_KEY } })).status, 405, "cron/backup GET → 405");
    await mustOk("devPutBackup", { key: "backup/2020-01-01.json" });
    await mustOk("devPutBackup", { key: "backup/2099-01-01.json" });
    const res = await post({ "x-backup-key": BACKUP_KEY });
    const j = await res.json();
    ok(res.status === 200 && j.ok && /^backup\/\d{4}-\d{2}-\d{2}\.json$/.test(j.data.key) && j.data.size > 5000, "cron/backup with key → writes backup/YYYY-MM-DD.json");
    ok(j.data.deleted.includes("backup/2020-01-01.json") && !j.data.deleted.includes("backup/2099-01-01.json"), "backups older than 90 days are deleted, newer kept");
    const ls = await mustOk("devListBackups");
    ok(ls.keys.includes(j.data.key) && ls.keys.includes("backup/2099-01-01.json") && !ls.keys.includes("backup/2020-01-01.json"), "R2 listing: new backup present, old one gone");
    const nb = await mustOk("adminBackupNow", {}, ADM2);
    ok(nb.key === j.data.key && nb.size > 5000, "adminBackupNow returns key + size");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("audit log");
  {
    const a1 = await mustOk("adminAuditLog", { limit: 500 }, ADM2);
    ok(a1.entries.length > 20, "audit log has entries");
    ok(a1.entries[0].id > a1.entries[a1.entries.length - 1].id, "newest first");
    const acts = new Set(a1.entries.map((e) => e.action));
    for (const a of ["submit", "adminSetPin", "adminLockRound", "adminNote", "adminSetConfig", "import_seed", "adminUsersAdd", "adminLimitsUpload", "adminSetLimit"]) ok(acts.has(a), `audit has "${a}"`);
    ok(a1.entries.every((e) => e.ts && "actor" in e && "role" in e), "entries carry ts/actor/role");
    const page = await mustOk("adminAuditLog", { limit: 5 }, ADM2);
    eq(page.entries.length, 5, "limit respected");
    const older = await mustOk("adminAuditLog", { limit: 5, before: page.next_before }, ADM2);
    ok(older.entries.length === 5 && older.entries.every((e) => e.id < page.next_before), "before pagination returns older rows");
    const n0 = (await mustOk("adminAuditLog", { limit: 1 }, ADM2)).entries[0].id;
    await mustOk("adminNote", { pcu: "PCU10", month: CUR, note: "audit probe" }, ADM2);
    const n1b = (await mustOk("adminAuditLog", { limit: 1 }, ADM2)).entries[0];
    ok(n1b.id > n0 && n1b.action === "adminNote" && n1b.pcu === "PCU10", "audit log grows after a mutating action");
    const lg = (await mustOk("adminAuditLog", { limit: 500 }, ADM2)).entries.filter((e) => e.action === "adminLoginBackup");
    ok(lg.length >= 5, "failed logins are audited too");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("pdf (2b)");
  {
    // dev mock renderer (DEV_FAKE_GOOGLE=1, no CF_BR_TOKEN) + local R2 (--r2 FILES): the whole flow is real except Browser Rendering itself
    const P = "PCU11", Q = "PCU13";
    const pr = (await mustOk("pcuList")).pcus.find((x) => x.code === P);
    const TP = (await mustOk("pcuLogin", { pcu: P, pin: "12345" })).token;
    const TQ = (await mustOk("pcuLogin", { pcu: Q, pin: "12345" })).token;
    const T3b = (await mustOk("pcuLogin", { pcu: "PCU03", pin: "12345" })).token; // another PCU
    const DSPE = "pdf.dispenser@example.com"; // the earlier dispenser was removed by the users section; a temporary one (removed again below)
    await mustOk("adminUsersAdd", { email: DSPE, role: "dispenser", units: ["LAB"] }, ADM2);
    const DSP2 = (await mustOk("adminLoginGoogle", { id_token: "dev:" + DSPE })).token;
    const tt = (s) => `2026-11-12T10:00:${String(s).padStart(2, "0")}.000Z`;
    const idP = `${P}_${CUR}`;
    const files = async (prefix) => (await mustOk("devListFiles", { prefix })).keys;
    const expectedName = `ใบเบิก_${pr.print_name}_พฤศจิกายน 2569.pdf`;
    const reqWith = (headers, body) => fetch(BASE + "/api", { method: "POST", headers: { "content-type": "text/plain;charset=utf-8", "x-dev-month": devMonth, ...headers }, body: JSON.stringify(body) }).then((r) => r.json());

    // --- guards (before anything is sent)
    expectErr(await api("requestPdf", { month: CUR }), "AUTH_REQUIRED", "requestPdf without a token");
    expectErr(await api("requestPdf", { month: CUR }, ADM2), "FORBIDDEN", "requestPdf with an admin token");
    expectErr(await api("adminRequestPdf", { pcu: P, month: CUR }, TP), "FORBIDDEN", "adminRequestPdf with a PCU token");
    expectErr(await api("requestPdf", {}, TP), "BAD_REQUEST", "requestPdf without a month");
    expectErr(await api("requestPdf", { month: CUR }, TP), "NOT_FOUND", "requestPdf with no request at all");
    await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 4, pp: 1, updated_at: tt(1) }, [B.code]: { op: 2, updated_at: tt(1) } } }, TP);
    const nf = await api("requestPdf", { month: CUR }, TP);
    expectErr(nf, "NOT_FOUND", "requestPdf on a draft");
    ok(/ต้องส่งใบเบิกก่อน/.test(nf.error.message), "draft message asks the user to send the request first (Thai)");
    expectErr(await api("adminRequestPdf", { pcu: P, month: CUR }, ADM2), "NOT_FOUND", "adminRequestPdf on a draft");
    expectErr(await api("adminRequestPdf", { month: CUR }, ADM2), "BAD_REQUEST", "adminRequestPdf without pcu");
    expectErr(await api("adminRequestPdf", { pcu: "PCU99", month: CUR }, ADM2), "NOT_FOUND", "adminRequestPdf unknown PCU");

    // --- submit → ready
    await mustOk("saveLines", { month: CUR, lines: {}, send: true }, TP);
    const p1 = await mustOk("requestPdf", { month: CUR }, TP);
    eq(p1.status, "ready", "requestPdf after submit → ready");
    ok(/^[0-9a-f]{64}$/.test(p1.content_key) && p1.url === `/api/pdf/${idP}?k=${p1.content_key}`, "ready.url = /api/pdf/<request_id>?k=<content_key>");
    eq(p1.filename, expectedName, "filename = ใบเบิก_<print_name>_<เดือนไทย ปีพ.ศ.>.pdf");
    eq((await files(`pdf/${P}/`)), [`pdf/${P}/${CUR}/${p1.content_key}.pdf`], "R2 object stored at pdf/<pcu>/<month>/<content_key>.pdf");

    // --- download access
    const noTok = await get(p1.url);
    const noTokJ = await noTok.json();
    ok([401, 403].includes(noTok.status) && noTokJ.ok === false && noTokJ.error.code === "AUTH_REQUIRED", "GET pdf without a token → 401 JSON");
    const other = await get(p1.url + "&token=" + encodeURIComponent(T3b));
    ok(other.status === 403 && (await other.json()).error.code === "FORBIDDEN", "GET pdf with another PCU's token → 403");
    eq((await get(p1.url + "&token=garbage")).status, 401, "GET pdf with a garbage token → 401");
    const own = await get(p1.url + "&token=" + encodeURIComponent(TP));
    eq(own.status, 200, "GET pdf with own token → 200");
    eq(own.headers.get("content-type"), "application/pdf", "content-type: application/pdf");
    const body = Buffer.from(await own.arrayBuffer());
    ok(body.subarray(0, 4).toString() === "%PDF" && body.length < 2048 && body.toString("latin1").includes(`MOCK PDF ${idP} `), "body is a valid small PDF (starts %PDF, mock text with request id)");
    const cd = own.headers.get("content-disposition") || "";
    ok(/^attachment;/.test(cd) && cd.includes("filename*=UTF-8''" + encodeURIComponent(expectedName)), "content-disposition: attachment with the UTF-8 filename");
    ok(/max-age=0/.test(own.headers.get("cache-control") || "") && /private/.test(own.headers.get("cache-control") || ""), "cache-control: private, max-age=0");
    eq((await get(p1.url, { authorization: "Bearer " + ADM2 })).status, 200, "admin may download any PDF (Authorization: Bearer)");
    eq((await get(p1.url, { authorization: "Bearer " + DSP2 })).status, 200, "dispenser may download any PDF");
    eq((await get(`/api/pdf/${idP}?k=${"0".repeat(64)}`, { authorization: "Bearer " + ADM2 })).status, 404, "unknown content key → 404");
    eq((await get(`/api/pdf/${idP}?k=zz`, { authorization: "Bearer " + ADM2 })).status, 400, "malformed content key → 400");
    eq((await get(`/api/pdf/NOPE_2026-11?k=${p1.content_key}`, { authorization: "Bearer " + ADM2 })).status, 404, "unknown request id → 404");

    // --- cache: same content → same key, no second row / object
    const p2 = await mustOk("requestPdf", { month: CUR }, TP);
    eq(p2.content_key, p1.content_key, "second requestPdf → same content_key (cache hit)");
    eq((await files(`pdf/${P}/`)).length, 1, "still exactly one R2 object after the second request");
    const pa = await mustOk("adminRequestPdf", { pcu: P, month: CUR }, ADM2);
    eq([pa.status, pa.content_key, pa.filename], ["ready", p1.content_key, expectedName], "adminRequestPdf (admin) → same key + filename");
    eq((await mustOk("adminRequestPdf", { pcu: P, month: CUR }, DSP2)).content_key, p1.content_key, "adminRequestPdf works for a dispenser");

    // --- changed content → new key
    await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 6, pp: 1, updated_at: tt(5) } } }, TP);
    await mustOk("saveLines", { month: CUR, lines: {}, send: true }, TP);
    const p3 = await mustOk("requestPdf", { month: CUR }, TP);
    ok(p3.status === "ready" && p3.content_key !== p1.content_key, "changed line + resubmit → different content_key");
    eq((await files(`pdf/${P}/`)).length, 2, "two R2 objects after the change");
    eq((await get(p1.url, { authorization: "Bearer " + ADM2 })).status, 200, "the older version stays downloadable by its key");

    // --- hidden items are part of the sheet → part of the key
    await mustOk("adminSetHidden", { pcu: P, codes: [CSI.code] }, ADM2);
    const p4 = await mustOk("requestPdf", { month: CUR }, TP);
    ok(p4.content_key !== p3.content_key && p4.content_key !== p1.content_key, "hiding an item changes the content_key");
    await mustOk("adminSetHidden", { pcu: P, codes: [] }, ADM2);
    eq((await mustOk("requestPdf", { month: CUR }, TP)).content_key, p3.content_key, "un-hiding returns to the cached key");
    eq((await files(`pdf/${P}/`)).length, 3, "three objects (v1, v2, hidden variant)");

    // --- printData (public, print token)
    const dt = await mustOk("devPrintToken", { pcu: P, month: CUR });
    eq(dt.content_key, p3.content_key, "devPrintToken carries the current content key");
    const pd = await mustOk("printData", { k: dt.token });
    const adm = await mustOk("adminGetRequest", { pcu: P, month: CUR }, ADM2);
    eq([pd.pcu.code, pd.pcu.print_name, pd.month], [P, pr.print_name, CUR], "printData: pcu + month");
    eq(pd.form.id, adm.form_version_id, "printData.form = the version bound to the request");
    eq(pd.form.steps.length, seed.form.steps.length, "printData.form carries every step");
    eq([pd.request.id, pd.request.status, pd.request.lines[A.code].op, pd.request.lines[A.code].pp, pd.request.lines[B.code].op], [idP, "submitted", 6, 1, 2], "printData.request lines");
    ok(pd.request.submitted_at && !("price_snapshot" in pd.request.lines[A.code]), "printData.request has submitted_at and no price/issued fields");
    eq(pd.hidden, [], "printData.hidden");
    await mustOk("adminSetHidden", { pcu: P, codes: [CSI.code] }, ADM2);
    const dt2 = await mustOk("devPrintToken", { pcu: P, month: CUR });
    eq((await mustOk("printData", { k: dt2.token })).hidden, [CSI.code], "printData.hidden lists the PCU's hidden items");
    await mustOk("adminSetHidden", { pcu: P, codes: [] }, ADM2);
    expectErr(await api("printData", { k: dt.token.slice(0, -3) + "AAA" }), "AUTH_EXPIRED", "printData with a tampered token");
    expectErr(await api("printData", {}), "AUTH_EXPIRED", "printData without k");
    expectErr(await api("printData", { k: TP }), "FORBIDDEN", "printData rejects a PCU session token (wrong token type)");
    if (TOKEN_SECRET) {
      const mk = (o) => forgeToken({ t: "print", pcu: P, month: CUR, ck: p3.content_key, exp: Date.now() + 60000, ...o });
      expectErr(await api("printData", { k: mk({ exp: Date.now() - 1000 }) }), "AUTH_EXPIRED", "printData with an expired print token");
      ok((await api("printData", { k: mk({}) })).ok, "printData accepts a correctly signed print token (documented HMAC format)");
      expectErr(await api("printData", { k: mk({ ck: "0".repeat(64) }) }), "CONFLICT", "printData with a stale content key → CONFLICT");
      expectErr(await api("printData", { k: mk({ pcu: "PCU12" }) }), "NOT_FOUND", "printData for a PCU without a sent request → NOT_FOUND");
    } else { for (let i = 0; i < 4; i++) ok(true, "(skipped print-token forgery test: no TOKEN_SECRET readable)"); }
    await mustOk("saveLines", { month: CUR, lines: { [B.code]: { op: 3, updated_at: tt(9) } } }, TP); // edit after the token was minted
    expectErr(await api("printData", { k: dt.token }), "CONFLICT", "request edited after the token was minted → CONFLICT");
    expectErr(await api("devPrintToken", { pcu: "PCU12", month: CUR }), "NOT_FOUND", "devPrintToken without a sent request");

    // --- dev switches for the pending / failed branches (mock mode only)
    const pend = await reqWith({ "x-dev-pdf": "pending" }, { action: "requestPdf", token: TQ, month: CUR });
    expectErr(pend, "NOT_FOUND", "(PCU13 has not sent yet) → NOT_FOUND before any renderer branch");
    await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 1, updated_at: tt(2) } }, send: true }, TQ);
    const pend2 = await reqWith({ "x-dev-pdf": "pending" }, { action: "requestPdf", token: TQ, month: CUR });
    ok(pend2.ok && pend2.data.status === "pending" && pend2.data.retry_after > 0, "renderer 429 → {status:pending, retry_after}");
    eq((await files(`pdf/${Q}/`)).length, 0, "pending stores nothing");
    const fl = await reqWith({ "x-dev-pdf": "fail" }, { action: "requestPdf", token: TQ, month: CUR });
    ok(!fl.ok && fl.error.code === "PDF_FAILED" && /Save as PDF/.test(fl.error.message) && fl.error.detail, "renderer error → PDF_FAILED{detail} + print/Save-as-PDF hint");
    eq((await files(`pdf/${Q}/`)).length, 0, "failed render stores nothing");

    // --- audit
    const au = (await mustOk("adminAuditLog", { limit: 500 }, ADM2)).entries.filter((e) => e.action === "pdf_create");
    ok(au.some((e) => e.actor === P && e.role === "pcu" && e.pcu === P && e.month === CUR), "audit: pdf_create by the PCU");
    ok(au.length === 3, `audit: one pdf_create per stored file (${au.length})`);

    // --- admin renders for a PCU that never asked; PCU then hits the cache
    const qa = await mustOk("adminRequestPdf", { pcu: Q, month: CUR }, DSP2);
    eq(qa.status, "ready", "dispenser can create a PDF for a sent request");
    eq((await mustOk("requestPdf", { month: CUR }, TQ)).content_key, qa.content_key, "PCU gets the PDF the dispenser created (cache)");
    ok((await mustOk("adminAuditLog", { limit: 500 }, ADM2)).entries.some((e) => e.action === "pdf_create" && e.actor === DSPE && e.role === "dispenser"), "audit: pdf_create by the dispenser (staff e-mail)");
    eq((await files("pdf/")).length, 4, "R2 holds 4 PDFs before the trial wipe");
    ok((await api("adminUsersRemove", { email: DSPE }, ADM2)).ok, "temporary dispenser removed again");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("clear trial data");
  {
    expectErr(await api("adminClearTrial", { confirm: "yes" }, ADM2), "BAD_REQUEST", "clear trial needs the confirmation word");
    const hiddenBefore = (await mustOk("adminBootstrap", {}, ADM2)).hidden;
    const limitsBefore = Object.keys((await mustOk("adminBootstrap", {}, ADM2)).limits).length;
    const c = await mustOk("adminClearTrial", { confirm: "ล้างข้อมูล" }, ADM2);
    ok(c.deleted_requests >= 7 && c.deleted_lines >= 7, `adminClearTrial deletes requests + lines (${c.deleted_requests}/${c.deleted_lines})`);
    ok("deleted_issue_status" in c && "deleted_pdf_files" in c, "adminClearTrial reports issue_status / pdf_files");
    ok(c.deleted_pdf_files >= 4, `adminClearTrial deletes the pdf_files rows (${c.deleted_pdf_files})`);
    eq((await mustOk("devListFiles", { prefix: "pdf/" })).keys, [], "adminClearTrial removed the PDF objects from R2");
    ok((await mustOk("devListFiles", { prefix: "backup/" })).keys.length > 0, "…but left the backups alone");
    eq((await mustOk("adminRequests", { month: CUR }, ADM2)).requests, [], "no requests left");
    const ab = await mustOk("adminBootstrap", {}, ADM2);
    eq(ab.months, [], "adminBootstrap.months empty");
    eq(ab.hidden, hiddenBefore, "hidden items survive");
    eq(Object.keys(ab.limits).length, limitsBefore, "limits survive");
    ok(ab.users.length === 2 && ab.form_versions.length === 1 && Object.keys(ab.plans).length > 0, "users, form versions and plans survive");
    ok(ab.rounds.some((x) => x.month === CUR && x.note), "rounds survive");
    const again = await mustOk("pcuBootstrap", {}, T1);
    eq(again.byMonth[CUR].request, null, "PCU sees an empty month after the trial wipe");
  }


  // ------------------------------------------------------------------------------------------------------------------------
  section("issue (2c)");
  {
    // ---- fixture: two dispensers (LAB · พัสดุ+จ่ายกลาง), four PCUs, items of 3 dispense units ----
    const D_LAB = "issue.lab@example.com", D_STORE = "issue.store@example.com";
    await mustOk("adminSetLimitMode", { mode: "off" }, ADM2);
    await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM2);
    await mustOk("adminLockRound", { month: CUR, locked: 0 }, ADM2);
    await mustOk("adminUsersAdd", { email: D_LAB, role: "dispenser", units: ["LAB"] }, ADM2);
    await mustOk("adminUsersAdd", { email: D_STORE, role: "dispenser", units: ["พัสดุ", "จ่ายกลาง"] }, ADM2);
    const DL = (await mustOk("adminLoginGoogle", { id_token: "dev:" + D_LAB })).token;
    const DS = (await mustOk("adminLoginGoogle", { id_token: "dev:" + D_STORE })).token;
    const login = async (code) => (await mustOk("pcuLogin", { pcu: code, pin: "12345" })).token;
    const [P3, P4, P5] = [await login("PCU03"), await login("PCU04"), await login("PCU05")];
    let n = 0;
    const tsn = () => new Date(Date.parse("2026-11-20T00:00:00Z") + ++n * 1000).toISOString();
    const A2 = seedItems.find((i) => i.step === "P1" && i.code !== A.code);
    const L = (o) => Object.fromEntries(Object.entries(o).map(([c, [op, pp]]) => [c, { stock: 1, op, pp, updated_at: tsn() }]));
    const save = (tok, lines, send) => api("saveLines", { month: CUR, lines: L(lines), send: !!send }, tok);
    const lineOf = (res, code) => res.request.lines[code];
    const issueOf = (res) => res.issue;
    ok(A.unit_of === "พัสดุ" && B.unit_of === "พัสดุ" && CSI.unit_of === "จ่ายกลาง" && LABI.unit_of === "LAB", "fixture items map to พัสดุ / พัสดุ / จ่ายกลาง / LAB");

    // ---- auth + draft ----
    expectErr(await api("issueLines", { pcu: "PCU03", month: CUR, lines: {} }), "AUTH_REQUIRED", "issueLines without a token");
    expectErr(await api("issueLines", { pcu: "PCU03", month: CUR, lines: {} }, P3), "FORBIDDEN", "issueLines with a PCU token");
    await mustOk("saveLines", { month: CUR, lines: L({ [A.code]: [10, 5], [B.code]: [4, 0], [CSI.code]: [2, 0], [LABI.code]: [3, 2] }) }, P3); // draft
    expectErr(await api("issueLines", { pcu: "PCU03", month: CUR, lines: { [A.code]: { issued_total: 1 } } }, ADM2), "NOT_FOUND", "issueLines on a draft → NOT_FOUND");
    expectErr(await api("issueDone", { pcu: "PCU03", month: CUR, unit: "LAB", done: 1 }, DL), "NOT_FOUND", "issueDone on a draft → NOT_FOUND");
    expectErr(await api("issueAll", { pcu: "PCU12", month: CUR }, ADM2), "NOT_FOUND", "issueAll without any request → NOT_FOUND");
    ok((await save(P3, {}, true)).ok, "PCU03 submits (A 10/5 · B 4/0 · CS 2/0 · LAB 3/2)");
    const sub3 = (await mustOk("adminGetRequest", { pcu: "PCU03", month: CUR }, ADM2)).request;
    ok((await save(P4, { [A.code]: [2, 0], [LABI.code]: [6, 0] }, true)).ok, "PCU04 submits (A 2/0 · LAB 6/0)");
    ok((await save(P5, { [A.code]: [1, 0] }, true)).ok, "PCU05 submits (A 1/0)");

    // ---- validation ----
    const il = (lines, tok = ADM2, pcu = "PCU03", extra = {}) => api("issueLines", { pcu, month: CUR, lines, ...extra }, tok);
    const over = await il({ [A.code]: { issued_total: 16 } });
    expectErr(over, "BAD_REQUEST", "over-request is rejected");
    ok(/จ่ายเกินขอไม่ได้ \(ขอ 15\)/.test(over.error.message), "over-request message names the requested qty (ขอ 15)");
    expectErr(await il({ [A.code]: { issued_total: 12 } }), "BAD_REQUEST", "short without a reason → BAD_REQUEST");
    expectErr(await il({ [A.code]: { issued_total: 12, reason: "x" } }), "BAD_REQUEST", "unknown reason → BAD_REQUEST");
    expectErr(await il({ [A.code]: { issued_total: 12, reason: "other" } }), "BAD_REQUEST", "reason other without a note → BAD_REQUEST");
    expectErr(await il({ [A.code]: { issued_total: 12, reason: "other", note: "   " } }), "BAD_REQUEST", "reason other with a blank note → BAD_REQUEST");
    expectErr(await il({ [A.code]: { issued_total: 12, reason: "other", note: "x".repeat(201) } }), "BAD_REQUEST", "note longer than 200 → BAD_REQUEST");
    expectErr(await il({ [A.code]: { issued_total: 1.5, reason: "out_of_stock" } }), "BAD_REQUEST", "fractional issued_total → BAD_REQUEST");
    expectErr(await il({ [A.code]: { issued_total: -1, reason: "out_of_stock" } }), "BAD_REQUEST", "negative issued_total → BAD_REQUEST");
    expectErr(await il({ [A.code]: { reason: "out_of_stock" } }), "BAD_REQUEST", "missing issued_total → BAD_REQUEST");
    expectErr(await il({ [A2.code]: { issued_total: 0, reason: "out_of_stock" } }), "BAD_REQUEST", "a line that was not requested cannot be issued");
    expectErr(await il({ "ZZ-99": { issued_total: 0, reason: "out_of_stock" } }), "BAD_REQUEST", "unknown item code → BAD_REQUEST");
    expectErr(await il({}), "BAD_REQUEST", "empty lines → BAD_REQUEST");
    expectErr(await api("issueLines", { pcu: "PCU03", month: "2026-13", lines: { [A.code]: { issued_total: 1 } } }, ADM2), "BAD_REQUEST", "bad month → BAD_REQUEST");
    expectErr(await il({ [A.code]: { issued_total: 12, reason: "out_of_stock" }, [B.code]: { issued_total: 99 } }), "BAD_REQUEST", "one bad line rejects the whole call");
    eq((await mustOk("adminGetRequest", { pcu: "PCU03", month: CUR }, ADM2)).request.lines[A.code].issued_total, null, "…and nothing was written (atomic)");

    // ---- permissions: dispenser LAB vs P1 item, admin ----
    expectErr(await il({ [A.code]: { issued_total: 15 } }, DL), "FORBIDDEN", "dispenser LAB cannot issue a P1 (พัสดุ) item");
    expectErr(await il({ [LABI.code]: { issued_total: 4, reason: "out_of_stock" }, [A.code]: { issued_total: 15 } }, DL), "FORBIDDEN", "mixed call with a foreign-unit line is rejected as a whole");
    eq((await mustOk("adminGetRequest", { pcu: "PCU03", month: CUR }, ADM2)).request.lines[LABI.code].issued_total, null, "…and the LAB line was not touched");
    const r1 = await mustOk("issueLines", { pcu: "PCU03", month: CUR, lines: { [LABI.code]: { issued_total: 4, reason: "out_of_stock" } } }, DL);
    eq([lineOf(r1, LABI.code).issued_total, lineOf(r1, LABI.code).issued_op, lineOf(r1, LABI.code).issued_pp], [4, 2, 2], "dispenser LAB issues a LAB item (LAB 3/2 → 4: OP short first → 2/2)");
    ok(lineOf(r1, LABI.code).issued_by === D_LAB && lineOf(r1, LABI.code).issued_at, "issued_by = dispenser e-mail, issued_at set");
    ok(Object.keys(r1.request.lines).every((c) => seedItems.find((i) => i.code === c).unit_of === "LAB"), "dispenser response carries only own-unit lines");
    ok(r1.issue && r1.issue.units_total === 3 && r1.issue.units_done === 0 && r1.issue.units.LAB.issued_lines === 1, "response.issue: 3 needed units, none done, LAB issued_lines 1");

    // ---- the OP-first split + reason rules (admin) ----
    let r = await mustOk("issueLines", { pcu: "PCU03", month: CUR, lines: { [A.code]: { issued_total: 12, reason: "out_of_stock" } } }, ADM2);
    let la = lineOf(r, A.code);
    eq([la.issued_total, la.issued_op, la.issued_pp, la.issue_reason, la.issue_note, la.issued_by], [12, 7, 5, "out_of_stock", null, ADMIN_EMAIL], "OP 10 / PP 5, issued 12 → 7/5 (reason out_of_stock, admin as issued_by)");
    r = await mustOk("issueLines", { pcu: "PCU03", month: CUR, lines: { [A.code]: { issued_total: 3, reason: "other", note: " รอของเข้า " } } }, ADM2);
    la = lineOf(r, A.code);
    eq([la.issued_op, la.issued_pp, la.issue_reason, la.issue_note], [0, 3, "other", "รอของเข้า"], "issued 3 → shortfall hits OP first (0/3); note trimmed, reason other");
    r = await mustOk("issueLines", { pcu: "PCU03", month: CUR, lines: { [A.code]: { issued_total: 15, reason: "out_of_stock", note: "ignored" } } }, ADM2);
    la = lineOf(r, A.code);
    eq([la.issued_total, la.issued_op, la.issued_pp, la.issue_reason, la.issue_note], [15, 10, 5, null, null], "issued = requested → 10/5, reason + note cleared");
    r = await mustOk("issueLines", { pcu: "PCU03", month: CUR, lines: { [A.code]: { issued_total: 0, reason: "out_of_stock", note: "หมดทั้งเครือข่าย" } } }, ADM2);
    la = lineOf(r, A.code);
    eq([la.issued_total, la.issued_op, la.issued_pp, la.issue_note], [0, 0, 0, "หมดทั้งเครือข่าย"], "issued 0 → 0/0 (out_of_stock may carry a note)");
    r = await mustOk("issueLines", { pcu: "PCU03", month: CUR, lines: { [A.code]: { issued_total: null, reason: "other", note: "x" } } }, ADM2);
    la = lineOf(r, A.code);
    eq([la.issued_total, la.issued_op, la.issued_pp, la.issue_reason, la.issue_note, la.issued_at, la.issued_by], [null, null, null, null, null, null, null], "issued_total null clears every issued field");
    eq([r.issue.complete, r.issue.incomplete], [0, 1], "IssueInfo counts: LAB 4/5 → incomplete 1, complete 0");

    // ---- issueAll ----
    expectErr(await api("issueAll", { pcu: "PCU03", month: CUR, unit: "โกดัง" }, ADM2), "BAD_REQUEST", "issueAll with an unknown unit → BAD_REQUEST");
    expectErr(await api("issueAll", { pcu: "PCU03", month: CUR, unit: "พัสดุ" }, DL), "FORBIDDEN", "dispenser LAB cannot issueAll the พัสดุ unit");
    r = await mustOk("issueAll", { pcu: "PCU03", month: CUR, unit: "พัสดุ" }, ADM2);
    eq([lineOf(r, A.code).issued_total, lineOf(r, A.code).issued_op, lineOf(r, A.code).issued_pp, lineOf(r, B.code).issued_total], [15, 10, 5, 4], "admin issueAll(unit พัสดุ): requested lines = requested qty");
    eq([lineOf(r, CSI.code).issued_total, lineOf(r, LABI.code).issued_total], [null, 4], "…other units untouched (CS still empty, LAB keeps 4)");
    r = await mustOk("issueAll", { pcu: "PCU03", month: CUR }, DL);
    eq([lineOf(r, LABI.code).issued_total, lineOf(r, LABI.code).issue_reason, lineOf(r, LABI.code).issued_op, lineOf(r, LABI.code).issued_pp], [5, null, 3, 2], "dispenser LAB issueAll without unit = its own units → LAB 5 (3/2), reason cleared");
    eq(lineOf(r, CSI.code), undefined, "…and the response still hides foreign-unit lines from the dispenser");
    r = await mustOk("issueLines", { pcu: "PCU03", month: CUR, lines: { [A.code]: { issued_total: 12, reason: "out_of_stock" } } }, DS);
    eq([lineOf(r, A.code).issued_total, lineOf(r, A.code).issued_op, lineOf(r, A.code).issued_pp], [12, 7, 5], "dispenser พัสดุ sets A back to 12 (7/5) — final state used below");

    // ---- issueDone: LAB first ----
    expectErr(await api("issueDone", { pcu: "PCU03", month: CUR, unit: "LAB", done: 1 }, DS), "FORBIDDEN", "dispenser พัสดุ cannot mark LAB done");
    expectErr(await api("issueDone", { pcu: "PCU03", month: CUR, unit: "LAB", done: 2 }, DL), "BAD_REQUEST", "issueDone: done must be 0|1");
    expectErr(await api("issueDone", { pcu: "PCU03", month: CUR, unit: "ห้องเก็บ", done: 1 }, ADM2), "BAD_REQUEST", "issueDone: unknown unit");
    expectErr(await api("issueDone", { pcu: "PCU05", month: CUR, unit: "LAB", done: 1 }, ADM2), "BAD_REQUEST", "issueDone for a unit with no requested lines → BAD_REQUEST");
    r = await mustOk("issueDone", { pcu: "PCU03", month: CUR, unit: "LAB", done: 1 }, DL);
    const U = r.issue.units;
    ok(U.LAB.done && U.LAB.done_at && U.LAB.done_by === D_LAB && U.LAB.needed && U.LAB.lines === 1, "issue.units.LAB done (done_at, done_by = dispenser)");
    eq([r.issue.units_total, r.issue.units_done, r.issue.done, r.request.status], [3, 1, false, "submitted"], "status stays submitted while พัสดุ / จ่ายกลาง are pending");
    eq(Object.keys(U).sort(), ["LAB", "จ่ายกลาง", "พัสดุ"].sort(), "issue.units has one entry per unit");
    ok(["needed", "done", "done_at", "done_by", "lines", "issued_lines"].every((k) => k in U["พัสดุ"]), "issue.units[unit] shape {needed,done,done_at,done_by,lines,issued_lines}");
    eq([U["พัสดุ"].lines, U["พัสดุ"].issued_lines, U["จ่ายกลาง"].lines, U["จ่ายกลาง"].issued_lines], [2, 2, 1, 0], "units: พัสดุ 2 lines / 2 issued · จ่ายกลาง 1 line / 0 issued");

    // PCU side: lines of the done unit are locked, other pages still editable (CONFLICT rule of 2a)
    const labLine = (stock) => ({ [LABI.code]: { stock, op: 3, pp: 2, updated_at: tsn() } });
    expectErr(await api("saveLines", { month: CUR, lines: labLine(9) }, P3), "CONFLICT", "PCU cannot change a LAB line after LAB is issued → CONFLICT");
    ok((await api("saveLines", { month: CUR, lines: labLine(1) }, P3)).ok, "…re-saving the same LAB values is fine");
    const aPcu = (await api("saveLines", { month: CUR, lines: { [A.code]: { stock: 7, op: 10, pp: 5, updated_at: tsn() } } }, P3));
    ok(aPcu.ok && aPcu.data.status === "submitted", "PCU can still change a P1 line (its unit is not done)");
    let pb2 = await mustOk("pcuBootstrap", {}, P3);
    let m3 = pb2.byMonth[CUR];
    eq(Object.keys(m3.request.issued), [LABI.code], "PCU request.issued has only the done unit's lines");
    eq(m3.request.issued[LABI.code], { total: 5, op: 3, pp: 2, reason: null, note: null }, "PCU request.issued[code] = {total,op,pp,reason,note}");
    eq(Object.keys(m3.request.lines[LABI.code]).sort(), ["op", "pp", "stock", "updated_at"], "PCU request.lines unchanged (no issued fields, Q78)");
    ok(m3.issue && m3.issue.units.LAB.done && m3.issue.units["พัสดุ"].done === false && m3.issue.units.LAB.done_by === null, "PCU IssueInfo.units present; done_by hidden from PCU");
    eq([m3.issue.complete, m3.issue.incomplete, m3.issue.units["พัสดุ"].issued_lines], [1, 0, 0], "PCU IssueInfo counts only done units (พัสดุ figures not leaked)");
    eq(pb2.issue_notices, [], "no notice yet (status not issued)");
    eq((await mustOk("pcuGetMonth", { month: CUR }, P3)).request.issued, m3.request.issued, "pcuGetMonth carries request.issued too");
    eq((await mustOk("pcuBootstrap", {}, P4)).byMonth[CUR].request.issued, undefined, "a request with no issue_status rows has no request.issued");

    // ---- the remaining units → issued ----
    r = await mustOk("issueDone", { pcu: "PCU03", month: CUR, unit: "พัสดุ", done: 1 }, DS);
    eq([lineOf(r, A.code).issued_total, lineOf(r, B.code).issued_total, r.request.status], [12, 4, "submitted"], "พัสดุ done keeps existing figures (A 12), still submitted");
    r = await mustOk("issueDone", { pcu: "PCU03", month: CUR, unit: "จ่ายกลาง", done: 1 }, DS);
    eq(lineOf(r, CSI.code).issued_total, 2, "marking done fills still-empty requested lines with the requested qty (CS 2)");
    eq([r.request.status, r.issue.done, r.issue.units_done, r.request.issued_seen_at], ["issued", true, 3, null], "all needed units done → status issued, issued_seen_at null");
    eq([r.issue.complete, r.issue.incomplete], [3, 1], "IssueInfo: 3 complete (B, CS, LAB) · 1 incomplete (A)");
    ok(r.request.submitted_at === sub3.submitted_at, "submitted_at untouched by issuing");
    pb2 = await mustOk("pcuBootstrap", {}, P3);
    m3 = pb2.byMonth[CUR];
    eq(pb2.issue_notices, [{ month: CUR, complete: 3, incomplete: 1 }], "issue_notices lists the month (3 complete / 1 incomplete)");
    eq(m3.request.status, "issued", "PCU sees status issued");
    eq(Object.keys(m3.request.issued).sort(), [A.code, B.code, CSI.code, LABI.code].sort(), "request.issued now has all four lines");
    eq(m3.request.issued[A.code], { total: 12, op: 7, pp: 5, reason: "out_of_stock", note: null }, "request.issued[A] shows the short line with its reason");
    ok((await mustOk("pcuAck", { month: CUR }, P3)).issued_seen_at, "pcuAck");
    pb2 = await mustOk("pcuBootstrap", {}, P3);
    eq([pb2.issue_notices, pb2.byMonth[CUR].request.status, !!pb2.byMonth[CUR].issue.issued_seen_at], [[], "issued", true], "pcuAck clears the notice; status stays issued");

    // ---- undo / redo ----
    expectErr(await api("issueDone", { pcu: "PCU03", month: CUR, unit: "พัสดุ", done: 0 }, DL), "FORBIDDEN", "undo follows the unit rule (LAB dispenser cannot undo พัสดุ)");
    r = await mustOk("issueDone", { pcu: "PCU03", month: CUR, unit: "LAB", done: 0 }, DL);
    eq([r.request.status, r.issue.units.LAB.done, r.issue.units_done, r.issue.done], ["submitted", false, 2, false], "issueDone LAB=0 → status back to submitted");
    ok(r.request.submitted_at === sub3.submitted_at && r.request.first_submitted_at === sub3.first_submitted_at, "undo keeps submitted_at / first_submitted_at");
    eq(lineOf(r, LABI.code).issued_total, 5, "undo keeps the issued figures (only the done flag goes)");
    pb2 = await mustOk("pcuBootstrap", {}, P3);
    eq([pb2.byMonth[CUR].request.status, Object.keys(pb2.byMonth[CUR].request.issued).includes(LABI.code), pb2.issue_notices], ["submitted", false, []], "PCU: status submitted, LAB figures hidden again, no notice");
    ok((await api("saveLines", { month: CUR, lines: labLine(3) }, P3)).ok, "PCU may change the LAB page again after the undo");
    r = await mustOk("issueDone", { pcu: "PCU03", month: CUR, unit: "LAB", done: 1 }, ADM2);
    eq([r.request.status, r.request.issued_seen_at], ["issued", null], "re-marking LAB done → issued again, notice re-armed (issued_seen_at null)");
    eq((await mustOk("pcuBootstrap", {}, P3)).issue_notices.length, 1, "notice shown again");
    r = await mustOk("issueDone", { pcu: "PCU03", month: CUR, unit: "LAB", done: 1 }, ADM2);
    eq([r.request.status, r.issue.units_done], ["issued", 3], "issueDone is idempotent");
    r = await mustOk("issueDone", { pcu: "PCU05", month: CUR, unit: "พัสดุ", done: 1 }, ADM2);
    eq([r.request.status, r.issue.units_total, lineOf(r, A.code).issued_total], ["issued", 1, 1], "a request needing one unit is issued as soon as it is done (PCU05)");

    // ---- dispenser time window ----
    const lab5 = { [LABI.code]: { issued_total: 5 } };
    const win = (action, params, tok, month) => api(action, { pcu: "PCU03", month: CUR, ...params }, tok, { month });
    expectErr(await win("issueLines", { lines: lab5 }, DL, "2027-01"), "FORBIDDEN", "dispenser two months after the request month → FORBIDDEN");
    const wm = await win("issueLines", { lines: lab5 }, DL, "2027-01");
    ok(/หมดเวลา/.test(wm.error.message), "window error message says the time is over (หมดเวลา…)");
    expectErr(await win("issueDone", { unit: "LAB", done: 0 }, DL, "2027-01"), "FORBIDDEN", "undo outside the window → FORBIDDEN");
    expectErr(await win("issueAll", { unit: "LAB" }, DL, "2027-01"), "FORBIDDEN", "issueAll outside the window → FORBIDDEN");
    expectErr(await api("issueItem", { month: CUR, item_code: LABI.code, entries: { PCU03: { issued_total: 5 } } }, DL, { month: "2027-01" }), "FORBIDDEN", "issueItem outside the window → FORBIDDEN");
    ok((await win("issueLines", { lines: lab5 }, ADM2, "2027-01")).ok, "admin is not limited by the window");
    ok((await win("issueLines", { lines: lab5 }, DL, "2026-12")).ok, "dispenser still allowed in the month after the request month");
    ok((await api("adminItemIssue", { month: CUR, item_code: LABI.code }, DL, { month: "2027-01" })).ok, "reading (adminItemIssue) is never time-limited");

    // ---- issueItem across PCUs + adminItemIssue ----
    const ie = (entries, tok = ADM2, code = LABI.code) => api("issueItem", { month: CUR, item_code: code, entries }, tok);
    expectErr(await ie({ PCU03: { issued_total: 5 } }, DL, A.code), "FORBIDDEN", "issueItem: item of another unit → FORBIDDEN for a dispenser");
    expectErr(await ie({ PCU04: { issued_total: 99 }, PCU03: { issued_total: 1, reason: "out_of_stock" } }), "BAD_REQUEST", "issueItem: an over-request entry rejects the call");
    eq((await mustOk("adminGetRequest", { pcu: "PCU03", month: CUR }, ADM2)).request.lines[LABI.code].issued_total, 5, "…and no PCU was touched (atomic)");
    expectErr(await ie({}), "BAD_REQUEST", "issueItem: empty entries → BAD_REQUEST");
    expectErr(await api("issueItem", { month: CUR, item_code: "ZZ-99", entries: { PCU03: { issued_total: 1 } } }, ADM2), "BAD_REQUEST", "issueItem: unknown item");
    const ii = await mustOk("issueItem", { month: CUR, item_code: LABI.code, entries: {
      PCU03: { issued_total: 3, reason: "other", note: "ส่งไม่ทัน" }, PCU04: { issued_total: 0, reason: "out_of_stock" },
      PCU05: { issued_total: 1 }, PCU12: { issued_total: 1 }, PCU99: { issued_total: 1 },
    } }, DL);
    eq(ii.updated, ["PCU03", "PCU04"], "issueItem: updated = PCUs that requested the item");
    eq(ii.skipped.map((s) => s.pcu).sort(), ["PCU05", "PCU12", "PCU99"], "issueItem: skipped = no request / item not requested / unknown PCU (not an error)");
    ok(ii.skipped.every((s) => s.why) && ii.skipped.find((s) => s.pcu === "PCU05").why !== ii.skipped.find((s) => s.pcu === "PCU12").why, "issueItem: each skip carries a Thai reason");
    const g3 = (await mustOk("adminGetRequest", { pcu: "PCU03", month: CUR }, ADM2)).request.lines[LABI.code];
    const g4 = (await mustOk("adminGetRequest", { pcu: "PCU04", month: CUR }, ADM2)).request.lines[LABI.code];
    eq([g3.issued_total, g3.issued_op, g3.issued_pp, g3.issue_reason, g3.issue_note, g3.issued_by], [3, 1, 2, "other", "ส่งไม่ทัน", D_LAB], "issueItem PCU03: 3 of 3/2 → 1/2, reason other + note, issued_by dispenser");
    eq([g4.issued_total, g4.issued_op, g4.issued_pp, g4.issue_reason], [0, 0, 0, "out_of_stock"], "issueItem PCU04: set to 0, out of stock (ตัดรายการ)");
    const ai = await mustOk("adminItemIssue", { month: CUR, item_code: LABI.code }, DL);
    eq([ai.item.code, ai.item.name, ai.item.unit, ai.item.price, ai.item.dispense_unit, ai.item.step], [LABI.code, LABI.name, LABI.unit, LABI.price, "LAB", "LAB"], "adminItemIssue.item {code,name,unit,price,dispense_unit,step}");
    eq(ai.rows.map((x) => x.pcu), ["PCU03", "PCU04"], "adminItemIssue: one row per PCU that requested the item");
    eq(ai.rows[0], { pcu: "PCU03", pcu_name: ai.rows[0].pcu_name, status: "issued", op: 3, pp: 2, requested: 5, issued_total: 3, issued_op: 1, issued_pp: 2, reason: "other", note: "ส่งไม่ทัน", unit_done: true }, "adminItemIssue row shape (PCU03, LAB unit done)");
    ok(ai.rows[0].pcu_name && ai.rows[1].status === "submitted" && ai.rows[1].unit_done === false && ai.rows[1].requested === 6, "adminItemIssue: PCU04 row (submitted, unit not done)");
    expectErr(await api("adminItemIssue", { month: CUR, item_code: A.code }, DL), "FORBIDDEN", "adminItemIssue: item of another unit → FORBIDDEN for a dispenser");
    const aiA = await mustOk("adminItemIssue", { month: CUR, item_code: A.code }, ADM2);
    eq(aiA.rows.map((x) => x.pcu), ["PCU03", "PCU04", "PCU05"], "adminItemIssue (admin): all PCUs that requested A");
    eq(aiA.rows.map((x) => x.unit_done), [true, false, true], "adminItemIssue.unit_done per request (พัสดุ done on PCU03 and PCU05)");
    expectErr(await api("adminItemIssue", { month: CUR, item_code: "ZZ-99" }, ADM2), "BAD_REQUEST", "adminItemIssue: unknown item");
    expectErr(await api("adminItemIssue", { month: "x", item_code: A.code }, ADM2), "BAD_REQUEST", "adminItemIssue: bad month");
    const dsp4 = await mustOk("issueAll", { pcu: "PCU04", month: CUR }, DS);
    eq([lineOf(dsp4, A.code).issued_total, dsp4.issue.units.LAB.issued_lines], [2, 1], "dispenser พัสดุ+จ่ายกลาง issueAll(no unit) on PCU04 fills A but never LAB");

    // ---- adminRequests / adminGetRequest shape ----
    const ar = (await mustOk("adminRequests", { month: CUR }, ADM2)).requests;
    const q3 = ar.find((x) => x.pcu === "PCU03");
    eq(Object.keys(q3.issue).sort(), ["complete", "done", "incomplete", "issued_seen_at", "units", "units_done", "units_total"].sort(), "adminRequests[].issue keys");
    eq([q3.issue.units_total, q3.issue.units_done, q3.issue.done, q3.status], [3, 3, true, "issued"], "adminRequests PCU03: 3/3 units done, status issued");
    ok(q3.issue.units.LAB.done_by === ADMIN_EMAIL && q3.issue.units["พัสดุ"].done_by === D_STORE, "adminRequests: units carry done_by (staff view)");
    const q4 = ar.find((x) => x.pcu === "PCU04");
    eq([q4.issue.units_done, q4.issue.units_total, q4.issue.units.LAB.needed, q4.issue.units["จ่ายกลาง"].needed, q4.status], [0, 2, true, false, "submitted"], "adminRequests PCU04: 0 of 2 needed units done");
    await mustOk("saveLines", { month: CUR, lines: { [A.code]: { stock: 3, op: null, pp: null, updated_at: tsn() } } }, await login("PCU08"));
    const q8 = (await mustOk("adminRequests", { month: CUR }, ADM2)).requests.find((x) => x.pcu === "PCU08");
    eq(q8.issue, null, "adminRequests: issue is null when the request has no requested lines");
    eq((await mustOk("adminRequests", { month: PREV }, ADM2)).requests.every((x) => x.issue === null || typeof x.issue.units_total === "number"), true, "adminRequests{month: previous} carries issue too");
    const g = await mustOk("adminGetRequest", { pcu: "PCU03", month: CUR }, ADM2);
    eq([g.issue.units_done, g.issue.done, g.issue.units_total], [3, true, 3], "adminGetRequest.issue");
    const gd = await mustOk("adminGetRequest", { pcu: "PCU03", month: CUR }, DL);
    ok(gd.issue.units_total === 3 && Object.keys(gd.request.lines).every((c) => seedItems.find((i) => i.code === c).unit_of === "LAB"), "adminGetRequest for a dispenser: issue covers all units, lines only its own");
    eq((await mustOk("adminGetRequest", { pcu: "PCU12", month: CUR }, ADM2)).issue, null, "adminGetRequest without a request → issue null");

    // ---- Excel export carries the issued columns ----
    {
      const xr = await get(`/api/export.xlsx?month=${CUR}`, { authorization: "Bearer " + ADM2 });
      eq(xr.status, 200, "export.xlsx after issuing → 200");
      const wb = XLSX.read(Buffer.from(await xr.arrayBuffer()), { type: "buffer" });
      const s1 = XLSX.utils.sheet_to_json(wb.Sheets["รายบรรทัด"], { header: 1 });
      eq(s1[0].slice(12, 17), ["จ่ายจริง OP", "จ่ายจริง PP", "จ่ายจริงรวม", "เหตุผล", "สถานะ"], "export line sheet: issued headers");
      const ra = s1.find((x) => x[1] === "PCU03" && x[4] === A.code), rl = s1.find((x) => x[1] === "PCU03" && x[4] === LABI.code), r4 = s1.find((x) => x[1] === "PCU04" && x[4] === LABI.code);
      eq([ra[12], ra[13], ra[14], ra[15], ra[16]], [7, 5, 12, "ของหมด/รอจัดซื้อ", "จ่ายแล้ว"], "export: PCU03 A → issued 7/5 = 12, reason ของหมด/รอจัดซื้อ, status จ่ายแล้ว");
      eq([rl[12], rl[13], rl[14], rl[15]], [1, 2, 3, "ส่งไม่ทัน"], "export: reason 'other' prints the typed note");
      eq([r4[12], r4[13], r4[14], r4[16]], [0, 0, 0, "ส่งแล้ว"], "export: an issued-0 line is exported (0/0/0) on a still-submitted request");
      const s2 = XLSX.utils.sheet_to_json(wb.Sheets["รพ.สต. × รายการ"], { header: 1 });
      const at = s2.findIndex((x) => x[0] && String(x[0]).startsWith("จำนวนที่จ่ายจริง"));
      const rowA2 = s2.slice(at).find((x) => x[0] === A.code);
      ok(at > 0 && rowA2 && rowA2[rowA2.length - 1] >= 12 + 2, "export sheet 2: second block (จ่ายจริง) has A ≥ 12 + 2");
      let expBaht = 0;
      for (const pc of ["PCU03", "PCU04", "PCU05"]) {
        const lines = (await mustOk("adminGetRequest", { pcu: pc, month: CUR }, ADM2)).request.lines;
        for (const l of Object.values(lines)) expBaht += ((l.issued_op || 0) + (l.issued_pp || 0)) * (l.price_snapshot || 0);
      }
      const s3 = XLSX.utils.sheet_to_json(wb.Sheets["สรุปเงินต่อ รพ.สต."], { header: 1 });
      const tot = s3[s3.length - 1];
      ok(tot[10] > 0 && near(tot[10], expBaht, 0.05), `export sheet 3: จ่ายจริงรวม = Σ issued × price_snapshot (${Math.round(expBaht * 100) / 100})`);
    }

    // ---- audit ----
    {
      const a = (await mustOk("adminAuditLog", { limit: 500 }, ADM2)).entries;
      for (const act of ["issue_lines", "issue_all", "issue_done", "issue_item"]) ok(a.some((e) => e.action === act), `audit has "${act}"`);
      const dl = a.find((e) => e.action === "issue_lines" && e.actor === D_LAB);
      ok(dl && dl.role === "dispenser" && dl.pcu === "PCU03" && dl.month === CUR && dl.detail.includes(LABI.code), "audit: issue_lines by the dispenser (actor, role, pcu, month, detail)");
      ok(a.some((e) => e.action === "issue_done" && e.detail.includes("status=issued") && e.detail.includes("done=1")), "audit: issue_done records the resulting status");
      ok(a.filter((e) => e.action === "issue_item").length === 2, "audit: issue_item has one row per updated PCU");
    }

    // ---- clean up ----
    ok((await api("adminUsersRemove", { email: D_LAB }, ADM2)).ok && (await api("adminUsersRemove", { email: D_STORE }, ADM2)).ok, "temporary dispensers removed again");
    ok((await mustOk("adminClearTrial", { confirm: "ล้างข้อมูล" }, ADM2)).deleted_issue_status >= 4, "adminClearTrial wipes issue_status rows too");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("form editor (2d)");
  {
    const cl = (o) => JSON.parse(JSON.stringify(o));
    const stepOf = (steps, code) => steps.find((x) => x.code === code);
    const itemRows = (steps) => steps.flatMap((x) => x.rows.filter((r) => r.type === "item"));
    const findItem = (steps, code) => itemRows(steps).find((r) => r.code === code);
    const activeN = (st) => st.rows.filter((r) => r.type === "item" && r.active !== false).length;
    const nextCode = (st, prefix) => `${prefix}-${String(Math.max(0, ...st.rows.filter((r) => r.type === "item").map((r) => Number(r.code.split("-")[1]))) + 1).padStart(2, "0")}`;

    await mustOk("adminSetLimitMode", { mode: "off" }, ADM2);
    await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM2);
    await mustOk("adminLockRound", { month: CUR, locked: 0 }, ADM2);

    // ---- read: bootstrap form == adminFormGet ----
    const b0 = await mustOk("adminBootstrap", {}, ADM2);
    let F = b0.form;
    const g0 = (await mustOk("adminFormGet", { id: F.id }, ADM2)).form;
    eq([g0.id, g0.fy, g0.steps], [F.id, F.fy, F.steps], "adminFormGet(latest) = adminBootstrap.form");
    ok("created_by" in g0 && g0.created_by, "adminFormGet carries created_by");
    expectErr(await api("adminFormGet", { id: 999999 }, ADM2), "NOT_FOUND", "adminFormGet unknown id");
    expectErr(await api("adminFormGet", { id: "x" }, ADM2), "BAD_REQUEST", "adminFormGet bad id");
    const V0 = F.id, base0 = cl(F);

    // ---- requests before the edit: one submitted (A + B), one draft ----
    const TF1 = (await mustOk("pcuLogin", { pcu: "PCU13", pin: "12345" })).token;
    const TF2 = (await mustOk("pcuLogin", { pcu: "PCU14", pin: "12345" })).token;
    const subOld = await api("saveLines", { month: CUR, lines: { [A.code]: { op: 2, updated_at: t(1) }, [B.code]: { op: 3, updated_at: t(1) } }, send: true }, TF1);
    ok(subOld.ok && subOld.data.request.form_version_id === V0, "pre-edit: PCU13 submitted on the old version");
    ok((await api("saveLines", { month: CUR, lines: { [A.code]: { op: 1, updated_at: t(1) } } }, TF2)).ok, "pre-edit: PCU14 has a draft");
    const oldA = findItem(base0.steps, A.code).price;

    // ---- no change → same ----
    const same = await mustOk("adminFormSave", { base_version_id: V0, note: "ไม่มีอะไรเปลี่ยน", form: { steps: cl(F.steps) } }, ADM2);
    ok(same.saved === false && same.same === true && same.form.id === V0, "save with no change → same:true, no new version");
    eq(same.versions.length, 1, "no new row after a same-save");
    // a lighter payload (no order/seq/page_no/active) normalises to the same data
    const lite = cl(F.steps).map((x) => { delete x.order; delete x.page_no; delete x.active; x.rows.forEach((r) => { delete r.seq; }); return x; });
    ok((await mustOk("adminFormSave", { base_version_id: V0, form: { steps: lite } }, ADM2)).same === true, "payload without order/page_no/seq → still same (server renumbers)");

    // ---- the big edit ----
    const steps = cl(F.steps);
    const P1 = stepOf(steps, "P1"), P2 = stepOf(steps, "P2"), P5 = stepOf(steps, "P5");
    const p1items = P1.rows.filter((r) => r.type === "item");
    const priceItem = p1items[0], renItem = p1items[1], unitItem = p1items[2], moveItem = p1items[p1items.length - 1];
    ok(priceItem.code === A.code, "fixture: first P1 item is A");
    const oldPrice = priceItem.price;
    priceItem.price = Math.round((priceItem.price + 1.5) * 100) / 100;
    const oldName = renItem.name; renItem.name = oldName + " (ปรับชื่อ)";
    const oldUnit = unitItem.unit; unitItem.unit = "ชุดทดสอบ";
    P1.rows = P1.rows.filter((r) => r !== moveItem);
    P5.rows.push(moveItem);
    const newP5 = nextCode(P5, "P5");
    P5.rows.push({ type: "item", code: newP5, name: "รายการใหม่ทดสอบ", unit: "กล่อง", price: 12.3456, active: true });
    const closeItem = P2.rows.find((r) => r.type === "item" && r.code === B.code);
    closeItem.active = false;
    steps.push({ code: "S08", sheet: "แบบ พัสดุ 8", title: "หน้าใหม่ทดสอบ", subject: "เรื่องทดสอบ", to: "ผู้อำนวยการ", dispense_unit: "พัสดุ",
                 rows: [{ type: "item", code: "S08-01", name: "รายการหน้า 8", unit: "อัน", price: 99, active: true }] });
    const sv = await mustOk("adminFormSave", { base_version_id: V0, note: "แก้ราคา เพิ่มหน้า 8", form: { steps } }, ADM2);
    ok(sv.saved === true && sv.form.id > V0 && sv.form.fy === 2570, "save → saved:true, new version of the same fy");
    eq(sv.versions.length, 2, "versions list has 2 entries");
    eq(sv.versions[0], { id: sv.form.id, fy: 2570, created_at: sv.versions[0].created_at, created_by: ADMIN_EMAIL, note: "แก้ราคา เพิ่มหน้า 8" }, "versions[0] = the new version (created_by = actor, note)");
    const d = sv.diff;
    eq([d.steps_added, d.steps_closed, d.steps_reopened], [["S08"], [], []], "diff: steps_added S08");
    eq(d.items_added.sort(), [newP5, "S08-01"].sort(), "diff: items_added (new P5 item + S08-01)");
    eq(d.items_closed, [B.code], "diff: items_closed");
    eq(d.price_changed, [{ code: priceItem.code, old: oldPrice, new: priceItem.price }], "diff: price_changed with old/new");
    eq(d.renamed, [{ code: renItem.code, old: oldName, new: oldName + " (ปรับชื่อ)" }], "diff: renamed");
    eq(d.unit_changed, [unitItem.code], "diff: unit_changed");
    eq(d.moved, [{ code: moveItem.code, from: "P1", to: "P5" }], "diff: moved P1 → P5");
    ok(findItem(sv.form.steps, newP5).price === 12.35, "price rounded to 2 decimals (12.3456 → 12.35)");
    eq(sv.form.steps.map((x) => x.order), sv.form.steps.map((_, i) => i + 1), "steps renumbered: order = 1..n");
    eq([stepOf(sv.form.steps, "S08").page_no, stepOf(sv.form.steps, "S08").active], [8, true], "new page: page_no 8, active true");
    eq(itemRows(sv.form.steps).map((r) => r.seq), itemRows(sv.form.steps).map((_, i) => i + 1), "item.seq = running number over the whole form");
    ok(findItem(sv.form.steps, B.code).active === false && stepOf(sv.form.steps, "P2").rows.some((r) => r.code === B.code), "closed item stays in the page with active:false");
    const aud = (await mustOk("adminAuditLog", { limit: 20 }, ADM2)).entries.find((e) => e.action === "form_save");
    ok(aud && aud.actor === ADMIN_EMAIL, "audit has form_save");
    const ad = aud ? JSON.parse(aud.detail) : {};
    ok(ad.id === sv.form.id && ad.note === "แก้ราคา เพิ่มหน้า 8" && ad.diff && ad.diff.steps_added[0] === "S08", "audit detail = JSON {id, note, diff}");
    expectErr(await api("adminFormSave", { base_version_id: V0, form: { steps } }, ADM2), "CONFLICT", "stale base_version_id → CONFLICT");
    const dget = (await mustOk("adminFormGet", { id: V0 }, ADM2)).form;
    eq(dget.steps, base0.steps, "old version is immutable (adminFormGet of the old id)");
    F = sv.form;
    const V1 = F.id;

    // ---- PCU side ----
    const pb1 = await mustOk("pcuBootstrap", {}, TF1);
    eq(pb1.form_version_id, V1, "pcuBootstrap.form_version_id = new version");
    ok(stepOf(pb1.form.steps, "S08") && findItem(pb1.form.steps, "S08-01"), "pcuBootstrap.form has the new page + item");
    ok(findItem(pb1.form.steps, newP5) && findItem(pb1.form.steps, B.code).active === false, "new item present; closed item is active:false");
    ok(pb1.forms && pb1.forms[V0] && pb1.forms[V0].id === V0, "pcuBootstrap.forms has the old version bound to the submitted request");
    eq(findItem(pb1.forms[V0].steps, A.code).price, oldA, "forms[old] keeps the old price");
    const pb2 = await mustOk("pcuBootstrap", {}, TF2);
    eq(pb2.forms, {}, "forms is {} when no shown request is bound to an older version (draft)");
    const gm1 = await mustOk("pcuGetMonth", { month: CUR }, TF1);
    ok(gm1.form && gm1.form.id === V0, "pcuGetMonth.form = bound old version");
    ok(!("form" in (await mustOk("pcuGetMonth", { month: CUR }, TF2))), "pcuGetMonth omits form when it is the latest");
    const gr = await mustOk("adminGetRequest", { pcu: "PCU13", month: CUR }, ADM2);
    ok(gr.form.id === V0 && gr.form_version_id === V0 && findItem(gr.form.steps, A.code).price === oldA, "adminGetRequest: submitted request keeps its old version + old price");

    // ---- saving after the edit ----
    const s2 = await api("saveLines", { month: CUR, lines: { "S08-01": { op: 2, updated_at: t(2) }, [newP5]: { op: 1, updated_at: t(2) } }, send: true }, TF2);
    ok(s2.ok && s2.data.status === "submitted" && s2.data.request.form_version_id === V1, "draft: new item codes save + submit → bound to the new version");
    const gr2 = await mustOk("adminGetRequest", { pcu: "PCU14", month: CUR }, ADM2);
    eq(gr2.request.lines["S08-01"].price_snapshot, 99, "price_snapshot of the new item");
    eq(gr2.request.lines[A.code].price_snapshot, priceItem.price, "price_snapshot of the draft's item A = the NEW price");
    ok(gr2.form.id === V1, "adminGetRequest after resubmit: new version");
    const re = await api("saveLines", { month: CUR, lines: { [B.code]: { op: 4, updated_at: t(3) } }, send: true }, TF1);
    ok(re.ok && re.data.request.form_version_id === V1, "old submitted request with a closed item (qty>0) resubmits fine → new version");
    const gr3 = await mustOk("adminGetRequest", { pcu: "PCU13", month: CUR }, ADM2);
    ok(gr3.request.lines[B.code].op === 4 && gr3.request.lines[B.code].price_snapshot === findItem(F.steps, B.code).price, "closed item keeps its qty and price_snapshot on resubmit");
    const aNew = gr3.request.lines[A.code].price_snapshot;
    eq(aNew, findItem(F.steps, A.code).price, "resubmit: price_snapshot = new form price");
    ok(aNew !== oldA, "…and it differs from the old price");

    // ---- validation (each against the latest version) ----
    const bad = async (label, mut, needle, extra = {}) => {
      const st = cl(F.steps); mut(st);
      const r = await api("adminFormSave", { base_version_id: F.id, note: "t", form: { steps: st }, ...extra }, ADM2);
      expectErr(r, "BAD_REQUEST", label);
      if (needle) ok(r.error && r.error.message.includes(needle), `${label}: message names "${needle}"`);
    };
    const mkItem = (code, extra = {}) => ({ type: "item", code, name: "x", unit: "อัน", price: 1, active: true, ...extra });
    await bad("25 active items on a page", (st) => { const x = stepOf(st, "P2"); for (let i = activeN(x); i < 25; i++) x.rows.push(mkItem(`P2-9${String(i).padStart(2, "0")}`)); }, "P2");
    await bad("11 active steps", (st) => { for (const c of ["T09", "T10", "T11"]) st.push({ code: c, title: c, rows: [] }); }, "10");
    await bad("3 sections on a page", (st) => { stepOf(st, "P1").rows.push({ type: "section", title: "หมวดเกิน" }); stepOf(st, "P1").rows.push({ type: "section", title: "หมวดเกิน 2" }); }, "P1");
    await bad("empty section title", (st) => { stepOf(st, "P5").rows.push({ type: "section", title: " " }); }, "P5");
    await bad("section title > 80", (st) => { stepOf(st, "P5").rows.push({ type: "section", title: "ก".repeat(81) }); }, "P5");
    await bad("duplicate item code", (st) => { stepOf(st, "P3").rows.push(mkItem(A.code)); }, A.code);
    await bad("bad item code format", (st) => { stepOf(st, "P3").rows.push(mkItem("xx-1")); }, "xx-1");
    await bad("duplicate step code", (st) => { st.push({ code: "P1", title: "ซ้ำ", rows: [] }); }, "P1");
    await bad("bad step code format", (st) => { st.push({ code: "toolong1", title: "x", rows: [] }); });
    await bad("missing base item (deleted, not closed)", (st) => { const x = stepOf(st, "P2"); x.rows = x.rows.filter((r) => r.code !== A.code && r.code !== B.code); }, "ลบรายการไม่ได้");
    await bad("missing base step (deleted, not closed)", (st) => { st.splice(st.findIndex((x) => x.code === "CS"), 1); }, "CS");
    await bad("closing a step that still has active items", (st) => { stepOf(st, "CS").active = false; }, "CS");
    await bad("negative price", (st) => { findItem(st, A.code).price = -1; }, A.code);
    await bad("price not a number", (st) => { findItem(st, A.code).price = "12"; }, A.code);
    await bad("empty item name", (st) => { findItem(st, A.code).name = "  "; }, A.code);
    await bad("item name > 200", (st) => { findItem(st, A.code).name = "ก".repeat(201); }, A.code);
    await bad("unit > 30", (st) => { findItem(st, A.code).unit = "ก".repeat(31); }, A.code);
    await bad("empty step title", (st) => { stepOf(st, "P1").title = ""; }, "P1");
    await bad("step title > 120", (st) => { stepOf(st, "P1").title = "ก".repeat(121); }, "P1");
    await bad("bad dispense_unit", (st) => { stepOf(st, "P1").dispense_unit = "ร้านค้า"; }, "P1");
    await bad("note > 200 chars", () => {}, null, { note: "ก".repeat(201) });
    expectErr(await api("adminFormSave", { base_version_id: F.id, form: {} }, ADM2), "BAD_REQUEST", "form without steps");
    expectErr(await api("adminFormSave", { form: { steps: cl(F.steps) } }, ADM2), "BAD_REQUEST", "missing base_version_id");
    expectErr(await api("adminFormSave", { base_version_id: 987654, form: { steps: cl(F.steps) } }, ADM2), "NOT_FOUND", "unknown base_version_id");
    eq((await mustOk("adminBootstrap", {}, ADM2)).form_versions.length, 2, "rejected saves created no version");

    // ---- dispenser / no token ----
    await mustOk("adminUsersAdd", { email: "disp.form@example.com", role: "dispenser", units: ["LAB"] }, ADM2);
    const DSP = (await mustOk("adminLoginGoogle", { id_token: "dev:disp.form@example.com" })).token;
    expectErr(await api("adminFormSave", { base_version_id: F.id, form: { steps: cl(F.steps) } }, DSP), "FORBIDDEN", "dispenser: adminFormSave");
    expectErr(await api("adminFormGet", { id: F.id }, DSP), "FORBIDDEN", "dispenser: adminFormGet");
    expectErr(await api("adminExportSeed", {}, DSP), "FORBIDDEN", "dispenser: adminExportSeed");
    expectErr(await api("adminExportSeed", {}, TF1), "FORBIDDEN", "PCU token cannot export");
    expectErr(await api("adminFormGet", { id: F.id }), "AUTH_REQUIRED", "adminFormGet without a token");

    // ---- close + reopen a page ----
    const st3 = cl(F.steps);
    findItem(st3, "S08-01").active = false; stepOf(st3, "S08").active = false;
    const v3 = await mustOk("adminFormSave", { base_version_id: V1, note: "ปิดหน้า 8", form: { steps: st3 } }, ADM2);
    eq([v3.diff.steps_closed, v3.diff.items_closed], [["S08"], ["S08-01"]], "close a page (soft delete): diff steps_closed + items_closed");
    eq([stepOf(v3.form.steps, "S08").active, stepOf(v3.form.steps, "S08").page_no], [false, null], "closed page: active:false, page_no null");
    ok(stepOf(v3.form.steps, "P5").page_no === 5 && stepOf(v3.form.steps, "LAB").page_no === 7, "page_no stays a running number among active pages");
    const pb3 = await mustOk("pcuBootstrap", {}, TF2);
    ok(!stepOf(pb3.form.steps, "S08"), "pcuBootstrap.form strips closed pages");
    ok(pb3.forms[V1] && stepOf(pb3.forms[V1].steps, "S08"), "…but forms[V1] (still has S08 active) is intact");
    ok(!pb3.forms[V0], "forms lists only versions bound to the shown requests");
    const ab3 = await mustOk("adminBootstrap", {}, ADM2);
    ok(stepOf(ab3.form.steps, "S08") && stepOf(ab3.form.steps, "S08").active === false, "adminBootstrap.form keeps the closed page (active:false)");
    ok((await api("saveLines", { month: CUR, lines: { "S08-01": { op: 5, updated_at: t(4) } }, send: true }, TF2)).ok, "closed page's item code still saves on a request (code exists)");
    const st4 = cl(v3.form.steps);
    findItem(st4, "S08-01").active = true; stepOf(st4, "S08").active = true;
    const v4 = await mustOk("adminFormSave", { base_version_id: v3.form.id, note: "เปิดหน้า 8 กลับ", form: { steps: st4 } }, ADM2);
    eq([v4.diff.steps_reopened, v4.diff.items_reopened], [["S08"], ["S08-01"]], "reopen: diff steps_reopened + items_reopened");
    F = v4.form;
    ok(stepOf((await mustOk("pcuBootstrap", {}, TF2)).form.steps, "S08"), "reopened page is visible to PCUs again");

    // ---- adminExportSeed ----
    const ex = (await mustOk("adminExportSeed", {}, ADM2)).seed;
    eq([ex.format, ex.fy, ex.generated_by, ex.sources], ["pcu-supply-import/1", 2570, "adminExportSeed", ["D1 export"]], "export: format/fy/generated_by/sources");
    ok(ex.generated_at && !("verify" in ex), "export: generated_at, no verify block");
    eq(ex.pcus.length, 15, "export: 15 pcus");
    ok(ex.pcus.every((x) => x.code && x.name && x.print_name && "group" in x), "export: pcus carry code/name/print_name/group");
    eq(ex.form.steps.length, 8, "export: form has 8 steps (incl. S08)");
    eq(ex.form.steps, F.steps, "export: form steps = latest version (all steps incl. inactive)");
    ok(ex.form.note === "เปิดหน้า 8 กลับ" && ex.form.fy === 2570, "export: form note/fy of the latest version");
    ok(ex.plans["2570"] && ex.plans["2569"], "export: plans for every fy present");
    ok(Object.keys(ex.prices_prev["2569"]).length > 100, "export: prices_prev");
    const am = ex.actual_prev["2569"];
    ok(am && am.months.length === 12 && am.months[0] === "2025-10" && Object.values(Object.values(am.data)[0])[0].op.length === 12, "export: actual_prev months (12) + 12-element op/pp arrays");
    ok(Object.keys(ex.stats["2569"]).length > 0, "export: stats");
    const lv = Object.values(Object.values(ex.limits["2570"])[0])[0];
    ok(Array.isArray(lv) && lv.length === 3 && typeof lv[2] === "string", "export: limits [month, year, source]");
    const srcs = new Set(Object.values(ex.limits["2570"]).flatMap((o) => Object.values(o).map((v) => v[2])));
    ok(srcs.has("admin"), "export: admin-edited limit rows included");
    eq(ex.config, { fy_current: 2570, limit_mode: "off", stock_required: 0, budget_op: 520000, budget_pp: 390000, budget_total: 910000, deadline_day: null }, "export: config");
    const before2 = await counts();
    const rei = await mustOk("adminImportSeed", { seed: ex }, ADM2);
    eq(rei.imported.form, "same", "re-import of the export: form → same");
    eq(rei.imported.limits_inserted, 0, "re-import of the export: limits_inserted 0");
    ok(rei.imported.limits_kept_admin >= 1, "re-import of the export: admin limits kept");
    eq(rei.imported.config_set, [], "re-import of the export: config untouched");
    eq(rei.warnings, [], "re-import of the export: no warnings");
    eq(await counts(), before2, "re-import of the export: every table keeps its row count");
    const ex2 = (await mustOk("adminExportSeed", {}, ADM2)).seed;
    eq([ex2.plans, ex2.prices_prev, ex2.actual_prev, ex2.stats, ex2.limits, ex2.form, ex2.config], [ex.plans, ex.prices_prev, ex.actual_prev, ex.stats, ex.limits, ex.form, ex.config], "export → import → export is a fixed point");
    const exOld = (await mustOk("adminExportSeed", { fy: 2569 }, ADM2)).seed;
    ok(exOld.fy === 2569 && !("form" in exOld) && Object.keys(exOld.limits["2569"]).length === 0, "export with fy=2569: no form for that fy, empty limits");
    expectErr(await api("adminExportSeed", { fy: "abc" }, ADM2), "BAD_REQUEST", "export: bad fy");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
}

let exitCode = 0;
try { await main(); exitCode = fail ? 1 : 0; }
catch (e) { console.log("FATAL " + (e && e.stack || e)); exitCode = 1; }
finally { stopServer(); }
process.exit(exitCode);
