// db.js — D1 schema + automatic migrations, config store, form-version cache, audit + chunked-batch helpers.
import { err, jparse } from "./http.js";
import { nowIso } from "./time.js";

// ---- schema ---------------------------------------------------------------------------------------
// Migration v1 = phase 2 spec §3.3 + documented additions (see functions/API.md §8).
// Every migration MUST be idempotent (two isolates may race on first boot).
const V1 = [
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (
     email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('admin','dispenser')),
     units TEXT NOT NULL DEFAULT '[]', added_at TEXT, added_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS pcus (
     code TEXT PRIMARY KEY, name TEXT NOT NULL, print_name TEXT, "group" TEXT,
     pin_hash TEXT, pin_salt TEXT, pin_version INTEGER NOT NULL DEFAULT 1,
     pin_fail INTEGER NOT NULL DEFAULT 0, pin_locked_until TEXT, pin_custom INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS form_versions (
     id INTEGER PRIMARY KEY AUTOINCREMENT, fy INTEGER NOT NULL, created_at TEXT, created_by TEXT, note TEXT,
     data TEXT NOT NULL, data_hash TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_form_versions_fy ON form_versions(fy, id)`,
  `CREATE TABLE IF NOT EXISTS rounds (
     month TEXT PRIMARY KEY, fy INTEGER, deadline_date TEXT, locked INTEGER NOT NULL DEFAULT 0,
     locked_at TEXT, locked_by TEXT, note TEXT)`,
  `CREATE TABLE IF NOT EXISTS requests (
     id TEXT PRIMARY KEY, pcu TEXT NOT NULL, month TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','issued')),
     form_version_id INTEGER, submitter_name TEXT, last_step TEXT, created_at TEXT, updated_at TEXT,
     first_submitted_at TEXT, submitted_at TEXT, submit_count INTEGER NOT NULL DEFAULT 0,
     admin_note TEXT, admin_note_at TEXT, issued_seen_at TEXT, UNIQUE (pcu, month))`,
  `CREATE INDEX IF NOT EXISTS idx_requests_month ON requests(month)`,
  `CREATE TABLE IF NOT EXISTS request_lines (
     request_id TEXT NOT NULL, item_code TEXT NOT NULL, stock INTEGER, op INTEGER, pp INTEGER,
     price_snapshot REAL, updated_at TEXT,
     issued_total INTEGER, issued_op INTEGER, issued_pp INTEGER, issue_reason TEXT, issue_note TEXT,
     issued_at TEXT, issued_by TEXT, PRIMARY KEY (request_id, item_code))`,
  `CREATE TABLE IF NOT EXISTS issue_status (
     request_id TEXT NOT NULL, dispense_unit TEXT NOT NULL, done_at TEXT, done_by TEXT,
     PRIMARY KEY (request_id, dispense_unit))`,
  `CREATE TABLE IF NOT EXISTS hidden_items (
     pcu TEXT NOT NULL, item_code TEXT NOT NULL, hidden_at TEXT, by TEXT, PRIMARY KEY (pcu, item_code))`,
  `CREATE TABLE IF NOT EXISTS limits (
     fy INTEGER NOT NULL, pcu TEXT NOT NULL, item_code TEXT NOT NULL, limit_month INTEGER, limit_year INTEGER,
     source TEXT, updated_by TEXT, updated_at TEXT, note TEXT, PRIMARY KEY (fy, pcu, item_code))`,
  `CREATE TABLE IF NOT EXISTS limit_unlocks (
     pcu TEXT NOT NULL, item_code TEXT NOT NULL, month TEXT NOT NULL, reason TEXT, by TEXT, at TEXT,
     PRIMARY KEY (pcu, item_code, month))`,
  `CREATE TABLE IF NOT EXISTS plans (
     fy INTEGER NOT NULL, pcu TEXT NOT NULL, item_code TEXT NOT NULL, plan_op REAL, plan_pp REAL,
     PRIMARY KEY (fy, pcu, item_code))`,
  `CREATE TABLE IF NOT EXISTS actual_prev (
     fy INTEGER NOT NULL, month TEXT NOT NULL, pcu TEXT NOT NULL, item_code TEXT NOT NULL, op REAL, pp REAL,
     PRIMARY KEY (fy, month, pcu, item_code))`,
  `CREATE TABLE IF NOT EXISTS prices_prev (
     fy INTEGER NOT NULL, item_code TEXT NOT NULL, price REAL, PRIMARY KEY (fy, item_code))`,
  `CREATE TABLE IF NOT EXISTS stats (
     fy INTEGER NOT NULL, pcu TEXT NOT NULL, item_code TEXT NOT NULL, median_m REAL, p90_m REAL, annual_qty REAL,
     PRIMARY KEY (fy, pcu, item_code))`,
  `CREATE TABLE IF NOT EXISTS pdf_files (
     request_id TEXT NOT NULL, content_key TEXT NOT NULL, r2_key TEXT, created_at TEXT, PRIMARY KEY (request_id, content_key))`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, role TEXT, action TEXT, pcu TEXT, month TEXT, detail TEXT)`,
];

export const MIGRATIONS = [{ v: 1, statements: V1 }];
export const TABLES = [
  "config", "users", "pcus", "form_versions", "rounds", "requests", "request_lines", "issue_status", "hidden_items",
  "limits", "limit_unlocks", "plans", "actual_prev", "prices_prev", "stats", "pdf_files", "audit_log",
];

let migrated = false;

export function getDb(env) {
  if (!env || !env.DB) throw err("SERVER_ERROR", "ไม่พบฐานข้อมูล (binding DB)");
  return env.DB;
}

export async function ensureSchema(env) {
  if (migrated) return;
  const DB = getDb(env);
  await DB.prepare(`CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`).run();
  const row = await DB.prepare(`SELECT MAX(v) AS v FROM schema_version`).first();
  const cur = Number((row && row.v) || 0);
  for (const m of MIGRATIONS) {
    if (m.v <= cur) continue;
    const stmts = m.statements.map((s) => DB.prepare(s));
    stmts.push(DB.prepare(`INSERT INTO schema_version (v) VALUES (?)`).bind(m.v));
    await DB.batch(stmts);
  }
  migrated = true;
}

export async function currentSchemaVersion(DB) {
  const row = await DB.prepare(`SELECT MAX(v) AS v FROM schema_version`).first();
  return Number((row && row.v) || 0);
}

// dev only (devReset): drop everything, forget per-isolate caches
export async function dropAllTables(env) {
  const DB = getDb(env);
  const stmts = [...TABLES, "schema_version"].map((t) => DB.prepare(`DROP TABLE IF EXISTS ${t}`));
  await DB.batch(stmts);
  resetCaches();
  await ensureSchema(env);
}

export function resetCaches() {
  migrated = false;
  formCache.clear();
}

// ---- chunked batches ---------------------------------------------------------------------------------
// D1: ≤ 100 statements per batch is the conservative bound we use; each chunk is atomic, the whole is not.
export async function batchChunked(DB, stmts, size = 100) {
  const out = [];
  for (let i = 0; i < stmts.length; i += size) {
    const res = await DB.batch(stmts.slice(i, i + size));
    out.push(...res);
  }
  return out;
}

// Multi-row INSERT statements honouring D1's 100 bound-parameter limit.
// opts.prefix: "INSERT INTO" | "INSERT OR IGNORE INTO" | "INSERT OR REPLACE INTO"; opts.suffix: e.g. "ON CONFLICT(...) DO UPDATE ..."
export function insertStatements(DB, table, cols, rows, opts = {}) {
  const prefix = opts.prefix || "INSERT INTO";
  const suffix = opts.suffix ? " " + opts.suffix : "";
  const perStmt = Math.max(1, Math.floor(100 / cols.length));
  const colSql = cols.map((c) => (c === "group" ? `"group"` : c)).join(",");
  const one = "(" + cols.map(() => "?").join(",") + ")";
  const stmts = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const part = rows.slice(i, i + perStmt);
    const sql = `${prefix} ${table} (${colSql}) VALUES ${part.map(() => one).join(",")}${suffix}`;
    stmts.push(DB.prepare(sql).bind(...part.flat()));
  }
  return stmts;
}

// ---- config ------------------------------------------------------------------------------------------------
export const SECRET_CONFIG_KEYS = new Set(["backup_pw_hash", "backup_pw_salt", "backup_version", "backup_fail", "backup_locked_until"]);

export async function getConfigAll(DB) {
  const { results } = await DB.prepare(`SELECT key, value FROM config`).all();
  const cfg = {};
  for (const r of results) cfg[r.key] = jparse(r.value, null);
  return cfg;
}

export const configStmt = (DB, key, value) =>
  DB.prepare(`INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(key, JSON.stringify(value));

// normalised, defaulted view of the settings the frontends need
export function publicConfig(cfg, fallbackFy) {
  const mode = ["off", "warn", "enforce"].includes(cfg.limit_mode) ? cfg.limit_mode : "warn";
  const fy = Number.isInteger(cfg.fy_current) ? cfg.fy_current : fallbackFy;
  const dd = Number.isInteger(cfg.deadline_day) && cfg.deadline_day >= 1 && cfg.deadline_day <= 31 ? cfg.deadline_day : null;
  return {
    limit_mode: mode,
    stock_required: Number(cfg.stock_required) === 1 ? 1 : 0,
    deadline_day: dd,
    fy_current: fy,
  };
}
export function budgetConfig(cfg) {
  const n = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return { budget_op: n(cfg.budget_op, 520000), budget_pp: n(cfg.budget_pp, 390000), budget_total: n(cfg.budget_total, 910000) };
}

// ---- audit ---------------------------------------------------------------------------------------------------
// Returns a prepared statement so it can ride in the same batch as the mutation.
export function auditStmt(DB, actor, role, action, pcu, month, detail) {
  return DB.prepare(`INSERT INTO audit_log (ts,actor,role,action,pcu,month,detail) VALUES (?,?,?,?,?,?,?)`)
    .bind(nowIso(), actor || "", role || "", action, pcu || "", month || "", detail === undefined || detail === null ? "" : String(detail).slice(0, 2000));
}

// ---- form versions ----------------------------------------------------------------------------------------------
const formCache = new Map(); // id -> parsed form (versions are immutable)

export const DEFAULT_UNIT_BY_STEP = (code) => (code === "CS" ? "จ่ายกลาง" : code === "LAB" ? "LAB" : "พัสดุ");

// Fills defaults a seed may omit (dispense_unit, item.active). Returns a new object.
export function normalizeForm(form) {
  const steps = (form.steps || []).map((s) => ({
    ...s,
    dispense_unit: s.dispense_unit || DEFAULT_UNIT_BY_STEP(s.code),
    rows: (s.rows || []).map((r) => (r.type === "item" ? { ...r, active: r.active === false ? false : true } : { ...r })),
  }));
  return { ...form, steps };
}

function buildIndex(form) {
  const items = new Map(); // code -> {item, step}
  for (const step of form.steps) for (const r of step.rows) if (r.type === "item") items.set(r.code, { item: r, step });
  return items;
}

export async function loadForm(DB, id) {
  if (formCache.has(id)) return formCache.get(id);
  const row = await DB.prepare(`SELECT id, fy, created_at, created_by, note, data FROM form_versions WHERE id = ?`).bind(id).first();
  if (!row) return null;
  const data = jparse(row.data, { steps: [] });
  const form = { id: row.id, fy: row.fy, created_at: row.created_at, created_by: row.created_by, note: row.note, steps: data.steps || [] };
  form.index = buildIndex(form);
  formCache.set(id, form);
  return form;
}

// Latest form version for a fiscal year; falls back to the newest version of any fy (so a month in an fy
// with no form yet still works). null when no versions exist at all.
export async function latestForm(DB, fy) {
  let row = await DB.prepare(`SELECT id FROM form_versions WHERE fy = ? ORDER BY id DESC LIMIT 1`).bind(fy).first();
  if (!row) row = await DB.prepare(`SELECT id FROM form_versions ORDER BY id DESC LIMIT 1`).first();
  return row ? loadForm(DB, row.id) : null;
}

// API-facing form object (no server-side index)
export function formPublic(form) {
  if (!form) return null;
  return { id: form.id, fy: form.fy, created_at: form.created_at, note: form.note, steps: form.steps };
}

// item price map {code: price} of a form
export function priceMap(form) {
  const m = {};
  if (form) for (const [code, { item }] of form.index) m[code] = Number(item.price) || 0;
  return m;
}
