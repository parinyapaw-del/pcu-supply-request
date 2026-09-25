// Withdrawal-ceiling + "cover" hint logic (spec §3.2 addendum, §3.5).
// Phase 1.5: limits and used_fy come straight from pcuBootstrap (API.md) — no more client-side
// simulation of past months. Counts OP+PP combined, per item, per PCU.

// `limitsForPcu`: { code: [limit_month|null, limit_year|null] } (pcuBootstrap.limits).
// `usedFyForRound`: { code: qty } (pcuBootstrap.byRound[month].used_fy) — already excludes the
// current round's request; this form's own live OP+PP is added in here.
export function computeLimitInfo(limitsForPcu, usedFyForRound, itemCode, liveOpPp) {
  const entry = limitsForPcu ? limitsForPcu[itemCode] : null;
  if (!entry) return null;

  const limit_month = entry[0];
  const limit_year = entry[1];
  const requested = Number(liveOpPp) || 0;

  const monthForbidden = limit_month === 0;
  const monthOver = limit_month != null && limit_month >= 0 && requested > limit_month;
  const monthExceedBy = monthOver ? requested - limit_month : 0;

  let yearUsed = null;
  let yearOver = false;
  let yearExceedBy = 0;
  let yearRemaining = null;
  if (limit_year != null) {
    const priorUsed = (usedFyForRound && usedFyForRound[itemCode]) || 0;
    yearUsed = priorUsed + requested;
    yearOver = yearUsed > limit_year;
    yearExceedBy = yearOver ? yearUsed - limit_year : 0;
    yearRemaining = Math.max(limit_year - yearUsed, 0);
  }

  return {
    itemCode,
    limit_month,
    limit_year,
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
  if (!info) return "";
  if (info.monthForbidden && info.requested > 0) {
    return `ห้ามเบิกรายการนี้ในเดือนนี้ (เพดานรายเดือน = 0)`;
  }
  if (!info.monthOver) return "";
  return `เกินเพดานรายเดือน: ขอ ${info.requested} · เบิกได้สูงสุด ${info.limit_month} → ต้องลดลง ${info.monthExceedBy} (แบ่งลด OP/PP เอง)`;
}

export function yearInfoMessage(info) {
  if (!info || info.limit_year == null) return "";
  return `เพดานรายปี: ใช้ไปแล้ว ${info.yearUsed} จาก ${info.limit_year} · เหลือ ${info.yearRemaining}`;
}

export function yearOverMessage(info) {
  if (!info || info.limit_year == null || !info.yearOver) return "";
  return `เกินเพดานรายปี: ใช้ไปแล้ว ${info.yearUsed} จาก ${info.limit_year} → ต้องลดลง ${info.yearExceedBy}`;
}

export function isAnyLimitExceeded(info) {
  return !!info && (info.monthOver || info.yearOver);
}

// ---- "cover" hint (spec §3.2 เสริม) ----------------------------------------------------------
// Once stock and/or op/pp are entered and avg3[code] > 0: "คงเหลือ + ขอเบิก พอใช้ ~n.n เดือน".
// Never blocks; just informational (yellow once over config.cover_over months).
export function computeCoverInfo(avg3ForCode, stock, op, pp) {
  const avg3 = Number(avg3ForCode) || 0;
  if (avg3 <= 0) return null;
  const s = Number(stock) || 0;
  const o = Number(op) || 0;
  const p = Number(pp) || 0;
  if (s === 0 && o === 0 && p === 0) return null;
  const months = (s + o + p) / avg3;
  return { months, avg3 };
}

export function coverMessage(coverInfo) {
  if (!coverInfo) return "";
  return `คงเหลือ + ขอเบิก พอใช้ ~${coverInfo.months.toFixed(1)} เดือน`;
}
