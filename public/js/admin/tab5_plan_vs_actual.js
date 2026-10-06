// Tab 5 — แผนปี 68 vs เบิกจริง (per PCU) — phase 1.5.md §4 item 5.
import { formatInt, formatMoney } from "../format.js";
import { escapeHtml, tableScroll, fmtPct } from "./util.js";
import { planVsActual, price2568For } from "./compute.js";

const FILTERS = [
  { key: "all", label: "ทั้งหมด" },
  { key: "over", label: "เกินแผน" },
  { key: "nouse", label: "มีแผนแต่ไม่เบิก" }
];

export function renderTab5(container, ctx) {
  const { state } = ctx;
  if (!state.tab5Pcu) state.tab5Pcu = state.bootstrap.pcus[0].code;
  if (!state.tab5Filter) state.tab5Filter = "all";
  if (!state.tab5Sort) state.tab5Sort = { key: "pct", dir: "desc" };

  container.innerHTML = "";
  const toolbar = document.createElement("div");
  toolbar.className = "admin-toolbar";

  const pcuLabel = document.createElement("label");
  pcuLabel.textContent = "รพ.สต.:";
  const pcuSelect = document.createElement("select");
  pcuSelect.className = "select-input";
  state.bootstrap.pcus.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.code; opt.textContent = `${p.code} ${p.name}`;
    if (p.code === state.tab5Pcu) opt.selected = true;
    pcuSelect.appendChild(opt);
  });
  pcuLabel.appendChild(pcuSelect);
  toolbar.appendChild(pcuLabel);

  const filterLabel = document.createElement("label");
  filterLabel.textContent = "กรอง:";
  const filterSelect = document.createElement("select");
  filterSelect.className = "select-input";
  FILTERS.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.key; opt.textContent = f.label;
    if (f.key === state.tab5Filter) opt.selected = true;
    filterSelect.appendChild(opt);
  });
  filterLabel.appendChild(filterSelect);
  toolbar.appendChild(filterLabel);

  container.appendChild(toolbar);
  const tableHost = document.createElement("div");
  container.appendChild(tableHost);

  pcuSelect.addEventListener("change", () => { state.tab5Pcu = pcuSelect.value; draw(); });
  filterSelect.addEventListener("change", () => { state.tab5Filter = filterSelect.value; draw(); });

  function sortRows(rows) {
    const { key, dir } = state.tab5Sort;
    const mul = dir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      let av = a[key], bv = b[key];
      if (av === null || av === Infinity) av = key === "pct" ? 1e12 : av;
      if (bv === null || bv === Infinity) bv = key === "pct" ? 1e12 : bv;
      if (av === null) av = -1;
      if (bv === null) bv = -1;
      return (av - bv) * mul;
    });
  }

  function draw() {
    const bootstrap = state.bootstrap;
    let rows = planVsActual(bootstrap, state.items, state.tab5Pcu);
    if (state.tab5Filter === "over") rows = rows.filter((r) => r.overPlan);
    else if (state.tab5Filter === "nouse") rows = rows.filter((r) => r.planNoUse);
    rows = sortRows(rows);

    let planMoney = 0, actualMoney = 0;
    const bodyRows = rows.map((r) => {
      const price = price2568For(bootstrap, r.item.code);
      planMoney += r.planTotal * price;
      actualMoney += r.actualAnnual * price;
      const pctText = r.pct === null ? "–" : (r.pct === Infinity ? "∞" : fmtPct(r.pct, 1));
      const diffCls = r.diff > 0 ? "admin-err-text" : "";
      return `<tr>
        <td class="left">${escapeHtml(r.item.name)}</td>
        <td class="num">${formatInt(r.planOp)}</td><td class="num">${formatInt(r.planPp)}</td><td class="num">${formatInt(r.planTotal)}</td>
        <td class="num">${formatInt(r.actualAnnual)}</td>
        <td class="num">${pctText}</td>
        <td class="num ${diffCls}">${r.diff > 0 ? "+" : ""}${formatInt(r.diff)}</td>
      </tr>`;
    }).join("");

    function sortHeader(label, key) {
      const active = state.tab5Sort.key === key;
      const arrow = active ? (state.tab5Sort.dir === "asc" ? " ▲" : " ▼") : "";
      return `<th data-sort="${key}" style="cursor:pointer">${label}${arrow}</th>`;
    }

    tableHost.innerHTML = tableScroll(`<table class="admin-table">
      <thead><tr>
        <th class="left">รายการ</th><th>แผน OP</th><th>แผน PP</th>${sortHeader("แผนรวม", "planTotal")}
        ${sortHeader("เบิกจริงทั้งปี", "actualAnnual")}${sortHeader("% ใช้", "pct")}${sortHeader("เกิน/ขาด", "diff")}
      </tr></thead>
      <tbody>${bodyRows || `<tr><td colspan="7" class="left muted">ไม่มีรายการตามเงื่อนไข</td></tr>`}
      <tr class="grand-row">
        <td class="left">รวม (บาท, ราคา 2568)</td><td colspan="2"></td>
        <td class="num">${formatMoney(planMoney)}</td><td class="num">${formatMoney(actualMoney)}</td>
        <td class="num">${planMoney > 0 ? fmtPct((actualMoney / planMoney) * 100, 1) : "–"}</td>
        <td class="num">${formatMoney(actualMoney - planMoney)}</td>
      </tr>
      </tbody>
    </table>`);

    tableHost.querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.tab5Sort.key === key) state.tab5Sort.dir = state.tab5Sort.dir === "asc" ? "desc" : "asc";
        else state.tab5Sort = { key, dir: "desc" };
        draw();
      });
    });
  }

  draw();
}
