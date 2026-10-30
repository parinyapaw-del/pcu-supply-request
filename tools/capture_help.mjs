#!/usr/bin/env node
// capture_help.mjs — one command → every user-manual screenshot (2ac) + the number-mark positions.
//
//   node tools/capture_help.mjs              (needs Google Chrome; CHROME_PATH overrides the default macOS path)
//   node tools/capture_help.mjs --serve      (dev aid: set up the fake data, print the URL, keep :8791 running until Ctrl-C)
//
// Starts its own `wrangler pages dev` on :8791 with a throw-away state (.wrangler/capture-state, wiped first) — never :8788.
// Data = synthetic only: item names / prices come from public/data/form2569.json; every quantity, usage, plan, ceiling and
// dashboard number is a deterministic fake (seeded random). seed/seed_2570.json (real plan / usage data) is never read.
// Writes public/help/img/<id>_<n>.png (1280 px wide, deviceScaleFactor 1) and public/help/shots.json =
// {<img>: {w, h, marks: {<sel_key>: {x, y, w, h}}}} — boxes from getBoundingClientRect of the selectors below, relative to the image.
// A selector that matches nothing fails the run with its name (no hand-placed coordinates).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const PORT = 8791;
const BASE = `http://localhost:${PORT}`;
const STATE = path.join(REPO, ".wrangler", "capture-state");
const OUT_DIR = path.join(REPO, "public", "help", "img");
const SHOTS_JSON = path.join(REPO, "public", "help", "shots.json");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVE = process.argv.includes("--serve");

// Pinned calendar month (X-Dev-Month): Dec 2569 → open round "ขอเบิก ม.ค. 70" (keyed in Dec), rounds Oct–Dec 69 already sent.
const CAL = "2026-12";
const OPEN = "2027-01", SENT = ["2026-10", "2026-11", "2026-12"];
const calOf = (round) => shiftMonth(round, -1); // a round X is keyed during X−1 (brief 2j)
const ADMIN = "admin@example.com";
const DISP = "dispenser@example.com"; // พัสดุ + จ่ายกลาง + LAB
const DEMO = "PCU00"; // the unit every PCU screenshot shows ("ทดลอง")
const PIN = "12345";

// ---- deterministic fake numbers ------------------------------------------------------------------------------------
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(2570);
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const shiftMonth = (k, d) => { const [y, m] = k.split("-").map(Number); const n = y * 12 + (m - 1) + d; return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`; };
const fyExcelMonths = (fy) => { const out = []; let k = `${fy - 543 - 1}-10`; for (let i = 0; i < 12; i++) { out.push(k); k = shiftMonth(k, 1); } return out; };

function buildFakeSeed() {
  const f = JSON.parse(fs.readFileSync(path.join(REPO, "public", "data", "form2569.json"), "utf8"));
  const steps = f.steps.map((s) => ({
    ...s,
    dispense_unit: s.code === "CS" ? "จ่ายกลาง" : s.code === "LAB" ? "LAB" : "พัสดุ",
    rows: s.rows.map((r) => (r.type === "item" ? { ...r, active: true } : r)),
  }));
  const items = steps.flatMap((s) => s.rows.filter((r) => r.type === "item"));
  const pcus = [...f.pcus, { code: DEMO, name: "ทดลอง", print_name: "ทดลอง", group: "ทดลอง" }];
  const months69 = fyExcelMonths(2569);
  const plans70 = {}, plans69 = {}, actual = {}, stats = {}, limits = {};
  for (const p of pcus) {
    plans70[p.code] = {}; plans69[p.code] = {}; actual[p.code] = {}; stats[p.code] = {}; limits[p.code] = {};
    items.forEach((it, j) => {
      if (rnd() < 0.45) {
        const plan = [ri(2, 14), ri(0, 6)];
        plans70[p.code][it.code] = plan;
        plans69[p.code][it.code] = [ri(2, 12), ri(0, 4)];
        const op = months69.map(() => (rnd() < 0.5 ? ri(1, 3) : 0));
        const pp = months69.map(() => (rnd() < 0.2 ? 1 : 0));
        actual[p.code][it.code] = { op, pp };
        const sums = op.map((v, m) => v + pp[m]).sort((a, b) => a - b);
        const tot = sums.reduce((a, b) => a + b, 0);
        stats[p.code][it.code] = [sums[6], sums[10], tot];
        limits[p.code][it.code] = [Math.max(2, sums[10]), plan[0] + plan[1], "plan70"];
      }
    });
    // the demo unit: a low yearly plan on P1-03 → the light-yellow "เกินแผน" row in the fill-page screenshot (the ceiling is off, 2ad)
    if (p.code === DEMO) { plans70[DEMO]["P1-03"] = [2, 0]; limits[DEMO]["P1-03"] = [1, 2, "plan70"]; }
  }
  const prices = Object.fromEntries(items.map((it) => [it.code, Math.round(it.price * 0.95 * 100) / 100]));
  return {
    format: "pcu-supply-import/1", fy: 2570, generated_at: "2026-10-01T00:00:00Z", generated_by: "tools/capture_help.mjs (fake)",
    pcus,
    form: { fy: 2570, note: "แบบฟอร์มตัวอย่าง (คู่มือ)", steps },
    plans: { 2570: plans70, 2569: plans69 },
    prices_prev: { 2569: prices },
    actual_prev: { 2569: { months: months69, data: actual } },
    stats: { 2569: stats },
    limits: { 2570: limits },
    config: { fy_current: 2570, limit_mode: "warn", stock_required: 0, budget_op: 500000, budget_pp: 300000, budget_total: 800000, deadline_day: null },
  };
}

// ---- server + api --------------------------------------------------------------------------------------------------
let server = null, serverLog = "";
async function reachable() { try { return (await fetch(BASE + "/api")).ok; } catch { return false; } }
async function startServer() {
  if (await reachable()) throw new Error(`something already listens on :${PORT} — stop it first (the capture needs a throw-away state)`);
  fs.rmSync(STATE, { recursive: true, force: true });
  console.log(`starting wrangler pages dev on :${PORT} (persist: .wrangler/capture-state, fresh) …`);
  server = spawn("npx", ["wrangler", "pages", "dev", "public", "--local", "--port", String(PORT), "--r2", "FILES", "--persist-to", STATE], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  server.stdout.on("data", (d) => (serverLog += d)); server.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 120; i++) { if (await reachable()) return; await new Promise((r) => setTimeout(r, 500)); }
  console.log(serverLog.slice(-2000));
  throw new Error("wrangler did not become ready");
}
function stopServer() {
  if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ } server = null; }
}

async function api(action, params = {}, token, month = CAL) {
  const res = await fetch(BASE + "/api", {
    method: "POST", headers: { "content-type": "text/plain;charset=utf-8", "x-dev-month": month },
    body: JSON.stringify({ action, token, ...params }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${action}: ${j.error && j.error.code} ${j.error && j.error.message}`);
  return j.data;
}

