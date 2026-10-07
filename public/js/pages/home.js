// Home page (#/home): one card per round (current + previous month), status badge, deadline, admin note,
// issue-notice bar + "ดูการจ่าย" (2c). Brief 2l: round timeline for the whole fiscal year (preview of the next round,
// editable cards, read-only history rows incl. "ไม่ได้ส่ง") + a fiscal-year dropdown reaching back one year.
import { getOrderedSteps } from "../data.js";
import {
  esc, pcuCode, requestOf, requestStatus,
  loadOlderMonth, alertDialog, monthData, roundTitle, currentRoundTagHtml, trialBadgeHtml, deadlineText, trialNote,
} from "./common.js";
import * as sync from "../sync.js";
import { fiscalYearOf, fiscalYearStartMonthKey, prevMonthKey } from "../format.js";
import { formatThaiYmd, formatThaiShortDate } from "./common.js";

// Brief 2l: fiscal year shown on the home page (null = the current one). Module-level; reset when boot changes.
let selectedFy = null;
let selectedFyBoot = null;

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

function previewHtml(next) {
  return `
  <div class="round-card round-card-preview" data-month="${esc(next.month)}">
    <div class="round-card-head">
      <h3>${esc(roundTitle(next.month))} <span class="muted fy-tag">ปีงบ ${esc(next.fy)}</span></h3>
      <span class="round-status"><span class="badge badge-info">รอบถัดไป</span></span>
    </div>
    <p class="muted deadline-line">เปิดให้กรอกตั้งแต่ ${esc(formatThaiYmd(next.opens_on))} · ส่งภายใน ${esc(formatThaiYmd(next.deadline_date))}</p>
    <div class="round-card-actions">
      <button type="button" class="btn btn-primary" disabled>กรอก</button>
    </div>
  </div>`;
}

function historyStatusBadge(h) {
  if (h.status === "issued") return '<span class="badge badge-success">จ่ายแล้ว</span>';
  if (h.status === "submitted") {
    const d = h.submitted_at ? formatThaiShortDate(h.submitted_at) : "";
    return `<span class="badge badge-success">ส่งแล้ว${d ? ` ${esc(d)}` : ""}</span>`;
  }
  return '<span class="badge badge-warn">กำลังกรอก</span>';
}

function historyRowHtml(h) {
  const title = `<strong>${esc(roundTitle(h.month))}</strong>${trialBadgeHtml(h)}`;
  if (h.status === "not_started") {
    return `
  <div class="round-card round-card-collapsed round-row-none" data-month="${esc(h.month)}">
    <span>${title}</span><span class="badge badge-muted">ไม่ได้ส่ง</span>
  </div>`;
  }
  return `
  <details class="round-card round-card-collapsed" data-month="${esc(h.month)}">
    <summary>${title} ${historyStatusBadge(h)} <span class="badge badge-danger">ปิดรับแล้ว</span></summary>
    <div class="round-card-actions">
      <button type="button" class="btn btn-secondary" data-older="${esc(h.month)}" data-go="summary">ดูใบเบิก</button>
      <button type="button" class="btn btn-secondary" data-older="${esc(h.month)}" data-go="print">ดู/พิมพ์</button>
      ${h.status === "issued" ? `<a class="btn btn-secondary" href="#/issue?month=${esc(h.month)}">ดูการจ่าย</a>` : ""}
    </div>
  </details>`;
}

// Cards for fiscal year V (brief 2l §4.1): preview (V===F only) -> editable rounds -> history rows (+ the trial round).
function cardsHtml(app, V, F) {
  const b = app.boot;
  const parts = [];
  if (V === F && b.next_round) parts.push(previewHtml(b.next_round));
  (b.rounds || []).forEach((r, i) => {
    if (V !== F && r.fy !== V) return;
    parts.push(i > 0 && r.locked ? collapsedHtml(app, r) : cardHtml(app, r));
  });
  const trialMonth = prevMonthKey(fiscalYearStartMonthKey(V));
  const shown = new Set((b.rounds || []).map((r) => r.month));
  (b.history || [])
    .filter((h) => (h.fy === V || (h.trial && h.month === trialMonth)) && !(V === F && shown.has(h.month)))
    .sort((a, c) => (a.month < c.month ? 1 : a.month > c.month ? -1 : 0))
    .forEach((h) => parts.push(historyRowHtml(h)));
  return parts.join("");
}

