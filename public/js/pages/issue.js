// Issue detail (#/issue?month=YYYY-MM) — phase 2 spec §4.1 (Q77), checkpoint 2c.
// Rows = requested items (ขอ > 0) in form order: รายการ · ขอ OP/PP · ได้ OP/PP · เหตุผล.
// "ได้" comes from request.issued[code] (pcuGetMonth / pcuBootstrap) which only carries lines of units that are
// marked done — other units show "—" (ยังไม่จ่าย). "รับทราบ" (pcuAck) only when every needed unit is done.
import { call, getPcuToken } from "../api.js";
import { getOrderedSteps } from "../data.js";
import { formatInt } from "../format.js";
import { esc, monthData, monthLabel, loadOlderMonth, alertDialog, formForRequest, formatThaiDateTime, toast } from "./common.js";

const UNITS = ["พัสดุ", "จ่ายกลาง", "LAB"];
const REASON = { out_of_stock: "ของหมด/รอจัดซื้อ", other: "อื่น ๆ" };

function unitOfStep(step) {
  if (step.dispense_unit) return step.dispense_unit;
  if (step.code === "CS") return "จ่ายกลาง";
  if (step.code === "LAB") return "LAB";
  return "พัสดุ";
}

function reasonText(g) {
  if (!g || !g.reason) return "";
  if (g.reason === "other") return `อื่น ๆ${g.note ? ": " + g.note : ""}`;
  return REASON[g.reason] || g.reason;
}

// Fresh copy of the month (the bootstrap may be older than the admin's last write); falls back to cached data.
async function freshMonth(app, month) {
  try {
    const data = await call("pcuGetMonth", { month }, { token: getPcuToken() });
    const md = monthData(app, month);
    if (app.boot.byMonth && app.boot.byMonth[month]) {
      app.boot.byMonth[month].issue = data.issue;
      if (md.request && data.request) md.request.issued = data.request.issued;
    } else {
      app.older = app.older || {};
      if (app.older[month]) Object.assign(app.older[month], { issue: data.issue, request: data.request });
    }
    return { request: data.request, issue: data.issue };
  } catch (err) {
    if (err && String(err.code || "").startsWith("AUTH_")) throw err;
    const md = monthData(app, month);
    return { request: md.request, issue: md.issue };
  }
}

