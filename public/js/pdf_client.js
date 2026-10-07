// pdf_client.js — browser side of the PDF download (functions/API.md §6b), shared by the PCU print page and the admin status tab.
// requestPdf / adminRequestPdf answer {status:"ready",url,filename} or {status:"pending",retry_after}; the file itself is then
// fetched from GET /api/pdf/:id?k=…&token=… (the server sets the download filename).
import { call } from "./api.js";

export const PDF_MAX_WAIT_MS = 60000; // give up after this long in "pending" (Browser Rendering rate limit)

export class PdfWaitError extends Error {
  constructor() {
    super("ระบบกำลังสร้าง PDF หลายไฟล์พร้อมกัน — รอนานเกินไป กรุณาลองใหม่อีกครั้งภายหลัง");
    this.code = "PDF_WAIT_TIMEOUT";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls `action` until it answers "ready" (retrying on "pending" after retry_after s, max PDF_MAX_WAIT_MS in total).
 * @param {(secondsLeft:number)=>void} [onWait] called every second while waiting for a retry
 * @param {(action:string, params:object)=>Promise<object>} [callFn] custom caller (the admin page passes its adminCall wrapper)
 * @returns {Promise<{status:"ready",url:string,filename:string,content_key:string}>}
 */
export async function requestPdfReady(action, params, token, { onWait, callFn } = {}) {
  const started = Date.now();
  for (;;) {
    const r = callFn ? await callFn(action, params) : await call(action, params, { token });
    if (r && r.status === "ready") return r;
    if (!r || r.status !== "pending") throw new Error("คำตอบจาก server ไม่ถูกต้อง");
    const waitS = Math.max(1, Math.min(120, Number(r.retry_after) || 10));
    if (Date.now() - started + waitS * 1000 > PDF_MAX_WAIT_MS) throw new PdfWaitError();
    for (let left = waitS; left > 0; left--) {
      if (onWait) onWait(left);
      await sleep(1000);
    }
  }
}

/** Starts the download through a temporary <a download> click (same origin; the server answers with Content-Disposition: attachment). */
export function startPdfDownload(url, token) {
  const a = document.createElement("a");
  a.href = url + "&token=" + encodeURIComponent(token);
  a.download = "";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

/** Opens the PDF in THIS tab for printing (inline, not a download): no popup blocker on iOS, and the Back button returns to
 *  the app because the tokens live in localStorage. The server answers `Content-Disposition: inline` for `inline=1`. */
export function openPdfInline(url, token) {
  location.assign(url + "&token=" + encodeURIComponent(token) + "&inline=1");
}

export const PDF_FALLBACK_HINT = "กดปุ่ม พิมพ์ แล้วเลือก Save as PDF แทน";
/** Error text + the print → Save as PDF hint (unless the server message already carries it). `esc` = html escaper. */
export function pdfErrorHtml(message, esc) {
  const m = String(message || "สร้าง PDF ไม่สำเร็จ");
  return `<p>${esc(m)}</p>` + (/Save as PDF/.test(m) ? "" : `<p class="muted">${esc(PDF_FALLBACK_HINT)}</p>`);
}
