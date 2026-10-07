// pdf.js — PDF of a submitted request: Cloudflare Browser Rendering (REST /pdf) → R2, cached by content key.
// Actions: requestPdf (PCU), adminRequestPdf (admin|dispenser), printData (public, print token), dev helpers.
// Contract: functions/API.md §4 / §5 / §6b. The download itself is functions/api/pdf/[id].js.
// 2b-R: retention (prunePdfFiles), R2 cost guard (PDF_QUOTA) and usage counters (usage.js).
import { err, sha256Hex, stableStringify } from "./http.js";
import { auditStmt, batchChunked, formForFy, formPublic, loadForm } from "./db.js";
import { signToken, verifyToken } from "./auth.js";
import { currentRound, isDate, isMonth, monthFy, monthMinus, nowIso } from "./time.js";
import { REQ_COLS, getLines, requestId, requestObj } from "./views.js";
import { MSG_QUOTA, PDF_RESERVE_BYTES, bumpStmt, quotaUsage, readUsage, renderStmts } from "./usage.js";

// Bump whenever print.css / print.js change what the sheet looks like: it is part of the content key, so a changed layout is
// rendered again instead of served from R2 (handoff 2026-10-07 §3.1). 2 = brief 2g (--print-scale 0.78, one Blink engine everywhere).
// 3 = brief 2h (header date / supply month blank unless chosen at print time; PCU14/15 sentence uses the full print_name).
export const LAYOUT_VERSION = 3;
export const PRINT_TOKEN_MS = 120000; // a print token (handed to the renderer inside the URL) lives 2 minutes
const DEFAULT_RETRY_AFTER = 10;
const RENDER_TIMEOUT_MS = 60000;

const MSG_NOT_SENT = "ต้องส่งใบเบิกก่อนจึงจะดาวน์โหลด PDF ได้";
const MSG_UNAVAILABLE = "ยังไม่เปิดใช้ PDF บน server — กดพิมพ์แล้วเลือก Save as PDF แทน";
const MSG_FAILED = "สร้าง PDF ไม่สำเร็จ — กดปุ่ม พิมพ์ แล้วเลือก Save as PDF แทน";

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

