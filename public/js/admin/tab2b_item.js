// tab2b_item.js — "จ่ายจริง" mode ต่อรายการ: one item across the network (adminItemIssue -> issueItem).
// 2ak D8: split out of renderTab2b (tab2b_issue.js), no behaviour change. `core` = the tab's shared state + helpers (see renderTab2b).
import { formatInt, formatMoney } from "../format.js";
import { el, escapeHtml, tableScroll, monthLong, toast, errMessage } from "./util.js";
import { clearRequestCache } from "./requests.js";
import { STATUS_LABEL, createEditor, gotCells, inputCell, numOrNull, rcvHtml, reasonCell } from "./tab2b_editor.js";

export function itemMode(core) {
  const { ctx, state, ts, host, myUnits, adminKeyed, expiredFor, footerHtml, lateNote, loadingHtml, refreshFooter, showFirstError, writeError } = core;

  // ======================================== ต่อรายการ ========================================
  async function loadItem() {
    const my = ++ts.seq;
    if (!ts.itemCode) {
      ts.item = null;
      host.innerHTML = `<div class="admin-card"><p class="muted">เลือกรายการเพื่อบันทึกการจ่ายทุก รพ.สต. ในรอบนี้</p></div>`;
      return;
    }
    host.innerHTML = loadingHtml("กำลังโหลด...");
    try {
      const data = await ctx.adminCall("adminItemIssue", { month: ts.month, item_code: ts.itemCode });
      if (my !== ts.seq) return;
      ts.item = data;
      ts.expired = expiredFor(data.rows);
      drawItem();
    } catch (err) {
      if (my !== ts.seq) return;
      if (err && err.code === "FORBIDDEN") { host.innerHTML = `<div class="notice notice-error">${escapeHtml(errMessage(err))}</div>`; return; }
      host.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    }
  }

  function drawItem(skipped) {
    const { item, rows } = ts.item;
    host.innerHTML = "";
    ts.editor = null;
    const head = el("div", { class: "admin-card t2b-head", id: "t2b-item-head" });
    head.appendChild(el("h2", {}, `${item.code} ${item.name}`));
    head.appendChild(el("p", { class: "t2b-meta small" },
      `${monthLong(ts.month)} · หน่วย ${item.unit || "–"} · ราคา ${formatMoney(((state.bootstrap.prices || {})[ts.month] || {})[item.code] ?? item.price)} บาท · หน้า ${item.step || "–"}${item.step_title ? " " + item.step_title : ""} · หน่วยจ่าย ${item.dispense_unit || "–"}`));
    if (ts.expired) head.appendChild(el("div", { class: "notice notice-error", id: "t2b-expired" }, ts.expired + " — ดูได้อย่างเดียว"));
    else if (ts.late) head.appendChild(lateNote());
    host.appendChild(head);
    if (skipped && skipped.length) {
      const names = skipped.map((s) => `${s.pcu}${s.why ? ` (${s.why})` : ""}`).join(", ");
      host.appendChild(el("div", { class: "notice notice-info", id: "t2b-skipped" }, `ข้าม ${skipped.length} แห่ง: ${names}`));
    }
    if (!rows.length) {
      host.appendChild(el("div", { class: "admin-card" }, el("p", { class: "muted" }, "ไม่มี รพ.สต. ที่ขอรายการนี้ในรอบนี้ (นับเฉพาะใบที่ส่งแล้ว)")));
      return;
    }
    const pcuName = (code) => (state.bootstrap.pcus.find((p) => p.code === code) || {}).name || "";
    const canAct = myUnits.includes(item.dispense_unit) && !ts.expired;
    const erows = rows.map((r) => ({
      key: r.pcu, label: r.pcu, op: Number(r.op) || 0, pp: Number(r.pp) || 0, req: Number(r.requested) || ((Number(r.op) || 0) + (Number(r.pp) || 0)),
      base: { total: numOrNull(r.issued_total), reason: r.reason || null, note: r.note || "" },
      disabled: !!r.unit_done || !canAct || (ts.late && !adminKeyed(r)), r
    }));
    const editor = createEditor(erows, { onChange: () => { refreshFooter(); refreshItemTotals(); } });
    ts.editor = editor;
    let sOp = 0, sPp = 0;
    const body = erows.map((er) => {
      const r = er.r;
      sOp += er.op; sPp += er.pp;
      return `<tr data-key="${escapeHtml(er.key)}">
        <td class="left"><strong>${escapeHtml(r.pcu)}</strong> ${escapeHtml(r.pcu_name || pcuName(r.pcu))}${rcvHtml(r)}</td>
        <td class="left"><span class="badge ${r.status === "issued" ? "badge-success" : "badge-muted"}">${escapeHtml(STATUS_LABEL[r.status] || r.status)}</span></td>
        <td class="num">${formatInt(er.op)}</td><td class="num">${formatInt(er.pp)}</td><td class="num"><strong>${formatInt(er.req)}</strong></td>
        ${inputCell(er)}${gotCells()}${reasonCell(er)}
        <td class="t2b-done-cell">${r.unit_done ? '<span class="badge badge-success" title="หน่วยจ่ายบันทึกว่าจ่ายใบนี้แล้ว — แก้ที่โหมดต่อใบหลังยกเลิกสถานะ">✓</span>' : '<span class="muted">○</span>'}</td></tr>`;
    }).join("");
    const card = el("div", { class: "admin-card" });
    card.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table t2b-table" id="t2b-item-tbl">
      <thead><tr><th class="left">รพ.สต.</th><th class="left">สถานะใบ</th><th class="num">ขอ OP</th><th class="num">ขอ PP</th><th class="num">ขอรวม</th>
      <th class="num">จ่ายจริง</th><th class="num">ได้ OP</th><th class="num">ได้ PP</th><th class="left">เหตุผล / หมายเหตุ</th><th>หน่วยจ่ายแล้ว</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr class="grand-row"><td class="left" colspan="2">รวม ${erows.length} แห่ง</td><td class="num">${formatInt(sOp)}</td><td class="num">${formatInt(sPp)}</td><td class="num">${formatInt(sOp + sPp)}</td>
      <td class="num" id="t2b-item-sum">—</td><td colspan="4"></td></tr></tfoot></table>`));
    host.appendChild(card);
    const allReqBtn = canAct ? `<button type="button" class="btn btn-secondary btn-sm" data-act="allreq" id="t2b-all-req">ตั้งทุกแห่ง = ขอ</button>` : "";
    const zeroBtn = allReqBtn + (canAct ? `<button type="button" class="btn btn-secondary btn-sm" data-act="zero" id="t2b-zero">ตั้งทุกแห่ง = 0 (ของหมด)</button>` : "");
    host.insertAdjacentHTML("beforeend", footerHtml(zeroBtn));
    editor.wire(host);
    const z = host.querySelector('[data-act="zero"]');
    if (z) z.addEventListener("click", () => editor.setAllZero());
    const ar = host.querySelector('[data-act="allreq"]');
    if (ar) ar.addEventListener("click", () => editor.setAllReq());
    host.querySelector('[data-act="save"]').addEventListener("click", saveItem);
    host.querySelector('[data-act="revert"]').addEventListener("click", () => editor.revert());
    refreshFooter();
    refreshItemTotals();
  }

  function refreshItemTotals() {
    const cell = host.querySelector("#t2b-item-sum");
    if (!cell || !ts.editor || !ts.item) return;
    let sum = 0, any = false;
    ts.item.rows.forEach((r) => { const d = ts.editor.draftOf(r.pcu); if (d && d.total !== null) { sum += d.total; any = true; } });
    cell.textContent = any ? formatInt(sum) : "—";
  }

  async function saveItem() {
    const editor = ts.editor;
    if (!editor) return;
    const problem = editor.validate();
    if (problem) { showFirstError(problem); return; }
    const entries = editor.payload();
    if (!Object.keys(entries).length) return;
    const btn = host.querySelector('[data-act="save"]');
    if (btn) btn.disabled = true;
    try {
      const res = await ctx.adminCall("issueItem", { month: ts.month, item_code: ts.itemCode, entries });
      clearRequestCache();
      const updated = res.updated || [], skipped = res.skipped || [];
      toast(`บันทึกแล้ว ${updated.length} แห่ง` + (skipped.length ? ` · ข้าม ${skipped.length} แห่ง` : ""));
      const data = await ctx.adminCall("adminItemIssue", { month: ts.month, item_code: ts.itemCode });
      ts.item = data;
      drawItem(skipped);
    } catch (err) {
      if (btn) btn.disabled = false;
      writeError(err, () => drawItem());
    }
  }

  return { load: loadItem };
}
