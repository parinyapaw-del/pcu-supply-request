// Brief 2s — pure aggregation helpers for the admin dashboard (no DOM; unit-testable in node).
// Input = the adminDashboard payload (briefs/2s_admin_dashboard.md §6). V6 = [req_qty, req_baht, got_qty, got_baht, used_qty, used_baht].
import { UNIT_ORDER } from "../pages/dashboard_calc.js";

const IDX = { qty: { req: 0, got: 2, used: 4 }, baht: { req: 1, got: 3, used: 5 } };

export const RULE_LABEL = {
  p90: "สูงกว่าปกติของแห่งนี้ (P90)",
  pace: "เบิกเร็วกว่าแผน",
  share: "สัดส่วนสูงกว่าภาพรวมของแห่งนี้",
  info_new: "เริ่มเบิกรายการใหม่ (ปีก่อนไม่เคยเบิก)",
};
export const RULE_ORDER = ["p90", "pace", "share", "info_new"];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const zeros = (n) => new Array(n).fill(0);

/** unit_group values present anywhere in the payload (UNIT_ORDER first, then the rest alphabetically). */
export function adminGroups(data) {
  const set = new Set();
  const net = data.network || {};
  Object.keys(net.monthly || {}).forEach((g) => set.add(g));
  Object.keys(net.plan_baht || {}).forEach((g) => set.add(g));
  Object.keys(net.req_baht_on_plan || {}).forEach((g) => set.add(g));
  Object.keys(data.items || {}).forEach((c) => { if (data.items[c] && data.items[c].unit_group) set.add(data.items[c].unit_group); });
  (data.pcus || []).forEach((p) => Object.keys(p.units || {}).forEach((g) => set.add(g)));
  const known = UNIT_ORDER.filter((g) => set.has(g));
  return known.concat([...set].filter((g) => !UNIT_ORDER.includes(g)).sort());
}

export function pickGroups(data, unit) {
  return unit === "all" ? adminGroups(data) : [unit];
}

/** True when nothing was requested at all (the real situation before the first round is sent). */
export function isAdminEmpty(data) {
  if (!data || !data.network) return true;
  const monthly = data.network.monthly || {};
  const anyMonthly = Object.keys(monthly).some((g) => Object.keys(monthly[g] || {}).length > 0);
  const anyPcu = (data.pcus || []).some((p) => num(p.req_baht) > 0 || num(p.got_baht) > 0);
  return !anyMonthly && !anyPcu;
}

function cumulative(arr) {
  let s = 0;
  return arr.map((v) => (s += v));
}

/**
 * Overview aggregate for (mode, unit) — shaped like dashboard_calc.aggregate() so the shared chart functions can draw it.
 * % แผน is always baht (the payload only carries plan / on-plan in baht): pctPlan = Σ req_baht_on_plan / Σ plan_baht.
 */
export function overviewAgg(data, mode, unit) {
  const rounds = data.rounds || [];
  const n = rounds.length;
  const idx = IDX[mode] || IDX.qty;
  const groups = pickGroups(data, unit);
  const monthly = (data.network || {}).monthly || {};
  const perRound = { req: zeros(n), got: zeros(n), used: zeros(n) };
  groups.forEach((g) => {
    const byRound = monthly[g] || {};
    rounds.forEach((r, i) => {
      const v = byRound[r];
      if (!v) return;
      perRound.req[i] += num(v[idx.req]);
      perRound.got[i] += num(v[idx.got]);
      perRound.used[i] += num(v[idx.used]);
    });
  });
  const cumul = { req: cumulative(perRound.req), got: cumulative(perRound.got), used: cumulative(perRound.used) };
  const totals = { req: cumul.req[n - 1] || 0, got: cumul.got[n - 1] || 0, used: cumul.used[n - 1] || 0 };
  let lastActive = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (perRound.req[i] || perRound.got[i] || perRound.used[i]) { lastActive = i; break; }
  }
  const net = data.network || {};
  let plan = 0;
  let onPlan = 0;
  groups.forEach((g) => { plan += num((net.plan_baht || {})[g]); onPlan += num((net.req_baht_on_plan || {})[g]); });
  return { rounds, perRound, cumul, totals, lastActive, prevCum: null, pctPlan: plan > 0 ? onPlan / plan : null, planBaht: plan, reqOnPlan: onPlan, groups };
}

/** Top `n` items of the network by qty and by baht for the unit filter (from network.items). */
export function topItemsNetwork(data, unit, n = 3) {
  const items = data.items || {};
  const net = (data.network || {}).items || {};
  const rows = [];
  Object.keys(net).forEach((code) => {
    const it = items[code] || {};
    if (unit !== "all" && it.unit_group !== unit) return;
    const v = net[code] || [];
    rows.push({ code, name: it.name || code, unit: it.unit || "", group: it.unit_group || "", qty: num(v[0]), baht: num(v[1]) });
  });
  const by = (key) => rows.filter((r) => r[key] > 0).sort((a, b) => b[key] - a[key] || a.code.localeCompare(b.code)).slice(0, n);
  return { qty: by("qty"), baht: by("baht") };
}

