// dashboard.js — 2q: `pcuDashboard{fy?}` — the PCU's own dashboard (spec 2o-2s §5.1, brief 2q §3/§4). functions/API.md §4.2.
// Counts submitted/issued requests only, never the trial round (config.trial_month). CPU (free tier 10 ms): a fixed handful of queries,
// one JS pass over the lines (≤ items × 12 rows: one request per pcu × round, so a line IS the (round, item) aggregate), no per-line query.
import { err } from "./http.js";
import { getConfigAll, loadForm, publicConfig } from "./db.js";
import { currentRound, fyMonths, monthFy, monthMinus } from "./time.js";
import { loadPriceHistory, priceFor } from "./price.js";

const r2 = (x) => Math.round(x * 100) / 100;
const SENT = `('submitted','issued')`;

// latest form version of exactly `fy` (no fallback — a fy without a form is NOT_FOUND here)
async function strictForm(DB, fy) {
  const row = await DB.prepare(`SELECT id FROM form_versions WHERE fy = ? ORDER BY id DESC LIMIT 1`).bind(fy).first();
  return row ? loadForm(DB, row.id) : null;
}

function parseFy(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,4}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw err("BAD_REQUEST", "ปีงบประมาณไม่ถูกต้อง");
  return n;
}

export async function pcuDashboard(ctx, p) {
  const { DB } = ctx;
  const pcu = ctx.pcu.code;
  const cur = currentRound();
  const cfg = publicConfig(await getConfigAll(DB), monthFy(cur));
  const fy = parseFy(p.fy, cfg.fy_current);
  const trial = cfg.trial_month;
  const all = fyMonths(fy);
  const rounds = all.filter((m) => m !== trial);
  const trialArg = trial || "";

  const [form, lineRes, doneRes, planRes, hidRes, prevRes, monthRes, fyRes] = await Promise.all([
    strictForm(DB, fy),
    DB.prepare(
      `SELECT r.month AS m, r.form_version_id AS fv, l.item_code AS c, COALESCE(l.op,0) + COALESCE(l.pp,0) AS q,
              l.issued_total AS it, l.used AS u, l.price_snapshot AS ps
         FROM requests r JOIN request_lines l ON l.request_id = r.id
        WHERE r.pcu = ? AND r.month >= ? AND r.month <= ? AND r.month != ? AND r.status IN ${SENT}
          AND (COALESCE(l.op,0) + COALESCE(l.pp,0) > 0 OR l.used IS NOT NULL)`
    ).bind(pcu, all[0], all[11], trialArg).raw(),
    DB.prepare(
      `SELECT r.month, s.dispense_unit FROM issue_status s JOIN requests r ON r.id = s.request_id
        WHERE r.pcu = ? AND r.month >= ? AND r.month <= ? AND r.status IN ${SENT}`
    ).bind(pcu, all[0], all[11]).raw(),
    DB.prepare(`SELECT item_code, COALESCE(plan_op,0) + COALESCE(plan_pp,0) FROM plans WHERE fy = ? AND pcu = ?`).bind(fy, pcu).raw(),
    DB.prepare(`SELECT item_code FROM hidden_items WHERE pcu = ?`).bind(pcu).raw(),
    DB.prepare(
      `SELECT a.month, a.item_code, SUM(COALESCE(a.op,0) + COALESCE(a.pp,0)) AS q, MAX(pp.price) AS price
         FROM actual_prev a LEFT JOIN prices_prev pp ON pp.fy = a.fy AND pp.item_code = a.item_code
        WHERE a.fy = ? AND a.pcu = ? GROUP BY a.month, a.item_code HAVING q > 0`
    ).bind(fy - 1, pcu).raw(),
    DB.prepare(`SELECT DISTINCT month FROM requests WHERE pcu = ? AND status IN ${SENT}`).bind(pcu).raw(),
    DB.prepare(`SELECT DISTINCT fy FROM form_versions`).raw(),
  ]);
  if (!form) throw err("NOT_FOUND", `ไม่พบแบบฟอร์มของปีงบ ${fy}`);

  // forms bound to the counted requests (unit of a line + item info of codes the fy's latest form lacks) — usually none besides `form`
  const forms = new Map([[form.id, form]]);
  const fvs = [...new Set(lineRes.map((r) => r[1]).filter((v) => v && !forms.has(v)))];
  for (const f of await Promise.all(fvs.map((id) => loadForm(DB, id)))) if (f) forms.set(f.id, f);
  const formOf = (fv) => (fv && forms.get(fv)) || form;
  const entOf = (code, fv) => {
    const own = formOf(fv).index.get(code);
    if (own) return own;
    if (form.index.has(code)) return form.index.get(code);
    for (const f of forms.values()) if (f.index.has(code)) return f.index.get(code);
    return null;
  };

  const done = new Set(doneRes.map(([m, u]) => m + "|" + u));
  let hist = null; // price_history of fy — loaded only when a line has no price_snapshot
  if (lineRes.some((r) => r[6] === null || r[6] === undefined)) hist = await loadPriceHistory(DB, fy);

  // ---- monthly (one pass) ----
  const monthly = {}, cum = new Map(), withUsed = new Set(), withReq = new Set();
  for (const [m, fv, code, q, it, u, ps] of lineRes) {
    const price = ps !== null && ps !== undefined ? ps : priceFor(hist, form.index.has(code) ? form : formOf(fv), code, m) ?? 0;
    let got = 0;
    if (q > 0 && it !== null && it !== undefined) { // PCU view rule (Q78): figures of DONE units only
      const ent = formOf(fv).index.get(code);
      if (ent && done.has(m + "|" + ent.step.dispense_unit)) got = it;
    }
    const used = u ?? 0;
    if (u !== null && u !== undefined) withUsed.add(code);
    if (q > 0) { withReq.add(code); cum.set(code, (cum.get(code) || 0) + q); }
    if (!q && !got && !used) continue;
    (monthly[code] ||= {})[m] = [q, r2(q * price), got, r2(got * price), used, r2(used * price)];
  }

  // ---- items ----
  const plan = new Map(planRes.map(([c, q]) => [c, Number(q) || 0]));
  const hidden = new Set(hidRes.map((r) => r[0]));
  const items = {};
  const put = (code, ent) => {
    items[code] = {
      name: ent ? ent.item.name : code, unit: (ent && ent.item.unit) || "",
      unit_group: ent ? ent.step.dispense_unit : null, plan_qty: plan.get(code) || 0,
    };
  };
  for (const [code, ent] of form.index) {
    const has = !!monthly[code];
    const shown = !hidden.has(code) && ent.item.active !== false && ent.step.active !== false;
    if (shown || has) put(code, ent);
  }
  for (const code of Object.keys(monthly)) if (!items[code]) put(code, entOf(code, null));

  // ---- flags (rule 2 "pace" only, Q25) ----
  const elapsed = rounds.filter((m) => m <= cur).length;
  const flags = [];
  if (elapsed > 0) {
    for (const code of Object.keys(items)) {
      const pq = items[code].plan_qty, cq = cum.get(code) || 0;
      if (pq > 0 && cq > (pq * elapsed / 12) * 1.2) flags.push({ code, rule: "pace", cum_qty: cq, plan_qty: pq, elapsed });
    }
  }

  // ---- prev_fy: actual_prev of fy−1 aligned to `rounds` (round X ↔ Excel month X−1 of the previous year = monthMinus(X, 13)) ----
  let prev_fy = null;
  if (prevRes.length) {
    const months = rounds.map((m) => monthMinus(m, 13));
    const idx = new Map(months.map((m, i) => [m, i]));
    const qty = new Array(months.length).fill(0), baht = new Array(months.length).fill(0);
    let prevForm = null, needForm = prevRes.some((r) => r[3] === null || r[3] === undefined);
    if (needForm) prevForm = (await strictForm(DB, fy - 1)) || form;
    for (const [m, code, q, pr] of prevRes) {
      const i = idx.get(m);
      if (i === undefined) continue;
      let price = pr;
      if (price === null || price === undefined) {
        const ent = prevForm.index.get(code) || form.index.get(code);
        price = ent ? Number(ent.item.price) || 0 : 0;
      }
      qty[i] += q; baht[i] += q * price;
    }
    prev_fy = { months, qty: qty.map(r2), baht: baht.map(r2) };
  }

  // ---- fys: fiscal years with a sent (non-trial) request of this pcu that have a form, + fy_current; newest first ----
  const withForm = new Set(fyRes.map((r) => r[0]));
  const fySet = new Set([cfg.fy_current]);
  for (const [m] of monthRes) if (m !== trial) { const f = monthFy(m); if (withForm.has(f)) fySet.add(f); }
  const fys = [...fySet].sort((a, b) => b - a);

  return {
    fy, fys, rounds, items, monthly, prev_fy,
    used_coverage: { items_with_used: withUsed.size, items_total: withReq.size },
    flags,
  };
}
