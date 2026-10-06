// admin.js — admin / dispenser actions (functions/API.md §5). ctx.who = {email, role, units, backup}.
import { err, assertLimitValue, isStr, jparse } from "./http.js";
import {
  SECRET_CONFIG_KEYS, auditStmt, batchChunked, budgetConfig, configStmt, formPublic, getConfigAll, insertStatements,
  latestForm, loadForm, priceMap, publicConfig, TABLES,
} from "./db.js";
import {
  BACKUP_LOCK_MIN, BACKUP_MAX_FAIL, PIN_LENGTH, UNITS, constantTimeEq, envAdmins, hashSecret, lookupUser, makeStaffToken, newSalt,
  verifyGoogleIdToken,
} from "./auth.js";
import {
  computeDeadline, currentMonth, fyMonths, isDate, isMonth, monthFy, nowIso, prevMonth,
} from "./time.js";
import {
  LINE_COLS, REQ_COLS, getLines, getRequestRow, getRoundRows, requestId, requestObj, roundInfo,
} from "./views.js";
import { runBackup } from "./backup.js";

const round2 = (x) => Math.round(x * 100) / 100;

function ctxFy(cfgAll) {
  return publicConfig(cfgAll, monthFy(currentMonth())).fy_current;
}

async function assertPcu(DB, code) {
  const row = await DB.prepare(`SELECT code, name, print_name, "group" AS grp FROM pcus WHERE code = ?`).bind(String(code || "")).first();
  if (!row) throw err("NOT_FOUND", "ไม่พบ รพ.สต. นี้: " + code);
  return row;
}
async function assertItem(DB, fy, code) {
  const form = await latestForm(DB, fy);
  if (!form || !isStr(code) || !form.index.has(code)) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + code);
  return form;
}
const itemCodeParam = (p) => (p.item_code !== undefined ? p.item_code : p.code);
function assertMonthParam(m) {
  if (!isMonth(m)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง: " + m);
}

// ---- login ------------------------------------------------------------------------------------------------------
export async function adminLoginGoogle(ctx, p) {
  const { DB, env } = ctx;
  if (!p.id_token) throw err("BAD_REQUEST", "ต้องมี id_token");
  const email = await verifyGoogleIdToken(env, p.id_token);
  const user = await lookupUser(env, DB, email);
  if (!user) {
    await DB.batch([auditStmt(DB, email, "", "adminLoginGoogle", "", "", "forbidden")]);
    throw err("FORBIDDEN", "บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ");
  }
  const tok = await makeStaffToken(env, user.role, email, 0);
  await DB.batch([auditStmt(DB, email, user.role, "adminLoginGoogle", "", "", "ok")]);
  return { token: tok.token, exp: tok.exp, email, role: user.role, units: user.units };
}

export async function adminLoginBackup(ctx, p) {
  const { DB, env } = ctx;
  const password = String(p.password || "");
  if (!password) throw err("BAD_REQUEST", "กรอกรหัสผ่าน");
  const cfg = await getConfigAll(DB);
  if (!cfg.backup_pw_hash || !cfg.backup_pw_salt) throw err("NOT_FOUND", "ยังไม่ได้ตั้งรหัสผ่านสำรอง");
  const now = Date.now();
  let fail = Number(cfg.backup_fail) || 0;
  if (cfg.backup_locked_until) {
    const until = Date.parse(cfg.backup_locked_until);
    if (!Number.isNaN(until) && until > now) throw err("LOCKED", "รหัสผ่านสำรองถูกล็อกชั่วคราว", { until: cfg.backup_locked_until });
    fail = 0;
  }
  const attempt = await hashSecret(password, cfg.backup_pw_salt);
  if (constantTimeEq(attempt, cfg.backup_pw_hash)) {
    const stmts = [auditStmt(DB, "backup", "admin", "adminLoginBackup", "", "", "ok")];
    if (fail || cfg.backup_locked_until) stmts.push(configStmt(DB, "backup_fail", 0), configStmt(DB, "backup_locked_until", ""));
    await DB.batch(stmts);
    const tok = await makeStaffToken(env, "admin", "backup", Number(cfg.backup_version) || 0);
    return { token: tok.token, exp: tok.exp, role: "admin" };
  }
  fail += 1;
  if (fail >= BACKUP_MAX_FAIL) {
    const until = new Date(now + BACKUP_LOCK_MIN * 60000).toISOString();
    await DB.batch([configStmt(DB, "backup_fail", fail), configStmt(DB, "backup_locked_until", until), auditStmt(DB, "backup", "admin", "adminLoginBackup", "", "", "locked")]);
    throw err("LOCKED", "ใส่รหัสผ่านผิดครบ 5 ครั้ง ถูกล็อกชั่วคราว", { until });
  }
  await DB.batch([configStmt(DB, "backup_fail", fail), auditStmt(DB, "backup", "admin", "adminLoginBackup", "", "", `bad_password fail=${fail}`)]);
  throw err("BAD_PASSWORD", "รหัสผ่านไม่ถูกต้อง", { remaining: BACKUP_MAX_FAIL - fail });
}

// ---- users -----------------------------------------------------------------------------------------------------------
async function effectiveUsers(env, DB) {
  const { results } = await DB.prepare(`SELECT email, role, units, added_at, added_by FROM users ORDER BY role, email`).all();
  if (results.length) {
    return {
      source: "table",
      users: results.map((u) => ({ email: u.email, role: u.role, units: u.role === "admin" ? [...UNITS] : jparse(u.units, []), added_at: u.added_at, added_by: u.added_by })),
    };
  }
  return { source: "env", users: envAdmins(env).map((e) => ({ email: e, role: "admin", units: [...UNITS], added_at: null, added_by: "env" })) };
}

// statements that copy ADMIN_EMAILS into the (empty) users table before the first mutation
async function materializeStmts(env, DB, actor) {
  const eff = await effectiveUsers(env, DB);
  if (eff.source !== "env" || !eff.users.length) return { source: eff.source, stmts: [], users: eff.users };
  const ts = nowIso();
  return {
    source: "env",
    users: eff.users,
    stmts: eff.users.map((u) => DB.prepare(`INSERT OR IGNORE INTO users (email,role,units,added_at,added_by) VALUES (?,?,?,?,?)`).bind(u.email, "admin", JSON.stringify(UNITS), ts, actor || "env")),
  };
}

export async function adminUsersList(ctx) {
  const eff = await effectiveUsers(ctx.env, ctx.DB);
  return { users: eff.users, source: eff.source };
}

export async function adminUsersAdd(ctx, p) {
  const { DB, env, who } = ctx;
  const email = String(p.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err("BAD_REQUEST", "อีเมลไม่ถูกต้อง");
  if (p.role !== "admin" && p.role !== "dispenser") throw err("BAD_REQUEST", "role ต้องเป็น admin หรือ dispenser");
  let units = [...UNITS];
  if (p.role === "dispenser") {
    units = Array.isArray(p.units) ? [...new Set(p.units)] : [];
    if (!units.length || units.some((u) => !UNITS.includes(u))) throw err("BAD_REQUEST", "ผู้จ่ายต้องมีอย่างน้อย 1 หน่วยจ่าย (พัสดุ / จ่ายกลาง / LAB)");
  }
  const mat = await materializeStmts(env, DB, who.email);
  // demoting the only admin to dispenser is refused (same guard as adminUsersRemove)
  const existing = mat.users.find((u) => u.email === email);
  if (p.role === "dispenser" && existing && existing.role === "admin" && mat.users.filter((u) => u.role === "admin").length <= 1) {
    throw err("CONFLICT", "ต้องมี admin อย่างน้อย 1 คน");
  }
  await DB.batch([...mat.stmts,
    DB.prepare(`INSERT INTO users (email,role,units,added_at,added_by) VALUES (?,?,?,?,?)
                ON CONFLICT(email) DO UPDATE SET role=excluded.role, units=excluded.units`).bind(email, p.role, JSON.stringify(units), nowIso(), who.email),
    auditStmt(DB, who.email, who.role, "adminUsersAdd", "", "", `${email} ${p.role} ${units.join("/")}`)]);
  return { users: (await effectiveUsers(env, DB)).users };
}

export async function adminUsersRemove(ctx, p) {
  const { DB, env, who } = ctx;
  const email = String(p.email || "").trim().toLowerCase();
  const mat = await materializeStmts(env, DB, who.email);
  const users = mat.users;
  const target = users.find((u) => u.email === email);
  if (!target) throw err("NOT_FOUND", "ไม่พบผู้ใช้นี้");
  if (target.role === "admin" && users.filter((u) => u.role === "admin").length <= 1) throw err("CONFLICT", "ห้ามถอด admin คนสุดท้าย");
  await DB.batch([...mat.stmts, DB.prepare(`DELETE FROM users WHERE email = ?`).bind(email),
    auditStmt(DB, who.email, who.role, "adminUsersRemove", "", "", email)]);
  const after = await effectiveUsers(env, DB);
  return { users: after.users };
}

// ---- bootstrap ----------------------------------------------------------------------------------------------------------
export async function adminBootstrap(ctx) {
  const { DB, env, who } = ctx;
  const cur = currentMonth(), prev = prevMonth(cur);
  const cfgAll = await getConfigAll(DB);
  const cfg = { ...publicConfig(cfgAll, monthFy(cur)), ...budgetConfig(cfgAll) };
  const fy = cfg.fy_current;
  const isAdmin = who.role === "admin";
  const months12 = fyMonths(fy);

  const [form, fvRes, pcuRes, reqMonths, roundRes] = await Promise.all([
    latestForm(DB, fy),
    DB.prepare(`SELECT id, fy, created_at, created_by, note FROM form_versions ORDER BY id DESC`).all(),
    DB.prepare(`SELECT code, name, print_name, "group" AS grp, pin_locked_until, pin_fail, pin_custom FROM pcus ORDER BY code`).all(),
    DB.prepare(`SELECT DISTINCT month FROM requests ORDER BY month DESC`).all(),
    DB.prepare(`SELECT * FROM rounds`).all(),
  ]);

  const roundMap = new Map(roundRes.results.map((r) => [r.month, r]));
  const monthSet = new Set([cur, prev, ...reqMonths.results.map((r) => r.month), ...roundRes.results.map((r) => r.month)]);
  const rounds = [...monthSet].sort().reverse().map((m) => roundInfo(m, roundMap.get(m), cfg.deadline_day));

  const nowMs = Date.now();
  const out = {
    me: { email: who.email, role: who.role, units: who.units },
    server_time: nowIso(), current_month: cur,
    config: isAdmin ? cfg : { limit_mode: cfg.limit_mode, stock_required: cfg.stock_required, deadline_day: cfg.deadline_day, fy_current: cfg.fy_current },
    pcus: pcuRes.results.map((r) => isAdmin
      ? {
          code: r.code, name: r.name, print_name: r.print_name || r.name, group: r.grp,
          pin_locked_until: r.pin_locked_until && Date.parse(r.pin_locked_until) > nowMs ? r.pin_locked_until : null,
          pin_fail: Number(r.pin_fail) || 0, pin_custom: !!r.pin_custom,
        }
      : { code: r.code, name: r.name, print_name: r.print_name || r.name, group: r.grp }),
    form: formPublic(form),
    form_versions: fvRes.results,
    months: reqMonths.results.map((r) => r.month),
    rounds,
  };
  if (!isAdmin) return out;

  const [planRes, statRes, limRes, unlockRes, hidRes, prevFyRes, usersEff] = await Promise.all([
    DB.prepare(`SELECT pcu, item_code, plan_op, plan_pp FROM plans WHERE fy = ?`).bind(fy).raw(),
    DB.prepare(`SELECT pcu, item_code, median_m, p90_m, annual_qty FROM stats WHERE fy = ?`).bind(fy - 1).raw(),
    DB.prepare(`SELECT pcu, item_code, limit_month, limit_year, source, updated_by, updated_at, note FROM limits WHERE fy = ?`).bind(fy).raw(),
    DB.prepare(`SELECT pcu, item_code, month, reason, by, at FROM limit_unlocks WHERE month >= ? AND month <= ?`).bind(months12[0], months12[11]).all(),
    DB.prepare(`SELECT pcu, item_code FROM hidden_items`).raw(),
    DB.prepare(`SELECT DISTINCT fy FROM actual_prev ORDER BY fy`).all(),
    effectiveUsers(env, DB),
  ]);

  const plans = {};
  let op = 0, pp = 0;
  const prices = priceMap(form);
  for (const [pcu, code, pop, ppp] of planRes) {
    (plans[pcu] ||= {})[code] = [pop || 0, ppp || 0];
    const price = prices[code] || 0;
    op += (pop || 0) * price; pp += (ppp || 0) * price;
  }
  out.plans = plans;
  out.plan_totals = { fy, op: round2(op), pp: round2(pp), total: round2(op + pp) };

  const statsData = {};
  for (const [pcu, code, med, p90, ann] of statRes) (statsData[pcu] ||= {})[code] = [med || 0, p90 || 0, ann || 0];
  out.stats = { fy: fy - 1, data: statsData };

  const limits = {};
  for (const [pcu, code, lm, ly, source, by, at, note] of limRes) {
    (limits[pcu] ||= {})[code] = { limit_month: lm ?? null, limit_year: ly ?? null, source, updated_by: by, updated_at: at, note: note ?? null };
  }
  out.limits = limits;
  out.unlocks = unlockRes.results;
  const hidden = {};
  for (const [pcu, code] of hidRes) (hidden[pcu] ||= []).push(code);
  out.hidden = hidden;

  // previous fiscal years (actual_prev + plans + prices)
  const prevOut = {};
  const fys = prevFyRes.results.map((r) => r.fy);
  if (fys.length) {
    const inFy = fys.map(() => "?").join(",");
    const [apRes, ppRes, prRes] = await Promise.all([
      DB.prepare(`SELECT fy, month, pcu, item_code, op, pp FROM actual_prev WHERE fy IN (${inFy})`).bind(...fys).raw(),
      DB.prepare(`SELECT fy, pcu, item_code, plan_op, plan_pp FROM plans WHERE fy IN (${inFy})`).bind(...fys).raw(),
      DB.prepare(`SELECT fy, item_code, price FROM prices_prev WHERE fy IN (${inFy})`).bind(...fys).raw(),
    ]);
    for (const f of fys) prevOut[f] = { months: fyMonths(f), actual: {}, plans: {}, prices: {} };
    const idx = {};
    for (const f of fys) idx[f] = new Map(prevOut[f].months.map((m, i) => [m, i]));
    for (const [f, month, pcu, code, aop, app] of apRes) {
      const i = idx[f].get(month);
      if (i === undefined) continue;
      const pe = (prevOut[f].actual[pcu] ||= {});
      const e = (pe[code] ||= { op: new Array(12).fill(0), pp: new Array(12).fill(0) });
      e.op[i] = aop || 0; e.pp[i] = app || 0;
    }
    for (const [f, pcu, code, pop, ppp] of ppRes) ((prevOut[f].plans[pcu] ||= {})[code] = [pop || 0, ppp || 0]);
    for (const [f, code, price] of prRes) prevOut[f].prices[code] = price;
  }
  out.prev = prevOut;
  out.users = usersEff.users;
  out.users_source = usersEff.source;
  return out;
}

// ---- requests (admin + dispenser) --------------------------------------------------------------------------------------------
export async function adminRequests(ctx, p) {
  const { DB } = ctx;
  const cur = currentMonth();
  if (p.month !== undefined && p.month !== null) assertMonthParam(p.month);
  const months = p.month ? [p.month] : [cur, prevMonth(cur)];
  const ph = months.map(() => "?").join(",");
  const cfgAll = await getConfigAll(DB);
  const cfg = publicConfig(cfgAll, monthFy(cur));

  const [reqRes, lineRes, hidRes, roundRows] = await Promise.all([
    DB.prepare(`SELECT ${REQ_COLS.split(",").map((c) => "r." + c).join(",")}, p.name AS pcu_name FROM requests r LEFT JOIN pcus p ON p.code = r.pcu
                WHERE r.month IN (${ph}) ORDER BY r.month DESC, r.pcu`).bind(...months).all(),
    DB.prepare(`SELECT request_id, item_code, stock, op, pp, price_snapshot FROM request_lines
                WHERE request_id IN (SELECT id FROM requests WHERE month IN (${ph}))`).bind(...months).all(),
    DB.prepare(`SELECT pcu, COUNT(*) AS n FROM hidden_items GROUP BY pcu`).all(),
    getRoundRows(DB, months),
  ]);
  const hiddenN = new Map(hidRes.results.map((r) => [r.pcu, r.n]));
  const byReq = new Map();
  for (const l of lineRes.results) { if (!byReq.has(l.request_id)) byReq.set(l.request_id, []); byReq.get(l.request_id).push(l); }

  const formFor = async (r) => (r.form_version_id ? loadForm(DB, r.form_version_id) : latestForm(DB, monthFy(r.month)));
  const requests = [];
  for (const r of reqRes.results) {
    const form = await formFor(r);
    const prices = priceMap(form);
    let activeN = 0;
    if (form) for (const [, { item }] of form.index) if (item.active !== false) activeN++;
    let items = 0, filled = 0, qop = 0, qpp = 0, baht = 0;
    const lines = byReq.get(r.id) || [];
    for (const l of lines) {
      if (l.stock !== null && l.stock !== undefined) filled++;
      const total = (l.op || 0) + (l.pp || 0);
      if (total > 0) {
        items++; qop += l.op || 0; qpp += l.pp || 0;
        baht += total * (l.price_snapshot ?? prices[l.item_code] ?? 0);
      }
    }
    const obj = requestObj(r, null, true);
    obj.pcu_name = r.pcu_name;
    obj.progress = {
      items_requested: items, stock_filled: filled, stock_required: Math.max(0, activeN - (hiddenN.get(r.pcu) || 0)),
      lines: lines.length, qty_op: qop, qty_pp: qpp, baht: round2(baht), last_step: r.last_step || "",
    };
    requests.push(obj);
  }
  return {
    requests, rounds: months.map((m) => roundInfo(m, roundRows.get(m), cfg.deadline_day)),
    server_time: nowIso(), current_month: cur,
  };
}

export async function adminGetRequest(ctx, p) {
  const { DB, who } = ctx;
  const pcuRow = await assertPcu(DB, p.pcu);
  assertMonthParam(p.month);
  const reqRow = await getRequestRow(DB, pcuRow.code, p.month);
  const bound = reqRow && reqRow.form_version_id ? await loadForm(DB, reqRow.form_version_id) : null;
  const form = bound || (await latestForm(DB, monthFy(p.month)));
  let lines = reqRow ? await getLines(DB, reqRow.id) : [];
  if (who.role === "dispenser" && form) {
    // dispensers only see the pages of their own dispense units
    lines = lines.filter((l) => {
      const ent = form.index.get(l.item_code);
      return ent && who.units.includes(ent.step.dispense_unit);
    });
  }
  const { results: hid } = await DB.prepare(`SELECT item_code FROM hidden_items WHERE pcu = ?`).bind(pcuRow.code).all();
  return {
    request: reqRow ? requestObj(reqRow, lines, true) : null,
    pcu: { code: pcuRow.code, name: pcuRow.name, print_name: pcuRow.print_name || pcuRow.name, group: pcuRow.grp },
    hidden: hid.map((r) => r.item_code),
    form_version_id: form ? form.id : null,
    form: formPublic(form),
  };
}

export async function adminNote(ctx, p) {
  const { DB, who } = ctx;
  const pcuRow = await assertPcu(DB, p.pcu);
  assertMonthParam(p.month);
  const note = String(p.note ?? "").trim().slice(0, 2000);
  const ts = nowIso();
  const id = requestId(pcuRow.code, p.month);
  const stmts = [];
  if (note) {
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO requests (id,pcu,month,status,created_at,updated_at,submit_count) VALUES (?,?,?, 'draft', ?, ?, 0)`).bind(id, pcuRow.code, p.month, ts, ts));
    stmts.push(DB.prepare(`UPDATE requests SET admin_note = ?, admin_note_at = ? WHERE id = ?`).bind(note, ts, id));
  } else {
    stmts.push(DB.prepare(`UPDATE requests SET admin_note = NULL, admin_note_at = NULL WHERE id = ?`).bind(id));
  }
  stmts.push(auditStmt(DB, who.email, who.role, "adminNote", pcuRow.code, p.month, note ? note.slice(0, 200) : "(cleared)"));
  await batchChunked(DB, stmts);
  const row = await getRequestRow(DB, pcuRow.code, p.month);
  return { request: requestObj(row, null, true) };
}

// ---- rounds -----------------------------------------------------------------------------------------------------------------------------
async function roundResult(DB, month) {
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentMonth()));
  const row = await DB.prepare(`SELECT * FROM rounds WHERE month = ?`).bind(month).first();
  return roundInfo(month, row, cfg.deadline_day);
}

export async function adminSetRound(ctx, p) {
  const { DB, who } = ctx;
  assertMonthParam(p.month);
  let dd = p.deadline_date;
  if (dd === undefined) dd = null;
  if (dd !== null && !isDate(dd)) throw err("BAD_REQUEST", "วันที่ต้องเป็นรูปแบบ YYYY-MM-DD");
  const stmts = [DB.prepare(`INSERT INTO rounds (month, fy, deadline_date) VALUES (?,?,?) ON CONFLICT(month) DO UPDATE SET deadline_date = excluded.deadline_date`).bind(p.month, monthFy(p.month), dd)];
  if (Object.prototype.hasOwnProperty.call(p, "note")) {
    const note = p.note === null ? null : String(p.note).trim().slice(0, 1000) || null;
    stmts.push(DB.prepare(`UPDATE rounds SET note = ? WHERE month = ?`).bind(note, p.month));
  }
  stmts.push(auditStmt(DB, who.email, who.role, "adminSetRound", "", p.month, `deadline=${dd}`));
  await DB.batch(stmts);
  return { round: await roundResult(DB, p.month) };
}

export async function adminLockRound(ctx, p) {
  const { DB, who } = ctx;
  assertMonthParam(p.month);
  const lock = p.locked === 1 || p.locked === true || p.locked === "1" ? 1 : p.locked === 0 || p.locked === false || p.locked === "0" ? 0 : null;
  if (lock === null) throw err("BAD_REQUEST", "locked ต้องเป็น 0 หรือ 1");
  const ts = nowIso();
  await DB.batch([
    DB.prepare(`INSERT INTO rounds (month, fy, locked, locked_at, locked_by) VALUES (?,?,?,?,?)
                ON CONFLICT(month) DO UPDATE SET locked = excluded.locked, locked_at = excluded.locked_at, locked_by = excluded.locked_by`)
      .bind(p.month, monthFy(p.month), lock, lock ? ts : null, lock ? who.email : null),
    auditStmt(DB, who.email, who.role, "adminLockRound", "", p.month, lock ? "locked" : "unlocked"),
  ]);
  return { round: await roundResult(DB, p.month) };
}

// ---- config -------------------------------------------------------------------------------------------------------------------------------
async function configResult(DB) {
  const cfgAll = await getConfigAll(DB);
  return { ...publicConfig(cfgAll, monthFy(currentMonth())), ...budgetConfig(cfgAll) };
}

export async function adminSetLimitMode(ctx, p) {
  const { DB, who } = ctx;
  if (!["off", "warn", "enforce"].includes(p.mode)) throw err("BAD_REQUEST", "โหมดต้องเป็น off, warn หรือ enforce");
  await DB.batch([configStmt(DB, "limit_mode", p.mode), auditStmt(DB, who.email, who.role, "adminSetLimitMode", "", "", p.mode)]);
  return { config: await configResult(DB) };
}

export async function adminSetConfig(ctx, p) {
  const { DB, who } = ctx;
  const key = p.key;
  let value = p.value;
  if (key === "stock_required") {
    if (value === true || value === "1" || value === 1) value = 1;
    else if (value === false || value === "0" || value === 0) value = 0;
    else throw err("BAD_REQUEST", "stock_required ต้องเป็น 0 หรือ 1");
  } else if (key === "budget_op" || key === "budget_pp" || key === "budget_total") {
    value = typeof value === "string" ? Number(value) : value;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw err("BAD_REQUEST", "งบประมาณต้องเป็นตัวเลข ≥ 0");
  } else if (key === "deadline_day") {
    if (value === null || value === "" || value === undefined) value = null;
    else {
      value = typeof value === "string" ? Number(value) : value;
      if (!Number.isInteger(value) || value < 1 || value > 31) throw err("BAD_REQUEST", "deadline_day ต้องเป็นจำนวนเต็ม 1–31 หรือว่าง");
    }
  } else {
    throw err("BAD_REQUEST", "ไม่อนุญาตให้แก้ค่านี้: " + key);
  }
  await DB.batch([configStmt(DB, key, value), auditStmt(DB, who.email, who.role, "adminSetConfig", "", "", `${key}=${JSON.stringify(value)}`)]);
  return { config: await configResult(DB) };
}

// ---- limits ------------------------------------------------------------------------------------------------------------------------------------
const limitObj = (pcu, code, lm, ly, source, by, at) => ({ pcu, code, limit_month: lm, limit_year: ly, source, updated_by: by, updated_at: at });

export async function adminSetLimit(ctx, p) {
  const { DB, who } = ctx;
  const code = itemCodeParam(p);
  const fy = ctxFy(await getConfigAll(DB));
  await assertPcu(DB, p.pcu);
  await assertItem(DB, fy, code);
  const lm = assertLimitValue(p.limit_month), ly = assertLimitValue(p.limit_year);
  const ts = nowIso();
  await DB.batch([
    DB.prepare(`INSERT INTO limits (fy,pcu,item_code,limit_month,limit_year,source,updated_by,updated_at) VALUES (?,?,?,?,?, 'admin', ?, ?)
                ON CONFLICT(fy,pcu,item_code) DO UPDATE SET limit_month=excluded.limit_month, limit_year=excluded.limit_year, source='admin', updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .bind(fy, p.pcu, code, lm, ly, who.email, ts),
    auditStmt(DB, who.email, who.role, "adminSetLimit", p.pcu, "", `${code} month=${lm} year=${ly}`),
  ]);
  return { limit: limitObj(p.pcu, code, lm, ly, "admin", who.email, ts) };
}

// FORMAT.md rule: limit_year = plan_op+plan_pp (0 → null); limit_month = ceil(p90_m of the basis year) if > 0 else ceil(limit_year/12*2)
export function defaultLimit(planOp, planPp, p90, fy) {
  const yy = (n) => String(n % 100).padStart(2, "0");
  const sum = (planOp || 0) + (planPp || 0);
  const ly = sum > 0 ? Math.ceil(sum - 1e-9) : null;
  let lm = null, source = `plan${yy(fy)}`;
  if ((p90 || 0) > 0) { lm = Math.ceil(p90 - 1e-9); source = `stat${yy(fy - 1)}`; }
  else if (ly) lm = Math.ceil((ly / 12) * 2 - 1e-9);
  return { lm, ly, source };
}

export async function adminResetLimit(ctx, p) {
  const { DB, who } = ctx;
  const code = itemCodeParam(p);
  const fy = ctxFy(await getConfigAll(DB));
  await assertPcu(DB, p.pcu);
  await assertItem(DB, fy, code);
  const [plan, st] = await Promise.all([
    DB.prepare(`SELECT plan_op, plan_pp FROM plans WHERE fy = ? AND pcu = ? AND item_code = ?`).bind(fy, p.pcu, code).first(),
    DB.prepare(`SELECT p90_m FROM stats WHERE fy = ? AND pcu = ? AND item_code = ?`).bind(fy - 1, p.pcu, code).first(),
  ]);
  const d = defaultLimit(plan && plan.plan_op, plan && plan.plan_pp, st && st.p90_m, fy);
  const ts = nowIso();
  const stmts = [];
  if (d.lm === null && d.ly === null) stmts.push(DB.prepare(`DELETE FROM limits WHERE fy = ? AND pcu = ? AND item_code = ?`).bind(fy, p.pcu, code));
  else stmts.push(DB.prepare(`INSERT INTO limits (fy,pcu,item_code,limit_month,limit_year,source,updated_by,updated_at) VALUES (?,?,?,?,?,?, 'system', ?)
                ON CONFLICT(fy,pcu,item_code) DO UPDATE SET limit_month=excluded.limit_month, limit_year=excluded.limit_year, source=excluded.source, updated_by='system', updated_at=excluded.updated_at, note=NULL`)
      .bind(fy, p.pcu, code, d.lm, d.ly, d.source, ts));
  stmts.push(auditStmt(DB, who.email, who.role, "adminResetLimit", p.pcu, "", code));
  await DB.batch(stmts);
  return { limit: d.lm === null && d.ly === null ? null : limitObj(p.pcu, code, d.lm, d.ly, d.source, "system", ts) };
}

const blank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export async function adminLimitsUpload(ctx, p) {
  const { DB, who } = ctx;
  if (!Array.isArray(p.rows)) throw err("BAD_REQUEST", "ต้องมี rows (array)");
  if (p.rows.length > 5000) throw err("BAD_REQUEST", "จำนวนแถวมากเกินไป (สูงสุด 5000)");
  const cfgAll = await getConfigAll(DB);
  const fy = Number.isInteger(p.fy) ? p.fy : ctxFy(cfgAll);
  const mode = p.mode === "replace" ? "replace" : "merge";
  const form = await latestForm(DB, fy);
  const { results: pcuRows } = await DB.prepare(`SELECT code FROM pcus`).all();
  const pcuSet = new Set(pcuRows.map((r) => r.code));
  const { results: curRows } = await DB.prepare(`SELECT pcu, item_code, limit_month, limit_year FROM limits WHERE fy = ?`).bind(fy).all();
  const cur = new Map(curRows.map((r) => [r.pcu + "|" + r.item_code, r]));

  const errors = [], warnings = [], valid = [];
  const seen = new Map(); // key -> [indexes]
  const parseVal = (v, rowNo, field, allowClear) => {
    if (blank(v)) return { blank: true };
    if (allowClear && typeof v === "string" && v.trim().toUpperCase() === "CLEAR") return { clear: true };
    const n = typeof v === "string" ? Number(v.trim()) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { error: `${field} ต้องเป็นจำนวนเต็ม ≥ 0` };
    return { value: n };
  };
  p.rows.forEach((r, i) => {
    const rowNo = r && Number.isInteger(r.row) ? r.row : i + 2;
    if (!r || typeof r !== "object" || ["pcu_code", "item_code", "limit_month", "limit_year", "note", "item_name"].every((k) => blank(r[k]))) return; // empty row → skip
    const pcuCode = String(r.pcu_code ?? "").trim(), itemCode = String(r.item_code ?? "").trim();
    const e = (msg) => errors.push({ row: rowNo, pcu_code: pcuCode, item_code: itemCode, error: msg });
    if (!pcuSet.has(pcuCode)) return e("ไม่พบ pcu_code นี้ในระบบ");
    if (!form || !form.index.has(itemCode)) return e("ไม่พบ item_code นี้ในฟอร์มปีงบนี้");
    const key = pcuCode + "|" + itemCode;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push({ rowNo, idx: i });
    const m = parseVal(r.limit_month, rowNo, "limit_month", mode === "merge");
    const y = parseVal(r.limit_year, rowNo, "limit_year", mode === "merge");
    if (m.error) return e(m.error);
    if (y.error) return e(y.error);
    if (m.value !== undefined && y.value !== undefined && y.value < m.value) warnings.push({ row: rowNo, pcu_code: pcuCode, item_code: itemCode, warning: "limit_year น้อยกว่า limit_month" });
    if (!blank(r.item_name) && String(r.item_name).trim() !== String(form.index.get(itemCode).item.name).trim()) {
      warnings.push({ row: rowNo, pcu_code: pcuCode, item_code: itemCode, warning: "item_name ไม่ตรงกับชื่อของ item_code" });
    }
    valid.push({ idx: i, rowNo, pcu: pcuCode, code: itemCode, m, y, note: blank(r.note) ? null : String(r.note).slice(0, 500) });
  });
  // duplicates: error on every duplicated row (and drop them from the valid set)
  const dupKeys = new Set([...seen].filter(([, v]) => v.length > 1).map(([k]) => k));
  const errRows = new Set(errors.map((x) => x.row));
  for (const k of dupKeys) {
    const [pcuCode, itemCode] = k.split("|");
    for (const s of seen.get(k)) if (!errRows.has(s.rowNo)) errors.push({ row: s.rowNo, pcu_code: pcuCode, item_code: itemCode, error: "คู่ (pcu_code, item_code) ซ้ำในไฟล์" });
  }
  const todo = valid.filter((v) => !dupKeys.has(v.pcu + "|" + v.code));
  errors.sort((a, b) => a.row - b.row);

  // ---- compute the resulting rows ----
  const changes = [];
  let added = 0, updated = 0, deleted = 0;
  const final = new Map(); // key -> {pcu, code, lm, ly, note}  (rows to write)
  const removeKeys = [];   // existing pairs to delete (merge: CLEAR-ed pairs)
  const nowTs = nowIso();
  for (const v of todo) {
    const key = v.pcu + "|" + v.code;
    const old = cur.get(key) || null;
    const oldPair = old ? [old.limit_month ?? null, old.limit_year ?? null] : null;
    let lm, ly;
    if (mode === "replace") { lm = v.m.value ?? null; ly = v.y.value ?? null; }
    else {
      lm = v.m.clear ? null : v.m.blank ? (old ? old.limit_month ?? null : null) : v.m.value;
      ly = v.y.clear ? null : v.y.blank ? (old ? old.limit_year ?? null : null) : v.y.value;
    }
    if (lm === null && ly === null) {
      if (mode === "merge" && old) { removeKeys.push([v.pcu, v.code]); deleted++; changes.push({ pcu: v.pcu, item_code: v.code, old: oldPair, new: null }); }
      continue; // replace mode: pair simply is not kept (counted below)
    }
    final.set(key, { pcu: v.pcu, code: v.code, lm, ly, note: v.note });
    if (!old) { added++; changes.push({ pcu: v.pcu, item_code: v.code, old: null, new: [lm, ly] }); }
    else if (oldPair[0] !== lm || oldPair[1] !== ly) { updated++; changes.push({ pcu: v.pcu, item_code: v.code, old: oldPair, new: [lm, ly] }); }
  }
  if (mode === "replace") {
    for (const [key, old] of cur) {
      if (final.has(key)) continue;
      deleted++;
      changes.push({ pcu: old.pcu, item_code: old.item_code, old: [old.limit_month ?? null, old.limit_year ?? null], new: null });
    }
  }

  const dry = p.dry_run === true;
  const dirty = added + updated + deleted > 0;
  if (!dry && dirty) {
    const cols = ["fy", "pcu", "item_code", "limit_month", "limit_year", "source", "updated_by", "updated_at", "note"];
    const toRow = (f) => [fy, f.pcu, f.code, f.lm, f.ly, "admin", who.email, nowTs, f.note];
    const stmts = [];
    if (mode === "replace") {
      stmts.push(DB.prepare(`DELETE FROM limits WHERE fy = ?`).bind(fy));
      stmts.push(...insertStatements(DB, "limits", cols, [...final.values()].map(toRow)));
    } else {
      for (const [pcu, code] of removeKeys) stmts.push(DB.prepare(`DELETE FROM limits WHERE fy = ? AND pcu = ? AND item_code = ?`).bind(fy, pcu, code));
      const changedRows = [...final.values()].filter((f) => {
        const old = cur.get(f.pcu + "|" + f.code);
        return !old || (old.limit_month ?? null) !== f.lm || (old.limit_year ?? null) !== f.ly;
      });
      stmts.push(...insertStatements(DB, "limits", cols, changedRows.map(toRow), {
        suffix: "ON CONFLICT(fy,pcu,item_code) DO UPDATE SET limit_month=excluded.limit_month, limit_year=excluded.limit_year, source='admin', updated_by=excluded.updated_by, updated_at=excluded.updated_at, note=COALESCE(excluded.note, limits.note)",
      }));
    }
    stmts.push(auditStmt(DB, who.email, who.role, "adminLimitsUpload", "", "", `mode=${mode} fy=${fy} added=${added} updated=${updated} deleted=${deleted} errors=${errors.length}`));
    await batchChunked(DB, stmts);
  }
  return { fy, mode, errors, warnings, changes, added, updated, deleted, applied: !dry && dirty };
}

export async function adminUnlockLimit(ctx, p) {
  const { DB, who } = ctx;
  const code = itemCodeParam(p);
  await assertPcu(DB, p.pcu);
  assertMonthParam(p.month);
  await assertItem(DB, monthFy(p.month), code);
  const reason = String(p.reason ?? "").trim().slice(0, 500);
  if (!reason) throw err("BAD_REQUEST", "กรุณาระบุเหตุผลที่ปลดล็อก");
  const ts = nowIso();
  await DB.batch([
    DB.prepare(`INSERT INTO limit_unlocks (pcu,item_code,month,reason,by,at) VALUES (?,?,?,?,?,?)
                ON CONFLICT(pcu,item_code,month) DO UPDATE SET reason=excluded.reason, by=excluded.by, at=excluded.at`).bind(p.pcu, code, p.month, reason, who.email, ts),
    auditStmt(DB, who.email, who.role, "adminUnlockLimit", p.pcu, p.month, `${code}: ${reason}`),
  ]);
  return { unlock: { pcu: p.pcu, item_code: code, month: p.month, reason, by: who.email, at: ts } };
}

export async function adminRemoveUnlock(ctx, p) {
  const { DB, who } = ctx;
  const code = itemCodeParam(p);
  assertMonthParam(p.month);
  const res = await DB.batch([
    DB.prepare(`DELETE FROM limit_unlocks WHERE pcu = ? AND item_code = ? AND month = ?`).bind(String(p.pcu || ""), String(code || ""), p.month),
    auditStmt(DB, who.email, who.role, "adminRemoveUnlock", p.pcu, p.month, String(code)),
  ]);
  if (!res[0].meta.changes) throw err("NOT_FOUND", "ไม่พบรายการที่ปลดล็อก");
  return { ok: true };
}

// ---- PIN / hidden --------------------------------------------------------------------------------------------------------------------------
export async function adminSetPin(ctx, p) {
  const { DB, who } = ctx;
  await assertPcu(DB, p.pcu);
  const pin = String(p.pin ?? "");
  if (!new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin)) throw err("BAD_REQUEST", "PIN ต้องเป็นเลข 5 หลัก");
  const salt = newSalt();
  await DB.batch([
    DB.prepare(`UPDATE pcus SET pin_hash = ?, pin_salt = ?, pin_version = COALESCE(pin_version,1) + 1, pin_fail = 0, pin_locked_until = NULL, pin_custom = 1 WHERE code = ?`)
      .bind(await hashSecret(pin, salt), salt, p.pcu),
    auditStmt(DB, who.email, who.role, "adminSetPin", p.pcu, "", ""),
  ]);
  return { ok: true };
}

