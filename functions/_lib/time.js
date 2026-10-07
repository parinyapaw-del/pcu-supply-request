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

// Round model (brief 2j): a round is named after the supply month X ("ขอเบิกเดือน X"); it is keyed/submitted during X−1.
// calMonth = currentMonth() · currentRound = nextMonth(calMonth) (open for keying) · prevRound = calMonth (still editable).
export const currentRound = (d) => nextMonth(currentMonth(d));

// Fiscal year (พ.ศ.) of a ROUND month key = FY of its submission month prevMonth(m). 2026-11 → 2570 · 2026-10 → 2569.
export function monthFy(m) {
  const [y, mo] = prevMonth(m).split("-").map(Number);
  return y + (mo >= 10 ? 1 : 0) + 543;
}
// The 12 ROUND month keys of a fiscal year. FY2570 = 2026-11 … 2027-10.
export function fyMonths(fy) {
  return fyExcelMonths(fy).map(nextMonth);
}
// The 12 Excel/calendar month keys of a fiscal year (Oct … Sep). FY2569 = 2025-10 … 2026-09. Used only for imported data
// (actual_prev / stats / seed import + export / adminBootstrap.prev[fy].months) — index 0 = October.
export function fyExcelMonths(fy) {
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

// {deadline_date, deadline_source} for a round given its rounds row (or null) and config.deadline_day (or null).
// An explicit rounds.deadline_date wins; otherwise deadline_day / month-end applies to the SUBMISSION month prevMonth(month) (2j).
export function computeDeadline(month, roundRow, deadlineDay) {
  if (roundRow && roundRow.deadline_date) return { deadline_date: roundRow.deadline_date, deadline_source: "round" };
  const sub = prevMonth(month);
  const last = lastDayOfMonth(sub);
  if (Number.isInteger(deadlineDay) && deadlineDay >= 1) {
    const d = Math.min(deadlineDay, last);
    return { deadline_date: `${sub}-${String(d).padStart(2, "0")}`, deadline_source: "config" };
  }
  return { deadline_date: `${sub}-${String(last).padStart(2, "0")}`, deadline_source: "month_end" };
}

// Bangkok local "YYYY-MM-DD HH:mm" from an ISO UTC string (exports)
export function bangkokDateTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  return new Date(t + BKK_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
}
