// Withdrawal-ceiling logic (phase 2: Q72/Q81). limits/used_fy/unlocks all come from the bootstrap
// (functions/API.md §4.1) — nothing is simulated client-side. Counts OP+PP combined, per item, per PCU.
// Ceilings are shown ONLY when exceeded (Q90) and only if the round's fiscal year is the one the limits are for.

// `limitsForPcu`: { code: [limit_month|null, limit_year|null] } (bootstrap.limits, fy_current).
// `usedFyForMonth`: { code: qty } (bootstrap.byMonth[month].used_fy — already excludes this month's request).
// Same rule as the server (views.overLimitItems): over if total > limit_month OR used + total > limit_year; total 0 never over.
export function computeLimitInfo(limitsForPcu, usedFyForMonth, itemCode, liveOpPp) {
  const entry = limitsForPcu ? limitsForPcu[itemCode] : null;
  if (!entry) return null;

  const limit_month = entry[0] == null ? null : entry[0];
  const limit_year = entry[1] == null ? null : entry[1];
  const requested = Number(liveOpPp) || 0;
  const priorUsed = (usedFyForMonth && usedFyForMonth[itemCode]) || 0;

  const monthForbidden = limit_month === 0 && requested > 0;
  const monthOver = requested > 0 && limit_month != null && requested > limit_month;
  const monthExceedBy = monthOver ? requested - limit_month : 0;

  let yearUsed = null;
  let yearOver = false;
  let yearExceedBy = 0;
  if (limit_year != null) {
    yearUsed = priorUsed + requested;
    yearOver = requested > 0 && yearUsed > limit_year;
    yearExceedBy = yearOver ? yearUsed - limit_year : 0;
  }

  return {
    itemCode, limit_month, limit_year, requested, priorUsed,
    monthForbidden, monthOver, monthExceedBy, yearUsed, yearOver, yearExceedBy,
    over: monthOver || yearOver,
  };
}

export function monthOverMessage(info) {
  if (!info || !info.monthOver) return "";
  if (info.monthForbidden) return "ห้ามเบิกรายการนี้ในรอบนี้ (เพดานรายเดือน = 0)";
  return `เกินเพดานรายเดือน: ขอ ${info.requested} · เพดาน ${info.limit_month} (เกิน ${info.monthExceedBy})`;
}

export function yearOverMessage(info) {
  if (!info || !info.yearOver) return "";
  return `เกินเพดานรายปี: เบิกแล้ว ${info.priorUsed} + ขอ ${info.requested} = ${info.yearUsed} · เพดาน ${info.limit_year} (เกิน ${info.yearExceedBy})`;
}

/**
 * What the PCU should see for one item.
 * @param {{mode:string, limits:object, usedFy:object, unlocks:object, code:string, total:number}} a
 * @returns {null | {over:true, blocked:boolean, unlockReason:string|null, messages:string[], info:object}}
 *   null = nothing to show (mode off / not exceeded).
 *   warn: messages in red, submit allowed. enforce: blocked unless an admin unlock exists for (month, code).
 */
export function limitStatus({ mode, limits, usedFy, unlocks, code, total }) {
  if (mode !== "warn" && mode !== "enforce") return null;
  const info = computeLimitInfo(limits, usedFy, code, total);
  if (!info || !info.over) return null;
  const messages = [monthOverMessage(info), yearOverMessage(info)].filter(Boolean);
  const unlockReason = unlocks && Object.prototype.hasOwnProperty.call(unlocks, code) ? String(unlocks[code] || "") : null;
  const unlocked = unlockReason !== null;
  return { over: true, blocked: mode === "enforce" && !unlocked, unlockReason: mode === "enforce" && unlocked ? unlockReason : null, messages, info };
}
