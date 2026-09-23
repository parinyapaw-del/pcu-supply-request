// Deterministic simulated withdrawal history. Same numbers on every device, always,
// because everything is derived from a string-hash seed fed into mulberry32 — no
// wall-clock / Math.random anywhere in this file.
import { fiscalYearStartMonthKey, fiscalYearEndMonthKey, nextMonthKey, monthKeyToParts } from "./format.js";

// djb2-style 32-bit string hash → seed for mulberry32.
function hashStringToSeed(str) {
  let h = 2166136261 >>> 0; // FNV-ish offset, fine for a demo PRNG seed
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Standard mulberry32: returns a fresh generator function producing floats in [0,1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFor(...parts) {
  return mulberry32(hashStringToSeed(parts.join("|")));
}

function typicalQtyForPrice(price, rand) {
  if (price < 10) {
    // multiples of 10 up to 200
    const steps = Math.floor(rand() * 20) + 1; // 1..20
    return steps * 10;
  }
  if (price <= 100) {
    return Math.floor(rand() * 10) + 1; // 1..10
  }
  return Math.floor(rand() * 3) + 1; // 1..3
}

// Generic per-(pcu,item,month) simulated line, used for non-limit items everywhere,
// and for limit items outside their special 11-month distribution window.
export function genericMonthSim(pcu, itemCode, price, monthKey) {
  const rand = rngFor(pcu, itemCode, monthKey);
  const isZero = rand() < 0.5;
  if (isZero) {
    const stock = Math.floor(rand() * 5); // small leftover even in a zero-withdrawal month
    return { stock, op: 0, pp: 0 };
  }
  const typical = typicalQtyForPrice(price, rand);
  const opShare = 0.5 + (rand() - 0.5) * 0.1; // ~55% +- a bit of jitter around 0.55
  const op = Math.round(typical * (0.55 + (opShare - 0.5)));
  const pp = Math.max(typical - op, 0);
  const stock = Math.floor(rand() * (2 * typical + 1));
  return { stock, op, pp };
}

const limitDistCache = new Map();

// Distributes round(limitYear * r) units of demand across the 11 months that
// precede the September close of fiscal year `fy` (Oct..Aug), split ~55/45 OP/PP.
// r is itself deterministic in [0.60, 0.90] so year-to-date usage stays high but
// leaves a small positive remainder (easy to exceed later in the demo).
function limitYearDistribution(pcu, itemCode, limitYear, fy) {
  const cacheKey = `${pcu}|${itemCode}|${limitYear}|${fy}`;
  if (limitDistCache.has(cacheKey)) return limitDistCache.get(cacheKey);

  const rand = rngFor(pcu, itemCode, "LIMITFY", fy);
  const r = 0.6 + rand() * 0.3;
  const total = Math.round(limitYear * r);

  const months = [];
  let cur = fiscalYearStartMonthKey(fy); // October
  const end = fiscalYearEndMonthKey(fy); // September (excluded: not a "prior" month)
  while (cur !== end) {
    months.push(cur);
    cur = nextMonthKey(cur);
  }

  // Random positive weights, normalised, then rounded with residual pushed onto
  // the last month so the total matches exactly.
  const weights = months.map(() => 0.2 + rand());
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / weightSum) * total);

  const monthTotals = raw.map((v) => Math.floor(v));
  let distributed = monthTotals.reduce((a, b) => a + b, 0);
  let remainder = total - distributed;
  // hand out leftover units one at a time, largest fractional remainder first
  const fracOrder = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < fracOrder.length && remainder > 0; k++, remainder--) {
    monthTotals[fracOrder[k].i] += 1;
  }

  const result = new Map();
  months.forEach((m, i) => {
    const t = Math.max(monthTotals[i], 0);
    const jitter = rand();
    const op = Math.round(t * (0.55 + (jitter - 0.5) * 0.1));
    const pp = Math.max(t - op, 0);
    const stock = Math.floor(rand() * (2 * (t || 1) + 1));
    result.set(m, { stock, op, pp });
  });

  limitDistCache.set(cacheKey, result);
  return result;
}

// Public entry point: simulated {stock, op, pp} for one PCU/item/month.
// limitYear: the PCU's limit_year for this item (or null/undefined if none) —
// only P1-01 / LAB-03 / LAB-04 ever carry one, per data/limits_demo.json.
export function simMonth(pcu, itemCode, price, monthKey, limitYear) {
  if (limitYear) {
    const fy = monthKeyFiscalYearForWindow(monthKey);
    if (fy) {
      const dist = limitYearDistribution(pcu, itemCode, limitYear, fy);
      if (dist.has(monthKey)) return dist.get(monthKey);
    }
  }
  return genericMonthSim(pcu, itemCode, price, monthKey);
}

// If monthKey lies in the Oct..Aug window that precedes some fiscal year's
// September close, return that fiscal year; else null (Sept itself, or any
// month that is a fiscal-year start, falls back to the generic simulation).
function monthKeyFiscalYearForWindow(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  if (month === 9) return null; // September = FY close, not part of the 11-month window
  // The FY whose Oct..Aug window contains `monthKey`: if month is Oct-Dec, that FY
  // closes the *following* BE September; if Jan-Aug, it closes *this* BE September.
  const be = year + 543;
  return month >= 10 ? be + 1 : be;
}

export const _internal = { hashStringToSeed, mulberry32 };
