// notices.js — 2ae: per-item stock flags ("ของหมด" / "รอจัดซื้อ") + admin announcements on the PCU home page (functions/API.md §5.7).
// Flags: set / cleared by admin or a dispenser (dispenser = only items whose page belongs to one of its dispense units, like issue.js) ·
// never block ordering · cleared by hand only. Announcements: admin only. The PCU reads both inside pcuBootstrap (pcuNotices below).
// D1 writes: only when something changed — one row upsert / delete + 1 audit row.
import { err, isStr } from "./http.js";
import { auditStmt, getConfigAll, latestForm, publicConfig } from "./db.js";
import { bangkokDate, currentRound, isDate, isMonth, monthFy, monthMinus, nowIso } from "./time.js";
import { unitOfCode } from "./views.js";

export const FLAG_STATUSES = ["out", "pending"];
export const NOTICE_LIMITS = { flag_note: 200, text: 1000, announcements_live: 10 };
const L = NOTICE_LIMITS;
const actorOf = (who) => (who.backup ? "backup" : who.email);

// ---- PCU side (rides in pcuBootstrap) --------------------------------------------------------------------------------------
// item_flags = {code: {status, note, eta}} · announcements = active + not expired (expires_at >= today in Bangkok), newest first.
// 2ai: item_locks = {code: {from_month, note, banner}} — locks that apply to this PCU (its exemptions left out) · banner = still inside the
// home-page notice window (from setting the lock until LOCK_BANNER_ROUNDS rounds from from_month).
export const LOCK_BANNER_ROUNDS = 3;
export async function pcuNotices(DB, pcu) {
  const [fr, ar, lr] = await Promise.all([
    DB.prepare(`SELECT item_code, status, note, eta FROM item_flags`).all(),
    DB.prepare(`SELECT id, text, expires_at, updated_at FROM announcements WHERE active = 1 AND (expires_at IS NULL OR expires_at >= ?) ORDER BY id DESC LIMIT ?`)
      .bind(bangkokDate(), L.announcements_live).all(),
    DB.prepare(`SELECT item_code, from_month, note FROM item_locks
      WHERE item_code NOT IN (SELECT item_code FROM item_lock_exempt WHERE pcu = ?)`).bind(String(pcu || "")).all(),
  ]);
  const item_flags = {};
  for (const r of fr.results) item_flags[r.item_code] = { status: r.status, note: r.note || null, eta: r.eta || null };
  const cur = currentRound();
  const item_locks = {};
  for (const r of lr.results) {
    item_locks[r.item_code] = { from_month: r.from_month, note: r.note || null, banner: cur <= monthMinus(r.from_month, -(LOCK_BANNER_ROUNDS - 1)) };
  }
  return { item_flags, item_locks, announcements: ar.results.map((r) => ({ id: r.id, text: r.text, expires_at: r.expires_at || null, updated_at: r.updated_at })) };
}

// ---- item flags (staff) -------------------------------------------------------------------------------------------------------
const flagObj = (r) => ({ code: r.item_code, status: r.status, note: r.note || null, eta: r.eta || null, set_by: r.set_by || null, set_at: r.set_at || null });

// The dispense unit of `code` in the latest form of fy_current (null = not on that form). A dispenser may only touch its own units.
async function assertFlagScope(ctx, code) {
  const { DB, who } = ctx;
  if (!isStr(code) || !code || code.length > 40) throw err("BAD_REQUEST", "ต้องระบุรหัสรายการ (code)");
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentRound()));
  const unit = unitOfCode(await latestForm(DB, cfg.fy_current), code);
  if (who.role === "dispenser") {
    if (!unit) throw err("FORBIDDEN", "ไม่พบรายการนี้ในหน่วยจ่ายของบัญชีนี้");
    if (!who.units.includes(unit)) throw err("FORBIDDEN", `รายการนี้เป็นของหน่วย "${unit}" — ตั้งป้ายได้เฉพาะรายการของหน่วยจ่ายตัวเอง`);
  }
  return unit;
}

export async function itemFlagList(ctx) {
  const rows = (await ctx.DB.prepare(`SELECT * FROM item_flags ORDER BY set_at DESC`).all()).results;
  return { flags: rows.map(flagObj) };
}