export async function renderIssue(container, app, params) {
  const month = params.get("month") || (app.boot.rounds[0] && app.boot.rounds[0].month);
  await loadOlderMonth(app, month);
  const { request, issue } = await freshMonth(app, month);
  const issued = (request && request.issued) || {};
  const units = (issue && issue.units) || {};

  // requested lines in form order, grouped by page
  const form = formForRequest(app, request);
  const groups = [];
  const seen = new Set();
  getOrderedSteps(form).forEach((step) => {
    const unit = unitOfStep(step);
    const rows = [];
    (step.rows || []).forEach((r) => {
      if (r.type !== "item" || seen.has(r.code)) return;
      const l = request && request.lines && request.lines[r.code];
      const op = l ? Number(l.op) || 0 : 0, pp = l ? Number(l.pp) || 0 : 0;
      if (op + pp <= 0) return;
      seen.add(r.code);
      rows.push({ code: r.code, name: r.name, unit: r.unit, op, pp, got: issued[r.code] || null });
    });
    if (rows.length) groups.push({ step, unit, done: !!(units[unit] && units[unit].done), rows });
  });
  // lines whose code is not in the form any more (should not happen; keep them visible)
  const extra = Object.entries((request && request.lines) || {})
    .filter(([code, l]) => !seen.has(code) && (Number(l.op) || 0) + (Number(l.pp) || 0) > 0)
    .map(([code, l]) => ({ code, name: code, unit: "", op: Number(l.op) || 0, pp: Number(l.pp) || 0, got: issued[code] || null }));
  if (extra.length) groups.push({ step: { sheet: "อื่น ๆ", code: "?" }, unit: "", done: false, rows: extra });

  let complete = 0, incomplete = 0;
  groups.forEach((g) => g.rows.forEach((r) => {
    if (!r.got) return;
    if (Number(r.got.total) >= r.op + r.pp) complete++; else incomplete++;
  }));

  const unitLine = UNITS.filter((u) => units[u] && units[u].needed)
    .map((u) => `<span class="badge ${units[u].done ? "badge-success" : "badge-muted"}">${esc(u)} ${units[u].done ? "จ่ายแล้ว" : "ยังไม่จ่าย"}</span>`)
    .join(" ");

  const tableHtml = groups.map((g) => `
    <tr class="issue-group-row"><td colspan="4">${esc(g.step.sheet || g.step.title || g.step.code)}${g.unit ? ` · ${esc(g.unit)}` : ""}
      ${g.unit ? `<span class="badge ${g.done ? "badge-success" : "badge-muted"}">${g.done ? "จ่ายแล้ว" : "ยังไม่จ่าย"}</span>` : ""}</td></tr>
    ${g.rows.map((r) => {
      const short = r.got && Number(r.got.total) < r.op + r.pp;
      return `<tr class="${short ? "issue-short" : ""}" data-code="${esc(r.code)}">
        <td class="issue-name">${esc(r.name)}${r.unit ? ` <span class="muted">(${esc(r.unit)})</span>` : ""}</td>
        <td class="num">${formatInt(r.op)} / ${formatInt(r.pp)}</td>
        <td class="num">${r.got ? `<strong>${formatInt(r.got.op)} / ${formatInt(r.got.pp)}</strong>` : '<span class="muted">—</span>'}</td>
        <td class="issue-reason">${r.got ? (short ? esc(reasonText(r.got)) : '<span class="muted">ครบ</span>') : '<span class="muted">ยังไม่จ่าย</span>'}</td>
      </tr>`;
    }).join("")}`).join("");

  const box = document.createElement("div");
  box.className = "issue-page";
  const acked = request && request.issued_seen_at;
  box.innerHTML = `
    <h2>การจ่ายวัสดุ ${esc(monthLabel(month))}</h2>
    ${issue
      ? `<p class="issue-summary" id="issue-summary">จ่ายแล้ว ${esc(issue.units_done)}/${esc(issue.units_total)} หน่วย — ครบ ${complete} · ไม่ครบ ${incomplete} รายการ</p>
         ${unitLine ? `<p class="issue-units">${unitLine}</p>` : ""}`
      : `<p class="muted">ยังไม่มีข้อมูลการจ่ายของเดือนนี้</p>`}
    ${groups.length ? `
    <div class="issue-table-wrap">
      <table class="issue-table" id="issue-table">
        <thead><tr><th>รายการ</th><th class="num">ขอ<br><span class="muted">OP / PP</span></th><th class="num">ได้<br><span class="muted">OP / PP</span></th><th>เหตุผล</th></tr></thead>
        <tbody>${tableHtml}</tbody>
      </table>
    </div>` : `<p class="muted">ใบเบิกเดือนนี้ไม่มีรายการที่ขอ</p>`}
    ${acked ? `<p class="muted" id="issue-acked">รับทราบแล้ว ${esc(formatThaiDateTime(request.issued_seen_at))}</p>` : ""}
    <div class="summary-actions">
      <button type="button" class="btn btn-secondary" id="btn-issue-back">กลับหน้าหลัก</button>
      ${issue && issue.done && !acked ? '<button type="button" class="btn btn-primary" id="btn-ack">รับทราบ</button>' : ""}
    </div>`;
  container.innerHTML = "";
  container.appendChild(box);

  box.querySelector("#btn-issue-back").addEventListener("click", () => { location.hash = "#/home"; });
  const ack = box.querySelector("#btn-ack");
  if (ack) {
    ack.addEventListener("click", async () => {
      ack.disabled = true;
      try {
        const res = await call("pcuAck", { month }, { token: getPcuToken() });
        app.boot.issue_notices = (app.boot.issue_notices || []).filter((n) => n.month !== month);
        const md = monthData(app, month);
        if (md.request) md.request.issued_seen_at = res.issued_seen_at;
        if (md.issue) md.issue.issued_seen_at = res.issued_seen_at;
        toast("รับทราบแล้ว");
        location.hash = "#/home";
      } catch (err) {
        ack.disabled = false;
        await alertDialog("รับทราบไม่สำเร็จ", `<p>${esc(err.message || "")}</p>`);
      }
    });
  }
}
