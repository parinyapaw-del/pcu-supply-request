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
// Pinned calendar month (X-Dev-Month) → deterministic fiscal-year edges. Brief 2j: a round is named after the supply month X and is keyed
// in X−1, so with calendar month CAL the open round is ROUND = CAL+1 and the previous (still editable) round is PREV_ROUND = CAL.
// CUR / PREV / NEXT are ROUND months (current round, previous round, the not-yet-open round after the current one).
const CAL = "2026-11";
const ROUND = "2026-12", PREV_ROUND = "2026-11";
const CUR = ROUND, PREV = PREV_ROUND, NEXT = "2027-01";
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
let devMonth = CAL;
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
// Excel / calendar months of a fiscal year (Oct … Sep — actual_prev columns) and its 12 ROUND months (Nov … Oct, brief 2j)
const fyExcelMonths = (fy) => { const out = []; let y = fy - 543 - 1, m = 10; for (let i = 0; i < 12; i++) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m === 13) { m = 1; y++; } } return out; };
const shiftMonth = (k, d) => { const [y, m] = k.split("-").map(Number); const n = y * 12 + (m - 1) + d; return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`; };
const fyRoundMonths = (fy) => fyExcelMonths(fy).map((m) => shiftMonth(m, 1));
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
  const months69 = fyExcelMonths(2569);
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
  ok(boot.rounds.some((r) => r.month === CUR) && boot.rounds.some((r) => r.month === PREV), "adminBootstrap: rounds include current + previous round");
  eq([boot.current_month, boot.current_round], [CAL, ROUND], "adminBootstrap: current_month = calendar month, current_round = CAL+1 (2j)");
  ok(boot.rounds.every((r) => r.trial === false) && boot.config.trial_month === null, "adminBootstrap: no trial round by default (config.trial_month null, round.trial false)");

  // ------------------------------------------------------------------------------------------------------------------------
  section("PCU login / PIN lock / PIN change");
  const lst = await mustOk("pcuList");
  eq(lst.pcus.length, 15, "pcuList: 15 pcus");
  ok(lst.pcus[0].code && lst.pcus[0].name, "pcuList: code+name");
  // 2m — PIN login counter (admin only). PCU03 is not logged into before this block; wrong PIN first, then 2 successes
  // → pin_fail is back to 0 (later PCU03 cases unaffected).
  ok(boot.pcus.every((x) => x.login_count === 0 && x.last_login_at === null), "2m: after devReset every pcu login_count 0 / last_login_at null");
  const t2m = new Date().toISOString();
  expectErr(await api("pcuLogin", { pcu: "PCU03", pin: "00000" }), "BAD_PIN", "2m: PCU03 wrong PIN (not counted)");
  await mustOk("pcuLogin", { pcu: "PCU03", pin: "12345" });
  const T3m = (await mustOk("pcuLogin", { pcu: "PCU03", pin: "12345" })).token;
  ok((await api("pcuBootstrap", {}, T3m)).ok, "2m: pcuBootstrap with the token (not counted)");
  const b2m = (await mustOk("adminBootstrap", {}, ADM)).pcus.find((x) => x.code === "PCU03");
  eq(b2m.login_count, 2, "2m: PCU03 login_count = 2 (2 successful pcuLogin, wrong PIN + token bootstrap not counted)");
  ok(typeof b2m.last_login_at === "string" && !isNaN(Date.parse(b2m.last_login_at)) && b2m.last_login_at >= t2m, "2m: PCU03 last_login_at ISO ≥ time before the logins");
  eq(b2m.pin_fail, 0, "2m: PCU03 pin_fail back to 0 after successful login");
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

  // 2k — pcuChangePin (PCU07's PIN is 54321 here and must be 54321 again at the end; other PCUs keep 12345)
  eq(l1.data.bootstrap.pcu.pin_custom, false, "pcuLogin bootstrap: pcu.pin_custom false on default PIN");
  const l7c = await mustOk("pcuLogin", { pcu: "PCU07", pin: "54321" });
  eq(l7c.bootstrap.pcu.pin_custom, true, "pcuLogin bootstrap: pcu.pin_custom true after adminSetPin");
  const T7 = l7c.token;
  expectErr(await api("pcuChangePin", { old_pin: "54321", new_pin: "67890" }), "AUTH_REQUIRED", "pcuChangePin without token");
  expectErr(await api("pcuChangePin", { old_pin: "54321", new_pin: "67890" }, ADM), "FORBIDDEN", "pcuChangePin with admin token");
  expectErr(await api("pcuChangePin", { old_pin: "54321", new_pin: "123" }, T7), "BAD_REQUEST", "pcuChangePin rejects 3-digit new PIN");
  const same = await api("pcuChangePin", { old_pin: "54321", new_pin: "54321" }, T7);
  expectErr(same, "BAD_REQUEST", "pcuChangePin rejects new = old");
  ok(!same.ok && /ต่างจาก/.test(same.error.message), "pcuChangePin new = old message says ต่างจาก");
  expectErr(await api("pcuChangePin", { old_pin: "54321", new_pin: 12345 }, T7), "BAD_REQUEST", "pcuChangePin rejects numeric new_pin");
  const wc = await api("pcuChangePin", { old_pin: "00000", new_pin: "67890" }, T7);
  expectErr(wc, "BAD_PIN", "pcuChangePin wrong old PIN"); eq(wc.error && wc.error.remaining, 4, "pcuChangePin BAD_PIN remaining = 4");
  const ch = await mustOk("pcuChangePin", { old_pin: "54321", new_pin: "67890" }, T7);
  ok(ch.token && ch.exp && ch.token !== T7, "pcuChangePin ok → new token + exp");
  expectErr(await api("pcuBootstrap", {}, T7), "AUTH_EXPIRED", "old PCU07 token invalid after pcuChangePin");
  const chb = await api("pcuBootstrap", {}, ch.token);
  ok(chb.ok && chb.data.pcu.code === "PCU07", "token returned by pcuChangePin works on pcuBootstrap");
  eq(chb.data && chb.data.pcu.pin_custom, true, "pcuBootstrap: pcu.pin_custom true");
  expectErr(await api("pcuLogin", { pcu: "PCU07", pin: "54321" }), "BAD_PIN", "old PIN rejected after pcuChangePin");
  ok((await api("pcuLogin", { pcu: "PCU07", pin: "67890" })).ok, "new PIN accepted after pcuChangePin");
  const back = await api("pcuChangePin", { old_pin: "67890", new_pin: "54321" }, ch.token);
  ok(back.ok && back.data.token, "pcuChangePin back to 54321 with the new token");
  const T7b = back.data && back.data.token;
  let lc;
  for (let i = 0; i < 5; i++) lc = await api("pcuChangePin", { old_pin: "11111", new_pin: "22222" }, T7b);
  ok(!lc.ok && lc.error.code === "PIN_LOCKED" && lc.error.until, "5th wrong old PIN on pcuChangePin → PIN_LOCKED with until");
  expectErr(await api("pcuLogin", { pcu: "PCU07", pin: "54321" }), "PIN_LOCKED", "pcuLogin locked by pcuChangePin failures (shared counter)");
  ok((await api("adminUnlockPin", { pcu: "PCU07" }, ADM)).ok, "adminUnlockPin PCU07");
  ok((await api("pcuLogin", { pcu: "PCU07", pin: "54321" })).ok, "pcuLogin PCU07 54321 after unlock");
  eq((await mustOk("adminBootstrap", {}, ADM)).pcus.find((p) => p.code === "PCU07").pin_custom, true, "adminBootstrap: pin_custom true after pcuChangePin");

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
  for (const k of ["server_time", "current_month", "current_round", "pcu", "config", "form_version_id", "form", "rounds", "next_round", "history", "hidden", "never_prev", "limits", "plans", "unlocks", "byMonth", "issue_notices"]) ok(k in pb, `bootstrap has "${k}"`);
  eq(pb.current_month, CAL, "bootstrap.current_month = calendar month (honours X-Dev-Month)");
  eq(pb.current_round, ROUND, "bootstrap.current_round = calendar month + 1 (2j)");
  eq(pb.config, { limit_mode: "warn", stock_required: 0, deadline_day: null, fy_current: 2570, trial_month: null }, "bootstrap.config (+ trial_month null)");
  eq(pb.rounds.map((r) => r.month), [ROUND, PREV_ROUND], "bootstrap.rounds = [currentRound, prevRound] = [CAL+1, CAL]");
  eq(pb.rounds.map((r) => r.fy), [2570, 2570], "rounds 2026-12 / 2026-11 are both FY2570");
  eq(pb.rounds.map((r) => r.deadline_date), ["2026-11-30", "2026-10-31"], "deadline = last day of the month BEFORE the round (submission month)");
  eq(pb.rounds[0].deadline_source, "month_end", "deadline_source month_end");
  eq(pb.form_version_id, pb.form.id, "form_version_id = form.id");
  eq(pb.form.steps.length, seed.form.steps.length, "form steps");
  ok(pb.form.steps.every((s) => s.dispense_unit) && pb.form.steps[0].rows.some((r) => r.type === "item" && r.active === true), "form carries dispense_unit + item.active");
  ok(Object.keys(pb.plans).length > 0 && Object.values(pb.plans)[0].length === 2, "bootstrap.plans {code:[op,pp]}");
  ok(Object.values(pb.limits).every((v) => Array.isArray(v) && v.length === 2), "bootstrap.limits {code:[month,year]}");
  ok(Array.isArray(pb.never_prev) && Array.isArray(pb.hidden), "never_prev / hidden arrays");
  ok(!("older_months" in pb), "older_months removed (2l: replaced by history)");
  eq([pb.next_round.month, pb.next_round.opens_on, pb.next_round.deadline_date, pb.next_round.deadline_source], [NEXT, "2026-12-01", "2026-12-31", "month_end"], "next_round = round 2027-01, opens 2026-12-01, due 2026-12-31 (month end)");
  eq([pb.next_round.fy, pb.next_round.trial, pb.next_round.locked], [2570, false, false], "next_round carries fy/trial/locked (RoundInfo)");
  eq(pb.history.map((h) => h.month), ["2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01", "2025-12", "2025-11"], "history = every round from FY2569's first (2025-11) up to before prevRound, newest first (12 entries)");
  ok(pb.history.every((h) => h.status === "not_started" && h.submitted_at === null && h.trial === false && h.locked === false), "history after devReset: all not_started, submitted_at null, not trial, not locked");
  ok(pb.history.every((h) => h.fy === 2569) && Object.keys(pb.history[0]).sort().join() === "fy,locked,month,status,submitted_at,trial", "history fy 2569 (2026-10 and 2025-11 alike) · entry keys {month,fy,trial,locked,status,submitted_at}");
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
  eq(r.request.lines[A.code], { stock: 2, op: 5, pp: 1, used: null, adj: null, adj_reason: null, calc_from: null, updated_at: t(1) }, "line stored (PCU view has no price/issued fields; 2o fields null)");
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
  expectErr(await api("pcuGetMonth", { month: NEXT }, T1), "BAD_REQUEST", "pcuGetMonth: a round after currentRound → BAD_REQUEST");
  ok(/เดือนนี้ยังไม่ถึง/.test((await api("pcuGetMonth", { month: NEXT }, T1)).error.message), "pcuGetMonth future message unchanged (เดือนนี้ยังไม่ถึง)");
  ok(/เดือนนี้ไม่เปิดให้กรอก/.test((await api("saveLines", { month: "2026-08", lines: {} }, T1)).error.message), "saveLines outside [currentRound, prevRound] message unchanged (เดือนนี้ไม่เปิดให้กรอก)");

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
  eq((await mustOk("pcuBootstrap", {}, T3)).byMonth[CUR].used_fy[A.code], 15, "used_fy[current] = Σ other rounds of the fiscal year (15) — round 2026-11 is FY2570 and counts (2j)");
  eq((await mustOk("pcuBootstrap", {}, T3)).byMonth[CUR].prev_lines[A.code], { op: 10, pp: 5, stock: null, received: 15, received_src: "requested" }, "prev_lines from previous month's submitted request (2o: + stock/received)");
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
  await mustOk("adminUnlockLimit", { pcu: "PCU03", item_code: A.code, month: "2026-10", reason: "รอบปีงบ 2569" }, ADM);
  await mustOk("adminUnlockLimit", { pcu: "PCU03", item_code: A.code, month: "2027-10", reason: "รอบสุดท้ายปีงบ 2570" }, ADM);
  const ulm = (await mustOk("adminBootstrap", {}, ADM)).unlocks.filter((u) => u.pcu === "PCU03").map((u) => u.month).sort();
  eq(ulm, [CUR, "2027-10"], "adminBootstrap.unlocks = rounds of FY2570 only (2026-11 … 2027-10): 2026-10 (FY2569) excluded, 2027-10 included");
  for (const m of ["2026-10", "2027-10"]) await mustOk("adminRemoveUnlock", { pcu: "PCU03", item_code: A.code, month: m }, ADM);
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
  await mustOk("adminSetRound", { month: NEXT, deadline_date: "2026-12-20" }, ADM);
  let nr = (await mustOk("pcuBootstrap", {}, T6)).next_round;
  eq([nr.month, nr.deadline_date, nr.deadline_source, nr.opens_on], [NEXT, "2026-12-20", "round", "2026-12-01"], "next_round reads its rounds row (deadline set in advance by admin)");
  await mustOk("adminSetRound", { month: NEXT, deadline_date: null }, ADM);
  nr = (await mustOk("pcuBootstrap", {}, T6)).next_round;
  eq([nr.deadline_date, nr.deadline_source], ["2026-12-31", "month_end"], "next_round deadline override cleared → month end");
  expectErr(await api("adminSetConfig", { key: "deadline_day", value: 40 }, ADM), "BAD_REQUEST", "deadline_day out of range");
  await mustOk("adminSetConfig", { key: "deadline_day", value: 25 }, ADM);
  let pr = (await mustOk("pcuBootstrap", {}, T6)).rounds;
  eq([pr[0].deadline_date, pr[0].deadline_source], ["2026-11-25", "config"], "config.deadline_day=25 → 25th of the submission month (round 2026-12 → 2026-11-25)");
  eq(pr[1].deadline_date, "2026-10-25", "config.deadline_day=25 for the previous round 2026-11 → 2026-10-25");
  await mustOk("adminSetConfig", { key: "deadline_day", value: 31 }, ADM);
  eq((await mustOk("pcuBootstrap", {}, T6)).rounds[0].deadline_date, "2026-11-30", "deadline_day 31 clamps to the month length (Nov has 30)");
  await mustOk("adminSetConfig", { key: "deadline_day", value: null }, ADM);
  await mustOk("saveLines", { month: CUR, lines: { [A.code]: { op: 1, updated_at: t(1) } } }, T6);
  eq((await mustOk("adminLockRound", { month: CUR, locked: 1 }, ADM)).round.locked, true, "adminLockRound locks");
  expectErr(await api("saveLines", { month: CUR, lines: { [A.code]: { op: 2, updated_at: t(2) } } }, T6), "CONFLICT", "locked round: autosave → CONFLICT");
  expectErr(await api("saveLines", { month: CUR, lines: {}, send: true }, T6), "CONFLICT", "locked round: send → CONFLICT");
  eq((await mustOk("pcuBootstrap", {}, T6)).rounds[0].locked, true, "bootstrap.rounds[].locked");
  {
    const hb = await api("pcuBootstrap", {}, T6, { month: "2027-01" }); // cur 2027-02, prev 2027-01 → CUR (2026-12) and PREV (2026-11) are history
    const h = hb.ok ? Object.fromEntries(hb.data.history.map((x) => [x.month, x])) : {};
    eq(h[CUR] && [h[CUR].locked, h[CUR].status, h[CUR].submitted_at, h[CUR].fy], [true, "draft", null, 2570], "history: locked round row → locked:true · draft request → status draft, submitted_at null");
    eq(h[PREV] && [h[PREV].locked, h[PREV].status], [false, "not_started"], "history: neighbouring round without a request → not_started, unlocked");
    eq(hb.ok && [hb.data.history.length, hb.data.history[0].month, hb.data.history.at(-1).month], [14, CUR, "2025-11"], "X-Dev-Month 2027-01: history = 2026-12 … 2025-11 (FY2570 so far + all of FY2569)");
  }
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
  ok(db1.pcus.every((x) => !("login_count" in x) && !("last_login_at" in x)), "2m: dispenser adminBootstrap has no login_count / last_login_at");
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
  section("fiscal-year edge: previous round in FY2569 (form fallback, 2j)");
  {
    const T9 = (await mustOk("pcuLogin", { pcu: "PCU09", pin: "12345" }, undefined)).token;
    const o = { month: "2026-10" }; // calendar Oct 2569 → open round 2026-11 (first round of FY2570), previous round 2026-10 (FY2569)
    const eb = await api("pcuBootstrap", {}, T9, o);
    ok(eb.ok && eb.data.rounds[0].month === "2026-11" && eb.data.rounds[1].month === "2026-10", "calendar 2026-10: rounds = [2026-11, 2026-10]");
    eq(eb.data.rounds.map((r) => [r.fy, r.deadline_date]), [[2570, "2026-10-31"], [2569, "2026-09-30"]], "round 2026-11 → FY2570 due 31 Oct · round 2026-10 → FY2569 due 30 Sep");
    eq([eb.data.current_month, eb.data.current_round, eb.data.config.fy_current], ["2026-10", "2026-11", 2570], "calendar 2026-10: current_round 2026-11, fy_current fallback 2570");
    const e1 = await api("saveLines", { month: "2026-10", lines: { [A.code]: { op: 1, updated_at: t(1) } }, send: true }, T9, o);
    ok(e1.ok && e1.data.status === "submitted" && e1.data.request.form_version_id === eb.data.form_version_id, "FY2569 round (no 2569 form) binds the fy_current form (formForFy)");
    expectErr(await api("saveLines", { month: "2026-12", lines: {} }, T9, o), "BAD_REQUEST", "calendar 2026-10: round 2026-12 not open yet");
    expectErr(await api("saveLines", { month: "2026-09", lines: {} }, T9, o), "BAD_REQUEST", "calendar 2026-10: round 2026-09 (no request) not open");
    const e2 = await api("pcuBootstrap", {}, T9, o);
    eq([e2.data.history.length, e2.data.history[0].month, e2.data.history.at(-1).month], [11, "2026-09", "2025-11"], "calendar 2026-10: history = 2026-09 … 2025-11 (prevRound 2026-10 is a full card, not history)");
    const hc = (await mustOk("pcuBootstrap", {}, T9)).history[0];
    eq(hc, { month: "2026-10", fy: 2569, trial: false, locked: false, status: "submitted", submitted_at: e1.data.request.submitted_at }, "calendar CAL: the sent FY2569 round 2026-10 is history[0] with status submitted + submitted_at");
    eq(e2.data.byMonth["2026-11"].used_fy, {}, "FY2570 used_fy ignores the FY2569 round 2026-10");
    eq(e2.data.byMonth["2026-11"].prev_lines[A.code], { op: 1, pp: 0, stock: null, received: 1, received_src: "requested" }, "…but prev_lines still reads the previous round");
    ok((await api("saveLines", { month: "2026-11", lines: {} }, T9, o)).ok, "saving in the first round of the FY (2026-11) works");
    eq((await mustOk("pcuBootstrap", {}, T9)).byMonth[CUR].used_fy, {}, "calendar CAL: used_fy of round 2026-12 still excludes the FY2569 round 2026-10");
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
    // 2j: fy= covers the 12 ROUND months of the fy (Nov … Oct) — round 2026-10 (PCU09, sent above) is FY2569, not FY2570
    const sheetMonths = async (res) => {
      const w = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
      return [...new Set(XLSX.utils.sheet_to_json(w.Sheets[w.SheetNames[0]], { header: 1 }).slice(1).map((r) => r[0]))].sort();
    };
    const m70 = await sheetMonths(xf);
    ok(m70.includes(PREV_ROUND) && m70.includes(ROUND) && m70.every((m) => m >= "2026-11" && m <= "2027-10"), `export fy=2570: months within 2026-11 … 2027-10 (${m70.join(",")})`);
    eq(await sheetMonths(await get(`/api/export.xlsx?fy=2569`, { authorization: "Bearer " + ADM2 })), ["2026-10"], "export fy=2569: only round 2026-10 (the last round of FY2569)");
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
    for (const a of ["submit", "adminSetPin", "pcuChangePin", "adminLockRound", "adminNote", "adminSetConfig", "import_seed", "adminUsersAdd", "adminLimitsUpload", "adminSetLimit"]) ok(acts.has(a), `audit has "${a}"`);
    const cpa = a1.entries.find((e) => e.action === "pcuChangePin" && e.detail === "ok");
    ok(cpa && cpa.actor === "PCU07" && cpa.role === "pcu", "audit pcuChangePin: actor PCU07, role pcu");
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
    const abD = await mustOk("adminBootstrap", {}, ADM2);
    const FD = abD.form; // latest FY2570 form (prices edited by 2p)
    const TP = (await mustOk("pcuLogin", { pcu: P, pin: "12345" })).token;
    const TQ = (await mustOk("pcuLogin", { pcu: Q, pin: "12345" })).token;
    const T3b = (await mustOk("pcuLogin", { pcu: "PCU03", pin: "12345" })).token; // another PCU
    const DSPE = "pdf.dispenser@example.com"; // the earlier dispenser was removed by the users section; a temporary one (removed again below)
    await mustOk("adminUsersAdd", { email: DSPE, role: "dispenser", units: ["LAB"] }, ADM2);
    const DSP2 = (await mustOk("adminLoginGoogle", { id_token: "dev:" + DSPE })).token;
    const tt = (s) => `2026-11-12T10:00:${String(s).padStart(2, "0")}.000Z`;
    const idP = `${P}_${CUR}`;
    const files = async (prefix) => (await mustOk("devListFiles", { prefix })).keys;
    const expectedName = `ใบเบิก_${pr.print_name}_ธันวาคม 2569.pdf`; // round CUR = 2026-12 ("ขอเบิก ธันวาคม 2569")
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
    // 2g: inline=1 → the พิมพ์ button (non-Chromium browsers) opens the PDF in the tab; same filename params, same auth
    const inl = await get(p1.url + "&token=" + encodeURIComponent(TP) + "&inline=1");
    const inlBody = Buffer.from(await inl.arrayBuffer());
    ok(inl.status === 200 && inl.headers.get("content-type") === "application/pdf" && inlBody.subarray(0, 4).toString() === "%PDF", "GET pdf &inline=1 with own token → 200 application/pdf (%PDF)");
    const icd = inl.headers.get("content-disposition") || "";
    ok(/^inline;/.test(icd) && icd.includes(`filename="request.pdf"`) && icd.includes("filename*=UTF-8''" + encodeURIComponent(expectedName)), "content-disposition: inline with the same filename params (inline=1)");
    ok(/^attachment;/.test((await get(p1.url + "&token=" + encodeURIComponent(TP) + "&inline=0")).headers.get("content-disposition") || ""), "inline=0 (anything but 1) → still attachment");
    const inlOther = await get(p1.url + "&token=" + encodeURIComponent(T3b) + "&inline=1");
    ok(inlOther.status === 403 && (await inlOther.json()).error.code === "FORBIDDEN", "GET pdf &inline=1 with another PCU's token → 403 (auth unchanged)");
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
    // 2b-R retention: the latest month keeps the newest 2 versions → storing the hidden variant (3rd version) pruned v1
    eq((await files(`pdf/${P}/`)).sort(), [`pdf/${P}/${CUR}/${p3.content_key}.pdf`, `pdf/${P}/${CUR}/${p4.content_key}.pdf`].sort(), "two objects (v2 + hidden variant; v1 pruned by the 2-version rule)");
    eq((await get(p1.url, { authorization: "Bearer " + ADM2 })).status, 404, "pruned v1 is no longer downloadable");

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
    // 2g: LAYOUT_VERSION is part of the content key (handoff 2026-10-07 §3.1) — a layout change must not be served old PDFs from R2.
    // functions/_lib/pdf.js loads under plain node (only http/db/auth/time/views/usage, no Workers-only deps), so this is the real function.
    {
      const pdfLib = await import(new URL("../functions/_lib/pdf.js", import.meta.url));
      const { sha256Hex, stableStringify } = await import(new URL("../functions/_lib/http.js", import.meta.url));
      const bundle = {
        pcuRow: { code: pd.pcu.code, name: pd.pcu.name, print_name: pd.pcu.print_name },
        reqRow: { form_version_id: adm.form_version_id, submitted_at: pd.request.submitted_at },
        lines: Object.entries(pd.request.lines).map(([item_code, l]) => ({ item_code, op: l.op, pp: l.pp, stock: l.stock })),
        hidden: pd.hidden,
      };
      const ls = {};
      for (const l of bundle.lines) {
        if ((Number(l.op) || 0) + (Number(l.pp) || 0) > 0) ls[l.item_code] = [Number(l.op) || 0, Number(l.pp) || 0];
      }
      const fields = { v: adm.form_version_id ?? null, pn: pd.pcu.print_name || pd.pcu.name, hidden: [...pd.hidden].sort(), lines: ls, dd: null, sm: null };
      const keyFor = (lv) => sha256Hex(stableStringify(lv === undefined ? fields : { lv, ...fields }));
      const local = await pdfLib.contentKeyOf(bundle);
      eq(pdfLib.LAYOUT_VERSION, 3, "pdf.js exports LAYOUT_VERSION = 3 (brief 2h)");
      ok(local === (await keyFor(pdfLib.LAYOUT_VERSION)) && local !== (await keyFor(pdfLib.LAYOUT_VERSION + 1)) && local !== (await keyFor(undefined)),
        "contentKeyOf hashes lv: LAYOUT_VERSION (key changes with lv; differs from the pre-2g key without lv)");
      eq(dt.content_key, local, "server content key = contentKeyOf() under node (same LAYOUT_VERSION + same fields)");
      // 2h: print options are hashed as dd / sm (null when absent)
      const withOpts = await pdfLib.contentKeyOf(bundle, { doc_date: "2026-12-03", supply_month: CUR });
      ok(withOpts === (await sha256Hex(stableStringify({ lv: pdfLib.LAYOUT_VERSION, ...fields, dd: "2026-12-03", sm: CUR }))) && withOpts !== local,
        "contentKeyOf hashes dd / sm (2h print options) — differs from the no-option key");
      eq(await pdfLib.contentKeyOf(bundle, { doc_date: null, supply_month: null }), local, "contentKeyOf with null options = no-option key");
    }
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
    eq((await files("pdf/")).length, 3, "R2 holds 3 PDFs (PCU11 ×2, PCU13 ×1) after the pdf section");

    // --- 2h print options {doc_date?, supply_month?}: per print, part of the content key + print token, returned by printData.
    // PCU11 still holds 2 files in CUR (latest month keeps 2), so storing the option variant prunes its oldest → R2 still holds 3 for 2b-R.
    const DD = "2026-12-03", OPT = { doc_date: DD, supply_month: CUR }; // 2j: supply_month may only be the round month itself; doc_date any date
    const k0 = (await mustOk("devPrintToken", { pcu: P, month: CUR })).content_key; // no-option key, nothing stored
    eq((await mustOk("devPrintToken", { pcu: P, month: CUR, doc_date: "", supply_month: null })).content_key, k0, "options \"\" / null = no options (same key)");
    expectErr(await api("requestPdf", { month: CUR, doc_date: "2026-13-40" }, TP), "BAD_REQUEST", "requestPdf doc_date 2026-13-40");
    ok(/วันที่เอกสารไม่ถูกต้อง/.test((await api("requestPdf", { month: CUR, doc_date: "2026-02-30" }, TP)).error.message), "bad doc_date message (Thai)");
    expectErr(await api("requestPdf", { month: CUR, doc_date: 20261203 }, TP), "BAD_REQUEST", "requestPdf doc_date as a number");
    const smNext = await api("requestPdf", { month: CUR, supply_month: NEXT }, TP);
    expectErr(smNext, "BAD_REQUEST", "requestPdf supply_month = nextMonth(round) (2j: only the round month itself)");
    ok(smNext.error && /เดือนที่เบิกต้องเป็นเดือนของรอบ/.test(smNext.error.message), "supply_month message (Thai)");
    expectErr(await api("requestPdf", { month: CUR, supply_month: "2027-02" }, TP), "BAD_REQUEST", "requestPdf supply_month two months ahead");
    expectErr(await api("requestPdf", { month: CUR, supply_month: ["2026-12"] }, TP), "BAD_REQUEST", "requestPdf supply_month as an array");
    expectErr(await api("adminRequestPdf", { pcu: P, month: CUR, supply_month: PREV }, ADM2), "BAD_REQUEST", "adminRequestPdf supply_month = previous month");
    expectErr(await api("devPrintToken", { pcu: P, month: CUR, doc_date: "2026-11" }), "BAD_REQUEST", "devPrintToken doc_date not a date");
    eq((await files("pdf/")).length, 3, "rejected options store nothing");
    const o1 = await mustOk("requestPdf", { month: CUR, ...OPT }, TP);
    ok(o1.status === "ready" && /^[0-9a-f]{64}$/.test(o1.content_key) && o1.content_key !== k0, "requestPdf with {doc_date, supply_month} → ready, key ≠ the no-option key");
    eq([o1.url, o1.filename], [`/api/pdf/${idP}?k=${o1.content_key}`, expectedName], "option PDF: same url shape, filename unchanged (round month)");
    const curFiles = await files(`pdf/${P}/${CUR}/`);
    ok(curFiles.includes(`pdf/${P}/${CUR}/${o1.content_key}.pdf`) && curFiles.length === 2, "option variant stored as its own R2 object (latest month keeps 2)");
    const o2 = await mustOk("requestPdf", { month: CUR, ...OPT }, TP);
    eq(o2.content_key, o1.content_key, "same options again → same content_key (cache hit)");
    eq(await files(`pdf/${P}/${CUR}/`), curFiles, "same options again → no second R2 object");
    const oa = await mustOk("adminRequestPdf", { pcu: P, month: CUR, ...OPT }, ADM2);
    eq([oa.status, oa.content_key], ["ready", o1.content_key], "adminRequestPdf (admin) with the same options → same key");
    ok((await mustOk("requestPdf", { month: CUR, doc_date: DD }, TP)).content_key !== o1.content_key, "doc_date alone → yet another key");
    const ot = await mustOk("devPrintToken", { pcu: P, month: CUR, ...OPT });
    eq(ot.content_key, o1.content_key, "devPrintToken with options carries the option content key");
    const opd = await mustOk("printData", { k: ot.token });
    eq([opd.doc_date, opd.supply_month, opd.month], [DD, CUR, CUR], "printData returns doc_date + supply_month (= the round month) from the token");
    const npd = await mustOk("printData", { k: (await mustOk("devPrintToken", { pcu: P, month: CUR })).token });
    eq([npd.doc_date, npd.supply_month], [null, null], "printData with a token minted without options → both null");
    if (TOKEN_SECRET) {
      const mk = (o) => forgeToken({ t: "print", pcu: P, month: CUR, exp: Date.now() + 60000, ...o });
      expectErr(await api("printData", { k: mk({ ck: o1.content_key }) }), "CONFLICT", "printData: option key in a token without dd/sm");
      expectErr(await api("printData", { k: mk({ ck: k0, dd: DD, sm: CUR }) }), "CONFLICT", "printData: dd/sm in a token whose ck has none");
    } else { for (let i = 0; i < 2; i++) ok(true, "(skipped print-token forgery test: no TOKEN_SECRET readable)"); }
    eq((await files("pdf/")).length, 3, "R2 still holds 3 PDFs after the 2h option checks (PCU11 ×2 by the 2-version rule, PCU13 ×1)");
    ok((await api("adminUsersRemove", { email: DSPE }, ADM2)).ok, "temporary dispenser removed again");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("pdf retention + quota (2b-R)");
  {
    // latest month = currentRound = CUR (= CAL+1, 2j). Rule: latest keeps 2 versions, other months 1, months older than CUR−11 are deleted.
    const OLD12 = "2025-12", OLD11 = "2026-01"; // CUR−12 (outside the 12-month window) · CUR−11 (last month inside it)
    const files = async (prefix) => (await mustOk("devListFiles", { prefix })).keys.sort();
    const keyOf = (pcu, month, ck) => `pdf/${pcu}/${month}/${ck}.pdf`;
    const tr = (s) => `2026-11-14T09:00:${String(s).padStart(2, "0")}.000Z`;
    const pdfFiles = (p = {}) => mustOk("adminPdfFiles", p, ADM2);
    const T12 = (await mustOk("pcuLogin", { pcu: "PCU12", pin: "12345" })).token;
    const T14 = (await mustOk("pcuLogin", { pcu: "PCU14", pin: "12345" })).token;
    const T15 = (await mustOk("pcuLogin", { pcu: "PCU15", pin: "12345" })).token;
    const DSPR = "pdfr.dispenser@example.com";
    await mustOk("adminUsersAdd", { email: DSPR, role: "dispenser", units: ["LAB"] }, ADM2);
    const DSP3 = (await mustOk("adminLoginGoogle", { id_token: "dev:" + DSPR })).token;
    const send = (tok, month, op, s) => mustOk("saveLines", { month, lines: { [A.code]: { op, updated_at: tr(s) } }, send: true }, tok);
    const audits = async (action) => (await mustOk("adminAuditLog", { limit: 500 }, ADM2)).entries.filter((e) => e.action === action);

    // --- permissions
    expectErr(await api("adminPdfFiles", {}, DSP3), "FORBIDDEN", "adminPdfFiles with a dispenser token");
    expectErr(await api("adminPdfPrune", {}, DSP3), "FORBIDDEN", "adminPdfPrune with a dispenser token");
    expectErr(await api("adminPdfFiles", {}, T12), "FORBIDDEN", "adminPdfFiles with a PCU token");
    ok(!("r2_max_bytes" in (await mustOk("adminBootstrap", {}, DSP3)).config), "dispenser adminBootstrap.config has no R2 caps");

    // --- shape (state left by the pdf (2b) section: PCU11 v2 + hidden variant, PCU13 one file)
    const f0 = await pdfFiles();
    eq(f0.rule, { latest_month: CUR, keep_latest: 2, keep_other: 1, months: 12 }, "adminPdfFiles.rule");
    eq(f0.total_files, 3, "adminPdfFiles: 3 files after the pdf section (v1 of PCU11 was pruned)");
    ok(f0.files.every((f) => f.pcu && f.pcu_name && f.month === CUR && /^[0-9a-f]{64}$/.test(f.content_key) && f.created_at && f.bytes > 100
      && f.url === `/api/pdf/${f.pcu}_${f.month}?k=${f.content_key}`), "adminPdfFiles.files: {pcu, pcu_name, month, content_key, created_at, bytes, url}");
    ok(f0.files.every((f, i) => i === 0 || f0.files[i - 1].created_at >= f.created_at), "files are newest first");
    eq(f0.total_bytes, f0.files.reduce((a, f) => a + f.bytes, 0), "total_bytes = Σ files.bytes");
    const u0 = f0.usage;
    ok(u0.period === new Date().toISOString().slice(0, 7) && u0.class_a >= f0.total_files && u0.renders_today >= 1 && u0.renders_month >= u0.renders_today,
      `usage: UTC period, class_a ≥ stored PDFs (${u0.class_a}), renders_today ≥ 1 (${u0.renders_today})`);
    eq([u0.pdf_bytes, u0.bytes_total], [f0.total_bytes, f0.total_bytes + u0.backup_bytes], "usage.pdf_bytes / bytes_total = pdf + backup bytes");
    eq(u0.limits, { r2_max_bytes: 1000000000, r2_max_class_a: 100000, r2_max_class_b: 1000000 }, "usage.limits = defaults");
    eq(u0.free_tier, { bytes: 10000000000, class_a: 1000000, class_b: 10000000 }, "usage.free_tier");
    const cfg0 = (await mustOk("adminBootstrap", {}, ADM2)).config;
    eq([cfg0.r2_max_bytes, cfg0.r2_max_class_a, cfg0.r2_max_class_b], [1000000000, 100000, 1000000], "adminBootstrap.config carries the effective R2 caps");

    // --- latest month: v1, v2, v3 → v2 + v3 remain
    const PR = "PCU12";
    await send(T12, CUR, 1, 1);
    const v1 = await mustOk("requestPdf", { month: CUR }, T12);
    await send(T12, CUR, 2, 2);
    const v2 = await mustOk("requestPdf", { month: CUR }, T12);
    eq(await files(`pdf/${PR}/${CUR}/`), [keyOf(PR, CUR, v1.content_key), keyOf(PR, CUR, v2.content_key)].sort(), "latest month: two versions are both kept");
    await send(T12, CUR, 3, 3);
    const v3 = await mustOk("requestPdf", { month: CUR }, T12);
    eq(await files(`pdf/${PR}/${CUR}/`), [keyOf(PR, CUR, v2.content_key), keyOf(PR, CUR, v3.content_key)].sort(), "latest month: 3rd version → v1 pruned, v2 + v3 kept");
    eq((await pdfFiles({ pcu: PR })).files.map((f) => f.content_key), [v3.content_key, v2.content_key], "adminPdfFiles{pcu}: the 2 rows, newest first");
    eq((await get(v1.url, { authorization: "Bearer " + ADM2 })).status, 404, "GET the pruned v1 → 404");
    ok((await audits("pdf_prune")).some((e) => e.pcu === PR && e.actor === PR && /^1 files \/ \d+ bytes \/ pcu=PCU12 \/ reason=create$/.test(e.detail)), "audit pdf_prune (reason=create) by the PCU");

    // --- Class B: one per download
    const cb0 = (await pdfFiles()).usage.class_b;
    eq((await get(v2.url + "&token=" + encodeURIComponent(T12))).status, 200, "the previous version (v2) is still downloadable");
    eq((await pdfFiles()).usage.class_b, cb0 + 1, "usage.class_b grows by 1 per download");

    // --- other month: keep only the newest
    await send(T12, PREV, 1, 4);
    const w1 = await mustOk("requestPdf", { month: PREV }, T12);
    await send(T12, PREV, 2, 5);
    const w2 = await mustOk("requestPdf", { month: PREV }, T12);
    eq(await files(`pdf/${PR}/${PREV}/`), [keyOf(PR, PREV, w2.content_key)], "previous month: 2nd version replaces the 1st (keep 1)");
    eq((await get(w1.url, { authorization: "Bearer " + ADM2 })).status, 404, "the replaced version → 404");

    // --- 12-month window (back-dated requests via devSetRequestMonth)
    expectErr(await api("devSetRequestMonth", { pcu: "PCU14", month: PREV, new_month: OLD12 }), "NOT_FOUND", "devSetRequestMonth without a request");
    expectErr(await api("devSetRequestMonth", { pcu: "PCU14", month: PREV, new_month: "2025-13" }), "BAD_REQUEST", "devSetRequestMonth bad month");
    await send(T14, PREV, 1, 6);
    const x14 = await mustOk("requestPdf", { month: PREV }, T14);
    await send(T15, PREV, 1, 7);
    const x15 = await mustOk("requestPdf", { month: PREV }, T15);
    eq((await mustOk("devSetRequestMonth", { pcu: "PCU14", month: PREV, new_month: OLD12 })).id, `PCU14_${OLD12}`, "devSetRequestMonth moves the request (id + month)");
    await mustOk("devSetRequestMonth", { pcu: "PCU15", month: PREV, new_month: OLD11 });
    expectErr(await api("devSetRequestMonth", { pcu: "PCU12", month: CUR, new_month: PREV }), "CONFLICT", "devSetRequestMonth onto an existing request");
    const f1 = await pdfFiles();
    ok(f1.files.some((f) => f.pcu === "PCU14" && f.month === OLD12 && f.content_key === x14.content_key && f.url === `/api/pdf/PCU14_${OLD12}?k=${x14.content_key}`),
      "adminPdfFiles lists the back-dated file under its new month");
    const pz = await mustOk("adminPdfPrune", {}, ADM2);
    eq(pz.deleted, [keyOf("PCU14", PREV, x14.content_key)], "adminPdfPrune deletes only the file older than 12 months (by its stored r2_key)");
    eq(pz.bytes, f1.files.find((f) => f.pcu === "PCU14").bytes, "adminPdfPrune.bytes = size of the deleted file");
    const f2 = await pdfFiles();
    ok(!f2.files.some((f) => f.pcu === "PCU14") && f2.files.some((f) => f.pcu === "PCU15" && f.month === OLD11), "PCU14 gone from adminPdfFiles; CUR−11 (window edge) kept");
    eq(await files("pdf/PCU14/"), [], "R2 object of the old month deleted");
    ok((await audits("pdf_prune")).some((e) => e.actor === ADMIN_EMAIL && /pcu=all \/ reason=admin$/.test(e.detail)), "audit pdf_prune (reason=admin, pcu=all)");
    eq((await mustOk("adminPdfPrune", {}, ADM2)), { deleted: [], bytes: 0 }, "second adminPdfPrune deletes nothing");

    // --- nightly cron: prune all PCUs + backup bytes
    await mustOk("devSetRequestMonth", { pcu: "PCU15", month: OLD11, new_month: OLD12 });
    const cr = await fetch(BASE + "/api/cron/backup", { method: "POST", headers: { "x-backup-key": BACKUP_KEY, "x-dev-month": CAL } });
    const crj = await cr.json();
    ok(cr.status === 200 && crj.ok && Array.isArray(crj.data.pdf_pruned), "cron/backup result has pdf_pruned (array)");
    eq(crj.data.pdf_pruned, [keyOf("PCU15", PREV, x15.content_key)], "cron/backup pruned the file that fell out of the window");
    const lb = await mustOk("devListBackups");
    const u1 = (await pdfFiles()).usage;
    eq([u1.backup_files, u1.backup_bytes], [lb.keys.length, lb.keys.reduce((a, k) => a + lb.sizes[k], 0)], "usage.backup_files / backup_bytes = what the backup listed");
    eq(u1.bytes_total, u1.pdf_bytes + u1.backup_bytes, "usage.bytes_total = pdf_bytes + backup_bytes");

    // --- bytes cap → prune (reason=quota) → still over → PDF_QUOTA; cache hits are unaffected
    await mustOk("devSetRequestMonth", { pcu: "PCU13", month: CUR, new_month: "2025-01" }); // makes PCU13's file prunable
    eq((await mustOk("adminSetConfig", { key: "r2_max_bytes", value: 1 }, ADM2)).config.r2_max_bytes, 1, "adminSetConfig r2_max_bytes=1");
    eq((await mustOk("requestPdf", { month: CUR }, T12)).content_key, v3.content_key, "bytes cap reached: a cached PDF is still ready");
    await send(T12, CUR, 4, 8);
    const q1 = await api("requestPdf", { month: CUR }, T12);
    expectErr(q1, "PDF_QUOTA", "new content over the bytes cap");
    ok(q1.error && /ถึงเพดาน/.test(q1.error.message) && q1.error.detail && q1.error.usage && q1.error.usage.limits.r2_max_bytes === 1 && "class_a" in q1.error.usage && "class_b" in q1.error.usage && "bytes" in q1.error.usage,
      "PDF_QUOTA carries the Thai message + {detail, usage:{bytes,class_a,class_b,limits}}");
    ok((await audits("pdf_prune")).some((e) => /reason=quota$/.test(e.detail)), "bytes cap ran the prune first (audit reason=quota)");
    eq(await files("pdf/PCU13/"), [], "…which deleted the out-of-window file");
    eq(await files(`pdf/${PR}/${CUR}/`), [keyOf(PR, CUR, v2.content_key), keyOf(PR, CUR, v3.content_key)].sort(), "nothing stored while over the cap");
    eq((await mustOk("adminSetConfig", { key: "r2_max_bytes", value: null }, ADM2)).config.r2_max_bytes, 1000000000, "value:null restores the default");
    eq((await mustOk("adminBootstrap", {}, ADM2)).config.r2_max_bytes, 1000000000, "adminBootstrap.config.r2_max_bytes back to 1000000000");
    const v4 = await mustOk("requestPdf", { month: CUR }, T12);
    eq(await files(`pdf/${PR}/${CUR}/`), [keyOf(PR, CUR, v3.content_key), keyOf(PR, CUR, v4.content_key)].sort(), "after the reset the PDF is created (v3 + v4 kept)");

    // --- Class A cap
    await mustOk("adminSetConfig", { key: "r2_max_class_a", value: 1 }, ADM2);
    await send(T12, CUR, 5, 9);
    expectErr(await api("requestPdf", { month: CUR }, T12), "PDF_QUOTA", "Class A cap reached");
    await mustOk("adminSetConfig", { key: "r2_max_class_a", value: null }, ADM2);
    eq((await mustOk("requestPdf", { month: CUR }, T12)).status, "ready", "Class A cap reset → ready");
    expectErr(await api("adminSetConfig", { key: "r2_max_class_a", value: "x" }, ADM2), "BAD_REQUEST", "r2_max_class_a = \"x\"");
    expectErr(await api("adminSetConfig", { key: "r2_max_class_a", value: 0 }, ADM2), "BAD_REQUEST", "r2_max_class_a = 0");
    expectErr(await api("adminSetConfig", { key: "r2_max_bytes", value: 1.5 }, ADM2), "BAD_REQUEST", "r2_max_bytes = 1.5");

    // --- Class B cap → 429 before touching R2
    await mustOk("adminSetConfig", { key: "r2_max_class_b", value: 1 }, ADM2);
    const cb1 = (await pdfFiles()).usage.class_b;
    const g429 = await get(v4.url + "&token=" + encodeURIComponent(T12));
    const g429j = await g429.json();
    ok(g429.status === 429 && g429j.ok === false && g429j.error.code === "PDF_QUOTA" && g429j.error.usage, "Class B cap reached → HTTP 429 {ok:false, error:{code:PDF_QUOTA, usage}}");
    eq((await pdfFiles()).usage.class_b, cb1, "a refused download is not counted");
    await mustOk("adminSetConfig", { key: "r2_max_class_b", value: null }, ADM2);
    eq((await get(v4.url + "&token=" + encodeURIComponent(T12))).status, 200, "Class B cap reset → 200");

    ok((await api("adminUsersRemove", { email: DSPR }, ADM2)).ok, "temporary dispenser removed again");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("trial round (2j): trial_month + adminClearTrial{month}");
  {
    expectErr(await api("adminSetConfig", { key: "trial_month", value: "2026-13" }, ADM2), "BAD_REQUEST", "trial_month 2026-13");
    expectErr(await api("adminSetConfig", { key: "trial_month", value: 202611 }, ADM2), "BAD_REQUEST", "trial_month as a number");
    eq((await mustOk("adminSetConfig", { key: "trial_month", value: PREV }, ADM2)).config.trial_month, PREV, "adminSetConfig trial_month = previous round");
    ok((await mustOk("adminAuditLog", { limit: 5 }, ADM2)).entries.some((e) => e.action === "adminSetConfig" && e.detail === `trial_month="${PREV}"`), "audit adminSetConfig trial_month");
    const tpb = await mustOk("pcuBootstrap", {}, T1);
    eq([tpb.config.trial_month, tpb.rounds.map((r) => [r.month, r.trial])], [PREV, [[CUR, false], [PREV, true]]], "pcuBootstrap: config.trial_month + rounds[].trial");
    eq((await mustOk("pcuGetMonth", { month: PREV }, T1)).round.trial, true, "pcuGetMonth.round.trial");
    {
      const th = await api("pcuBootstrap", {}, T1, { month: "2026-12" }); // prev = 2026-12 → the trial round PREV (2026-11) moves into history
      const st = (await mustOk("adminGetRequest", { pcu: "PCU01", month: PREV }, ADM2)).request;
      const h0 = th.ok && th.data.history[0];
      eq(h0 && [h0.month, h0.trial, h0.status, h0.submitted_at], [PREV, true, st ? st.status : "not_started", st ? st.submitted_at : null], "history: trial round carries trial:true + its request status/submitted_at");
      ok(th.ok && th.data.history.slice(1).every((x) => x.trial === false), "history: only the trial month is flagged");
    }
    eq((await mustOk("adminRequests", {}, ADM2)).rounds.map((r) => [r.month, r.trial]), [[CUR, false], [PREV, true]], "adminRequests.rounds[].trial");
    const tab = await mustOk("adminBootstrap", {}, ADM2);
    ok(tab.config.trial_month === PREV && tab.rounds.every((r) => r.trial === (r.month === PREV)), "adminBootstrap: config.trial_month + every round's trial flag");
    await mustOk("adminUsersAdd", { email: "trial.disp@example.com", role: "dispenser", units: ["LAB"] }, ADM2);
    const DT = (await mustOk("adminLoginGoogle", { id_token: "dev:trial.disp@example.com" })).token;
    eq((await mustOk("adminBootstrap", {}, DT)).config.trial_month, PREV, "dispenser adminBootstrap.config carries trial_month");
    ok((await api("adminUsersRemove", { email: "trial.disp@example.com" }, ADM2)).ok, "temporary dispenser removed again");

    // clear only the trial round
    const reqN = async (m) => (await mustOk("adminRequests", { month: m }, ADM2)).requests.length;
    const pdfKeys = async () => (await mustOk("devListFiles", { prefix: "pdf/" })).keys.sort();
    const nCur = await reqN(CUR), nPrev = await reqN(PREV);
    const keys0 = await pdfKeys();
    const prevKeys = keys0.filter((k) => k.split("/")[2] === PREV);
    ok(nCur > 0 && nPrev > 0 && prevKeys.length > 0, `setup: requests in both rounds (${nCur}/${nPrev}) and a PDF in the trial round (${prevKeys.length})`);
    expectErr(await api("adminClearTrial", { confirm: "ล้างข้อมูล", month: "2026-13" }, ADM2), "BAD_REQUEST", "adminClearTrial{month} bad month");
    expectErr(await api("adminClearTrial", { confirm: "yes", month: PREV }, ADM2), "BAD_REQUEST", "adminClearTrial{month} still needs the confirmation word");
    const cm = await mustOk("adminClearTrial", { confirm: "ล้างข้อมูล", month: PREV }, ADM2);
    eq([cm.month, cm.deleted_requests, cm.deleted_pdf_files], [PREV, nPrev, prevKeys.length], "adminClearTrial{month}: response names the month, deletes exactly that round's requests + pdf rows");
    ok(cm.deleted_lines > 0 && "deleted_issue_status" in cm, "adminClearTrial{month}: lines deleted, issue_status reported");
    eq([await reqN(PREV), await reqN(CUR)], [0, nCur], "only the trial round is gone; the current round is untouched");
    eq(await pdfKeys(), keys0.filter((k) => !prevKeys.includes(k)), "R2: only the trial round's PDF objects removed");
    ok((await mustOk("adminAuditLog", { limit: 5 }, ADM2)).entries.some((e) => e.action === "adminClearTrial" && e.month === PREV && JSON.parse(e.detail).month === PREV), "audit adminClearTrial carries the month");
    eq((await mustOk("adminSetConfig", { key: "trial_month", value: null }, ADM2)).config.trial_month, null, "adminSetConfig trial_month = null clears it");
    eq((await mustOk("pcuBootstrap", {}, T1)).rounds.map((r) => r.trial), [false, false], "no trial flag once cleared");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("clear trial data");
  {
    expectErr(await api("adminClearTrial", { confirm: "yes" }, ADM2), "BAD_REQUEST", "clear trial needs the confirmation word");
    const hiddenBefore = (await mustOk("adminBootstrap", {}, ADM2)).hidden;
    const limitsBefore = Object.keys((await mustOk("adminBootstrap", {}, ADM2)).limits).length;
    const nCurAll = (await mustOk("adminRequests", { month: CUR }, ADM2)).requests.length;
    const nPdfAll = (await mustOk("adminPdfFiles", {}, ADM2)).total_files;
    const c = await mustOk("adminClearTrial", { confirm: "ล้างข้อมูล" }, ADM2);
    ok(c.deleted_requests >= nCurAll && nCurAll >= 5 && c.deleted_lines >= 5 && !("month" in c), `adminClearTrial (no month) deletes every round's requests + lines (${c.deleted_requests}/${c.deleted_lines})`);
    ok("deleted_issue_status" in c && "deleted_pdf_files" in c, "adminClearTrial reports issue_status / pdf_files");
    ok(c.deleted_pdf_files === nPdfAll && nPdfAll >= 3, `adminClearTrial deletes the pdf_files rows (${c.deleted_pdf_files})`);
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
    eq(Object.keys(m3.request.lines[LABI.code]).sort(), ["adj", "adj_reason", "calc_from", "op", "pp", "stock", "updated_at", "used"], "PCU request.lines unchanged (no issued fields, Q78; + 2o fields)");
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

    // ---- dispenser time window (2j: allowed while calMonth <= round month; round CUR = 2026-12 is dispensed in 2026-11 and 2026-12) ----
    const lab5 = { [LABI.code]: { issued_total: 5 } };
    const win = (action, params, tok, month) => api(action, { pcu: "PCU03", month: CUR, ...params }, tok, { month });
    expectErr(await win("issueLines", { lines: lab5 }, DL, "2027-01"), "FORBIDDEN", "dispenser in calendar 2027-01 (after the round month 2026-12) → FORBIDDEN");
    const wm = await win("issueLines", { lines: lab5 }, DL, "2027-01");
    ok(/หมดเวลา/.test(wm.error.message), "window error message says the time is over (หมดเวลา…)");
    expectErr(await win("issueDone", { unit: "LAB", done: 0 }, DL, "2027-01"), "FORBIDDEN", "undo outside the window → FORBIDDEN");
    expectErr(await win("issueAll", { unit: "LAB" }, DL, "2027-01"), "FORBIDDEN", "issueAll outside the window → FORBIDDEN");
    expectErr(await api("issueItem", { month: CUR, item_code: LABI.code, entries: { PCU03: { issued_total: 5 } } }, DL, { month: "2027-01" }), "FORBIDDEN", "issueItem outside the window → FORBIDDEN");
    ok((await win("issueLines", { lines: lab5 }, ADM2, "2027-01")).ok, "admin is not limited by the window");
    ok((await win("issueLines", { lines: lab5 }, DL, "2026-12")).ok, "dispenser still allowed in calendar 2026-12 (= the round month)");
    ok((await win("issueLines", { lines: lab5 }, DL, CAL)).ok, "dispenser allowed in calendar 2026-11 (the submission month)");
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
  section("stock mode (2o): used / adj / calc_from + server recalc");
  {
    const M0 = "2026-10", M1 = PREV, M2 = CUR; // M0 = the trial round (FY2569) — a valid baseline since 2026-10-20 (no special-casing)
    const H0 = { month: "2026-09" }; // calendar 2026-09 → round 2026-10 open for keying
    await mustOk("adminSetLimitMode", { mode: "off" }, ADM2);
    await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM2);
    await mustOk("adminSetConfig", { key: "trial_month", value: M0 }, ADM2);
    for (const m of [M0, M1, M2]) await mustOk("adminLockRound", { month: m, locked: 0 }, ADM2);
    const P = (await mustOk("pcuLogin", { pcu: "PCU06", pin: "12345" })).token;
    const Q = (await mustOk("pcuLogin", { pcu: "PCU09", pin: "12345" })).token;
    const A2 = seedItems.find((i) => i.step === "P1" && i.code !== A.code);
    let n = 0;
    const tsn = () => new Date(Date.parse("2026-11-21T00:00:00Z") + ++n * 1000).toISOString();
    const L = (o) => Object.fromEntries(Object.entries(o).map(([c, v]) => [c, { ...v, updated_at: tsn() }]));
    const sv = (tok, month, lines, extra = {}, opts = {}) => api("saveLines", { month, lines: L(lines), ...extra }, tok, opts);
    const svOk = async (tok, month, lines, extra, opts) => { const r = await sv(tok, month, lines, extra, opts); if (!r.ok) console.log("  saveLines error", JSON.stringify(r.error)); return r.ok ? r.data : null; };
    const adm = async (pcu, month) => (await mustOk("adminGetRequest", { pcu, month }, ADM2)).request;
    const pick = (l) => l && [l.stock, l.used, l.adj, l.adj_reason, l.calc_from];

    // ---- pcuSetStockMode ----
    eq((await mustOk("pcuBootstrap", {}, P)).pcu.stock_mode, "A", "pcuBootstrap.pcu.stock_mode defaults to A");
    eq(await mustOk("pcuSetStockMode", { mode: "B" }, P), { stock_mode: "B" }, "pcuSetStockMode B → {stock_mode:'B'}");
    eq((await mustOk("pcuBootstrap", {}, P)).pcu.stock_mode, "B", "pcuBootstrap.pcu.stock_mode = B after the switch");
    eq((await mustOk("pcuBootstrap", {}, Q)).pcu.stock_mode, "A", "another PCU stays A");
    expectErr(await api("pcuSetStockMode", { mode: "C" }, P), "BAD_REQUEST", "pcuSetStockMode mode C");
    expectErr(await api("pcuSetStockMode", {}, P), "BAD_REQUEST", "pcuSetStockMode without mode");
    expectErr(await api("pcuSetStockMode", { mode: "A" }, ADM2), "FORBIDDEN", "pcuSetStockMode with a staff token");
    ok((await mustOk("adminAuditLog", { limit: 10 }, ADM2)).entries.some((e) => e.action === "pcuSetStockMode" && e.pcu === "PCU06" && e.detail === "B"), "audit pcuSetStockMode (detail = mode)");

    // ---- validation ----
    for (const [f, v, why] of [["used", -1, "used −1"], ["used", 100000, "used 100000"], ["used", 1.5, "used 1.5"], ["adj", 100000, "adj 100000"], ["adj", -100000, "adj −100000"],
      ["adj", 2.5, "adj 2.5"], ["adj_reason", "lost", "adj_reason outside the enum"], ["calc_from", "op", "calc_from op"]]) {
      expectErr(await sv(P, M1, { [A.code]: { op: 1, [f]: v } }), "BAD_REQUEST", `saveLines rejects ${why}`);
    }
    ok(/ปรับยอด/.test((await sv(P, M1, { [A.code]: { adj: 100000 } })).error.message), "adj error message is Thai");

    // ---- no baseline: no previous-round request ----
    let r = await svOk(P, M1, { [A.code]: { stock: 5, op: 2, pp: 0, used: 3, calc_from: "used" } });
    eq(pick(r && r.request.lines[A.code]), [5, 3, null, null, null], "no baseline → calc_from forced null, stock / used kept as sent");
    eq(r && r.recalc, {}, "no baseline → recalc {}");
    // draft previous round is no baseline either
    await svOk(Q, M0, { [A.code]: { stock: 10, op: 1, pp: 0 } }, {}, H0);
    r = await svOk(Q, M1, { [A.code]: { stock: 3, op: 0, pp: 0, used: 1, calc_from: "used" } });
    eq([pick(r && r.request.lines[A.code]), (await mustOk("pcuGetMonth", { month: M1 }, Q)).prev_lines], [[3, 1, null, null, null], {}], "previous round only a draft → no baseline, prev_lines {}");

    // ---- baseline from the trial round 2026-10 ----
    r = await svOk(P, M0, { [A.code]: { stock: 10, op: 20, pp: 0 }, [B.code]: { stock: 4, op: 0, pp: 0 } }, { send: true }, H0);
    eq(r && r.status, "submitted", "setup: PCU06 sends the trial round 2026-10 (A stock 10 / ขอ 20 · B stock 4 / ขอ 0)");
    const pl1 = (await mustOk("pcuGetMonth", { month: M1 }, P)).prev_lines;
    eq([pl1[A.code], pl1[B.code]], [{ op: 20, pp: 0, stock: 10, received: 20, received_src: "requested" }, { op: 0, pp: 0, stock: 4, received: 0, received_src: "requested" }],
      "prev_lines of round 2026-11 = trial round: {op,pp,stock,received,received_src} incl. a stock-only row (op+pp 0)");
    eq((await mustOk("pcuBootstrap", {}, P)).byMonth[M1].prev_lines[A.code].stock, 10, "pcuBootstrap.byMonth[prev].prev_lines carries the same baseline");

    // ---- calc_from used / stock, negative, adj, received_extra ----
    r = await svOk(P, M1, { [A.code]: { stock: null, op: 2, pp: 0, used: 25, calc_from: "used" }, [B.code]: { stock: 1, op: 0, pp: 0, calc_from: "stock" } });
    eq([pick(r.request.lines[A.code]), pick(r.request.lines[B.code])], [[5, 25, null, null, "used"], [1, 3, null, null, "stock"]], "calc_from used → stock = 10+20−25 = 5 · calc_from stock → used = 4+0−1 = 3");
    eq(r.recalc, { [A.code]: { stock: 5, used: 25 }, [B.code]: { stock: 1, used: 3 } }, "response.recalc lists the lines the server computed");
    r = await svOk(P, M1, { [A.code]: { stock: 5, op: 2, pp: 0, used: 40, calc_from: "used" } });
    eq([pick(r.request.lines[A.code]), r.recalc[A.code]], [[null, 40, null, null, "used"], { stock: null, used: 40 }], "used > available → stock NULL (red), used kept");
    r = await svOk(P, M1, { [B.code]: { stock: 10, op: 0, pp: 0, calc_from: "stock" } });
    eq(pick(r.request.lines[B.code]), [10, null, null, null, "stock"], "stock > available → used NULL (yellow), stock kept");
    r = await svOk(P, M1, { [B.code]: { stock: 10, op: 0, pp: 0, used: 0, adj: 6, adj_reason: "received_extra", calc_from: "stock" } });
    eq([pick(r.request.lines[B.code]), r.recalc], [[10, 0, 6, "received_extra", "stock"], {}], "ใส่เป็นยอดรับเพิ่ม: adj += stock − available, used 0 → round-trips (used = 4+0+6−10 = 0, recalc {})");
    r = await svOk(P, M1, { [A.code]: { stock: 999, op: 2, pp: 0, used: 25, adj: -2, adj_reason: null } });
    eq([pick(r.request.lines[A.code]), r.recalc[A.code]], [[3, 25, -2, null, "used"], { stock: 3, used: 25 }], "adj −2 (reason null accepted) → stock 3; client stock 999 ignored; calc_from kept when omitted");
    r = await svOk(P, M1, { [A.code]: { stock: 3, op: 2, pp: 0, adj: 2, adj_reason: "recount" } });
    eq(pick(r.request.lines[A.code]), [7, 25, 2, "recount", "used"], "adj +2 → stock 7 (used kept when omitted)");
    r = await svOk(P, M1, { [A.code]: { stock: 7, op: 2, pp: 0, adj: null, adj_reason: null } });
    eq(pick(r.request.lines[A.code]), [5, 25, null, null, "used"], "adj cleared → stock 5");

    // ---- old client (no 2o fields) keeps the stored values; mode A line is never computed ----
    r = await svOk(P, M1, { [A.code]: { stock: 99, op: 2, pp: 0 } });
    eq([pick(r.request.lines[A.code]), r.recalc], [[5, 25, null, null, "used"], { [A.code]: { stock: 5, used: 25 } }], "old client {stock,op,pp}: used/calc_from kept → server recomputes stock 5");
    r = await svOk(P, M1, { [A2.code]: { stock: 7, op: 3, pp: 0, used: 2, adj: 1, adj_reason: "borrow_return", calc_from: null } });
    eq([pick(r.request.lines[A2.code]), r.recalc], [[7, 2, 1, "borrow_return", null], {}], "mode A (calc_from null): stock as typed, used / adj stored, nothing computed");
    r = await svOk(P, M1, { [A2.code]: { stock: 8, op: 3, pp: 0 } });
    eq(pick(r.request.lines[A2.code]), [8, 2, 1, "borrow_return", null], "old client on a mode-A line: used / adj / adj_reason survive");

    // ---- stock_required counts a computed stock; a NULL (negative) one is missing ----
    await mustOk("adminSetConfig", { key: "stock_required", value: 1 }, ADM2);
    const inc1 = await sv(P, M1, {}, { send: true });
    expectErr(inc1, "INCOMPLETE", "stock_required=1 → INCOMPLETE (other items empty)");
    ok(inc1.error && ![A.code, B.code, A2.code].some((c) => inc1.error.missing.includes(c)), "computed stock counts as filled (A, B, A2 not missing)");
    await svOk(P, M1, { [A.code]: { stock: 5, op: 2, pp: 0, used: 40 } });
    const inc2 = await sv(P, M1, {}, { send: true });
    ok(inc2.error && inc2.error.missing.includes(A.code), "computed stock NULL (negative) → item listed in INCOMPLETE.missing");
    await svOk(P, M1, { [A.code]: { stock: null, op: 2, pp: 0, used: 25 } });
    await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM2);
    eq((await svOk(P, M1, {}, { send: true })).status, "submitted", "setup: PCU06 sends round 2026-11");

    // ---- round 2026-12 on top of 2026-11 ----
    r = await svOk(P, M2, { [A.code]: { op: 1, pp: 0, used: 4, calc_from: "used" }, [A2.code]: { stock: 5, op: 0, pp: 0, calc_from: "stock" } }, { send: true });
    eq([pick(r.request.lines[A.code]), pick(r.request.lines[A2.code])], [[3, 4, null, null, "used"], [5, 6, null, null, "stock"]], "round 2026-12: A stock = 5+2−4 = 3 · A2 used = 8+3−5 = 6");
    const u2 = (await adm("PCU06", M2)).updated_at;
    eq((await adm("PCU06", M2)).edited_after_submit, false, "setup: round 2026-12 sent");

    // ---- saveLines on the previous round triggers the chain ----
    await svOk(P, M1, { [A.code]: { stock: null, op: 2, pp: 0, used: 23 } });
    let m2 = await adm("PCU06", M2);
    eq([m2.lines[A.code].stock, m2.lines[A2.code].used, m2.updated_at, m2.edited_after_submit], [5, 6, u2, false],
      "editing round 2026-11 (stock 7) recalcs 2026-12 A → 7+2−4 = 5; updated_at untouched, not edited_after_submit");

    // ---- issued figures: PCU view does not leak a unit that is not done; done → received = issued ----
    const k1 = (await mustOk("devPrintToken", { pcu: "PCU06", month: M2 })).content_key;
    await mustOk("issueLines", { pcu: "PCU06", month: M1, lines: { [A.code]: { issued_total: 1, reason: "out_of_stock" }, [A2.code]: { issued_total: 1, reason: "out_of_stock" } } }, ADM2);
    let pl2 = (await mustOk("pcuGetMonth", { month: M2 }, P)).prev_lines;
    eq([pl2[A.code], pl2[A2.code].received_src, (await adm("PCU06", M2)).lines[A.code].stock], [{ op: 2, pp: 0, stock: 7, received: 2, received_src: "requested" }, "requested", 5],
      "issued but unit not done → prev_lines received = ขอ (no leak) and no recalc");
    await mustOk("issueDone", { pcu: "PCU06", month: M1, unit: A.unit_of, done: 1 }, ADM2);
    pl2 = (await mustOk("pcuGetMonth", { month: M2 }, P)).prev_lines;
    eq(pl2[A.code], { op: 2, pp: 0, stock: 7, received: 1, received_src: "issued" }, "unit done → prev_lines received = issued_total (received_src issued)");
    m2 = await adm("PCU06", M2);
    eq([pick(m2.lines[A.code]), pick(m2.lines[A2.code]), m2.updated_at, m2.edited_after_submit], [[4, 4, null, null, "used"], [5, 4, null, null, "stock"], u2, false],
      "issueDone recalcs 2026-12 (calc_from used: stock 7+1−4 = 4 · calc_from stock: used 8+1−5 = 4), updated_at untouched");
    const k2 = (await mustOk("devPrintToken", { pcu: "PCU06", month: M2 })).content_key;
    eq(k1, k2, "PDF content_key unchanged by a stock recalc (the printed sheet shows only OP/PP)");

    // ---- cascade 2 rounds from the trial round, through a locked round ----
    await mustOk("adminLockRound", { month: M2, locked: 1 }, ADM2);
    const u1 = (await adm("PCU06", M1)).updated_at;
    await mustOk("issueLines", { pcu: "PCU06", month: M0, lines: { [A.code]: { issued_total: 15, reason: "out_of_stock" } } }, ADM2);
    eq((await adm("PCU06", M1)).lines[A.code].stock, 7, "issueLines on 2026-10 (unit not done) changes nothing downstream");
    await mustOk("issueDone", { pcu: "PCU06", month: M0, unit: A.unit_of, done: 1 }, ADM2);
    const m1 = await adm("PCU06", M1);
    m2 = await adm("PCU06", M2);
    eq([m1.lines[A.code].stock, m1.updated_at, pick(m2.lines[A.code]), m2.updated_at], [2, u1, [null, 4, null, null, "used"], u2],
      "cascade: 2026-10 done (received 15) → 2026-11 A stock 10+15−23 = 2 → 2026-12 A 2+1−4 < 0 → NULL, on a locked round, no updated_at bump");
    eq([m1.lines[B.code].used, m2.lines[A2.code].used], [0, 4], "lines whose baseline did not change stay as they were");
    const v2 = (await mustOk("pcuGetMonth", { month: M2 }, P)).request.lines[A.code];
    eq([v2.stock, v2.used, v2.calc_from], [null, 4, "used"], "PCU view of 2026-12: calc line with stock NULL + used (frontend shows the negative banner)");
    await mustOk("issueDone", { pcu: "PCU06", month: M0, unit: A.unit_of, done: 0 }, ADM2);
    eq([(await adm("PCU06", M1)).lines[A.code].stock, (await adm("PCU06", M2)).lines[A.code].stock], [7, 4], "undo done on 2026-10 → received back to ขอ 20 → chain recalculated again (7 · 4)");
    await mustOk("adminLockRound", { month: M2, locked: 0 }, ADM2);

    // ---- issueAll / issueItem trigger it too ----
    await mustOk("issueDone", { pcu: "PCU06", month: M0, unit: A.unit_of, done: 1 }, ADM2); // received 15 again → 2026-11 A = 2
    await mustOk("issueItem", { month: M1, item_code: A.code, entries: { PCU06: { issued_total: 2 } } }, ADM2);
    eq((await adm("PCU06", M2)).lines[A.code].stock, 0, "issueItem on 2026-11 (A issued 2, unit done) → 2026-12 A = 2+2−4 = 0");
    await mustOk("issueAll", { pcu: "PCU06", month: M0 }, ADM2);
    eq([(await adm("PCU06", M1)).lines[A.code].stock, (await adm("PCU06", M2)).lines[A.code].stock], [7, 5], "issueAll on 2026-10 (A issued 20) → 2026-11 A = 10+20−23 = 7 → 2026-12 A = 7+2−4 = 5");

    // ---- locked unit: the "same line" check includes the 2o fields ----
    ok((await sv(P, M1, { [A.code]: { stock: 0, op: 2, pp: 0, used: 23, calc_from: "used" } })).ok, "issued unit: re-sending the same line (stale stock, same used) is accepted");
    expectErr(await sv(P, M1, { [A.code]: { stock: 7, op: 2, pp: 0, used: 24 } }), "CONFLICT", "issued unit: changing used → CONFLICT");
    expectErr(await sv(P, M1, { [A.code]: { stock: 7, op: 2, pp: 0, adj: 1 } }), "CONFLICT", "issued unit: changing adj → CONFLICT");
    expectErr(await sv(P, M1, { [A.code]: { stock: 7, op: 2, pp: 0, calc_from: null } }), "CONFLICT", "issued unit: changing calc_from → CONFLICT");
    ok((await sv(P, M1, { [B.code]: { stock: 10, op: 0, pp: 0 } })).ok, "issued unit: old client re-sending B unchanged is accepted");

    // ---- admin view + Excel ----
    const am1 = await adm("PCU06", M1);
    eq(pick(am1.lines[A2.code]), [8, 2, 1, "borrow_return", null], "adminGetRequest lines carry used / adj / adj_reason / calc_from");
    const xr = await get(`/api/export.xlsx?month=${M1}`, { authorization: "Bearer " + ADM2 });
    const xs = XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await xr.arrayBuffer()), { type: "buffer" }).Sheets["รายบรรทัด"], { header: 1 });
    eq(xs[0].slice(19), ["ใช้ไป", "ปรับยอด", "เหตุผลปรับยอด"], "export line sheet: + ใช้ไป / ปรับยอด / เหตุผลปรับยอด (appended)");
    const xa = xs.find((x) => x[1] === "PCU06" && x[4] === A2.code), xa1 = xs.find((x) => x[1] === "PCU06" && x[4] === A.code);
    eq(xa && xa.slice(19, 22), [2, 1, "ยืม/คืน"], "export: A2 → used 2, adj 1, ยืม/คืน");
    ok(xa1 && xa1[19] === 23 && !xa1[20] && !xa1[21], "export: A → used 23, adj / reason blank");

    // ---- migration v4 idempotent ----
    expectErr(await api("devRerunMigration", { v: 1 }), "BAD_REQUEST", "devRerunMigration v 1 refused");
    eq((await mustOk("devRerunMigration", { v: 4 })).schema_version, 5, "re-running migrations v4+ on existing columns succeeds (duplicate column tolerated; v5 re-runs too)");
    eq([pick((await adm("PCU06", M2)).lines[A.code]), (await mustOk("pcuBootstrap", {}, P)).pcu.stock_mode], [[5, 4, null, null, "used"], "B"], "…and keeps the data (lines + stock_mode)");

    // ---- clean up ----
    await mustOk("pcuSetStockMode", { mode: "A" }, P);
    eq((await mustOk("pcuBootstrap", {}, P)).pcu.stock_mode, "A", "back to mode A");
    eq((await mustOk("pcuGetMonth", { month: M2 }, P)).request.lines[A.code].used, 4, "switching to A never deletes values");
    await mustOk("adminSetConfig", { key: "trial_month", value: null }, ADM2);
    ok((await mustOk("adminClearTrial", { confirm: "ล้างข้อมูล" }, ADM2)).deleted_requests >= 4, "stock-mode requests wiped again");
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
    eq(pb1.forms, {}, "2t: the submitted request follows the new version (re-bound) → forms {}");
    const pb2 = await mustOk("pcuBootstrap", {}, TF2);
    eq(pb2.forms, {}, "forms is {} when no shown request is bound to an older version (draft)");
    const gm1 = await mustOk("pcuGetMonth", { month: CUR }, TF1);
    ok(!("form" in gm1) && gm1.request.form_version_id === V1, "2t: pcuGetMonth: request re-bound to the latest version → no form key");
    ok(!("form" in (await mustOk("pcuGetMonth", { month: CUR }, TF2))), "pcuGetMonth omits form when it is the latest");
    const gr = await mustOk("adminGetRequest", { pcu: "PCU13", month: CUR }, ADM2);
    ok(gr.form.id === V1 && gr.form_version_id === V1 && findItem(gr.form.steps, renItem.code).name === oldName + " (ปรับชื่อ)", "2t: adminGetRequest: submitted request shows the new version (new wording)");
    eq(gr.request.lines[A.code].price_print, oldA, "2t: …the printed price of the sent line is unchanged");

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
    ok(pb3.forms[v3.form.id] && stepOf(pb3.forms[v3.form.id].steps, "S08"), "2t: …but a request with a quantity on the closed page gets the full latest form (forms[latest] keeps S08)");
    ok(!pb3.forms[V0] && !pb3.forms[V1], "2t: no older version in forms (requests re-bound to the latest)");
    const gm3 = await mustOk("pcuGetMonth", { month: CUR }, TF2);
    ok(gm3.form && gm3.form.id === v3.form.id && stepOf(gm3.form.steps, "S08"), "2t: pcuGetMonth: full latest form when a closed page carries a quantity");
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
  section("price effective from a round (2p)");
  {
    const cl = (o) => JSON.parse(JSON.stringify(o));
    const findIt = (steps, code) => steps.flatMap((s) => s.rows).find((r) => r.type === "item" && r.code === code);
    const r2 = (x) => Math.round(x * 100) / 100;
    const hrows = (h, code) => h.filter((x) => x.code === code).map((x) => [x.from_round, x.price]);
    await mustOk("adminSetLimitMode", { mode: "off" }, ADM2);
    await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM2);
    for (const m of [PREV, CUR, NEXT]) await mustOk("adminLockRound", { month: m, locked: 0 }, ADM2);
    const T7 = (await mustOk("pcuLogin", { pcu: "PCU07", pin: "54321" })).token; // PCU07's PIN was changed in the PIN tests
    const T8 = (await mustOk("pcuLogin", { pcu: "PCU08", pin: "12345" })).token;
    let n = 0;
    const tsn = () => new Date(Date.parse("2026-11-25T00:00:00Z") + ++n * 1000).toISOString();
    const L = (o) => Object.fromEntries(Object.entries(o).map(([c, v]) => [c, { stock: null, ...v, updated_at: tsn() }]));
    const send = async (tok, month, lines, opts) => {
      const r = await api("saveLines", { month, lines: L(lines), send: true }, tok, opts);
      if (!r.ok) console.log("  saveLines error", JSON.stringify(r.error));
      return r.ok ? r.data : null;
    };
    const AT_NEXT = { month: CUR }; // calendar = 2026-12 → the open round is NEXT (2027-01)
    const ADM_LATER = { month: NEXT }; // admin acting in calendar 2027-01 → currentRound 2027-02
    const line = async (pcu, month, code) => (await mustOk("adminGetRequest", { pcu, month }, ADM2)).request.lines[code];
    const pp2 = (l) => l && [l.price_snapshot, l.price_print];
    const bahtOf = async (pcu, month) => { const r = (await mustOk("adminRequests", { month }, ADM2)).requests.find((x) => x.pcu === pcu); return r ? r.progress.baht : null; };
    const baht = async () => { let s = 0; for (const m of [PREV, CUR, NEXT]) for (const r of (await mustOk("adminRequests", { month: m }, ADM2)).requests) s += r.progress.baht; return r2(s); };

    let F = (await mustOk("adminBootstrap", {}, ADM2)).form;
    const p4 = F.steps.find((s) => s.code === "P4").rows.filter((r) => r.type === "item" && r.active !== false);
    const X = p4[1].code, Y = p4[2].code, px0 = p4[1].price, py0 = p4[2].price;
    const px1 = r2(px0 + 10), px2 = r2(px0 + 3), py2 = r2(py0 + 2);
    const stepsWith = (code, price, base = F) => { const st = cl(base.steps); findIt(st, code).price = price; return st; };

    // ---- history seeded by the import + the 2d edit ----
    const g = await mustOk("adminFormGet", { id: F.id }, ADM2);
    ok(Array.isArray(g.price_history) && g.price_history.length >= seedItems.length, "adminFormGet.price_history: a row per item (seeded by the import)");
    eq(hrows(g.price_history, X), [[PREV, px0]], "price_history X = [[first round of FY2570, form price]]");
    const hx = g.price_history.find((h) => h.code === X);
    ok(hx.set_by === ADMIN_EMAIL && hx.set_at && "note" in hx, "price_history rows carry set_by / set_at / note");
    const ha = hrows(g.price_history, A.code);
    ok(ha.length === 2 && ha[0][0] === PREV && ha[0][1] === A.price && ha[1][0] === CUR, "2d price edit of A without price_from → a row from currentRound (2026-12); the import price stays from 2026-11");

    // ---- sent requests at the import price ----
    const s1 = [await send(T7, PREV, { [X]: { op: 2, pp: 1 }, [Y]: { op: 4, pp: 0 } }), await send(T7, CUR, { [X]: { op: 5, pp: 0 } }),
      await send(T8, PREV, { [X]: { op: 1, pp: 0 } }), await send(T8, NEXT, { [X]: { op: 7, pp: 0 } }, AT_NEXT)];
    ok(s1.every((r) => r && r.status === "submitted"), "setup: PCU07 sends 2026-11 (X 3, Y 4) + 2026-12 (X 5) · PCU08 sends 2026-11 (X 1) + 2027-01 (X 7)");
    eq([pp2(await line("PCU07", PREV, X)), pp2(await line("PCU07", CUR, X))], [[px0, px0], [px0, px0]], "send: price_snapshot = price_print = the round's price (RequestObj admin lines carry price_print)");
    ok(!("price_print" in (await mustOk("pcuGetMonth", { month: CUR }, T7)).request.lines[X]), "PCU view lines carry no price_print");

    // ---- validation ----
    const fsave = (price_from, extra = {}, opts) => api("adminFormSave", { base_version_id: F.id, form: { steps: stepsWith(X, px1) }, price_from, ...extra }, ADM2, opts);
    const r10 = await fsave({ [X]: "2026-10" });
    expectErr(r10, "BAD_REQUEST", "price_from 2026-10 (FY2569, before the first round of fy_current)");
    ok(r10.error && r10.error.message.includes("2570"), "price_from error names the fiscal year (Thai)");
    expectErr(await fsave({ [X]: "2027-11" }), "BAD_REQUEST", "price_from 2027-11 (after the last round of fy_current)");
    expectErr(await fsave({ [X]: "2026-13" }), "BAD_REQUEST", "price_from not a month");
    expectErr(await fsave([X]), "BAD_REQUEST", "price_from as an array");
    expectErr(await fsave({ "ZZ-01": CUR }), "BAD_REQUEST", "price_from for a code that is not in the form");
    eq((await mustOk("adminBootstrap", {}, ADM2)).form.id, F.id, "rejected saves created no version");
    const pvBad = async (changes, label, tok = ADM2) => expectErr(await api("adminPricePreview", { changes }, tok), tok === ADM2 ? "BAD_REQUEST" : "FORBIDDEN", label);
    await pvBad([], "adminPricePreview: empty changes");
    await pvBad([{ code: X, price: 1, from_round: "2026-10" }], "adminPricePreview: from_round outside fy_current");
    await pvBad([{ code: "ZZ-01", price: 1, from_round: PREV }], "adminPricePreview: unknown code");
    await pvBad([{ code: X, price: -1, from_round: PREV }], "adminPricePreview: negative price");
    await pvBad([{ code: X, price: 1, from_round: PREV }, { code: X, price: 2, from_round: PREV }], "adminPricePreview: duplicate code");
    const DSPP = (await mustOk("adminLoginGoogle", { id_token: "dev:disp.form@example.com" })).token;
    await pvBad([{ code: X, price: 1, from_round: PREV }], "adminPricePreview: dispenser", DSPP);
    await pvBad([{ code: X, price: 1, from_round: PREV }], "adminPricePreview: PCU token", T7);

    // ---- a future price (from 2027-01) ----
    const pv0 = await mustOk("adminPricePreview", { changes: [{ code: X, price: px1, from_round: NEXT }] }, ADM2);
    eq([pv0.requests, pv0.months, pv0.delta_baht, pv0.per_code.map((x) => [x.code, x.n_lines, x.delta, x.backdate])], [0, [], 0, [[X, 0, 0, false]]], "preview of a future price: nothing sent is touched");
    const fut = await mustOk("adminFormSave", { base_version_id: F.id, note: "ราคา X ใหม่ตั้งแต่ ม.ค. 70", form: { steps: stepsWith(X, px1) }, price_from: { [X]: NEXT, [Y]: PREV } }, ADM2);
    ok(fut.saved && findIt(fut.form.steps, X).price === px1, "future price saved: the form holds the latest price");
    eq(fut.price_backdate, [], "future price: price_backdate []");
    eq(hrows(fut.price_history, X), [[PREV, px0], [NEXT, px1]], "adminFormSave.price_history: X old from 2026-11 · new from 2027-01");
    eq(hrows(fut.price_history, Y), [[PREV, py0]], "price_from of an item whose price did not change is ignored");
    F = fut.form;
    const aud0 = (await mustOk("adminAuditLog", { limit: 10 }, ADM2)).entries.find((e) => e.action === "form_save");
    eq(aud0 && JSON.parse(aud0.detail).price_from, { [X]: NEXT }, "audit form_save detail carries price_from of the changed prices");
    eq([pp2(await line("PCU07", CUR, X)), pp2(await line("PCU08", NEXT, X))], [[px0, px0], [px0, px0]], "future price: sent lines are not rewritten (only a back-date rewrites)");
    const pbF = await mustOk("pcuBootstrap", {}, T7);
    eq([pbF.prices[CUR][X], pbF.prices[PREV][X], findIt(pbF.form.steps, X).price], [px0, px0, px1], "pcuBootstrap.prices: both shown rounds price X at the old price (form = latest price)");
    ok(!(Y in pbF.prices[CUR]) && !(Y in pbF.prices[PREV]), "pcuBootstrap.prices lists only prices that differ from the form");
    const abF = await mustOk("adminBootstrap", {}, ADM2);
    ok(fyRoundMonths(2570).every((m) => abF.prices[m] && typeof abF.prices[m] === "object"), "adminBootstrap.prices has a key for every round of fy_current");
    eq([abF.prices[PREV][X], abF.prices[CUR][X], X in abF.prices[NEXT], X in abF.prices["2027-05"]], [px0, px0, false, false], "adminBootstrap.prices: X at the old price before 2027-01, nothing listed from 2027-01 (= form)");
    const gmP = (await mustOk("pcuGetMonth", { month: PREV }, T7)).prices;
    ok(gmP && gmP[PREV] && gmP[PREV][X] === px0 && gmP[PREV][A.code] === A.price, "pcuGetMonth.prices[month]: X old price · A at its 2026-11 (import) price");

    // the current round re-sent after the future price → still the round's price; its PDF prints that price
    ok(!!(await send(T7, CUR, { [X]: { op: 6, pp: 0 } })), "PCU07 re-sends 2026-12 (X 6) after the future price");
    eq(pp2(await line("PCU07", CUR, X)), [px0, px0], "re-send in the current round: the round's price, not the form's latest");
    const pdC = await mustOk("printData", { k: (await mustOk("devPrintToken", { pcu: "PCU07", month: CUR })).token });
    eq([pdC.form.id, findIt(pdC.form.steps, X).price, findIt(pdC.form.steps, Y).price], [F.id, px0, py0], "printData: the latest form (X = new price) printed with the round's prices");
    // the future round prints the new price once sent in it
    const k8a = (await mustOk("devPrintToken", { pcu: "PCU08", month: NEXT })).content_key;
    ok(!!(await send(T8, NEXT, { [X]: { op: 7, pp: 0 } }, AT_NEXT)), "PCU08 re-sends 2027-01");
    eq(pp2(await line("PCU08", NEXT, X)), [px1, px1], "send in 2027-01: the new price (price_snapshot + price_print)");
    const tk8 = await mustOk("devPrintToken", { pcu: "PCU08", month: NEXT });
    ok(tk8.content_key !== k8a && findIt((await mustOk("printData", { k: tk8.token })).form.steps, X).price === px1, "PDF of 2027-01: new content_key, printed at the new price");

    // ---- back-date (admin in calendar 2027-01 → currentRound 2027-02): X from 2026-12 (stops at its 2027-01 row) + Y from 2026-11 (to the end of the fy) ----
    const chg = [{ code: X, price: px2, from_round: CUR }, { code: Y, price: py2, from_round: PREV }];
    const pv = await api("adminPricePreview", { changes: chg }, ADM2, ADM_LATER);
    ok(pv.ok, "adminPricePreview (admin)");
    const P = pv.data;
    const expX = r2(6 * (px2 - px0)), expY = r2(4 * (py2 - py0));
    eq([P.requests, P.months, P.delta_baht], [2, [PREV, CUR], r2(expX + expY)], `preview: 2 requests, rounds 2026-11 … 2026-12, Δ ${r2(expX + expY)} บาท`);
    eq(P.per_code.map((x) => [x.code, x.n_lines, x.delta, x.old, x.to_round, x.backdate]), [[X, 1, expX, px0, NEXT, true], [Y, 1, expY, py0, "2027-11", true]],
      "preview per_code: X only in [2026-12, 2027-01) · Y in [2026-11, end of fy)");
    const before = await baht();
    const k7 = (await mustOk("devPrintToken", { pcu: "PCU07", month: CUR })).content_key;
    const bd = await api("adminFormSave", { base_version_id: F.id, note: "แก้ราคาย้อนหลัง", form: { steps: stepsWith(Y, py2, { steps: stepsWith(X, px2) }) }, price_from: { [X]: CUR, [Y]: PREV } }, ADM2, ADM_LATER);
    ok(bd.ok && bd.data.saved, "back-dated adminFormSave");
    eq(bd.data.price_backdate.map((x) => [x.code, x.old, x.new, x.from_round, x.to_round, x.requests, x.lines, x.delta]), [[X, px0, px2, CUR, NEXT, 1, 1, expX], [Y, py0, py2, PREV, "2027-11", 1, 1, expY]],
      "adminFormSave.price_backdate = the preview");
    eq(r2((await baht()) - before), P.delta_baht, "preview = real effect: Σ adminRequests.progress.baht moved by exactly delta_baht");
    eq([pp2(await line("PCU07", CUR, X)), pp2(await line("PCU07", PREV, Y))], [[px2, px0], [py2, py0]], "back-date: price_snapshot rewritten, price_print untouched");
    eq([pp2(await line("PCU07", PREV, X)), pp2(await line("PCU08", PREV, X)), pp2(await line("PCU08", NEXT, X))], [[px0, px0], [px0, px0], [px1, px1]],
      "back-date only inside its range: 2026-11 (before) and 2027-01 (next row) untouched");
    const auds = (await mustOk("adminAuditLog", { limit: 10 }, ADM2)).entries.filter((e) => e.action === "price_backdate");
    const ax = auds.find((e) => JSON.parse(e.detail).code === X), axd = ax ? JSON.parse(ax.detail) : {};
    ok(auds.length === 2 && ax.month === CUR && axd.old === px0 && axd.new === px2 && axd.from_round === CUR && axd.requests === 1 && axd.delta === expX,
      "audit price_backdate per code (detail: code, old → new, from_round, n ใบ, Δ บาท)");
    F = bd.data.form;
    eq(hrows(bd.data.price_history, X), [[PREV, px0], [CUR, px2], [NEXT, px1]], "price_history X after the back-date");
    eq(hrows(bd.data.price_history, Y), [[PREV, py2]], "Y back-dated to the first round replaces its first-round row");
    expectErr(await api("adminFormSave", { base_version_id: F.id, form: { steps: stepsWith(X, r2(px2 + 1)) }, price_from: { [X]: "2026-10" } }, ADM2, ADM_LATER), "BAD_REQUEST", "back-date before fy_current refused");

    // ---- PDF after the back-date: old price (price_print) · re-send → new price + new key ----
    const tk7 = await mustOk("devPrintToken", { pcu: "PCU07", month: CUR });
    ok(tk7.content_key !== k7, "2t: the form save re-binds the request → new content_key (the sheet is re-rendered with the latest form; prices stay price_print)");
    eq(findIt((await mustOk("printData", { k: tk7.token })).form.steps, X).price, px0, "printData after the back-date: the price as sent (price_print)");
    ok(!!(await send(T7, CUR, { [X]: { op: 6, pp: 0 } })), "PCU07 re-sends 2026-12 after the back-date");
    eq(pp2(await line("PCU07", CUR, X)), [px2, px2], "re-send: price_snapshot = price_print = the back-dated price");
    const tk7b = await mustOk("devPrintToken", { pcu: "PCU07", month: CUR });
    ok(tk7b.content_key !== tk7.content_key && findIt((await mustOk("printData", { k: tk7b.token })).form.steps, X).price === px2, "re-send → new content_key, printed at the new price");

    // ---- an old round re-sent uses ITS round's price ----
    ok(!!(await send(T8, PREV, { [X]: { op: 1, pp: 0 } })), "PCU08 re-sends 2026-11");
    eq([pp2(await line("PCU08", PREV, X)), findIt(F.steps, X).price], [[px0, px0], px2], "re-sent 2026-11: X at the 2026-11 price although the form holds the latest");

    // ---- drafts / export / dispenser screen use the round's price ----
    ok((await api("saveLines", { month: NEXT, lines: L({ [X]: { op: 2, pp: 0 } }) }, T7, AT_NEXT)).ok, "PCU07 drafts 2027-01 (X 2, not sent)");
    eq(await bahtOf("PCU07", NEXT), r2(2 * px1), "adminRequests.progress.baht of a draft = qty × the round's price (2027-01 → new), not the form's latest");
    const xr = await get(`/api/export.xlsx?month=${NEXT}`, { authorization: "Bearer " + ADM2 });
    const xs = XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await xr.arrayBuffer()), { type: "buffer" }).Sheets["รายบรรทัด"], { header: 1 });
    const x7 = xs.find((x) => x[1] === "PCU07" && x[4] === X), x8 = xs.find((x) => x[1] === "PCU08" && x[4] === X);
    eq([x7 && x7[7], x7 && x7[11], x8 && x8[7]], [px1, r2(2 * px1), px1], "export: a draft line is priced by its round (2027-01), a sent line by price_snapshot");
    const xr2 = await get(`/api/export.xlsx?month=${PREV}`, { authorization: "Bearer " + ADM2 });
    const xs2 = XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await xr2.arrayBuffer()), { type: "buffer" }).Sheets["รายบรรทัด"], { header: 1 });
    eq([(xs2.find((x) => x[1] === "PCU07" && x[4] === X) || [])[7], (xs2.find((x) => x[1] === "PCU07" && x[4] === Y) || [])[7]], [px0, py2], "export 2026-11: X at 2026-11 price, Y at the back-dated price");
    eq((await mustOk("adminItemIssue", { month: PREV, item_code: X }, ADM2)).item.price, px0, "adminItemIssue.item.price = the round's price");

    // ---- from_round = the open round (currentRound 2026-12): already-sent requests of that round are re-priced too (orchestrator decision) ----
    const px3 = r2(px2 + 1);
    const pvc = await mustOk("adminPricePreview", { changes: [{ code: X, price: px3, from_round: CUR }] }, ADM2);
    eq([pvc.requests, pvc.months, pvc.per_code[0].backdate, pvc.delta_baht], [1, [CUR, CUR], true, r2(6 * (px3 - px2))], "preview from the open round: the sent 2026-12 request counts");
    const sc = await mustOk("adminFormSave", { base_version_id: F.id, form: { steps: stepsWith(X, px3) }, price_from: { [X]: CUR } }, ADM2);
    F = sc.form;
    eq(pp2(await line("PCU07", CUR, X)), [px3, px2], "price from the open round: price_snapshot of the sent 2026-12 line rewritten, price_print kept");

    // ---- migration v5: idempotent + backfill ----
    const hBefore = (await mustOk("adminFormGet", { id: F.id }, ADM2)).price_history;
    const l7 = [pp2(await line("PCU07", PREV, Y)), pp2(await line("PCU07", CUR, X))];
    eq((await mustOk("devRerunMigration", { v: 5 })).schema_version, 5, "re-running migration v5 succeeds (duplicate column tolerated)");
    eq([(await mustOk("adminFormGet", { id: F.id }, ADM2)).price_history, [pp2(await line("PCU07", PREV, Y)), pp2(await line("PCU07", CUR, X))]], [hBefore, l7],
      "…and changes nothing (price_history, price_snapshot / price_print)");
    eq((await mustOk("devRerunMigration", { v: 5, clear_price_history: true })).schema_version, 5, "migration v5 on an empty price_history (first deploy)");
    const hb = (await mustOk("adminFormGet", { id: F.id }, ADM2)).price_history;
    const itemsF = F.steps.flatMap((s) => s.rows.filter((r) => r.type === "item"));
    eq(hb.map((h) => [h.code, h.from_round, h.price].join("|")).sort(), itemsF.map((r) => [r.code, PREV, r.price].join("|")).sort(),
      "backfill: one row per item of the latest form of the fy, from its first round (2026-11), at the form price");
    ok(hb.every((h) => h.set_by === "migration v5"), "backfill rows: set_by 'migration v5'");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("open fiscal year (2e)");
  {
    const cl = (o) => JSON.parse(JSON.stringify(o));
    const OLD = 2570, NEW = 2571;
    const r2 = (x) => Math.round((x + 1e-9) * 100) / 100;
    const itemsOfSteps = (steps) => steps.flatMap((s) => s.rows.filter((r) => r.type === "item").map((r) => ({ ...r, step: s.code })));
    const sortedObj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortedObj(o[k])])) : o);
    const byCode = (arr) => [...arr].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const monthsOld = fyRoundMonths(OLD); // 2j: the 12 rounds of FY2570 = 2026-11 … 2027-10 (actual_prev columns = their submission months)
    await mustOk("adminSetLimitMode", { mode: "off" }, ADM2);
    await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM2);

    // ---- controlled requests of FY2570 (PCU11 / PCU12), sent in several months via X-Dev-Month ----
    const T11 = (await mustOk("pcuLogin", { pcu: "PCU11", pin: "12345" })).token;
    const T12 = (await mustOk("pcuLogin", { pcu: "PCU12", pin: "12345" })).token;
    const C = seedItems.find((i) => i.step === "P3");
    // keyed as the open round: calendar month = the month before the round (X-Dev-Month)
    const send = async (tok, month, lines) => api("saveLines", { month, lines, send: true }, tok, { month: shiftMonth(month, -1) });
    const sent = [ // round months → actual_prev column (= submission month): 2026-11 → Oct · 2027-09 → Aug · 2027-10 → Sep · 2027-01 → Dec · 2027-04 → Mar
      [T11, "2026-11", { [A.code]: { op: 3, pp: 1 } }],
      [T11, "2027-09", { [A.code]: { op: 10, pp: 0 } }],
      [T11, "2027-10", { [A.code]: { op: 2, pp: 4 } }],
      [T12, "2027-01", { [LABI.code]: { op: 3, pp: 0 }, [A.code]: { op: 7, pp: 1 } }],
      [T12, "2027-04", { [A.code]: { op: 7, pp: 1 }, [C.code]: { op: 5, pp: 0 } }],
    ];
    let allSent = true;
    for (const [tok, month, lines] of sent) { const r = await send(tok, month, lines); if (!r.ok || r.data.status !== "submitted") { allSent = false; console.log(JSON.stringify(r)); } }
    ok(allSent, "setup: 5 requests sent in 5 different rounds of FY2570 (PCU11 ×3, PCU12 ×2)");
    // 2j boundary: the round 2026-10 is FY2569 → never part of FY2570's history
    const T10 = (await mustOk("pcuLogin", { pcu: "PCU10", pin: "12345" })).token;
    const s10 = await api("saveLines", { month: "2026-10", lines: { [A.code]: { op: 9, pp: 9 } }, send: true }, T10, { month: "2026-10" });
    ok(s10.ok && s10.data.status === "submitted", "setup: PCU10 sends the FY2569 round 2026-10 (must not be counted for FY2570)");

    // snapshot of what the DB holds for FY2570 (independent of the code under test): every submitted/issued line with qty
    const reqCells = {};
    let nReq = 0; const reqMonths = new Set();
    for (const m of monthsOld) {
      const lst = (await mustOk("adminRequests", { month: m }, ADM2)).requests.filter((r) => ["submitted", "issued"].includes(r.status));
      for (const r of lst) {
        nReq++; reqMonths.add(m);
        const g = await mustOk("adminGetRequest", { pcu: r.pcu, month: m }, ADM2);
        for (const [code, l] of Object.entries(g.request.lines)) if ((l.op || 0) + (l.pp || 0) > 0) reqCells[`${r.pcu}|${code}|${shiftMonth(m, -1)}`] = [l.op || 0, l.pp || 0]; // keyed by the Excel column
      }
    }
    ok(nReq >= 7 && Object.keys(reqCells).length >= 9, `setup: snapshot of FY2570 has ${nReq} sent requests / ${Object.keys(reqCells).length} cells (incl. PCU13/PCU14 of the 2d tests)`);
    const tm = {}; // "pcu|code" -> 12 monthly totals
    for (const [k, [op, pp]] of Object.entries(reqCells)) { const [pcu, code, m] = k.split("|"); (tm[pcu + "|" + code] ||= new Array(12).fill(0))[fyExcelMonths(OLD).indexOf(m)] += op + pp; }
    ok(!Object.keys(reqCells).some((k) => k.startsWith("PCU10|")), "setup: the FY2569 round 2026-10 is not in the FY2570 snapshot");
    const expStats = {};
    for (const [k, arr] of Object.entries(tm)) {
      const s = [...arr].sort((a, b) => a - b), ann = arr.reduce((a, b) => a + b, 0);
      if (ann > 0) expStats[k] = [r2(pct(s, 0.5)), r2(pct(s, 0.9)), ann];
    }

    // ---- build seed71 from the LATEST FY2570 form in the DB ----
    const boot0 = await mustOk("adminBootstrap", {}, ADM2);
    const oldForm = boot0.form;
    const versions0 = boot0.form_versions.length;
    const oldItems = itemsOfSteps(oldForm.steps);
    const oldPrice = Object.fromEntries(oldItems.map((i) => [i.code, i.price]));
    const p3 = oldForm.steps.find((s) => s.code === "P3").rows.filter((r) => r.type === "item" && r.active !== false);
    const REM = p3[p3.length - 1];
    ok(REM.code !== C.code, "setup: removed item differs from the item with requests");
    const NEWC = "P3-901";
    const renameItem = oldForm.steps.find((s) => s.code === "P4").rows.find((r) => r.type === "item");
    const form71 = { fy: NEW, note: "ฟอร์มปี 71 (ทดสอบ)", steps: cl(oldForm.steps) };
    for (const s of form71.steps) {
      s.rows = s.rows.filter((r) => !(r.type === "item" && r.code === REM.code));
      for (const r of s.rows) if (r.type === "item") { r.price = Math.round(r.price * 1.1 * 100) / 100; if (r.code === renameItem.code) r.name += " (ชื่อใหม่ 71)"; }
    }
    form71.steps.find((s) => s.code === "P3").rows.push({ type: "item", code: NEWC, name: "รายการใหม่ปี 71", unit: "กล่อง", price: 25, active: true });
    const price71 = { ...oldPrice, ...Object.fromEntries(itemsOfSteps(form71.steps).map((i) => [i.code, i.price])) }; // removed item keeps its old price
    const plans71 = {};
    for (const [pcu, m] of Object.entries(boot0.plans)) for (const [code, v] of Object.entries(m)) (plans71[pcu] ||= {})[code] = [v[0] * 2, v[1] * 2];
    (plans71.PCU11 ||= {})[A.code] = [6, 2];      // p90 5.8 → limit [6, 8, stat70]
    plans71.PCU11[CSI.code] = [12, 0];            // no requests → plan-only [2, 12, plan71]
    plans71.PCU11[NEWC] = [4, 1];                 // new item, plan-only [1, 5, plan71]
    delete (plans71.PCU12 ||= {})[LABI.code];     // 1 month only (p90 0) and no plan → skipped
    delete plans71.PCU12[A.code];                 // p90 7.2 and no plan → [8, null, stat70]
    const seed71 = {
      format: "pcu-supply-import/1", fy: NEW, generated_at: "2027-09-01T00:00:00Z", generated_by: "tools/test_api.mjs (2e)",
      pcus: seed.pcus, form: form71, plans: { [NEW]: plans71 },
      config: { fy_current: NEW, limit_mode: "enforce", budget_op: 1 },
    };

    // ---- expected numbers (computed here, independently of the backend) ----
    const sumBaht = (m) => {
      let op = 0, pp = 0;
      for (const [code, v] of Object.entries(m)) { op += v[0] * (price71[code] || 0); pp += v[1] * (price71[code] || 0); }
      return { op: Math.round(op * 100) / 100, pp: Math.round(pp * 100) / 100, total: Math.round((op + pp) * 100) / 100 };
    };
    const expPlanPcu = Object.fromEntries(Object.entries(plans71).map(([pcu, m]) => [pcu, sumBaht(m)]));
    const expLimits = {}; // pcu -> code -> [lm, ly, source]
    const pairs = new Set([...Object.entries(plans71).flatMap(([p, m]) => Object.keys(m).map((c) => p + "|" + c)), ...Object.keys(expStats)]);
    let nLim = 0;
    for (const k of pairs) {
      const [pcu, code] = k.split("|");
      const d = defaultLimitRule(plans71[pcu] && plans71[pcu][code], expStats[k], NEW);
      if (d.lm === null && d.ly === null) continue;
      (expLimits[pcu] ||= {})[code] = [d.lm, d.ly, d.source]; nLim++;
    }
    const expPriceChanged = byCode(oldItems.filter((i) => i.code !== REM.code).map((i) => ({ code: i.code, old: i.price, new: Math.round(i.price * 1.1 * 100) / 100 })).filter((x) => x.old !== x.new));
    const oldActive = oldItems.filter((i) => i.active !== false).length;

    // ---- preview: same fiscal year ----
    const pv0 = await mustOk("adminImportPreview", { seed }, ADM2);
    eq([pv0.fy, pv0.fy_current, pv0.mode], [OLD, OLD, "same_fy"], "preview of the FY2570 seed → mode same_fy");
    eq(pv0.summary.form.version_action, "override", "preview same_fy: version_action override (the seed form differs from the latest, editor-edited version)");
    eq(pv0.summary.rollover, null, "preview same_fy: rollover null");
    ok(pv0.summary.limits.in_file > 0 && pv0.summary.limits.will_default === 0, "preview same_fy: limits in_file > 0, will_default 0");
    let seedTotal = 0;
    for (const [pcu, m] of Object.entries(seed.plans[String(OLD)])) for (const [code, v] of Object.entries(m)) seedTotal += (v[0] + v[1]) * ((seedItems.find((x) => x.code === code) || {}).price || 0);
    ok(near(pv0.summary.plans.network.total, seedTotal, 0.02), "preview same_fy: network plan total = Σ qty × price of the file");
    eq(pv0.summary.pcus.new, [], "preview same_fy: no new pcus");
    expectErr(await api("adminImportApply", { seed, confirm: "เปิดปีงบ 2570" }, ADM2), "CONFLICT", "apply of the current fiscal year's file → CONFLICT (use adminImportSeed)");

    // ---- preview: rollover ----
    const pv = await mustOk("adminImportPreview", { seed: seed71 }, ADM2);
    eq([pv.fy, pv.fy_current, pv.mode], [NEW, OLD, "rollover"], "preview seed71 → mode rollover");
    const S = pv.summary;
    eq(S.form.version_action, "insert", "preview rollover: version_action insert");
    eq(S.form.items_new, [NEWC], "preview: items_new = the one new item");
    eq(S.form.items_closed, [REM.code], "preview: items_closed = the item dropped from the file");
    eq(S.form.items_reopened, [], "preview: no reopened items");
    eq(byCode(S.form.price_changed), expPriceChanged, `preview: price_changed (${expPriceChanged.length} items × 1.1) with old/new`);
    eq(S.form.renamed, 1, "preview: renamed = 1");
    eq([S.form.steps, S.form.active_items], [oldForm.steps.length, oldActive], "preview: steps / active_items of the form that will be stored");
    eq(S.pcus.known.length, 15, "preview: 15 known pcus");
    eq([S.pcus.new, S.pcus.missing_in_file], [[], []], "preview: no new / missing pcus");
    eq(Object.keys(S.plans.per_pcu).sort(), Object.keys(plans71).sort(), "preview: per_pcu has every pcu of the plan");
    ok(Object.entries(expPlanPcu).every(([pcu, e]) => ["op", "pp", "total"].every((f) => near(S.plans.per_pcu[pcu] && S.plans.per_pcu[pcu][f], e[f], 0.011))), "preview: per_pcu op/pp/total = Σ qty × price (2 decimals)");
    const netExp = Object.values(expPlanPcu).reduce((a, e) => a + e.total, 0);
    ok(near(S.plans.network.total, netExp, 0.1) && near(S.plans.network.op + S.plans.network.pp, S.plans.network.total, 0.011), "preview: network total = Σ per pcu, op + pp = total");
    eq(S.plans.rows, Object.values(plans71).reduce((a, m) => a + Object.keys(m).length, 0), "preview: plans.rows");
    ok(S.limits.will_default > 0 && S.limits.in_file === 0, "preview: limits.will_default > 0 (the file has no limits)");
    eq(S.limits.will_default, nLim, "preview: will_default = pairs of plans ∪ stats minus the skipped ones");
    eq(S.config.will_set, ["fy_current"], "preview: config.will_set = fy_current only (the other keys already have values)");
    eq([S.rollover.from_fy, S.rollover.requests_counted, S.rollover.actual_months], [OLD, nReq, [...reqMonths].sort().map((m) => shiftMonth(m, -1))], "preview: rollover from_fy / requests_counted / actual_months (Excel column labels = submission months)");
    eq(S.rollover.source, { actual_prev: "db", prices_prev: "db", stats: "db" }, "preview: old-fy numbers come from the DB");
    ok(Array.isArray(pv.warnings) && pv.warnings.some((w) => /ปิดแล้ว/.test(w)), "preview: warning that dropped items are kept closed");

    // nothing written by a preview
    const boot1 = await mustOk("adminBootstrap", {}, ADM2);
    eq([boot1.form_versions.length, boot1.config.fy_current, Object.keys(boot1.prev), boot1.plan_totals.fy], [versions0, OLD, ["2569"], OLD], "preview wrote nothing (versions, fy_current, prev, plan_totals unchanged)");

    // preview variants
    const pvPcu = await mustOk("adminImportPreview", { seed: { ...seed71, pcus: [...seed71.pcus.filter((x) => x.code !== "PCU15"), { code: "PCU99", name: "ใหม่" }] } }, ADM2);
    eq([pvPcu.summary.pcus.new, pvPcu.summary.pcus.missing_in_file], [["PCU99"], ["PCU15"]], "preview: new / missing_in_file pcus");
    eq((await mustOk("pcuList")).pcus.length, 15, "preview created no pcu");
    const pvLim = await mustOk("adminImportPreview", { seed: { ...seed71, limits: { [NEW]: { PCU11: { [A.code]: [3, 9, "import"] } } }, stats: { [OLD]: { PCU11: { [A.code]: [1, 2, 3] } } } } }, ADM2);
    eq([pvLim.summary.limits, pvLim.summary.rollover.source.stats], [{ in_file: 1, will_default: 0 }, "file"], "preview: limits/stats supplied by the file are used as they are");

    // preview / apply errors (all BAD_REQUEST, nothing written)
    const bp = async (label, mut, needle, action = "adminImportPreview") => {
      const s = cl(seed71); mut(s);
      const r = await api(action, { seed: s, confirm: "เปิดปีงบ 2571" }, ADM2);
      expectErr(r, "BAD_REQUEST", label);
      if (needle) ok(r.error && r.error.message.includes(needle), `${label}: message names "${needle}"`);
    };
    const s12 = cl(seed71); s12.fy = 2572; s12.form.fy = 2572; s12.plans = { 2572: plans71 };
    expectErr(await api("adminImportPreview", { seed: s12 }, ADM2), "BAD_REQUEST", "preview: fy 2572 (two years ahead) → BAD_REQUEST");
    const s09 = cl(seed71); s09.fy = 2569; s09.form.fy = 2569; s09.plans = { 2569: plans71 };
    expectErr(await api("adminImportPreview", { seed: s09 }, ADM2), "BAD_REQUEST", "preview: fy 2569 (older) → BAD_REQUEST");
    expectErr(await api("adminImportPreview", { seed: { ...seed71, format: "x" } }, ADM2), "BAD_REQUEST", "preview: wrong format");
    await bp("preview: no form", (s) => { delete s.form; });
    await bp("preview: no plans for the fy", (s) => { s.plans = {}; });
    await bp("preview: form.fy ≠ fy", (s) => { s.form.fy = 2570; });
    await bp("preview: duplicate item code", (s) => { s.form.steps[0].rows.push({ ...s.form.steps[0].rows.find((r) => r.type === "item") }); }, A.code);
    await bp("preview: 25 active items on a page", (s) => { const x = s.form.steps.find((y) => y.code === "P2"); for (let i = 0; i < 25; i++) x.rows.push({ type: "item", code: `P2-8${String(i).padStart(2, "0")}`, name: "x", unit: "อัน", price: 1, active: true }); }, "P2");
    await bp("preview: 11 active pages", (s) => { for (let i = 1; i <= 11; i++) s.form.steps.push({ code: `T${i}`, title: "t", rows: [] }); }, "10");
    await bp("preview: negative price", (s) => { s.form.steps[0].rows.find((r) => r.type === "item").price = -1; });
    await bp("preview: closing a page that still has active items", (s) => { s.form.steps.find((y) => y.code === "CS").active = false; }, "CS");
    await bp("apply: invalid form is rejected before anything is written", (s) => { s.form.steps[0].rows.push({ ...s.form.steps[0].rows.find((r) => r.type === "item") }); }, A.code, "adminImportApply");

    // ---- apply: guards ----
    expectErr(await api("adminImportApply", { seed: seed71, confirm: "เปิดปีงบ 2570" }, ADM2), "BAD_REQUEST", "apply with a wrong confirm word → BAD_REQUEST");
    expectErr(await api("adminImportApply", { seed: seed71 }, ADM2), "BAD_REQUEST", "apply without confirm → BAD_REQUEST");
    expectErr(await api("adminImportApply", { seed: s12, confirm: "เปิดปีงบ 2572" }, ADM2), "BAD_REQUEST", "apply of fy 2572 (not fy_current + 1) → BAD_REQUEST");
    const boot2 = await mustOk("adminBootstrap", {}, ADM2);
    eq([boot2.form_versions.length, boot2.config.fy_current, Object.keys(boot2.prev)], [versions0, OLD, ["2569"]], "rejected applies wrote nothing");

    // ---- permissions ----
    await mustOk("adminUsersAdd", { email: "disp.fy@example.com", role: "dispenser", units: ["LAB"] }, ADM2);
    const DSPF = (await mustOk("adminLoginGoogle", { id_token: "dev:disp.fy@example.com" })).token;
    expectErr(await api("adminImportPreview", { seed: seed71 }, DSPF), "FORBIDDEN", "dispenser: adminImportPreview");
    expectErr(await api("adminImportApply", { seed: seed71, confirm: "เปิดปีงบ 2571" }, DSPF), "FORBIDDEN", "dispenser: adminImportApply");
    expectErr(await api("adminImportApply", { seed: seed71, confirm: "เปิดปีงบ 2571" }, T11), "FORBIDDEN", "PCU token: adminImportApply");
    expectErr(await api("adminImportPreview", { seed: seed71 }), "AUTH_REQUIRED", "adminImportPreview without a token");
    ok((await api("adminUsersRemove", { email: "disp.fy@example.com" }, ADM2)).ok, "temporary dispenser removed again");
    const reqBefore = (await mustOk("adminGetRequest", { pcu: "PCU13", month: CUR }, ADM2));

    // ---- apply ----
    const ap = await mustOk("adminImportApply", { seed: seed71, confirm: "เปิดปีงบ 2571" }, ADM2, "apply seed71");
    eq(ap.fy_current, NEW, "apply → fy_current 2571");
    eq(ap.imported.form, "inserted", "apply: imported.form = inserted (version 1 of the new fy)");
    ok(ap.imported.config_set.includes("fy_current") && ap.imported.plans > 0 && ap.imported.stats > 0 && ap.imported.actual_rows > 0, "apply: imported plans / stats / actual_prev / fy_current");
    ok(ap.rollover.form_version_id > boot0.form.id, "apply: rollover.form_version_id is a new row");
    eq(ap.rollover.actual_rows, Object.keys(reqCells).length, "apply: rollover.actual_rows = cells with qty in FY2570");
    eq(ap.rollover.stats_rows, Object.keys(expStats).length, "apply: rollover.stats_rows");
    eq(ap.rollover.prices_rows, Object.keys(oldPrice).length, "apply: rollover.prices_rows = items of the old form");
    eq(ap.rollover.limits_rows, nLim, "apply: rollover.limits_rows = default limits generated");
    const ph71 = (await mustOk("adminFormGet", { id: ap.rollover.form_version_id }, ADM2)).price_history; // 2p
    const nf71 = itemsOfSteps((await mustOk("adminFormGet", { id: ap.rollover.form_version_id }, ADM2)).form.steps);
    eq(ph71.map((h) => [h.code, h.from_round, h.price].join("|")).sort(), nf71.map((i) => [i.code, fyRoundMonths(NEW)[0], i.price].join("|")).sort(),
      "apply: price_history of FY2571 seeded — every item of the new form from 2027-11 at its new price (2p)");

    const boot3 = await mustOk("adminBootstrap", {}, ADM2);
    eq(boot3.config.fy_current, NEW, "adminBootstrap: config.fy_current 2571");
    eq(boot3.config.limit_mode, "off", "apply left limit_mode (existing value) alone");
    eq([boot3.form.fy, boot3.form.id, boot3.form_versions.length], [NEW, ap.rollover.form_version_id, versions0 + 1], "adminBootstrap.form = the new FY2571 version (the only one of its fy)");
    eq(boot3.form_versions[0].created_by, ADMIN_EMAIL, "new form version: created_by = the actor");
    eq(boot3.form.note, "ฟอร์มปี 71 (ทดสอบ)", "new form version: note from the file");
    const nf = itemsOfSteps(boot3.form.steps);
    eq(new Set(oldItems.map((i) => i.code)).size, nf.filter((i) => i.code !== NEWC).length, "new form: carries every old item code (+ the new one)");
    eq(nf.find((i) => i.code === REM.code).active, false, "new form: the item removed from the file is kept with active:false");
    eq(nf.find((i) => i.code === REM.code).step, "P3", "…in its original page");
    ok(nf.find((i) => i.code === NEWC) && nf.find((i) => i.code === NEWC).active === true && nf.find((i) => i.code === NEWC).price === 25, "new form: the new item is active at its price");
    eq(nf.find((i) => i.code === A.code).price, Math.round(oldPrice[A.code] * 1.1 * 100) / 100, "new form: prices are the file's (× 1.1)");
    eq(nf.map((i) => i.seq), nf.map((_, i) => i + 1), "new form: canonical numbering (item.seq running over the form)");
    ok(boot3.plan_totals.fy === NEW && near(boot3.plan_totals.total, netExp, 0.1) && near(boot3.plan_totals.total, S.plans.network.total, 0.011), "plan_totals: fy 2571 and equal to the preview's network total");
    eq(Object.keys(boot3.plans.PCU11).length, Object.keys(plans71.PCU11).length, "plans[2571] imported (PCU11)");

    // actual_prev[2570] = the requests
    const pv70 = boot3.prev[String(OLD)];
    ok(pv70 && pv70.months.length === 12 && pv70.months[0] === "2026-10" && pv70.months[11] === "2027-09", "adminBootstrap.prev has FY2570 (12 months, 2026-10 … 2027-09)");
    const got = {};
    for (const [pcu, items] of Object.entries(pv70.actual)) for (const [code, e] of Object.entries(items)) e.op.forEach((v, i) => { if (v > 0 || e.pp[i] > 0) got[`${pcu}|${code}|${pv70.months[i]}`] = [v, e.pp[i]]; });
    eq(sortedObj(got), sortedObj(reqCells), "actual_prev[2570] = every sent line with qty (all cells equal)");
    eq(pv70.actual.PCU11[A.code].op, [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 2], "spot-check PCU11/A op by month");
    eq(pv70.actual.PCU11[A.code].pp, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4], "spot-check PCU11/A pp by month");
    eq([pv70.actual.PCU12[LABI.code].op[2], pv70.actual.PCU12[C.code].op[5]], [3, 5], "spot-check PCU12 LAB item (Dec) and P3 item (Mar)");
    eq(sortedObj(pv70.prices), sortedObj(oldPrice), "prices_prev[2570] = the prices of the old form (every item)");

    // stats[2570]
    const st = boot3.stats;
    eq(st.fy, OLD, "adminBootstrap.stats.fy = 2570 (basis of the new year)");
    eq(st.data.PCU11[A.code], [0, 5.8, 20], "stats PCU11/A: months [4,0,…,10,6] → median 0, p90 5.8 (numpy linear), annual 20");
    eq(st.data.PCU12[A.code], [0, 7.2, 16], "stats PCU12/A: months [0,0,8,0,0,8,0…] → p90 7.2");
    eq(st.data.PCU12[LABI.code], [0, 0, 3], "stats PCU12 LAB item: a single month → [0, 0, 3]");
    const gotStats = {};
    for (const [pcu, items] of Object.entries(st.data)) for (const [code, v] of Object.entries(items)) gotStats[`${pcu}|${code}`] = v;
    eq(Object.keys(gotStats).sort(), Object.keys(expStats).sort(), "stats: one row per (pcu,item) with annual > 0 — no others");
    ok(Object.entries(expStats).every(([k, e]) => e.every((x, i) => near(gotStats[k] && gotStats[k][i], x, 0.0051))), "stats: median / p90 / annual equal the independent computation for every pair");

    // limits[2571]
    eq(boot3.limits.PCU11[A.code] && [boot3.limits.PCU11[A.code].limit_month, boot3.limits.PCU11[A.code].limit_year, boot3.limits.PCU11[A.code].source], [6, 8, "stat70"], "limits PCU11/A: ceil(p90 5.8) = 6, year 6+2 = 8, source stat70");
    const lc = boot3.limits.PCU11[CSI.code];
    eq([lc.limit_month, lc.limit_year, lc.source], [2, 12, "plan71"], "limits PCU11/CS item: plan only → ceil(12/12×2) = 2, year 12, source plan71");
    const ln = boot3.limits.PCU11[NEWC];
    eq([ln.limit_month, ln.limit_year, ln.source], [1, 5, "plan71"], "limits PCU11/new item: plan [4,1] → year 5, month ceil(5/12×2) = 1");
    ok(!(boot3.limits.PCU12 && boot3.limits.PCU12[LABI.code]), "limits PCU12/LAB item: no plan and p90 0 → no row (skipped)");
    const l12 = boot3.limits.PCU12[A.code];
    eq([l12.limit_month, l12.limit_year, l12.source], [8, null, "stat70"], "limits PCU12/A: p90 7.2, no plan → [8, null, stat70]");
    const gotLim = {};
    for (const [pcu, items] of Object.entries(boot3.limits)) for (const [code, v] of Object.entries(items)) (gotLim[pcu] ||= {})[code] = [v.limit_month, v.limit_year, v.source];
    eq(sortedObj(gotLim), sortedObj(expLimits), "limits[2571]: every row equals the rule (plans ∪ stats) — nothing more, nothing less");
    ok(Object.values(boot3.limits).every((o) => Object.values(o).every((v) => v.updated_by === "import")), "limits[2571]: written as import rows (admin edits would stay)");

    // the new year in the PCU app
    const pbNew = await api("pcuBootstrap", {}, T11, { month: "2027-10" });
    ok(pbNew.ok && pbNew.data.form.id === ap.rollover.form_version_id && pbNew.data.form.fy === NEW, "X-Dev-Month 2027-10: pcuBootstrap.form = the FY2571 version");
    eq(pbNew.data.config.fy_current, NEW, "pcuBootstrap.config.fy_current 2571");
    {
      const hist = pbNew.data.history;
      eq([hist.length, hist[0].month, hist.at(-1).month], [11, "2027-09", "2026-11"], "X-Dev-Month 2027-10 (cur 2027-11, F 2571): history = 2027-09 … 2026-11");
      ok(hist.every((h) => h.fy === OLD) && !hist.some((h) => h.month === "2026-10"), "history: all FY2570, never reaches back to 2026-10 (FY2569 = F-2)");
      const hm = Object.fromEntries(hist.map((h) => [h.month, h]));
      ok(["2026-11", "2027-09"].every((m) => ["submitted", "issued"].includes(hm[m].status) && hm[m].submitted_at) && hm["2027-01"].status === "not_started", "history (PCU11): rounds it sent → submitted + submitted_at, others not_started");
      eq([pbNew.data.next_round.month, pbNew.data.next_round.opens_on, pbNew.data.next_round.fy], ["2027-12", "2027-11-01", NEW], "X-Dev-Month 2027-10: next_round 2027-12 opens 2027-11-01");
    }
    eq([pbNew.data.limits[A.code], pbNew.data.plans[A.code]], [[6, 8], [6, 2]], "pcuBootstrap (2027-10): limits / plans of PCU11 are 2571's");
    const stepsNew = pbNew.data.form.steps;
    ok(!itemsOfSteps(stepsNew).some((i) => i.code === REM.code && i.active !== false) && itemsOfSteps(stepsNew).some((i) => i.code === NEWC), "PCU form for 2027-10: new item present, dropped item not active");
    const pbOldMonth = await mustOk("pcuBootstrap", {}, T11); // current round 2026-12 is still FY2570, but drafts follow fy_current's latest form
    const v11 = (await mustOk("adminGetRequest", { pcu: "PCU11", month: "2026-11" }, ADM2)).form_version_id;
    ok(pbOldMonth.form.fy === NEW && v11 === boot0.form.id && pbOldMonth.forms[v11] && pbOldMonth.forms[v11].fy === OLD, "pcuBootstrap: a request sent before the rollover keeps its FY2570 form (forms[old id]); drafts use the new latest form");
    const reqAfter = await mustOk("adminGetRequest", { pcu: "PCU13", month: CUR }, ADM2);
    eq([reqAfter.request, reqAfter.form_version_id, reqAfter.form.fy], [reqBefore.request, reqBefore.form_version_id, OLD], "old requests untouched (same lines, still bound to the old form version)");

    // idempotence / re-run / audit
    expectErr(await api("adminImportApply", { seed: seed71, confirm: "เปิดปีงบ 2571" }, ADM2), "CONFLICT", "re-apply the same file → CONFLICT (ปีงบเปิดแล้ว)");
    eq((await mustOk("adminBootstrap", {}, ADM2)).form_versions.length, versions0 + 1, "re-apply created no extra form version");
    const pvAfter = await api("adminImportPreview", { seed: seed71 }, ADM2);
    ok(pvAfter.ok && pvAfter.data.mode === "same_fy" && pvAfter.data.summary.form.version_action === "same", "preview of the same file after opening → same_fy, form same (file + the same closed carry-over)");
    const aud = (await mustOk("adminAuditLog", { limit: 30 }, ADM2)).entries.find((e) => e.action === "fy_open");
    ok(aud && aud.actor === ADMIN_EMAIL, "audit has fy_open");
    const ad = aud ? JSON.parse(aud.detail) : {};
    ok(ad.fy === NEW && ad.from_fy === OLD && ad.actual_rows === ap.rollover.actual_rows && ad.limits_rows === nLim, "audit fy_open detail = JSON {fy, from_fy, counts}");
    const ex = (await mustOk("adminExportSeed", {}, ADM2)).seed;
    ok(ex.fy === NEW && ex.config.fy_current === NEW && ex.form.fy === NEW && ex.actual_prev[String(OLD)] && ex.stats[String(OLD)] && ex.limits[String(NEW)], "adminExportSeed after the rollover: fy 2571 with the FY2570 history");
    const rei = await mustOk("adminImportSeed", { seed: ex }, ADM2);
    ok(rei.imported.form === "same" && rei.imported.limits_inserted === 0 && rei.imported.config_set.length === 0, "export → import is a no-op for the new year (form same, limits_inserted 0)");

    // ---- 2j formForFy: a round whose fy has no form uses fy_current's latest form — not simply the newest version ----
    await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: OLD }, set_current_fy: true }, ADM2); // fy_current back to 2570 (newest form is 2571's)
    const T08 = (await mustOk("pcuLogin", { pcu: "PCU08", pin: "12345" })).token;
    const s08 = await api("saveLines", { month: "2026-10", lines: { [A.code]: { op: 1 } }, send: true }, T08, { month: "2026-10" });
    ok(s08.ok && s08.data.request.form_version_id === boot0.form.id, `formForFy: round 2026-10 (fy 2569, no form) binds fy_current 2570's latest form (${boot0.form.id}), not the newest (${ap.rollover.form_version_id})`);
    const g08 = await mustOk("adminGetRequest", { pcu: "PCU08", month: "2025-11" }, ADM2); // no request, fy 2569 → resolved form
    eq([g08.request, g08.form_version_id], [null, boot0.form.id], "adminGetRequest of an empty FY2569 round resolves the fy_current form (formForFy)");
    eq((await mustOk("adminGetRequest", { pcu: "PCU08", month: "2027-11" }, ADM2)).form_version_id, ap.rollover.form_version_id, "a FY2571 round resolves its own fy's form");
    await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: NEW }, set_current_fy: true }, ADM2);
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // Runs LAST: it adds a 16th PCU, and many earlier cases count 15.
  section("PCU manage (2n): adminPcuAdd / adminPcuEdit + group ทดลอง");
  {
    const DSPN = "pcu.manage.disp@example.com";
    await mustOk("adminUsersAdd", { email: DSPN, role: "dispenser", units: ["LAB"] }, ADM2);
    const DN = (await mustOk("adminLoginGoogle", { id_token: "dev:" + DSPN })).token;
    expectErr(await api("adminPcuAdd", { code: "PCU00", name: "x" }, DN), "FORBIDDEN", "dispenser adminPcuAdd");
    expectErr(await api("adminPcuEdit", { code: "PCU01", name: "x" }, DN), "FORBIDDEN", "dispenser adminPcuEdit");
    ok((await api("adminUsersRemove", { email: DSPN }, ADM2)).ok, "temporary dispenser removed again");
    const T1x = (await mustOk("pcuLogin", { pcu: "PCU01", pin: "12345" })).token;
    expectErr(await api("adminPcuAdd", { code: "PCU00", name: "x" }, T1x), "FORBIDDEN", "PCU token adminPcuAdd");

    // validation
    expectErr(await api("adminPcuAdd", { code: "P", name: "x" }, ADM2), "BAD_REQUEST", "add: code too short (P)");
    expectErr(await api("adminPcuAdd", { code: "ab c", name: "x" }, ADM2), "BAD_REQUEST", "add: code with a space (ab c)");
    expectErr(await api("adminPcuAdd", { code: "PCU0000000000", name: "x" }, ADM2), "BAD_REQUEST", "add: code longer than 12");
    expectErr(await api("adminPcuAdd", { code: "PCU00", name: "x", group: "xx" }, ADM2), "BAD_REQUEST", "add: unknown group");
    expectErr(await api("adminPcuAdd", { code: "PCU00", name: "   " }, ADM2), "BAD_REQUEST", "add: blank name");
    expectErr(await api("adminPcuAdd", { code: "PCU00", name: "ก".repeat(61) }, ADM2), "BAD_REQUEST", "add: name > 60 chars");
    expectErr(await api("adminPcuAdd", { code: "PCU00", name: "x", print_name: "ก".repeat(81) }, ADM2), "BAD_REQUEST", "add: print_name > 80 chars");
    expectErr(await api("adminPcuAdd", { code: "PCU01", name: "ซ้ำ" }, ADM2), "CONFLICT", "add: duplicate PCU01");
    expectErr(await api("adminPcuAdd", { code: "pcu01", name: "ซ้ำ" }, ADM2), "CONFLICT", "add: duplicate after uppercasing (pcu01)");
    eq((await mustOk("pcuList")).pcus.length, 15, "rejected adds changed nothing (15 PCUs)");

    // add PCU00 (lower-case code → stored upper-case, print_name blank → = name)
    const ad = await mustOk("adminPcuAdd", { code: " pcu00 ", name: " ทดลอง ", print_name: "", group: "ทดลอง" }, ADM2);
    eq(ad.pcu, { code: "PCU00", name: "ทดลอง", print_name: "ทดลอง", group: "ทดลอง" }, "adminPcuAdd → {pcu} (code upper-cased, trimmed, print_name = name)");
    const pl = (await mustOk("pcuList")).pcus;
    const p00 = pl.find((x) => x.code === "PCU00");
    eq(pl.length, 16, "pcuList has 16 PCUs");
    eq(p00, { code: "PCU00", name: "ทดลอง", print_name: "ทดลอง", group: "ทดลอง" }, "pcuList: PCU00 group ทดลอง, print_name = name");
    const l00 = await mustOk("pcuLogin", { pcu: "PCU00", pin: "12345" });
    ok(l00.token && l00.pcu.code === "PCU00" && l00.bootstrap.pcu.pin_custom === false, "pcuLogin PCU00 with the default PIN 12345 (pin_custom false)");
    const b00 = (await mustOk("adminBootstrap", {}, ADM2)).pcus.find((x) => x.code === "PCU00");
    eq([b00.pin_custom, b00.login_count, b00.pin_fail, b00.pin_locked_until], [false, 1, 0, null], "adminBootstrap PCU00: pin_custom false, login_count 1");

    // edit
    const e1 = await mustOk("adminPcuEdit", { code: "PCU00", name: "ทดลองระบบ", print_name: "รพ.สต.ทดลอง" }, ADM2);
    eq(e1.pcu, { code: "PCU00", name: "ทดลองระบบ", print_name: "รพ.สต.ทดลอง", group: "ทดลอง" }, "adminPcuEdit name + print_name → {pcu}");
    eq((await mustOk("pcuList")).pcus.find((x) => x.code === "PCU00"), e1.pcu, "pcuList reflects the edit");
    expectErr(await api("adminPcuEdit", { code: "PCU99", name: "x" }, ADM2), "NOT_FOUND", "edit unknown PCU99");
    expectErr(await api("adminPcuEdit", { code: "PCU00" }, ADM2), "BAD_REQUEST", "edit without any field");
    expectErr(await api("adminPcuEdit", { code: "PCU00", name: "ทดลองระบบ" }, ADM2), "BAD_REQUEST", "edit with no actual change");
    expectErr(await api("adminPcuEdit", { code: "PCU00", group: "xx" }, ADM2), "BAD_REQUEST", "edit: unknown group");
    expectErr(await api("adminPcuEdit", { code: "PCU00", name: "" }, ADM2), "BAD_REQUEST", "edit: blank name");
    eq((await mustOk("adminPcuEdit", { code: "PCU00", group: "พิเศษ" }, ADM2)).pcu.group, "พิเศษ", "edit group → พิเศษ");
    eq((await mustOk("adminPcuEdit", { code: "pcu00", group: "ทดลอง" }, ADM2)).pcu, e1.pcu, "edit group back → ทดลอง (lower-case code accepted)");
    const b00b = (await mustOk("adminBootstrap", {}, ADM2)).pcus.find((x) => x.code === "PCU00");
    eq([b00b.pin_custom, b00b.login_count], [false, 1], "edit never touches pin_* / login_*");
    ok((await mustOk("pcuLogin", { pcu: "PCU00", pin: "12345" })).token, "PCU00 still logs in with 12345 after edits");

    // export: a sent PCU00 request in CUR is excluded from all 3 sheets
    const T00 = (await mustOk("pcuLogin", { pcu: "PCU00", pin: "12345" })).token;
    const s00 = await api("saveLines", { month: CUR, lines: { [A.code]: { op: 3, pp: 1 } }, send: true }, T00);
    ok(s00.ok && ["submitted", "issued"].includes(s00.data.request.status), "PCU00 sends a request in CUR" + (s00.ok ? "" : ` (${s00.error && s00.error.code}: ${s00.error && s00.error.message})`));
    const x00 = await get(`/api/export.xlsx?month=${CUR}`, { authorization: "Bearer " + ADM2 });
    eq(x00.status, 200, "export with PCU00 present → 200");
    const wb00 = XLSX.read(Buffer.from(await x00.arrayBuffer()), { type: "buffer" });
    const e1s = XLSX.utils.sheet_to_json(wb00.Sheets["รายบรรทัด"], { header: 1 });
    ok(e1s.length > 1 && !e1s.slice(1).some((r) => r[1] === "PCU00"), "export sheet 1: no PCU00 rows (other rows still there)");
    const e2s = XLSX.utils.sheet_to_json(wb00.Sheets["รพ.สต. × รายการ"], { header: 1 });
    ok(!e2s[1].includes("ทดลองระบบ"), "export sheet 2: header has no ทดลองระบบ column");
    eq(e2s[1].length, 3 + 15 + 1, "export sheet 2: still 15 PCU columns + total (trial excluded)");
    const e3s = XLSX.utils.sheet_to_json(wb00.Sheets["สรุปเงินต่อ รพ.สต."], { header: 1 });
    const data3 = e3s.slice(2, -1);
    ok(!data3.some((r) => r[0] === "PCU00"), "export sheet 3: no PCU00 row");
    eq(data3.length, 15, "export sheet 3: still 15 PCU rows (trial excluded)");
    const reqs00 = (await mustOk("adminRequests", { month: CUR }, ADM2)).requests;
    const realBaht = reqs00.filter((x) => x.pcu !== "PCU00" && (x.status === "submitted" || x.status === "issued")).reduce((a, x) => a + x.progress.baht, 0);
    ok(near(e3s[e3s.length - 1][7], realBaht, 0.05), `export sheet 3 requested total = Σ real PCUs only (${realBaht})`);
    ok(reqs00.some((x) => x.pcu === "PCU00" && x.status === "submitted"), "adminRequests still lists the PCU00 request (frontend tags it)");

    // audit + seed export
    const aud = (await mustOk("adminAuditLog", { limit: 100 }, ADM2)).entries;
    const aAdd = aud.find((x) => x.action === "adminPcuAdd" && x.pcu === "PCU00");
    ok(aAdd && aAdd.detail === "ทดลอง" && aAdd.actor === ADMIN_EMAIL, "audit adminPcuAdd (pcu PCU00, detail = name)");
    const aEd = aud.find((x) => x.action === "adminPcuEdit" && x.pcu === "PCU00" && /name/.test(x.detail));
    eq(aEd && JSON.parse(aEd.detail), { name: ["ทดลอง", "ทดลองระบบ"], print_name: ["ทดลอง", "รพ.สต.ทดลอง"] }, "audit adminPcuEdit detail = JSON {field:[old,new]} (changed keys only)");
    const exs = (await mustOk("adminExportSeed", {}, ADM2)).seed;
    eq([exs.pcus.length, exs.pcus.find((x) => x.code === "PCU00")], [16, { code: "PCU00", name: "ทดลองระบบ", print_name: "รพ.สต.ทดลอง", group: "ทดลอง" }],
      "adminExportSeed: pcus has PCU00 group ทดลอง (16)");

    // defaults on a second PCU (added after the count checks above)
    const gd = await mustOk("adminPcuAdd", { code: "PCU98", name: "ปกติ" }, ADM2);
    eq(gd.pcu, { code: "PCU98", name: "ปกติ", print_name: "ปกติ", group: "ทั่วไป" }, "add without group / print_name → ทั่วไป, print_name = name");
    eq((await mustOk("adminPcuEdit", { code: "PCU98", name: "ปกติ2", print_name: "" }, ADM2)).pcu.print_name, "ปกติ2", "edit print_name \"\" → = (new) name");
    eq((await mustOk("adminPcuEdit", { code: "PCU98", name: "ปกติ3" }, ADM2)).pcu.print_name, "ปกติ2", "edit name only leaves print_name untouched");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("PCU dashboard (2q)");
  {
    // PCU98 (added in 2n, no data yet) · trial round = 2026-11 (inside FY2570 here, so it must be dropped) · rounds 2026-12 / 2027-01 sent, 2027-02 draft
    const P = "PCU98", TRIAL = "2026-11", R1 = "2026-12", R2 = "2027-01", R3 = "2027-02";
    const AT_R2 = { month: R2 }; // calendar 2027-01 → currentRound 2027-02, prevRound 2027-01
    const r2 = (x) => Math.round(x * 100) / 100;
    await mustOk("adminSetLimitMode", { mode: "off" }, ADM2);
    await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM2);
    for (const m of [TRIAL, R1, R2, R3]) await mustOk("adminLockRound", { month: m, locked: 0 }, ADM2);
    await mustOk("adminSetConfig", { key: "trial_month", value: TRIAL }, ADM2);
    const fItem = (code) => FD.steps.flatMap((s) => s.rows).find((r) => r.type === "item" && r.code === code);
    const unitOf = (code) => FD.steps.find((s) => s.rows.some((r) => r.type === "item" && r.code === code)).dispense_unit;
    // plans 2570 + actual_prev 2569 for PCU98 (import replaces a whole fy → the seed's rows are re-sent, restored at the end)
    const ap69 = (seed.actual_prev && seed.actual_prev["2569"]) || { months: fyExcelMonths(2569), data: {} };
    const z = () => new Array(12).fill(0);
    const aOp = z(), aPp = z(), bOp = z();
    aOp[0] = 4; aOp[1] = 3; aPp[1] = 1; bOp[11] = 2; // Excel 2025-10 (↔ trial round 2026-11: dropped) · 2025-11 (↔ 2026-12) · 2026-09 (↔ 2026-10)
    await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: 2570,
      plans: { 2570: { ...seed.plans["2570"], [P]: { [A.code]: [100, 20], [B.code]: [10, 2] } } },
      actual_prev: { 2569: { months: ap69.months, data: { ...ap69.data, [P]: { [A.code]: { op: aOp, pp: aPp }, [B.code]: { op: bOp, pp: z() } } } } },
    }, set_current_fy: true }, ADM2, "import PCU98 plans + actual_prev (+ fy_current back to 2570; the 2e section left 2571)");

    const abD = await mustOk("adminBootstrap", {}, ADM2);
    const FD = abD.form; // latest FY2570 form (prices edited by 2p)
    const TP = (await mustOk("pcuLogin", { pcu: P, pin: "12345" })).token;
    let n = 0;
    const tsn = () => new Date(Date.parse("2027-01-05T00:00:00Z") + ++n * 1000).toISOString();
    const L = (o) => Object.fromEntries(Object.entries(o).map(([c, v]) => [c, { stock: null, ...v, updated_at: tsn() }]));
    const save = async (month, lines, send, opts) => {
      const r = await api("saveLines", { month, lines: L(lines), ...(send ? { send: true } : {}) }, TP, opts);
      if (!r.ok) console.log("  saveLines error", JSON.stringify(r.error));
      return r.ok ? r.data : null;
    };
    const dash = async (params = {}, tok = TP, opts) => api("pcuDashboard", params, tok, opts);

    // empty pcu first
    const d0 = await mustOk("pcuDashboard", {}, TP);
    eq([d0.fy, d0.fys, d0.monthly, d0.flags, d0.used_coverage], [2570, [2570], {}, [], { items_with_used: 0, items_total: 0 }], "empty: fy = fy_current, fys [2570], monthly {}, flags [], coverage 0/0");
    eq(d0.rounds, fyRoundMonths(2570).filter((m) => m !== TRIAL), "rounds = fyMonths(2570) without the trial round (11)");

    const sends = [
      await save(TRIAL, { [A.code]: { op: 50, pp: 0, used: 7 } }, true), // trial: never counted
      await save(R1, { [A.code]: { op: 4, pp: 1, used: 2 }, [B.code]: { op: 2, pp: 0 }, [CSI.code]: { op: 3, pp: 0 }, [LABI.code]: { op: 1, pp: 0 } }, true),
      await save(R2, { [A.code]: { op: 1, pp: 0, used: 3 }, [B.code]: { op: 10, pp: 0, used: 0 } }, true, AT_R2),
      await save(R3, { [A.code]: { op: 99, pp: 0 }, [B.code]: { op: 99, pp: 0 } }, false, AT_R2), // draft: never counted
    ];
    ok(sends.every(Boolean) && sends[3].status === "draft" && sends.slice(0, 3).every((s) => s.status === "submitted"), "setup: PCU98 sends trial 2026-11, 2026-12, 2027-01 · draft 2027-02");
    // issue 2026-12: A short (3 of 5) + CSI figure, then only A's unit is marked done
    await mustOk("issueLines", { pcu: P, month: R1, lines: { [A.code]: { issued_total: 3, reason: "out_of_stock" }, [CSI.code]: { issued_total: 3 } } }, ADM2);
    await mustOk("issueDone", { pcu: P, month: R1, unit: unitOf(A.code), done: 1 }, ADM2);
    const g1 = (await mustOk("adminGetRequest", { pcu: P, month: R1 }, ADM2)).request.lines;
    const g2 = (await mustOk("adminGetRequest", { pcu: P, month: R2 }, ADM2)).request.lines;
    const ps = (l) => l.price_snapshot;
    ok([A, B, CSI, LABI].every((x) => typeof ps(g1[x.code]) === "number") && typeof ps(g2[A.code]) === "number", "setup: sent lines carry price_snapshot");
    const bGot = unitOf(B.code) === unitOf(A.code) ? 2 : 0; // issueDone fills the still-null lines of the done unit with the request

    const dr = await dash({}, TP, AT_R2);
    ok(dr.ok, "pcuDashboard at calendar 2027-01" + (dr.ok ? "" : ` (${dr.error.code}: ${dr.error.message})`));
    const d = dr.data;
    eq(d.fy, 2570, "pcuDashboard default fy = fy_current 2570");
    eq(d.monthly[A.code] && Object.keys(d.monthly[A.code]).sort(), [R1, R2], "A: only rounds 2026-12 + 2027-01 (trial 2026-11 and draft 2027-02 not counted)");
    ok(!Object.values(d.monthly).some((byR) => TRIAL in byR || R3 in byR), "no item has a trial-round or draft-round entry");
    const pA1 = ps(g1[A.code]), pB1 = ps(g1[B.code]), pC1 = ps(g1[CSI.code]), pL1 = ps(g1[LABI.code]), pA2 = ps(g2[A.code]), pB2 = ps(g2[B.code]);
    eq(d.monthly[A.code][R1], [5, r2(5 * pA1), 3, r2(3 * pA1), 2, r2(2 * pA1)], "A 2026-12 = [req 5, ×snapshot, got 3 (unit done, short), ×snapshot, used 2, ×snapshot]");
    eq(d.monthly[A.code][R2], [1, r2(pA2), 0, 0, 3, r2(3 * pA2)], "A 2027-01 = [1, …, got 0 (not issued), used 3 × snapshot]");
    eq(d.monthly[B.code][R1], [2, r2(2 * pB1), bGot, r2(bGot * pB1), 0, 0], `B 2026-12 got ${bGot} (done unit default = requested)`);
    eq(d.monthly[B.code][R2], [10, r2(10 * pB2), 0, 0, 0, 0], "B 2027-01 (used 0 → used columns 0)");
    eq(d.monthly[CSI.code][R1], [3, r2(3 * pC1), 0, 0, 0, 0], "CSI: issued_total set but its unit is not done → got 0 (no leak)");
    eq(d.monthly[LABI.code][R1], [1, r2(pL1), 0, 0, 0, 0], "LAB item: requested, nothing issued");
    ok(near(d.monthly[A.code][R1][1], 5 * pA1) && pA1 !== A.price, `baht = qty × price_snapshot (${pA1}; ≠ the import price ${A.price} — 2p repriced A from 2026-12)`);
    eq(d.used_coverage, { items_with_used: 2, items_total: 4 }, "used_coverage: 2 items with a used line (A, B used 0) of 4 requested");
    eq(d.fys, [2570], "fys = [2570] (the trial round does not add a fy)");

    // items
    const ia = d.items[A.code];
    eq(ia, { name: fItem(A.code).name, unit: fItem(A.code).unit || "", unit_group: unitOf(A.code), plan_qty: 120 }, "items[A] = {name, unit, unit_group = step.dispense_unit, plan_qty = plan_op + plan_pp}");
    eq([d.items[B.code].plan_qty, d.items[CSI.code].plan_qty, d.items[CSI.code].unit_group, d.items[LABI.code].unit_group], [12, 0, "จ่ายกลาง", "LAB"], "items: plan_qty 12 / 0 (no plan) · unit_group จ่ายกลาง / LAB");
    const activeCodes = FD.steps.filter((s) => s.active !== false).flatMap((s) => s.rows.filter((r) => r.type === "item" && r.active !== false).map((r) => r.code));
    eq(Object.keys(d.items).sort(), [...new Set([...activeCodes, A.code, B.code, CSI.code, LABI.code])].sort(), "items = active items of the FY2570 form (+ any with data)");

    // flags (rule 2 "pace"): elapsed = rounds ≤ currentRound without the trial
    eq(d.flags, [{ code: B.code, rule: "pace", cum_qty: 12, plan_qty: 12, elapsed: 3 }],
      "calendar 2027-01: elapsed 3 (2026-12, 2027-01, 2027-02) · B 12 > 12×3/12×1.2 → pace · A 6 ≤ 36 no flag · CSI has no plan → skipped");
    const dE1 = await mustOk("pcuDashboard", {}, TP);
    eq(dE1.flags.map((f) => [f.code, f.elapsed]), [[B.code, 1]], "calendar 2026-11: elapsed 1 (trial 2026-11 not counted)");

    // prev_fy: actual_prev 2569 aligned to rounds (round X ↔ Excel month X−1 a year earlier)
    const pp69 = abD.prev && abD.prev["2569"] ? abD.prev["2569"].prices : {};
    const pa = pp69[A.code] ?? fItem(A.code).price, pb = pp69[B.code] ?? fItem(B.code).price;
    const pv = d.prev_fy;
    ok(pv && pv.months.length === 11 && pv.qty.length === 11 && pv.baht.length === 11, "prev_fy arrays aligned to rounds (11 entries)");
    eq([pv.months[0], pv.months[10]], ["2025-11", "2026-09"], "prev_fy.months[i] = Excel month of rounds[i] one year earlier (2026-12 ↔ 2025-11)");
    const qx = z().slice(0, 11); qx[0] = 4; qx[10] = 2;
    eq(pv.qty, qx, "prev_fy.qty: 2025-11 → 4 (OP 3 + PP 1) · 2026-09 → 2 · 2025-10 (↔ trial round) dropped");
    ok(near(pv.baht[0], r2(4 * pa)) && near(pv.baht[10], r2(2 * pb)) && pv.baht.slice(1, 10).every((x) => x === 0), `prev_fy.baht = qty × prices_prev 2569 (${pa}, ${pb})`);

    // CSI's unit marked done later → got appears
    await mustOk("issueDone", { pcu: P, month: R1, unit: "จ่ายกลาง", done: 1 }, ADM2);
    eq((await mustOk("pcuDashboard", {}, TP)).monthly[CSI.code][R1].slice(2, 4), [3, r2(3 * pC1)], "CSI unit done → got 3 shows up");

    // hidden: no data → dropped · with data → kept
    const H = activeCodes.find((c) => ![A.code, B.code, CSI.code, LABI.code].includes(c));
    await mustOk("setHidden", { codes: [H, LABI.code] }, TP);
    const dH = await mustOk("pcuDashboard", {}, TP);
    ok(!(H in dH.items) && LABI.code in dH.items, "hidden item without data excluded · hidden item with data kept");
    await mustOk("setHidden", { codes: [] }, TP);

    // fy param
    expectErr(await dash({ fy: "abc" }), "BAD_REQUEST", "fy 'abc'");
    expectErr(await dash({ fy: 2570.5 }), "BAD_REQUEST", "fy 2570.5");
    expectErr(await dash({ fy: -1 }), "BAD_REQUEST", "fy -1");
    expectErr(await dash({ fy: 2560 }), "NOT_FOUND", "fy 2560 (no form)");
    const d71 = await mustOk("pcuDashboard", { fy: "2571" }, TP);
    eq([d71.fy, d71.rounds.length, d71.monthly, d71.prev_fy, d71.flags, d71.fys], [2571, 12, {}, null, [], [2570]],
      "fy '2571' (form from the rollover): 12 rounds, no data, prev_fy null (no actual_prev 2570 for PCU98), fys [2570]");
    eq(await mustOk("pcuDashboard", { fy: 2570 }, TP), await mustOk("pcuDashboard", {}, TP), "fy 2570 explicit = the default");

    // auth: PCU token only, always the token's own pcu
    expectErr(await dash({}, null), "AUTH_REQUIRED", "pcuDashboard without a token");
    expectErr(await dash({}, ADM2), "FORBIDDEN", "pcuDashboard with an admin token");
    const DSPD = "dash.disp@example.com";
    await mustOk("adminUsersAdd", { email: DSPD, role: "dispenser", units: ["LAB"] }, ADM2);
    expectErr(await dash({}, (await mustOk("adminLoginGoogle", { id_token: "dev:" + DSPD })).token), "FORBIDDEN", "pcuDashboard with a dispenser token");
    await mustOk("adminUsersRemove", { email: DSPD }, ADM2);
    const T00d = (await mustOk("pcuLogin", { pcu: "PCU00", pin: "12345" })).token;
    const d00 = await mustOk("pcuDashboard", { pcu: P }, T00d);
    ok(d00.monthly[A.code] && d00.monthly[A.code][R1][0] === 4 && !d00.monthly[B.code], "a pcu param is ignored: PCU00 sees only its own request (A 4 in 2026-12), never PCU98's");

    // restore: trial off, seed plans / actual_prev, fy_current 2571 (as the 2e section left it)
    await mustOk("adminSetConfig", { key: "trial_month", value: null }, ADM2);
    await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: 2570, plans: { 2570: seed.plans["2570"] }, actual_prev: { 2569: ap69 } } }, ADM2, "restore seed plans + actual_prev");
    await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: 2571 }, set_current_fy: true }, ADM2, "restore fy_current 2571");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("Admin dashboard + shortage (2s)");
  {
    // FY2571 (fy_current here, no request yet) = fully controlled data · trial round 2027-11 · PCU00 = group ทดลอง · PCU98 / PCU01 / PCU11 / PCU12
    const FY = 2571, TRIAL = "2027-11", R1 = "2027-12", R2 = "2028-01";
    const AT = { month: R2 }; // calendar 2028-01 → currentRound 2028-02: elapsed = 2027-12, 2028-01, 2028-02 (trial dropped) = 3
    const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 10000) / 10000;
    const patternOf = (vals) => { // thresholds.json rules (same order as the backend)
      const annual = vals.reduce((a, v) => a + v, 0), act = vals.filter((v) => v > 0).length, s = vals.filter((v) => v > 0).sort((a, b) => b - a);
      if (!(annual > 0)) return "ไม่เบิก";
      if (act <= 3 && annual < 10000) return "เบาบาง";
      if (s[0] / annual >= 0.8) return "เบิกครั้งเดียว";
      if ((s[0] + (s[1] || 0) + (s[2] || 0)) / annual >= 0.6) return "กระจุกเป็นช่วง";
      if (act >= 8 && s[0] / annual < 0.35) return "สม่ำเสมอ";
      return "ผสม";
    };
    const ex0 = (await mustOk("adminExportSeed", {}, ADM2)).seed; // plans / stats / actual_prev of every fy — restored at the end
    await mustOk("adminSetLimitMode", { mode: "off" }, ADM2);
    await mustOk("adminSetConfig", { key: "stock_required", value: 0 }, ADM2);
    await mustOk("adminSetConfig", { key: "trial_month", value: TRIAL }, ADM2);
    const F = (await mustOk("adminBootstrap", {}, ADM2)).form;
    eq(F.fy, FY, "setup: fy_current form = FY2571");
    const its = F.steps.filter((s) => s.active !== false).flatMap((s) => s.rows.filter((r) => r.type === "item" && r.active !== false).map((r) => ({ ...r, unit_of: s.dispense_unit })));
    const pk = its.filter((i) => i.unit_of === "พัสดุ");
    const X = pk.find((i) => i.price >= 20 && i.price <= 500);
    const W = pk.find((i) => i.price > 0 && i.price <= 30 && i !== X);
    const Y = pk.find((i) => i.price >= 50 && ![X, W].includes(i));
    const Z = pk.find((i) => i.price >= 10 && ![X, W, Y].includes(i));
    const K = its.find((i) => i.unit_of === "จ่ายกลาง" && i.price > 0);
    ok(X && W && Y && Z && K, "setup: items X (20–500 ฿), W (≤ 30 ฿), Y (≥ 50 ฿), Z, K (จ่ายกลาง) found in the FY2571 form");
    const ordIdx = new Map(its.map((i, k) => [i.code, k]));
    const byForm = (a, b) => ordIdx.get(a) - ordIdx.get(b);
    const qx = Math.ceil(3000 / X.price), a = Math.ceil(qx * 0.6), b = qx - a;
    const qy = Math.ceil(10000 / Y.price), qz = Math.ceil(1000 / Z.price);

    // plans 2571 · stats 2570 (rule 1 basis = fy−1) · actual_prev 2570 (rule 3 + pattern_prev) — replaced per fy, restored at the end
    const z12 = () => new Array(12).fill(0);
    const xOp = z12(); xOp[9] = 1; xOp[10] = 1; xOp[11] = 1; // Excel ก.ค.–ก.ย. only → endyear
    await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: FY,
      plans: { [FY]: { PCU98: { [X.code]: [a + b, 0], [Z.code]: [qz * 10, 0] }, PCU01: { [Y.code]: [qy * 10, 0] } } },
      stats: { 2570: { PCU98: { [X.code]: [1, a - 1, 10], [Z.code]: [1, qz + 5, 10], [W.code]: [0, 0, 1] }, PCU01: { [X.code]: [0, 0.5, 1] } } },
      actual_prev: { 2570: { months: fyExcelMonths(2570), data: { PCU98: { [X.code]: { op: xOp, pp: z12() } } } } },
    } }, ADM2, "import controlled plans 2571 / stats 2570 / actual_prev 2570");

    const tok = {};
    for (const pc of ["PCU98", "PCU01", "PCU11", "PCU12", "PCU00"]) tok[pc] = (await mustOk("pcuLogin", { pcu: pc, pin: "12345" })).token;
    let n = 0;
    const tsn = () => new Date(Date.parse("2028-01-05T00:00:00Z") + ++n * 1000).toISOString();
    const L = (o) => Object.fromEntries(Object.entries(o).map(([c, q]) => [c, { stock: null, op: q, pp: 0, updated_at: tsn() }]));
    const send = async (pc, month, lines) => {
      const r = await api("saveLines", { month, lines: L(lines), send: true }, tok[pc], { month: shiftMonth(month, -1) });
      if (!r.ok) console.log("  saveLines error", pc, month, JSON.stringify(r.error));
      return r.ok && r.data.status === "submitted";
    };
    const sent = [
      await send("PCU98", TRIAL, { [X.code]: 50 }), // trial round: never counted
      await send("PCU98", R1, { [X.code]: a, [Z.code]: qz, [W.code]: 2 }),
      await send("PCU98", R2, { [X.code]: b }),
      await send("PCU01", R1, { [Y.code]: qy, [X.code]: 1, [W.code]: 1 }),
      await send("PCU11", R1, { [Y.code]: qy, [X.code]: 1 }),
      await send("PCU12", R2, { [Y.code]: qy, [W.code]: 1, [K.code]: 5 }),
      await send("PCU00", R1, { [X.code]: 100 }), // group ทดลอง: never counted
    ];
    ok(sent.every(Boolean), "setup: 7 requests sent (PCU98 trial/R1/R2, PCU01 R1, PCU11 R1, PCU12 R2, PCU00 R1)");
    // issuing (admin, no unit marked done): PCU98 X short 2 · PCU01 all full, then X → 0 (other) · PCU12 K 1 of 5 · trial cases short too
    await mustOk("issueLines", { pcu: "PCU98", month: R1, lines: { [X.code]: { issued_total: a - 2, reason: "out_of_stock" } } }, ADM2);
    await mustOk("issueAll", { pcu: "PCU01", month: R1 }, ADM2);
    await mustOk("issueLines", { pcu: "PCU01", month: R1, lines: { [X.code]: { issued_total: 0, reason: "other", note: "ทดสอบ" } } }, ADM2);
    await mustOk("issueLines", { pcu: "PCU12", month: R2, lines: { [K.code]: { issued_total: 1, reason: "out_of_stock" } } }, ADM2);
    await mustOk("issueLines", { pcu: "PCU00", month: R1, lines: { [X.code]: { issued_total: 10, reason: "out_of_stock" } } }, ADM2);
    await mustOk("issueLines", { pcu: "PCU98", month: TRIAL, lines: { [X.code]: { issued_total: 40, reason: "out_of_stock" } } }, ADM2);
    // prices = price_snapshot of the lines (FY2571 price_history from 2027-11)
    const P = {};
    let samePrice = true;
    for (const [pc, m] of [["PCU98", R1], ["PCU98", R2], ["PCU01", R1], ["PCU11", R1], ["PCU12", R2]]) {
      const ls = (await mustOk("adminGetRequest", { pcu: pc, month: m }, ADM2)).request.lines;
      for (const [c, l] of Object.entries(ls)) { if (c in P && P[c] !== l.price_snapshot) samePrice = false; P[c] = l.price_snapshot; }
    }
    ok(samePrice && [X, Y, Z, W, K].every((i) => typeof P[i.code] === "number"), "setup: one price_snapshot per item across the sent lines");
    const px = P[X.code], py = P[Y.code], pz = P[Z.code], pw = P[W.code], pkk = P[K.code];
    const T = { PCU98: (a + b) * px + qz * pz + 2 * pw, PCU01: qy * py + px + pw, PCU11: qy * py + px, PCU12: qy * py + pw + 5 * pkk };
    const Tnet = Object.values(T).reduce((s, v) => s + v, 0);

    // ---- permissions ----
    expectErr(await api("adminDashboard", {}, null, AT), "AUTH_REQUIRED", "adminDashboard without a token");
    expectErr(await api("adminDashboard", {}, tok.PCU98, AT), "FORBIDDEN", "adminDashboard with a PCU token");
    const DSP = "dash2s.disp@example.com";
    await mustOk("adminUsersAdd", { email: DSP, role: "dispenser", units: ["จ่ายกลาง"] }, ADM2);
    const DT = (await mustOk("adminLoginGoogle", { id_token: "dev:" + DSP })).token;
    expectErr(await api("adminDashboard", {}, DT, AT), "FORBIDDEN", "adminDashboard with a dispenser token");
    expectErr(await api("adminDashboard", { pcu: "PCU98" }, DT, AT), "FORBIDDEN", "adminDashboard{pcu} with a dispenser token");
    expectErr(await api("adminDashboard", { fy: "abc" }, ADM2, AT), "BAD_REQUEST", "adminDashboard fy 'abc'");
    expectErr(await api("adminDashboard", { fy: 2560 }, ADM2, AT), "NOT_FOUND", "adminDashboard fy 2560 (no form)");

    // ---- network view ----
    const nr = await api("adminDashboard", {}, ADM2, AT);
    ok(nr.ok, "adminDashboard (network) at calendar 2028-01" + (nr.ok ? "" : ` (${nr.error.code}: ${nr.error.message})`));
    const N = nr.data;
    eq([N.fy, N.elapsed, N.rounds], [FY, 3, fyRoundMonths(FY).filter((m) => m !== TRIAL)], "network: fy = fy_current 2571, elapsed 3, rounds without the trial round");
    ok(N.fys.includes(2571) && N.fys.includes(2570) && N.fys[0] === 2571, `network: fys newest first incl. 2571 + 2570 (${N.fys})`);
    ok(!N.pcus.some((x) => x.code === "PCU00") && N.pcus.length === 16, "network: pcus = every PCU except group ทดลอง (16, PCU00 left out)");
    const pc = Object.fromEntries(N.pcus.map((x) => [x.code, x]));
    const expOrder = Object.entries(T).sort((u, v) => v[1] - u[1]).map(([k]) => k);
    eq(N.pcus.slice(0, 4).map((x) => x.code), expOrder, "network: pcus sorted by req_baht (high → low)");
    eq(N.pcus.slice(0, 4).map((x) => x.req_baht), expOrder.map((k) => r2(T[k])), "network: req_baht per pcu (trial round + trial group excluded)");
    eq(["PCU98", "PCU01", "PCU11", "PCU12"].map((k) => pc[k].got_baht), [r2((a - 2) * px), r2(qy * py + pw), 0, r2(pkk)],
      "network: got = staff view (issued_total of undone units counted; null → 0)");
    eq(N.network.items[X.code], [a + b + 2, r2((a + b + 2) * px), a - 2, r2((a - 2) * px), 0, 0], "network.items[X] = V6 without PCU00 (100) and the trial round (50)");
    eq(N.network.monthly["จ่ายกลาง"], { [R2]: [5, r2(5 * pkk), 1, r2(pkk), 0, 0] }, "network.monthly[จ่ายกลาง] = only R2 (K 5 → got 1)");
    eq(N.network.monthly["พัสดุ"][R1][0], a + qz + 2 + qy + 2 + qy + 1, "network.monthly[พัสดุ][R1] req qty = Σ พัสดุ lines of R1");
    ok(!Object.values(N.network.monthly).some((byR) => TRIAL in byR) && Object.keys(N.network.monthly.LAB).length === 0, "network.monthly: no trial-round key · LAB empty");
    eq(N.items[X.code], { name: X.name, unit: X.unit || "", unit_group: "พัสดุ", net_plan_qty: a + b }, "items[X] = {name, unit, unit_group, net_plan_qty}");
    eq(N.network.plan_baht, { "พัสดุ": r2((a + b) * X.price + qz * 10 * Z.price + qy * 10 * Y.price), "จ่ายกลาง": 0, LAB: 0 }, "network.plan_baht per unit = Σ plan × form price");
    eq(N.network.req_baht_on_plan, { "พัสดุ": r2((a + b) * px + qz * pz + qy * py), "จ่ายกลาง": 0, LAB: 0 }, "network.req_baht_on_plan = req baht of planned (pcu,item)");
    const netQ = { [X.code]: a + b + 2, [Y.code]: 3 * qy, [Z.code]: qz, [W.code]: 4, [K.code]: 5 };
    const netB = { [X.code]: (a + b + 2) * px, [Y.code]: 3 * qy * py, [Z.code]: qz * pz, [W.code]: 4 * pw, [K.code]: 5 * pkk };
    const top = (o) => Object.keys(o).sort((u, v) => o[v] - o[u] || byForm(u, v)).slice(0, 3);
    eq(N.network.top3, { qty: top(netQ), baht: top(netB) }, "network.top3 by req qty / req baht");
    const plan98 = (a + b) * X.price + qz * 10 * Z.price, on98 = (a + b) * px + qz * pz;
    eq([pc.PCU98.plan_baht, pc.PCU98.pct_plan, pc.PCU01.pct_plan, pc.PCU11.pct_plan], [r2(plan98), r4(on98 / plan98), 0.1, null], "pcus: plan_baht + pct_plan (null without a plan)");
    eq(pc.PCU98.units, { "พัสดุ": [r2(T.PCU98), r2((a - 2) * px), r2(plan98), r2(on98)], "จ่ายกลาง": [0, 0, 0, 0], LAB: [0, 0, 0, 0] }, "pcus[PCU98].units = [req, got, plan, req_on_plan] per unit");

    // flags: rule 1 (p90 of stats 2570), rule 2 (pace), rule 4 (share) — ordered pcu → item → rule → round
    const share98 = (a + b) * px / ((a + b + 2) * px), thr98 = 2 * T.PCU98 / Tnet;
    const fShare = { pcu: "PCU98", code: X.code, rule: "share", value: r4(share98), threshold: r4(thr98) };
    const fPace = { pcu: "PCU98", code: X.code, rule: "pace", value: a + b, threshold: r2((a + b) * 3 / 12 * 1.2) };
    eq(N.flags, [
      { pcu: "PCU01", code: X.code, rule: "p90", round: R1, value: 1, threshold: 0.5 },
      { pcu: "PCU98", code: X.code, rule: "p90", round: R1, value: a, threshold: a - 1 },
      fPace, fShare,
    ], "network.flags: p90 X R1 (PCU01, PCU98) · pace X · share X (PCU98) — nothing else");
    ok(!N.flags.some((f) => f.rule === "p90" && f.round === R2), `rule 1 non-trigger: PCU98 X R2 qty ${b} ≤ p90 ${a - 1}`);
    ok(!N.flags.some((f) => f.code === Z.code), `rule 1 non-trigger Z (qty ${qz} ≤ p90 ${qz + 5}) · rule 2 non-trigger Z (${qz} ≤ plan ${qz * 10} × 3/12 × 1.2)`);
    ok(!N.flags.some((f) => f.code === W.code && f.rule === "p90"), "rule 1: stats p90_m 0 → skipped (W qty 2 > 0 not flagged)");
    ok(!N.flags.some((f) => f.code === Y.code), "rule 2 non-trigger: PCU01 Y within plan · rule 4 non-trigger: Y share 1/3 < 2 × pcu share");
    const shareZ = 1, shareW = 2 / 4;
    ok(shareZ > thr98 && !N.flags.some((f) => f.rule === "share" && f.code === Z.code), "rule 4 cut-off: Z (share 1 > threshold) requested by 1 PCU only (< 3) → no flag");
    ok(4 * pw < 0.005 * Tnet && shareW > thr98 && !N.flags.some((f) => f.rule === "share" && f.code === W.code),
      `rule 4 cut-off: W 3 PCUs, share ${shareW} > threshold ${r4(thr98)} but network ${r2(4 * pw)} ฿ < 0.5 % of ${r2(Tnet)} → no flag`);
    ok(share98 > thr98 && (a + b + 2) * px >= 0.005 * Tnet, "rule 4 trigger case: X ≥ 0.5 % of the network, 3 PCUs, PCU98 share > 2 × its total share");
    eq([pc.PCU98.n_flags, pc.PCU01.n_flags, pc.PCU11.n_flags, pc.PCU12.n_flags], [3, 1, 0, 0], "pcus[].n_flags");
    eq(N.info_new, [Z.code, W.code].sort(byForm).map((c) => ({ pcu: "PCU98", code: c })),
      "info_new (rule 3): PCU98 Z + W (not in its actual_prev 2570) · X was there · PCU01/11/12 have no actual_prev → none");
    const b98 = [a * px + qz * pz + 2 * pw, b * px, 0];
    eq([pc.PCU98.pattern, pc.PCU01.pattern, pc.PCU11.pattern, pc.PCU02 && pc.PCU02.pattern], [patternOf(b98), "เบิกครั้งเดียว", "เบิกครั้งเดียว", "ไม่เบิก"],
      `pattern this year (req baht of the elapsed rounds): PCU98 ${patternOf(b98)} · one-month ≥ 10,000 ฿ → เบิกครั้งเดียว · nothing → ไม่เบิก`);
    eq([pc.PCU98.pattern_prev, pc.PCU98.endyear_prev, pc.PCU01.pattern_prev, pc.PCU01.endyear_prev], ["เบาบาง", true, null, false],
      "pattern_prev from actual_prev 2570 (3 months ก.ค.–ก.ย. → เบาบาง, endyear) · null/false without actual_prev");
    ok(N.pcus.every((x) => x.pattern_note === "ข้อมูลยังน้อย"), "pattern_note ข้อมูลยังน้อย (3 elapsed rounds < 6)");
    const N9 = await mustOk("adminDashboard", {}, ADM2); // calendar 2026-11: FY2571 not started → elapsed 0 → no pace flag
    ok(N9.elapsed === 0 && !N9.flags.some((f) => f.rule === "pace"), "elapsed 0 (calendar 2026-11) → no pace flag");

    // ---- one PCU (staff view) ----
    const vr = await api("adminDashboard", { pcu: "pcu98" }, ADM2, AT);
    ok(vr.ok, "adminDashboard{pcu:'pcu98'} (code upper-cased)" + (vr.ok ? "" : ` (${vr.error.code}: ${vr.error.message})`));
    const V = vr.data;
    eq([V.fy, V.pcu, V.elapsed, V.rounds.length], [FY, { code: "PCU98", name: pc.PCU98.name }, 3, 11], "pcu view: fy, pcu {code,name}, elapsed, rounds");
    eq(V.monthly[X.code][R1], [a, r2(a * px), a - 2, r2((a - 2) * px), 0, 0], "pcu view monthly X R1: got = issued_total although the unit is not done (staff view)");
    ok(!(TRIAL in V.monthly[X.code]), "pcu view: trial round not counted");
    const pdA = await api("pcuDashboard", { fy: FY }, tok.PCU98, AT);
    ok(pdA.ok && pdA.data.monthly[X.code][R1][2] === 0, "pcuDashboard (PCU view) of the same line: got 0 while the unit is not done");
    eq(V.flags, [
      { code: X.code, rule: "p90", round: R1, value: a, threshold: a - 1 },
      { code: X.code, rule: "pace", value: a + b, threshold: fPace.threshold, cum_qty: a + b, plan_qty: a + b, elapsed: 3 },
      { code: X.code, rule: "share", value: fShare.value, threshold: fShare.threshold },
    ], "pcu view flags: every rule (no pcu field) · pace also carries cum_qty / plan_qty / elapsed");
    const q98 = { [X.code]: a + b, [Z.code]: qz, [W.code]: 2 }, bb98 = { [X.code]: (a + b) * px, [Z.code]: qz * pz, [W.code]: 2 * pw };
    eq(V.top3, { qty: top(q98), baht: top(bb98) }, "pcu view top3 (qty / baht)");
    eq(V.info_new, [Z.code, W.code].sort(byForm), "pcu view info_new = [codes]");
    eq([V.pattern, V.pattern_prev, V.pattern_note, V.endyear_prev], [pc.PCU98.pattern, "เบาบาง", "ข้อมูลยังน้อย", true], "pcu view pattern fields = the network row");
    ok(V.prev_fy && V.prev_fy.qty.reduce((s, v) => s + v, 0) === 3 && V.used_coverage && V.items[X.code].plan_qty === a + b, "pcu view keeps the pcuDashboard fields (prev_fy, used_coverage, items.plan_qty)");
    expectErr(await api("adminDashboard", { pcu: "PCU00" }, ADM2, AT), "NOT_FOUND", "adminDashboard{pcu: PCU00 (group ทดลอง)}");
    expectErr(await api("adminDashboard", { pcu: "NOPE" }, ADM2, AT), "NOT_FOUND", "adminDashboard{pcu: unknown}");

    // ---- issueShortage ----
    const sh = (params, t = ADM2) => api("issueShortage", params, t, AT);
    expectErr(await sh({ scope: "fy" }, null), "AUTH_REQUIRED", "issueShortage without a token");
    expectErr(await sh({ scope: "fy" }, tok.PCU98), "FORBIDDEN", "issueShortage with a PCU token");
    expectErr(await sh({ scope: "x" }), "BAD_REQUEST", "issueShortage scope 'x'");
    expectErr(await sh({ scope: "fy", unit: "xx" }), "BAD_REQUEST", "issueShortage unit 'xx'");
    expectErr(await sh({ scope: "round", month: "2028-13" }), "BAD_REQUEST", "issueShortage month 2028-13");
    expectErr(await sh({ scope: "round", month: "2026-12", fy: FY }), "BAD_REQUEST", "issueShortage month outside the fy");
    const S = (await sh({ scope: "fy" })).data;
    const itK = { code: K.code, name: K.name, unit: K.unit || "", unit_group: "จ่ายกลาง", req_qty: 5, issued_qty: 1, short_qty: 4, short_baht: r2(4 * pkk), n_pcus: 1 };
    const itX = { code: X.code, name: X.name, unit: X.unit || "", unit_group: "พัสดุ", req_qty: a + 1, issued_qty: a - 2, short_qty: 3, short_baht: r2(3 * px), n_pcus: 2 };
    eq([S.fy, S.scope, S.month, S.unit, S.rounds.length], [FY, "fy", null, "all", 11], "shortage fy: {fy, scope, month null, unit all (admin default), rounds}");
    eq(S.summary, { complete: 2, incomplete: 3, short_qty: 7, short_baht: r2(2 * px + px + 4 * pkk) },
      "shortage summary: only lines with issued_total (PCU11 R1, PCU12 Y/W not issued → not counted) · trial round + PCU00 excluded");
    eq(S.items, [itK, itX], "shortage items: short > 0 only, short_qty high → low, short = max(req − issued, 0)");
    eq(S.by_pcu[X.code], [
      { pcu: "PCU01", pcu_name: pc.PCU01.name, month: R1, req: 1, issued: 0, short: 1, short_baht: r2(px), reason: "other", note: "ทดสอบ" },
      { pcu: "PCU98", pcu_name: pc.PCU98.name, month: R1, req: a, issued: a - 2, short: 2, short_baht: r2(2 * px), reason: "out_of_stock", note: null },
    ], "shortage by_pcu[X]: req / issued / short / short_baht / reason / note per pcu × round");
    eq(Object.keys(S.by_pcu).sort(), [X.code, K.code].sort(), "shortage by_pcu: only items with a short line");
    const Sr = (await sh({ scope: "round" })).data;
    eq([Sr.month, Sr.items.map((x) => x.code), Sr.summary], [R2, [K.code], { complete: 0, incomplete: 1, short_qty: 4, short_baht: r2(4 * pkk) }],
      "shortage round (no month): latest sent round ≤ currentRound = 2028-01");
    const S1 = (await sh({ scope: "round", month: R1 })).data;
    eq([S1.fy, S1.items.map((x) => x.code), S1.summary.complete, S1.summary.incomplete], [FY, [X.code], 2, 2], "shortage round 2027-12 (fy derived from month)");
    eq((await sh({ scope: "round", month: TRIAL })).data.summary, { complete: 0, incomplete: 0, short_qty: 0, short_baht: 0 }, "shortage of the trial round = nothing");
    eq((await sh({ scope: "fy", unit: "LAB" })).data.items, [], "shortage unit LAB → none");
    eq((await sh({ scope: "fy", unit: "พัสดุ" })).data.summary, { complete: 2, incomplete: 2, short_qty: 3, short_baht: r2(3 * px) }, "shortage unit พัสดุ");
    const Sd = (await sh({ scope: "fy" }, DT)).data;
    eq([Sd.unit, Sd.items.map((x) => x.code)], ["จ่ายกลาง", [K.code]], "dispenser: unit defaults to its own (จ่ายกลาง)");
    eq((await sh({ scope: "fy", unit: "all" }, DT)).data.items.map((x) => x.code), [K.code, X.code], "dispenser may ask for unit all");

    // restore: trial off, plans 2571 / stats 2570 / actual_prev 2570 as exported before, temporary dispenser removed
    await mustOk("adminUsersRemove", { email: DSP }, ADM2);
    await mustOk("adminSetConfig", { key: "trial_month", value: null }, ADM2);
    await mustOk("adminImportSeed", { seed: { format: "pcu-supply-import/1", fy: FY,
      plans: { [FY]: (ex0.plans && ex0.plans[String(FY)]) || {} },
      stats: { 2570: (ex0.stats && ex0.stats["2570"]) || {} },
      actual_prev: { 2570: (ex0.actual_prev && ex0.actual_prev["2570"]) || { months: fyExcelMonths(2570), data: {} } },
    } }, ADM2, "restore plans 2571 / stats 2570 / actual_prev 2570");
    const ex1 = (await mustOk("adminExportSeed", {}, ADM2)).seed;
    eq([ex1.plans[String(FY)], ex1.stats["2570"], ex1.actual_prev["2570"]], [ex0.plans[String(FY)], ex0.stats["2570"], ex0.actual_prev["2570"]], "restore: plans / stats / actual_prev equal the export taken before");
  }

  // ------------------------------------------------------------------------------------------------------------------------
  section("same-fy override import + requests follow the latest form (2t)");
  {
    const cl = (o) => JSON.parse(JSON.stringify(o));
    const items = (steps) => steps.flatMap((x) => x.rows.filter((r) => r.type === "item").map((r) => ({ ...r, step: x.code })));
    const findIt = (steps, code) => items(steps).find((r) => r.code === code);
    const r2 = (x) => Math.round(x * 100) / 100;
    await mustOk("adminSetLimitMode", { mode: "off" }, ADM2);
    const FY = (await mustOk("adminBootstrap", {}, ADM2)).config.fy_current, first = `${FY - 544}-11`;
    const devMonth0 = devMonth;
    devMonth = `${FY - 544}-12`; // calendar Dec → round Jan of FY (a round of fy_current)
    const b0 = await mustOk("adminBootstrap", {}, ADM2);
    const F0 = b0.form;
    const T4 = (await mustOk("pcuLogin", { pcu: "PCU04", pin: "12345" })).token;
    const R = (await mustOk("pcuBootstrap", {}, T4)).current_round;
    await mustOk("adminLockRound", { month: R, locked: 0 }, ADM2);
    const openSteps = F0.steps.filter((x) => x.active !== false);
    const act = items(openSteps).filter((i) => i.active !== false);
    const [A, B, C, D] = act;
    const sent = await api("saveLines", { month: R, lines: { [A.code]: { op: 3 }, [D.code]: { op: 1 } }, send: true }, T4);
    ok(sent.ok && sent.data.status === "submitted", "2t fixture: PCU04 sends A + D in the current round");
    const g0 = await mustOk("adminGetRequest", { pcu: "PCU04", month: R }, ADM2);
    const ppA = g0.request.lines[A.code].price_print;

    // ---- the file: export of the current fy, then edited ----
    const seed = (await mustOk("adminExportSeed", {}, ADM2)).seed;
    const st = seed.form.steps;
    const s0 = st.find((x) => x.code === openSteps[0].code);
    const newA = r2(findIt(F0.steps, A.code).price + 2);
    st.forEach((x) => x.rows.forEach((r) => { if (r.code === A.code) r.price = newA; if (r.code === B.code) r.name = B.name + " (ใหม่)"; }));
    st.forEach((x) => { x.rows = x.rows.filter((r) => r.code !== C.code && r.code !== D.code); });
    const dst = st.filter((x) => x.active !== false).find((x) => x.code !== C.step && x.rows.filter((r) => r.type === "item" && r.active !== false).length < 24);
    dst.rows.push({ type: "item", code: C.code, name: C.name, unit: C.unit, price: C.price, active: true });
    const NC = `${s0.code}-987`;
    s0.rows.push({ type: "item", code: NC, name: "รายการใหม่ override", unit: "ชิ้น", price: 5, active: true });
    s0.title = s0.title + " ฉบับใหม่";
    const pl = seed.plans[String(FY)];
    (pl.PCU04 ||= {})[A.code] = [100, 0];
    pl.PCU04[NC] = [12, 0];
    const [delPcu] = Object.keys(pl).filter((k) => k !== "PCU04" && Object.keys(pl[k]).length);
    const delCode = Object.keys(pl[delPcu])[0];
    delete pl[delPcu][delCode];
    delete seed.limits;

    // ---- preview ----
    const pv = await mustOk("adminImportPreview", { seed }, ADM2);
    const O = pv.summary.override;
    eq([pv.mode, pv.summary.form.version_action, O.version_action], ["same_fy", "override", "override"], "2t preview: same_fy, version_action override");
    ok(O.diff_counts.renamed >= 1 && O.diff_counts.moved >= 1 && O.diff_counts.items_added === 1 && O.diff_counts.items_closed === 1, "2t preview: diff counts (renamed / moved / added 1 / closed 1)");
    ok(O.requests_rebound >= 1, "2t preview: requests to re-bind ≥ 1");
    ok(O.price_backdate.items === 1 && O.price_backdate.lines >= 1 && O.price_backdate.requests >= 1, "2t preview: 1 price change back-dated over the whole fy (≥ 1 sent line)");
    eq([O.plans.upsert, O.plans.delete], [2, 1], "2t preview: plans upsert 2 (changed + new) · delete 1");
    ok(O.limits.upsert >= 1 && O.limits.source === "default", "2t preview: default limits for the new plan pair");
    ok(pv.warnings.some((x) => /ปิดแล้ว/.test(x)), "2t preview: warns that the dropped item is kept closed");

    // ---- guards ----
    expectErr(await api("adminImportOverride", { seed, confirm: "แทนที่" }, ADM2), "BAD_REQUEST", "2t: wrong confirm phrase");
    expectErr(await api("adminImportOverride", { seed: { ...seed, fy: FY + 1 }, confirm: `แทนที่ปีงบ ${FY + 1}` }, ADM2), "BAD_REQUEST", "2t: a file of another fy");
    expectErr(await api("adminImportOverride", { seed, confirm: `แทนที่ปีงบ ${FY}` }, T4), "FORBIDDEN", "2t: PCU token");
    expectErr(await api("adminImportOverride", { seed, confirm: `แทนที่ปีงบ ${FY}` }), "AUTH_REQUIRED", "2t: no token");

    // ---- apply ----
    const ap = await mustOk("adminImportOverride", { seed, confirm: `แทนที่ปีงบ ${FY}` }, ADM2);
    ok(ap.form_version_id > F0.id && ap.version_action === "override", "2t apply: new form version");
    eq(ap.override.requests_rebound, O.requests_rebound, "2t apply: re-bound = preview");
    const g1 = await mustOk("adminGetRequest", { pcu: "PCU04", month: R }, ADM2);
    eq(g1.form_version_id, ap.form_version_id, "2t: sent request now bound to the new version");
    ok(findIt(g1.form.steps, B.code).name === B.name + " (ใหม่)" && g1.form.steps.find((x) => x.code === s0.code).title === s0.title, "2t: admin sees the new wording (item name + page title)");
    ok(findIt(g1.form.steps, D.code).active === false && g1.request.lines[D.code].op === 1, "2t: dropped item kept closed, its sent line intact");
    ok(g1.form.steps.find((x) => x.code === dst.code).rows.some((r) => r.code === C.code), "2t: moved item is on its new page");
    eq([g1.request.lines[A.code].price_snapshot, g1.request.lines[A.code].price_print], [newA, ppA], "2t: price back-dated on the sent line (snapshot) · printed price unchanged");
    const pg = await mustOk("pcuGetMonth", { month: R }, T4);
    ok(!("form" in pg) && pg.request.form_version_id === ap.form_version_id, "2t: PCU side follows the latest form too");
    const hist = (await mustOk("adminFormGet", { id: ap.form_version_id }, ADM2)).price_history.filter((h) => h.code === A.code).map((h) => [h.from_round, h.price]);
    eq(hist, [[first, newA]], "2t: price_history of the changed item = one row at the fy's first round");
    const ex = (await mustOk("adminExportSeed", {}, ADM2)).seed;
    eq([ex.plans[String(FY)].PCU04[A.code], ex.plans[String(FY)].PCU04[NC], ex.plans[String(FY)][delPcu] && ex.plans[String(FY)][delPcu][delCode]], [[100, 0], [12, 0], undefined], "2t: plans upserted / deleted");
    ok(ex.limits[String(FY)].PCU04 && ex.limits[String(FY)].PCU04[NC], "2t: limits row for the new plan pair");
    const aud = (await mustOk("adminAuditLog", { limit: 30 }, ADM2)).entries.find((e) => e.action === "form_override");
    const ad = aud ? JSON.parse(aud.detail) : {};
    ok(aud && ad.id === ap.form_version_id && ad.rebound === O.requests_rebound && ad.plans.upsert === 2, "2t: audit form_override");

    // ---- the same file again: nothing left to do ----
    const pv2 = await mustOk("adminImportPreview", { seed }, ADM2);
    const O2 = pv2.summary.override;
    eq([O2.version_action, O2.price_backdate.items, O2.plans.upsert, O2.plans.delete, O2.limits.upsert], ["same", 0, 0, 0, 0], "2t: re-preview of the same file → nothing to change");
    const ap2 = await mustOk("adminImportOverride", { seed, confirm: `แทนที่ปีงบ ${FY}` }, ADM2);
    ok(ap2.form_version_id === null && ap2.version_action === "same", "2t: re-apply creates no version");

    // ---- the form editor re-binds too ----
    const F2 = (await mustOk("adminBootstrap", {}, ADM2)).form;
    const st2 = cl(F2.steps);
    st2.forEach((x) => x.rows.forEach((r) => { if (r.code === A.code) r.name = A.name + " (editor)"; }));
    const sv = await mustOk("adminFormSave", { base_version_id: F2.id, note: "2t rename", form: { steps: st2 } }, ADM2);
    const g2 = await mustOk("adminGetRequest", { pcu: "PCU04", month: R }, ADM2);
    ok(g2.form_version_id === sv.form.id && findIt(g2.form.steps, A.code).name === A.name + " (editor)", "2t: adminFormSave re-binds the fy's requests to the new version");
    devMonth = devMonth0;
  }

  // ------------------------------------------------------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
}

let exitCode = 0;
try { await main(); exitCode = fail ? 1 : 0; }
catch (e) { console.log("FATAL " + (e && e.stack || e)); exitCode = 1; }
finally { stopServer(); }
process.exit(exitCode);