// "ใบเบิก_<print_name>_<เดือนไทย ปีพ.ศ.>.pdf"   e.g. ใบเบิก_มหาดไทย_ตุลาคม 2569.pdf
export function pdfFilename(printName, month) {
  const [y, m] = month.split("-").map(Number);
  const safe = String(printName || "").replace(/[\\/:*?"<>|\r\n]+/g, " ").trim();
  return `ใบเบิก_${safe}_${THAI_MONTHS[m - 1]} ${y + 543}.pdf`;
}

// RFC 5987 percent-encoding for Content-Disposition filename*
export const encodeFilename = (name) => encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export const pdfR2Key = (pcu, month, contentKey) => `pdf/${pcu}/${month}/${contentKey}.pdf`;
export const pdfDownloadUrl = (requestId, contentKey) => `/api/pdf/${encodeURIComponent(requestId)}?k=${contentKey}`;

// ---- data ---------------------------------------------------------------------------------------------------
async function getPcuRow(DB, code) {
  return DB.prepare(`SELECT code, name, print_name, "group" AS grp FROM pcus WHERE code = ?`).bind(String(code || "")).first();
}

// Everything the sheet is rendered from. reqRow is null when the PCU has no request for the month.
async function loadBundle(DB, pcuCode, month) {
  const pcuRow = await getPcuRow(DB, pcuCode);
  if (!pcuRow) throw err("NOT_FOUND", "ไม่พบ รพ.สต. นี้: " + pcuCode);
  const reqRow = await DB.prepare(`SELECT ${REQ_COLS} FROM requests WHERE pcu = ? AND month = ?`).bind(pcuRow.code, month).first();
  if (!reqRow) return { pcuRow, reqRow: null, lines: [], hidden: [] };
  const [lines, hid] = await Promise.all([
    getLines(DB, reqRow.id),
    DB.prepare(`SELECT item_code FROM hidden_items WHERE pcu = ?`).bind(pcuRow.code).all(),
  ]);
  return { pcuRow, reqRow, lines, hidden: hid.results.map((r) => r.item_code) };
}

const isSent = (reqRow) => !!reqRow && (reqRow.status === "submitted" || reqRow.status === "issued");

// 2h print options (per print, never stored on the request): {doc_date:"YYYY-MM-DD"|null, supply_month:"YYYY-MM"|null}.
// absent / null / "" → null · doc_date any valid date · supply_month only the round month itself (2j: round = "ขอเบิกเดือน X") · any other type fails the same
// checks (isDate / === need a string) → BAD_REQUEST. `month` must already be valid.
export function printOptsOf(p, month) {
  const pick = (v) => (v === undefined || v === null || v === "" ? null : v);
  const doc_date = pick(p && p.doc_date), supply_month = pick(p && p.supply_month);
  if (doc_date !== null && !isDate(doc_date)) throw err("BAD_REQUEST", "วันที่เอกสารไม่ถูกต้อง");
  if (supply_month !== null && supply_month !== month) throw err("BAD_REQUEST", "เดือนที่เบิกต้องเป็นเดือนของรอบ");
  return { doc_date, supply_month };
}

// Hash of everything that changes what the printed sheet shows (data + LAYOUT_VERSION + 2h print options). Same content → same key →
// the cached PDF is reused; each distinct option set is its own file.
export async function contentKeyOf({ pcuRow, reqRow, lines, hidden }, opts = {}) {
  const ls = {};
  for (const l of lines) {
    const op = Number(l.op) || 0, pp = Number(l.pp) || 0;
    if (op + pp > 0) ls[l.item_code] = [op, pp];
  }
  return sha256Hex(stableStringify({
    lv: LAYOUT_VERSION,
    v: reqRow.form_version_id ?? null,
    pn: pcuRow.print_name || pcuRow.name,
    hidden: [...hidden].sort(),
    lines: ls,
    dd: opts.doc_date ?? null,
    sm: opts.supply_month ?? null,
  }));
}

export async function makePrintToken(env, pcu, month, contentKey, opts = {}) {
  return signToken(env, {
    t: "print", pcu, month, ck: contentKey, dd: opts.doc_date ?? null, sm: opts.supply_month ?? null, exp: Date.now() + PRINT_TOKEN_MS,
  });
}

// ---- renderers --------------------------------------------------------------------------------------------------
// Browser Rendering REST body, checked 2026-10-06 against
//   https://developers.cloudflare.com/api/resources/browser_rendering/subresources/pdf/methods/create/
//   https://developers.cloudflare.com/browser-rendering/rest-api/pdf-endpoint/  (guide now names the path .../browser-run/pdf;
//   the API reference still documents .../browser-rendering/pdf — we use the reference path).
//   url                      page to print (we pass print.html?k=<print token>)
//   viewport                 {width,height} px (A4 @96dpi)
//   gotoOptions              {waitUntil:"load"|"domcontentloaded"|"networkidle0"|"networkidle2", timeout ≤ 60000}
//   waitForSelector          {selector, timeout ≤ 120000, visible?, hidden?}  — we wait for `.print-ready`
//   pdfOptions               {format:"a4", landscape, printBackground, preferCSSPageSize, margin, scale, timeout, …}
// Response: raw application/pdf bytes on 200; 429 {errors:[{code:2001,"Rate limit exceeded"}]} when throttled.
export function browserRenderingBody(printUrl) {
  return {
    url: printUrl,
    viewport: { width: 794, height: 1123 },
    gotoOptions: { waitUntil: "load", timeout: 30000 },
    waitForSelector: { selector: ".print-ready", timeout: 30000 },
    pdfOptions: { format: "a4", landscape: false, printBackground: true, preferCSSPageSize: true },
  };
}

// Returns {pending:true, retryAfter} on 429, or {bytes}. Throws PDF_FAILED otherwise.
async function renderWithBrowserRendering(env, printUrl) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/browser-rendering/pdf`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_BR_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(browserRenderingBody(printUrl)),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
  } catch (e) {
    throw err("PDF_FAILED", MSG_FAILED, { detail: "request error: " + String(e && e.message).slice(0, 200) });
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    return { pending: true, retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(Math.ceil(ra), 120) : DEFAULT_RETRY_AFTER };
  }
  if (res.status !== 200) {
    let t = "";
    try { t = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw err("PDF_FAILED", MSG_FAILED, { detail: `browser rendering HTTP ${res.status}: ${t}` });
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 100 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "%PDF") {
    throw err("PDF_FAILED", MSG_FAILED, { detail: "browser rendering returned a non-PDF body" });
  }
  return { bytes };
}

// Hand-built one-page A4 PDF (ASCII only, ~700 B) — dev mock. Text lines are shown in the page, so the cache key is visible.
export function mockPdfBytes(lines) {
  const esc = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").replace(/([\\()])/g, "\\$1");
  let content = "BT /F1 9 Tf 40 780 Td 12 TL\n";
  for (const l of lines) content += `(${esc(l)}) Tj T*\n`;
  content += "ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// ---- core -------------------------------------------------------------------------------------------------------
// Mock only when the dev switch is on AND no real Browser Rendering token is configured. Never in production.
const useMock = (env) => env.DEV_FAKE_GOOGLE === "1" && !env.CF_BR_TOKEN;

async function createOrGetPdf(ctx, pcuCode, month, actor, role, p) {
  const { DB, env, request } = ctx;
  if (!isMonth(month)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง: " + month);
  const opts = printOptsOf(p, month);
  const mock = useMock(env);
  if (!env.FILES || (!mock && (!env.CF_BR_TOKEN || !env.CF_ACCOUNT_ID))) throw err("PDF_UNAVAILABLE", MSG_UNAVAILABLE);

  const bundle = await loadBundle(DB, pcuCode, month);
  if (!isSent(bundle.reqRow)) throw err("NOT_FOUND", MSG_NOT_SENT);
  const { pcuRow, reqRow } = bundle;
  const contentKey = await contentKeyOf(bundle, opts);
  const filename = pdfFilename(pcuRow.print_name || pcuRow.name, month);
  const ready = () => ({ status: "ready", url: pdfDownloadUrl(reqRow.id, contentKey), filename, content_key: contentKey });

  const hit = await DB.prepare(`SELECT 1 AS x FROM pdf_files WHERE request_id = ? AND content_key = ?`).bind(reqRow.id, contentKey).first();
  if (hit) return ready();

  // cache miss → R2 cost guard (§6b): Class A cap, then the bytes cap (prune everything prunable first, re-check)
  let usage = await readUsage(DB);
  if (usage.class_a >= usage.limits.r2_max_class_a) {
    throw err("PDF_QUOTA", MSG_QUOTA, { detail: `class_a ${usage.class_a} ≥ ${usage.limits.r2_max_class_a}`, usage: quotaUsage(usage) });
  }
  if (usage.bytes_total + PDF_RESERVE_BYTES > usage.limits.r2_max_bytes) {
    await prunePdfFiles(env, DB, { reason: "quota", actor, role });
    usage = await readUsage(DB);
    if (usage.bytes_total + PDF_RESERVE_BYTES > usage.limits.r2_max_bytes) {
      throw err("PDF_QUOTA", MSG_QUOTA, {
        detail: `bytes ${usage.bytes_total} + ${PDF_RESERVE_BYTES} > ${usage.limits.r2_max_bytes}`, usage: quotaUsage(usage),
      });
    }
  }

  // every renderer attempt is counted (Cloudflare bills the browser time of 429s / failures too); the dev mock counts as well
  await DB.batch(renderStmts(DB));

  // dev-only switches (mock mode, header X-Dev-PDF) to exercise the 429 / error branches without Cloudflare
  if (mock && request.headers.get("x-dev-pdf") === "pending") return { status: "pending", retry_after: 2 };
  if (mock && request.headers.get("x-dev-pdf") === "fail") throw err("PDF_FAILED", MSG_FAILED, { detail: "dev: simulated renderer failure" });

  let bytes;
  if (mock) {
    bytes = mockPdfBytes([`MOCK PDF ${reqRow.id} ${contentKey}`]);
  } else {
    const printUrl = `${new URL(request.url).origin}/print.html?k=${encodeURIComponent(await makePrintToken(env, pcuRow.code, month, contentKey, opts))}`;
    const r = await renderWithBrowserRendering(env, printUrl);
    if (r.pending) return { status: "pending", retry_after: r.retryAfter };
    bytes = r.bytes;
  }

  const r2Key = pdfR2Key(pcuRow.code, month, contentKey);
  try {
    await env.FILES.put(r2Key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  } catch (e) {
    throw err("PDF_FAILED", MSG_FAILED, { detail: "storage error: " + String(e && e.message).slice(0, 200) });
  }
  await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO pdf_files (request_id, content_key, r2_key, created_at, bytes) VALUES (?,?,?,?,?)`)
      .bind(reqRow.id, contentKey, r2Key, nowIso(), bytes.length),
    bumpStmt(DB, "r2_class_a"), // the put above
    auditStmt(DB, actor, role, "pdf_create", pcuRow.code, month, `${contentKey.slice(0, 12)} ${bytes.length}B${mock ? " (mock)" : ""}`),
  ]);
  // retention for this PCU — after the row exists, so the new file counts as the newest version. Never fails the download.
  try {
    await prunePdfFiles(env, DB, { pcu: pcuRow.code, reason: "create", actor, role });
  } catch (e) {
    console.error("pdf prune after create", e && e.stack ? e.stack : e);
  }
  return ready();
}

