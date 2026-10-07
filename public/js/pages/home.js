// Home page (#/home): one card per round (current + previous month), status badge, deadline, admin note,
// issue-notice bar + "ดูการจ่าย" (2c) and the "older months" expander (phase 2 spec §4.1).
import { getOrderedSteps } from "../data.js";
import {
  esc, pcuCode, requestOf, requestStatus,
  loadOlderMonth, alertDialog, monthData, roundTitle, currentRoundTagHtml, trialBadgeHtml, deadlineText, trialNote,
} from "./common.js";
import * as sync from "../sync.js";

function itemsRequested(request) {
  let n = 0;
  if (request && request.lines) {
    Object.keys(request.lines).forEach((c) => {
      const l = request.lines[c];
      if ((Number(l.op) || 0) + (Number(l.pp) || 0) > 0) n++;
    });
  }
  return n;
}

function stepProgress(app, request) {
  const steps = getOrderedSteps(app.boot.form);
  const idx = request && request.last_step ? steps.findIndex((s) => s.code === request.last_step) : -1;
  const label = idx >= 0 ? (steps[idx].sheet || steps[idx].code) : request && request.status !== "not_started" ? (steps[0].sheet || steps[0].code) : "";
  return { label, n: idx >= 0 ? idx + 1 : request && request.status !== "not_started" ? 1 : 0, total: steps.length };
}

function badgesHtml(st) {
  return `<span class="badge ${st.cls}">${esc(st.label)}</span>` +
    st.extra.map((e) => ` <span class="badge ${e.cls}">${esc(e.label)}</span>`).join("");
}

// 2c: status from IssueInfo — "จ่ายแล้ว" (every needed unit done) or "จ่ายแล้วบางหน่วย (x/y)".
function withIssueStatus(st, issue) {
  if (!issue || !issue.units_done) return st;
  if (issue.done) {
    if (st.label === "จ่ายแล้ว" || st.extra.some((e) => e.label === "จ่ายแล้ว")) return st;
    return { ...st, extra: [...st.extra, { label: "จ่ายแล้ว", cls: "badge-success" }] };
  }
  return { ...st, extra: [...st.extra, { label: `จ่ายแล้วบางหน่วย (${issue.units_done}/${issue.units_total})`, cls: "badge-warn" }] };
}

function cardHtml(app, round) {
  const request = requestOf(app, round.month);
  const session = sync.getSession(pcuCode(app), round.month);
  const issue = monthData(app, round.month).issue;
  const st = withIssueStatus(requestStatus(request, round, session && session.conflict), issue);
  const locked = round.locked || !!(session && session.conflict);
  const started = !!request && request.status !== "not_started";
  const prog = stepProgress(app, request);
  const startStep = request && request.last_step ? request.last_step : getOrderedSteps(app.boot.form)[0].code;
  const note = request && request.admin_note ? request.admin_note : "";
  const n = itemsRequested(request);

  return `
  <div class="round-card${locked ? " round-card-locked" : ""}" data-month="${esc(round.month)}">
    <div class="round-card-head">
      <h3>${round.trial ? "ทดลองกรอก — " : ""}${esc(roundTitle(round.month))} <span class="muted fy-tag">ปีงบ ${esc(round.fy)}</span>${trialBadgeHtml(round)}${currentRoundTagHtml(app, round.month)}</h3>
      <span class="round-status">${badgesHtml(st)}</span>
    </div>
    ${note ? `<div class="admin-note-box"><strong>ข้อความจากผู้ดูแล:</strong> ${esc(note)}</div>` : ""}
    <p class="muted deadline-line">${locked ? "รอบนี้ปิดรับแล้ว" : esc(deadlineText(round))}</p>
    ${round.trial ? `<p class="trial-note">${esc(trialNote(round))}</p>` : ""}
    ${started ? `<p>ขอเบิกแล้ว ${n} รายการ · ขั้นตอน ${prog.n}/${prog.total}${prog.label ? ` (${esc(prog.label)})` : ""}</p>` : ""}
    <div class="round-card-actions">
      ${locked
        ? `<button type="button" class="btn btn-secondary" data-fill="${esc(round.month)}" data-step="summary">ดูใบเบิก</button>`
        : `<button type="button" class="btn btn-primary" data-fill="${esc(round.month)}" data-step="${esc(startStep)}">${started ? "ทำต่อ" : "กรอก"}</button>`}
      <button type="button" class="btn btn-secondary" data-print="${esc(round.month)}">ดู/พิมพ์</button>
      ${issue && issue.units_done > 0 ? `<a class="btn btn-secondary" href="#/issue?month=${esc(round.month)}" data-issue="${esc(round.month)}">ดูการจ่าย</a>` : ""}
    </div>
  </div>`;
}

