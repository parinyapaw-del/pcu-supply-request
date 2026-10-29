// usage: npm test once (leaves .wrangler/test-state) → cp its D1 .sqlite to a scratch file →
//   node tools/bench_dashboard.mjs <copy.sqlite> $PWD/functions/_lib/dashboard.js NEW fill   (fill = only on the first run of a copy; NEVER on .wrangler/state = Save's dev DB)
// 2aa CPU bench: fill a copy of the test-state D1 with 15 pcus × every item × 12 rounds, record query results through node:sqlite,
// then replay them from memory and time the JS of adminDashboard / pcuDashboard (old = HEAD copy, new = working tree).
// usage: node bench.mjs <sqlite copy> <dashboard module path> <label> [fill]
import { DatabaseSync } from "node:sqlite";
const [dbPath, modPath, label, fill] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
const FY = 2571;
const months = []; { let y = 2027, m = 10; for (let i = 0; i < 12; i++) { months.push(`${y}-${String(m).padStart(2, "0")}`); if (++m === 13) { m = 1; y++; } } }
if (fill) {
  const fv = db.prepare(`SELECT id, data FROM form_versions WHERE fy = ? ORDER BY id DESC LIMIT 1`).get(FY);
  const form = JSON.parse(fv.data);
  const items = form.steps.flatMap((s) => s.rows.filter((r) => r.type === "item").map((r) => ({ code: r.code, price: r.price || 10, unit: s.dispense_unit })));
  const pcus = db.prepare(`SELECT code FROM pcus WHERE COALESCE("group",'') != 'ทดลอง' ORDER BY code LIMIT 15`).all().map((r) => r.code);
  db.exec(`DELETE FROM request_lines WHERE request_id IN (SELECT id FROM requests WHERE month >= '${months[0]}' AND month <= '${months[11]}');
           DELETE FROM issue_status WHERE request_id IN (SELECT id FROM requests WHERE month >= '${months[0]}' AND month <= '${months[11]}');
           DELETE FROM requests WHERE month >= '${months[0]}' AND month <= '${months[11]}'; UPDATE config SET value='null' WHERE key='trial_month';`);
  const insR = db.prepare(`INSERT INTO requests (id, pcu, month, status, form_version_id, submit_count) VALUES (?,?,?,'submitted',?,1)`);
  const insL = db.prepare(`INSERT INTO request_lines (request_id, item_code, stock, op, pp, price_snapshot, issued_total, used) VALUES (?,?,?,?,?,?,?,?)`);
  const insS = db.prepare(`INSERT INTO issue_status (request_id, dispense_unit, done_at) VALUES (?,?,'x')`);
  const insA = db.prepare(`INSERT OR REPLACE INTO actual_prev (fy, month, pcu, item_code, op, pp) VALUES (?,?,?,?,?,0)`);
  const insP = db.prepare(`INSERT OR REPLACE INTO plans (fy, pcu, item_code, plan_op, plan_pp) VALUES (?,?,?,?,0)`);
  const insT = db.prepare(`INSERT OR REPLACE INTO stats (fy, pcu, item_code, median_m, p90_m, annual_qty) VALUES (?,?,?,1,?,10)`);
  const insLim = db.prepare(`INSERT OR REPLACE INTO limits (fy, pcu, item_code, limit_month, limit_year, source) VALUES (?,?,?,NULL,?,'bench')`);
  db.exec("BEGIN");
  let k = 0;
  for (const p of pcus) for (const m of months) {
    const id = `B-${p}-${m}`;
    insR.run(id, p, m, fv.id);
    for (const it of items) { k++; insL.run(id, it.code, k % 7, 1 + (k % 9), k % 3, it.price, k % 5 ? 1 + (k % 9) : null, k % 4); }
    for (const u of ["พัสดุ", "จ่ายกลาง", "LAB"]) insS.run(id, u);
  }
  const xm = []; { let y = 2026, m = 10; for (let i = 0; i < 12; i++) { xm.push(`${y}-${String(m).padStart(2, "0")}`); if (++m === 13) { m = 1; y++; } } }
  for (const p of pcus) for (const it of items) {
    insP.run(FY, p, it.code, 100); insT.run(FY - 1, p, it.code, 5); insLim.run(FY, p, it.code, 90);
    for (const m of xm) insA.run(FY - 1, m, p, it.code, 3);
  }
  db.exec("COMMIT");
  console.log(`filled: ${pcus.length} pcus × ${items.length} items × 12 rounds = ${pcus.length * items.length * 12} lines`);
}
// D1 shim (record) + replay
const cache = new Map();
const key = (sql, b) => sql + "\u0001" + JSON.stringify(b);
const conv = (b) => b.map((v) => (typeof v === "boolean" ? Number(v) : v));
function mk(record) {
  return {
    prepare(sql) {
      let b = [];
      const run = (kind) => {
        const k = kind + key(sql, b);
        if (!record) { if (!cache.has(k)) throw new Error("replay miss " + sql.slice(0, 80)); return cache.get(k); }
        const st = db.prepare(sql);
        let out;
        if (kind === "raw") { st.setReturnArrays(true); out = st.all(...conv(b)); }
        else if (kind === "first") out = st.get(...conv(b)) ?? null;
        else out = { results: st.all(...conv(b)) };
        cache.set(k, out);
        return out;
      };
      const o = { bind(...a) { b = a; return o; }, async raw() { return run("raw"); }, async first() { return run("first"); }, async all() { return run("all"); } };
      return o;
    },
    async batch() { throw new Error("no writes in bench"); },
  };
}
const mod = await import(modPath);
const pcu = db.prepare(`SELECT code FROM pcus WHERE COALESCE("group",'') != 'ทดลอง' ORDER BY code LIMIT 1`).get().code;
const cases = [
  ["network", (DB) => mod.adminDashboard({ DB }, { fy: FY })],
  ["onePcu", (DB) => mod.adminDashboard({ DB }, { fy: FY, pcu })],
  ["pcuDash", (DB) => mod.pcuDashboard({ DB, pcu: { code: pcu } }, { fy: FY })],
];
const rec = mk(true), rep = mk(false);
for (const [, f] of cases) await f(rec);
const out = [];
for (const [name, f] of cases) {
  let t = performance.now(); const r = await f(rep); const cold = performance.now() - t;
  const ts = [];
  for (let i = 0; i < 40; i++) { t = performance.now(); await f(rep); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  out.push(`${name}: cold ${cold.toFixed(1)} ms · warm median ${ts[20].toFixed(2)} ms · payload ${JSON.stringify(r).length} chars`);
}
console.log(label + "\n  " + out.join("\n  "));
