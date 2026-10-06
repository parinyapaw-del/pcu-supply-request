// js/admin/compute.js — pure aggregation functions over the adminBootstrap payload.
// No DOM, no API calls. Every tab module calls into here so the numbers agree across tabs
// and so we compute once per (month, tab) rather than on every keystroke (perf note in brief).
import { getItemRows } from "../data.js";

export const STEP_CODES = ["P1", "P2", "P3", "P4", "P5", "CS", "LAB"];
export const STEP_ORDER_WITH_SUMMARY = ["P1", "P2", "P3", "P4", "P5", "CS", "LAB", "summary"];
export const DISPENSE_UNIT_BY_STEP = {
  P1: "งานพัสดุ", P2: "งานพัสดุ", P3: "งานพัสดุ", P4: "งานพัสดุ", P5: "งานพัสดุ",
  CS: "หน่วยจ่ายกลาง", LAB: "กลุ่มงานพยาธิวิทยา"
};
export const DISPENSE_UNITS = ["งานพัสดุ", "หน่วยจ่ายกลาง", "กลุ่มงานพยาธิวิทยา"];
export const EXTRA_ITEM_CODE = "X-113";

// ---- item catalogue (125 rows, running seq 1-125), built once after form2569.json loads --------
export function buildItems(form, bootstrap) {
  const items = [];
  let seq = 0;
  STEP_CODES.forEach((stepCode) => {
    const step = form.steps.find((s) => s.code === stepCode);
    if (!step) return;
    getItemRows(step).forEach((row) => {
      seq += 1;
      items.push({
        code: row.code,
        seq,
        step: stepCode,
        dispenseUnit: DISPENSE_UNIT_BY_STEP[stepCode] || stepCode,
        name: row.name,
        unit: row.unit || "",
        price2569: Number(row.price) || 0,
        price2568: price2568For(bootstrap, row.code)
      });
    });
  });
  return items;
}

export function price2568For(bootstrap, code) {
  if (bootstrap.items_extra && bootstrap.items_extra[code] !== undefined) {
    return Number(bootstrap.items_extra[code].price_2568) || 0;
  }
  if (bootstrap.price_2568 && bootstrap.price_2568[code] !== undefined) {
    return Number(bootstrap.price_2568[code]) || 0;
  }
  return 0;
}

export function extraItemDescriptor(bootstrap) {
  const e = bootstrap.items_extra && bootstrap.items_extra[EXTRA_ITEM_CODE];
  if (!e) return null;
  return { code: EXTRA_ITEM_CODE, name: e.name, unit: e.unit || "", price2568: Number(e.price_2568) || 0 };
}

// ---- month/round selector helpers ---------------------------------------------------------------
// A "month selection" is { type: "real", key: "2024-10" } or { type: "trial", key: "2025-09" }.
export function monthSelectOptions(bootstrap) {
  const real = bootstrap.months.map((m, idx) => ({ type: "real", key: m, idx }));
  const trial = bootstrap.rounds.map((r) => ({ type: "trial", key: r.month, round: r }));
  return { real, trial };
}

export function monthValue(sel) { return sel.type + ":" + sel.key; }
export function parseMonthValue(v) {
  const i = v.indexOf(":");
  return { type: v.slice(0, i), key: v.slice(i + 1) };
}

// ---- real-month aggregation (tabs 2, 3, 4) --------------------------------------------------------
// { code: { op, pp, pcuCount } } across all PCUs for one real month index (includes X-113).
export function actualTotalsByItem(bootstrap, monthIdx) {
  const out = {};
  bootstrap.pcus.forEach((pcu) => {
    const pcuActual = bootstrap.actual[pcu.code] || {};
    Object.keys(pcuActual).forEach((code) => {
      const a = pcuActual[code];
      const op = a.op[monthIdx] || 0;
      const pp = a.pp[monthIdx] || 0;
      if (op === 0 && pp === 0) return;
      out[code] = out[code] || { op: 0, pp: 0, pcuCount: 0 };
      out[code].op += op;
      out[code].pp += pp;
      out[code].pcuCount += 1;
    });
  });
  return out;
}

// Requests for a trial round with a usable (submitted/received) status.
export function usableTrialRequests(bootstrap, roundMonth) {
  return bootstrap.requests.filter((r) => r.month === roundMonth && (r.status === "submitted" || r.status === "received"));
}

// { code: { op, pp, pcuCount } } from submitted/received trial requests for one round.
export function trialTotalsByItem(bootstrap, roundMonth) {
  const out = {};
  usableTrialRequests(bootstrap, roundMonth).forEach((req) => {
    Object.keys(req.lines || {}).forEach((code) => {
      const l = req.lines[code];
      const op = l.op || 0, pp = l.pp || 0;
      if (op === 0 && pp === 0) return;
      out[code] = out[code] || { op: 0, pp: 0, pcuCount: 0 };
      out[code].op += op;
      out[code].pp += pp;
      out[code].pcuCount += 1;
    });
  });
  return out;
}