/** Top `n` by qty / baht for a single PCU, from its pcuDashboard-shaped payload (monthly[code][round] V6), unit filtered. */
export function topItemsPcu(data, unit, n = 3) {
  const items = data.items || {};
  const rows = [];
  Object.keys(data.monthly || {}).forEach((code) => {
    const it = items[code] || {};
    if (unit !== "all" && it.unit_group !== unit) return;
    let qty = 0;
    let baht = 0;
    Object.values(data.monthly[code] || {}).forEach((v) => { qty += num(v[0]); baht += num(v[1]); });
    rows.push({ code, name: it.name || code, unit: it.unit || "", group: it.unit_group || "", qty, baht });
  });
  const by = (key) => rows.filter((r) => r[key] > 0).sort((a, b) => b[key] - a[key] || a.code.localeCompare(b.code)).slice(0, n);
  return { qty: by("qty"), baht: by("baht") };
}

/** Per-unit_group totals over the whole network (ignores the unit filter), from network.items. */
export function groupBreakdown(data, mode) {
  const idx = IDX[mode] || IDX.qty;
  const items = data.items || {};
  const net = (data.network || {}).items || {};
  const groups = adminGroups(data);
  const out = groups.map((g) => ({ group: g, items: 0, req: 0, got: 0, used: 0, share: 0 }));
  const byG = new Map(out.map((o) => [o.group, o]));
  Object.keys(net).forEach((code) => {
    const o = byG.get((items[code] || {}).unit_group);
    if (!o) return;
    const v = net[code] || [];
    const req = num(v[idx.req]);
    const got = num(v[idx.got]);
    const used = num(v[idx.used]);
    if (req > 0 || got > 0 || used > 0) o.items++;
    o.req += req;
    o.got += got;
    o.used += used;
  });
  const total = out.reduce((a, o) => a + o.req, 0);
  out.forEach((o) => { o.share = total > 0 ? o.req / total : 0; });
  return out;
}

/** Flags + info_new of the payload as one list (rows tagged with pcu code), filtered by unit_group of the item. */
export function anomalyRows(data, unit) {
  const items = data.items || {};
  const own = data.pcu && data.pcu.code;
  const ok = (code) => unit === "all" || (items[code] || {}).unit_group === unit;
  const rows = [];
  (data.flags || []).forEach((f) => {
    if (!f || !ok(f.code)) return;
    rows.push({ rule: f.rule, pcu: f.pcu || own || "", code: f.code, round: f.round || null, value: f.value, threshold: f.threshold, cum_qty: f.cum_qty, plan_qty: f.plan_qty, elapsed: f.elapsed });
  });
  (data.info_new || []).forEach((x) => {
    const code = typeof x === "string" ? x : x && x.code;
    if (!code || !ok(code)) return;
    rows.push({ rule: "info_new", pcu: (x && x.pcu) || own || "", code });
  });
  return rows;
}

/** Network ranking rows for the unit filter. Baht only (the payload carries pcus[].units in baht). */
export function rankRows(data, unit) {
  const groups = pickGroups(data, unit);
  const flagCount = new Map();
  if (unit !== "all") {
    anomalyRows(data, unit).forEach((r) => { if (r.rule !== "info_new") flagCount.set(r.pcu, (flagCount.get(r.pcu) || 0) + 1); });
  }
  return (data.pcus || []).map((p) => {
    let req = 0, got = 0, plan = 0, onPlan = 0;
    if (unit === "all" && p.units === undefined) {
      req = num(p.req_baht); got = num(p.got_baht); plan = num(p.plan_baht);
      onPlan = p.pct_plan != null ? num(p.pct_plan) * plan : 0;
    } else {
      groups.forEach((g) => {
        const u = (p.units || {})[g];
        if (!u) return;
        req += num(u[0]); got += num(u[1]); plan += num(u[2]); onPlan += num(u[3]);
      });
    }
    return {
      code: p.code,
      name: p.name || p.code,
      req, got, plan,
      pct: plan > 0 ? onPlan / plan : null,
      pattern: p.pattern || null,
      pattern_note: p.pattern_note || null,
      pattern_prev: p.pattern_prev || null,
      endyear_prev: !!p.endyear_prev,
      flags: unit === "all" ? num(p.n_flags) : (flagCount.get(p.code) || 0),
    };
  });
}

export function sortRank(rows, key, dir) {
  const sign = dir === "asc" ? 1 : -1;
  const val = (r) => (key === "name" ? r.name : r[key] == null ? -1 : r[key]);
  return rows.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    const c = key === "name" ? String(x).localeCompare(String(y), "th") : x - y;
    return c ? sign * c : b.req - a.req || String(a.code).localeCompare(String(b.code));
  });
}
