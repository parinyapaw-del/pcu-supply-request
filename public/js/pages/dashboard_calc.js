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
    const rq = zeros(n); // req qty / req baht per round, kept regardless of mode (heatmap, top 3, CSV, limits)
    const rb = zeros(n);
    let gq = 0;
    let uq = 0;
    rounds.forEach((r, i) => {
      const v = byRound[r];
      if (!v) return;
      SERIES_KEYS.forEach((k) => { m[k][i] = num(v[idx[k]]); });
      rq[i] = num(v[0]);
      rb[i] = num(v[1]);
      gq += num(v[2]);
      uq += num(v[4]);
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
      inForm: !!(data.items || {})[code],
      off: !!it.off,
      rq,
      rb,
      cq: rq.reduce((a, b) => a + b, 0),
      cb: rb.reduce((a, b) => a + b, 0),
      gq,
      uq,
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

// ---------------------------------------------------------------- brief 2aa (PCU dashboard cards; all pure)

/** Top `n` rows by cumulative request qty and by baht (both measures regardless of mode). Rows with 0 are skipped. */
export function top3Rows(rows, n = 3) {
  const all = rows.map((r) => ({ code: r.code, name: r.name, unit: r.unit, group: r.group, qty: r.cq, baht: r.cb }));
  const by = (key) => all.filter((r) => r[key] > 0).sort((a, b) => b[key] - a[key] || a.code.localeCompare(b.code)).slice(0, n);
  return { qty: by("qty"), baht: by("baht") };
}

/** Σ spent[code] over the given rows (unit-filtered). */
export function spentSum(rows, spent) {
  const sp = spent || {};
  return rows.reduce((a, r) => a + num(sp[r.code]), 0);
}

/**
 * Yearly ceiling (Q16): over = cumulative request qty > limit_year (every item, by % desc);
 * near = >= 80 % and not over (top 3 by %). limits = {code: limit_year}.
 */
export function limitStatus(rows, limits) {
  const over = [];
  const near = [];
  const lim = limits || {};
  rows.forEach((r) => {
    const l = num(lim[r.code]);
    if (!(l > 0) || !(r.cq > 0)) return;
    const e = { code: r.code, name: r.name, unit: r.unit, cum: r.cq, limit: l, pct: r.cq / l };
    if (r.cq > l) over.push(e);
    else if (e.pct >= 0.8) near.push(e);
  });
  over.sort((a, b) => b.pct - a.pct || a.code.localeCompare(b.code));
  near.sort((a, b) => b.pct - a.pct || a.code.localeCompare(b.code));
  return { over, near: near.slice(0, 3), nearTotal: near.length };
}

/**
 * Items of the form never requested this FY (R12): in `data.items`, not off, cum req = 0.
 * prev = requested last FY (prev_items > 0, by prev qty desc); never = not in prev_items either.
 */
export function notYetRequested(rows, prevItems) {
  const pi = prevItems || {};
  const prev = [];
  const never = [];
  rows.forEach((r) => {
    if (!r.inForm || r.off || r.cq > 0) return;
    const q = num(pi[r.code]);
    const e = { code: r.code, name: r.name, unit: r.unit, group: r.group, prevQty: q };
    (q > 0 ? prev : never).push(e);
  });
  prev.sort((a, b) => b.prevQty - a.prevQty || a.code.localeCompare(b.code));
  never.sort((a, b) => a.name.localeCompare(b.name, "th"));
  return { prev, never };
}

/** Stock card rows (Q15) from stock_latest, unit filtered, by name. got null = "รอจ่าย". total = stock + got (null when got is null). */
export function stockRows(data, unit) {
  const st = data.stock_latest || {};
  const items = data.items || {};
  const out = [];
  Object.keys(st).forEach((code) => {
    const e = st[code];
    if (!e) return;
    const it = items[code] || {};
    if (unit !== "all" && groupOf(it) !== unit) return;
    const stock = num(e.stock);
    const got = e.got == null ? null : num(e.got);
    out.push({ code, name: it.name || code, unit: it.unit || "", round: e.round, stock, got, total: got == null ? null : stock + got });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name, "th") || a.code.localeCompare(b.code));
}

/** Average per elapsed round (cum req in the row's current measure) and the 12-round projection; null when elapsed <= 0. */
export function avgPerMonth(cumReq, elapsed) {
  const e = num(elapsed);
  return e > 0 ? cumReq / e : null;
}

/** One CSV field (RFC 4180 quoting). */
export function csvField(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV text (UTF-8 BOM first) for `rows` (buildRows output; quantities, independent of the on-screen mode). */
export function buildCsv(data, rows) {
  const rounds = data.rounds || [];
  const elapsed = num(data.elapsed);
  const head = ["รหัส", "รายการ", "หน่วย", "หน่วยจ่าย", ...rounds.map((r) => `ขอเบิก ${shortRound(r)}`),
    "สะสมขอเบิก (จำนวน)", "สะสมขอเบิก (บาท)", "ได้รับจริง", "ใช้ไป", "แผนปี", "% แผน", "เฉลี่ย/เดือน", "คาดทั้งปี"];
  const r2 = (x) => Math.round(x * 100) / 100;
  const lines = [head.map(csvField).join(",")];
  rows.forEach((r) => {
    const avg = avgPerMonth(r.cq, elapsed);
    lines.push([
      r.code, r.name, r.unit, r.group, ...r.rq.map(r2), r2(r.cq), r2(r.cb), r2(r.gq), r2(r.uq),
      r.planQty > 0 ? r.planQty : "", r.planQty > 0 ? `${Math.round((r.cq / r.planQty) * 1000) / 10}%` : "",
      avg == null ? "" : r2(avg), avg == null ? "" : r2(avg * 12),
    ].map(csvField).join(","));
  });
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
