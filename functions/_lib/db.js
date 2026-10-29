// db.js — D1 schema + automatic migrations, config store, form-version cache, audit + chunked-batch helpers.
import { err, jparse } from "./http.js";
import { currentRound, isMonth, monthFy, nowIso } from "./time.js";

// ---- schema ---------------------------------------------------------------------------------------
// Migration v1 = phase 2 spec §3.3 + documented additions (see functions/API.md §8). v2 = 2b-R, v3 = 2m, v4 = 2o, v5 = 2p, v6 = 2w, v7 = 2x (below).
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

// Migration v2 (2b-R, PDF retention + R2 cost guard): pdf_files.bytes + usage_counters (API.md §6b/§8).
// `ALTER TABLE … ADD COLUMN` is not idempotent → v2 runs statement by statement and swallows only "duplicate column".
const V2 = [
  `ALTER TABLE pdf_files ADD COLUMN bytes INTEGER`,
  `CREATE TABLE IF NOT EXISTS usage_counters (
     period TEXT NOT NULL, metric TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (period, metric))`,
];

// Migration v3 (2m, PIN login counter shown to admin): pcus.login_count + pcus.last_login_at, backfilled from audit_log
// (successful pcuLogin rows = action 'pcuLogin' AND detail 'ok'). The backfill is idempotent (recomputed from audit_log).
const V3 = [
  `ALTER TABLE pcus ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pcus ADD COLUMN last_login_at TEXT`,
  `UPDATE pcus SET
     login_count = (SELECT COUNT(*) FROM audit_log a WHERE a.action = 'pcuLogin' AND a.detail = 'ok' AND a.pcu = pcus.code),
     last_login_at = (SELECT MAX(a.ts) FROM audit_log a WHERE a.action = 'pcuLogin' AND a.detail = 'ok' AND a.pcu = pcus.code)`,
];

// Migration v4 (2o, stock mode A/B): pcus.stock_mode + request_lines.used / adj / adj_reason / calc_from (spec 2o-2s §3.1). Same one-by-one rule.
const V4 = [
  `ALTER TABLE pcus ADD COLUMN stock_mode TEXT NOT NULL DEFAULT 'A'`,
  `ALTER TABLE request_lines ADD COLUMN used INTEGER`,
  `ALTER TABLE request_lines ADD COLUMN adj INTEGER`,
  `ALTER TABLE request_lines ADD COLUMN adj_reason TEXT`,
  `ALTER TABLE request_lines ADD COLUMN calc_from TEXT`,
];

// Migration v5 (2p, price effective from a round): price_history + request_lines.price_print (spec 2o-2s §4.1). Same one-by-one rule.
// Backfill (re-runnable): price_print = price_snapshot where still NULL · one price_history row per item of the LATEST form version of every fy
// that has a form, from_round = the fy's first round (2w: fyMonths(fy)[0] = "<fy-544>-10", e.g. FY2570 → 2026-10), INSERT OR IGNORE.
// (Before 2w the first round was "<fy-544>-11"; databases migrated then are realigned by v6.)
const V5 = [
  `CREATE TABLE IF NOT EXISTS price_history (
     fy INTEGER NOT NULL, item_code TEXT NOT NULL, from_round TEXT NOT NULL, price REAL NOT NULL, set_by TEXT, set_at TEXT, note TEXT,
     PRIMARY KEY (fy, item_code, from_round))`,
  `ALTER TABLE request_lines ADD COLUMN price_print REAL`,
  `UPDATE request_lines SET price_print = price_snapshot WHERE price_print IS NULL AND price_snapshot IS NOT NULL`,
  `INSERT OR IGNORE INTO price_history (fy, item_code, from_round, price, set_by, set_at, note)
     SELECT fv.fy, json_extract(r.value, '$.code'), printf('%04d-10', fv.fy - 544), COALESCE(json_extract(r.value, '$.price'), 0),
            'migration v5', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'backfill: latest form of the fy'
       FROM form_versions fv, json_each(fv.data, '$.steps') s, json_each(s.value, '$.rows') r
      WHERE fv.id IN (SELECT MAX(id) FROM form_versions GROUP BY fy)
        AND json_extract(r.value, '$.type') = 'item' AND json_extract(r.value, '$.code') IS NOT NULL`,
];

// Migration v6 (2w, fy = the supply month itself Oct … Sep; admin keys requests for a pcu): requests.entry_by ('admin' = keyed/edited by an
// admin, sticky; NULL = the pcu) + realign data written under the 2j fy (first round "<fy-544>-11"): price_history rows at the old first
// round move to the new one "<fy-544>-10" (UPDATE OR IGNORE — a row already there wins) · rounds.fy recomputed from the month. Re-runnable.
const V6 = [
  `ALTER TABLE requests ADD COLUMN entry_by TEXT`,
  `UPDATE OR IGNORE price_history SET from_round = printf('%04d-10', fy - 544) WHERE from_round = printf('%04d-11', fy - 544)`,
  `UPDATE rounds SET fy = CAST(substr(month, 1, 4) AS INTEGER) + 543 + (CASE WHEN CAST(substr(month, 6, 2) AS INTEGER) >= 10 THEN 1 ELSE 0 END)`,
];

// Migration v7 (2x, requester name on the printed sheet): pcus.requester_name (set by admin only) + pcus.phone (default "โทร" line) ·
// requester_log (one row per name change, rows older than 2 years pruned on write) · requests.requester_name = the name frozen at send
// (NULL on requests sent before 2x → printed with the pcu's first logged name). Same one-by-one rule.
const V7 = [
  `ALTER TABLE pcus ADD COLUMN requester_name TEXT`,
  `ALTER TABLE pcus ADD COLUMN phone TEXT`,
  `ALTER TABLE requests ADD COLUMN requester_name TEXT`,
  `CREATE TABLE IF NOT EXISTS requester_log (
     pcu TEXT NOT NULL, name TEXT, set_at TEXT NOT NULL, set_by TEXT, PRIMARY KEY (pcu, set_at))`,
];