// One PCU's total baht for a real month, across every code it has actual data for (incl. X-113).
export function pcuMonthBaht(bootstrap, pcuCode, monthIdx) {
  const pcuActual = bootstrap.actual[pcuCode] || {};
  let total = 0;
  Object.keys(pcuActual).forEach((code) => {
    const a = pcuActual[code];
    const qty = (a.op[monthIdx] || 0) + (a.pp[monthIdx] || 0);
    if (!qty) return;
    total += qty * price2568For(bootstrap, code);
  });
  return total;
}

export function pcuYearBaht(bootstrap, pcuCode) {
  let total = 0;
  for (let m = 0; m < bootstrap.months.length; m++) total += pcuMonthBaht(bootstrap, pcuCode, m);
  return total;
}

// ---- tab 3: network budget vs actual --------------------------------------------------------------
export function networkMonthlyBudget(bootstrap) {
  const months = bootstrap.months;
  const rows = months.map((m, idx) => {
    const totals = actualTotalsByItem(bootstrap, idx);
    let op = 0, pp = 0;
    Object.keys(totals).forEach((code) => {
      const price = price2568For(bootstrap, code);
      op += totals[code].op * price;
      pp += totals[code].pp * price;
    });
    return { month: m, op, pp, total: op + pp };
  });
  let cumOp = 0, cumPp = 0, cumTotal = 0;
  rows.forEach((r) => {
    cumOp += r.op; cumPp += r.pp; cumTotal += r.total;
    r.cumOp = cumOp; r.cumPp = cumPp; r.cumTotal = cumTotal;
  });
  return rows;
}

// ---- tab 5: plan (FY68) vs actual withdrawn, per PCU -----------------------------------------------
export function planVsActual(bootstrap, items, pcuCode) {
  const plan = bootstrap.plan[pcuCode] || {};
  const pcuActual = bootstrap.actual[pcuCode] || {};
  return items.map((item) => {
    const p = plan[item.code] || [0, 0];
    const planOp = p[0] || 0, planPp = p[1] || 0, planTotal = planOp + planPp;
    const a = pcuActual[item.code];
    let actualAnnual = 0;
    if (a) { for (let m = 0; m < 12; m++) actualAnnual += (a.op[m] || 0) + (a.pp[m] || 0); }
    const pct = planTotal > 0 ? (actualAnnual / planTotal) * 100 : (actualAnnual > 0 ? Infinity : null);
    return {
      item, planOp, planPp, planTotal, actualAnnual,
      pct, diff: actualAnnual - planTotal,
      overPlan: planTotal > 0 && actualAnnual > planTotal,
      planNoUse: planTotal > 0 && actualAnnual === 0
    };
  });
}

// ---- tab 6: simulated stock + cover-months + flags -------------------------------------------------
// avg3 for a REAL month index m: mean withdrawal of up to 3 months strictly before m (within the
// same 12-slot array), fallback to the annual mean (Σ12/12) if that is 0/unavailable (spec §2.3).
export function avg3ForRealMonth(pcuActualItem, monthIdx) {
  if (!pcuActualItem) return 0;
  const from = Math.max(0, monthIdx - 3);
  let sum = 0, n = 0;
  for (let i = from; i < monthIdx; i++) {
    sum += (pcuActualItem.op[i] || 0) + (pcuActualItem.pp[i] || 0);
    n++;
  }
  const mean = n > 0 ? sum / n : 0;
  if (mean > 0) return mean;
  let annualSum = 0;
  for (let i = 0; i < 12; i++) annualSum += (pcuActualItem.op[i] || 0) + (pcuActualItem.pp[i] || 0);
  return annualSum / 12;
}

// Mirrors backend Requests.js `buildByRoundForPcu_` avg3 logic for the two trial rounds, so the
// admin's tab 6 agrees with what the PCU itself would see via pcuBootstrap.
export function avg3ForTrialRound(bootstrap, pcuCode, code, roundMonth) {
  const pcuActual = (bootstrap.actual[pcuCode] || {})[code];
  const a = pcuActual || { op: new Array(12).fill(0), pp: new Array(12).fill(0) };
  const round = bootstrap.rounds.find((r) => r.month === roundMonth);
  let mean3;
  if (round && round.fy === 2568) {
    let sum3 = 0;
    for (let i = 8; i <= 10; i++) sum3 += (a.op[i] || 0) + (a.pp[i] || 0);
    mean3 = sum3 / 3;
  } else {
    const sepReq = bootstrap.requests.find((r) => r.pcu === pcuCode && r.month === "2025-09" && (r.status === "submitted" || r.status === "received"));
    const v9 = (a.op[9] || 0) + (a.pp[9] || 0);
    const v10 = (a.op[10] || 0) + (a.pp[10] || 0);
    let v11;
    if (sepReq && sepReq.lines[code]) v11 = (sepReq.lines[code].op || 0) + (sepReq.lines[code].pp || 0);
    else v11 = (a.op[11] || 0) + (a.pp[11] || 0);
    mean3 = (v9 + v10 + v11) / 3;
  }
  if (mean3 > 0) return mean3;
  const stats = (bootstrap.stats[pcuCode] || {})[code];
  const annualMean = stats ? stats[2] / 12 : 0;
  return annualMean; // may be 0 -> caller treats as "unavailable"
}

