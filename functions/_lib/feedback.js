// feedback.js — feedback + FAQ (2ab, functions/API.md §4.3 / §5.6). feedbackSend / faqList are public but read a token when one is
// sent (a bad token = guest, never an error) · feedbackMine = pcu or staff · admin* = admin only (router).
// D1 writes: feedbackSend = exactly 1 INSERT (no audit, like autosave; the rate limits count the feedback table itself) ·
// admin writes only when something changed, + 1 audit row.
import { ApiError, err, isStr, jparse } from "./http.js";
import { auditStmt } from "./db.js";
import { hmacHex, requirePcu, requireStaff, verifyToken } from "./auth.js";
import { bangkokDate, nowIso } from "./time.js";

export const FEEDBACK_CATEGORIES = ["entry", "dashboard", "other"]; // 2ah: "wording" dropped for new feedback
export const FEEDBACK_FILTER_CATEGORIES = ["wording", ...FEEDBACK_CATEGORIES]; // old rows keep category 'wording' (admin list / filter / CSV)
export const FEEDBACK_STATUSES = ["new", "ack", "fixed"];
export const FEEDBACK_ROLES = ["pcu", "dispenser", "admin", "guest"];
export const FAQ_AUDIENCES = ["pcu", "dispenser", "admin"];
export const FEEDBACK_LIMITS = { body: 2000, body_guest: 1000, per_day: 20, per_day_guest: 5, per_day_no_identity: 100, reply: 2000, context_bytes: 2048 };
const L = FEEDBACK_LIMITS;

// ---- who is calling ------------------------------------------------------------------------------------------------------
// {role:"pcu", pcu} · {role:"admin"|"dispenser", email} · {role:"guest"}. strict=false: no / bad / expired token → guest.
async function identify(ctx, token, strict) {
  const { env, DB } = ctx;
  if (!token) {
    if (strict) throw err("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบ");
    return { role: "guest" };
  }
  try {
    const payload = await verifyToken(env, token);
    if (payload.t === "pcu") return { role: "pcu", pcu: (await requirePcu(env, DB, token)).code };
    const who = await requireStaff(env, DB, token, ["admin", "dispenser"]);
    return { role: who.role, email: who.email };
  } catch (e) {
    if (strict || !(e instanceof ApiError)) throw e;
    return { role: "guest" };
  }
}

// context: plain object, kept field by field while the JSON stays ≤ 2 KB (a field that does not fit is dropped, never an error)
const utf8Len = (s) => new TextEncoder().encode(s).length;
function trimContext(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const out = {};
  let size = 2;
  for (const k of Object.keys(c).slice(0, 40)) {
    const v = c[k];
    if (v === undefined || typeof v === "function" || k.length > 40) continue;
    let piece;
    try { piece = JSON.stringify(k) + ":" + JSON.stringify(v); } catch { continue; }
    if (piece === undefined) continue;
    const add = utf8Len(piece) + (size > 2 ? 1 : 0);
    if (size + add > L.context_bytes) continue;
    out[k] = v;
    size += add;
  }
  return Object.keys(out).length ? out : null;
}

const limitErr = (limit) => err("RATE_LIMITED", `ส่งความคิดเห็นครบ ${limit} ครั้งของวันนี้แล้ว — ส่งเพิ่มได้พรุ่งนี้`, { limit });

