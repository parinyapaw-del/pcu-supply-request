// Home page (#/home): PCU name + the 2 trial rounds, status/progress, jump into the wizard/print.
import { WIZARD_STEPS } from "../constants.js";
import { loadFormData, getItemRows } from "../data.js";
import * as sync from "../sync.js";

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function currentRequest(app, month) {
  const session = sync.getSession(app.boot.pcu.code, month);
  if (session) return session.request;
  const byRound = app.boot.byRound[month];
  return (byRound && byRound.request) || null;
}

function statusBadge(request) {
  if (!request || request.status === "not_started") return { label: "ยังไม่เริ่ม", cls: "badge-muted" };
  if (request.status === "draft" && request.return_reason) return { label: "ส่งกลับแก้ไข", cls: "badge-danger" };
  if (request.status === "draft") return { label: "แบบร่าง", cls: "badge-warn" };
  if (request.status === "submitted") return { label: "ส่งแล้ว", cls: "badge-success" };
  if (request.status === "received") return { label: "รับเรื่องแล้ว", cls: "badge-success" };
  return { label: request.status, cls: "badge-muted" };
}

function progressOf(app, month, request) {
  const required = 125 - (app.boot.hidden || []).length;
  let filled = 0;
  if (request && request.lines) {
    const hiddenSet = new Set(app.boot.hidden || []);
    app.form.steps.forEach((step) => {
      getItemRows(step).forEach((item) => {
        if (hiddenSet.has(item.code)) return;
        const line = request.lines[item.code];
        if (line && line.stock != null) filled++;
      });
    });
  }
  const stepIdx = request && request.last_step ? WIZARD_STEPS.indexOf(request.last_step) : -1;
  const stepNum = stepIdx >= 0 ? stepIdx + 1 : request && request.status !== "not_started" ? 1 : 0;
  return { filled, required, stepNum, total: WIZARD_STEPS.length };
}

export async function renderHome(container, app) {
  app.form = app.form || (await loadFormData());
  const box = document.createElement("div");
  box.className = "home-page";

  const cardsHtml = app.boot.rounds
    .map((round) => {
      const request = currentRequest(app, round.month);
      const status = statusBadge(request);
      const progress = progressOf(app, round.month, request);
      const started = !!request && request.status !== "not_started";
      const fillLabel = started ? "ทำต่อ" : "กรอก";
      const startStep = request && request.last_step ? request.last_step : "P1";

      return `
      <div class="round-card">
        <div class="round-card-head">
          <h3>${esc(round.label)}${round.next ? ' <span class="badge badge-muted">รอบถัดไป (ทดลอง)</span>' : ""}</h3>
          <span class="badge ${status.cls}">${status.label}</span>
        </div>
        ${request && request.status === "draft" && request.return_reason ? `<div class="notice notice-error">เหตุผลที่ส่งกลับ: ${esc(request.return_reason)}</div>` : ""}
        <p class="muted">กำหนดส่ง: ${esc(round.deadlineLabel)} (ข้อความเท่านั้น ไม่บังคับ)</p>
        <p>ความคืบหน้า: step ${progress.stepNum}/${progress.total} · คงเหลือกรอกแล้ว ${progress.filled}/${progress.required} รายการ</p>
        <div class="round-card-actions">
          <button type="button" class="btn btn-primary" data-fill="${round.month}" data-step="${esc(startStep)}">${fillLabel}</button>
          <button type="button" class="btn btn-secondary" data-print="${round.month}">ดู/พิมพ์</button>
        </div>
      </div>`;
    })
    .join("");

  box.innerHTML = `
    <h2>สวัสดี ${esc(app.boot.pcu.name)}</h2>
    <p class="muted">เลือกรอบที่จะกรอกหรือพิมพ์</p>
    <div class="round-cards">${cardsHtml}</div>
    <p class="home-links"><a href="#/hidden">ตั้งค่ารายการที่ไม่เบิก</a></p>
  `;

  container.innerHTML = "";
  container.appendChild(box);

  box.querySelectorAll("[data-fill]").forEach((btn) => {
    btn.addEventListener("click", () => {
      location.hash = `#/fill/${btn.dataset.step}?month=${btn.dataset.fill}`;
    });
  });
  box.querySelectorAll("[data-print]").forEach((btn) => {
    btn.addEventListener("click", () => {
      location.hash = `#/print?month=${btn.dataset.print}`;
    });
  });
}