// Flags only apply to items withdrawn regularly in FY68 (≥ REGULAR_MIN_MONTHS of 12 months) —
// "months of cover" is meaningless for lumpy/sporadic items (phase 1.5.md §2.3).
export const REGULAR_MIN_MONTHS = 6;
export function isRegularItem(bootstrap, pcuCode, code) {
  const a = (bootstrap.actual[pcuCode] || {})[code];
  if (!a) return false;
  let n = 0;
  for (let i = 0; i < 12; i++) if ((a.op[i] || 0) + (a.pp[i] || 0) > 0) n++;
  return n >= REGULAR_MIN_MONTHS;
}

// Returns { stock, withdrawal, avg3, cover, flag, regular } for one PCU x item x month-selection.
// `flag` is null | "over" | "short" (always null for non-regular items).
export function stockRowFor(bootstrap, pcuCode, code, sel) {
  const cfg = bootstrap.config;
  let stock = null, withdrawal = 0, avg3 = 0, hasData = true;

  if (sel.type === "real") {
    const idx = bootstrap.months.indexOf(sel.key);
    const stockArr = (bootstrap.stock_sim[pcuCode] || {})[code];
    stock = stockArr ? (stockArr[idx] || 0) : 0;
    const a = (bootstrap.actual[pcuCode] || {})[code];
    withdrawal = a ? (a.op[idx] || 0) + (a.pp[idx] || 0) : 0;
    avg3 = avg3ForRealMonth(a, idx);
  } else {
    const req = bootstrap.requests.find((r) => r.pcu === pcuCode && r.month === sel.key && (r.status === "submitted" || r.status === "received"));
    if (!req || !req.lines[code]) {
      hasData = false;
    } else {
      const l = req.lines[code];
      stock = l.stock === null || l.stock === undefined ? null : l.stock;
      withdrawal = (l.op || 0) + (l.pp || 0);
      avg3 = avg3ForTrialRound(bootstrap, pcuCode, code, sel.key);
    }
  }

  const regular = isRegularItem(bootstrap, pcuCode, code);
  if (!hasData || stock === null) {
    return { stock: null, withdrawal, avg3, cover: null, flag: null, hasData, regular };
  }
  const cover = avg3 > 0 ? stock / avg3 : null;
  let flag = null;
  if (cover !== null && regular) {
    if (cover > cfg.cover_over && withdrawal > 0) flag = "over";
    else if (cover < cfg.cover_short) flag = "short";
  }
  return { stock, withdrawal, avg3, cover, flag, hasData, regular };
}

export function stockTableForPcu(bootstrap, items, pcuCode, sel) {
  return items.map((item) => ({ item, ...stockRowFor(bootstrap, pcuCode, item.code, sel) }));
}

export function stockSummaryPerPcu(bootstrap, items, sel) {
  return bootstrap.pcus.map((pcu) => {
    let over = 0, short = 0;
    items.forEach((item) => {
      const r = stockRowFor(bootstrap, pcu.code, item.code, sel);
      if (r.flag === "over") over++;
      else if (r.flag === "short") short++;
    });
    return { pcu, over, short };
  });
}

// ---- tab 7: limits table -----------------------------------------------------------------------
export function limitsRowsForPcu(bootstrap, items, pcuCode) {
  const limits = bootstrap.limits[pcuCode] || {};
  const stats = bootstrap.stats[pcuCode] || {};
  return items.map((item) => {
    const stat = stats[item.code] || [0, 0, 0];
    const lim = limits[item.code] || { limit_month: null, limit_year: null, source: "stat68", updated_by: "", updated_at: "" };
    return {
      item,
      median_m: stat[0] || 0, p90_m: stat[1] || 0, annual_qty: stat[2] || 0,
      limit_month: lim.limit_month, limit_year: lim.limit_year,
      source: lim.source || "stat68", updated_by: lim.updated_by || "", updated_at: lim.updated_at || ""
    };
  });
}

// ---- tab 1 helpers -------------------------------------------------------------------------------
export function lastStepIndex(lastStep) {
  const i = STEP_ORDER_WITH_SUMMARY.indexOf(lastStep);
  return i < 0 ? 0 : i + 1;
}
