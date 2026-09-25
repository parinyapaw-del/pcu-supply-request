#!/usr/bin/env node
// test_api.mjs — plain-assert test suite for the apps-script backend, run through gas_mock.mjs
// against a FRESH in-memory instance (never touches tools/.devstate.json). No test framework:
// prints "PASS ..." / "FAIL ..." lines and exits non-zero if anything failed.
//
// Usage: node webapp/tools/test_api.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, freshState } from "./gas_mock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_DIR = path.resolve(__dirname, "..");
const APPS_SCRIPT_DIR = path.join(WEBAPP_DIR, "apps-script");
const SEED_PATH = path.resolve(WEBAPP_DIR, "..", "phase15_seed", "seed_2568.json");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log("PASS " + label); }
  else { fail++; console.log("FAIL " + label); }
}
function okEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, label + (a === e ? "" : ` (got ${a}, expected ${e})`));
}

// ---------------------------------------------------------------------------------------------
const state = freshState();
const rt = createRuntime({ appsScriptDir: APPS_SCRIPT_DIR, state });

function post(obj) {
  const out = rt.call("doPost", { postData: { contents: JSON.stringify(obj), type: "text/plain" }, parameter: {} });
  return JSON.parse(out.getContent());
}

console.log("=== setup() ===");
rt.call("setup");
ok(fs.existsSync(path.join(APPS_SCRIPT_DIR, "_seed.html")), "seed file present (run tools/make_seed_html.py first)");

const seed = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));

// =================================================================================================
console.log("\n=== pcuList / pcuLogin ===");
{
  const list = post({ action: "pcuList" });
  ok(list.ok, "pcuList ok");
  ok(Array.isArray(list.data.pcus) && list.data.pcus.length === 15, "pcuList returns 15 pcus");

  const login = post({ action: "pcuLogin", pcu: "PCU01", pin: "12345" });
  ok(login.ok, "pcuLogin PCU01 12345 ok");
  ok(!!login.data.token && !!login.data.exp, "pcuLogin returns token+exp");
  ok(login.data.pcu.code === "PCU01", "pcuLogin returns pcu info");
}

// =================================================================================================
console.log("\n=== PIN lockout ===");
{
  let lastErr;
  for (let i = 0; i < 5; i++) {
    const r = post({ action: "pcuLogin", pcu: "PCU02", pin: "00000" });
    lastErr = r;
  }
  ok(!lastErr.ok && lastErr.error.code === "PIN_LOCKED" && !!lastErr.error.until, "5x wrong PIN -> PIN_LOCKED with until");

  const stillLocked = post({ action: "pcuLogin", pcu: "PCU02", pin: "12345" });
  ok(!stillLocked.ok && stillLocked.error.code === "PIN_LOCKED", "correct PIN still locked during lock window");

  const adminTok0 = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const unlock = post({ action: "adminUnlockPin", token: adminTok0, pcu: "PCU02" });
  ok(unlock.ok && unlock.data.ok === true, "adminUnlockPin ok");

  const afterUnlock = post({ action: "pcuLogin", pcu: "PCU02", pin: "12345" });
  ok(afterUnlock.ok, "pcuLogin works again after adminUnlockPin");
}

// =================================================================================================
console.log("\n=== token isolation (PCU01 cannot touch PCU02) ===");
{
  const tok1 = post({ action: "pcuLogin", pcu: "PCU01", pin: "12345" }).data.token;
  // PCU actions take NO pcu parameter at all — token alone determines the pcu. Smuggling a `pcu`
  // param must have zero effect: the write still lands on PCU01, never PCU02.
  const save = post({ action: "saveLines", token: tok1, pcu: "PCU02", month: "2025-09", lines: { "P1-01": { stock: 1, op: 0, pp: 0, updated_at: new Date().toISOString() } } });
  ok(save.ok && save.data.request.pcu === "PCU01", "saveLines with token=PCU01 always writes pcu=PCU01, ignoring a smuggled `pcu` param");

  const boot2 = post({ action: "pcuBootstrap", token: post({ action: "pcuLogin", pcu: "PCU02", pin: "12345" }).data.token });
  const pcu02SepLines = boot2.data.byRound["2025-09"].request;
  ok(!pcu02SepLines || !pcu02SepLines.lines || !pcu02SepLines.lines["P1-01"] || pcu02SepLines.lines["P1-01"].stock !== 1,
    "PCU02's own data was not touched by PCU01's saveLines call");
}

