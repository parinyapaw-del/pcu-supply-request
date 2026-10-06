// print_shell.js — standalone print page for the server-side PDF (public/print.html?k=<print token>).
// Calls printData{k}, renders every printable step with the same page builder as the in-app print route, waits for the
// fonts, then marks the wrapper `.print-ready` (Browser Rendering waits for that selector). On failure it renders the error
// text and marks `.print-error` instead, so the renderer times out and the server answers PDF_FAILED.
import { call } from "./api.js";
import { renderAllPages, fitPrintPages } from "./pages/print.js";

const root = document.getElementById("print-root");

function fail(message) {
  const box = document.createElement("div");
  box.className = "print-error";
  box.style.cssText = "font:16px sans-serif;padding:24px;color:#900";
  box.textContent = message;
  root.innerHTML = "";
  root.appendChild(box);
}

async function main() {
  const k = new URLSearchParams(location.search).get("k");
  if (!k) throw new Error("ไม่พบรหัสพิมพ์ (k)");
  const data = await call("printData", { k });
  if (!data.form || !data.request) throw new Error("ไม่พบข้อมูลใบเบิก");
  const wrap = document.createElement("div");
  wrap.className = "print-wrap";
  const pages = document.createElement("div");
  pages.id = "print-pages";
  wrap.appendChild(pages);
  root.innerHTML = "";
  root.appendChild(wrap);
  renderAllPages(pages, data.form, data.request, data.pcu, data.hidden || [], data.month);
  // the PDF must embed TH Sarabun New: wait until both faces are loaded for the text that is on the page
  await Promise.all([document.fonts.load('16px "TH Sarabun New"'), document.fonts.load('bold 16px "TH Sarabun New"')]);
  await document.fonts.ready;
  fitPrintPages(pages); // row heights can change once TH Sarabun New is in
  wrap.classList.add("print-ready");
}

main().catch((e) => fail("สร้างหน้าพิมพ์ไม่สำเร็จ: " + (e && e.message ? e.message : String(e))));
