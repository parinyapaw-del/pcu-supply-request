// Brief 2q — PCU dashboard (#/dashboard): ขอเบิก / ได้รับจริง / ใช้ไป per round + FY cumulative, by quantity or baht,
// unit-group breakdown, top 10 and a searchable per-item table. Data = pcuDashboard{fy} (fetched when the page opens,
// not part of the bootstrap). Charts / KPI / table live in dashboard_parts.js (shared with the admin per-PCU view, brief 2s).
import { call, getPcuToken } from "../api.js";
import * as auth from "../auth.js";
import { esc } from "./common.js";
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
    createBody(box, data, { hiddenLink: true }).bind();
  }

  await load(null, false);
}
