// Date / number / fiscal-year formatting helpers. Pure functions, no DOM/localStorage access.

export const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

export function beYear(ceYear) {
  return ceYear + 543;
}

export function monthKeyToParts(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return { year: y, month: m };
}

export function partsToMonthKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Thai fiscal year (ต.ค.–ก.ย.), applied to a ROUND month (brief 2j): a round named "ขอเบิกเดือน X" is keyed in X-1,
// so the FY of round X is the FY of its submission month X-1. Round 2026-11 (พ.ย. 69) -> FY 2570 (first round of
// 2570); round 2026-10 -> FY 2569. FY number is itself a BE year number.
export function fiscalYearOf(monthKey) {
  const { year, month } = monthKeyToParts(prevMonthKey(monthKey));
  const be = beYear(year);
  return month >= 10 ? be + 1 : be;
}

// CE month key of the first ROUND month (November) of a given Thai fiscal year (FY2570 -> "2026-11").
export function fiscalYearStartMonthKey(fy) {
  const ceYear = fy - 1 - 543;
  return partsToMonthKey(ceYear, 11);
}

// CE month key of the last ROUND month (October) of a given Thai fiscal year (FY2570 -> "2027-10").
export function fiscalYearEndMonthKey(fy) {
  const ceYear = fy - 543;
  return partsToMonthKey(ceYear, 10);
}

export function formatMonthKeyThai(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  return `${THAI_MONTHS[month - 1]} ${beYear(year)}`;
}

export function shortMonthKeyThai(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  const shortNames = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${shortNames[month - 1]} ${beYear(year)}`;
}

export function nextMonthKey(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  return month === 12 ? partsToMonthKey(year + 1, 1) : partsToMonthKey(year, month + 1);
}

export function prevMonthKey(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  return month === 1 ? partsToMonthKey(year - 1, 12) : partsToMonthKey(year, month - 1);
}

// All month keys strictly before `monthKey`, within the same fiscal year, in
// chronological order (oldest first). For a fiscal year's start month this is [].
export function monthsInFiscalYearBefore(monthKey) {
  const fy = fiscalYearOf(monthKey);
  const start = fiscalYearStartMonthKey(fy);
  const out = [];
  let cur = start;
  while (cur !== monthKey) {
    out.push(cur);
    cur = nextMonthKey(cur);
    if (out.length > 12) break; // safety guard, should never trigger
  }
  return out;
}

export function compareMonthKey(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString("en-US");
}

export function formatMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Format a JS Date for the printed "วันที่ D / เดือนไทย / พ.ศ." line.
export function formatThaiDateParts(date) {
  return {
    day: date.getDate(),
    monthName: THAI_MONTHS[date.getMonth()],
    beYear: beYear(date.getFullYear()),
  };
}

export function nowTimeHHMM(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// HH:MM in Asia/Bangkok, from a JS Date or an ISO string (server times are UTC ISO strings —
// spec §3.1 wants the PIN lock-until time shown as Bangkok wall-clock, not the browser's TZ).
export function formatBangkokHHMM(dateOrIso) {
  const date = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (isNaN(date.getTime())) return "-";
  try {
    return new Intl.DateTimeFormat("th-TH", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Bangkok",
    }).format(date);
  } catch (err) {
    return nowTimeHHMM(date);
  }
}