// ---- retention (2b-R) ---------------------------------------------------------------------------------------------------------
export const PDF_RULE = { keep_latest: 2, keep_other: 1, months: 12 };

// latest = currentRound() = nextMonth(calMonth) (2j; honours X-Dev-Month in dev; = adminRequests.current_round).
// Per (pcu, request month), newest first: month < latest−11 → delete all · month ≥ latest → keep 2 · else keep 1.
// Deletes the R2 object (by stored r2_key; R2 ignores missing keys) and the pdf_files row. Audit `pdf_prune` only when ≥ 1 file went.
// opts: {pcu?, reason: "create"|"backup"|"admin"|"quota", actor?, role?}  →  {deleted:[r2_key], bytes}
export async function prunePdfFiles(env, DB, opts = {}) {
  const pcu = opts.pcu || null;
  const reason = opts.reason || "admin";
  if (!env.FILES) return { deleted: [], bytes: 0 }; // nothing can be stored without the binding; never orphan objects
  const latest = currentRound();
  const oldest = monthMinus(latest, PDF_RULE.months - 1);
  const sql = `SELECT pf.request_id, pf.content_key, pf.r2_key, pf.bytes, r.pcu, r.month
               FROM pdf_files pf JOIN requests r ON r.id = pf.request_id ${pcu ? "WHERE r.pcu = ?" : ""}
               ORDER BY r.pcu, r.month, pf.created_at DESC, pf.rowid DESC`;
  const { results } = await (pcu ? DB.prepare(sql).bind(pcu) : DB.prepare(sql)).all();

  const victims = [];
  let group = null, idx = 0;
  for (const row of results) {
    const g = row.pcu + "|" + row.month;
    if (g !== group) { group = g; idx = 0; }
    const keep = row.month < oldest ? 0 : row.month >= latest ? PDF_RULE.keep_latest : PDF_RULE.keep_other;
    if (idx >= keep) victims.push(row);
    idx++;
  }
  if (!victims.length) return { deleted: [], bytes: 0 };

  const keys = victims.map((v) => v.r2_key || pdfR2Key(v.pcu, v.month, v.content_key));
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000)); // delete is free (not counted)
  const bytes = victims.reduce((a, v) => a + (Number(v.bytes) || 0), 0);
  const stmts = victims.map((v) => DB.prepare(`DELETE FROM pdf_files WHERE request_id = ? AND content_key = ?`).bind(v.request_id, v.content_key));
  stmts.push(auditStmt(DB, opts.actor || "system", opts.role || "system", "pdf_prune", pcu || "", latest,
    `${victims.length} files / ${bytes} bytes / pcu=${pcu || "all"} / reason=${reason}`));
  await batchChunked(DB, stmts);
  return { deleted: keys, bytes };
}

