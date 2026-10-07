// usage.js — R2 / Browser Rendering usage counters + the R2 cost-guard caps (2b-R). Contract: functions/API.md §6b.
// Counters live in D1 `usage_counters(period, metric, n)`; period = UTC month "YYYY-MM" (R2 billing month) or UTC day "YYYY-MM-DD".
//   r2_class_a  (month)        every FILES.put (PDF create, backup) + every FILES.list page in runBackup
//   r2_class_b  (month)        every FILES.get in GET /api/pdf/:id
//   pdf_render  (day + month)  every renderer attempt (real Browser Rendering call incl. 429, dev mock + its simulated branches)
// FILES.delete is free → never counted. devListFiles / devListBackups are dev-only → not counted.
import { getConfigAll } from "./db.js";

export const R2_CAP_KEYS = ["r2_max_bytes", "r2_max_class_a", "r2_max_class_b"];
export const R2_CAP_DEFAULTS = { r2_max_bytes: 1000000000, r2_max_class_a: 100000, r2_max_class_b: 1000000 }; // ≈ 10 % of the free tier
export const R2_FREE_TIER = { bytes: 10000000000, class_a: 1000000, class_b: 10000000 };
export const PDF_RESERVE_BYTES = 1000000; // room a new PDF is assumed to need when checking r2_max_bytes

export const MSG_QUOTA = "ที่เก็บไฟล์ PDF ถึงเพดานที่ตั้งไว้ — กดปุ่ม พิมพ์ แล้วเลือก Save as PDF แทน และแจ้งผู้ดูแลระบบ";

// UTC periods (R2 bills per UTC calendar month; Browser Rendering's daily allowance resets at 00:00 UTC)
export const utcMonth = (d = new Date()) => d.toISOString().slice(0, 7);
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

// Effective caps: a config value is used when it is an integer ≥ 1, otherwise the default.
export function r2Caps(cfg) {
  const out = {};
  for (const k of R2_CAP_KEYS) {
    const v = cfg ? cfg[k] : null;
    out[k] = Number.isInteger(v) && v >= 1 ? v : R2_CAP_DEFAULTS[k];
  }
  return out;
}

// One prepared upsert (so it can ride in the same DB.batch as the mutation).
export function bumpStmt(DB, metric, period = utcMonth(), by = 1) {
  return DB.prepare(`INSERT INTO usage_counters (period, metric, n) VALUES (?,?,?) ON CONFLICT(period, metric) DO UPDATE SET n = n + excluded.n`)
    .bind(period, metric, by);
}
export async function bumpUsage(DB, metric, period, by = 1) {
  await bumpStmt(DB, metric, period || utcMonth(), by).run();
}
// a render attempt is counted for the UTC day and the UTC month
export const renderStmts = (DB, d = new Date()) => [bumpStmt(DB, "pdf_render", utcDay(d)), bumpStmt(DB, "pdf_render", utcMonth(d))];

export async function readCounter(DB, metric, period = utcMonth()) {
  const row = await DB.prepare(`SELECT n FROM usage_counters WHERE period = ? AND metric = ?`).bind(period, metric).first();
  return Number((row && row.n) || 0);
}

export async function pdfBytesTotal(DB) {
  const row = await DB.prepare(`SELECT COALESCE(SUM(bytes), 0) AS b FROM pdf_files`).first();
  return Number((row && row.b) || 0);
}

const nonNegInt = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

// The `usage` object of adminPdfFiles (and, trimmed, the PDF_QUOTA error). cfg = getConfigAll() result (read when omitted).
export async function readUsage(DB, cfg) {
  const now = new Date();
  const period = utcMonth(now), day = utcDay(now);
  const [cfgAll, cnt, pdfBytes] = await Promise.all([
    cfg ? Promise.resolve(cfg) : getConfigAll(DB),
    DB.prepare(`SELECT period, metric, n FROM usage_counters WHERE period IN (?, ?)`).bind(period, day).all(),
    pdfBytesTotal(DB),
  ]);
  const get = (p, m) => {
    const r = cnt.results.find((x) => x.period === p && x.metric === m);
    return Number((r && r.n) || 0);
  };
  const backupBytes = nonNegInt(cfgAll.r2_backup_bytes);
  return {
    period,
    class_a: get(period, "r2_class_a"),
    class_b: get(period, "r2_class_b"),
    renders_month: get(period, "pdf_render"),
    renders_today: get(day, "pdf_render"),
    pdf_bytes: pdfBytes,
    backup_bytes: backupBytes,
    backup_files: nonNegInt(cfgAll.r2_backup_files),
    bytes_total: pdfBytes + backupBytes,
    limits: r2Caps(cfgAll),
    free_tier: { ...R2_FREE_TIER },
  };
}

// compact form carried by PDF_QUOTA errors
export const quotaUsage = (u) => ({ bytes: u.bytes_total, class_a: u.class_a, class_b: u.class_b, limits: u.limits });
