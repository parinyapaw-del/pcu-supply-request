// Tab 3 — งบสะสม vs เพดานเครือข่าย — phase 1.5.md §4 item 3 / §9 criterion 1.
import { formatMonthKeyThai, formatMoney } from "../format.js";
import { tableScroll } from "./util.js";
import { networkMonthlyBudget } from "./compute.js";

function bar(label, value, budget) {
  const pct = budget > 0 ? Math.min(999, (value / budget) * 100) : 0;
  const fillPct = Math.min(100, pct);
  const over = value > budget;
  return `<div class="budget-bar-row">
    <div class="budget-bar-label"><span>${label}</span><span>${formatMoney(value)} / ${formatMoney(budget)} บาท (${pct.toFixed(1)}%)</span></div>
    <div class="budget-bar-track"><div class="budget-bar-fill ${over ? "over-budget" : ""}" style="width:${fillPct}%"></div></div>
  </div>`;
}

export function renderTab3(container, ctx) {
  const { state } = ctx;
  const bootstrap = state.bootstrap;
  const cfg = bootstrap.config;
  const rows = networkMonthlyBudget(bootstrap);
  const last = rows[rows.length - 1] || { cumOp: 0, cumPp: 0, cumTotal: 0 };

  container.innerHTML = "";
  const card = document.createElement("div");
  card.className = "admin-card";
  card.innerHTML = `<h2>งบสะสมเทียบเพดานเครือข่าย (ปีงบ 2568, ราคา 2568)</h2>
    ${bar("OP", last.cumOp, cfg.budget_op)}
    ${bar("PP", last.cumPp, cfg.budget_pp)}
    ${bar("รวม", last.cumTotal, cfg.budget_total)}`;
  container.appendChild(card);

  const bodyRows = rows.map((r) => `<tr>
    <td class="left">${formatMonthKeyThai(r.month)}</td>
    <td class="num">${formatMoney(r.op)}</td><td class="num">${formatMoney(r.pp)}</td><td class="num">${formatMoney(r.total)}</td>
    <td class="num">${formatMoney(r.cumOp)}</td><td class="num">${formatMoney(r.cumPp)}</td><td class="num">${formatMoney(r.cumTotal)}</td>
  </tr>`).join("");

  const tableHost = document.createElement("div");
  tableHost.innerHTML = tableScroll(`<table class="admin-table">
    <thead><tr>
      <th class="left">เดือน</th>
      <th colspan="3">รายเดือน (บาท)</th>
      <th colspan="3">สะสม (บาท)</th>
    </tr>
    <tr><th></th><th>OP</th><th>PP</th><th>รวม</th><th>OP</th><th>PP</th><th>รวม</th></tr></thead>
    <tbody>${bodyRows}
    <tr class="grand-row">
      <td class="left">รวมทั้งปี</td>
      <td class="num">${formatMoney(last.cumOp)}</td><td class="num">${formatMoney(last.cumPp)}</td><td class="num">${formatMoney(last.cumTotal)}</td>
      <td></td><td></td><td></td>
    </tr>
    </tbody>
  </table>`);
  container.appendChild(tableHost);
}