// =================================================================================================
console.log("\n=== pcuBootstrap shapes + numbers vs seed_2568.json ===");
{
  function expectedSep(pcu, code) {
    const a = (seed.actual[pcu] || {})[code];
    const stockArr = (seed.stock_sim[pcu] || {})[code];
    const op = a ? a.op[10] : 0, pp = a ? a.pp[10] : 0;
    const stock = stockArr ? stockArr[10] : 0;
    const plan = (seed.plan[pcu] || {})[code] || null;
    let usedFy = 0;
    if (a) for (let i = 0; i <= 10; i++) usedFy += (a.op[i] || 0) + (a.pp[i] || 0);
    return { op, pp, stock, plan, usedFy };
  }

  const samplePcus = ["PCU01", "PCU05", "PCU10"];
  let allGood = true;
  const details = [];
  samplePcus.forEach((pcu) => {
    const tok = post({ action: "pcuLogin", pcu, pin: pcu === "PCU02" ? "12345" : "12345" }).data.token;
    const boot = post({ action: "pcuBootstrap", token: tok });
    const codes = Object.keys(seed.actual[pcu] || {}).slice(0, 5);
    codes.forEach((code) => {
      const exp = expectedSep(pcu, code);
      const gotItem = boot.data.byRound["2025-09"].prev.items[code] || { op: 0, pp: 0, stock: 0 };
      const gotPlan = boot.data.byRound["2025-09"].plan[code] || null;
      const gotUsedFy = boot.data.byRound["2025-09"].used_fy[code] || 0;
      const good = gotItem.op === exp.op && gotItem.pp === exp.pp && gotItem.stock === exp.stock &&
        JSON.stringify(gotPlan) === JSON.stringify(exp.plan) && gotUsedFy === exp.usedFy;
      if (!good) { allGood = false; details.push({ pcu, code, exp, got: { item: gotItem, plan: gotPlan, usedFy: gotUsedFy } }); }
    });
  });
  ok(allGood, "pcuBootstrap 2025-09 prev/plan/used_fy match seed for 3 pcus x 5 codes" + (allGood ? "" : " " + JSON.stringify(details.slice(0, 3))));
}

// =================================================================================================
console.log("\n=== saveLines upsert + LWW + last_step persisted across devices ===");
{
  const tokDeviceA = post({ action: "pcuLogin", pcu: "PCU03", pin: "12345" }).data.token;
  const t1 = new Date(Date.now() - 60000).toISOString();
  const save1 = post({ action: "saveLines", token: tokDeviceA, month: "2025-09", last_step: "P2", lines: { "P1-01": { stock: 5, op: 1, pp: 0, updated_at: t1 } } });
  ok(save1.ok && save1.data.request.lines["P1-01"].stock === 5, "saveLines creates draft + line");

  const tOlder = new Date(Date.parse(t1) - 30000).toISOString(); // older than t1 -> must be ignored
  const save2 = post({ action: "saveLines", token: tokDeviceA, month: "2025-09", lines: { "P1-01": { stock: 999, op: 9, pp: 9, updated_at: tOlder } } });
  ok(save2.ok && save2.data.request.lines["P1-01"].stock === 5, "older updated_at is ignored (last-write-wins keeps newer value)");

  const tNewer = new Date(Date.parse(t1) + 30000).toISOString();
  const save3 = post({ action: "saveLines", token: tokDeviceA, month: "2025-09", lines: { "P1-01": { stock: 7, op: 2, pp: 0, updated_at: tNewer } } });
  ok(save3.ok && save3.data.request.lines["P1-01"].stock === 7, "newer updated_at overwrites");

  // "second device" = a brand new login token for the same PCU
  const tokDeviceB = post({ action: "pcuLogin", pcu: "PCU03", pin: "12345" }).data.token;
  const boot = post({ action: "pcuBootstrap", token: tokDeviceB });
  const req = boot.data.byRound["2025-09"].request;
  ok(req.last_step === "P2", "last_step persisted and visible from a second device/token");
  ok(req.lines["P1-01"].stock === 7, "line values visible from a second device/token");
}

