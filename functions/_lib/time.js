// time.js — ISO timestamps, Bangkok calendar months, fiscal years (พ.ศ.), deadline computation.

const BKK_OFFSET_MS = 7 * 3600 * 1000;

export const nowIso = () => new Date().toISOString();

// "YYYY-MM-DD" in Asia/Bangkok
export const bangkokDate = (d = new Date()) => new Date(d.getTime() + BKK_OFFSET_MS).toISOString().slice(0, 10);
export const MONTH_RE = /^(20\d\d)-(0[1-9]|1[0-2])$/;
export const isMonth = (m) => typeof m === "string" && MONTH_RE.test(m);

// Dev/test only: the router sets this from the `X-Dev-Month` header when env.DEV_FAKE_GOOGLE === "1", so tests are
// independent of the real date (month boundaries, fiscal-year edges). Always null in production.
let devMonth = null;
export const setDevMonth = (m) => { devMonth = isMonth(m) ? m : null; };
export const currentMonth = (d) => (!d && devMonth ? devMonth : bangkokDate(d || new Date()).slice(0, 7));

export function prevMonth(m) {
  let [y, mo] = m.split("-").map(Number);
  mo -= 1;
  if (mo === 0) { mo = 12; y -= 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}
export function nextMonth(m) {
  let [y, mo] = m.split("-").map(Number);
  mo += 1;
  if (mo === 13) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

// n months before m (n ≥ 0). monthMinus("2026-10", 11) === "2025-11".
export function monthMinus(m, n) {
  const [y, mo] = m.split("-").map(Number);
  const k = y * 12 + (mo - 1) - n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
}

// Fiscal year (พ.ศ.) of a CE month key. 2026-10 → 2570.
export function monthFy(m) {
  const [y, mo] = m.split("-").map(Number);
  return y + (mo >= 10 ? 1 : 0) + 543;
}
// First/last month key and the 12 month keys of a fiscal year. FY2570 = 2026-10 … 2027-09.
export function fyMonths(fy) {
  const startYear = fy - 543 - 1;
  const out = [];
  let m = `${startYear}-10`;
  for (let i = 0; i < 12; i++) { out.push(m); m = nextMonth(m); }
  return out;
}

export function lastDayOfMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// {deadline_date, deadline_source} for a month given its rounds row (or null) and config.deadline_day (or null).
export function computeDeadline(month, roundRow, deadlineDay) {
  if (roundRow && roundRow.deadline_date) return { deadline_date: roundRow.deadline_date, deadline_source: "round" };
  const last = lastDayOfMonth(month);
  if (Number.isInteger(deadlineDay) && deadlineDay >= 1) {
    const d = Math.min(deadlineDay, last);
    return { deadline_date: `${month}-${String(d).padStart(2, "0")}`, deadline_source: "config" };
  }
  return { deadline_date: `${month}-${String(last).padStart(2, "0")}`, deadline_source: "month_end" };
}

// Bangkok local "YYYY-MM-DD HH:mm" from an ISO UTC string (exports)
export function bangkokDateTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  return new Date(t + BKK_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}
