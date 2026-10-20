// Brief 2q — pure aggregation helpers for the PCU dashboard (no DOM, no imports; unit-testable in node).
// Input = the `pcuDashboard` payload (functions/API.md): monthly[code][round] = [req_qty, req_baht, got_qty, got_baht, used_qty, used_baht].

export const UNIT_ORDER = ["พัสดุ", "จ่ายกลาง", "LAB"];
export const OTHER_GROUP = "อื่น ๆ";
export const SERIES_KEYS = ["req", "got", "used"];
const IDX = { qty: { req: 0, got: 2, used: 4 }, baht: { req: 1, got: 3, used: 5 } };

function zeros(n) {
  return new Array(n).fill(0);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Distinct unit_group values of the items (UNIT_ORDER first, then any other value alphabetically). */
export function unitGroups(data) {
  const set = new Set();
  Object.keys(data.items || {}).forEach((code) => set.add(groupOf(data.items[code])));
  Object.keys(data.monthly || {}).forEach((code) => set.add(groupOf((data.items || {})[code])));
  const known = UNIT_ORDER.filter((g) => set.has(g));
  const rest = [...set].filter((g) => !UNIT_ORDER.includes(g)).sort();
  return known.concat(rest);
}

function groupOf(item) {
  return (item && item.unit_group) || OTHER_GROUP;
}

/** Latest price per piece seen in the requests of this FY (req_baht / req_qty of the latest round with req_qty > 0). */
export function latestPrice(data, code) {
  const byRound = (data.monthly || {})[code];
  if (!byRound) return null;
  for (let i = data.rounds.length - 1; i >= 0; i--) {
    const v = byRound[data.rounds[i]];
    if (v && num(v[0]) > 0) return num(v[1]) / num(v[0]);
  }
  return null;
}

/**
 * One row per item (every item of the form + any code that only appears in `monthly`).
 * Per row: m[series][roundIdx] (selected measure), cum[series], plan (selected measure or null), pct (cum.req / plan or null).
 */
export function buildRows(data, mode) {
  const rounds = data.rounds || [];
  const n = rounds.length;
  const idx = IDX[mode] || IDX.qty;
  const codes = new Set(Object.keys(data.items || {}));
  Object.keys(data.monthly || {}).forEach((c) => codes.add(c));
  const rows = [];
  codes.forEach((code) => {
    const it = (data.items || {})[code] || {};
    const byRound = (data.monthly || {})[code] || {};
    const m = { req: zeros(n), got: zeros(n), used: zeros(n) };
    rounds.forEach((r, i) => {
      const v = byRound[r];
      if (!v) return;
      SERIES_KEYS.forEach((k) => { m[k][i] = num(v[idx[k]]); });
    });
    const cum = {
      req: m.req.reduce((a, b) => a + b, 0),
      got: m.got.reduce((a, b) => a + b, 0),
      used: m.used.reduce((a, b) => a + b, 0),
    };
    const planQty = num(it.plan_qty);
    const price = latestPrice(data, code);
    let plan = null;
    if (planQty > 0) {
      if (mode === "baht") plan = price != null ? planQty * price : null;
      else plan = planQty;
    }
    rows.push({
      code,
      name: it.name || code,
      unit: it.unit || "",
      group: groupOf(it),
      planQty,
      price,
      m,
      cum,
      plan,
      pct: plan > 0 ? cum.req / plan : null,
    });
  });
  return rows;
}

function cumulative(arr) {
  let s = 0;
  return arr.map((v) => (s += v));
}

/** Index of the last round that has any activity (req/got/used) in `rows`, or -1. */
function lastActiveIndex(rows, n) {
  let last = -1;
  rows.forEach((r) => {
    for (let i = n - 1; i > last; i--) {
      if (r.m.req[i] || r.m.got[i] || r.m.used[i]) { last = i; break; }
    }
  });
  return last;
}

/** Totals per group over ALL rows (the group breakdown ignores the unit filter). */
export function groupTotals(rows, groups) {
  const out = groups.map((g) => ({ group: g, items: 0, req: 0, got: 0, used: 0 }));
  const byG = new Map(out.map((o) => [o.group, o]));
  rows.forEach((r) => {
    const o = byG.get(r.group);
    if (!o) return;
    if (r.cum.req > 0 || r.cum.got > 0 || r.cum.used > 0) o.items++;
    o.req += r.cum.req;
    o.got += r.cum.got;
    o.used += r.cum.used;
  });
  const totalReq = out.reduce((a, o) => a + o.req, 0);
  out.forEach((o) => { o.share = totalReq > 0 ? o.req / totalReq : 0; });
  return out;
}

/**
 * Everything the page draws, for (mode, unit). `unit` = "all" or a unit_group.
 * - perRound / cumul: arrays aligned to data.rounds, per series
 * - prevCum: cumulative of prev_fy (only when unit === "all"; else null) aligned to rounds
 * - pctPlan: Σ cum.req / Σ plan over the filtered rows that have a plan (baht mode: also a price), or null
 */
export function aggregate(data, mode, unit) {
  const rounds = data.rounds || [];
  const n = rounds.length;
  const allRows = buildRows(data, mode);
  const rows = unit === "all" ? allRows : allRows.filter((r) => r.group === unit);

  const perRound = { req: zeros(n), got: zeros(n), used: zeros(n) };
  rows.forEach((r) => {
    SERIES_KEYS.forEach((k) => { for (let i = 0; i < n; i++) perRound[k][i] += r.m[k][i]; });
  });
  const cumul = { req: cumulative(perRound.req), got: cumulative(perRound.got), used: cumulative(perRound.used) };
  const totals = { req: cumul.req[n - 1] || 0, got: cumul.got[n - 1] || 0, used: cumul.used[n - 1] || 0 };
  const lastActive = lastActiveIndex(rows, n);

  let prevCum = null;
  const pf = data.prev_fy;
  if (unit === "all" && pf && Array.isArray(pf[mode])) {
    prevCum = cumulative(rounds.map((_, i) => num(pf[mode][i])));
  }

  let planSum = 0;
  let reqOnPlan = 0;
  rows.forEach((r) => {
    if (r.plan > 0) { planSum += r.plan; reqOnPlan += r.cum.req; }
  });
  const pctPlan = planSum > 0 ? reqOnPlan / planSum : null;

  const withReq = rows.filter((r) => r.cum.req > 0).length;
  const withUsed = rows.filter((r) => r.cum.used > 0).length;
  let coverage = { with: withUsed, total: withReq };
  if (unit === "all" && data.used_coverage) {
    coverage = { with: num(data.used_coverage.items_with_used), total: num(data.used_coverage.items_total) };
  }

  const rowCodes = new Set(rows.map((r) => r.code));
  const flagged = new Map();
  (data.flags || []).forEach((f) => { if (f && f.rule === "pace" && rowCodes.has(f.code)) flagged.set(f.code, f); });

  const top = rows.filter((r) => r.cum.req > 0).sort((a, b) => b.cum.req - a.cum.req).slice(0, 10);

  return { rounds, rows, allRows, perRound, cumul, totals, lastActive, prevCum, pctPlan, coverage, flagged, top };
}

/** True when the payload has no request data at all. */
export function isEmpty(data) {
  return !data || !data.monthly || Object.keys(data.monthly).length === 0;
}

/** "2026-11" -> "พ.ย. 69" */
const SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
export function shortRound(monthKey) {
  const [y, m] = String(monthKey).split("-").map(Number);
  return `${SHORT[m - 1]} ${String((y + 543) % 100).padStart(2, "0")}`;
}

/** "Nice" axis ticks from 0 to >= max (about `count` steps). */
export function niceTicks(max, count = 5) {
  if (!(max > 0)) return { ticks: [0, 1], top: 1 };
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, top: ticks[ticks.length - 1] };
}

/** 0 / 500 / 1K / 1.5K / 2M */
export function compact(v) {
  const a = Math.abs(v);
  const f = (x) => String(Math.round(x * 10) / 10);
  if (a >= 1e6) return f(v / 1e6) + "M";
  if (a >= 1e3) return f(v / 1e3) + "K";
  return f(v);
}
