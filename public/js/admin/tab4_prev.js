// Tab 4 — ปีก่อน (phase 2.md §5.6, read-only; merges the 1.5 heatmap + plan-vs-actual tabs).
// Data: adminBootstrap.prev[fy] = {months, actual, plans, prices}. Money = qty x prices_prev (that year's prices).
import { formatInt, formatMoney } from "../format.js";
import { el, escapeHtml, tableScroll, monthShort, heatColor, fmtPct } from "./util.js";
import { prevHeatmap, prevPlanVsActual } from "./compute.js";

export function renderTab4(container, ctx) {
  const { state } = ctx;
  const prev = state.bootstrap.prev || {};
  const fys = Object.keys(prev).sort().reverse();
  container.innerHTML = "";
  if (!fys.length) {
    container.appendChild(el("div", { class: "admin-card" }, el("p", { class: "muted" }, "ยังไม่มีข้อมูลปีก่อน — นำเข้าข้อมูลตั้งต้นในแท็บ \"ระบบ\"")));
    return null;
  }
  const ts = { fy: fys[0], pcu: "*", filter: "all", sort: { key: "item", dir: "asc" } };

  const toolbar = el("div", { class: "admin-toolbar" });
  const fySel = el("select", { class: "select-input", id: "t4-fy", "aria-label": "ปีงบ" });
  fys.forEach((fy) => fySel.appendChild(el("option", { value: fy }, `ปีงบ ${fy}`)));
  toolbar.appendChild(el("label", {}, ["ปีงบ: ", fySel]));
  toolbar.appendChild(el("span", { class: "muted small" }, "อ่านอย่างเดียว · ราคาตามปีนั้น"));
  container.appendChild(toolbar);
  const heatHost = el("div", { id: "t4-heat" });
  const planHost = el("div", { id: "t4-plan" });
  container.appendChild(heatHost);
  container.appendChild(planHost);
  fySel.addEventListener("change", () => { ts.fy = fySel.value; drawHeat(); drawPlan(); });

  function drawHeat() {
    const entry = prev[ts.fy];
    const pcus = state.bootstrap.pcus;
    const { matrix, max } = prevHeatmap(entry, pcus);
    const months = entry.months;
    const colTotals = months.map((m, i) => pcus.reduce((s, p) => s + matrix[p.code][i], 0));
    const grand = colTotals.reduce((a, b) => a + b, 0);
    const parts = [];
    [{ label: "ทั่วไป", list: pcus.filter((p) => p.group !== "พิเศษ") }, { label: "พิเศษ", list: pcus.filter((p) => p.group === "พิเศษ") }].forEach((g) => {
      if (!g.list.length) return;
      parts.push(`<tr class="group-row"><td colspan="${months.length + 2}">${g.label}</td></tr>`);
      g.list.forEach((p) => {
        const row = matrix[p.code];
        const cells = row.map((v) => { const h = heatColor(v, max); return `<td class="heatmap-cell ${h.cls}" style="${h.style}">${v ? formatMoney(v) : "·"}</td>`; }).join("");
        parts.push(`<tr data-pcu="${p.code}"><td class="left"><strong>${p.code}</strong> ${escapeHtml(p.name)}</td>${cells}<td class="num"><strong>${formatMoney(row.reduce((a, b) => a + b, 0))}</strong></td></tr>`);
      });
    });
    parts.push(`<tr class="grand-row"><td class="left">รวมเครือข่าย</td>${colTotals.map((v) => `<td class="num">${formatMoney(v)}</td>`).join("")}<td class="num" id="t4-grand">${formatMoney(grand)}</td></tr>`);
    heatHost.innerHTML = "";
    const card = el("div", { class: "admin-card" });
    card.appendChild(el("h2", {}, `รพ.สต. × เดือน — เบิกจริงปีงบ ${ts.fy} (บาท)`));
    card.insertAdjacentHTML("beforeend", `<p class="admin-note">ยอดเบิกจริง (OP+PP) × ราคาปี ${ts.fy} · ไล่สีตามยอด</p>`
      + tableScroll(`<table class="admin-table admin-table-wide" id="t4-heat-tbl"><thead><tr><th class="left">รพ.สต.</th>${months.map((m) => `<th>${escapeHtml(monthShort(m))}</th>`).join("")}<th>รวม</th></tr></thead><tbody>${parts.join("")}</tbody></table>`));
    heatHost.appendChild(card);
  }

  function drawPlan() {
    const entry = prev[ts.fy];
    const pcus = state.bootstrap.pcus;
    planHost.innerHTML = "";
    const card = el("div", { class: "admin-card" });
    card.appendChild(el("h2", {}, `แผน ${String(ts.fy).slice(-2)} vs เบิกจริง ${String(ts.fy).slice(-2)} — ต่อรายการ`));
    const bar = el("div", { class: "admin-toolbar" });
    const pcuSel = el("select", { class: "select-input", id: "t4-pcu", "aria-label": "รพ.สต." });
    pcuSel.appendChild(el("option", { value: "*" }, "ทั้งเครือข่าย (รวม)"));
    pcus.forEach((p) => pcuSel.appendChild(el("option", { value: p.code, selected: p.code === ts.pcu }, `${p.code} ${p.name}`)));
    pcuSel.value = ts.pcu;
    const fSel = el("select", { class: "select-input", id: "t4-filter", "aria-label": "กรอง" });
    [["all", "ทั้งหมด"], ["over", "เกินแผน"], ["nouse", "มีแผนแต่ไม่เบิก"], ["noplan", "เบิกโดยไม่มีแผน"]].forEach(([v, l]) => fSel.appendChild(el("option", { value: v }, l)));
    fSel.value = ts.filter;
    bar.appendChild(el("label", {}, ["รพ.สต.: ", pcuSel]));
    bar.appendChild(el("label", {}, ["กรอง: ", fSel]));
    card.appendChild(bar);
    const tbl = el("div", { id: "t4-plan-tbl" });
    card.appendChild(tbl);
    planHost.appendChild(card);
    pcuSel.addEventListener("change", () => { ts.pcu = pcuSel.value; drawTable(); });
    fSel.addEventListener("change", () => { ts.filter = fSel.value; drawTable(); });

    function drawTable() {
      let rows = prevPlanVsActual(entry, ctx.state.cat, ts.pcu, pcus);
      if (ts.filter === "over") rows = rows.filter((r) => r.plan > 0 && r.act > r.plan);
      else if (ts.filter === "nouse") rows = rows.filter((r) => r.plan > 0 && r.act === 0);
      else if (ts.filter === "noplan") rows = rows.filter((r) => r.plan === 0 && r.act > 0);
      const key = ts.sort.key, mul = ts.sort.dir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        if (key === "item") return mul * (a.item.stepOrder - b.item.stepOrder || a.code.localeCompare(b.code, "en", { numeric: true }));
        const av = a[key] === Infinity ? 1e12 : (a[key] ?? -1), bv = b[key] === Infinity ? 1e12 : (b[key] ?? -1);
        return mul * (av - bv);
      });
      let pq = 0, aq = 0, pb = 0, ab = 0;
      const body = rows.map((r) => {
        pq += r.plan; aq += r.act; pb += r.planBaht; ab += r.actBaht;
        const pct = r.pct === null ? "–" : r.pct === Infinity ? "∞" : fmtPct(r.pct, 0);
        return `<tr><td class="left code-cell">${escapeHtml(r.code)}</td><td class="left name-cell">${escapeHtml(r.item.name)}</td><td class="left">${escapeHtml(r.item.unit)}</td>
          <td class="num">${formatInt(r.planOp)}</td><td class="num">${formatInt(r.planPp)}</td><td class="num">${formatInt(r.plan)}</td>
          <td class="num">${formatInt(r.actOp)}</td><td class="num">${formatInt(r.actPp)}</td><td class="num ${r.act > r.plan && r.plan > 0 ? "admin-err-text" : ""}">${formatInt(r.act)}</td><td class="num">${pct}</td>
          <td class="num">${formatMoney(r.planBaht)}</td><td class="num">${formatMoney(r.actBaht)}</td></tr>`;
      }).join("");
      const arrow = (k) => (ts.sort.key === k ? (ts.sort.dir === "asc" ? " ▲" : " ▼") : "");
      tbl.innerHTML = tableScroll(`<table class="admin-table admin-table-wide" id="t4-plan-table"><thead><tr>
        <th class="left sortable" data-sort="item">รหัส${arrow("item")}</th><th class="left">รายการ</th><th class="left">หน่วย</th>
        <th class="num">แผน OP</th><th class="num">แผน PP</th><th class="num sortable" data-sort="plan">แผนรวม${arrow("plan")}</th>
        <th class="num">จริง OP</th><th class="num">จริง PP</th><th class="num sortable" data-sort="act">จริงรวม${arrow("act")}</th><th class="num sortable" data-sort="pct">% ใช้${arrow("pct")}</th>
        <th class="num sortable" data-sort="planBaht">แผน (บาท)${arrow("planBaht")}</th><th class="num sortable" data-sort="actBaht">จริง (บาท)${arrow("actBaht")}</th></tr></thead>
        <tbody>${body || '<tr><td colspan="12" class="left muted">ไม่มีรายการตามเงื่อนไข</td></tr>'}
        <tr class="grand-row"><td colspan="3" class="left">รวม ${rows.length} รายการ</td><td colspan="2"></td><td class="num">${formatInt(pq)}</td><td colspan="2"></td><td class="num">${formatInt(aq)}</td><td class="num">${pq > 0 ? fmtPct((aq / pq) * 100, 0) : "–"}</td><td class="num" id="t4-plan-baht">${formatMoney(pb)}</td><td class="num" id="t4-act-baht">${formatMoney(ab)}</td></tr>
        </tbody></table>`);
      tbl.querySelectorAll("th[data-sort]").forEach((th) => th.addEventListener("click", () => {
        const k = th.dataset.sort;
        ts.sort = ts.sort.key === k ? { key: k, dir: ts.sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "item" ? "asc" : "desc" };
        drawTable();
      }));
    }
    drawTable();
  }

  drawHeat();
  drawPlan();
  return null;
}
