// pdf.js — PDF of a submitted request: Cloudflare Browser Rendering (REST /pdf) → R2, cached by content key.
// Actions: requestPdf (PCU), adminRequestPdf (admin|dispenser), printData (public, print token), dev helpers.
// Contract: functions/API.md §4 / §5 / §6b. The download itself is functions/api/pdf/[id].js.
import { err, sha256Hex, stableStringify } from "./http.js";
import { auditStmt, formPublic, latestForm, loadForm } from "./db.js";
import { signToken, verifyToken } from "./auth.js";
import { isMonth, monthFy, nowIso } from "./time.js";
import { REQ_COLS, getLines, requestObj } from "./views.js";

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

// Hash of everything that changes what the printed sheet shows. Same content → same key → the cached PDF is reused.
export async function contentKeyOf({ pcuRow, reqRow, lines, hidden }) {
  const ls = {};
  for (const l of lines) {
    const op = Number(l.op) || 0, pp = Number(l.pp) || 0;
    if (op + pp > 0) ls[l.item_code] = [op, pp];
  }
  return sha256Hex(stableStringify({
    v: reqRow.form_version_id ?? null,
    pn: pcuRow.print_name || pcuRow.name,
    sa: reqRow.submitted_at || null,
    hidden: [...hidden].sort(),
    lines: ls,
  }));
}

export async function makePrintToken(env, pcu, month, contentKey) {
  return signToken(env, { t: "print", pcu, month, ck: contentKey, exp: Date.now() + PRINT_TOKEN_MS });
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

async function createOrGetPdf(ctx, pcuCode, month, actor, role) {
  const { DB, env, request } = ctx;
  if (!isMonth(month)) throw err("BAD_REQUEST", "เดือน/รอบไม่ถูกต้อง: " + month);
  const mock = useMock(env);
  if (!env.FILES || (!mock && (!env.CF_BR_TOKEN || !env.CF_ACCOUNT_ID))) throw err("PDF_UNAVAILABLE", MSG_UNAVAILABLE);

  const bundle = await loadBundle(DB, pcuCode, month);
  if (!isSent(bundle.reqRow)) throw err("NOT_FOUND", MSG_NOT_SENT);
  const { pcuRow, reqRow } = bundle;
  const contentKey = await contentKeyOf(bundle);
  const filename = pdfFilename(pcuRow.print_name || pcuRow.name, month);
  const ready = () => ({ status: "ready", url: pdfDownloadUrl(reqRow.id, contentKey), filename, content_key: contentKey });

  const hit = await DB.prepare(`SELECT 1 AS x FROM pdf_files WHERE request_id = ? AND content_key = ?`).bind(reqRow.id, contentKey).first();
  if (hit) return ready();

  // dev-only switches (mock mode, header X-Dev-PDF) to exercise the 429 / error branches without Cloudflare
  if (mock && request.headers.get("x-dev-pdf") === "pending") return { status: "pending", retry_after: 2 };
  if (mock && request.headers.get("x-dev-pdf") === "fail") throw err("PDF_FAILED", MSG_FAILED, { detail: "dev: simulated renderer failure" });

  let bytes;
  if (mock) {
    bytes = mockPdfBytes([`MOCK PDF ${reqRow.id} ${contentKey}`]);
  } else {
    const printUrl = `${new URL(request.url).origin}/print.html?k=${encodeURIComponent(await makePrintToken(env, pcuRow.code, month, contentKey))}`;
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
    DB.prepare(`INSERT OR IGNORE INTO pdf_files (request_id, content_key, r2_key, created_at) VALUES (?,?,?,?)`).bind(reqRow.id, contentKey, r2Key, nowIso()),
    auditStmt(DB, actor, role, "pdf_create", pcuRow.code, month, `${contentKey.slice(0, 12)} ${bytes.length}B${mock ? " (mock)" : ""}`),
  ]);
  return ready();
}

// PCU token → the PCU's own request.
export async function requestPdf(ctx, p) {
  return createOrGetPdf(ctx, ctx.pcu.code, p.month, ctx.pcu.code, "pcu");
}

// admin | dispenser → any PCU's request.
export async function adminRequestPdf(ctx, p) {
  const { who } = ctx;
  if (typeof p.pcu !== "string" || !p.pcu) throw err("BAD_REQUEST", "ต้องระบุ pcu");
  return createOrGetPdf(ctx, p.pcu, p.month, who.email, who.role);
}

// public — the print shell (print.html) calls this with the short-lived print token it was opened with.
export async function printData(ctx, p) {
  const { DB, env } = ctx;
  const payload = await verifyToken(env, p.k);
  if (payload.t !== "print" || !payload.pcu || !isMonth(payload.month)) throw err("FORBIDDEN", "ลิงก์พิมพ์ไม่ถูกต้อง");
  const bundle = await loadBundle(DB, payload.pcu, payload.month);
  if (!isSent(bundle.reqRow)) throw err("NOT_FOUND", MSG_NOT_SENT);
  // the sheet must be exactly what the content key was computed from (the PDF is cached under that key)
  if ((await contentKeyOf(bundle)) !== payload.ck) throw err("CONFLICT", "ใบเบิกถูกแก้ไขระหว่างสร้าง PDF กรุณาลองใหม่");
  const { pcuRow, reqRow, lines, hidden } = bundle;
  const form = (reqRow.form_version_id ? await loadForm(DB, reqRow.form_version_id) : null) || (await latestForm(DB, monthFy(payload.month)));
  return {
    pcu: { code: pcuRow.code, name: pcuRow.name, print_name: pcuRow.print_name || pcuRow.name, group: pcuRow.grp },
    month: payload.month,
    form: formPublic(form),
    request: requestObj(reqRow, lines, false),
    hidden,
  };
}

// dev only (router checks DEV_FAKE_GOOGLE): a fresh print token for (pcu, month) — the tests cannot see the one the server generates.
export async function devPrintToken(ctx, p) {
  if (!isMonth(p.month)) throw err("BAD_REQUEST", "เดือนไม่ถูกต้อง");
  const bundle = await loadBundle(ctx.DB, p.pcu, p.month);
  if (!isSent(bundle.reqRow)) throw err("NOT_FOUND", MSG_NOT_SENT);
  const ck = await contentKeyOf(bundle);
  return { token: await makePrintToken(ctx.env, bundle.pcuRow.code, p.month, ck), content_key: ck };
}

// ---- download helper (functions/api/pdf/[id].js) -------------------------------------------------------------------------
export async function loadForDownload(DB, requestId) {
  const reqRow = await DB.prepare(`SELECT id, pcu, month FROM requests WHERE id = ?`).bind(requestId).first();
  if (!reqRow) return null;
  const pcuRow = await getPcuRow(DB, reqRow.pcu);
  return { reqRow, pcuRow };
}