// ---- fake requests ------------------------------------------------------------------------------------------------
async function setupData() {
  const devVars = fs.existsSync(path.join(REPO, ".dev.vars")) ? fs.readFileSync(path.join(REPO, ".dev.vars"), "utf8") : "";
  if (!/^DEV_FAKE_GOOGLE=1/m.test(devVars)) throw new Error(".dev.vars needs DEV_FAKE_GOOGLE=1 (dev:<email> logins, devReset, X-Dev-Month)");
  const envAdmin = ((/^ADMIN_EMAILS=(.*)$/m.exec(devVars) || [])[1] || "").split(",")[0].trim();
  await api("devReset");
  const ENV = (await api("adminLoginGoogle", { id_token: "dev:" + envAdmin })).token;
  // screenshot accounts use example.com addresses; the env admin is removed before anything is written in its name
  await api("adminUsersAdd", { email: ADMIN, role: "admin", units: [] }, ENV);
  await api("adminUsersAdd", { email: DISP, role: "dispenser", units: ["พัสดุ", "จ่ายกลาง", "LAB"] }, ENV);
  const ADM = (await api("adminLoginGoogle", { id_token: "dev:" + ADMIN })).token;
  await api("adminUsersRemove", { email: envAdmin }, ADM);
  await api("adminUsersAdd", { email: "lab@example.com", role: "dispenser", units: ["LAB"] }, ADM);
  const seed = buildFakeSeed();
  await api("adminImportSeed", { seed }, ADM);
  await api("adminPcuEdit", { code: DEMO, requester_name: "สมใจ ใจดี", phone: "035-000000" }, ADM);

  const form = seed.form;
  const itemsOf = (code) => form.steps.find((s) => s.code === code).rows.filter((r) => r.type === "item");
  const allItems = form.steps.flatMap((s) => s.rows.filter((r) => r.type === "item"));
  const real = seed.pcus.filter((p) => p.code !== DEMO);
  const tsOf = (round) => `${calOf(round)}-15T03:00:00.000Z`;
  // lines for one request: a handful of items per page, fake quantities
  const sent = {}; // pcu → round → lines
  const fakeLines = (round, density) => {
    const lines = {};
    for (const it of allItems) if (rnd() < density) lines[it.code] = { stock: ri(0, 8), op: ri(1, 6), pp: rnd() < 0.3 ? ri(1, 3) : 0, updated_at: tsOf(round) };
    return lines;
  };
  // every real unit sends Oct–Dec (admin dashboard / totals / issue tabs have data); a few have not sent the Dec round yet
  for (const round of SENT) {
    for (const [i, p] of real.entries()) {
      if (round === "2026-12" && i % 5 === 4) continue;
      const T = (await api("pcuLogin", { pcu: p.code, pin: PIN }, undefined, calOf(round))).token;
      const lines = fakeLines(round, 0.12);
      (sent[p.code] ||= {})[round] = lines;
      await api("saveLines", { month: round, lines, last_step: "LAB", send: true }, T, calOf(round));
    }
  }
  // the demo unit: Oct–Dec sent (stock mode baseline + dashboard line), the open round Jan 70 = a draft in progress
  for (const round of SENT) {
    const T = (await api("pcuLogin", { pcu: DEMO, pin: PIN }, undefined, calOf(round))).token;
    const lines = fakeLines(round, 0.18);
    if (round === "2026-12") for (const [c, op] of [["P1-06", 3], ["P1-07", 4], ["P1-08", 2]]) lines[c] = { stock: 1, op, pp: 0, updated_at: tsOf(round) };
    await api("saveLines", { month: round, lines, last_step: "LAB", send: true, submitter_name: "สมใจ ใจดี" }, T, calOf(round));
  }
  const TD = (await api("pcuLogin", { pcu: DEMO, pin: PIN })).token;
  const draft = {};
  itemsOf("P1").slice(0, 8).forEach((it, k) => { draft[it.code] = { stock: ri(1, 6), op: k % 3 === 2 ? 0 : ri(1, 4), pp: 0, updated_at: `${CAL}-10T03:00:00.000Z` }; });
  draft["P1-03"] = { stock: 0, op: 3, pp: 0, updated_at: `${CAL}-10T03:00:00.000Z` }; // over the yearly ceiling of 2 (incl. Oct–Dec)
  await api("saveLines", { month: OPEN, lines: draft, last_step: "P1" }, TD);
  await api("setHidden", { codes: itemsOf("P5").slice(0, 3).map((r) => r.code) }, TD);

  // issue: Oct + Nov fully issued by every unit; Dec partly (LAB done for a few, one shortage)
  const DT = (await api("adminLoginGoogle", { id_token: "dev:" + DISP })).token;
  for (const round of ["2026-10", "2026-11"]) for (const u of ["พัสดุ", "จ่ายกลาง", "LAB"]) await api("issueDoneAll", { month: round, unit: u }, DT, round);
  for (const p of real.slice(0, 4)) await api("issueAll", { pcu: p.code, month: "2026-12", unit: "LAB" }, DT).catch(() => {});
  await api("issueAll", { pcu: real[0].code, month: "2026-12", unit: "พัสดุ" }, DT).catch(() => {});
  await api("issueDone", { pcu: real[0].code, month: "2026-12", unit: "LAB", done: 1 }, DT).catch(() => {});
  // one shortage (PCU02, พัสดุ): got 1 less than asked — "จ่ายไม่พอ"
  const p2 = sent[real[1].code]["2026-12"];
  const short = Object.keys(p2).find((c) => /^P/.test(c) && p2[c].op + p2[c].pp >= 2);
  await api("issueLines", { pcu: real[1].code, month: "2026-12", lines: { [short]: { issued_total: p2[short].op + p2[short].pp - 1, reason: "out_of_stock" } } }, DT);
  // the item most units asked for in Dec (dispenser "ต่อรายการ" screenshot)
  const count = {};
  for (const pc of Object.keys(sent)) for (const c of Object.keys(sent[pc]["2026-12"] || {})) count[c] = (count[c] || 0) + 1;
  const popular = Object.keys(count).filter((c) => /^P/.test(c)).sort((a, b) => count[b] - count[a] || a.localeCompare(b))[0];

  // 2ad–2af fixtures: stock flags (P1-02 out, P1-04 pending) · P1-05 cancelled for good · announcement · issue + "รายงานของได้จริง" (one mismatch)
  const F0 = (await api("adminBootstrap", {}, ADM)).form;
  const steps = JSON.parse(JSON.stringify(F0.steps));
  steps.forEach((st) => st.rows.forEach((r) => { if (r.type === "item" && r.code === "P1-05") { r.active = false; r.cancel_reason = "เลิกผลิต — ใช้รายการอื่นแทน"; } }));
  await api("adminFormSave", { base_version_id: F0.id, note: "capture: cancel P1-05", form: { steps } }, ADM);
  await api("itemFlagSet", { code: "P1-02", status: "out", eta: "2027-01-20", note: "ใช้รายการ P1-01 แทนได้" }, DT);
  await api("itemFlagSet", { code: "P1-04", status: "pending" }, DT);
  await api("adminAnnouncementSave", { text: "รอบขอเบิก ม.ค. 70 ปิดรับวันที่ 25 ธ.ค. — กรุณาส่งใบเบิกก่อนกำหนด (ข้อความตัวอย่าง)" }, ADM);
  await api("issueLines", { pcu: DEMO, month: "2026-12", lines: { "P1-06": { issued_total: 3 }, "P1-07": { issued_total: 3, reason: "out_of_stock", note: "ของหมดชั่วคราว" } } }, DT);
  await api("issueDone", { pcu: DEMO, month: "2026-12", unit: "พัสดุ", done: 1 }, DT); // the PCU sees mismatches against done units only
  await api("pcuReceivedSave", { month: "2026-12", lines: [{ code: "P1-06", qty: 3 }, { code: "P1-07", qty: 4, note: "ได้ครบตามที่ขอ" }] }, TD);
  await api("pcuReceivedSave", { month: "2026-12", lines: [{ code: short, qty: p2[short].op + p2[short].pp }] }, (await api("pcuLogin", { pcu: real[1].code, pin: PIN })).token);

  // two feedback rows + the FAQ seeded by migration v8 (admin feedback tab / FAQ section)
  await api("feedbackSend", { category: "entry", body: "หน้ากรอกหน้า 3 อยากให้มีปุ่มกลับไปหน้าแรก", context: { app: "pcu", route: "fill" } }, TD);
  await api("feedbackSend", { category: "dashboard", body: "อยากเห็นยอดเบิกเทียบปีก่อนเป็นกราฟแท่ง", context: { app: "pcu", route: "dashboard" } }, TD);
  // a-yearly: a fake import file for the next fiscal year (only uploaded and previewed — never applied)
  const next = { ...seed, fy: 2571, generated_by: "tools/capture_help.mjs (fake, next fy)", form: { ...seed.form, fy: 2571 },
    plans: { 2571: seed.plans[2570] }, limits: { 2571: seed.limits[2570] } };
  delete next.actual_prev; delete next.stats; delete next.prices_prev; delete next.config;
  const nextFile = path.join(STATE, "import_2571.json");
  fs.writeFileSync(nextFile, JSON.stringify(next));
  return { popular, nextFile, envAdmin };
}

