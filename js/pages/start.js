// Start page: choose PCU + month, see current status, jump into the wizard or print.
import * as store from "../store.js";
import { formatMonthKeyThai } from "../format.js";

function computeStatus(request, round) {
  if (!request) return { label: "ยังไม่เริ่ม", cls: "badge-muted" };
  if (request.status === "submitted") {
    return request.late
      ? { label: "ส่งแล้ว (ส่งช้า)", cls: "badge-danger" }
      : { label: "ส่งแล้ว", cls: "badge-success" };
  }
  return { label: "แบบร่าง", cls: "badge-warn" };
}

function defaultRound(rounds) {
  const now = new Date();
  const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return rounds.find((r) => r.monthKey === nowKey) || rounds[0];
}

export async function renderStart(container, app) {
  const savedPcu = store.getLastPcu();
  let selectedPcu = app.pcu || savedPcu || app.form.pcus[0].code;
  let selectedMonth = app.monthKey || defaultRound(app.rounds).monthKey;

  const box = document.createElement("div");
  box.className = "start-page";
  box.innerHTML = `
    <h2>เลือก รพ.สต. และรอบเดือนที่จะเบิก</h2>
    <div class="field-row">
      <label class="field-label" for="pcu-select">โรงพยาบาลส่งเสริมสุขภาพตำบล</label>
      <select id="pcu-select" class="select-input">
        ${app.form.pcus.map((p) => `<option value="${p.code}" ${p.code === selectedPcu ? "selected" : ""}>${p.code} — ${escapeHtml(p.name)}${p.group === "พิเศษ" ? " (พิเศษ)" : ""}</option>`).join("")}
      </select>
    </div>
    <div class="field-row">
      <label class="field-label" for="month-select">รอบเดือน</label>
      <select id="month-select" class="select-input">
        ${app.rounds.map((r) => `<option value="${r.monthKey}" ${r.monthKey === selectedMonth ? "selected" : ""}>${r.label} (กำหนดส่ง ${r.deadlineLabel})</option>`).join("")}
      </select>
    </div>
    <div class="status-card" id="status-card"></div>
    <div class="start-actions">
      <button type="button" class="btn btn-primary" id="btn-go">ไปกรอกใบเบิก</button>
      <button type="button" class="btn btn-secondary" id="btn-print-jump">ไปหน้าพิมพ์</button>
    </div>
  `;

  container.innerHTML = "";
  container.appendChild(box);

  function refreshStatus() {
    const req = store.getRequest(selectedPcu, selectedMonth);
    const round = app.rounds.find((r) => r.monthKey === selectedMonth);
    const status = computeStatus(req, round);
    document.getElementById("status-card").innerHTML =
      `สถานะแบบฟอร์มของ <strong>${escapeHtml(selectedPcu)}</strong> เดือน <strong>${formatMonthKeyThai(selectedMonth)}</strong>: ` +
      `<span class="badge ${status.cls}">${status.label}</span>`;
  }
  refreshStatus();

  document.getElementById("pcu-select").addEventListener("change", (ev) => {
    selectedPcu = ev.target.value;
    store.setLastPcu(selectedPcu);
    refreshStatus();
  });
  document.getElementById("month-select").addEventListener("change", (ev) => {
    selectedMonth = ev.target.value;
    refreshStatus();
  });

  document.getElementById("btn-go").addEventListener("click", () => {
    store.setLastPcu(selectedPcu);
    location.hash = `#/fill/P1?pcu=${selectedPcu}&month=${selectedMonth}`;
  });
  document.getElementById("btn-print-jump").addEventListener("click", () => {
    store.setLastPcu(selectedPcu);
    location.hash = `#/print?pcu=${selectedPcu}&month=${selectedMonth}`;
  });
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
