// Tab 4 — รพ.สต. × เดือน (บาท) — phase 1.5.md §4 item 4 / §9 criterion 1 (must match pcu_month.csv).
import { formatMonthKeyThai, formatMoney } from "../format.js";
import { escapeHtml, tableScroll, heatColor } from "./util.js";
import { pcuMonthBaht } from "./compute.js";

export function renderTab4(container, ctx) {
  const { state } = ctx;
  const bootstrap = state.bootstrap;
  const months = bootstrap.months;

  // matrix[pcuCode][monthIdx] = baht
  const matrix = {};
  let maxCell = 0;
  bootstrap.pcus.forEach((pcu) => {
    matrix[pcu.code] = months.map((m, idx) => {
      const v = pcuMonthBaht(bootstrap, pcu.code, idx);
      if (v > maxCell) maxCell = v;
      return v;
    });
  });

  const colTotals = months.map((m, idx) => bootstrap.pcus.reduce((s, pcu) => s + matrix[pcu.code][idx], 0));
  const grandTotal = colTotals.reduce((a, b) => a + b, 0);

  const groups = [
    { label: "ทั่วไป", pcus: bootstrap.pcus.filter((p) => p.group !== "พิเศษ") },
    { label: "พิเศษ", pcus: bootstrap.pcus.filter((p) => p.group === "พิเศษ") }
  ];

  const headerCells = months.map((m) => `<th>${escapeHtml(formatMonthKeyThai(m).replace(" 25", " '"))}</th>`).join("");

  const bodyParts = [];
  groups.forEach((g) => {
    if (!g.pcus.length) return;
    bodyParts.push(`<tr class="group-row"><td colspan="${months.length + 2}">${g.label}</td></tr>`);
    let groupTotal = 0;
    g.pcus.forEach((pcu) => {
      const row = matrix[pcu.code];
      const rowTotal = row.reduce((a, b) => a + b, 0);
      groupTotal += rowTotal;
      const cells = row.map((v) => {
        const h = heatColor(v, maxCell);
        return `<td class="heatmap-cell ${h.cls}" style="${h.style}">${formatMoney(v)}</td>`;
      }).join("");
      bodyParts.push(`<tr><td class="left">${pcu.code} ${escapeHtml(pcu.name)}</td>${cells}<td class="num" style="font-weight:700">${formatMoney(rowTotal)}</td></tr>`);
    });
    bodyParts.push(`<tr class="subtotal-row"><td class="left">รวม ${g.label}</td>${new Array(months.length).fill(0).map(() => "<td></td>").join("")}<td class="num">${formatMoney(groupTotal)}</td></tr>`);
  });

  const colTotalCells = colTotals.map((v) => `<td class="num" style="font-weight:700">${formatMoney(v)}</td>`).join("");
  bodyParts.push(`<tr class="grand-row"><td class="left">รวมทั้งหมด</td>${colTotalCells}<td class="num">${formatMoney(grandTotal)}</td></tr>`);

  container.innerHTML = "";
  const note = document.createElement("p");
  note.className = "admin-note";
  note.textContent = "ไล่สีเดียวตามยอดเบิก (เข้มขึ้นตามยอด) — ตัวเลขในช่องเป็นบาท ราคาปี 2568 รวมรายการ X-113";
  container.appendChild(note);

  const tableHost = document.createElement("div");
  tableHost.innerHTML = tableScroll(`<table class="admin-table admin-table-wide">
    <thead><tr><th class="left">รพ.สต.</th>${headerCells}<th>รวม</th></tr></thead>
    <tbody>${bodyParts.join("")}</tbody>
  </table>`);
  container.appendChild(tableHost);
}
