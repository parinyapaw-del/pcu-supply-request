// dashboard.js — 2q `pcuDashboard{fy?}` (the PCU's own dashboard, spec 2o-2s §5.1, functions/API.md §4.2)
// + 2s `adminDashboard{fy?, pcu?}` (network / one PCU, admin only) and `issueShortage{fy?, scope, month?, unit?}` (admin + dispenser)
// (spec 2o-2s §6.2–§6.3, brief 2s §6, functions/API.md §5.5).
// Counts submitted/issued requests only, never the trial round (config.trial_month); the 2s views also never count pcus."group" = ทดลอง.
// CPU (free tier 10 ms): a fixed handful of queries. One PCU = one JS pass over its lines (≤ items × 12 rows: one request per pcu × round,
// so a line IS the (round, item) aggregate). The network view never pulls raw lines: SQL GROUP BY (pcu,item) / (round,item) / (pcu,round),
// p90 compared inside SQL (JOIN stats), only lines without price_snapshot (normally none) come back raw for the priceFor fallback.
import { err } from "./http.js";
import { DEFAULT_UNIT_BY_STEP, formForFy, getConfigAll, linkMap, linkedCode, loadForm, publicConfig } from "./db.js";
import { TRIAL_GROUP, UNITS } from "./auth.js";
import { currentRound, fyExcelMonths, fyMonths, isMonth, monthFy, monthMinus } from "./time.js";
import { formPrice, loadPriceHistory, priceFor } from "./price.js";

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const SENT = `('submitted','issued')`;
const Q = `(COALESCE(l.op,0) + COALESCE(l.pp,0))`;
const QA = `(COALESCE(a.op,0) + COALESCE(a.pp,0))`;
const NOT_TRIAL = `COALESCE(p."group",'') != '${TRIAL_GROUP}'`; // code constant, not user input

// Pattern thresholds — copied from output/data/thresholds.json (insight report 2567–2569, `pattern_rules` / `endyear_rule`).
// Evaluated in pattern_order on the MONTHLY BAHT of one pcu (all items): ไม่เบิก → เบาบาง → เบิกครั้งเดียว → กระจุกเป็นช่วง → สม่ำเสมอ → ผสม.
const PAT = { top1_steady: 0.35, months_steady: 8, top3_burst: 0.6, top1_single: 0.8, sparse_months: 3, sparse_baht: 10000, endyear: 0.4 };
const FEW_ROUNDS = 6; // < 6 elapsed rounds → pattern_note "ข้อมูลยังน้อย" (spec §6.2)
// Rule 4 ("share") cut-off (brief 2s §2): item's network fy-to-date req baht ≥ 0.5 % of the network total AND ≥ 3 PCUs requested it.
const SHARE_MIN_NET = 0.005, SHARE_MIN_PCUS = 3;
const RULE_ORDER = { p90: 0, pace: 1, share: 2 };

export function patternOf(vals) {
  let annual = 0, active = 0;
  for (const v of vals) { annual += v; if (v > 0) active++; }
  if (!(annual > 0)) return "ไม่เบิก";
  if (active <= PAT.sparse_months && annual < PAT.sparse_baht) return "เบาบาง";
  const s = vals.filter((v) => v > 0).sort((a, b) => b - a);
  const top1 = s[0] / annual, top3 = ((s[0] || 0) + (s[1] || 0) + (s[2] || 0)) / annual;
  if (top1 >= PAT.top1_single) return "เบิกครั้งเดียว";
  if (top3 >= PAT.top3_burst) return "กระจุกเป็นช่วง";
  if (active >= PAT.months_steady && top1 < PAT.top1_steady) return "สม่ำเสมอ";
  return "ผสม";
}
// q4 share (ก.ค.+ส.ค.+ก.ย. = the last 3 Excel months of a full fiscal year) ≥ 0.40
function endyearOf(vals12) {
  const annual = vals12.reduce((a, v) => a + v, 0);
  return annual > 0 && (vals12[9] + vals12[10] + vals12[11]) / annual >= PAT.endyear;
}

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

// shared request context: current round, config, fy (BAD_REQUEST before any NOT_FOUND), its rounds without the trial round
async function dashCtx(DB, p) {
  const cur = currentRound();
  const cfg = publicConfig(await getConfigAll(DB), monthFy(cur));
  const fy = parseFy(p.fy, cfg.fy_current);
  const trial = cfg.trial_month;
  const all = fyMonths(fy);
  const rounds = all.filter((m) => m !== trial);
  return { cur, cfg, fy, trial, trialArg: trial || "", all, rounds, elapsed: rounds.filter((m) => m <= cur).length };
}

// fys: fiscal years with a sent (non-trial-round) request that have a form, + fy_current; newest first
function fysFrom(cfg, trial, monthRes, fyRes) {
  const withForm = new Set(fyRes.map((r) => r[0]));
  const fySet = new Set([cfg.fy_current]);
  for (const [m] of monthRes) if (m !== trial) { const f = monthFy(m); if (withForm.has(f)) fySet.add(f); }
  return [...fySet].sort((a, b) => b - a);
}