export async function adminUnlockPin(ctx, p) {
  const { DB, who } = ctx;
  await assertPcu(DB, p.pcu);
  await DB.batch([
    DB.prepare(`UPDATE pcus SET pin_fail = 0, pin_locked_until = NULL WHERE code = ?`).bind(p.pcu),
    auditStmt(DB, who.email, who.role, "adminUnlockPin", p.pcu, "", ""),
  ]);
  return { ok: true };
}

export async function adminSetHidden(ctx, p) {
  const { DB, who } = ctx;
  await assertPcu(DB, p.pcu);
  const codes = Array.isArray(p.codes) ? p.codes : [];
  const form = await latestForm(DB, ctxFy(await getConfigAll(DB)));
  for (const c of codes) if (!isStr(c) || !form || !form.index.has(c)) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + c);
  const uniq = [...new Set(codes)];
  const ts = nowIso();
  await batchChunked(DB, [
    DB.prepare(`DELETE FROM hidden_items WHERE pcu = ?`).bind(p.pcu),
    ...insertStatements(DB, "hidden_items", ["pcu", "item_code", "hidden_at", "by"], uniq.map((c) => [p.pcu, c, ts, who.email])),
    auditStmt(DB, who.email, who.role, "adminSetHidden", p.pcu, "", `count=${uniq.length}`),
  ]);
  return { hidden: uniq };
}