// PCU token → the PCU's own request.
export async function requestPdf(ctx, p) {
  return createOrGetPdf(ctx, ctx.pcu.code, p.month, ctx.pcu.code, "pcu", p);
}

// admin | dispenser → any PCU's request.
export async function adminRequestPdf(ctx, p) {
  const { who } = ctx;
  if (typeof p.pcu !== "string" || !p.pcu) throw err("BAD_REQUEST", "ต้องระบุ pcu");
  return createOrGetPdf(ctx, p.pcu, p.month, who.email, who.role, p);
}

// public — the print shell (print.html) calls this with the short-lived print token it was opened with.
export async function printData(ctx, p) {
  const { DB, env } = ctx;
  const payload = await verifyToken(env, p.k);
  if (payload.t !== "print" || !payload.pcu || !isMonth(payload.month)) throw err("FORBIDDEN", "ลิงก์พิมพ์ไม่ถูกต้อง");
  const bundle = await loadBundle(DB, payload.pcu, payload.month);
  if (!isSent(bundle.reqRow)) throw err("NOT_FOUND", MSG_NOT_SENT);
  // the sheet must be exactly what the content key was computed from (the PDF is cached under that key)
  const opts = { doc_date: payload.dd ?? null, supply_month: payload.sm ?? null };
  if ((await contentKeyOf(bundle, opts)) !== payload.ck) throw err("CONFLICT", "ใบเบิกถูกแก้ไขระหว่างสร้าง PDF กรุณาลองใหม่");
  const { pcuRow, reqRow, lines, hidden } = bundle;
  const form = (reqRow.form_version_id ? await loadForm(DB, reqRow.form_version_id) : null) || (await formForFy(DB, monthFy(payload.month)));
  return {
    pcu: { code: pcuRow.code, name: pcuRow.name, print_name: pcuRow.print_name || pcuRow.name, group: pcuRow.grp },
    month: payload.month,
    form: formPublic(form),
    request: requestObj(reqRow, lines, false),
    hidden,
    doc_date: opts.doc_date,
    supply_month: opts.supply_month,
  };
}

