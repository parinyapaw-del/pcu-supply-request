// issue.js — บันทึกจ่ายจริง (phase 2c): issueLines · issueAll · issueDone · issueItem · adminItemIssue + (2y) issueDoneAll · issueExcept (functions/API.md §5.3).
// Staff = admin or dispenser (ctx.who = {email, role, units, backup}). A dispenser may only touch lines whose step.dispense_unit is one of
// its units, and only while calMonth <= the round month (round m is dispensed in m−1 and m, brief 2j) — except on a request keyed by an admin
// (requests.entry_by = 'admin', 2w R4: no time limit). Every write rides in the same D1 batch as its audit row.
import { err, isStr } from "./http.js";
import { auditStmt, batchChunked, formForFy } from "./db.js";
import { UNITS } from "./auth.js";
import { currentMonth, isMonth, monthFy, nowIso } from "./time.js";
import {
  formOfRequest, getLines, getRequestRow, issueInfoFrom, neededUnits, requestObj, requestedQty, unitOfCode,
} from "./views.js";
import { recalcAfterIssue } from "./stock.js";
import { loadPriceHistory, priceFor } from "./price.js";

const REASONS = ["out_of_stock", "other"];
const MAX_LINES = 400;
const MAX_ENTRIES = 60;
const NOT_SENT = "ยังไม่ได้ส่งใบเบิก";
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// ---- guards -------------------------------------------------------------------------------------------------------
const isDispenser = (who) => who.role === "dispenser";

const WINDOW_MSG = "หมดเวลาแก้ไขการจ่าย (แก้ได้ถึงสิ้นเดือนถัดไป)";
const windowClosed = (who, month, reqRow) => isDispenser(who) && currentMonth() > month && !(reqRow && reqRow.entry_by === "admin");
function assertWindow(who, month, reqRow) {
  if (windowClosed(who, month, reqRow)) throw err("FORBIDDEN", WINDOW_MSG);
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
  assertWindow(who, p.month, reqRow);

  const ts = nowIso();
  const stmts = plan.map((x) => lineUpdate(DB, reqRow.id, x.code, x.line, x.v, ts, who.email));
  stmts.push(auditStmt(DB, who.email, who.role, "issue_lines", reqRow.pcu, reqRow.month, clip(plan.map((x) => fmtLine(x.code, x.v)).join(" "))));
  await batchChunked(DB, stmts);
  await recalcAfterIssue(DB, [reqRow.pcu], reqRow.month); // 2o: received changed → next rounds' calc lines
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
  assertWindow(who, p.month, reqRow);

  const ts = nowIso();
  const stmts = [];
  const targets = lines.filter((l) => requestedQty(l) > 0 && units.includes(unitOfCode(form, l.item_code)));
  for (const l of targets) stmts.push(lineUpdate(DB, reqRow.id, l.item_code, l, { total: requestedQty(l), reason: null, note: null }, ts, who.email));
  stmts.push(auditStmt(DB, who.email, who.role, "issue_all", reqRow.pcu, reqRow.month, `units=${units.join(",")} lines=${targets.length}`));
  await batchChunked(DB, stmts);
  await recalcAfterIssue(DB, [reqRow.pcu], reqRow.month); // 2o: received changed → next rounds' calc lines
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
  assertWindow(who, p.month, reqRow);

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
  await recalcAfterIssue(DB, [reqRow.pcu], reqRow.month); // 2o: received changed → next rounds' calc lines
  return respond(DB, who, reqRow.pcu, reqRow.month);
}

// ---- per item, across PCUs ----------------------------------------------------------------------------------------------
// formForFy of the month's fy, the item in it, and its dispense unit (BAD_REQUEST if unknown).
async function itemContext(DB, who, month, code) {
  assertMonth(month);
  if (!isStr(code) || !code) throw err("BAD_REQUEST", "ต้องระบุ item_code");
  const latest = await formForFy(DB, monthFy(month));
  const ent = latest && latest.index.get(code);
  if (!ent) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + code);
  assertUnitAllowed(who, ent.step.dispense_unit);
  return { latest, ent };
}