// =================================================================================================
console.log("\n=== submit: INCOMPLETE, hidden, ok ===");
{
  const tok = post({ action: "pcuLogin", pcu: "PCU04", pin: "12345" }).data.token;
  const submitEmpty = post({ action: "submit", token: tok, month: "2025-09" });
  ok(!submitEmpty.ok && submitEmpty.error.code === "INCOMPLETE" && Array.isArray(submitEmpty.error.missing) && submitEmpty.error.missing.length === 125,
    "submit with nothing filled -> INCOMPLETE listing all 125 codes");

  const allCodes = rt.sandbox.ITEM_CODES;
  const hideCodes = allCodes.slice(0, 10);
  const setH = post({ action: "setHidden", token: tok, codes: hideCodes });
  ok(setH.ok && setH.data.hidden.length === 10, "setHidden hides 10 items");

  const submitStillMissing = post({ action: "submit", token: tok, month: "2025-09" });
  ok(!submitStillMissing.ok && submitStillMissing.error.code === "INCOMPLETE" && submitStillMissing.error.missing.length === 115,
    "submit missing count excludes hidden items (125-10=115)");

  const remaining = allCodes.filter((c) => !hideCodes.includes(c));
  const lines = {};
  const now = new Date().toISOString();
  remaining.forEach((c) => { lines[c] = { stock: 0, op: 0, pp: 0, updated_at: now }; });
  const fill = post({ action: "saveLines", token: tok, month: "2025-09", lines });
  ok(fill.ok, "saveLines fills remaining 115 items with stock=0");

  const submitOk = post({ action: "submit", token: tok, month: "2025-09" });
  ok(submitOk.ok && submitOk.data.request.status === "submitted", "submit ok after filling all non-hidden items");
}

// =================================================================================================
console.log("\n=== withdraw / admin receive / conflicts ===");
{
  const tok = post({ action: "pcuLogin", pcu: "PCU04", pin: "12345" }).data.token;
  const withdrawn = post({ action: "withdraw", token: tok, month: "2025-09" });
  ok(withdrawn.ok && withdrawn.data.request.status === "draft", "withdraw returns to draft");

  const resubmit = post({ action: "submit", token: tok, month: "2025-09" });
  ok(resubmit.ok && resubmit.data.request.status === "submitted", "resubmit ok");

  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const received = post({ action: "adminReceive", token: adminTok, pcu: "PCU04", month: "2025-09" });
  ok(received.ok && received.data.request.status === "received", "adminReceive -> received");

  const withdrawAfterReceive = post({ action: "withdraw", token: tok, month: "2025-09" });
  ok(!withdrawAfterReceive.ok && withdrawAfterReceive.error.code === "CONFLICT", "withdraw after received -> CONFLICT");

  const saveAfterReceive = post({ action: "saveLines", token: tok, month: "2025-09", lines: { "P1-01": { stock: 1, op: 0, pp: 0, updated_at: new Date().toISOString() } } });
  ok(!saveAfterReceive.ok && saveAfterReceive.error.code === "CONFLICT", "saveLines after received -> CONFLICT");
}

// =================================================================================================
console.log("\n=== admin return + reason + resubmit clears it ===");
{
  const tok = post({ action: "pcuLogin", pcu: "PCU05", pin: "12345" }).data.token;
  const now = new Date().toISOString();
  const lines = {};
  rt.sandbox.ITEM_CODES.forEach((c) => { lines[c] = { stock: 0, op: 0, pp: 0, updated_at: now }; });
  post({ action: "saveLines", token: tok, month: "2025-09", lines });
  post({ action: "submit", token: tok, month: "2025-09" });

  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const ret = post({ action: "adminReturn", token: adminTok, pcu: "PCU05", month: "2025-09", reason: "กรอกไม่ครบ" });
  ok(ret.ok && ret.data.request.status === "draft" && ret.data.request.return_reason === "กรอกไม่ครบ", "adminReturn -> draft + reason");

  const boot = post({ action: "pcuBootstrap", token: tok });
  ok(boot.data.byRound["2025-09"].request.return_reason === "กรอกไม่ครบ", "return_reason visible in pcuBootstrap");

  const resubmit = post({ action: "submit", token: tok, month: "2025-09" });
  ok(resubmit.ok && resubmit.data.request.return_reason === "", "resubmit clears return_reason");
}