function fyLineHtml(V, F, hasPrev) {
  const select = hasPrev
    ? ` <select class="fy-select" aria-label="เลือกปีงบประมาณ">
        <option value="${F}"${V === F ? " selected" : ""}>ปีงบ ${F}</option>
        <option value="${F - 1}"${V === F - 1 ? " selected" : ""}>ปีงบ ${F - 1}</option>
      </select>`
    : "";
  return `เลือกรอบที่จะกรอกหรือพิมพ์ · ปีงบประมาณ ${esc(V)}${select}`;
}

export async function renderHome(container, app) {
  const box = document.createElement("div");
  box.className = "home-page";

  const F = fiscalYearOf(app.boot.current_round || (app.boot.rounds[0] && app.boot.rounds[0].month));
  if (selectedFyBoot !== app.boot || (selectedFy !== F && selectedFy !== F - 1)) {
    selectedFy = F;
    selectedFyBoot = app.boot;
  }
  const trialMonth = (app.boot.config && app.boot.config.trial_month) || null;
  const hasPrevFy = (app.boot.history || []).some(
    (h) => h.fy === F - 1 && h.month !== trialMonth && h.status !== "not_started");
  if (!hasPrevFy) selectedFy = F;

  const pinWarnHtml = app.boot.pcu.pin_custom === false
    ? `<div class="notice-bar notice-bar-warn" role="status"><span>ยังใช้ PIN ตั้งต้น — แนะนำให้เปลี่ยน PIN ของ รพ.สต. เพื่อความปลอดภัย</span><a href="#/pin" class="btn btn-sm btn-secondary">เปลี่ยน PIN</a></div>`
    : "";

  box.innerHTML = `
    ${pinWarnHtml}
    ${noticesHtml(app)}
    <h2>สวัสดี ${esc(app.boot.pcu.name)}</h2>
    <p class="muted fy-line">${fyLineHtml(selectedFy, F, hasPrevFy)}</p>
    <div class="round-cards">${cardsHtml(app, selectedFy, F)}</div>
    <p class="home-links"><a href="#/hidden">ตั้งค่ารายการที่ไม่เบิก</a> · <a href="#/pin">เปลี่ยน PIN</a></p>
  `;

  container.innerHTML = "";
  container.appendChild(box);

  function bindCards(scope) {
    scope.querySelectorAll("[data-fill]").forEach((btn) => {
      btn.addEventListener("click", () => {
        location.hash = `#/fill/${btn.dataset.step}?month=${btn.dataset.fill}`;
      });
    });
    scope.querySelectorAll("[data-print]").forEach((btn) => {
      btn.addEventListener("click", () => {
        location.hash = `#/print?month=${btn.dataset.print}`;
      });
    });
    scope.querySelectorAll("[data-older]").forEach((btn) => {
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

  const cardsBox = box.querySelector(".round-cards");
  bindCards(cardsBox);

  const sel = box.querySelector(".fy-select");
  if (sel) {
    sel.addEventListener("change", () => {
      selectedFy = Number(sel.value);
      cardsBox.innerHTML = cardsHtml(app, selectedFy, F);
      bindCards(cardsBox);
      // Keep the <select> element (and its focus); only the label text before it changes.
      const line = box.querySelector(".fy-line");
      const text = line.firstChild;
      if (text && text.nodeType === 3) text.nodeValue = `เลือกรอบที่จะกรอกหรือพิมพ์ · ปีงบประมาณ ${selectedFy} `;
    });
  }
}
