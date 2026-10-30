// Tab 16 — รับของไม่ตรง (2af, admin only; functions/API.md §5.8 adminReceivedReport): lines where what the รพ.สต. reported it received
// differs from the issue recorded by the dispenser / admin (both figures are kept — nobody overwrites the other side).
// Filters: round of the selected fy (or the whole fy) · รพ.สต. · "แสดงทุกรายการที่แจ้ง" (all reported lines, not only mismatches) · CSV (client side).
import { el, escapeHtml, toast, errMessage, tableScroll, downloadBlob, formatBangkokDateTime } from "./util.js";
import { formatInt } from "../format.js";
import { csvField } from "../pages/dashboard_calc.js";

const REASON = { out_of_stock: "ของหมด/รอจัดซื้อ", other: "อื่น ๆ" };

export function renderTab16(container, ctx) {
  const { state } = ctx;
  let data = null;
  container.innerHTML = "";
  const card = el("div", { class: "admin-card", id: "t16-card" });
  container.appendChild(card);
  card.appendChild(el("h2", {}, "รับของไม่ตรง (รพ.สต. แจ้งได้รับ ≠ ผู้จ่ายบันทึก)"));
  card.appendChild(el("p", { class: "admin-note" },
    "รพ.สต. แจ้งยอดได้รับจริงเองที่หน้า \"รายงานของได้จริง\" (ไม่บังคับ) · แสดงเฉพาะรายการที่มีทั้งสองฝั่งแล้วตัวเลขต่างกัน · ต่าง = รพ.สต. แจ้ง − ผู้จ่ายบันทึก · ตัวเลขทั้งสองฝั่งเก็บแยก ไม่มีใครเขียนทับกัน"));

  const monthSel = el("select", { class: "select-input", id: "t16-month" });
  const pcuSel = el("select", { class: "select-input", id: "t16-pcu" });
  const allChk = el("input", { type: "checkbox", id: "t16-all" });
  const csvBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t16-csv" }, "ส่งออก CSV");
  card.appendChild(el("div", { class: "admin-toolbar" }, [
    el("label", {}, ["รอบ ", monthSel]), el("label", {}, ["รพ.สต. ", pcuSel]),
    el("label", {}, [allChk, " แสดงทุกรายการที่แจ้ง"]), csvBtn,
  ]));
  const out = el("div", { id: "t16-out" });
  card.appendChild(out);

  function fillFilters() {
    const fy = ctx.fySelected() || ctx.fyCurrent();
    const keepM = monthSel.value, keepP = pcuSel.value;
    monthSel.innerHTML = `<option value="">ทั้งปีงบ ${escapeHtml(fy)}</option>` + ctx.fyMonths().map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(ctx.monthLabel(m))}</option>`).join("");
    pcuSel.innerHTML = `<option value="">ทุกแห่ง</option>` + state.bootstrap.pcus.map((p) => `<option value="${escapeHtml(p.code)}">${escapeHtml(p.code)} ${escapeHtml(p.name)}</option>`).join("");
    if ([...monthSel.options].some((o) => o.value === keepM)) monthSel.value = keepM;
    pcuSel.value = keepP;
  }

  async function load() {
    out.innerHTML = `<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังโหลด…</div>`;
    try {
      data = await ctx.adminCall("adminReceivedReport", {
        fy: ctx.fySelected() || ctx.fyCurrent(), month: monthSel.value || undefined, pcu: pcuSel.value || undefined, all: allChk.checked,
      });
      draw();
    } catch (err) { out.innerHTML = ""; toast(errMessage(err), "err"); }
  }

  const reasonText = (r) => (r.issue_reason ? (REASON[r.issue_reason] || r.issue_reason) + (r.issue_note ? ` — ${r.issue_note}` : "") : "");

  function draw() {
    const { rows, counts } = data;
    const summary = `<p class="admin-note" id="t16-summary">รพ.สต. แจ้งได้รับแล้ว ${formatInt(counts.reported)} รายการ · ไม่ตรง <strong>${formatInt(counts.mismatch)}</strong> รายการ</p>`;
    if (!rows.length) { out.innerHTML = summary + `<p class="muted" id="t16-empty">${allChk.checked ? "ยังไม่มีการแจ้งได้รับ" : "ไม่มีรายการที่ไม่ตรง"}</p>`; return; }
    out.innerHTML = summary + tableScroll(`<table class="admin-table" id="t16-tbl">
      <thead><tr><th class="left">รอบ</th><th class="left">รพ.สต.</th><th class="left">รายการ</th><th class="num">ขอ</th><th class="num">ผู้จ่ายบันทึก</th>
        <th class="num">รพ.สต. แจ้ง</th><th class="num">ต่าง</th><th class="left">วันที่รับ</th><th class="left">หมายเหตุ รพ.สต.</th><th class="left">เหตุผลผู้จ่าย</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.mismatch ? "t16-mismatch" : ""}" data-pcu="${escapeHtml(r.pcu)}" data-code="${escapeHtml(r.code)}">
        <td class="left">${escapeHtml(ctx.monthLabel(r.month))}</td>
        <td class="left"><strong>${escapeHtml(r.pcu)}</strong> ${escapeHtml(r.pcu_name)}</td>
        <td class="left"><span class="code-cell">${escapeHtml(r.code)}</span> ${escapeHtml(r.name)}${r.unit ? ` <span class="muted small">(${escapeHtml(r.unit)})</span>` : ""}</td>
        <td class="num">${formatInt(r.requested)}</td>
        <td class="num">${r.issued_total === null ? '<span class="muted">—</span>' : formatInt(r.issued_total)}</td>
        <td class="num"><strong>${formatInt(r.rcv_qty)}</strong>${r.mismatch ? ' <span class="badge badge-warn">ไม่ตรง</span>' : ""}</td>
        <td class="num">${r.diff === null ? "" : (r.diff > 0 ? "+" : "") + formatInt(r.diff)}</td>
        <td class="left">${escapeHtml(r.rcv_date || "")}</td>
        <td class="left">${escapeHtml(r.rcv_note || "")}</td>
        <td class="left">${escapeHtml(reasonText(r))}</td></tr>`).join("")}</tbody></table>`);
  }

  function exportCsv() {
    if (!data || !data.rows.length) { toast("ไม่มีข้อมูลให้ส่งออก"); return; }
    const head = ["รอบ", "รหัส รพ.สต.", "รพ.สต.", "รหัสรายการ", "รายการ", "หน่วย", "หน่วยจ่าย", "ขอ", "ผู้จ่ายบันทึก", "รพ.สต. แจ้งได้รับ", "ต่าง", "ไม่ตรง",
      "วันที่รับ", "หมายเหตุ รพ.สต.", "เหตุผลผู้จ่าย", "แจ้งเมื่อ"];
    const lines = [head.map(csvField).join(",")];
    data.rows.forEach((r) => lines.push([
      r.month, r.pcu, r.pcu_name, r.code, r.name, r.unit, r.dispense_unit || "", r.requested, r.issued_total ?? "", r.rcv_qty, r.diff ?? "",
      r.mismatch ? "ไม่ตรง" : "", r.rcv_date || "", r.rcv_note || "", reasonText(r), r.reported_at ? formatBangkokDateTime(r.reported_at) : "",
    ].map(csvField).join(",")));
    const stamp = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    downloadBlob(new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }), `received_${data.fy}${data.month ? "_" + data.month : ""}_${stamp}.csv`);
    toast(`ส่งออก ${data.rows.length} แถว`);
  }

  [monthSel, pcuSel, allChk].forEach((x) => x.addEventListener("change", load));
  csvBtn.addEventListener("click", exportCsv);

  return {
    onShow() { fillFilters(); load(); },
  };
}
