// Brief 2q — PCU dashboard (#/dashboard): ขอเบิก / ได้รับจริง / ใช้ไป per round + FY cumulative, by quantity or baht,
// unit-group breakdown, top 10 and a searchable per-item table. Data = pcuDashboard{fy} (fetched when the page opens,
// not part of the bootstrap). Charts / KPI / table live in dashboard_parts.js (shared with the admin per-PCU view, brief 2s).
import { call, getPcuToken } from "../api.js";
import { getXLSX, requestRows, yearWorkbook, saveWorkbook, safeName } from "../xlsx_export.js";
import * as auth from "../auth.js";
import { esc, formForRequest, alertDialog } from "./common.js";
import { ui, ROW_PAGE, controlsHtml, bodyShellHtml, createBody } from "./dashboard_parts.js";
import { isEmpty, unitGroups } from "./dashboard_calc.js";

export async function renderDashboard(container, app) {
  const box = document.createElement("div");
  box.className = "dash-page";
  container.innerHTML = "";
  container.appendChild(box);
  ui.search = "";
  ui.limit = ROW_PAGE;
  ui.showAll = false;

  let data = null;
  let seq = 0;

  const headHtml = `
    <p class="dash-back"><a href="#/home">← กลับหน้าหลัก</a></p>
    <h2>📊 แดชบอร์ดการเบิก</h2>`;

  // 2ag: whole fy as XLSX — one pcuGetMonth per sent round (<= 12 calls, 4 at a time), built in the browser.
  async function downloadYearXlsx() {
    try {
      // rounds after the current one are not readable yet (pcuGetMonth BAD_REQUEST "เดือนนี้ยังไม่ถึง")
      const cur = app.boot.rounds && app.boot.rounds[0] ? app.boot.rounds[0].month : "9999-99";
      const months = (data.rounds || []).filter((m) => /^\d{4}-\d{2}$/.test(m) && m <= cur);
      const loaded = new Array(months.length);
      for (let i = 0; i < months.length; i += 4) {
        await Promise.all(months.slice(i, i + 4).map(async (m, j) => {
          loaded[i + j] = await call("pcuGetMonth", { month: m }, { token: getPcuToken() });
        }));
      }
      const entries = [];
      months.forEach((month, i) => {
        const d = loaded[i], req = d && d.request;
        if (!req || !(req.status === "submitted" || req.status === "issued")) return;
        if (d.form && d.form.id) { app.boot.forms = app.boot.forms || {}; app.boot.forms[d.form.id] = d.form; }
        const form = formForRequest(app, req);
        const base = {};
        (form.steps || []).forEach((st) => (st.rows || []).forEach((r) => { if (r.type === "item") base[r.code] = r.price; }));
        const over = (d.prices && d.prices[month]) || {};
        entries.push({ month, rows: requestRows(req, form, (code) => (over[code] != null ? over[code] : base[code])) });
      });
      if (!entries.length) { await alertDialog("ดาวน์โหลด Excel", "<p>ยังไม่มีใบเบิกที่ส่งแล้วในปีงบนี้</p>"); return; }
      const XLSX = await getXLSX();
      const pcu = app.boot.pcu;
      saveWorkbook(XLSX, yearWorkbook(XLSX, entries), `ใบเบิก_${safeName(pcu.print_name || pcu.name || pcu.code)}_ปีงบ${data.fy}.xlsx`);
    } catch (err) {
      await alertDialog("ดาวน์โหลด Excel ไม่สำเร็จ", `<p>${esc((err && err.message) || "ลองใหม่อีกครั้ง")}</p>`);
    }
  }

  async function load(fy, fromEvent) {
    const my = ++seq;
    if (!data) box.innerHTML = `${headHtml}<p class="muted" role="status">กำลังโหลดข้อมูล...</p>`;
    else box.classList.add("is-loading");
    let d;
    try {
      d = await call("pcuDashboard", fy ? { fy } : {}, { token: getPcuToken() });
    } catch (err) {
      if (auth.isAuthError(err)) {
        if (fromEvent) window.dispatchEvent(new HashChangeEvent("hashchange"));
        throw err;
      }
      if (my !== seq || !box.isConnected) return;
      box.classList.remove("is-loading");
      box.innerHTML = `${headHtml}
        <div class="notice notice-error" role="alert">โหลดแดชบอร์ดไม่สำเร็จ: ${esc(err.message || "เกิดข้อผิดพลาด")}</div>
        <p><button type="button" class="btn btn-secondary" id="dash-retry">ลองใหม่</button></p>`;
      box.querySelector("#dash-retry").addEventListener("click", () => load(fy, true));
      return;
    }
    if (my !== seq || !box.isConnected) return;
    box.classList.remove("is-loading");
    data = d;
    if (ui.unit !== "all" && !unitGroups(d).includes(ui.unit)) ui.unit = "all";
    renderPage();
  }

  function renderPage() {
    const groups = unitGroups(data);
    const empty = isEmpty(data);
    box.innerHTML = `
      ${headHtml}
      <p class="muted dash-sub">ปีงบประมาณ ${esc(data.fy)} · นับเฉพาะใบเบิกที่ส่งแล้ว (ไม่รวมฉบับร่างและรอบทดลอง)</p>
      ${controlsHtml(data, groups)}
      ${empty ? `<div class="notice notice-info dash-empty" role="status">ยังไม่มีข้อมูลการเบิกในปีงบ ${esc(data.fy)} — เมื่อส่งใบเบิกแล้ว ข้อมูลจะแสดงที่นี่</div>` : bodyShellHtml()}`;

    const sel = box.querySelector(".dash-fy");
    if (sel) sel.addEventListener("change", () => load(Number(sel.value), true));
    if (empty) return;
    createBody(box, data, { hiddenLink: true, xlsx: downloadYearXlsx }).bind();
  }

  await load(null, false);
}