// ---- screenshots ------------------------------------------------------------------------------------------------
// One entry per image. role: guest (nobody signed in) | pcu (PCU00) | disp (dispenser, all 3 units) | admin.
// clip: omitted = the top 1280×800 of the page · {x, y, w, h} fixed · {from, to} = union of those elements' boxes (+ pad / padTop;
// h = fixed height from the top), height ≤ maxH (900).
// marks: {sel_key: selector} — "css", "css::text" (first visible match whose text contains it) or "css::=text" (exact text).
// widget: true keeps the 💬/❓ buttons in the image (hidden otherwise). Actions run in order after the page loads.
const SHOTS = (c) => [
  // ---- รพ.สต. (/help) ----
  { img: "login_1.png", role: "guest", url: "index.html#/login", clip: { from: "h2::เข้าสู่ระบบ", to: "#login-help" },
    marks: { pcu: "#pcu-select", pin: "#pin-input", go: "#btn-login", help: "#login-help" } },
  { img: "login_2.png", role: "pcu", url: "index.html#/home", clip: { from: "#app-header", to: "h2::สวัสดี" },
    marks: { pinbtn: ".notice-bar a::เปลี่ยน PIN", logout: "#btn-logout" } },
  { img: "login_3.png", role: "pcu", url: "index.html#/pin", clip: { from: "h2::เปลี่ยน PIN", to: "#link-cancel-pin" },
    marks: { old: "#pin-old", nw: "#pin-new", confirm: "#pin-confirm", go: "#btn-change-pin" } },
  { img: "fill_1.png", role: "pcu", url: "index.html#/home", clip: { from: "h2::สวัสดี", to: "h3::ธันวาคม 2569" },
    marks: { card: `button[data-fill="${c.OPEN}"]`, next: ".round-card-preview .badge, .round-card-preview .round-status" } },
  { img: "fill_2.png", role: "pcu", url: `index.html#/fill/P1?month=${c.OPEN}`, clip: { from: "#app-header", to: `input[data-field="op"]`, pad: 60 },
    marks: { pills: ".progress-pill.active", search: "#item-search", stock: `input[data-field="stock"]`, op: `input[data-field="op"]` } },
  { img: "fill_3.png", role: "pcu", url: `index.html#/fill/P1?month=${c.OPEN}`, clip: { from: "button::=ย้อนกลับ", to: "button.btn-primary::=ถัดไป" },
    actions: [{ type: [`tr:has(button[data-hide="P1-09"]) input[data-field="op"]`, "2"] }, { waitFor: "#autosave-status:not(:empty)", settle: 2500 }],
    marks: { saved: "#autosave-status", back: "button::=ย้อนกลับ", next: "button.btn-primary::=ถัดไป" } },
  { img: "hidden_1.png", role: "pcu", url: `index.html#/fill/P1?month=${c.OPEN}`, clip: { from: "summary::รายการที่ซ่อนไว้", to: `button[data-hide="P1-02"]` },
    marks: { list: "summary::รายการที่ซ่อนไว้", hide: `button[data-hide="P1-01"]` } },
  { img: "hidden_2.png", role: "pcu", url: "index.html#/hidden", clip: { from: "h2::ตั้งค่ารายการที่ไม่เบิก", to: `input[data-code="P1-08"]` },
    marks: { never: "#btn-never-prev", tick: `input[data-code="P1-01"]`, clear: "#btn-clear-all" } },
  { img: "hidden_3.png", role: "pcu", url: `index.html#/fill/P5?month=${c.OPEN}`, actions: [{ click: "details.hidden-drawer > summary" }],
    clip: { from: "details.hidden-drawer", to: "details.hidden-drawer", pad: 12 },
    marks: { list: "details.hidden-drawer > summary", back: ".hidden-item-row button::แสดงในหน้ากรอก" } },
  { img: "stock_1.png", role: "pcu", url: `index.html#/fill/P1?month=${c.OPEN}`, actions: [{ click: "#stock-mode-toggle" }],
    clip: { from: "#stock-mode-toggle", to: `input[data-field="pp"]`, pad: 90 },
    marks: { toggle: "#stock-mode-toggle", used: `input[data-field="used"]`, stock: `input[data-field="stock"]` } },
  { img: "send_1.png", role: "pcu", url: `index.html#/fill/summary?month=${c.OPEN}`, clip: { from: "h2::สรุปยอดก่อนส่ง", to: "button::=พิมพ์", maxH: 1100 },
    marks: { table: "#app table", save: "button.btn-primary::=บันทึก", print: "button::=พิมพ์" } },
  { img: "send_2.png", role: "pcu", url: "index.html#/home", clip: { from: "h3::มกราคม 2570", to: "summary::ตุลาคม 2569" },
    marks: { sent: ".badge::ส่งแล้ว", again: `button[data-fill="2026-12"]`, paid: ".badge::จ่ายแล้ว" } },
  { img: "print_1.png", role: "pcu", url: "index.html#/print?month=2026-12", clip: { from: "h2::ใบเบิก", to: "#btn-print-back", pad: 24 },
    marks: { pages: ".print-step-chk", date: "#print-doc-date", phone: "#print-phone", print: "#btn-do-print", pdf: "#btn-do-pdf", xlsx: "#btn-do-xlsx" } },
  { img: "dashboard_1.png", role: "pcu", url: "index.html#/dashboard", clip: { from: "h2::แดชบอร์ด", to: "h3::ยอดสะสม", pad: 8 },
    marks: { mode: `button[data-mode="baht"]`, unit: `button[data-unit="พัสดุ"]`, chart: "h3::ยอดรายรอบ" } },
  { img: "dashboard_2.png", role: "pcu", url: "index.html#/dashboard", clip: { from: "h3::รายการทั้งหมด", to: ".dash-more" },
    marks: { search: ".dash-search", excel: ".dash-export-xlsx", csv: ".dash-export" } },
  { img: "announce_1.png", role: "pcu", url: "index.html#/home", clip: { from: ".announce-bar", to: ".announce-bar", pad: 4 },
    marks: { bar: ".announce-bar", hide: ".announce-hide" } },
  { img: "noorder_1.png", role: "pcu", url: "index.html#/home", clip: { from: `.round-card:has(button[data-noorder="on"])`, to: `.round-card:has(button[data-noorder="on"])`, pad: 8 },
    marks: { btn: `button[data-noorder="on"]` } },
  { img: "noorder_2.png", role: "pcu", url: "index.html#/home", actions: [{ click: `button[data-noorder="on"][data-month="${c.OPEN}"]` }, { waitFor: ".dialog-box" }],
    clip: { from: ".dialog-box", to: ".dialog-box", pad: 8 },
    marks: { warn: ".dialog-box .notice-warn", cancel: ".dialog-box .btn-secondary", ok: ".dialog-box .btn-primary" } },
  { img: "received_1.png", role: "pcu", url: "index.html#/received?month=2026-12", clip: { from: "h2::รายงานของได้จริง", to: ".rcv-mismatch", pad: 16 },
    marks: { date: "#rcv-date", full: "#rcv-fill", qty: ".rcv-qty", flag: ".rcv-flag:not([hidden])" } },
  { img: "flags_1.png", role: "pcu", url: `index.html#/fill/P1?month=${c.OPEN}`, clip: { from: `tr[data-code="P1-02"]`, to: `tr[data-code="P1-05"]`, pad: 0 },
    marks: { out: `tr[data-code="P1-02"] .stock-flag`, over: `tr[data-code="P1-03"] .limit-plan`, pending: `tr[data-code="P1-04"] .stock-flag`, cancelled: `tr[data-code="P1-05"] .row-note` } },
  { img: "flags_2.png", role: "pcu", url: "index.html#/fill/P1?month=2026-12", clip: { from: `tr[data-code="P1-06"]`, to: `tr[data-code="P1-07"]`, pad: 0 },
    marks: { locked: `tr[data-code="P1-06"] .row-note` } },
  { img: "feedback_1.png", role: "pcu", url: "index.html#/home", widget: true, actions: [{ click: "#fb-fab" }], clip: { x: 640, y: 0, w: 640, h: 800 },
    marks: { fab: "#fb-fab", help: "#fb-help", cat: ".fb-cat", send: "#fb-send" } },

  // ---- ผู้จ่าย (admin.html → คู่มือ) ----
  { img: "d-login_1.png", role: "guest", url: "admin.html", clip: { from: ".admin-login-card", to: ".admin-login-card" },
    marks: { google: "#gsi-button-host", backup: ".admin-backup-details summary" } },
  { img: "d-issue_1.png", role: "disp", url: "admin.html#issue?pcu=PCU02&month=2026-12",
    marks: { mode: "#t2b-mode-sheet", month: "#t2b-month", pcu: "#t2b-pcu", qty: ".t2b-in", all: `button[data-act="issue-all"]`, done: `button[data-act="issue-done"]` } },
  { img: "d-issue_2.png", role: "disp", url: "admin.html#issue?pcu=PCU02&month=2026-12", actions: [{ click: "#t2b-mode-item" }, { select: ["#t2b-item", c.popular] }],
    marks: { mode: "#t2b-mode-item", item: "#t2b-item", qty: ".t2b-in" } },
  { img: "d-all_1.png", role: "disp", url: "admin.html#issue?pcu=PCU02&month=2026-12", actions: [{ click: "#t2b-mode-round" }], clip: { x: 0, y: 0, w: 1280, h: 640 },
    marks: { mode: "#t2b-mode-round", unit: "#t2b-unit", all: "#t2b-done-all", except: "#t2b-except" } },
  { img: "d-all_2.png", role: "disp", url: "admin.html#issue?pcu=PCU02&month=2026-12", actions: [{ click: "#t2b-mode-round" }, { click: "#t2b-except" }],
    marks: { pick: "#t2b-wiz-list input[type=checkbox]", next: "#t2b-wiz-next" } },
  { img: "d-short_1.png", role: "disp", url: "admin.html#issue?pcu=PCU02&month=2026-12", actions: [{ click: "#t2b-shortage-btn" }], clip: { from: "#t2b-shortage-btn", to: "h2::PCU02" },
    marks: { btn: "#t2b-shortage-btn", scope: `button[data-scope="fy"]` } },
  { img: "d-undo_1.png", role: "disp", url: "admin.html#issue?pcu=PCU01&month=2026-12", clip: { from: "h3::หน่วยจ่าย: LAB", to: `button[data-act="issue-done"][data-unit="LAB"]`, pad: 16, h: 300 },
    marks: { undo: `button[data-act="issue-done"][data-unit="LAB"]` } },
  { img: "d-notices_1.png", role: "disp", url: "admin.html#notices", clip: { from: "#t15-flags", to: "#t15-flag-list", pad: 8 },
    marks: { list: "#t15-flag-tbl", search: "#t15-search" } },
  { img: "d-excel_1.png", role: "disp", url: "admin.html#excel", clip: { x: 0, y: 0, w: 1280, h: 420 },
    marks: { now: "#t6-month-now", pick: "#t6-month-pick", fy: "#t6-fy" } },
  { img: "d-excel_2.png", role: "disp", url: "admin.html#status", actions: [{ select: ["#t1-month", "2026-12"] }],
    marks: { month: "#t1-month", open: `a[data-act="open"]`, pdf: `button[data-act="pdf"]` } },

  // ---- admin ----
  { img: "a-monthly_1.png", role: "admin", url: "admin.html#status", actions: [{ select: ["#t1-month", "2026-12"] }],
    marks: { month: "#t1-month", lock: "#t1-lock", entry: `button[data-act="entry"]`, note: `button[data-act="note"]`, mismatch: `[data-role="mismatch"]` } },
  { img: "a-monthly_2.png", role: "admin", url: "admin.html#totals", actions: [{ select: ["#t2-month", "2026-12"] }],
    marks: { month: "#t2-month", unit: "#t2-view-unit", print: "#t2-print" } },
  { img: "a-monthly_3.png", role: "admin", url: "admin.html#dashboard",
    marks: { unit: `.dash-seg-btn[data-unit="พัสดุ"]` } },
  { img: "a-monthly_4.png", role: "admin", url: "admin.html#feedback", clip: { x: 0, y: 120, w: 1280, h: 760 },
    marks: { filter: "#t13-status", csv: "#t13-csv", status: `button[data-status="ack"]`, faq: "button[data-faq-from]", reply: ".t13-reply" } },
  { img: "a-notices_1.png", role: "admin", url: "admin.html#notices", clip: { from: "#t15-ann", to: "#t15-ann", pad: 8 },
    marks: { add: "#t15-ann-add", list: "#t15-ann-tbl" } },
  { img: "a-received_1.png", role: "admin", url: "admin.html#received", actions: [{ select: ["#t16-month", "2026-12"] }], clip: { from: "#t16-card", to: "#t16-card", pad: 8 },
    marks: { month: "#t16-month", csv: "#t16-csv", mm: "#t16-tbl .t16-mismatch", table: "#t16-tbl" } },
  { img: "a-excel_1.png", role: "admin", url: "admin.html#excel", clip: { from: "h3::ใบเบิกรายบรรทัด", to: "#t6-lines-fy", pad: 16 },
    marks: { month: "#t6-lines-month", fy: "#t6-lines-fy" } },
  { img: "a-sometimes_1.png", role: "admin", url: "admin.html#form", clip: { from: "h2::หน้าในใบเบิก", to: "select.t10-move", pad: 16 },
    marks: { chip: ".t10-chip.active", price: ".t10-in-price", toggle: `button[data-act="toggle"]` } },
  { img: "a-sometimes_2.png", role: "admin", url: "admin.html#pcu", clip: { x: 0, y: 120, w: 1280, h: 420 },
    marks: { add: "#t7-add", edit: `button[data-act="edit"]`, pin: `button[data-act="pin"]`, hidden: `button[data-act="hidden"]` } },
  { img: "a-sometimes_3.png", role: "admin", url: "admin.html#system", clip: { from: "h2::รอบทดลอง", to: "#t9-clear", pad: 16 },
    marks: { trial: "#t9-trial-clear", backup: "#t9-backup-now", clear: "#t9-clear" } },
  { img: "a-yearly_1.png", role: "admin", url: "admin.html#import", actions: [{ upload: ["#t11-json-file", c.nextFile] }],
    clip: { from: "h2::นำเข้า / เปิดปีงบใหม่", to: "#t11-next1", pad: 16, maxH: 1000 },
    marks: { fy: "#t11-fy", json: "#t11-json-file", guide: "#t11-guide", next: "#t11-next1" } },
  { img: "a-yearly_2.png", role: "admin", url: "admin.html#import", actions: [{ upload: ["#t11-json-file", c.nextFile] }, { click: "#t11-next1" }, { waitFor: "#t11-apply:not([disabled])" }],
    clip: { from: "#t11-steps", to: "#t11-steps", pad: 16, h: 820 }, marks: { steps: "#t11-steps" } },
  { img: "a-yearly_3.png", role: "admin", url: "admin.html#import", actions: [{ upload: ["#t11-json-file", c.nextFile] }, { click: "#t11-next1" }, { waitFor: "#t11-apply:not([disabled])" }],
    clip: { from: "#t11-back3", to: "#t11-apply", pad: 16, padTop: 260 }, marks: { back: "#t11-back3", dl: "#t11-download", apply: "#t11-apply" } },
  { img: "a-yearly_4.png", role: "admin", url: "admin.html#import",
    actions: [{ upload: ["#t11-json-file", c.nextFile] }, { click: "#t11-next1" }, { waitFor: "#t11-apply:not([disabled])" }, { click: "#t11-apply" }],
    clip: { from: ".admin-modal", to: ".admin-modal", pad: 16 }, marks: { cancel: `.admin-modal [data-role="cancel"]`, ok: `.admin-modal [data-role="ok"]` } },
  { img: "a-yearly_5.png", role: "admin", url: "admin.html#import",
    actions: [{ upload: ["#t11-json-file", c.nextFile] }, { click: "#t11-next1" }, { waitFor: "#t11-apply:not([disabled])" }, { click: "#t11-apply" },
      { click: `.admin-modal [data-role="ok"]` }, { waitFor: ".admin-modal input" }],
    clip: { from: ".admin-modal", to: ".admin-modal", pad: 16 }, marks: { phrase: ".admin-modal input", ok: ".admin-modal .btn-primary" } },
  // last on purpose: it turns the demo unit's open round into "ไม่เบิก" (clears its draft), which no other image may show
  { img: "noorder_3.png", role: "pcu", url: "index.html#/home",
    actions: [{ click: `button[data-noorder="on"][data-month="${c.OPEN}"]` }, { waitFor: ".dialog-box" }, { click: ".dialog-box .btn-primary" },
      { waitFor: `button[data-noorder="off"]`, settle: 3500 }],
    clip: { from: `.round-card:has(button[data-noorder="off"])`, to: `.round-card:has(button[data-noorder="off"])`, pad: 8 },
    marks: { msg: ".round-card p::แจ้ง \"ไม่เบิก\" เดือนนี้แล้ว", off: `button[data-noorder="off"]` } },
];