// oneByOne: run each statement on its own; an error whose message matches `tolerate` is ignored (a racing isolate got there first).
export const MIGRATIONS = [
  { v: 1, statements: V1 },
  { v: 2, statements: V2, oneByOne: true, tolerate: /duplicate column/i },
  { v: 3, statements: V3, oneByOne: true, tolerate: /duplicate column/i },
  { v: 4, statements: V4, oneByOne: true, tolerate: /duplicate column/i },
  { v: 5, statements: V5, oneByOne: true, tolerate: /duplicate column/i },
  { v: 6, statements: V6, oneByOne: true, tolerate: /duplicate column/i },
  { v: 7, statements: V7, oneByOne: true, tolerate: /duplicate column/i },
];
export const TABLES = [
  "config", "users", "pcus", "form_versions", "rounds", "requests", "request_lines", "issue_status", "hidden_items",
  "limits", "limit_unlocks", "plans", "actual_prev", "prices_prev", "price_history", "stats", "pdf_files", "usage_counters", "requester_log", "audit_log",
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
    if (m.oneByOne) {
      for (const s of m.statements) {
        try {
          await DB.prepare(s).run();
        } catch (e) {
          if (!(m.tolerate && m.tolerate.test(String((e && e.message) || "") + " " + String((e && e.cause && e.cause.message) || "")))) throw e;
        }
      }
      await DB.prepare(`INSERT INTO schema_version (v) VALUES (?)`).bind(m.v).run();
      continue;
    }
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

// dev only (devRerunMigration, tests): forget migrations >= v and run them again on the existing tables (idempotency check).
export async function rerunMigrationsFrom(env, v) {
  const DB = getDb(env);
  await DB.prepare(`DELETE FROM schema_version WHERE v >= ?`).bind(v).run();
  resetCaches();
  await ensureSchema(env);
  return currentSchemaVersion(DB);
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
    trial_month: isMonth(cfg.trial_month) ? cfg.trial_month : null, // 2j: the practice round ("YYYY-MM") or null
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

// 2j: the form a ROUND month resolves against when nothing is bound — latest version of the round's fy, else of fy_current
// (`fyCurrent`; read from config when omitted), else the newest version of any fy. null when no versions exist at all.
// (The trial round 2026-09 is fy 2569, which has no form version → it uses the fy_current form.)
export async function formForFy(DB, fy, fyCurrent) {
  const strict = async (f) => {
    const row = await DB.prepare(`SELECT id FROM form_versions WHERE fy = ? ORDER BY id DESC LIMIT 1`).bind(f).first();
    return row ? loadForm(DB, row.id) : null;
  };
  const own = await strict(fy);
  if (own) return own;
  if (!Number.isInteger(fyCurrent)) fyCurrent = publicConfig(await getConfigAll(DB), monthFy(currentRound())).fy_current;
  if (fyCurrent !== fy) {
    const cur = await strict(fyCurrent);
    if (cur) return cur;
  }
  const row = await DB.prepare(`SELECT id FROM form_versions ORDER BY id DESC LIMIT 1`).first();
  return row ? loadForm(DB, row.id) : null;
}

// API-facing form object (no server-side index).
// opts.pcu: PCU-facing copy — soft-deleted pages (step.active === false, 2d) are stripped. Admin-facing callers keep them.
export function formPublic(form, opts) {
  if (!form) return null;
  const steps = opts && opts.pcu ? form.steps.filter((s) => s.active !== false) : form.steps;
  return { id: form.id, fy: form.fy, created_at: form.created_at, note: form.note, steps };
}

// 2v: {old code -> code of the item that replaces it} from item rows' `links` (chains A→B→C resolve to C). Cached on the form object.
// Prior-year data (actual_prev / stats / prices_prev / plans fy−1) and lines of a linked closed code count under the new code.
export function linkMap(form) {
  if (!form) return new Map();
  if (form.linkMap) return form.linkMap;
  const direct = new Map();
  for (const s of form.steps || []) for (const r of s.rows || []) if (r.type === "item" && Array.isArray(r.links)) for (const c of r.links) if (c !== r.code) direct.set(c, r.code);
  const m = new Map();
  for (const k of direct.keys()) {
    let c = direct.get(k), n = 0;
    while (direct.has(c) && c !== k && n++ < 50) c = direct.get(c);
    m.set(k, c);
  }
  form.linkMap = m;
  return m;
}
export const linkedCode = (lm, code) => (lm && lm.get(code)) || code;
// 2v: rows [pcu, code, ...values] of prior-year data (stats …) + a copy under the linking code for every (pcu, old code) whose new
// code has no row of its own (first old code wins). Rows of the old code stay (closed items still resolve).
export function withLinkedRows(rows, lm) {
  if (!lm || !lm.size) return rows;
  const k = (pcu, code) => pcu + "\u0000" + code;
  const have = new Set(rows.map((r) => k(r[0], r[1])));
  const extra = [];
  for (const r of rows) {
    const n = lm.get(r[1]);
    if (n && !have.has(k(r[0], n))) { have.add(k(r[0], n)); extra.push([r[0], n, ...r.slice(2)]); }
  }
  return extra.length ? rows.concat(extra) : rows;
}

// item price map {code: price} of a form
export function priceMap(form) {
  const m = {};
  if (form) for (const [code, { item }] of form.index) m[code] = Number(item.price) || 0;
  return m;
}