// =================================================================================================
console.log("\n=== limit mode: enforce -> OVER_LIMIT, warn -> ok ===");
{
  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const tok = post({ action: "pcuLogin", pcu: "PCU06", pin: "12345" }).data.token;

  const setLim = post({ action: "adminSetLimit", token: adminTok, pcu: "PCU06", code: "P1-01", limit_month: 3, limit_year: 1000 });
  ok(setLim.ok && setLim.data.limit.limit_month === 3, "adminSetLimit sets limit_month=3");

  const modeEnforce = post({ action: "adminSetMode", token: adminTok, mode: "enforce" });
  ok(modeEnforce.ok && modeEnforce.data.config.limit_mode === "enforce", "adminSetMode enforce");

  const now = new Date().toISOString();
  const lines = {}; rt.sandbox.ITEM_CODES.forEach((c) => { lines[c] = { stock: 0, op: 0, pp: 0, updated_at: now }; });
  lines["P1-01"] = { stock: 0, op: 10, pp: 0, updated_at: now }; // 10 > limit_month 3
  post({ action: "saveLines", token: tok, month: "2025-09", lines });
  const overSubmit = post({ action: "submit", token: tok, month: "2025-09" });
  ok(!overSubmit.ok && overSubmit.error.code === "OVER_LIMIT" && overSubmit.error.items.some((i) => i.code === "P1-01"),
    "enforce mode: submit OVER_LIMIT when exceeding limit_month");

  const modeWarn = post({ action: "adminSetMode", token: adminTok, mode: "warn" });
  ok(modeWarn.ok && modeWarn.data.config.limit_mode === "warn", "adminSetMode back to warn");
  const warnSubmit = post({ action: "submit", token: tok, month: "2025-09" });
  ok(warnSubmit.ok, "warn mode: same over-limit request submits fine");
}

// =================================================================================================
console.log("\n=== adminSetLimit / adminResetLimit / pcuBootstrap reflects it ===");
{
  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const tok = post({ action: "pcuLogin", pcu: "PCU07", pin: "12345" }).data.token;

  post({ action: "adminSetLimit", token: adminTok, pcu: "PCU07", code: "P1-02", limit_month: 42, limit_year: 500 });
  const boot1 = post({ action: "pcuBootstrap", token: tok });
  okEq(boot1.data.limits["P1-02"], [42, 500], "pcuBootstrap.limits reflects adminSetLimit after reload");

  const statsRow = (seed.stats["PCU07"] || {})["P1-02"];
  const resetRes = post({ action: "adminResetLimit", token: adminTok, pcu: "PCU07", code: "P1-02" });
  ok(resetRes.ok, "adminResetLimit ok");
  const boot2 = post({ action: "pcuBootstrap", token: tok });
  const expLm = statsRow ? (Math.ceil(statsRow[1] - 1e-9) || null) : null;
  const expLy = statsRow ? (Math.ceil(statsRow[2] - 1e-9) || null) : null;
  okEq(boot2.data.limits["P1-02"] || [null, null], [expLm, expLy], "adminResetLimit restores ceil(P90)/ceil(annual) from seed stats");
}

// =================================================================================================
console.log("\n=== adminSetPin invalidates old token ===");
{
  const oldTok = post({ action: "pcuLogin", pcu: "PCU08", pin: "12345" }).data.token;
  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const setPin = post({ action: "adminSetPin", token: adminTok, pcu: "PCU08", pin: "54321" });
  ok(setPin.ok, "adminSetPin ok");

  const useOld = post({ action: "pcuBootstrap", token: oldTok });
  ok(!useOld.ok && (useOld.error.code === "AUTH_EXPIRED" || useOld.error.code === "FORBIDDEN"), "old token rejected after PIN change (AUTH_EXPIRED/FORBIDDEN)");

  const oldPinLogin = post({ action: "pcuLogin", pcu: "PCU08", pin: "12345" });
  ok(!oldPinLogin.ok, "old PIN no longer works");
  const newPinLogin = post({ action: "pcuLogin", pcu: "PCU08", pin: "54321" });
  ok(newPinLogin.ok, "new PIN works");
}