const CAPTURE_CSS = `*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }
  .admin-dev-login { display: none !important; }
  .step-totals.sticky-totals { position: static !important; }
  .rcv-actions { display: none !important; }`; /* sticky save bar would cover the rows */ /* a bar stuck to the viewport bottom would land mid-image */
const HIDE_WIDGET_CSS = ".fb-dock, .fb-fab, .fb-panel { display: none !important; }";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(ctx) {
  let puppeteer;
  try { puppeteer = (await import("puppeteer-core")).default; } catch { throw new Error("puppeteer-core is missing — run npm install"); }
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} — set CHROME_PATH`);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--font-render-hinting=none", "--hide-scrollbars"] });
  const tokens = {
    pcu: await api("pcuLogin", { pcu: DEMO, pin: PIN }),
    disp: await api("adminLoginGoogle", { id_token: "dev:" + DISP }),
    admin: await api("adminLoginGoogle", { id_token: "dev:" + ADMIN }),
  };
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = {};
  try {
    for (const shot of SHOTS({ OPEN, ...ctx })) {
      const bctx = await browser.createBrowserContext();
      const page = await bctx.newPage();
      try {
        await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
        await page.setExtraHTTPHeaders({ "x-dev-month": CAL });
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
        await page.goto(BASE + "/index.html#/none", { waitUntil: "domcontentloaded" });
        await page.evaluate((role, t) => {
          localStorage.clear();
          if (role === "pcu") { localStorage.setItem("pcuSupply2:pcuToken", t.token); localStorage.setItem("pcuSupply2:pcuTokenExp", String(t.exp)); }
          if (role === "disp" || role === "admin") { localStorage.setItem("pcuSupply2:adminToken", t.token); localStorage.setItem("pcuSupply2:adminTokenExp", String(t.exp)); }
        }, shot.role, tokens[shot.role] || {});
        await page.goto("about:blank");
        await page.goto(BASE + "/" + shot.url, { waitUntil: "networkidle0" });
        await page.addStyleTag({ content: CAPTURE_CSS + (shot.widget ? "" : HIDE_WIDGET_CSS) });
        await sleep(400);
        for (const a of shot.actions || []) {
          if (a.click) { await page.waitForSelector(a.click, { visible: true, timeout: 10000 }); await page.click(a.click); }
          else if (a.select) { await page.waitForSelector(a.select[0], { timeout: 10000 }); await page.select(a.select[0], a.select[1]); }
          else if (a.upload) { const h = await page.waitForSelector(a.upload[0], { timeout: 10000 }); await h.uploadFile(a.upload[1]); }
          else if (a.type) { await page.waitForSelector(a.type[0], { visible: true, timeout: 10000 }); await page.type(a.type[0], a.type[1]); await page.keyboard.press("Tab"); }
          else if (a.waitFor) { await page.waitForSelector(a.waitFor, { timeout: 20000 }); }
          if (a.settle) await sleep(a.settle);
          await page.waitForNetworkIdle({ idleTime: 300, timeout: 20000 }).catch(() => {});
          await sleep(300);
        }
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.scrollTo(0, 0); });
        await sleep(200);
        // no real e-mail / account name may end up in an image
        const leak = await page.evaluate((needle) => {
          const vis = document.body.innerText + " " + [...document.querySelectorAll("input,select,textarea")].filter((e) => e.offsetParent).map((e) => e.value).join(" ");
          return needle && vis.toLowerCase().includes(needle.toLowerCase());
        }, ctx.envAdmin);
        if (leak) throw new Error(`${shot.img}: the page shows ${ctx.envAdmin}`);
        const boxes = await page.evaluate((shot) => {
          const find = (spec) => {
            const [css, textRaw] = spec.split("::");
            const exact = textRaw && textRaw.startsWith("=");
            const text = textRaw && (exact ? textRaw.slice(1) : textRaw);
            const el = [...document.querySelectorAll(css)].find((e) => {
              const r = e.getBoundingClientRect();
              if (!r.width || !r.height) return false;
              if (!text) return true;
              const t = (e.innerText || e.value || "").trim();
              return exact ? t === text : t.includes(text);
            });
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height };
          };
          const res = { missing: [], marks: {}, clip: null, pageH: document.documentElement.scrollHeight };
          for (const [k, sel] of Object.entries(shot.marks || {})) { const b = find(sel); if (b) res.marks[k] = b; else res.missing.push(`mark ${k} = ${sel}`); }
          const c = shot.clip;
          if (c && c.from) {
            const a = find(c.from), b = find(c.to);
            if (!a) res.missing.push(`clip.from = ${c.from}`);
            if (!b) res.missing.push(`clip.to = ${c.to}`);
            if (a && b) {
              const pad = c.pad == null ? 24 : c.pad;
              const x0 = Math.min(a.x, b.x) - pad, y0 = Math.min(a.y, b.y) - (c.padTop == null ? pad : c.padTop);
              const x1 = Math.max(a.x + a.w, b.x + b.w) + pad, y1 = c.h ? y0 + c.h : Math.max(a.y + a.h, b.y + b.h) + pad;
              res.clip = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
            }
          }
          return res;
        }, shot);
        if (boxes.missing.length) throw new Error(`${shot.img}: selector not found — ${boxes.missing.join(" · ")}`);
        let clip = shot.clip && !shot.clip.from ? { ...shot.clip } : boxes.clip || { x: 0, y: 0, w: 1280, h: 800 };
        // whole pixels inside the page, height capped
        clip.x = Math.max(0, Math.floor(clip.x)); clip.y = Math.max(0, Math.floor(clip.y));
        clip.w = Math.min(1280 - clip.x, Math.ceil(clip.w)); clip.h = Math.min(shot.clip && shot.clip.maxH || 900, Math.ceil(clip.h), boxes.pageH - clip.y);
        const marks = {};
        for (const [k, b] of Object.entries(boxes.marks)) {
          const m = { x: Math.round(b.x - clip.x), y: Math.round(b.y - clip.y), w: Math.round(b.w), h: Math.round(b.h) };
          if (m.x < -2 || m.y < -2 || m.x + m.w > clip.w + 2 || m.y + m.h > clip.h + 2) throw new Error(`${shot.img}: mark ${k} lies outside the image (${JSON.stringify(m)} vs ${clip.w}×${clip.h})`);
          marks[k] = m;
        }
        await page.screenshot({ path: path.join(OUT_DIR, shot.img), clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h }, captureBeyondViewport: true });
        out[shot.img] = { w: clip.w, h: clip.h, marks };
        console.log(`  ${shot.img.padEnd(20)} ${clip.w}×${clip.h}  marks: ${Object.keys(marks).join(", ")}`);
      } finally {
        await bctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  fs.writeFileSync(SHOTS_JSON, JSON.stringify(sorted, null, 1) + "\n");
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  const bytes = files.reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log(`\n${files.length} images · ${(bytes / 1024 / 1024).toFixed(2)} MB in public/help/img/ · public/help/shots.json written`);
  if (bytes > 5 * 1024 * 1024) console.log("WARNING: over the 5 MB target");
  await checkManuals(sorted);
}

// every image / mark the manuals refer to must exist (and every image should be used)
async function checkManuals(shots) {
  const pcu = (await import(path.join(REPO, "public", "help", "manual_pcu.js"))).default;
  const staff = await import(path.join(REPO, "public", "help", "manual_staff.js"));
  const topics = [...pcu, ...staff.DISPENSER, ...staff.ADMIN_PARTS.flatMap((p) => p.topics)];
  const used = new Set(), problems = [];
  for (const t of topics) for (const sh of t.shots || []) {
    used.add(sh.img);
    if (!shots[sh.img]) { problems.push(`${t.id}: image ${sh.img} was not captured`); continue; }
    for (const m of sh.marks || []) if (!shots[sh.img].marks[m.sel_key]) problems.push(`${t.id}: ${sh.img} has no mark "${m.sel_key}"`);
  }
  for (const img of Object.keys(shots)) if (!used.has(img)) problems.push(`image ${img} is not used by any manual topic`);
  if (problems.length) throw new Error("manual ↔ screenshots mismatch:\n  " + problems.join("\n  "));
  console.log(`manuals OK: ${topics.length} topics, ${used.size} images referenced`);
}

// ====================================================================================================================
async function main() {
  process.on("SIGINT", () => { stopServer(); process.exit(130); });
  await startServer();
  try {
    console.log("fixture: fake data built from public/data/form2569.json (seed/seed_2570.json is not read)");
    const ctx = await setupData();
    if (SERVE) {
      console.log(`ready: ${BASE}/ (send header X-Dev-Month: ${CAL}) — Ctrl-C to stop`);
      await new Promise(() => {});
    }
    await capture(ctx);
  } finally {
    stopServer();
  }
}
main().catch((err) => { console.error("capture failed:", err.message || err); stopServer(); process.exit(1); });
