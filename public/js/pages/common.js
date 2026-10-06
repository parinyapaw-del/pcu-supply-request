// Shared helpers for the PCU pages (home / fill / print / issue): escaping, round + status helpers,
// Thai date formatting, older-month loading and the in-page dialog/toast (no native alert/confirm).
import { call, getPcuToken } from "../api.js";
import { THAI_MONTHS, shortMonthKeyThai } from "../format.js";
import * as sync from "../sync.js";

export function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------- dates ----------------
const BKK_DATETIME = new Intl.DateTimeFormat("th-TH", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok",
});
const BKK_PARTS = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "numeric", year: "numeric", timeZone: "Asia/Bangkok",
});

// "6 ต.ค. 15:30" (Asia/Bangkok) from an ISO string.
export function formatThaiDateTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return "";
  return BKK_DATETIME.format(d).replace(/\s*เวลา\s*/, " ");
}

// Calendar parts of an ISO instant in Asia/Bangkok -> { day, monthName, beYear }.
export function bangkokDateParts(iso) {
  const d = new Date(iso);
  const parts = BKK_PARTS.formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { day: get("day"), monthName: THAI_MONTHS[get("month") - 1], beYear: get("year") + 543 };
}

// "2026-10-31" -> "31 ตุลาคม 2569"
export function formatThaiYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return "";
  return `${Number(m[3])} ${THAI_MONTHS[Number(m[2]) - 1]} ${Number(m[1]) + 543}`;
}

