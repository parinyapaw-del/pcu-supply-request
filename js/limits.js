// Demo withdrawal-ceiling logic (spec §3.5). Only items present in
// data/limits_demo.json for the chosen PCU are checked; everything else has no
// ceiling at all. Counts OP+PP combined.
import { monthsInFiscalYearBefore } from "./format.js";
import { simMonth } from "./sim.js";
import { getRequest } from "./store.js";

export function getLimitEntry(limits, pcu, itemCode) {
  const forPcu = limits[pcu];
  if (!forPcu) return null;
  return forPcu[itemCode] || null;
}

function lineOpPp(line) {
  if (!line) return 0;
  return (Number(line.op) || 0) + (Number(line.pp) || 0);
}

// Sum of OP+PP the PCU already has on record for `itemCode` in `monthKey`:
// a submitted request's stored line if one exists, else the deterministic
// simulated figure for that month (spec §"Simulated history").
function usageForPastMonth(pcu, itemCode, price, monthKey, limitYear) {
  const req = getRequest(pcu, monthKey);
  if (req && req.status === "submitted" && req.lines && req.lines[itemCode]) {
    return lineOpPp(req.lines[itemCode]);
  }
  const sim = simMonth(pcu, itemCode, price, monthKey, limitYear);
  return sim.op + sim.pp;
}

// Full limit picture for one item, for the form currently being filled.
// `liveOpPp` is this form's current (possibly unsaved) OP+PP for the item.
// Returns null if the item has no limit entry for this PCU at all.
export function computeLimitInfo(limits, pcu, itemCode, price, monthKey, liveOpPp) {
  const entry = getLimitEntry(limits, pcu, itemCode);
  if (!entry) return null;

  const { limit_month, limit_year, note } = entry;
  const requested = Number(liveOpPp) || 0;

  const monthForbidden = limit_month === 0;
  const monthOver = limit_month != null && limit_month >= 0 && requested > limit_month;
  const monthExceedBy = monthOver ? requested - limit_month : 0;

  let yearUsed = null;
  let yearOver = false;
  let yearExceedBy = 0;
  let yearRemaining = null;
  if (limit_year != null) {
    const priorMonths = monthsInFiscalYearBefore(monthKey);
    let sum = 0;
    for (const m of priorMonths) {
      sum += usageForPastMonth(pcu, itemCode, price, m, limit_year);
    }
    sum += requested; // this form counts too, live
    yearUsed = sum;
    yearOver = yearUsed > limit_year;
    yearExceedBy = yearOver ? yearUsed - limit_year : 0;
    yearRemaining = Math.max(limit_year - yearUsed, 0);
  }

  return {
    itemCode,
    limit_month,
    limit_year,
    note: note || "",
    requested,
    monthForbidden,
    monthOver,
    monthExceedBy,
    yearUsed,
    yearOver,
    yearExceedBy,
    yearRemaining,
  };
}

export function monthOverMessage(info) {
  if (info.monthForbidden && info.requested > 0) {
    return `ห้ามเบิกรายการนี้ในเดือนนี้ (เพดานรายเดือน = 0)`;
  }
  if (!info.monthOver) return "";
  return `เกินเพดานรายเดือน: ขอ ${info.requested} · เบิกได้สูงสุด ${info.limit_month} → ต้องลดลง ${info.monthExceedBy} (แบ่งลด OP/PP เอง)`;
}

export function yearInfoMessage(info) {
  if (info.limit_year == null) return "";
  return `เพดานรายปี: ใช้ไปแล้ว ${info.yearUsed} จาก ${info.limit_year} · เหลือ ${info.yearRemaining}`;
}

export function yearOverMessage(info) {
  if (info.limit_year == null || !info.yearOver) return "";
  return `เกินเพดานรายปี: ใช้ไปแล้ว ${info.yearUsed} จาก ${info.limit_year} → ต้องลดลง ${info.yearExceedBy}`;
}

export function isAnyLimitExceeded(info) {
  return !!info && (info.monthOver || info.yearOver);
}