// =================================================================================================
console.log("\n=== setHidden / adminSetHidden round-trip ===");
{
  const tok = post({ action: "pcuLogin", pcu: "PCU09", pin: "12345" }).data.token;
  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  post({ action: "setHidden", token: tok, codes: ["P1-01", "P1-02"] });
  const viaAdmin = post({ action: "adminBootstrap", token: adminTok });
  okEq((viaAdmin.data.hidden["PCU09"] || []).sort(), ["P1-01", "P1-02"], "PCU-set hidden visible to admin");

  post({ action: "adminSetHidden", token: adminTok, pcu: "PCU09", codes: ["P1-03"] });
  const boot = post({ action: "pcuBootstrap", token: tok });
  okEq(boot.data.hidden, ["P1-03"], "adminSetHidden replaces PCU's hidden list (round-trip visible to PCU)");
}

// =================================================================================================
console.log("\n=== round 2025-10 prev switches to trial after Sep submitted ===");
{
  const tok = post({ action: "pcuLogin", pcu: "PCU10", pin: "12345" }).data.token;
  const bootBefore = post({ action: "pcuBootstrap", token: tok });
  const beforeSrc = (bootBefore.data.byRound["2025-10"].prev.items["P1-01"] || {}).stock_src;
  ok(beforeSrc === "sim" || beforeSrc === undefined, "2025-10 prev is sim-sourced before Sep is submitted");

  const now = new Date().toISOString();
  const lines = {}; rt.sandbox.ITEM_CODES.forEach((c) => { lines[c] = { stock: 3, op: 7, pp: 1, updated_at: now }; });
  post({ action: "saveLines", token: tok, month: "2025-09", lines });
  post({ action: "submit", token: tok, month: "2025-09" });

  const bootAfter = post({ action: "pcuBootstrap", token: tok });
  const afterItem = bootAfter.data.byRound["2025-10"].prev.items["P1-01"];
  ok(afterItem && afterItem.stock_src === "trial" && afterItem.stock === 3 && afterItem.op === 7 && afterItem.pp === 1,
    "2025-10 prev switches to trial (Sep's submitted lines) once Sep is submitted");
}

// =================================================================================================
console.log("\n=== admin Google login allow/deny ===");
{
  const okLogin = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" });
  ok(okLogin.ok, "adminLoginGoogle parinya.paw@gmail.com ok");
  const denied = post({ action: "adminLoginGoogle", id_token: "dev:save.independent@gmail.com" });
  ok(!denied.ok && denied.error.code === "FORBIDDEN", "adminLoginGoogle non-admin email -> FORBIDDEN");
}

// =================================================================================================
console.log("\n=== backup password ===");
{
  const googleTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const noBackupYet = post({ action: "adminLoginBackup", password: "whatever1" });
  ok(!noBackupYet.ok && noBackupYet.error.code === "NOT_FOUND", "adminLoginBackup before it's set -> NOT_FOUND");

  const setBackup = post({ action: "adminSetBackupPassword", token: googleTok, password: "sup3rSecret!" });
  ok(setBackup.ok, "adminSetBackupPassword (google admin) ok");

  const backupTok = post({ action: "adminLoginBackup", password: "sup3rSecret!" }).data.token;
  ok(!!backupTok, "adminLoginBackup with correct password works");

  const backupCannotSetBackup = post({ action: "adminSetBackupPassword", token: backupTok, password: "anotherPassw0rd" });
  ok(!backupCannotSetBackup.ok && backupCannotSetBackup.error.code === "FORBIDDEN", "adminSetBackupPassword via backup token -> FORBIDDEN (google admin only)");

  let lastFail;
  for (let i = 0; i < 5; i++) lastFail = post({ action: "adminLoginBackup", password: "wrong-password" });
  ok(!lastFail.ok && lastFail.error.code === "LOCKED" && !!lastFail.error.until, "5x wrong backup password -> LOCKED");
}