// every submitted/issued request of the month that has `code` requested (+ names, + issue_status units per request)
async function itemRequests(DB, month, code) {
  const [res, doneRes] = await Promise.all([
    DB.prepare(
      `SELECT r.id, r.pcu, r.status, r.form_version_id, r.entry_by, p.name AS pcu_name, l.op, l.pp, l.issued_total, l.issued_op, l.issued_pp, l.issue_reason, l.issue_note
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
  const price = priceFor(await loadPriceHistory(DB, monthFy(p.month)), latest, p.item_code, p.month) ?? 0; // 2p: the round's price
  return {
    item: { code: it.code, name: it.name, unit: it.unit, price, dispense_unit: ent.step.dispense_unit, step: ent.step.code, step_title: ent.step.title || "" },
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

  // time window (2w): past it a dispenser may still write the requests keyed by an admin; none of the entries is one → FORBIDDEN as before
  const late = windowClosed(who, p.month, null);
  if (late && !pcuCodes.some((c) => byPcu.has(c) && byPcu.get(c).entry_by === "admin")) throw err("FORBIDDEN", WINDOW_MSG);
  const plan = [], skipped = [];
  for (const pcuCode of pcuCodes) {
    const r = byPcu.get(pcuCode);
    if (!r) {
      const st = hasReq.get(pcuCode);
      skipped.push({ pcu: pcuCode, why: !known.has(pcuCode) ? "ไม่พบ รพ.สต. นี้" : st !== "submitted" && st !== "issued" ? NOT_SENT : "ไม่ได้ขอรายการนี้" });
      continue;
    }
    if (late && r.entry_by !== "admin") { skipped.push({ pcu: pcuCode, why: WINDOW_MSG }); continue; }
    if (isDispenser(who) && !who.units.includes(await unitFor(r))) { skipped.push({ pcu: pcuCode, why: "รายการนี้อยู่นอกหน่วยจ่ายของคุณในใบเบิกนี้" }); continue; }
    plan.push({ r, v: parseIssueInput(p.entries[pcuCode], (r.op || 0) + (r.pp || 0)) }); // a bad entry rejects the whole call before any write
  }

  const ts = nowIso();
  const stmts = [];
  for (const x of plan) {
    stmts.push(lineUpdate(DB, x.r.id, p.item_code, x.r, x.v, ts, who.email));
    stmts.push(auditStmt(DB, who.email, who.role, "issue_item", x.r.pcu, p.month, fmtLine(p.item_code, x.v)));
  }
  if (stmts.length) {
    await batchChunked(DB, stmts);
    await recalcAfterIssue(DB, plan.map((x) => x.r.pcu), p.month); // 2o
  }
  return { updated: plan.map((x) => x.r.pcu), skipped };
}

// ---- whole round, one unit (2y) -------------------------------------------------------------------------------------------
// issueDoneAll{month, unit} · issueExcept{month, unit, items, reason, note?}. Targets = every submitted/issued request of the month that has
// requested lines of `unit` and no issue_status(unit) yet; a request past the dispenser's time window → skipped (not an error).
// Only lines whose figures actually change are written (D1 quota); "= ขอ" lines go as one UPDATE … IN (…) per request.
const FILL_CHUNK = 90; // + 3 bound params ≤ D1's 100

const isFull = (l) => l.issued_total === requestedQty(l) && l.issued_op === (l.op || 0) && l.issued_pp === (l.pp || 0) && l.issue_reason == null && l.issue_note == null;

async function roundUnitTargets(DB, who, month, unit) {
  assertMonth(month);
  assertUnitName(unit);
  assertUnitAllowed(who, unit);
  const [reqRes, lineRes, doneRes] = await Promise.all([
    DB.prepare(`SELECT id, pcu, month, status, form_version_id, entry_by FROM requests WHERE month = ? AND status IN ('submitted','issued') ORDER BY pcu`).bind(month).all(),
    DB.prepare(
      `SELECT l.request_id, l.item_code, l.op, l.pp, l.issued_total, l.issued_op, l.issued_pp, l.issue_reason, l.issue_note
         FROM request_lines l JOIN requests r ON r.id = l.request_id
        WHERE r.month = ? AND r.status IN ('submitted','issued') AND (COALESCE(l.op,0) + COALESCE(l.pp,0)) > 0`
    ).bind(month).all(),
    DB.prepare(`SELECT request_id, dispense_unit FROM issue_status WHERE request_id IN (SELECT id FROM requests WHERE month = ?)`).bind(month).all(),
  ]);
  const linesBy = new Map(), doneBy = new Map(), forms = new Map();
  for (const l of lineRes.results) { if (!linesBy.has(l.request_id)) linesBy.set(l.request_id, []); linesBy.get(l.request_id).push(l); }
  for (const d of doneRes.results) { if (!doneBy.has(d.request_id)) doneBy.set(d.request_id, new Set()); doneBy.get(d.request_id).add(d.dispense_unit); }
  const targets = [], skipped = [];
  for (const r of reqRes.results) {
    const key = r.form_version_id || 0;
    if (!forms.has(key)) forms.set(key, await formOfRequest(DB, r));
    const form = forms.get(key), lines = linesBy.get(r.id) || [], done = doneBy.get(r.id) || new Set();
    const needed = neededUnits(form, lines);
    if (!needed.has(unit) || done.has(unit)) continue;
    if (windowClosed(who, month, r)) { skipped.push({ pcu: r.pcu, why: WINDOW_MSG }); continue; }
    targets.push({ r, form, needed, done, unitLines: lines.filter((l) => unitOfCode(form, l.item_code) === unit) });
  }
  return { targets, skipped };
}

// UPDATE … SET issued = requested for `codes` of one request (reason/note cleared)
function fillStmts(DB, reqId, codes, ts, actor) {
  const out = [];
  for (let i = 0; i < codes.length; i += FILL_CHUNK) {
    const part = codes.slice(i, i + FILL_CHUNK);
    out.push(DB.prepare(
      `UPDATE request_lines SET issued_total = COALESCE(op,0) + COALESCE(pp,0), issued_op = COALESCE(op,0), issued_pp = COALESCE(pp,0),
              issue_reason = NULL, issue_note = NULL, issued_at = ?, issued_by = ?
        WHERE request_id = ? AND item_code IN (${part.map(() => "?").join(",")})`
    ).bind(ts, actor, reqId, ...part));
  }
  return out;
}

// issue_status row + 'issued' when every needed unit is done (same rule as issueDone done:1) → resulting status
function markDoneStmts(DB, t, unit, ts, actor, stmts) {
  stmts.push(DB.prepare(`INSERT OR IGNORE INTO issue_status (request_id, dispense_unit, done_at, done_by) VALUES (?,?,?,?)`).bind(t.r.id, unit, ts, actor));
  const allDone = [...t.needed].every((u) => u === unit || t.done.has(u));
  if (allDone && t.r.status === "submitted") {
    stmts.push(DB.prepare(`UPDATE requests SET status = 'issued', issued_seen_at = NULL WHERE id = ? AND status = 'submitted'`).bind(t.r.id));
    return "issued";
  }
  return t.r.status;
}

export async function issueDoneAll(ctx, p) {
  const { DB, who } = ctx;
  const { targets, skipped } = await roundUnitTargets(DB, who, p.month, p.unit);
  const ts = nowIso();
  const stmts = [];
  for (const t of targets) {
    const codes = t.unitLines.filter((l) => l.issued_total === null || l.issued_total === undefined).map((l) => l.item_code); // typed figures stay
    stmts.push(...fillStmts(DB, t.r.id, codes, ts, who.email));
    const status = markDoneStmts(DB, t, p.unit, ts, who.email, stmts);
    stmts.push(auditStmt(DB, who.email, who.role, "issue_done_all", t.r.pcu, p.month, `unit=${p.unit} filled=${codes.length} status=${status}`));
  }
  if (stmts.length) {
    await batchChunked(DB, stmts);
    await recalcAfterIssue(DB, targets.map((t) => t.r.pcu), p.month); // 2o
  }
  return { done: targets.map((t) => t.r.pcu), skipped };
}

export async function issueExcept(ctx, p) {
  const { DB, who } = ctx;
  if (!isObj(p.items)) throw err("BAD_REQUEST", "ต้องระบุ items");
  const codes = Object.keys(p.items);
  if (!codes.length) throw err("BAD_REQUEST", "ต้องเลือกรายการที่จ่ายไม่ครบอย่างน้อย 1 รายการ");
  if (codes.length > MAX_LINES) throw err("BAD_REQUEST", "จำนวนรายการมากเกินไป");
  if (!REASONS.includes(p.reason)) throw err("BAD_REQUEST", "จ่ายไม่ครบต้องระบุเหตุผล (ของหมด/รอจัดซื้อ หรือ อื่น ๆ)");
  if (p.reason === "other" && !(isStr(p.note) && p.note.trim())) throw err("BAD_REQUEST", 'เหตุผล "อื่น ๆ" ต้องพิมพ์หมายเหตุ');
  const { targets, skipped } = await roundUnitTargets(DB, who, p.month, p.unit);
  const latest = await formForFy(DB, monthFy(p.month));
  for (const code of codes) {
    const ent = latest && latest.index.get(code);
    if (!ent) throw err("BAD_REQUEST", "รหัสรายการไม่ถูกต้อง: " + code);
    if (ent.step.dispense_unit !== p.unit) throw err("BAD_REQUEST", `รายการ ${code} ไม่ใช่ของหน่วย "${p.unit}"`);
    if (!isObj(p.items[code])) throw err("BAD_REQUEST", `items.${code} ต้องเป็น {รพ.สต.: จำนวน}`);
  }

  // validate every cell before anything is written; a PCU that did not request the item is ignored
  const picked = new Set(codes);
  const plan = targets.map((t) => {
    const custom = [], fill = [];
    for (const l of t.unitLines) {
      if (!picked.has(l.item_code)) { if (!isFull(l)) fill.push(l.item_code); continue; }
      const raw = p.items[l.item_code][t.r.pcu];
      if (raw === undefined || raw === null || raw === "") throw err("BAD_REQUEST", `ต้องกรอกยอดที่จ่ายของ ${t.r.pcu} รายการ ${l.item_code}`);
      const v = parseIssueInput({ issued_total: raw, reason: p.reason, note: p.note }, requestedQty(l));
      const sp = splitIssued(l.op || 0, l.pp || 0, v.total);
      const same = l.issued_total === v.total && l.issued_op === sp.issued_op && l.issued_pp === sp.issued_pp && (l.issue_reason ?? null) === v.reason && (l.issue_note ?? null) === v.note;
      custom.push({ l, v, same });
    }
    return { t, custom, fill };
  });

  const ts = nowIso();
  const stmts = [];
  let lines = 0;
  for (const { t, custom, fill } of plan) {
    for (const x of custom) if (!x.same) stmts.push(lineUpdate(DB, t.r.id, x.l.item_code, x.l, x.v, ts, who.email));
    stmts.push(...fillStmts(DB, t.r.id, fill, ts, who.email));
    lines += custom.filter((x) => !x.same).length + fill.length;
    const status = markDoneStmts(DB, t, p.unit, ts, who.email, stmts);
    stmts.push(auditStmt(DB, who.email, who.role, "issue_except", t.r.pcu, p.month,
      clip(`unit=${p.unit} ${custom.map((x) => fmtLine(x.l.item_code, x.v)).join(" ")} filled=${fill.length} status=${status}`)));
  }
  if (stmts.length) {
    await batchChunked(DB, stmts);
    await recalcAfterIssue(DB, targets.map((t) => t.r.pcu), p.month); // 2o
  }
  return { done: targets.map((t) => t.r.pcu), skipped, lines };
}
