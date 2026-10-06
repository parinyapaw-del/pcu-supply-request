// issue.js — บันทึกจ่ายจริง (phase 2c): issueLines · issueAll · issueDone · issueItem · adminItemIssue (functions/API.md §5.3).
// Staff = admin or dispenser (ctx.who = {email, role, units, backup}). A dispenser may only touch lines whose step.dispense_unit is one of
// its units, and only until the end of the month after the request month. Every write rides in the same D1 batch as its audit row.
import { err, isStr } from "./http.js";
import { auditStmt, batchChunked, latestForm } from "./db.js";
import { UNITS } from "./auth.js";
import { currentMonth, isMonth, monthFy, nextMonth, nowIso } from "./time.js";
import {
  formOfRequest, getLines, getRequestRow, issueInfoFrom, neededUnits, requestObj, requestedQty, unitOfCode,
} from "./views.js";

const REASONS = ["out_of_stock", "other"];
const MAX_LINES = 400;
const MAX_ENTRIES = 60;
const NOT_SENT = "ยังไม่ได้ส่งใบเบิก";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// ---- guards -------------------------------------------------------------------------------------------------------
const isDispenser = (who) => who.role === "dispenser";

function assertWindow(who, month) {
  if (isDispenser(who) && currentMonth() > nextMonth(month)) throw err("FORBIDDEN", "หมดเวลาแก้ไขการจ่าย (แก้ได้ถึงสิ้นเดือนถัดไป)");
}
function assertUnitAllowed(who, unit) {
  if (isDispenser(who) && !who.units.includes(unit)) throw err("FORBIDDEN", `ไม่มีสิทธิ์จ่ายรายการของหน่วย "${unit}"`);
}
function assertUnitName(unit) {
  if (!isStr(unit) || !UNITS.includes(unit)) throw err("BAD_REQUEST", "หน่วยจ่ายไม่ถูกต้อง (พัสดุ / จ่ายกลาง / LAB)");
}
function assertMonth(m) {
  if (!isMonth(m)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง");
}

// ---- value rules ---------------------------------------------------------------------------------------------------
// Parses one {issued_total, reason?, note?} against the requested quantity.
// Returns null (= clear the line) or {total, reason, note} (reason/note null when total == requested).
export function parseIssueInput(raw, requested) {
  if (!isObj(raw) || !("issued_total" in raw)) throw err("BAD_REQUEST", "ต้องระบุ issued_total (จำนวนเต็ม หรือ null เพื่อล้างค่า)");
  const t = raw.issued_total;
  if (t === null || t === "") return null;
  const n = typeof t === "string" ? Number(t.trim()) : t;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw err("BAD_REQUEST", "จำนวนที่จ่ายต้องเป็นเลขจำนวนเต็ม ≥ 0 หรือว่าง");
  if (n > requested) throw err("BAD_REQUEST", `จ่ายเกินขอไม่ได้ (ขอ ${requested})`);
  if (n === requested) return { total: n, reason: null, note: null };
  if (!REASONS.includes(raw.reason)) throw err("BAD_REQUEST", "จ่ายไม่ครบต้องระบุเหตุผล (ของหมด/รอจัดซื้อ หรือ อื่น ๆ)");
  if (raw.note !== undefined && raw.note !== null && !isStr(raw.note)) throw err("BAD_REQUEST", "หมายเหตุต้องเป็นข้อความ");
  const note = isStr(raw.note) ? raw.note.trim() : "";
  if (raw.reason === "other" && !note) throw err("BAD_REQUEST", 'เหตุผล "อื่น ๆ" ต้องพิมพ์หมายเหตุ');
  if (note.length > 200) throw err("BAD_REQUEST", "หมายเหตุยาวเกิน 200 ตัวอักษร");
  return { total: n, reason: raw.reason, note: note || null };
}

// OP is short first: short = op+pp − total; issued_op = max(0, op − short); issued_pp = pp − max(0, short − op).
export function splitIssued(op, pp, total) {
  const short = op + pp - total;
  return { issued_op: Math.max(0, op - short), issued_pp: pp - Math.max(0, short - op) };
}

function lineUpdate(DB, reqId, code, line, v, ts, actor) {
  if (!v) { // clear
    return DB.prepare(
      `UPDATE request_lines SET issued_total=NULL, issued_op=NULL, issued_pp=NULL, issue_reason=NULL, issue_note=NULL, issued_at=NULL, issued_by=NULL
        WHERE request_id=? AND item_code=?`
    ).bind(reqId, code);
  }
  const { issued_op, issued_pp } = splitIssued(line.op || 0, line.pp || 0, v.total);
  return DB.prepare(
    `UPDATE request_lines SET issued_total=?, issued_op=?, issued_pp=?, issue_reason=?, issue_note=?, issued_at=?, issued_by=? WHERE request_id=? AND item_code=?`
  ).bind(v.total, issued_op, issued_pp, v.reason, v.note, ts, actor, reqId, code);
}

const fmtLine = (code, v) => (v ? `${code}=${v.total}${v.reason ? "(" + v.reason + (v.note ? ":" + v.note : "") + ")" : ""}` : `${code}=null`);
const clip = (s) => (s.length > 1500 ? s.slice(0, 1500) + "…" : s);

// ---- shared loading ------------------------------------------------------------------------------------------------
async function loadSent(DB, pcuCode, month) {
  assertMonth(month);
  const code = isStr(pcuCode) ? pcuCode : "";
  const reqRow = code ? await getRequestRow(DB, code, month) : null;
  if (!reqRow || (reqRow.status !== "submitted" && reqRow.status !== "issued")) throw err("NOT_FOUND", NOT_SENT);
  const [form, lines, doneRes] = await Promise.all([
    formOfRequest(DB, reqRow),
    getLines(DB, reqRow.id),
    DB.prepare(`SELECT dispense_unit, done_at, done_by FROM issue_status WHERE request_id = ?`).bind(reqRow.id).all(),
  ]);
  return { reqRow, form, lines, done: doneRes.results };
}

// {request (admin view; a dispenser only gets the lines of its own units), issue}
async function respond(DB, who, pcuCode, month) {
  const { reqRow, form, lines, done } = await loadSent(DB, pcuCode, month);
  const shown = isDispenser(who) ? lines.filter((l) => who.units.includes(unitOfCode(form, l.item_code))) : lines;
  return { request: requestObj(reqRow, shown, true), issue: issueInfoFrom(form, reqRow.issued_seen_at, lines, done) };
}

// ---- issueLines ---------------------------------------------------------------------------------------------------------
export async function issueLines(ctx, p) {
  const { DB, who } = ctx;
  const { reqRow, form, lines } = await loadSent(DB, p.pcu, p.month);
  if (!isObj(p.lines)) throw err("BAD_REQUEST", "ต้องระบุ lines");
  const codes = Object.keys(p.lines);
  if (!codes.length) throw err("BAD_REQUEST", "ไม่มีรายการที่จะบันทึก");
  if (codes.length > MAX_LINES) throw err("BAD_REQUEST", "จำนวนบรรทัดมากเกินไป");
  const byCode = new Map(lines.map((l) => [l.item_code, l]));

  // permission first (unit + time window), then per-line validation — nothing is written unless every line is valid
  const plan = [];
  for (const code of codes) {
    const unit = unitOfCode(form, code);
    if (!unit) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + code);
    assertUnitAllowed(who, unit);
    const line = byCode.get(code);
    const req = line ? requestedQty(line) : 0;
    if (!line || req <= 0) throw err("BAD_REQUEST", `รายการ ${code} ไม่ได้ขอในใบเบิกนี้`);
    plan.push({ code, line, v: parseIssueInput(p.lines[code], req) });
  }
  assertWindow(who, p.month);

  const ts = nowIso();
  const stmts = plan.map((x) => lineUpdate(DB, reqRow.id, x.code, x.line, x.v, ts, who.email));
  stmts.push(auditStmt(DB, who.email, who.role, "issue_lines", reqRow.pcu, reqRow.month, clip(plan.map((x) => fmtLine(x.code, x.v)).join(" "))));
  await batchChunked(DB, stmts);
  return respond(DB, who, reqRow.pcu, reqRow.month);
}