// ---- feedbackSend -----------------------------------------------------------------------------------------------------------
export async function feedbackSend(ctx, p) {
  const { env, DB } = ctx;
  const me = await identify(ctx, p.token, false);
  const category = p.category;
  if (!FEEDBACK_CATEGORIES.includes(category)) throw err("BAD_REQUEST", "หมวดไม่ถูกต้อง");
  if (!isStr(p.body)) throw err("BAD_REQUEST", "กรุณาพิมพ์ข้อความ");
  const body = p.body.trim();
  const maxBody = me.role === "guest" ? L.body_guest : L.body;
  if (!body) throw err("BAD_REQUEST", "กรุณาพิมพ์ข้อความ");
  if (body.length > maxBody) throw err("BAD_REQUEST", `ข้อความยาวเกิน ${maxBody.toLocaleString("en-US")} ตัวอักษร`);

  const anonymous = me.role === "pcu" && p.anonymous === true;
  const noIdentity = me.role === "guest" || anonymous;
  let device = null;
  if (noIdentity) {
    if (!isStr(p.device) || p.device.length < 8 || p.device.length > 64) throw err("BAD_REQUEST", "ไม่พบรหัสเครื่อง (device)");
    device = p.device;
  }
  let pcu = null;
  if (me.role === "pcu" && !anonymous) pcu = me.pcu;
  if (me.role === "guest" && isStr(p.pcu) && p.pcu) {
    const row = await DB.prepare(`SELECT code FROM pcus WHERE code = ?`).bind(p.pcu).first();
    pcu = row ? row.code : null;
  }
  const email = me.role === "admin" || me.role === "dispenser" ? me.email : null;
  const day = bangkokDate();
  const rateKey = noIdentity ? await hmacHex(env, "dev:" + device + ":" + day) : null;

  // one read: this sender's count today + today's count of rows without an identity (guest + anonymous)
  let ownSql, ownBind, limit;
  if (noIdentity) { ownSql = `rate_key = ?2 AND role = ?3`; ownBind = [rateKey, me.role]; limit = me.role === "guest" ? L.per_day_guest : L.per_day; }
  else if (me.role === "pcu") { ownSql = `role = 'pcu' AND pcu = ?2`; ownBind = [pcu]; limit = L.per_day; }
  else { ownSql = `role IN ('admin','dispenser') AND email = ?2`; ownBind = [email]; limit = L.per_day; }
  const cnt = await DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN ${ownSql} THEN 1 ELSE 0 END), 0) AS own,
            COALESCE(SUM(CASE WHEN role = 'guest' OR (role = 'pcu' AND pcu IS NULL) THEN 1 ELSE 0 END), 0) AS anon
       FROM feedback WHERE day = ?1`
  ).bind(day, ...ownBind).first();
  const own = Number(cnt.own) || 0;
  if (own >= limit) throw limitErr(limit);
  if (noIdentity && Number(cnt.anon) >= L.per_day_no_identity) throw limitErr(L.per_day_no_identity);

  const context = trimContext(p.context);
  const row = await DB.prepare(
    `INSERT INTO feedback (created_at, day, role, pcu, email, anonymous, category, body, context, rate_key, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new') RETURNING id`
  ).bind(nowIso(), day, me.role, pcu, email, anonymous ? 1 : 0, category, body, context ? JSON.stringify(context) : null, rateKey).first();
  return { id: row.id, remaining_today: Math.max(0, limit - own - 1) };
}

// ---- feedbackMine (pcu: named rows of the unit · staff: rows of the email) ------------------------------------------------------
export async function feedbackMine(ctx, p) {
  const me = await identify(ctx, p.token, true);
  const cols = `id, created_at, category, body, status, reply, reply_at`;
  const stmt = me.role === "pcu"
    ? ctx.DB.prepare(`SELECT ${cols} FROM feedback WHERE role = 'pcu' AND pcu = ? AND anonymous = 0 ORDER BY id DESC LIMIT 200`).bind(me.pcu)
    : ctx.DB.prepare(`SELECT ${cols} FROM feedback WHERE role IN ('admin','dispenser') AND email = ? ORDER BY id DESC LIMIT 200`).bind(me.email);
  return { items: (await stmt.all()).results };
}

// ---- FAQ ---------------------------------------------------------------------------------------------------------------------------
const audOf = (r) => FAQ_AUDIENCES.filter((a) => Number(r["aud_" + a]) === 1);
function faqObj(r, full) {
  const o = { id: r.id, question: r.question, answer: r.answer, category: r.category || null, sort: Number(r.sort) || 0, aud: audOf(r) };
  if (full) Object.assign(o, {
    hidden: Number(r.hidden) === 1, from_feedback_id: r.from_feedback_id ?? null,
    created_at: r.created_at, created_by: r.created_by, updated_at: r.updated_at, updated_by: r.updated_by,
  });
  return o;
}
const FAQ_ORDER = `ORDER BY COALESCE(category, ''), sort, id`;

export async function faqList(ctx, p) {
  const me = await identify(ctx, p.token, false);
  if (me.role === "admin" && p.all === true) {
    const { results } = await ctx.DB.prepare(`SELECT * FROM faq ${FAQ_ORDER}`).all();
    return { faqs: results.map((r) => faqObj(r, true)) };
  }
  const col = me.role === "admin" ? "aud_admin" : me.role === "dispenser" ? "aud_dispenser" : "aud_pcu";
  const { results } = await ctx.DB.prepare(`SELECT * FROM faq WHERE ${col} = 1 AND hidden = 0 ${FAQ_ORDER}`).all();
  return { faqs: results.map((r) => faqObj(r, false)) };
}

// ---- admin: feedback review ---------------------------------------------------------------------------------------------------------
function feedbackObj(r) {
  return {
    id: r.id, created_at: r.created_at, day: r.day, role: r.role, pcu: r.pcu ?? null, email: r.email ?? null, anonymous: Number(r.anonymous) === 1,
    category: r.category, body: r.body, context: jparse(r.context, null),
    status: r.status, status_at: r.status_at ?? null, status_by: r.status_by ?? null,
    reply: r.reply ?? null, reply_at: r.reply_at ?? null, reply_by: r.reply_by ?? null,
  };
}
const FB_COLS = `id, created_at, day, role, pcu, email, anonymous, category, body, context, status, status_at, status_by, reply, reply_at, reply_by`;