// {code, status:"out"|"pending", note?, eta? ("YYYY-MM-DD" or null)} → {flag, changed}
export async function itemFlagSet(ctx, p) {
  const { DB, who } = ctx;
  const code = p.code;
  if (!FLAG_STATUSES.includes(p.status)) throw err("BAD_REQUEST", 'สถานะต้องเป็น "out" (ของหมด) หรือ "pending" (รอจัดซื้อ)');
  if (p.note !== undefined && p.note !== null && !isStr(p.note)) throw err("BAD_REQUEST", "หมายเหตุต้องเป็นข้อความ");
  const note = isStr(p.note) ? p.note.trim() : "";
  if (note.length > L.flag_note) throw err("BAD_REQUEST", `หมายเหตุยาวเกิน ${L.flag_note} ตัวอักษร`);
  let eta = null;
  if (p.eta !== undefined && p.eta !== null && p.eta !== "") {
    if (!isDate(p.eta)) throw err("BAD_REQUEST", "วันที่คาดว่าจะมีของต้องเป็น YYYY-MM-DD");
    eta = p.eta;
  }
  const unit = await assertFlagScope(ctx, code);
  if (!unit) throw err("NOT_FOUND", "ไม่พบรายการนี้ในแบบฟอร์มปีงบปัจจุบัน");
  const cur = await DB.prepare(`SELECT * FROM item_flags WHERE item_code = ?`).bind(code).first();
  if (cur && cur.status === p.status && (cur.note || "") === note && (cur.eta || null) === eta) return { flag: flagObj(cur), changed: false };
  const now = nowIso(), actor = actorOf(who);
  await DB.batch([
    DB.prepare(
      `INSERT INTO item_flags (item_code, status, note, eta, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_code) DO UPDATE SET status = excluded.status, note = excluded.note, eta = excluded.eta, set_by = excluded.set_by, set_at = excluded.set_at`
    ).bind(code, p.status, note || null, eta, actor, now),
    auditStmt(DB, actor, who.role, "itemFlagSet", "", "", `${code}=${p.status}${eta ? " eta " + eta : ""}${note ? " · " + note.slice(0, 80) : ""}`),
  ]);
  return { flag: { code, status: p.status, note: note || null, eta, set_by: actor, set_at: now }, changed: true };
}

// {code} → {ok, changed}. Admin may clear any code (also one that left the form); a dispenser only items of its units.
export async function itemFlagClear(ctx, p) {
  const { DB, who } = ctx;
  await assertFlagScope(ctx, p.code);
  const cur = await DB.prepare(`SELECT item_code FROM item_flags WHERE item_code = ?`).bind(p.code).first();
  if (!cur) return { ok: true, changed: false };
  const actor = actorOf(who);
  await DB.batch([
    DB.prepare(`DELETE FROM item_flags WHERE item_code = ?`).bind(p.code),
    auditStmt(DB, actor, who.role, "itemFlagClear", "", "", p.code),
  ]);
  return { ok: true, changed: true };
}

// ---- announcements (admin) ----------------------------------------------------------------------------------------------------
const annObj = (r, today) => ({
  id: r.id, text: r.text, expires_at: r.expires_at || null, active: !!r.active,
  live: !!r.active && (!r.expires_at || r.expires_at >= today),
  created_by: r.created_by || null, created_at: r.created_at || null, updated_by: r.updated_by || null, updated_at: r.updated_at || null,
});

export async function adminAnnouncementList(ctx) {
  const rows = (await ctx.DB.prepare(`SELECT * FROM announcements ORDER BY id DESC LIMIT 200`).all()).results;
  const today = bangkokDate();
  return { announcements: rows.map((r) => annObj(r, today)), today };
}