// price of an actual_prev (fy−1) row: prices_prev, else the price in the latest form of fy−1, else of fy (that form loaded once, lazily)
function prevPricer(DB, fy, form) {
  let prevForm = null;
  return {
    async ensure() { if (!prevForm) prevForm = (await strictForm(DB, fy - 1)) || form; },
    price(code, pr) {
      if (pr !== null && pr !== undefined) return pr;
      const ent = prevForm.index.get(code) || form.index.get(code);
      return ent ? Number(ent.item.price) || 0 : 0;
    },
  };
}

// item lookup over the fy's latest form first, then the other loaded forms
function entLookup(form, forms) {
  return (code) => {
    if (form.index.has(code)) return form.index.get(code);
    for (const f of forms.values()) if (f.index.has(code)) return f.index.get(code);
    return null;
  };
}
const orderBy = (codes) => new Map(codes.map((c, i) => [c, i]));
const cmpCode = (ord) => (a, b) => {
  const x = ord.has(a) ? ord.get(a) : 1e9, y = ord.has(b) ? ord.get(b) : 1e9;
  return x !== y ? x - y : a < b ? -1 : a > b ? 1 : 0;
};
// top 3 codes by a value (> 0), ties in item order
function top3(valOf, codes, ord) {
  const cmp = cmpCode(ord);
  return codes.filter((c) => valOf(c) > 0).sort((a, b) => valOf(b) - valOf(a) || cmp(a, b)).slice(0, 3);
}

