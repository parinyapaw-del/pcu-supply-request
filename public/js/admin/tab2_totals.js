// Tab 2 — ยอดรวมต่อรายการ / ใบจัดของ (phase 2.md §5.3). Only submitted/issued requests are counted.
// Lines come from adminGetRequest per request (cached in requests.js, ≤ 15 calls per month).
// A dispenser only receives lines of its own units from the API, so the same code shows their slice.
import { formatInt, formatMoney } from "../format.js";
import { el, escapeHtml, tableScroll, monthLong, formatBangkokTimeSec, errMessage, toast } from "./util.js";
import { buildCatalog, addForm, aggregateRequests, itemOrPlaceholder } from "./compute.js";
import { loadMonth } from "./requests.js";

export function renderTab2(container, ctx) {
  const { state } = ctx;
  const ts = { month: ctx.defaultMonth(), view: "step", showZero: false, showAll: false, data: null, expanded: new Set(), seq: 0 };

  container.innerHTML = "";
  const toolbar = el("div", { class: "admin-toolbar no-print" });
  const select = el("select", { class: "select-input", id: "t2-month", "aria-label": "เลือกเดือน" });
  const seg = el("div", { class: "admin-seg", role: "group" }, [
    el("button", { type: "button", "data-view": "step", class: "active", id: "t2-view-step" }, "ต่อหน้า"),
    el("button", { type: "button", "data-view": "unit", id: "t2-view-unit" }, "ต่อหน่วยจ่าย")
  ]);
  const zeroCb = el("input", { type: "checkbox", id: "t2-zero" });
  const allCb = el("input", { type: "checkbox", id: "t2-all" });
  const refresh = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t2-refresh" }, "รีเฟรช");
  const printBtn = el("button", { type: "button", class: "btn btn-primary btn-sm", id: "t2-print" }, "พิมพ์ใบจัดของ");
  toolbar.appendChild(el("label", {}, ["เดือน: ", select]));
  toolbar.appendChild(seg);
  toolbar.appendChild(el("label", { class: "admin-inline-check" }, [zeroCb, "แสดงรายการที่ไม่มียอด"]));
  toolbar.appendChild(el("label", { class: "admin-inline-check" }, [allCb, "ขยายรายแห่งทั้งหมด"]));
  toolbar.appendChild(refresh);
  toolbar.appendChild(printBtn);
  container.appendChild(toolbar);
  const info = el("p", { class: "admin-note", id: "t2-info" });
  const host = el("div", { id: "t2-host" });
  container.appendChild(info);
  container.appendChild(host);

  function months() {
    const set = new Set(ctx.fyMonths());
    if (ts.month) set.add(ts.month);
    return Array.from(set).sort().reverse();
  }
  function fillSelect() {
    select.innerHTML = "";
    if (!months().length) { select.appendChild(el("option", { value: "", disabled: true, selected: true }, "— ไม่มีรอบในปีงบนี้ —")); return; }
    months().forEach((m) => select.appendChild(el("option", { value: m, selected: m === ts.month }, monthLong(m) + (m === state.bootstrap.current_month ? " (เดือนนี้)" : ""))));
  }
  fillSelect();
  select.addEventListener("change", () => { ts.month = select.value; ts.expanded.clear(); ts.data = null; load(); });
  seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    ts.view = b.dataset.view;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    draw();
  }));
  zeroCb.addEventListener("change", () => { ts.showZero = zeroCb.checked; draw(); });
  allCb.addEventListener("change", () => { ts.showAll = allCb.checked; draw(); });
  refresh.addEventListener("click", () => load());
  printBtn.addEventListener("click", () => window.print());

  async function load(silent) {
    const my = ++ts.seq;
    if (!ts.month) {
      ts.data = null;
      host.innerHTML = `<p class="admin-note">ยังไม่มีรอบหรือใบเบิกบนเว็บในปีงบ ${escapeHtml(String(ctx.fySelected()))}</p>`;
      return;
    }
    if (!silent) host.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div><span id="t2-prog">กำลังโหลดใบเบิก...</span></div>';
    try {
      const data = await loadMonth(ctx, ts.month, (d, n) => {
        const p = host.querySelector("#t2-prog");
        if (p && my === ts.seq) p.textContent = `กำลังโหลดใบเบิก ${d}/${n}`;
      });
      if (my !== ts.seq) return;
      const cat = buildCatalog(state.bootstrap.form);
      data.entries.forEach((e) => { if (e.form) addForm(cat, e.form); });
      ts.data = { ...data, cat, agg: aggregateRequests(cat, data.entries) };
      draw();
    } catch (err) {
      if (my !== ts.seq) return;
      host.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    }
  }

  function groupsFor(cat, agg) {
    const rowsAll = cat.items.map((it) => ({ item: it, a: agg.byItem[it.code] || null }));
    // unknown codes (not in catalogue) — shown last
    Object.keys(agg.byItem).forEach((code) => {
      if (!cat.byCode[code]) rowsAll.push({ item: itemOrPlaceholder(cat, code), a: agg.byItem[code] });
    });
    const rows = rowsAll.filter((r) => ts.showZero || (r.a && (r.a.total > 0 || r.a.issued !== null)));
    const groups = [];
    const map = new Map();
    rows.forEach((r) => {
      const key = ts.view === "step" ? "s:" + r.item.stepCode : "u:" + (r.item.dispenseUnit || "?");
      let g = map.get(key);
      if (!g) {
        const title = ts.view === "step"
          ? `หน้า ${r.item.pageNo} — ${r.item.sheet}`
          : `หน่วยจ่าย: ${r.item.dispenseUnit || "อื่น ๆ"}`;
        g = { key, title, rows: [], order: ts.view === "step" ? r.item.stepOrder : ["พัสดุ", "จ่ายกลาง", "LAB"].indexOf(r.item.dispenseUnit) };
        map.set(key, g); groups.push(g);
      }
      g.rows.push(r);
    });
    groups.sort((a, b) => a.order - b.order);
    return groups;
  }

  function draw() {
    if (!ts.data) return;
    const { cat, agg, entries, requests } = ts.data;
    const pcus = state.bootstrap.pcus;
    const nUsable = entries.length;
    info.textContent = `${monthLong(ts.month)} — ใบที่ส่งแล้ว/จ่ายแล้ว ${nUsable}/${pcus.length} แห่ง · ยอดขอรวม ${formatMoney(agg.baht)} บาท (OP ${formatMoney(agg.bahtOp)} · PP ${formatMoney(agg.bahtPp)}) · โหลดเมื่อ ${formatBangkokTimeSec()}`
      + (state.isAdmin ? "" : " · แสดงเฉพาะรายการของหน่วยที่ท่านรับผิดชอบ");
    const draftCount = requests.filter((r) => r.status === "draft").length;
    if (draftCount) info.textContent += ` · แบบร่าง ${draftCount} แห่ง (ยังไม่นับ)`;

    const groups = groupsFor(cat, agg);
    if (!groups.length) {
      host.innerHTML = `<div class="admin-card"><p class="muted">ยังไม่มีใบเบิกที่ส่งแล้วในเดือนนี้</p></div>`;
      return;
    }
    let grandOp = 0, grandPp = 0, grandBaht = 0, grandIssued = null;
    const body = [];
    groups.forEach((g) => {
      let gOp = 0, gPp = 0, gBaht = 0, gIss = null;
      body.push(`<tr class="group-row"><td colspan="8">${escapeHtml(g.title)}</td></tr>`);
      g.rows.forEach(({ item, a }) => {
        const op = a ? a.op : 0, pp = a ? a.pp : 0, total = op + pp, baht = a ? a.baht : 0;
        gOp += op; gPp += pp; gBaht += baht;
        if (a && a.issued !== null) gIss = (gIss || 0) + a.issued;
        const open = ts.showAll || ts.expanded.has(item.code);
        body.push(`<tr class="item-row ${total === 0 ? "zero-row" : ""}" data-code="${escapeHtml(item.code)}">
          <td class="left code-cell"><button type="button" class="exp-btn" aria-expanded="${open}" data-exp="${escapeHtml(item.code)}" ${total === 0 ? "disabled" : ""}>${open ? "▾" : "▸"}</button> ${escapeHtml(item.code)}</td>
          <td class="left name-cell">${escapeHtml(item.name)}</td>
          <td class="left">${escapeHtml(item.unit)}</td>
          <td class="num">${formatInt(op)}</td><td class="num">${formatInt(pp)}</td><td class="num"><strong>${formatInt(total)}</strong></td>
          <td class="num">${a && a.issued !== null ? formatInt(a.issued) : "—"}</td>
          <td class="num">${formatMoney(baht)}</td>
        </tr>`);
        if (open && a && total > 0) body.push(breakdownRow(a, pcus));
      });
      grandOp += gOp; grandPp += gPp; grandBaht += gBaht;
      if (gIss !== null) grandIssued = (grandIssued || 0) + gIss;
      body.push(`<tr class="subtotal-row"><td colspan="3" class="left">รวม ${escapeHtml(g.title)}</td><td class="num">${formatInt(gOp)}</td><td class="num">${formatInt(gPp)}</td><td class="num">${formatInt(gOp + gPp)}</td><td class="num">${gIss === null ? "—" : formatInt(gIss)}</td><td class="num">${formatMoney(gBaht)}</td></tr>`);
    });
    body.push(`<tr class="grand-row" id="t2-grand"><td colspan="3" class="left">รวมทั้งหมด</td><td class="num">${formatInt(grandOp)}</td><td class="num">${formatInt(grandPp)}</td><td class="num">${formatInt(grandOp + grandPp)}</td><td class="num">${grandIssued === null ? "—" : formatInt(grandIssued)}</td><td class="num">${formatMoney(grandBaht)}</td></tr>`);

    host.innerHTML = `<h2 class="print-title">ใบจัดของ — ${escapeHtml(monthLong(ts.month))} (${ts.view === "step" ? "ต่อหน้า" : "ต่อหน่วยจ่าย"})</h2>`
      + tableScroll(`<table class="admin-table totals-table" id="t2-tbl">
        <thead><tr><th class="left">รหัส</th><th class="left">รายการ</th><th class="left">หน่วย</th><th class="num">ขอ OP</th><th class="num">ขอ PP</th><th class="num">ขอ รวม</th><th class="num" title="ยอดจ่ายจริง — บันทึกใน phase 2c">จ่ายจริง</th><th class="num">เป็นเงิน (บาท)</th></tr></thead>
        <tbody>${body.join("")}</tbody></table>`);
    host.querySelectorAll("[data-exp]").forEach((b) => b.addEventListener("click", () => {
      const code = b.dataset.exp;
      if (ts.expanded.has(code)) ts.expanded.delete(code); else ts.expanded.add(code);
      draw();
    }));
  }

  function breakdownRow(a, pcus) {
    const head = pcus.map((p) => `<th title="${escapeHtml(p.name)}">${escapeHtml(p.code.replace("PCU", ""))}<div class="pcu-mini">${escapeHtml(p.name)}</div></th>`).join("");
    const cell = (v) => `<td class="num ${v ? "" : "zero"}">${v ? formatInt(v) : "·"}</td>`;
    const opRow = pcus.map((p) => cell((a.byPcu[p.code] || {}).op || 0)).join("");
    const ppRow = pcus.map((p) => cell((a.byPcu[p.code] || {}).pp || 0)).join("");
    const totRow = pcus.map((p) => { const b = a.byPcu[p.code]; return cell(b ? b.op + b.pp : 0); }).join("");
    return `<tr class="breakdown-row"><td colspan="8"><div class="table-scroll"><table class="admin-table mini-table">
      <thead><tr><th class="left">รพ.สต.</th>${head}</tr></thead>
      <tbody><tr><th class="left">OP</th>${opRow}</tr><tr><th class="left">PP</th>${ppRow}</tr><tr class="tot"><th class="left">รวม</th>${totRow}</tr></tbody>
    </table></div></td></tr>`;
  }

  let firstShow = true;
  load();
  return {
    onShow() { fillSelect(); if (firstShow) { firstShow = false; return; } load(!!ts.data); }
  };
}