function collapsedHtml(app, round) {
  const issue = monthData(app, round.month).issue;
  return `
  <details class="round-card round-card-collapsed" data-month="${esc(round.month)}">
    <summary><strong>${esc(roundTitle(round.month))}</strong>${trialBadgeHtml(round)} <span class="badge badge-danger">ปิดรับแล้ว</span></summary>
    <div class="round-card-actions">
      <button type="button" class="btn btn-secondary" data-fill="${esc(round.month)}" data-step="summary">ดูใบเบิก</button>
      <button type="button" class="btn btn-secondary" data-print="${esc(round.month)}">ดู/พิมพ์</button>
      ${issue && issue.units_done > 0 ? `<a class="btn btn-secondary" href="#/issue?month=${esc(round.month)}">ดูการจ่าย</a>` : ""}
    </div>
  </details>`;
}

function noticesHtml(app) {
  const list = app.boot.issue_notices || [];
  return list
    .map((n) => `<div class="notice-bar" role="status" data-notice="${esc(n.month)}"><span>พัสดุจ่ายของรอบ ${esc(roundTitle(n.month))} แล้ว — ครบ ${esc(n.complete)} รายการ · ไม่ครบ ${esc(n.incomplete)} รายการ</span>
      <a href="#/issue?month=${esc(n.month)}" class="btn btn-sm btn-secondary">ดูรายละเอียด</a></div>`)
    .join("");
}

export async function renderHome(container, app) {
  const box = document.createElement("div");
  box.className = "home-page";

  const rounds = app.boot.rounds;
  const cards = rounds
    .map((r, i) => (i > 0 && r.locked ? collapsedHtml(app, r) : cardHtml(app, r)))
    .join("");
  const older = app.boot.older_months || [];

  const pinWarnHtml = app.boot.pcu.pin_custom === false
    ? `<div class="notice-bar notice-bar-warn" role="status"><span>ยังใช้ PIN ตั้งต้น — แนะนำให้เปลี่ยน PIN ของ รพ.สต. เพื่อความปลอดภัย</span><a href="#/pin" class="btn btn-sm btn-secondary">เปลี่ยน PIN</a></div>`
    : "";

  box.innerHTML = `
    ${pinWarnHtml}
    ${noticesHtml(app)}
    <h2>สวัสดี ${esc(app.boot.pcu.name)}</h2>
    <p class="muted">เลือกรอบที่จะกรอกหรือพิมพ์ · ปีงบประมาณ ${esc(app.boot.config.fy_current)}</p>
    <div class="round-cards">${cards}</div>
    ${older.length ? `
    <details class="older-months">
      <summary>ดูเดือนเก่า (${older.length})</summary>
      <div class="older-list">
        ${older.map((m) => `<div class="older-row"><span>${esc(roundTitle(m))}</span>
          <span><button type="button" class="btn btn-secondary btn-sm" data-older="${esc(m)}" data-go="summary">ดูใบเบิก</button>
          <button type="button" class="btn btn-secondary btn-sm" data-older="${esc(m)}" data-go="print">ดู/พิมพ์</button></span></div>`).join("")}
      </div>
    </details>` : ""}
    <p class="home-links"><a href="#/hidden">ตั้งค่ารายการที่ไม่เบิก</a> · <a href="#/pin">เปลี่ยน PIN</a></p>
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
  box.querySelectorAll("[data-older]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await loadOlderMonth(app, btn.dataset.older);
        location.hash = btn.dataset.go === "print"
          ? `#/print?month=${btn.dataset.older}`
          : `#/fill/summary?month=${btn.dataset.older}`;
      } catch (err) {
        btn.disabled = false;
        if (err && String(err.code || "").startsWith("AUTH_")) throw err;
        await alertDialog("เปิดเดือนนี้ไม่สำเร็จ", `<p>${esc(err.message || "")}</p>`);
      }
    });
  });
}
