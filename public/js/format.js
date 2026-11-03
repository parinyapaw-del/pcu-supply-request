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

// Thai fiscal year (ต.ค.–ก.ย.) of a ROUND month = FY of the supply month itself (2w — reverses 2j): round 2026-10
// (ต.ค. 69, keyed in Sep 2026) -> FY 2570 (first round of 2570); round 2026-09 -> FY 2569. FY number is a BE year number.
export function fiscalYearOf(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  const be = beYear(year);
  return month >= 10 ? be + 1 : be;
}

// CE month key of the first ROUND month (October) of a given Thai fiscal year (FY2570 -> "2026-10").
export function fiscalYearStartMonthKey(fy) {
  const ceYear = fy - 1 - 543;
  return partsToMonthKey(ceYear, 10);
}

export const THAI_MONTHS_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

// "2026-10" -> "ตุลาคม 2569"
export function formatMonthKeyThai(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  return `${THAI_MONTHS[month - 1]} ${beYear(year)}`;
}

// "2026-10" -> "ต.ค. 2569"
export function shortMonthKeyThai(monthKey) {
  const { year, month } = monthKeyToParts(monthKey);
  return `${THAI_MONTHS_SHORT[month - 1]} ${beYear(year)}`;
}

// "2026-10" -> "ต.ค. 69" (compact, for column headers / charts)
export function monthShortYY(monthKey) {
  const { year, month } = monthKeyToParts(String(monthKey));
  return `${THAI_MONTHS_SHORT[month - 1]} ${String(beYear(year) % 100).padStart(2, "0")}`;
}

// "2026-10" shifted by n months (n may be negative): shiftMonth("2026-10", -11) === "2025-11". Same arithmetic as time.js monthMinus.
export function shiftMonth(monthKey, n) {
  const { year, month } = monthKeyToParts(monthKey);
  const k = year * 12 + (month - 1) + n;
  return partsToMonthKey(Math.floor(k / 12), (k % 12) + 1);
}

export const nextMonthKey = (monthKey) => shiftMonth(monthKey, 1);
export const prevMonthKey = (monthKey) => shiftMonth(monthKey, -1);

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