export function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${THAI_MONTHS[m - 1]} ${y + 543}`;
}

export { shortMonthKeyThai };

// "2570" -> "70"
export function fyShort(fy) {
  return String(Number(fy) % 100).padStart(2, "0");
}

// ---------------- rounds / months ----------------
export function pcuCode(app) {
  return app.boot.pcu.code;
}

export function roundOf(app, month) {
  const r = app.boot.rounds.find((x) => x.month === month);
  if (r) return r;
  return (app.older && app.older[month] && app.older[month].round) || null;
}

// Per-month data (request/used_fy/prev_lines/issue) from the bootstrap or a pcuGetMonth result.
export function monthData(app, month) {
  return (app.boot.byMonth && app.boot.byMonth[month]) || (app.older && app.older[month]) || { request: null, used_fy: {}, prev_lines: {}, issue: null };
}

export function unlocksOf(app, month) {
  if (app.boot.unlocks && app.boot.unlocks[month]) return app.boot.unlocks[month];
  return (app.older && app.older[month] && app.older[month].unlocks) || {};
}

// Months shown on the home page as editable rounds (current + previous).
export function isActiveRound(app, month) {
  return app.boot.rounds.some((r) => r.month === month);
}

export function isLocked(app, month) {
  const r = roundOf(app, month);
  const s = sync.getSession(pcuCode(app), month);
  return !!(r && r.locked) || !!(s && s.conflict);
}

// Editable = an active round (current/previous), not locked, server has not refused (CONFLICT).
export function isEditable(app, month) {
  return isActiveRound(app, month) && !isLocked(app, month);
}

// Ceilings/plans in the bootstrap are for fy_current — only meaningful for rounds of that fiscal year.
export function roundUsesCurrentFy(app, month) {
  const r = roundOf(app, month);
  return !!r && r.fy === app.boot.config.fy_current;
}

export function requestOf(app, month) {
  const s = sync.getSession(pcuCode(app), month);
  if (s) return s.request;
  return monthData(app, month).request || null;
}

// Loads a month outside the bootstrap (older months list) via pcuGetMonth and registers a session for it.
export async function loadOlderMonth(app, month) {
  if (app.boot.byMonth[month] || (app.older && app.older[month])) return;
  const data = await call("pcuGetMonth", { month }, { token: getPcuToken() });
  app.older = app.older || {};
  app.older[month] = data;
  // 2d: pcuGetMonth carries the form version bound to that month's request when it differs from the latest.
  if (data.form && data.form.id) {
    app.boot.forms = app.boot.forms || {};
    app.boot.forms[data.form.id] = data.form;
  }
  sync.initSession(pcuCode(app), month, data.request);
}

// 2d: the form version a request should be rendered with. A sent request (no edits after its last send) is bound to
// `request.form_version_id`; drafts and edited requests use the latest form (they are re-bound on the next send).
export function formForRequest(app, request) {
  const latest = app.boot.form;
  if (!request || !request.form_version_id) return latest;
  if (request.status !== "submitted" && request.status !== "issued") return latest;
  if (request.edited_after_submit) return latest;
  const forms = app.boot.forms || {};
  return forms[request.form_version_id] || latest;
}

// ---------------- status badge ----------------
// -> { label, cls, extra: [{label, cls}] }
export function requestStatus(request, round, conflict) {
  const locked = !!(round && round.locked) || !!conflict;
  const base = (() => {
    if (!request || request.status === "not_started") return { label: "ยังไม่เริ่ม", cls: "badge-muted", extra: [] };
    if (request.status === "issued") return { label: "จ่ายแล้ว", cls: "badge-success", extra: [] };
    if (request.status === "submitted") {
      const t = formatThaiDateTime(request.submitted_at);
      const extra = request.edited_after_submit ? [{ label: "มีการแก้ไขยังไม่บันทึก", cls: "badge-warn" }] : [];
      return { label: `ส่งแล้ว${t ? " " + t : ""}`, cls: "badge-success", extra };
    }
    return { label: "กำลังกรอก", cls: "badge-warn", extra: [] };
  })();
  if (locked) return { label: "ล็อกแล้ว", cls: "badge-danger", extra: [{ label: base.label, cls: base.cls }, ...base.extra] };
  return base;
}

// Text for the fill-page status line, e.g. "ส่งแล้ว 6 ต.ค. 15:30 (มีการแก้ไขยังไม่บันทึก)".
export function statusText(request) {
  const s = requestStatus(request, null, false);
  return s.label + (s.extra.length ? ` (${s.extra.map((e) => e.label).join(", ")})` : "");
}

// ---------------- dialog / toast ----------------
let dialogSeq = 0;

/**
 * In-page modal. buttons: [{label, value, primary?}] -> resolves with the clicked value (Esc / backdrop = last "cancel"-like button's value or null).
 */
export function showDialog({ title, html, buttons }) {
  return new Promise((resolve) => {
    const id = `dlg${++dialogSeq}`;
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay no-print";
    overlay.innerHTML = `
      <div class="dialog-box" role="dialog" aria-modal="true" aria-labelledby="${id}-t">
        ${title ? `<h3 id="${id}-t">${esc(title)}</h3>` : ""}
        <div class="dialog-body">${html || ""}</div>
        <div class="dialog-actions">
          ${buttons.map((b, i) => `<button type="button" class="btn ${b.primary ? "btn-primary" : "btn-secondary"}" data-i="${i}">${esc(b.label)}</button>`).join("")}
        </div>
      </div>`;
    const close = (value) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(value);
    };
    const cancelValue = (buttons.find((b) => !b.primary) || buttons[buttons.length - 1]).value;
    const onKey = (ev) => { if (ev.key === "Escape") close(cancelValue); };
    overlay.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-i]");
      if (btn) close(buttons[Number(btn.dataset.i)].value);
      else if (ev.target === overlay) close(cancelValue);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    const primary = overlay.querySelector(".btn-primary") || overlay.querySelector("button");
    if (primary) primary.focus();
  });
}

export function alertDialog(title, html, okLabel = "ตกลง") {
  return showDialog({ title, html, buttons: [{ label: okLabel, value: true, primary: true }] });
}

export function confirmDialog(title, html, okLabel = "ยืนยัน", cancelLabel = "ยกเลิก") {
  return showDialog({
    title,
    html,
    buttons: [{ label: cancelLabel, value: false }, { label: okLabel, value: true, primary: true }],
  });
}

export function toast(message, kind = "ok") {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host no-print";
    host.setAttribute("role", "status");
    document.body.appendChild(host);
  }
  const t = document.createElement("div");
  t.className = `toast toast-${kind}`;
  t.textContent = message;
  host.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
