// Tab 3 — งบ (phase 2.md §5.5): fiscal-year-to-date requested OP/PP vs the network budget, the plan total of
// the new year (adminBootstrap.plan_totals) beside the budget, and a per-PCU plan vs requested table.
// 2c: "จ่ายจริง" = Σ issued_op/issued_pp × price (price_snapshot ?? form price) of submitted/issued requests (compute.js aggregateIssued).
import { formatMoney, fiscalYearOf } from "../format.js";
import { el, escapeHtml, tableScroll, monthLong, toast, errMessage, fmtPct } from "./util.js";
import { buildCatalog, addForm, aggregateRequests, aggregateIssued, planBahtByPcu } from "./compute.js";
import { loadMonth } from "./requests.js";

const BUDGET_KEYS = [
  { key: "budget_op", label: "งบ OP" },
  { key: "budget_pp", label: "งบ PP" },
  { key: "budget_total", label: "งบรวม" }
];

function barRow(label, value, budget) {
  const pct = budget > 0 ? (value / budget) * 100 : 0;
  const over = budget > 0 && value > budget;
  return `<div class="budget-bar-row">
    <div class="budget-bar-label"><span>${escapeHtml(label)}</span><span>${formatMoney(value)} / ${formatMoney(budget)} บาท (${fmtPct(pct, 1)})</span></div>
    <div class="budget-bar-track"><div class="budget-bar-fill ${over ? "over-budget" : ""}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
  </div>`;
}