export async function adminSetBackupPassword(ctx, p) {
  const { DB, who } = ctx;
  if (who.backup) throw err("FORBIDDEN", "ต้อง Sign in with Google เท่านั้น");
  const password = String(p.password ?? "");
  if (password.length < 8) throw err("BAD_REQUEST", "รหัสผ่านสำรองต้องยาวอย่างน้อย 8 ตัวอักษร");
  const cfg = await getConfigAll(DB);
  const salt = newSalt();
  await DB.batch([
    configStmt(DB, "backup_pw_salt", salt), configStmt(DB, "backup_pw_hash", await hashSecret(password, salt)),
    configStmt(DB, "backup_version", (Number(cfg.backup_version) || 0) + 1), configStmt(DB, "backup_fail", 0), configStmt(DB, "backup_locked_until", ""),
    auditStmt(DB, who.email, who.role, "adminSetBackupPassword", "", "", ""),
  ]);
  return { ok: true };
}

// ---- maintenance ---------------------------------------------------------------------------------------------------------------------------------
export async function adminClearTrial(ctx, p) {
  const { DB, env, who } = ctx;
  if (p.confirm !== "ล้างข้อมูล") throw err("BAD_REQUEST", 'พิมพ์คำว่า "ล้างข้อมูล" เพื่อยืนยัน');
  const { results: pdfs } = await DB.prepare(`SELECT r2_key FROM pdf_files`).all();
  const res = await DB.batch([
    DB.prepare(`DELETE FROM request_lines`), DB.prepare(`DELETE FROM issue_status`), DB.prepare(`DELETE FROM pdf_files`), DB.prepare(`DELETE FROM requests`),
  ]);
  const out = {
    deleted_lines: res[0].meta.changes, deleted_issue_status: res[1].meta.changes,
    deleted_pdf_files: res[2].meta.changes, deleted_requests: res[3].meta.changes,
  };
  if (env.FILES && pdfs.length) {
    try { await env.FILES.delete(pdfs.map((r) => r.r2_key).filter(Boolean)); } catch (e) { console.error("clearTrial r2", e); }
  }
  await DB.batch([auditStmt(DB, who.email, who.role, "adminClearTrial", "", "", JSON.stringify(out))]);
  return out;
}

export async function adminBackupNow(ctx) {
  const { DB, env, who } = ctx;
  const r = await runBackup(env);
  await DB.batch([auditStmt(DB, who.email, who.role, "adminBackupNow", "", "", `${r.key} ${r.size}B`)]);
  return r;
}

export async function adminAuditLog(ctx, p) {
  const { DB } = ctx;
  let limit = Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 100;
  limit = Math.min(limit, 500);
  const before = Number.isInteger(p.before) ? p.before : null;
  const { results } = before !== null
    ? await DB.prepare(`SELECT id,ts,actor,role,action,pcu,month,detail FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?`).bind(before, limit).all()
    : await DB.prepare(`SELECT id,ts,actor,role,action,pcu,month,detail FROM audit_log ORDER BY id DESC LIMIT ?`).bind(limit).all();
  return { entries: results, next_before: results.length === limit ? results[results.length - 1].id : null };
}