// ---- issueAll ---------------------------------------------------------------------------------------------------------------
export async function issueAll(ctx, p) {
  const { DB, who } = ctx;
  const { reqRow, form, lines } = await loadSent(DB, p.pcu, p.month);
  let units;
  if (p.unit !== undefined && p.unit !== null && p.unit !== "") {
    assertUnitName(p.unit);
    assertUnitAllowed(who, p.unit);
    units = [p.unit];
  } else units = isDispenser(who) ? UNITS.filter((u) => who.units.includes(u)) : [...UNITS];
  assertWindow(who, p.month);

  const ts = nowIso();
  const stmts = [];
  const targets = lines.filter((l) => requestedQty(l) > 0 && units.includes(unitOfCode(form, l.item_code)));
  for (const l of targets) stmts.push(lineUpdate(DB, reqRow.id, l.item_code, l, { total: requestedQty(l), reason: null, note: null }, ts, who.email));
  stmts.push(auditStmt(DB, who.email, who.role, "issue_all", reqRow.pcu, reqRow.month, `units=${units.join(",")} lines=${targets.length}`));
  await batchChunked(DB, stmts);
  return respond(DB, who, reqRow.pcu, reqRow.month);
}

// ---- issueDone ---------------------------------------------------------------------------------------------------------------
export async function issueDone(ctx, p) {
  const { DB, who } = ctx;
  const { reqRow, form, lines, done } = await loadSent(DB, p.pcu, p.month);
  assertUnitName(p.unit);
  const want = p.done === 1 || p.done === true || p.done === "1";
  if (!want && !(p.done === 0 || p.done === false || p.done === "0")) throw err("BAD_REQUEST", "done ต้องเป็น 0 หรือ 1");
  assertUnitAllowed(who, p.unit);
  assertWindow(who, p.month);

  const needed = neededUnits(form, lines);
  if (want && !needed.has(p.unit)) throw err("BAD_REQUEST", `หน่วย "${p.unit}" ไม่มีรายการที่ขอในใบเบิกนี้`);
  const ts = nowIso();
  const stmts = [];
  let filled = 0;
  const doneAfter = new Set(done.map((d) => d.dispense_unit));
  if (want) {
    // default = จ่ายตามที่ขอ for every requested line of this unit that has no figure yet
    for (const l of lines) {
      if (requestedQty(l) <= 0 || unitOfCode(form, l.item_code) !== p.unit || (l.issued_total !== null && l.issued_total !== undefined)) continue;
      stmts.push(lineUpdate(DB, reqRow.id, l.item_code, l, { total: requestedQty(l), reason: null, note: null }, ts, who.email));
      filled++;
    }
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO issue_status (request_id, dispense_unit, done_at, done_by) VALUES (?,?,?,?)`).bind(reqRow.id, p.unit, ts, who.email));
    doneAfter.add(p.unit);
  } else {
    stmts.push(DB.prepare(`DELETE FROM issue_status WHERE request_id = ? AND dispense_unit = ?`).bind(reqRow.id, p.unit));
    doneAfter.delete(p.unit);
  }
  const allDone = needed.size > 0 && [...needed].every((u) => doneAfter.has(u));
  let status = reqRow.status;
  if (allDone && status === "submitted") {
    status = "issued";
    stmts.push(DB.prepare(`UPDATE requests SET status = 'issued', issued_seen_at = NULL WHERE id = ? AND status = 'submitted'`).bind(reqRow.id));
  } else if (!allDone && status === "issued") {
    status = "submitted"; // submitted_at / first_submitted_at stay as they were
    stmts.push(DB.prepare(`UPDATE requests SET status = 'submitted' WHERE id = ? AND status = 'issued'`).bind(reqRow.id));
  }
  stmts.push(auditStmt(DB, who.email, who.role, "issue_done", reqRow.pcu, reqRow.month, `unit=${p.unit} done=${want ? 1 : 0} filled=${filled} status=${status}`));
  await batchChunked(DB, stmts);
  return respond(DB, who, reqRow.pcu, reqRow.month);
}

// ---- per item, across PCUs ----------------------------------------------------------------------------------------------
// Latest form of the month's fy, the item in it, and its dispense unit (BAD_REQUEST if unknown).
async function itemContext(DB, who, month, code) {
  assertMonth(month);
  if (!isStr(code) || !code) throw err("BAD_REQUEST", "ต้องระบุ item_code");
  const latest = await latestForm(DB, monthFy(month));
  const ent = latest && latest.index.get(code);
  if (!ent) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + code);
  assertUnitAllowed(who, ent.step.dispense_unit);
  return { latest, ent };
}

// every submitted/issued request of the month that has `code` requested (+ names, + issue_status units per request)
async function itemRequests(DB, month, code) {
  const [res, doneRes] = await Promise.all([
    DB.prepare(
      `SELECT r.id, r.pcu, r.status, r.form_version_id, p.name AS pcu_name, l.op, l.pp, l.issued_total, l.issued_op, l.issued_pp, l.issue_reason, l.issue_note
         FROM requests r JOIN request_lines l ON l.request_id = r.id AND l.item_code = ? LEFT JOIN pcus p ON p.code = r.pcu
        WHERE r.month = ? AND r.status IN ('submitted','issued') AND (COALESCE(l.op,0) + COALESCE(l.pp,0)) > 0 ORDER BY r.pcu`
    ).bind(code, month).all(),
    DB.prepare(`SELECT request_id, dispense_unit FROM issue_status WHERE request_id IN (SELECT id FROM requests WHERE month = ?)`).bind(month).all(),
  ]);
  const doneBy = new Map();
  for (const d of doneRes.results) { if (!doneBy.has(d.request_id)) doneBy.set(d.request_id, new Set()); doneBy.get(d.request_id).add(d.dispense_unit); }
  return { rows: res.results, doneBy };
}

export async function adminItemIssue(ctx, p) {
  const { DB, who } = ctx;
  const { latest, ent } = await itemContext(DB, who, p.month, p.item_code);
  const { rows, doneBy } = await itemRequests(DB, p.month, p.item_code);
  const formCache = new Map();
  const unitFor = async (r) => {
    if (!r.form_version_id) return ent.step.dispense_unit;
    if (!formCache.has(r.form_version_id)) formCache.set(r.form_version_id, await formOfRequest(DB, r));
    return unitOfCode(formCache.get(r.form_version_id), p.item_code) || ent.step.dispense_unit;
  };
  const out = [];
  for (const r of rows) {
    const unit = await unitFor(r);
    out.push({
      pcu: r.pcu, pcu_name: r.pcu_name || r.pcu, status: r.status, op: r.op || 0, pp: r.pp || 0, requested: (r.op || 0) + (r.pp || 0),
      issued_total: r.issued_total ?? null, issued_op: r.issued_op ?? null, issued_pp: r.issued_pp ?? null,
      reason: r.issue_reason ?? null, note: r.issue_note ?? null,
      unit_done: !!(doneBy.get(r.id) && doneBy.get(r.id).has(unit)),
    });
  }
  const it = ent.item;
  return {
    item: { code: it.code, name: it.name, unit: it.unit, price: Number(it.price) || 0, dispense_unit: ent.step.dispense_unit, step: ent.step.code, step_title: ent.step.title || "" },
    rows: out, form_version_id: latest.id,
  };
}

export async function issueItem(ctx, p) {
  const { DB, who } = ctx;
  const { ent } = await itemContext(DB, who, p.month, p.item_code);
  if (!isObj(p.entries)) throw err("BAD_REQUEST", "ต้องระบุ entries");
  const pcuCodes = Object.keys(p.entries);
  if (!pcuCodes.length) throw err("BAD_REQUEST", "ไม่มี รพ.สต. ที่จะบันทึก");
  if (pcuCodes.length > MAX_ENTRIES) throw err("BAD_REQUEST", "จำนวน รพ.สต. มากเกินไป");
  assertWindow(who, p.month);

  const [{ rows }, pcuRes, reqRes] = await Promise.all([
    itemRequests(DB, p.month, p.item_code),
    DB.prepare(`SELECT code FROM pcus`).all(),
    DB.prepare(`SELECT pcu, status FROM requests WHERE month = ?`).bind(p.month).all(),
  ]);
  const byPcu = new Map(rows.map((r) => [r.pcu, r]));
  const known = new Set(pcuRes.results.map((r) => r.code));
  const hasReq = new Map(reqRes.results.map((r) => [r.pcu, r.status]));
  const formCache = new Map();
  const unitFor = async (r) => {
    if (!r.form_version_id) return ent.step.dispense_unit;
    if (!formCache.has(r.form_version_id)) formCache.set(r.form_version_id, await formOfRequest(DB, r));
    return unitOfCode(formCache.get(r.form_version_id), p.item_code) || ent.step.dispense_unit;
  };

  const plan = [], skipped = [];
  for (const pcuCode of pcuCodes) {
    const r = byPcu.get(pcuCode);
    if (!r) {
      const st = hasReq.get(pcuCode);
      skipped.push({ pcu: pcuCode, why: !known.has(pcuCode) ? "ไม่พบ รพ.สต. นี้" : st !== "submitted" && st !== "issued" ? NOT_SENT : "ไม่ได้ขอรายการนี้" });
      continue;
    }
    if (isDispenser(who) && !who.units.includes(await unitFor(r))) { skipped.push({ pcu: pcuCode, why: "รายการนี้อยู่นอกหน่วยจ่ายของคุณในใบเบิกนี้" }); continue; }
    plan.push({ r, v: parseIssueInput(p.entries[pcuCode], (r.op || 0) + (r.pp || 0)) }); // a bad entry rejects the whole call before any write
  }

  const ts = nowIso();
  const stmts = [];
  for (const x of plan) {
    stmts.push(lineUpdate(DB, x.r.id, p.item_code, x.r, x.v, ts, who.email));
    stmts.push(auditStmt(DB, who.email, who.role, "issue_item", x.r.pcu, p.month, fmtLine(p.item_code, x.v)));
  }
  if (stmts.length) await batchChunked(DB, stmts);
  return { updated: plan.map((x) => x.r.pcu), skipped };
}