// {id?, text, expires_at? ("YYYY-MM-DD" | null), active? (default true)} → {announcement}
export async function adminAnnouncementSave(ctx, p) {
  const { DB, who } = ctx;
  const text = isStr(p.text) ? p.text.trim() : "";
  if (!text || text.length > L.text) throw err("BAD_REQUEST", `ข้อความประกาศต้องยาว 1–${L.text.toLocaleString("en-US")} ตัวอักษร`);
  let expires = null;
  if (p.expires_at !== undefined && p.expires_at !== null && p.expires_at !== "") {
    if (!isDate(p.expires_at)) throw err("BAD_REQUEST", "วันหมดอายุต้องเป็น YYYY-MM-DD");
    expires = p.expires_at;
  }
  if (p.active !== undefined && typeof p.active !== "boolean") throw err("BAD_REQUEST", "active ต้องเป็น true/false");
  const active = p.active === false ? 0 : 1;
  const now = nowIso(), actor = actorOf(who), today = bangkokDate();

  if (p.id === undefined || p.id === null) {
    const row = await DB.prepare(
      `INSERT INTO announcements (text, expires_at, active, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(text, expires, active, actor, now, actor, now).first();
    await auditStmt(DB, actor, who.role, "adminAnnouncementSave", "", "", `new #${row.id} ${text.slice(0, 80)}`).run();
    return { announcement: annObj(row, today) };
  }
  if (!Number.isInteger(p.id)) throw err("BAD_REQUEST", "id ต้องเป็นจำนวนเต็ม");
  const cur = await DB.prepare(`SELECT * FROM announcements WHERE id = ?`).bind(p.id).first();
  if (!cur) throw err("NOT_FOUND", "ไม่พบประกาศนี้");
  // `active` not sent on an edit = keep the stored value
  const vals = { text, expires_at: expires, active: p.active === undefined ? cur.active : active };
  const changed = Object.keys(vals).filter((k) => (cur[k] ?? null) !== (vals[k] ?? null));
  if (!changed.length) return { announcement: annObj(cur, today) };
  await DB.batch([
    DB.prepare(`UPDATE announcements SET ${changed.map((k) => `${k} = ?`).join(", ")}, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(...changed.map((k) => vals[k]), actor, now, p.id),
    auditStmt(DB, actor, who.role, "adminAnnouncementSave", "", "", `#${p.id} ${changed.join(",")}`),
  ]);
  return { announcement: annObj(await DB.prepare(`SELECT * FROM announcements WHERE id = ?`).bind(p.id).first(), today) };
}

export async function adminAnnouncementDelete(ctx, p) {
  const { DB, who } = ctx;
  if (!Number.isInteger(p.id)) throw err("BAD_REQUEST", "id ต้องเป็นจำนวนเต็ม");
  const cur = await DB.prepare(`SELECT id, text FROM announcements WHERE id = ?`).bind(p.id).first();
  if (!cur) throw err("NOT_FOUND", "ไม่พบประกาศนี้");
  const actor = actorOf(who);
  await DB.batch([
    DB.prepare(`DELETE FROM announcements WHERE id = ?`).bind(p.id),
    auditStmt(DB, actor, who.role, "adminAnnouncementDelete", "", "", `#${p.id} ${String(cur.text).slice(0, 80)}`),
  ]);
  return { ok: true };
}

// ---- item locks (admin, 2ai) ----------------------------------------------------------------------------------------------------
// Codes whose requested qty `pcu` may not raise in round `month` (lock from_month <= month, no exemption for that pcu).
export async function lockedCodes(DB, pcu, month) {
  const { results } = await DB.prepare(`SELECT item_code FROM item_locks WHERE from_month <= ?
    AND item_code NOT IN (SELECT item_code FROM item_lock_exempt WHERE pcu = ?)`).bind(month, pcu).all();
  return new Set(results.map((r) => r.item_code));
}

const lockObj = (r, ex) => ({ code: r.item_code, from_month: r.from_month, note: r.note || null, set_by: r.set_by || null, set_at: r.set_at || null,
  exempt: ex.filter((e) => e.item_code === r.item_code).map((e) => ({ pcu: e.pcu, set_by: e.set_by || null, set_at: e.set_at || null })) });

export async function adminItemLockList(ctx) {
  const { DB } = ctx;
  const [lr, er] = await Promise.all([
    DB.prepare(`SELECT * FROM item_locks ORDER BY set_at DESC`).all(),
    DB.prepare(`SELECT * FROM item_lock_exempt ORDER BY pcu`).all(),
  ]);
  return { locks: lr.results.map((r) => lockObj(r, er.results)), current_round: currentRound(), banner_rounds: LOCK_BANNER_ROUNDS };
}

// {code, from_month:"YYYY-MM", note?} → {lock, changed}. The code must be on the latest form of fy_current.
export async function adminItemLockSet(ctx, p) {
  const { DB, who } = ctx;
  const code = p.code;
  if (!isStr(code) || !code || code.length > 40) throw err("BAD_REQUEST", "ต้องระบุรหัสรายการ (code)");
  if (!isMonth(p.from_month)) throw err("BAD_REQUEST", "รอบเริ่มล็อกต้องเป็น YYYY-MM");
  if (p.note !== undefined && p.note !== null && !isStr(p.note)) throw err("BAD_REQUEST", "หมายเหตุต้องเป็นข้อความ");
  const note = isStr(p.note) ? p.note.trim() : "";
  if (note.length > L.flag_note) throw err("BAD_REQUEST", `หมายเหตุยาวเกิน ${L.flag_note} ตัวอักษร`);
  const cfg = publicConfig(await getConfigAll(DB), monthFy(currentRound()));
  if (!unitOfCode(await latestForm(DB, cfg.fy_current), code)) throw err("NOT_FOUND", "ไม่พบรายการนี้ในแบบฟอร์มปีงบปัจจุบัน");
  const cur = await DB.prepare(`SELECT * FROM item_locks WHERE item_code = ?`).bind(code).first();
  if (cur && cur.from_month === p.from_month && (cur.note || "") === note) return { lock: lockObj(cur, []), changed: false };
  const now = nowIso(), actor = actorOf(who);
  await DB.batch([
    DB.prepare(`INSERT INTO item_locks (item_code, from_month, note, set_by, set_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_code) DO UPDATE SET from_month = excluded.from_month, note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at`)
      .bind(code, p.from_month, note || null, actor, now),
    auditStmt(DB, actor, who.role, "adminItemLockSet", "", p.from_month, `${code}${note ? " · " + note.slice(0, 80) : ""}`),
  ]);
  return { lock: { code, from_month: p.from_month, note: note || null, set_by: actor, set_at: now, exempt: [] }, changed: true };
}

// {code} → {ok, changed} — removes the lock and its per-PCU exemptions.
export async function adminItemLockClear(ctx, p) {
  const { DB, who } = ctx;
  if (!isStr(p.code) || !p.code) throw err("BAD_REQUEST", "ต้องระบุรหัสรายการ (code)");
  const cur = await DB.prepare(`SELECT item_code FROM item_locks WHERE item_code = ?`).bind(p.code).first();
  if (!cur) return { ok: true, changed: false };
  const actor = actorOf(who);
  await DB.batch([
    DB.prepare(`DELETE FROM item_locks WHERE item_code = ?`).bind(p.code),
    DB.prepare(`DELETE FROM item_lock_exempt WHERE item_code = ?`).bind(p.code),
    auditStmt(DB, actor, who.role, "adminItemLockClear", "", "", p.code),
  ]);
  return { ok: true, changed: true };
}

// {code, pcu, exempt:bool} → {ok, changed} — release (true) / take back (false) the lock for one PCU; kept until taken back.
export async function adminItemLockExempt(ctx, p) {
  const { DB, who } = ctx;
  if (typeof p.exempt !== "boolean") throw err("BAD_REQUEST", "exempt ต้องเป็น true/false");
  if (!isStr(p.code) || !p.code) throw err("BAD_REQUEST", "ต้องระบุรหัสรายการ (code)");
  const [lock, pcuRow, cur] = await Promise.all([
    DB.prepare(`SELECT item_code FROM item_locks WHERE item_code = ?`).bind(p.code).first(),
    DB.prepare(`SELECT code FROM pcus WHERE code = ?`).bind(String(p.pcu || "")).first(),
    DB.prepare(`SELECT pcu FROM item_lock_exempt WHERE item_code = ? AND pcu = ?`).bind(p.code, String(p.pcu || "")).first(),
  ]);
  if (!lock) throw err("NOT_FOUND", "รายการนี้ไม่ได้ล็อกอยู่");
  if (!pcuRow) throw err("NOT_FOUND", "ไม่พบ รพ.สต. นี้");
  if (!!cur === p.exempt) return { ok: true, changed: false };
  const actor = actorOf(who);
  await DB.batch([
    p.exempt
      ? DB.prepare(`INSERT INTO item_lock_exempt (item_code, pcu, set_by, set_at) VALUES (?, ?, ?, ?)`).bind(p.code, p.pcu, actor, nowIso())
      : DB.prepare(`DELETE FROM item_lock_exempt WHERE item_code = ? AND pcu = ?`).bind(p.code, p.pcu),
    auditStmt(DB, actor, who.role, "adminItemLockExempt", p.pcu, "", `${p.code}=${p.exempt ? "ปลด" : "ล็อกคืน"}`),
  ]);
  return { ok: true, changed: true };
}