// =================================================================================================
console.log("\n=== adminBootstrap network totals ===");
{
  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const t0 = Date.now();
  const ab = post({ action: "adminBootstrap", token: adminTok });
  const elapsedMs = Date.now() - t0;
  ok(ab.ok, "adminBootstrap ok");

  let opTotal = 0, ppTotal = 0;
  Object.keys(ab.data.actual).forEach((pcu) => {
    Object.keys(ab.data.actual[pcu]).forEach((code) => {
      const price = ab.data.price_2568[code] !== undefined ? ab.data.price_2568[code] : ((ab.data.items_extra[code] || {}).price_2568 || 0);
      const a = ab.data.actual[pcu][code];
      for (let i = 0; i < 12; i++) { opTotal += a.op[i] * price; ppTotal += a.pp[i] * price; }
    });
  });
  opTotal = Math.round(opTotal * 100) / 100;
  ppTotal = Math.round(ppTotal * 100) / 100;
  ok(Math.abs(opTotal - 413041.11) < 0.01, `adminBootstrap OP total = ${opTotal} (expect 413041.11)`);
  ok(Math.abs(ppTotal - 137014.98) < 0.01, `adminBootstrap PP total = ${ppTotal} (expect 137014.98)`);

  const bytes = Buffer.byteLength(JSON.stringify(ab), "utf8");
  console.log(`INFO adminBootstrap payload size: ${bytes.toLocaleString()} bytes (built in ${elapsedMs}ms)`);
}

// =================================================================================================
console.log("\n=== adminClearTrial keeps limits/hidden/pins, deletes requests ===");
{
  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const beforeReq = post({ action: "adminRequests", token: adminTok });
  ok(beforeReq.data.requests.length > 0, "there are requests before clearing (sanity)");

  const bad = post({ action: "adminClearTrial", token: adminTok, confirm: "wrong" });
  ok(!bad.ok && bad.error.code === "BAD_REQUEST", "adminClearTrial without exact confirm text -> BAD_REQUEST");

  const limitBefore = post({ action: "pcuBootstrap", token: post({ action: "pcuLogin", pcu: "PCU07", pin: "12345" }).data.token }).data.limits["P1-02"];
  const clear = post({ action: "adminClearTrial", token: adminTok, confirm: "ล้างข้อมูล" });
  ok(clear.ok && clear.data.deleted_requests > 0, "adminClearTrial deletes requests");

  const afterReq = post({ action: "adminRequests", token: adminTok });
  ok(afterReq.data.requests.length === 0, "no requests remain after adminClearTrial");

  const pcu07Tok = post({ action: "pcuLogin", pcu: "PCU07", pin: "12345" }); // PIN still works
  ok(pcu07Tok.ok, "PINs survive adminClearTrial");
  const limitAfter = post({ action: "pcuBootstrap", token: pcu07Tok.data.token }).data.limits["P1-02"];
  okEq(limitAfter, limitBefore, "limits survive adminClearTrial");

  const pcu08NewPin = post({ action: "pcuLogin", pcu: "PCU08", pin: "54321" });
  ok(pcu08NewPin.ok, "PCU08's admin-changed PIN also survives adminClearTrial");
}

// =================================================================================================
console.log("\n=== setup() re-run is idempotent (edited limit & changed PIN survive) ===");
{
  rt.call("setup");
  const pcu08Login = post({ action: "pcuLogin", pcu: "PCU08", pin: "54321" });
  ok(pcu08Login.ok, "PCU08 changed PIN survives setup() re-run");

  const pcu07Tok = post({ action: "pcuLogin", pcu: "PCU07", pin: "12345" }).data.token;
  const limitAfterSetup = post({ action: "pcuBootstrap", token: pcu07Tok }).data.limits["P1-02"];
  ok(limitAfterSetup !== undefined, "limit for PCU07/P1-02 still present after setup() re-run");
}

// =================================================================================================
console.log("\n=== audit_log has rows ===");
{
  const auditSheet = state.sheets["audit_log"];
  ok(auditSheet && auditSheet.data.length > 10, "audit_log has many rows (header + actions)");
  const actions = auditSheet.data.slice(1).map((r) => r[2]);
  ["pcuLogin", "saveLines", "submit", "adminSetLimit", "adminSetPin", "adminReceive", "adminReturn", "adminClearTrial"].forEach((a) => {
    ok(actions.includes(a), `audit_log contains at least one "${a}" row`);
  });
}

