// Withdrawal-ceiling logic (phase 2: Q72/Q81 · 2z Q10/R10). limits/used_fy come from the bootstrap (functions/API.md §4.1) — nothing is
// simulated client-side. Counts OP+PP combined, per item, per PCU. Shown ONLY when exceeded (Q90) and only if the round's fiscal year is the
// one the limits are for. 2z: information only (blue/grey) — never blocks the send · the monthly ceiling is never shown to the PCU.

// `limitsForPcu`: { code: [null, limit_year|null] } (bootstrap.limits, fy_current — slot 0 was limit_month, always null since 2z).
// `usedFyForMonth`: { code: qty } (bootstrap.byMonth[month].used_fy — already excludes this month's request).
// Same rule as the server (views.overLimitItems): over if used + total > limit_year; total 0 never over.
export function computeLimitInfo(limitsForPcu, usedFyForMonth, itemCode, liveOpPp) {
  const entry = limitsForPcu ? limitsForPcu[itemCode] : null;
  if (!entry || entry[1] == null) return null;
  const limit_year = entry[1];
  const requested = Number(liveOpPp) || 0;
  const priorUsed = (usedFyForMonth && usedFyForMonth[itemCode]) || 0;
  const yearUsed = priorUsed + requested;
  const yearOver = requested > 0 && yearUsed > limit_year;
  return { itemCode, limit_year, requested, priorUsed, yearUsed, yearOver, yearExceedBy: yearOver ? yearUsed - limit_year : 0, over: yearOver };
}

export function yearOverMessage(info) {
  if (!info || !info.yearOver) return "";
  return `ยอดขอสะสมปีงบนี้เกินเพดานรายปี (${info.yearUsed}/${info.limit_year}) — แจ้งเพื่อใช้ประมาณการปีถัดไปให้แม่นยำขึ้น ส่งได้ตามปกติ`;
}

/**
 * What the PCU should see for one item.
 * @param {{mode:string, limits:object, usedFy:object, code:string, total:number}} a
 * @returns {null | {over:true, messages:string[], info:object}} null = nothing to show (mode off / not exceeded).
 */
export function limitStatus({ mode, limits, usedFy, code, total }) {
  if (mode === "off") return null;
  const info = computeLimitInfo(limits, usedFy, code, total);
  if (!info || !info.over) return null;
  return { over: true, messages: [yearOverMessage(info)], info };
}