export function renderTab3(container, ctx) {
  const { state } = ctx;
  let seq = 0;
  let loadedOnce = false;
  container.innerHTML = "";
  const host = el("div", { id: "t3-host" });
  container.appendChild(host);

  async function load() {
    const my = ++seq;
    host.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div><span id="t3-prog">กำลังคำนวณยอดขอสะสม...</span></div>';
    try {
      await ctx.refreshBootstrap();
      const b = state.bootstrap;
      const fy = b.config.fy_current;
      const monthSet = new Set((b.months || []).filter((m) => fiscalYearOf(m) === fy));
      if (fiscalYearOf(b.current_month) === fy) monthSet.add(b.current_month);
      const months = Array.from(monthSet).sort();
      const cat = buildCatalog(b.form);
      const perMonth = [];
      const perPcu = {};
      for (let i = 0; i < months.length; i++) {
        const m = months[i];
        const p = host.querySelector("#t3-prog");
        if (p && my === seq) p.textContent = `กำลังโหลด ${monthLong(m)} (${i + 1}/${months.length})`;
        const data = await loadMonth(ctx, m);
        if (my !== seq) return;
        let op = 0, pp = 0, iop = 0, ipp = 0, unrecorded = 0;
        data.entries.forEach((e) => {
          if (e.form) addForm(cat, e.form);
          const a = aggregateRequests(cat, [e]);
          const iss = aggregateIssued(cat, [e]);
          op += a.bahtOp; pp += a.bahtPp;
          iop += iss.op; ipp += iss.pp; unrecorded += iss.unrecorded;
          const t = perPcu[e.pcu] || (perPcu[e.pcu] = { op: 0, pp: 0, iop: 0, ipp: 0 });
          t.op += a.bahtOp; t.pp += a.bahtPp; t.iop += iss.op; t.ipp += iss.pp;
        });
        perMonth.push({ month: m, n: data.entries.length, op, pp, total: op + pp, iop, ipp, issued: iop + ipp, unrecorded });
      }
      if (my !== seq) return;
      draw({ fy, months: perMonth, perPcu, cat });
    } catch (err) {
      if (my !== seq) return;
      host.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    }
  }

  function draw({ fy, months, perPcu, cat }) {
    const b = state.bootstrap;
    const cfg = b.config;
    const reqOp = months.reduce((s, m) => s + m.op, 0);
    const reqPp = months.reduce((s, m) => s + m.pp, 0);
    const reqTotal = reqOp + reqPp;
    const issOp = months.reduce((s, m) => s + m.iop, 0);
    const issPp = months.reduce((s, m) => s + m.ipp, 0);
    const issTotal = issOp + issPp;
    const unrecorded = months.reduce((s, m) => s + m.unrecorded, 0);
    const plan = b.plan_totals || { op: 0, pp: 0, total: 0 };
    const gap = plan.total - (cfg.budget_total || 0);

    host.innerHTML = "";

    // ---- budget card -------------------------------------------------------------------------------
    const card = el("div", { class: "admin-card", id: "t3-budget-card" });
    card.appendChild(el("h2", {}, `งบเครือข่าย ปีงบ ${fy}`));
    const grid = el("div", { class: "budget-grid" });
    const inputs = {};
    BUDGET_KEYS.forEach(({ key, label }) => {
      const input = el("input", { type: "number", min: "0", step: "0.01", class: "budget-input", id: "t3-" + key, value: String(cfg[key] ?? 0), inputmode: "decimal" });
      inputs[key] = input;
      grid.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, label + " (บาท)"), input]));
    });
    card.appendChild(grid);
    const saveBtn = el("button", { type: "button", class: "btn btn-primary btn-sm", id: "t3-save-budget" }, "บันทึกงบ");
    card.appendChild(saveBtn);
    card.appendChild(el("span", { class: "admin-note", id: "t3-save-msg", style: "margin-left:10px" }));
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        for (const { key } of BUDGET_KEYS) {
          const v = Number(inputs[key].value);
          if (!isFinite(v) || v < 0) throw new Error(`ค่า "${key}" ไม่ถูกต้อง`);
          if (v !== Number(cfg[key])) {
            const res = await ctx.adminCall("adminSetConfig", { key, value: v });
            Object.assign(state.bootstrap.config, res.config);
          }
        }
        toast("บันทึกงบแล้ว");
        draw({ fy, months, perPcu, cat });
      } catch (err) { toast(errMessage(err), "err"); } finally { saveBtn.disabled = false; }
    });
    host.appendChild(card);

    // ---- bars + plan compare -------------------------------------------------------------------------
    const cmp = el("div", { class: "admin-card", id: "t3-compare-card" });
    cmp.appendChild(el("h2", {}, "ขอสะสม เทียบงบ"));
    cmp.insertAdjacentHTML("beforeend",
      barRow("ขอสะสม OP", reqOp, cfg.budget_op) + barRow("ขอสะสม PP", reqPp, cfg.budget_pp) + barRow("ขอสะสม รวม", reqTotal, cfg.budget_total)
      + barRow("จ่ายจริงสะสม รวม", issTotal, cfg.budget_total));
    cmp.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table" id="t3-summary">
      <thead><tr><th class="left"></th><th class="num">OP</th><th class="num">PP</th><th class="num">รวม</th></tr></thead><tbody>
        <tr><td class="left">งบ</td><td class="num">${formatMoney(cfg.budget_op)}</td><td class="num">${formatMoney(cfg.budget_pp)}</td><td class="num">${formatMoney(cfg.budget_total)}</td></tr>
        <tr><td class="left">แผนรวมปี ${String(plan.fy || fy).slice(-2)} (แผน × ราคาฟอร์ม)</td><td class="num">${formatMoney(plan.op)}</td><td class="num">${formatMoney(plan.pp)}</td><td class="num" id="t3-plan-total"><strong>${formatMoney(plan.total)}</strong></td></tr>
        <tr><td class="left">แผน − งบ</td><td class="num">${formatMoney(plan.op - cfg.budget_op)}</td><td class="num">${formatMoney(plan.pp - cfg.budget_pp)}</td><td class="num ${gap > 0 ? "admin-err-text" : ""}" id="t3-gap">${gap > 0 ? "+" : ""}${formatMoney(gap)}</td></tr>
        <tr><td class="left">ขอสะสม (ส่งแล้ว)</td><td class="num" id="t3-req-op">${formatMoney(reqOp)}</td><td class="num" id="t3-req-pp">${formatMoney(reqPp)}</td><td class="num" id="t3-req-total"><strong>${formatMoney(reqTotal)}</strong></td></tr>
        <tr id="t3-issued-row"><td class="left">จ่ายจริงสะสม${unrecorded ? ` <span class="muted small" id="t3-unrecorded">(ยังไม่บันทึก ${unrecorded} ใบ)</span>` : ""}</td><td class="num" id="t3-iss-op">${formatMoney(issOp)}</td><td class="num" id="t3-iss-pp">${formatMoney(issPp)}</td><td class="num" id="t3-iss-total"><strong>${formatMoney(issTotal)}</strong></td></tr>
        <tr><td class="left">งบคงเหลือ (งบ − ขอ)</td><td class="num">${formatMoney(cfg.budget_op - reqOp)}</td><td class="num">${formatMoney(cfg.budget_pp - reqPp)}</td><td class="num">${formatMoney(cfg.budget_total - reqTotal)}</td></tr>
        <tr><td class="left">งบคงเหลือ (งบ − จ่ายจริง)</td><td class="num">${formatMoney(cfg.budget_op - issOp)}</td><td class="num">${formatMoney(cfg.budget_pp - issPp)}</td><td class="num">${formatMoney(cfg.budget_total - issTotal)}</td></tr>
      </tbody></table>`));
    if (gap > 0) cmp.appendChild(el("p", { class: "admin-note" }, `แผนรวมปี ${fy} สูงกว่างบเครือข่าย ${formatMoney(gap)} บาท`));
    host.appendChild(cmp);

    // ---- monthly -----------------------------------------------------------------------------------
    let cum = 0;
    const monthRows = months.map((m) => {
      cum += m.total;
      return `<tr><td class="left">${escapeHtml(monthLong(m.month))}</td><td class="num">${m.n}</td><td class="num">${formatMoney(m.op)}</td><td class="num">${formatMoney(m.pp)}</td><td class="num">${formatMoney(m.total)}</td><td class="num">${formatMoney(cum)}</td>`
        + `<td class="num">${formatMoney(m.issued)}${m.unrecorded ? ` <span class="muted small">(ยังไม่บันทึก ${m.unrecorded} ใบ)</span>` : ""}</td></tr>`;
    }).join("");
    const monthCard = el("div", { class: "admin-card" });
    monthCard.appendChild(el("h2", {}, "ขอรายเดือน (ใบที่ส่งแล้ว/จ่ายแล้ว, ราคา ณ วันส่ง)"));
    monthCard.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table"><thead><tr><th class="left">เดือน</th><th class="num">ใบ (แห่ง)</th><th class="num">OP</th><th class="num">PP</th><th class="num">รวม</th><th class="num">สะสม</th><th class="num">จ่ายจริง</th></tr></thead>
      <tbody>${monthRows || '<tr><td colspan="7" class="left muted">ยังไม่มีใบที่ส่งแล้ว</td></tr>'}</tbody></table>`));
    host.appendChild(monthCard);

    // ---- per PCU -----------------------------------------------------------------------------------
    const planBy = planBahtByPcu(b.plans, cat);
    let tPlan = 0, tOp = 0, tPp = 0, tIss = 0;
    const pcuRows = b.pcus.map((p) => {
      const pl = planBy[p.code] || { op: 0, pp: 0, total: 0 };
      const rq = perPcu[p.code] || { op: 0, pp: 0, iop: 0, ipp: 0 };
      const rt = rq.op + rq.pp;
      const it = rq.iop + rq.ipp;
      tPlan += pl.total; tOp += rq.op; tPp += rq.pp; tIss += it;
      const pct = pl.total > 0 ? (rt / pl.total) * 100 : null;
      return `<tr><td class="left"><strong>${p.code}</strong> ${escapeHtml(p.name)}</td>
        <td class="num">${formatMoney(pl.op)}</td><td class="num">${formatMoney(pl.pp)}</td><td class="num">${formatMoney(pl.total)}</td>
        <td class="num">${formatMoney(rq.op)}</td><td class="num">${formatMoney(rq.pp)}</td><td class="num">${formatMoney(rt)}</td>
        <td class="num">${fmtPct(pct, 1)}</td><td class="num" title="OP ${formatMoney(rq.iop)} · PP ${formatMoney(rq.ipp)}">${formatMoney(it)}</td></tr>`;
    }).join("");
    const pcuCard = el("div", { class: "admin-card" });
    pcuCard.appendChild(el("h2", {}, `ต่อแห่ง: แผนปี ${String(fy).slice(-2)} / ขอสะสม / จ่ายจริง (บาท)`));
    pcuCard.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table admin-table-wide" id="t3-pcu-tbl"><thead><tr>
      <th class="left">รพ.สต.</th><th class="num">แผน OP</th><th class="num">แผน PP</th><th class="num">แผนรวม</th>
      <th class="num">ขอ OP</th><th class="num">ขอ PP</th><th class="num">ขอรวม</th><th class="num">ขอ/แผน</th><th class="num">จ่ายจริง</th></tr></thead>
      <tbody>${pcuRows}<tr class="grand-row"><td class="left">รวม</td><td class="num">${formatMoney(plan.op)}</td><td class="num">${formatMoney(plan.pp)}</td><td class="num" id="t3-pcu-plan-sum">${formatMoney(tPlan)}</td>
      <td class="num">${formatMoney(tOp)}</td><td class="num">${formatMoney(tPp)}</td><td class="num">${formatMoney(tOp + tPp)}</td><td class="num">${fmtPct(tPlan > 0 ? ((tOp + tPp) / tPlan) * 100 : null, 1)}</td><td class="num" id="t3-pcu-iss-sum">${formatMoney(tIss)}</td></tr></tbody></table>`));
    host.appendChild(pcuCard);
  }

  load();
  return { onShow() { if (!loadedOnce) { loadedOnce = true; return; } load(); } };
}