// =================================================================================================
console.log("\n=== adminGetRequest (admin reprint) ===");
{
  const adminTok = post({ action: "adminLoginGoogle", id_token: "dev:parinya.paw@gmail.com" }).data.token;
  const tok = post({ action: "pcuLogin", pcu: "PCU12", pin: "12345" }).data.token;

  const beforeAny = post({ action: "adminGetRequest", token: adminTok, pcu: "PCU12", month: "2025-09" });
  ok(beforeAny.ok && beforeAny.data.request === null && beforeAny.data.pcu.code === "PCU12", "adminGetRequest returns request:null before any saveLines");

  const now = new Date().toISOString();
  const lines = { "P1-01": { stock: 4, op: 2, pp: 0, updated_at: now } };
  post({ action: "saveLines", token: tok, month: "2025-09", last_step: "P1", lines });
  post({ action: "setHidden", token: tok, codes: ["LAB-01"] });

  const after = post({ action: "adminGetRequest", token: adminTok, pcu: "PCU12", month: "2025-09" });
  ok(after.ok && after.data.request && after.data.request.lines["P1-01"].stock === 4, "adminGetRequest returns the PCU's request+lines");
  okEq(after.data.hidden, ["LAB-01"], "adminGetRequest returns the PCU's hidden list");

  const wrongPcu = post({ action: "adminGetRequest", token: adminTok, pcu: "NOPE", month: "2025-09" });
  ok(!wrongPcu.ok && wrongPcu.error.code === "NOT_FOUND", "adminGetRequest with unknown pcu -> NOT_FOUND");

  const pcuTokenDenied = post({ action: "adminGetRequest", token: tok, pcu: "PCU12", month: "2025-09" });
  ok(!pcuTokenDenied.ok && pcuTokenDenied.error.code === "FORBIDDEN", "adminGetRequest with a PCU token (not admin) -> FORBIDDEN");
}

// =================================================================================================
console.log("\n=== token tampering / expiry ===");
{
  const tok = post({ action: "pcuLogin", pcu: "PCU11", pin: "12345" }).data.token;
  const parts = tok.split(".");
  const tamperedPartA = parts[0].slice(0, -1) + (parts[0].slice(-1) === "A" ? "B" : "A");
  const tampered = tamperedPartA + "." + parts[1];
  const tamperedRes = post({ action: "pcuBootstrap", token: tampered });
  ok(!tamperedRes.ok && tamperedRes.error.code.indexOf("AUTH_") === 0, "tampered token -> AUTH_* error");

  // Craft a token with a valid signature but an already-past exp, using the backend's own signer.
  const expiredToken = rt.sandbox.signToken_({ t: "pcu", pcu: "PCU11", v: 1, exp: Date.now() - 1000 });
  const expiredRes = post({ action: "pcuBootstrap", token: expiredToken });
  ok(!expiredRes.ok && expiredRes.error.code === "AUTH_EXPIRED", "expired (but validly-signed) token -> AUTH_EXPIRED");

  const noToken = post({ action: "pcuBootstrap" });
  ok(!noToken.ok && noToken.error.code === "AUTH_REQUIRED", "missing token -> AUTH_REQUIRED");
}

// =================================================================================================
console.log("\n=== sheet growth + text formats (real-Sheets behaviour) ===");
{
  // audit_log past the initial 1000-row grid must keep working (getRange beyond maxRows throws in Sheets)
  for (let i = 0; i < 1100; i++) rt.sandbox.auditLog_("test", "bulk", "PCU01", "2025-09", "i=" + i);
  rt.sandbox.resetDbCache_();
  const n = rt.sandbox.readTable_("audit_log").length;
  ok(n > 1100, `audit_log grows past 1000 rows (${n})`);
  // month keys / timestamps survive a round-trip as strings (not Dates)
  const act = rt.sandbox.readTable_("actual_2568");
  ok(act.length > 1000 && act.every((r) => typeof r.month === "string" && /^\d{4}-\d{2}$/.test(r.month)), "actual_2568 months read back as 'YYYY-MM' strings");
  const reqs = rt.sandbox.readTable_("requests");
  ok(reqs.every((r) => typeof r.updated_at === "string"), "request timestamps read back as strings");
}

// =================================================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