function enumParam(v, list, name) {
  if (v === undefined || v === null || v === "") return null;
  if (!list.includes(v)) throw err("BAD_REQUEST", `${name} ไม่ถูกต้อง`);
  return v;
}

export async function adminFeedbackList(ctx, p) {
  const { DB } = ctx;
  const where = [], bind = [];
  const role = enumParam(p.role, FEEDBACK_ROLES, "role");
  const category = enumParam(p.category, FEEDBACK_FILTER_CATEGORIES, "category");
  const status = enumParam(p.status, FEEDBACK_STATUSES, "status");
  if (role) { where.push(`role = ?`); bind.push(role); }
  if (category) { where.push(`category = ?`); bind.push(category); }
  if (status) { where.push(`status = ?`); bind.push(status); }
  if (p.pcu !== undefined && p.pcu !== null && p.pcu !== "") {
    if (!isStr(p.pcu)) throw err("BAD_REQUEST", "pcu ไม่ถูกต้อง");
    where.push(`pcu = ?`); bind.push(p.pcu);
  }
  if (p.before !== undefined && p.before !== null) {
    if (!Number.isInteger(p.before)) throw err("BAD_REQUEST", "before ต้องเป็นจำนวนเต็ม");
    where.push(`id < ?`); bind.push(p.before);
  }
  let limit = Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 100;
  limit = Math.min(limit, 1000);
  const sql = `SELECT ${FB_COLS} FROM feedback ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  const [list, counts] = await Promise.all([
    DB.prepare(sql).bind(...bind, limit).all(),
    DB.prepare(`SELECT status, COUNT(*) AS n FROM feedback GROUP BY status`).all(),
  ]);
  const c = { new: 0, ack: 0, fixed: 0 };
  for (const r of counts.results) if (r.status in c) c[r.status] = Number(r.n) || 0;
  const items = list.results.map(feedbackObj);
  return { items, next_before: items.length === limit ? items[items.length - 1].id : null, counts: c };
}

export const feedbackNewCount = async (DB) => Number((await DB.prepare(`SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'`).first()).n) || 0;

const actorOf = (who) => (who.backup ? "backup" : who.email);

export async function adminFeedbackUpdate(ctx, p) {
  const { DB, who } = ctx;
  if (!Number.isInteger(p.id)) throw err("BAD_REQUEST", "id ต้องเป็นจำนวนเต็ม");
  const row = await DB.prepare(`SELECT ${FB_COLS} FROM feedback WHERE id = ?`).bind(p.id).first();
  if (!row) throw err("NOT_FOUND", "ไม่พบ feedback นี้");
  const status = p.status === undefined ? row.status : enumParam(p.status, FEEDBACK_STATUSES, "status") || row.status;
  let reply = row.reply ?? null;
  if (p.reply !== undefined) {
    if (p.reply !== null && !isStr(p.reply)) throw err("BAD_REQUEST", "คำตอบไม่ถูกต้อง");
    const t = (p.reply || "").trim();
    if (t.length > L.reply) throw err("BAD_REQUEST", `คำตอบยาวเกิน ${L.reply.toLocaleString("en-US")} ตัวอักษร`);
    if (t && Number(row.anonymous) === 1) throw err("BAD_REQUEST", "feedback นิรนามตอบกลับรายคนไม่ได้ — ตอบผ่าน FAQ แทน");
    reply = t || null;
  }
  const sets = [], bind = [], changes = [];
  const now = nowIso(), actor = actorOf(who);
  if (status !== row.status) { sets.push(`status = ?`, `status_at = ?`, `status_by = ?`); bind.push(status, now, actor); changes.push(`status ${row.status}→${status}`); }
  if (reply !== (row.reply ?? null)) {
    sets.push(`reply = ?`, `reply_at = ?`, `reply_by = ?`);
    bind.push(reply, reply ? now : null, reply ? actor : null);
    changes.push(reply ? "reply" : "reply cleared");
  }
  if (!sets.length) return { item: feedbackObj(row) };
  await DB.batch([
    DB.prepare(`UPDATE feedback SET ${sets.join(", ")} WHERE id = ?`).bind(...bind, p.id),
    auditStmt(DB, actor, who.role, "adminFeedbackUpdate", row.pcu, "", `#${p.id} ${changes.join(", ")}`),
  ]);
  return { item: feedbackObj(await DB.prepare(`SELECT ${FB_COLS} FROM feedback WHERE id = ?`).bind(p.id).first()) };
}

// ---- admin: FAQ editor -------------------------------------------------------------------------------------------------------------
export async function adminFaqSave(ctx, p) {
  const { DB, who } = ctx;
  const question = isStr(p.question) ? p.question.trim() : "";
  const answer = isStr(p.answer) ? p.answer.trim() : "";
  if (!question || question.length > 300) throw err("BAD_REQUEST", "คำถามต้องยาว 1–300 ตัวอักษร");
  if (!answer || answer.length > 5000) throw err("BAD_REQUEST", "คำตอบต้องยาว 1–5,000 ตัวอักษร");
  if (!Array.isArray(p.aud) || !p.aud.length || p.aud.some((a) => !FAQ_AUDIENCES.includes(a))) throw err("BAD_REQUEST", "เลือกกลุ่มผู้อ่านอย่างน้อย 1 กลุ่ม");
  let category = null;
  if (p.category !== undefined && p.category !== null) {
    if (!isStr(p.category)) throw err("BAD_REQUEST", "หมวดไม่ถูกต้อง");
    category = p.category.trim() || null;
    if (category && category.length > 60) throw err("BAD_REQUEST", "หมวดยาวเกิน 60 ตัวอักษร");
  }
  let sort = 0;
  if (p.sort !== undefined && p.sort !== null && p.sort !== "") {
    sort = Number(p.sort);
    if (!Number.isInteger(sort) || Math.abs(sort) > 99999) throw err("BAD_REQUEST", "ลำดับต้องเป็นจำนวนเต็ม");
  }
  const hidden = p.hidden === true ? 1 : 0;
  const aud = Object.fromEntries(FAQ_AUDIENCES.map((a) => ["aud_" + a, p.aud.includes(a) ? 1 : 0]));
  let fromFb;
  if (p.from_feedback_id !== undefined && p.from_feedback_id !== null) {
    if (!Number.isInteger(p.from_feedback_id)) throw err("BAD_REQUEST", "from_feedback_id ต้องเป็นจำนวนเต็ม");
    if (!(await DB.prepare(`SELECT 1 AS x FROM feedback WHERE id = ?`).bind(p.from_feedback_id).first())) throw err("BAD_REQUEST", "ไม่พบ feedback ต้นทาง");
    fromFb = p.from_feedback_id;
  }
  const now = nowIso(), actor = actorOf(who);
  const vals = { question, answer, ...aud, category, sort, hidden };

  if (p.id === undefined || p.id === null) {
    const row = await DB.prepare(
      `INSERT INTO faq (question, answer, aud_pcu, aud_dispenser, aud_admin, category, sort, hidden, from_feedback_id, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(question, answer, aud.aud_pcu, aud.aud_dispenser, aud.aud_admin, category, sort, hidden, fromFb ?? null, now, actor, now, actor).first();
    await auditStmt(DB, actor, who.role, "adminFaqSave", "", "", `new #${row.id} ${question.slice(0, 80)}`).run();
    return { faq: faqObj(row, true) };
  }
  if (!Number.isInteger(p.id)) throw err("BAD_REQUEST", "id ต้องเป็นจำนวนเต็ม");
  const cur = await DB.prepare(`SELECT * FROM faq WHERE id = ?`).bind(p.id).first();
  if (!cur) throw err("NOT_FOUND", "ไม่พบคำถามนี้");
  if (fromFb !== undefined) vals.from_feedback_id = fromFb;
  const changed = Object.keys(vals).filter((k) => (cur[k] ?? null) !== (vals[k] ?? null));
  if (!changed.length) return { faq: faqObj(cur, true) };
  const sets = changed.map((k) => `${k} = ?`);
  await DB.batch([
    DB.prepare(`UPDATE faq SET ${sets.join(", ")}, updated_at = ?, updated_by = ? WHERE id = ?`).bind(...changed.map((k) => vals[k]), now, actor, p.id),
    auditStmt(DB, actor, who.role, "adminFaqSave", "", "", `#${p.id} ${changed.join(",")}`),
  ]);
  return { faq: faqObj(await DB.prepare(`SELECT * FROM faq WHERE id = ?`).bind(p.id).first(), true) };
}

export async function adminFaqDelete(ctx, p) {
  const { DB, who } = ctx;
  if (!Number.isInteger(p.id)) throw err("BAD_REQUEST", "id ต้องเป็นจำนวนเต็ม");
  if (p.confirm !== "ลบ") throw err("BAD_REQUEST", 'ต้องยืนยันด้วย confirm:"ลบ"');
  const cur = await DB.prepare(`SELECT id, question FROM faq WHERE id = ?`).bind(p.id).first();
  if (!cur) throw err("NOT_FOUND", "ไม่พบคำถามนี้");
  const actor = actorOf(who);
  await DB.batch([
    DB.prepare(`DELETE FROM faq WHERE id = ?`).bind(p.id),
    auditStmt(DB, actor, who.role, "adminFaqDelete", "", "", `#${p.id} ${String(cur.question).slice(0, 80)}`),
  ]);
  return { ok: true };
}