// dev only (router checks DEV_FAKE_GOOGLE): a fresh print token for (pcu, month[, 2h options]) — the tests cannot see the one the server generates.
export async function devPrintToken(ctx, p) {
  if (!isMonth(p.month)) throw err("BAD_REQUEST", "เดือนไม่ถูกต้อง");
  const opts = printOptsOf(p, p.month);
  const bundle = await loadBundle(ctx.DB, p.pcu, p.month);
  if (!isSent(bundle.reqRow)) throw err("NOT_FOUND", MSG_NOT_SENT);
  const ck = await contentKeyOf(bundle, opts);
  return { token: await makePrintToken(ctx.env, bundle.pcuRow.code, p.month, ck, opts), content_key: ck };
}

// dev only (router checks DEV_FAKE_GOOGLE): move a request to another month (tests back-date a sent request for the 12-month window).
// Moves the requests row (id + month) and re-points request_lines / issue_status / pdf_files; R2 objects stay where they are
// (pdf_files.r2_key is kept as stored — the prune deletes by r2_key).
export async function devSetRequestMonth(ctx, p) {
  const { DB } = ctx;
  if (!isMonth(p.month) || !isMonth(p.new_month)) throw err("BAD_REQUEST", "เดือนไม่ถูกต้อง");
  const pcu = String(p.pcu || "");
  const oldId = requestId(pcu, p.month), newId = requestId(pcu, p.new_month);
  if (!(await DB.prepare(`SELECT 1 AS x FROM requests WHERE id = ?`).bind(oldId).first())) throw err("NOT_FOUND", "ไม่พบใบเบิก " + oldId);
  if (oldId === newId) return { id: newId };
  if (await DB.prepare(`SELECT 1 AS x FROM requests WHERE id = ? OR (pcu = ? AND month = ?)`).bind(newId, pcu, p.new_month).first()) {
    throw err("CONFLICT", "มีใบเบิกของเดือนปลายทางอยู่แล้ว");
  }
  await DB.batch([
    DB.prepare(`UPDATE requests SET id = ?, month = ? WHERE id = ?`).bind(newId, p.new_month, oldId),
    DB.prepare(`UPDATE request_lines SET request_id = ? WHERE request_id = ?`).bind(newId, oldId),
    DB.prepare(`UPDATE issue_status SET request_id = ? WHERE request_id = ?`).bind(newId, oldId),
    DB.prepare(`UPDATE pdf_files SET request_id = ? WHERE request_id = ?`).bind(newId, oldId),
  ]);
  return { id: newId };
}

// ---- download helper (functions/api/pdf/[id].js) -------------------------------------------------------------------------
export async function loadForDownload(DB, requestId) {
  const reqRow = await DB.prepare(`SELECT id, pcu, month FROM requests WHERE id = ?`).bind(requestId).first();
  if (!reqRow) return null;
  const pcuRow = await getPcuRow(DB, reqRow.pcu);
  return { reqRow, pcuRow };
}