// ---- one PCU (pcuDashboard = PCU view; adminDashboard{pcu} = staff view) ---------------------------------------------------------
// staff=false: got = issued_total only when the line's dispense unit is done (Q78) · staff=true: got = issued_total whenever not null.
async function pcuCore(DB, c, pcu, staff) {
  const { cfg, fy, trial, all, rounds, trialArg, elapsed } = c;
  const [form, lineRes, doneRes, planRes, hidRes, prevRes, monthRes, fyRes] = await Promise.all([
    strictForm(DB, fy),
    DB.prepare(
      `SELECT r.month AS m, r.form_version_id AS fv, l.item_code AS c, COALESCE(l.op,0) + COALESCE(l.pp,0) AS q,
              l.issued_total AS it, l.used AS u, l.price_snapshot AS ps
         FROM requests r JOIN request_lines l ON l.request_id = r.id
        WHERE r.pcu = ? AND r.month >= ? AND r.month <= ? AND r.month != ? AND r.status IN ${SENT}
          AND (COALESCE(l.op,0) + COALESCE(l.pp,0) > 0 OR l.used IS NOT NULL)`
    ).bind(pcu, all[0], all[11], trialArg).raw(),
    staff ? [] : DB.prepare(
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
  const entOf = (code, fv) => formOf(fv).index.get(code) || entLookup(form, forms)(code);

  const done = new Set(doneRes.map(([m, u]) => m + "|" + u));
  let hist = null; // price_history of fy — loaded only when a line has no price_snapshot
  if (lineRes.some((r) => r[6] === null || r[6] === undefined)) hist = await loadPriceHistory(DB, fy);

  // ---- monthly (one pass) ----
  const monthly = {}, cum = new Map(), withUsed = new Set(), withReq = new Set();
  const roundBaht = new Map(); // round → unrounded req baht (2s pattern)
  const lm = linkMap(form); // 2v: lines of a linked old code count under the code that replaces it
  for (const [m, fv, code0, q, it, u, ps] of lineRes) {
    const price = ps !== null && ps !== undefined ? ps : priceFor(hist, form.index.has(code0) ? form : formOf(fv), code0, m) ?? 0;
    let got = 0;
    if (q > 0 && it !== null && it !== undefined) {
      if (staff) got = it; // staff view (2s): every unit, no need to wait for done
      else { // PCU view rule (Q78): figures of DONE units only
        const ent = formOf(fv).index.get(code0);
        if (ent && done.has(m + "|" + ent.step.dispense_unit)) got = it;
      }
    }
    const code = linkedCode(lm, code0);
    const used = u ?? 0;
    if (u !== null && u !== undefined) withUsed.add(code);
    if (q > 0) { withReq.add(code); cum.set(code, (cum.get(code) || 0) + q); roundBaht.set(m, (roundBaht.get(m) || 0) + q * price); }
    if (!q && !got && !used) continue;
    const t = ((monthly[code] ||= {})[m] ||= [0, 0, 0, 0, 0, 0]);
    const add = [q, q * price, got, got * price, used, used * price];
    for (let i = 0; i < 6; i++) t[i] = i % 2 ? r2(t[i] + add[i]) : t[i] + add[i];
  }

  // ---- items ----
  const plan = new Map(planRes.map(([code, q]) => [code, Number(q) || 0]));
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
  const flags = [];
  if (elapsed > 0) {
    for (const code of Object.keys(items)) {
      const pq = items[code].plan_qty, cq = cum.get(code) || 0;
      if (pq > 0 && cq > (pq * elapsed / 12) * 1.2) flags.push({ code, rule: "pace", cum_qty: cq, plan_qty: pq, elapsed });
    }
  }

  // ---- prev_fy: actual_prev of fy−1 aligned to `rounds` (round X ↔ Excel month X−1 of the previous year = monthMinus(X, 13)) ----
  const pricer = prevPricer(DB, fy, form);
  let prev_fy = null;
  if (prevRes.length) {
    if (prevRes.some((r) => r[3] === null || r[3] === undefined)) await pricer.ensure();
    const months = rounds.map((m) => monthMinus(m, 13));
    const idx = new Map(months.map((m, i) => [m, i]));
    const qty = new Array(months.length).fill(0), baht = new Array(months.length).fill(0);
    for (const [m, code, q, pr] of prevRes) {
      const i = idx.get(m);
      if (i === undefined) continue;
      qty[i] += q; baht[i] += q * pricer.price(code, pr);
    }
    prev_fy = { months, qty: qty.map(r2), baht: baht.map(r2) };
  }

  const fys = fysFrom(cfg, trial, monthRes, fyRes);
  return {
    out: {
      fy, fys, rounds, items, monthly, prev_fy,
      used_coverage: { items_with_used: withUsed.size, items_total: withReq.size },
      flags,
    },
    form, lm, prevRes, pricer, cum, roundBaht,
  };
}

export async function pcuDashboard(ctx, p) {
  const c = await dashCtx(ctx.DB, p);
  return (await pcuCore(ctx.DB, c, ctx.pcu.code, false)).out;
}

// ---- network aggregates (2s) -------------------------------------------------------------------------------------------------
const LINES = `FROM requests r JOIN request_lines l ON l.request_id = r.id JOIN pcus p ON p.code = r.pcu`;
const LINES_WHERE = `r.month >= ? AND r.month <= ? AND r.month != ? AND r.status IN ${SENT} AND ${NOT_TRIAL} AND (${Q} > 0 OR l.used IS NOT NULL)`;
// V6 sums: qty over every line, baht over lines with a price_snapshot (the others are added in JS via priceFor). got = staff view.
const V6_SQL = `SUM(${Q}), TOTAL(${Q} * l.price_snapshot),
  SUM(CASE WHEN ${Q} > 0 THEN COALESCE(l.issued_total,0) ELSE 0 END), TOTAL(CASE WHEN ${Q} > 0 THEN l.issued_total * l.price_snapshot END),
  SUM(COALESCE(l.used,0)), TOTAL(l.used * l.price_snapshot)`;

const addTo = (map, k1, k2) => {
  let m = map.get(k1);
  if (!m) map.set(k1, (m = new Map()));
  let v = m.get(k2);
  if (!v) m.set(k2, (v = [0, 0, 0, 0, 0, 0]));
  return v;
};
const rowsToMap = (rows, lm) => {
  const out = new Map();
  for (const [a, b, ...v] of rows) { const t = addTo(out, a, linkedCode(lm, b)); for (let i = 0; i < 6; i++) t[i] += Number(v[i]) || 0; }
  return out;
};

// pi: Map pcu → Map code → [rq, rb, gq, gb, uq, ub] (unrounded) · full: + ri (round → code → V6) and pr (pcu → round → req baht)
async function networkData(DB, c, formP, full) {
  const bind = [c.all[0], c.all[11], c.trialArg];
  const [piRes, riRes, prRes, nullRes] = await Promise.all([
    DB.prepare(`SELECT r.pcu, l.item_code, ${V6_SQL} ${LINES} WHERE ${LINES_WHERE} GROUP BY r.pcu, l.item_code`).bind(...bind).raw(),
    full ? DB.prepare(`SELECT r.month, l.item_code, ${V6_SQL} ${LINES} WHERE ${LINES_WHERE} GROUP BY r.month, l.item_code`).bind(...bind).raw() : [],
    full ? DB.prepare(`SELECT r.pcu, r.month, TOTAL(${Q} * l.price_snapshot) ${LINES} WHERE ${LINES_WHERE} GROUP BY r.pcu, r.month`).bind(...bind).raw() : [],
    DB.prepare(`SELECT r.pcu, r.month, r.form_version_id, l.item_code, ${Q}, l.issued_total, l.used ${LINES}
                 WHERE ${LINES_WHERE} AND l.price_snapshot IS NULL`).bind(...bind).raw(),
  ]);
  const lm = linkMap(await formP);
  const pi = rowsToMap(piRes, lm), ri = rowsToMap(riRes, lm);
  const pr = new Map();
  for (const [pcu, m, b] of prRes) { if (!pr.has(pcu)) pr.set(pcu, new Map()); pr.get(pcu).set(m, Number(b) || 0); }
  if (nullRes.length) { // priceFor fallback (as pcuDashboard): the latest form when it has the code, else the line's bound form
    const form = await formP;
    const hist = await loadPriceHistory(DB, c.fy);
    const forms = new Map();
    for (const fv of new Set(nullRes.filter((r) => form && !form.index.has(r[3]) && r[2]).map((r) => r[2]))) forms.set(fv, await loadForm(DB, fv));
    for (const [pcu, m, fv, code, q, it, u] of nullRes) {
      const f = form && form.index.has(code) ? form : forms.get(fv) || form;
      const price = priceFor(hist, f, code, m) ?? 0;
      const got = q > 0 && it !== null && it !== undefined ? it : 0, used = u ?? 0;
      const add = (t) => { t[1] += q * price; t[3] += got * price; t[5] += used * price; };
      add(addTo(pi, pcu, linkedCode(lm, code)));
      if (full) {
        add(addTo(ri, m, linkedCode(lm, code)));
        if (!pr.has(pcu)) pr.set(pcu, new Map());
        pr.get(pcu).set(m, (pr.get(pcu).get(m) || 0) + q * price);
      }
    }
  }
  return { pi, ri, pr };
}

// rule 1 rows [pcu, code, round, qty, p90_m]: qty of the pcu × item in a round > its stats p90_m (stats of fy−1 = the data year).
// No stats row (or p90_m ≤ 0) → the item is skipped.
// 2v: an item with no stats row of its own uses the stats of the old code(s) it links (highest p90) · flags of a linked old code's
// lines are reported under the new code.
async function p90Query(DB, c, pcu, formP) {
  const lm = linkMap(await formP);
  const pairs = [...lm];
  const src = pairs.length
    ? `(SELECT fy, pcu, item_code, p90_m FROM stats
        UNION ALL
        SELECT s.fy, s.pcu, lk.n, MAX(s.p90_m) FROM stats s JOIN (${pairs.map(() => "SELECT ? AS o, ? AS n").join(" UNION ALL ")}) lk ON lk.o = s.item_code
         WHERE NOT EXISTS (SELECT 1 FROM stats s2 WHERE s2.fy = s.fy AND s2.pcu = s.pcu AND s2.item_code = lk.n) GROUP BY s.fy, s.pcu, lk.n)`
    : "stats";
  const rows = await DB.prepare(
    `SELECT r.pcu, l.item_code, r.month, ${Q}, s.p90_m ${LINES}
       JOIN ${src} s ON s.fy = ? AND s.pcu = r.pcu AND s.item_code = l.item_code
      WHERE ${LINES_WHERE} AND s.p90_m > 0 AND ${Q} > s.p90_m${pcu ? " AND r.pcu = ?" : ""}`
  ).bind(...pairs.flat(), c.fy - 1, c.all[0], c.all[11], c.trialArg, ...(pcu ? [pcu] : [])).raw();
  for (const r of rows) r[1] = linkedCode(lm, r[1]);
  return rows;
}

// rule 4: share of the pcu in the item's network req baht > 2 × the pcu's share of the network req baht total,
// only for items with network baht ≥ 0.5 % of the total and requested (req > 0) by ≥ 3 PCUs. → [{pcu, code, rule, value, threshold}]
function shareFlags(pi) {
  const netB = new Map(), netN = new Map(), pcuB = new Map();
  let total = 0;
  for (const [pcu, m] of pi) {
    let s = 0;
    for (const [code, v] of m) {
      s += v[1];
      netB.set(code, (netB.get(code) || 0) + v[1]);
      if (v[0] > 0) netN.set(code, (netN.get(code) || 0) + 1);
    }
    pcuB.set(pcu, s); total += s;
  }
  const out = [];
  if (!(total > 0)) return out;
  for (const [pcu, m] of pi) {
    const thr = 2 * pcuB.get(pcu) / total;
    for (const [code, v] of m) {
      const nb = netB.get(code) || 0;
      if (v[0] <= 0 || nb < SHARE_MIN_NET * total || (netN.get(code) || 0) < SHARE_MIN_PCUS || !(nb > 0)) continue;
      const share = v[1] / nb;
      if (share > thr) out.push({ pcu, code, rule: "share", value: r4(share), threshold: r4(thr) });
    }
  }
  return out;
}

// ---- adminDashboard ---------------------------------------------------------------------------------------------------------------
export async function adminDashboard(ctx, p) {
  const { DB } = ctx;
  const c = await dashCtx(DB, p);
  if (p.pcu !== undefined && p.pcu !== null && p.pcu !== "") return adminPcuView(DB, c, String(p.pcu).trim().toUpperCase());
  return adminNetwork(DB, c);
}

async function adminPcuView(DB, c, code) {
  const row = await DB.prepare(`SELECT code, name, "group" AS grp FROM pcus WHERE code = ?`).bind(code).first();
  if (!row || row.grp === TRIAL_GROUP) throw err("NOT_FOUND", "ไม่พบ รพ.สต. นี้");
  const formP = strictForm(DB, c.fy);
  const [core, p90Res, net] = await Promise.all([
    pcuCore(DB, c, row.code, true),
    p90Query(DB, c, row.code, formP),
    networkData(DB, c, formP, false),
  ]);
  const { out, lm, prevRes, pricer, cum, roundBaht } = core;
  const codes = Object.keys(out.items), ord = orderBy(codes), cmp = cmpCode(ord);

  // flags: every rule, ordered as items, then p90 → pace → share, then round
  const flags = [];
  for (const [, c2, m, q, p90] of p90Res) flags.push({ code: c2, rule: "p90", round: m, value: q, threshold: p90 });
  for (const f of out.flags) {
    flags.push({ code: f.code, rule: "pace", value: f.cum_qty, threshold: r2(f.plan_qty * f.elapsed / 12 * 1.2), cum_qty: f.cum_qty, plan_qty: f.plan_qty, elapsed: f.elapsed });
  }
  for (const f of shareFlags(net.pi)) if (f.pcu === row.code) flags.push({ code: f.code, rule: f.rule, value: f.value, threshold: f.threshold });
  flags.sort((a, b) => cmp(a.code, b.code) || RULE_ORDER[a.rule] - RULE_ORDER[b.rule] || (a.round || "").localeCompare(b.round || ""));

  // top 3 of the pcu (req qty / req baht of the fy)
  const mine = net.pi.get(row.code) || new Map();
  const bahtOf = (k) => (mine.get(k) ? mine.get(k)[1] : 0);
  const reqCodes = [...cum.keys()];

  // pattern: this year = req baht of the elapsed rounds · previous year = actual_prev fy−1 × prices_prev over its 12 Excel months
  const pattern = patternOf(c.rounds.filter((m) => m <= c.cur).map((m) => roundBaht.get(m) || 0));
  let pattern_prev = null, endyear_prev = false;
  const prevCodes = new Set();
  if (prevRes.length) {
    if (prevRes.some((r) => r[3] === null || r[3] === undefined)) await pricer.ensure();
    const xm = fyExcelMonths(c.fy - 1), idx = new Map(xm.map((m, i) => [m, i]));
    const vals = new Array(12).fill(0);
    for (const [m, code2, q, pr] of prevRes) {
      prevCodes.add(linkedCode(lm, code2));
      const i = idx.get(m);
      if (i !== undefined) vals[i] += q * pricer.price(code2, pr);
    }
    pattern_prev = patternOf(vals); endyear_prev = endyearOf(vals);
  }
  // rule 3 (info only): requested this fy, never in actual_prev fy−1 of this pcu (only when the pcu has actual_prev fy−1 rows)
  const info_new = prevRes.length ? codes.filter((k) => (cum.get(k) || 0) > 0 && !prevCodes.has(k)) : [];

  return {
    ...out, flags, elapsed: c.elapsed,
    pcu: { code: row.code, name: row.name },
    top3: { qty: top3((k) => cum.get(k) || 0, reqCodes, ord), baht: top3(bahtOf, reqCodes, ord) },
    pattern, pattern_prev, pattern_note: c.elapsed < FEW_ROUNDS ? "ข้อมูลยังน้อย" : null, endyear_prev, info_new,
  };
}

async function adminNetwork(DB, c) {
  const { fy, cfg, trial, all, cur, elapsed } = c;
  const formP = strictForm(DB, fy);
  const [form, net, p90Res, planRes, pcuRes, prevMonRes, prevItemRes, monthRes, fyRes] = await Promise.all([
    formP,
    networkData(DB, c, formP, true),
    p90Query(DB, c, null, formP),
    DB.prepare(`SELECT pl.pcu, pl.item_code, COALESCE(pl.plan_op,0) + COALESCE(pl.plan_pp,0) AS q FROM plans pl JOIN pcus p ON p.code = pl.pcu
                 WHERE pl.fy = ? AND ${NOT_TRIAL} AND COALESCE(pl.plan_op,0) + COALESCE(pl.plan_pp,0) > 0`).bind(fy).raw(),
    DB.prepare(`SELECT p.code, p.name FROM pcus p WHERE ${NOT_TRIAL} ORDER BY p.code`).raw(),
    DB.prepare(`SELECT a.pcu, a.month, SUM(${QA}) AS q, TOTAL(${QA} * pp.price), SUM(CASE WHEN pp.price IS NULL THEN ${QA} ELSE 0 END)
                  FROM actual_prev a JOIN pcus p ON p.code = a.pcu LEFT JOIN prices_prev pp ON pp.fy = a.fy AND pp.item_code = a.item_code
                 WHERE a.fy = ? AND ${NOT_TRIAL} GROUP BY a.pcu, a.month HAVING q > 0`).bind(fy - 1).raw(),
    DB.prepare(`SELECT a.pcu, a.item_code FROM actual_prev a WHERE a.fy = ? GROUP BY a.pcu, a.item_code HAVING SUM(${QA}) > 0`).bind(fy - 1).raw(),
    DB.prepare(`SELECT DISTINCT r.month FROM requests r JOIN pcus p ON p.code = r.pcu WHERE r.status IN ${SENT} AND ${NOT_TRIAL}`).raw(),
    DB.prepare(`SELECT DISTINCT fy FROM form_versions`).raw(),
  ]);
  if (!form) throw err("NOT_FOUND", `ไม่พบแบบฟอร์มของปีงบ ${fy}`);
  const { pi, ri, pr } = net;

  // ---- items: active items of the fy's latest form + every code with data (looked up in the bound versions when missing) ----
  const dataCodes = new Set();
  for (const m of pi.values()) for (const k of m.keys()) dataCodes.add(k);
  const forms = new Map([[form.id, form]]);
  if ([...dataCodes].some((k) => !form.index.has(k))) {
    const fvRes = await DB.prepare(`SELECT DISTINCT form_version_id FROM requests WHERE month >= ? AND month <= ? AND status IN ${SENT}`).bind(all[0], all[11]).raw();
    for (const [fv] of fvRes) if (fv && !forms.has(fv)) { const f = await loadForm(DB, fv); if (f) forms.set(fv, f); }
  }
  const entOf = entLookup(form, forms);
  const netPlan = new Map();
  for (const [, code, q] of planRes) netPlan.set(code, (netPlan.get(code) || 0) + (Number(q) || 0));
  const items = {};
  const put = (code, ent) => {
    items[code] = {
      name: ent ? ent.item.name : code, unit: (ent && ent.item.unit) || "",
      unit_group: ent ? ent.step.dispense_unit : null, net_plan_qty: r2(netPlan.get(code) || 0),
    };
  };
  for (const [code, ent] of form.index) if (dataCodes.has(code) || (ent.item.active !== false && ent.step.active !== false)) put(code, ent);
  for (const code of dataCodes) if (!items[code]) put(code, entOf(code));
  const codes = Object.keys(items), ord = orderBy(codes), cmp = cmpCode(ord);
  const unitOf = (code) => (items[code] && items[code].unit_group) || (entOf(code) && entOf(code).step.dispense_unit) || DEFAULT_UNIT_BY_STEP();
  const blank = () => Object.fromEntries(UNITS.map((u) => [u, 0]));

  // ---- network.monthly / network.items ----
  const monthly = Object.fromEntries(UNITS.map((u) => [u, {}]));
  for (const [m, byCode] of ri) for (const [code, v] of byCode) {
    const u = unitOf(code);
    const t = ((monthly[u] ||= {})[m] ||= [0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 6; i++) t[i] += v[i];
  }
  for (const u of Object.keys(monthly)) for (const m of Object.keys(monthly[u])) {
    const t = monthly[u][m];
    if (t.every((x) => !x)) delete monthly[u][m]; else monthly[u][m] = t.map(r2);
  }
  const netItems = new Map();
  for (const byCode of pi.values()) for (const [code, v] of byCode) {
    const t = netItems.get(code) || [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6; i++) t[i] += v[i];
    netItems.set(code, t);
  }
  const netItemsOut = {};
  for (const code of [...netItems.keys()].sort(cmp)) { const t = netItems.get(code); if (t.some((x) => x)) netItemsOut[code] = t.map(r2); }

  // ---- plans → plan baht (latest form price) per pcu × unit ----
  const planBy = new Map(); // pcu → Map code → plan qty
  for (const [pcu, code, q] of planRes) { if (!planBy.has(pcu)) planBy.set(pcu, new Map()); planBy.get(pcu).set(code, Number(q) || 0); }

  // ---- flags ----
  const flags = [];
  for (const [pcu, code, m, q, p90] of p90Res) flags.push({ pcu, code, rule: "p90", round: m, value: q, threshold: p90 });
  if (elapsed > 0) {
    for (const [pcu, byCode] of planBy) for (const [code, pq] of byCode) {
      const v = pi.get(pcu) && pi.get(pcu).get(code), cq = v ? v[0] : 0, thr = (pq * elapsed / 12) * 1.2;
      if (cq > thr) flags.push({ pcu, code, rule: "pace", value: cq, threshold: r2(thr) });
    }
  }
  flags.push(...shareFlags(pi));
  flags.sort((a, b) => (a.pcu < b.pcu ? -1 : a.pcu > b.pcu ? 1 : 0) || cmp(a.code, b.code) || RULE_ORDER[a.rule] - RULE_ORDER[b.rule]
    || (a.round || "").localeCompare(b.round || ""));
  const nFlags = new Map();
  for (const f of flags) nFlags.set(f.pcu, (nFlags.get(f.pcu) || 0) + 1);

  // ---- previous year: pattern_prev / endyear_prev / rule 3 ----
  const xm = fyExcelMonths(fy - 1), xIdx = new Map(xm.map((m, i) => [m, i]));
  const prevVals = new Map();
  let needFallback = false;
  for (const [pcu, m, , b, nq] of prevMonRes) {
    if (!prevVals.has(pcu)) prevVals.set(pcu, new Array(12).fill(0));
    const i = xIdx.get(m);
    if (i !== undefined) prevVals.get(pcu)[i] += Number(b) || 0;
    if (nq > 0) needFallback = true;
  }
  if (needFallback) { // items without a prices_prev row: price of the latest fy−1 form, else of fy (as pcuDashboard prev_fy)
    const pricer = prevPricer(DB, fy, form);
    await pricer.ensure();
    const res = await DB.prepare(`SELECT a.pcu, a.month, a.item_code, SUM(${QA}) AS q FROM actual_prev a LEFT JOIN prices_prev pp ON pp.fy = a.fy AND pp.item_code = a.item_code
                                   WHERE a.fy = ? AND pp.price IS NULL GROUP BY a.pcu, a.month, a.item_code HAVING q > 0`).bind(fy - 1).raw();
    for (const [pcu, m, code, q] of res) {
      const i = xIdx.get(m);
      if (i !== undefined && prevVals.has(pcu)) prevVals.get(pcu)[i] += q * pricer.price(code, null);
    }
  }
  const lmNet = linkMap(form);
  const prevItems = new Set(prevItemRes.map(([pcu, code]) => pcu + "\u0000" + linkedCode(lmNet, code)));
  const info_new = [];

  // ---- pcus ----
  const elapsedRounds = c.rounds.filter((m) => m <= cur);
  const note = elapsed < FEW_ROUNDS ? "ข้อมูลยังน้อย" : null;
  const planBaht = blank(), onPlan = blank();
  const pcus = [];
  for (const [code, name] of pcuRes) {
    const byCode = pi.get(code) || new Map(), plans = planBy.get(code) || new Map();
    const units = Object.fromEntries(UNITS.map((u) => [u, [0, 0, 0, 0]]));
    let rb = 0, gb = 0;
    for (const [k, v] of byCode) {
      const u = (units[unitOf(k)] ||= [0, 0, 0, 0]);
      u[0] += v[1]; u[1] += v[3]; rb += v[1]; gb += v[3];
      if ((plans.get(k) || 0) > 0) u[3] += v[1];
      if (v[0] > 0 && prevVals.has(code) && !prevItems.has(code + "\u0000" + k)) info_new.push({ pcu: code, code: k });
    }
    for (const [k, q] of plans) {
      const ent = entOf(k), pb = q * (formPrice(form, k) ?? (ent ? Number(ent.item.price) || 0 : 0)); // latest form price
      if (!pb) continue;
      (units[unitOf(k)] ||= [0, 0, 0, 0])[2] += pb;
    }
    let pbT = 0, opT = 0;
    for (const u of Object.keys(units)) {
      planBaht[u] = (planBaht[u] || 0) + units[u][2]; onPlan[u] = (onPlan[u] || 0) + units[u][3];
      pbT += units[u][2]; opT += units[u][3];
      units[u] = units[u].map(r2);
    }
    const pv = prevVals.get(code);
    pcus.push({
      code, name, req_baht: r2(rb), got_baht: r2(gb), plan_baht: r2(pbT), pct_plan: pbT > 0 ? r4(opT / pbT) : null, units,
      pattern: patternOf(elapsedRounds.map((m) => (pr.get(code) && pr.get(code).get(m)) || 0)),
      pattern_prev: pv ? patternOf(pv) : null, pattern_note: note, endyear_prev: pv ? endyearOf(pv) : false,
      n_flags: nFlags.get(code) || 0,
    });
  }
  pcus.sort((a, b) => b.req_baht - a.req_baht || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  info_new.sort((a, b) => (a.pcu < b.pcu ? -1 : a.pcu > b.pcu ? 1 : 0) || cmp(a.code, b.code));

  const netCodes = [...netItems.keys()];
  return {
    fy, fys: fysFrom(cfg, trial, monthRes, fyRes), rounds: c.rounds, elapsed, items,
    network: {
      monthly, items: netItemsOut,
      plan_baht: Object.fromEntries(Object.entries(planBaht).map(([u, v]) => [u, r2(v)])),
      req_baht_on_plan: Object.fromEntries(Object.entries(onPlan).map(([u, v]) => [u, r2(v)])),
      top3: { qty: top3((k) => netItems.get(k)[0], netCodes, ord), baht: top3((k) => netItems.get(k)[1], netCodes, ord) },
    },
    pcus, flags, info_new,
  };
}

// ---- issueShortage (admin + dispenser) ----------------------------------------------------------------------------------------------
// Lines (pcu × round × item) of sent requests with issued_total set (staff view), never the trial round / group ทดลอง.
// short = max(req − issued_total, 0) · short_baht = short × price_snapshot (fallback priceFor) · unit of a line = its bound form's page.
export async function issueShortage(ctx, p) {
  const { DB, who } = ctx;
  const scope = p.scope === undefined || p.scope === null || p.scope === "" ? "round" : p.scope;
  if (scope !== "round" && scope !== "fy") throw err("BAD_REQUEST", 'scope ต้องเป็น "round" หรือ "fy"');
  let unit = p.unit;
  if (unit === undefined || unit === null || unit === "") {
    unit = who.role === "dispenser" ? (who.units || []).find((u) => UNITS.includes(u)) || "all" : "all";
  } else if (unit !== "all" && !UNITS.includes(unit)) throw err("BAD_REQUEST", "หน่วยจ่ายไม่ถูกต้อง (พัสดุ / จ่ายกลาง / LAB / all)");
  const hasMonth = scope === "round" && p.month !== undefined && p.month !== null && p.month !== "";
  if (hasMonth && !isMonth(p.month)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง");
  const c = await dashCtx(DB, hasMonth && (p.fy === undefined || p.fy === null || p.fy === "") ? { fy: monthFy(p.month) } : p);
  const { fy, all, trialArg } = c;
  if (hasMonth && !all.includes(p.month)) throw err("BAD_REQUEST", `รอบ ${p.month} ไม่อยู่ในปีงบ ${fy}`);

  let month = null;
  if (scope === "round") {
    month = hasMonth ? p.month : null;
    if (!month) {
      const hi = c.cur < all[11] ? c.cur : all[11];
      const row = await DB.prepare(`SELECT MAX(r.month) AS m FROM requests r JOIN pcus p ON p.code = r.pcu
                                     WHERE r.month >= ? AND r.month <= ? AND r.month != ? AND r.status IN ${SENT} AND ${NOT_TRIAL}`)
        .bind(all[0], hi, trialArg).first();
      // none → currentRound, kept inside the fy (a past fy → its last round, a future fy → its first)
      month = (row && row.m) || (c.cur < all[0] ? all[0] : c.cur > all[11] ? all[11] : c.cur);
    }
  }
  const [lo, hi] = scope === "round" ? [month, month] : [all[0], all[11]];
  const W = `FROM requests r JOIN request_lines l ON l.request_id = r.id JOIN pcus p ON p.code = r.pcu
             WHERE r.month >= ? AND r.month <= ? AND r.month != ? AND r.status IN ${SENT} AND ${NOT_TRIAL} AND ${Q} > 0 AND l.issued_total IS NOT NULL`;
  const [latest, aggRes, shortRes] = await Promise.all([
    formForFy(DB, fy, c.cfg.fy_current),
    DB.prepare(`SELECT r.form_version_id, l.item_code, SUM(CASE WHEN l.issued_total >= ${Q} THEN 1 ELSE 0 END), SUM(CASE WHEN l.issued_total < ${Q} THEN 1 ELSE 0 END),
                       SUM(${Q}), SUM(l.issued_total) ${W} GROUP BY r.form_version_id, l.item_code`).bind(lo, hi, trialArg).raw(),
    DB.prepare(`SELECT r.pcu, p.name, r.month, r.form_version_id, l.item_code, ${Q}, l.issued_total, l.price_snapshot, l.issue_reason, l.issue_note
                 ${W} AND l.issued_total < ${Q} ORDER BY r.pcu, r.month`).bind(lo, hi, trialArg).raw(),
  ]);
  const forms = new Map();
  for (const fv of new Set(aggRes.map((r) => r[0]).filter(Boolean))) { const f = await loadForm(DB, fv); if (f) forms.set(fv, f); }
  const formOf = (fv) => (fv && forms.get(fv)) || latest;
  const entOf = (code, fv) => (latest && latest.index.get(code)) || (formOf(fv) && formOf(fv).index.get(code)) || null;
  const unitLine = (code, fv) => { const e = (formOf(fv) && formOf(fv).index.get(code)) || entOf(code, fv); return e ? e.step.dispense_unit : null; };
  const keep = (code, fv) => unit === "all" || unitLine(code, fv) === unit;

  const byItem = new Map(), summary = { complete: 0, incomplete: 0, short_qty: 0, short_baht: 0 };
  const itemOf = (code, fv) => {
    if (!byItem.has(code)) {
      const e = entOf(code, fv);
      byItem.set(code, { code, name: e ? e.item.name : code, unit: (e && e.item.unit) || "", unit_group: e ? e.step.dispense_unit : null,
        req_qty: 0, issued_qty: 0, short_qty: 0, short_baht: 0, n_pcus: 0, pcus: new Set() });
    }
    return byItem.get(code);
  };
  for (const [fv, code, nc, ni, rq, iq] of aggRes) {
    if (!keep(code, fv)) continue;
    summary.complete += nc; summary.incomplete += ni;
    const it = itemOf(code, fv);
    it.req_qty += rq; it.issued_qty += iq;
  }
  let hist = null;
  if (shortRes.some((r) => r[7] === null || r[7] === undefined)) hist = await loadPriceHistory(DB, fy);
  const by_pcu = {};
  for (const [pcu, name, m, fv, code, q, iss, ps, reason, note] of shortRes) {
    if (!keep(code, fv)) continue;
    const short = Math.max(q - iss, 0);
    if (short <= 0) continue;
    const price = ps !== null && ps !== undefined ? ps : priceFor(hist, latest && latest.index.has(code) ? latest : formOf(fv), code, m) ?? 0;
    const it = itemOf(code, fv);
    it.short_qty += short; it.short_baht += short * price; it.pcus.add(pcu);
    summary.short_qty += short; summary.short_baht += short * price;
    (by_pcu[code] ||= []).push({ pcu, pcu_name: name || pcu, month: m, req: q, issued: iss, short, short_baht: r2(short * price), reason: reason ?? null, note: note ?? null });
  }
  const items = [...byItem.values()].filter((x) => x.short_qty > 0).map(({ pcus, ...x }) => ({ ...x, short_baht: r2(x.short_baht), n_pcus: pcus.size }));
  const ord = orderBy(latest ? [...latest.index.keys()] : []);
  const cmp = cmpCode(ord);
  items.sort((a, b) => b.short_qty - a.short_qty || b.short_baht - a.short_baht || cmp(a.code, b.code));
  summary.short_baht = r2(summary.short_baht);
  return { fy, scope, month, unit, rounds: c.rounds, summary, items, by_pcu };
}

