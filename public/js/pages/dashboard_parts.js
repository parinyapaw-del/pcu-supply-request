// Brief 2q/2s — shared dashboard pieces: SVG bar / line charts, tooltip, KPI tiles, unit-group list, top list and the per-item table.
// Used by the PCU page (pages/dashboard.js, pcuDashboard) and by the admin per-PCU view (admin/tab12_dashboard.js, adminDashboard{pcu}).
// Charts are hand-written SVG (no library); colors come from the --dv-* tokens in main.css.
// `ui` (mode / unit / search ...) is module state shared by every user of this module.
import { formatInt } from "../format.js";
import {
  aggregate, groupTotals, isEmpty, unitGroups, shortRound, niceTicks, compact,
  top3Rows, spentSum, limitStatus, notYetRequested, stockRows, avgPerMonth, buildCsv,
} from "./dashboard_calc.js";

export function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const SERIES = [
  { key: "req", label: "ขอเบิก", cls: "req" },
  { key: "got", label: "ได้รับจริง", cls: "got" },
  { key: "used", label: "ใช้ไป", cls: "used" },
];
export const MIXED_UNITS = "หน่วยนับรวม (ต่างชนิด)";
export const ROW_PAGE = 50;
export const STOCK_PAGE = 10;

// UI state survives re-opening the page (toggle / unit); the FY and search do not.
export const ui = { mode: "qty", unit: "all", search: "", showAll: false, limit: ROW_PAGE, stockLimit: STOCK_PAGE };

export const fullRound = (m) => `ขอเบิก ${shortRound(m)}`;
export const fmt = (v) => formatInt(v);
export const unitWord = () => (ui.mode === "baht" ? "บาท" : "หน่วย");
export const pctText = (p) => (p == null ? "—" : `${Math.round(p * 1000) / 10}%`);

// ---------------------------------------------------------------- SVG pieces
export function barPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function legendHtml(items) {
  return `<ul class="dash-legend">${items
    .map((s) => {
      const shape = s.shape === "line-dashed" ? "line dash-key-dashed" : s.shape === "line" ? "line" : "box";
      return `<li><span class="dash-key dash-key-${shape} dash-c-${s.cls}" aria-hidden="true"></span>${esc(s.label)}</li>`;
    })
    .join("")}</ul>`;
}

export function axisSvg(g) {
  // horizontal hairline grid + y tick labels + x labels
  const { W, H, L, R, T, B, ticks, top, rounds, gw } = g;
  const ph = H - T - B;
  const y = (v) => T + ph - (v / top) * ph;
  let s = "";
  ticks.forEach((t) => {
    s += `<line class="dash-grid${t === 0 ? " dash-base" : ""}" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text class="dash-ytick" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(compact(t))}</text>`;
  });
  rounds.forEach((m, i) => {
    s += `<text class="dash-xtick" x="${L + gw * i + gw / 2}" y="${H - B + 18}" text-anchor="middle">${esc(shortRound(m))}</text>`;
  });
  return { svg: s, y };
}

export function geometry(rounds, maxV) {
  const W = 720, H = 300, L = 50, R = 12, T = 14, B = 36;
  const { ticks, top } = niceTicks(maxV);
  return { W, H, L, R, T, B, ticks, top, rounds, gw: (W - L - R) / rounds.length, ph: H - T - B };
}

export function summaryLabel(prefix, parts) {
  return `${prefix} — ${parts.join(" · ")}`;
}

/** Grouped monthly bars. tips[i] = {x, title, rows:[{cls,label,value}]} */
export function barChart(agg) {
  const { rounds, perRound, totals } = agg;
  const maxV = Math.max(0, ...perRound.req, ...perRound.got, ...perRound.used);
  const g = geometry(rounds, maxV);
  const ax = axisSvg(g);
  const bw = Math.max(4, Math.min(16, (g.gw * 0.8 - 4) / 3));
  const groupW = bw * 3 + 4;
  let bars = "";
  let hits = "";
  const tips = [];
  rounds.forEach((m, i) => {
    const cx = g.L + g.gw * i + g.gw / 2;
    const x0 = cx - groupW / 2;
    SERIES.forEach((s, k) => {
      const v = perRound[s.key][i];
      if (!(v > 0)) return;
      const h = (v / g.top) * g.ph;
      bars += `<path class="dash-bar dash-f-${s.cls}" d="${barPath(x0 + k * (bw + 2), g.T + g.ph - h, bw, h, 4)}"/>`;
    });
    const rows = SERIES.map((s) => ({ cls: s.cls, label: s.label, value: `${fmt(perRound[s.key][i])} ${unitWord()}` }));
    tips.push({ x: cx, title: fullRound(m), rows });
    const aria = `${fullRound(m)}: ` + rows.map((r) => `${r.label} ${r.value}`).join(", ");
    hits += `<rect class="dash-hit" data-i="${i}" x="${g.L + g.gw * i}" y="${g.T}" width="${g.gw}" height="${g.ph}" tabindex="0" role="img" aria-label="${esc(aria)}"/>`;
  });
  const label = summaryLabel("กราฟแท่งรายรอบ ขอเบิก ได้รับจริง ใช้ไป", SERIES.map((s) => `${s.label}รวม ${fmt(totals[s.key])} ${unitWord()}`));
  const svg = `<svg class="dash-svg" viewBox="0 0 ${g.W} ${g.H}" role="group" aria-label="${esc(label)}">
    <title>${esc(label)}</title>${ax.svg}${bars}${hits}</svg>`;
  return { svg, tips, table: tableForBars(agg) };
}

/** Cumulative lines (+ previous FY as a dashed neutral line). */
export function lineChart(agg, data) {
  const { rounds, cumul, totals, lastActive, prevCum } = agg;
  const last = lastActive;
  const hasUsed = totals.used > 0;
  const maxV = Math.max(0, ...cumul.req, ...cumul.got, ...cumul.used, ...(prevCum || [0]));
  const g = geometry(rounds, maxV);
  const ax = axisSvg(g);
  const px = (i) => g.L + g.gw * i + g.gw / 2;
  let lines = "";
  const draw = (arr, cls, upto, dashed) => {
    if (upto < 0) return;
    const pts = [];
    for (let i = 0; i <= upto; i++) pts.push(`${px(i)},${ax.y(arr[i])}`);
    lines += `<polyline class="dash-line dash-s-${cls}${dashed ? " dash-dashed" : ""}" points="${pts.join(" ")}"/>`;
    lines += `<circle class="dash-dot dash-f-${cls}" cx="${px(upto)}" cy="${ax.y(arr[upto])}" r="4"/>`;
  };
  if (prevCum) draw(prevCum, "prev", rounds.length - 1, true);
  draw(cumul.req, "req", last);
  draw(cumul.got, "got", last);
  if (hasUsed) draw(cumul.used, "used", last);

  const prevLabel = data.fy ? `ปีงบ ${data.fy - 1} (ปีก่อน)` : "ปีก่อน";
  let hits = "";
  const tips = [];
  rounds.forEach((m, i) => {
    const rows = [];
    if (i <= last) {
      SERIES.forEach((s) => {
        if (s.key === "used" && !hasUsed) return;
        rows.push({ cls: s.cls, label: `${s.label} (สะสม)`, value: `${fmt(cumul[s.key][i])} ${unitWord()}` });
      });
    } else {
      rows.push({ cls: "none", label: "ยังไม่มีข้อมูลรอบนี้", value: "" });
    }
    if (prevCum) rows.push({ cls: "prev", label: `${prevLabel} (สะสม)`, value: `${fmt(prevCum[i])} ${unitWord()}`, dashed: true });
    tips.push({ x: px(i), title: fullRound(m), rows });
    const aria = `${fullRound(m)}: ` + rows.map((r) => `${r.label} ${r.value}`.trim()).join(", ");
    hits += `<rect class="dash-hit" data-i="${i}" x="${g.L + g.gw * i}" y="${g.T}" width="${g.gw}" height="${g.ph}" tabindex="0" role="img" aria-label="${esc(aria)}"/>`;
  });
  const xhair = `<line class="dash-xhair" x1="0" x2="0" y1="${g.T}" y2="${g.T + g.ph}" hidden/>`;
  const label = summaryLabel("กราฟเส้นยอดสะสมตลอดปีงบ", SERIES.map((s) => `${s.label}สะสม ${fmt(totals[s.key])} ${unitWord()}`));
  const svg = `<svg class="dash-svg" viewBox="0 0 ${g.W} ${g.H}" role="group" aria-label="${esc(label)}">
    <title>${esc(label)}</title>${ax.svg}${lines}${xhair}${hits}</svg>`;
  return { svg, tips, prevLabel, hasUsed, table: tableForCum(agg, prevLabel, hasUsed) };
}

export function tableForBars(agg) {
  const { rounds, perRound } = agg;
  return `<table class="dash-table dash-table-sm"><caption class="sr-only">ยอดรายรอบ (${unitWord()})</caption>
    <thead><tr><th scope="col">รอบ</th>${SERIES.map((s) => `<th scope="col" class="num">${esc(s.label)}</th>`).join("")}</tr></thead>
    <tbody>${rounds.map((m, i) => `<tr><th scope="row">${esc(fullRound(m))}</th>${SERIES.map((s) => `<td class="num">${fmt(perRound[s.key][i])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export function tableForCum(agg, prevLabel, hasUsed) {
  const { rounds, cumul, prevCum, lastActive } = agg;
  const cols = SERIES.filter((s) => s.key !== "used" || hasUsed);
  return `<table class="dash-table dash-table-sm"><caption class="sr-only">ยอดสะสม (${unitWord()})</caption>
    <thead><tr><th scope="col">รอบ</th>${cols.map((s) => `<th scope="col" class="num">${esc(s.label)}สะสม</th>`).join("")}${prevCum ? `<th scope="col" class="num">${esc(prevLabel)}</th>` : ""}</tr></thead>
    <tbody>${rounds.map((m, i) => `<tr><th scope="row">${esc(fullRound(m))}</th>${cols.map((s) => `<td class="num">${i <= lastActive ? fmt(cumul[s.key][i]) : "–"}</td>`).join("")}${prevCum ? `<td class="num">${fmt(prevCum[i])}</td>` : ""}</tr>`).join("")}</tbody></table>`;
}

export function chartCardHtml(id, title, caption, legend, c) {
  return `
  <div class="dash-card" id="${id}">
    <h3>${esc(title)}</h3>
    <p class="muted small dash-caption">${caption}</p>
    ${legend}
    <div class="dash-chart">
      <div class="dash-scroll">${c.svg}</div>
      <div class="dash-tip" hidden role="status"></div>
    </div>
    <details class="dash-tableview"><summary>ดูเป็นตาราง</summary><div class="table-scroll">${c.table}</div></details>
  </div>`;
}

/** Hover / focus tooltip (values in primary ink, series keyed by a short line) — also a vertical crosshair on line charts. */
export function attachTips(card, tips) {
  const chart = card.querySelector(".dash-chart");
  const tip = chart.querySelector(".dash-tip");
  const xh = chart.querySelector(".dash-xhair");
  const svg = chart.querySelector("svg");
  const hide = () => { tip.hidden = true; if (xh) xh.setAttribute("hidden", ""); };
  const show = (i, clientX, clientY) => {
    const t = tips[i];
    if (!t) return;
    tip.textContent = "";
    const head = document.createElement("div");
    head.className = "dash-tip-title";
    head.textContent = t.title;
    tip.appendChild(head);
    t.rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "dash-tip-row";
      const key = document.createElement("span");
      key.className = `dash-key dash-key-line dash-c-${r.cls}${r.dashed ? " dash-key-dashed" : ""}`;
      const val = document.createElement("strong");
      val.textContent = r.value;
      const lab = document.createElement("span");
      lab.className = "dash-tip-label";
      lab.textContent = r.label;
      row.append(key, val, lab);
      tip.appendChild(row);
    });
    tip.hidden = false;
    if (xh) { xh.setAttribute("x1", t.x); xh.setAttribute("x2", t.x); xh.removeAttribute("hidden"); }
    const cr = chart.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = clientX - cr.left + 14;
    if (x + tw > cr.width) x = clientX - cr.left - tw - 14;
    x = Math.max(0, Math.min(x, cr.width - tw));
    const y = Math.max(0, Math.min(clientY - cr.top - th - 8, cr.height - th));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  svg.querySelectorAll(".dash-hit").forEach((r) => {
    const i = Number(r.dataset.i);
    r.addEventListener("pointermove", (ev) => show(i, ev.clientX, ev.clientY));
    r.addEventListener("pointerdown", (ev) => show(i, ev.clientX, ev.clientY));
    r.addEventListener("pointerleave", hide);
    r.addEventListener("focus", () => {
      const b = r.getBoundingClientRect();
      show(i, b.left + b.width / 2, b.top + b.height / 3);
    });
    r.addEventListener("blur", hide);
  });
  svg.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hide(); });
}

// ---------------------------------------------------------------- HTML sections
export function kpiHtml(agg, data) {
  const { totals, coverage, pctPlan } = agg;
  const flagged = agg.flagged || new Map();
  const pctMode = agg.pctBasis || ui.mode; // the admin overview only has % แผน in baht
  const unitLine = ui.mode === "baht" ? "บาท" : MIXED_UNITS;
  const tile = (label, value, sub, extra) => `
    <div class="dash-kpi">
      <div class="dash-kpi-label">${esc(label)}</div>
      <div class="dash-kpi-value">${value}</div>
      <div class="dash-kpi-unit muted small">${esc(unitLine)}</div>
      ${sub ? `<div class="dash-kpi-sub small">${sub}</div>` : ""}${extra || ""}
    </div>`;
  const pctTile = `
    <div class="dash-kpi">
      <div class="dash-kpi-label">% ของแผนปี</div>
      <div class="dash-kpi-value">${esc(pctText(pctPlan))}</div>
      <div class="dash-kpi-unit muted small">${pctPlan == null ? "ยังไม่มีแผนหรือราคาสำหรับคำนวณ" : `ขอเบิกเทียบแผนปี (${pctMode === "baht" ? "บาท" : "จำนวน"}) · เฉพาะรายการที่มีแผน`}</div>
      ${pctPlan != null ? `<div class="dash-meter" role="img" aria-label="${esc(`ขอเบิกแล้ว ${pctText(pctPlan)} ของแผนปี`)}"><span style="width:${Math.min(100, pctPlan * 100).toFixed(1)}%"></span></div>` : ""}
    </div>`;
  const flagNote = flagged.size
    ? `<p class="dash-note" role="note"><span aria-hidden="true">ℹ️</span> มี ${flagged.size} รายการที่เบิกสะสมเร็วกว่าแผนเล็กน้อย — ดูรายการที่ติดป้าย “เบิกเร็วกว่าแผน” ในตารางด้านล่าง (เป็นข้อสังเกตเฉย ๆ ไม่ใช่ข้อผิดพลาด)</p>`
    : "";
  return `
    <div class="dash-kpis">
      ${tile("ขอเบิก", `<strong>${fmt(totals.req)}</strong>`, `สะสมปีงบ ${esc(data.fy)}`)}
      ${tile("ได้รับจริง", `<strong>${fmt(totals.got)}</strong>`, (data.pcu || data.network) ? "ที่จ่ายแล้ว (เห็นทุกหน่วยจ่าย ไม่ต้องรอจ่ายครบ)" : "นับเฉพาะหน่วยที่จ่ายแล้ว")}
      ${tile("ใช้ไป", `<strong>${fmt(totals.used)}</strong>`, coverage ? `มีข้อมูล ${esc(coverage.with)}/${esc(coverage.total)} รายการ` : "ตามที่ รพ.สต. กรอก")}
      ${pctTile}
    </div>${flagNote}`;
}

export function groupsHtml(data) {
  return groupRowsHtml(groupTotals(buildAll(data), unitGroups(data)));
}

/** Unit-group list (clickable rows = unit filter). rows = [{group, items, req, got, used, share}] */
export function groupRowsHtml(rows) {
  const maxShare = Math.max(0, ...rows.map((r) => r.share));
  if (!rows.length) return `<p class="muted">ไม่มีข้อมูล</p>`;
  return `<ul class="dash-groups">${rows
    .map((r) => `
    <li><button type="button" class="dash-group${ui.unit === r.group ? " is-on" : ""}" data-unit="${esc(r.group)}" aria-pressed="${ui.unit === r.group}">
      <span class="dash-group-head"><strong>${esc(r.group)}</strong><span class="muted small">${esc(r.items)} รายการ</span>
        <span class="dash-group-val"><strong>${fmt(r.req)}</strong> ${unitWord()} · ${Math.round(r.share * 100)}%</span></span>
      <span class="dash-hbar" aria-hidden="true"><span class="dash-f-req" style="width:${maxShare > 0 ? ((r.share / maxShare) * 100).toFixed(1) : 0}%"></span></span>
      <span class="muted small">ได้รับจริง ${fmt(r.got)} · ใช้ไป ${fmt(r.used)}</span>
    </button></li>`)
    .join("")}</ul>`;
}

/** Ranked list with a bar per row; `key` = "qty" | "baht" (rows from top3Rows / dash_calc). */
export function topListHtml(rows, key, emptyText) {
  if (!rows.length) return `<p class="muted">${esc(emptyText || "ยังไม่มีรายการที่ขอเบิก")}</p>`;
  const max = Math.max(...rows.map((r) => r[key]));
  return `<ol class="dash-top">${rows
    .map((r) => `
    <li>
      <span class="dash-top-name"><span class="dash-top-text">${esc(r.name)}</span> <span class="muted small">${esc(r.code)}${r.group ? ` · ${esc(r.group)}` : ""}</span></span>
      <span class="dash-hbar" aria-hidden="true"><span class="dash-f-req" style="width:${max > 0 ? ((r[key] / max) * 100).toFixed(1) : 0}%"></span></span>
      <span class="dash-top-val"><strong>${fmt(r[key])}</strong> <span class="muted small">${key === "baht" ? "บาท" : esc(r.unit || "หน่วย")}</span></span>
    </li>`)
    .join("")}</ol>`;
}

/** Two-column card: by qty | by baht. `tops` = {qty:[], baht:[]}. */
export function twoColCardHtml(title, caption, tops, emptyText) {
  return `<div class="dash-card">
      <h3>${esc(title)}</h3>
      <p class="muted small dash-caption">${esc(caption)}</p>
      <div class="dash-two">
        <div><h4 class="dash-sub-h">ตามจำนวน</h4>${topListHtml(tops.qty, "qty", emptyText)}</div>
        <div><h4 class="dash-sub-h">ตามบาท</h4>${topListHtml(tops.baht, "baht", emptyText)}</div>
      </div></div>`;
}

/** Collapsible name list: <details> with a count in the summary. items = [{code,name,unit?, note?}] */
export function detailsListHtml(summary, items) {
  if (!items.length) return "";
  return `<details class="dash-det"><summary>${esc(summary)} (${fmt(items.length)} รายการ)</summary>
    <ul class="dash-plain">${items.map((r) => `<li>${esc(r.name)} <span class="muted small">${esc(r.code)}${r.unit ? ` · ${esc(r.unit)}` : ""}</span>${r.note ? ` <span class="small">${esc(r.note)}</span>` : ""}</li>`).join("")}</ul></details>`;
}

// ---------------------------------------------------------------- brief 2aa cards (PCU dashboard + admin per-PCU view)
export function spentHtml(rows, data) {
  const total = spentSum(rows, data.spent);
  return `<div class="dash-card dash-spent"><div class="dash-kpi-label">ใช้ไปสะสมปีงบ ${esc(data.fy)}</div>
    <div class="dash-kpi-value"><strong>${fmt(total)}</strong> <span class="muted small">บาท</span></div>
    <p class="muted small dash-caption">คิดจากราคากลางในระบบ อาจไม่ตรงกับราคาที่ได้รับจริง</p></div>`;
}

export function stockCardHtml(data) {
  const all = stockRows(data, ui.unit);
  const hasAny = Object.keys(data.stock_latest || {}).length > 0;
  const list = all.slice(0, ui.stockLimit);
  const body = list.map((r) => `<tr>
      <th scope="row" class="dash-name"><div>${esc(r.name)}</div><div class="muted small">${esc(r.code)}${r.unit ? ` · ${esc(r.unit)}` : ""}</div></th>
      <td>${esc(shortRound(r.round))}</td>
      <td class="num">${fmt(r.stock)}</td>
      <td class="num">${r.got == null ? '<span class="muted">รอจ่าย</span>' : fmt(r.got)}</td>
      <td class="num strong">${r.total == null ? '<span class="muted">–</span>' : fmt(r.total)}</td></tr>`).join("");
  const more = all.length > list.length ? `<button type="button" class="btn btn-secondary dash-stock-more">แสดงเพิ่ม (เหลืออีก ${all.length - list.length} รายการ)</button>` : "";
  return `<div class="dash-card" id="dash-stock-card"><h3>คงเหลือ (stock)</h3>
    <p class="muted small dash-caption">ต่อรายการ ใช้รอบล่าสุดที่กรอกคงเหลือ (ระบุรอบในแต่ละแถว) · ของเดิม + ได้เพิ่ม = รวม · เฉพาะรายการที่กรอกคงเหลือแล้ว</p>
    ${!hasAny ? `<p class="muted">ยังไม่ได้กรอกคงเหลือ</p>` : !all.length ? `<p class="muted">ไม่มีรายการในหน่วยจ่ายนี้</p>` : `
    <div class="table-scroll dash-table-wrap"><table class="dash-table dash-table-sm">
      <caption class="sr-only">คงเหลือล่าสุดต่อรายการ</caption>
      <thead><tr><th scope="col" class="dash-name">รายการ</th><th scope="col">รอบ</th><th scope="col" class="num">ของเดิม</th><th scope="col" class="num">ได้เพิ่ม</th><th scope="col" class="num">รวม</th></tr></thead>
      <tbody>${body}</tbody></table></div>${more}`}</div>`;
}

export function limitCardHtml(rows, data) {
  const st = limitStatus(rows, data.limits);
  if (!st.over.length && !st.near.length) return "";
  const line = (r) => `<li>${esc(r.name)} <span class="muted small">${esc(r.code)}</span> — <strong>${fmt(r.cum)}</strong> / ${fmt(r.limit)} ${esc(r.unit || "หน่วย")} <span class="small">(${Math.round(r.pct * 100)}%)</span></li>`;
  return `<div class="notice notice-info dash-card dash-limit" role="note">
    <h3>เพดานรายปี</h3>
    <p class="small dash-caption">เพื่อใช้ประมาณการปีถัดไปให้แม่นยำขึ้น (แจ้งให้ทราบเท่านั้น ไม่ได้ห้ามเบิก)</p>
    ${st.over.length > 5 // a long list stays collapsed (mobile)
      ? `<details class="dash-det"><summary><strong>เกินเพดานรายปี (${fmt(st.over.length)} รายการ)</strong> — กดเพื่อดูทั้งหมด</summary><ul class="dash-plain">${st.over.map(line).join("")}</ul></details>`
      : st.over.length ? `<h4 class="dash-sub-h">เกินเพดานรายปี (${fmt(st.over.length)} รายการ)</h4><ul class="dash-plain">${st.over.map(line).join("")}</ul>` : ""}
    ${st.near.length ? `<h4 class="dash-sub-h">ใกล้เพดาน (≥ 80%${st.nearTotal > st.near.length ? ` · แสดง 3 อันดับแรกจาก ${fmt(st.nearTotal)}` : ""})</h4><ul class="dash-plain">${st.near.map(line).join("")}</ul>` : ""}
  </div>`;
}

export function neverCardHtml(rows, data, { hiddenLink } = {}) {
  const { prev, never } = notYetRequested(rows, data.prev_items);
  if (!prev.length && !never.length) return "";
  const prevYear = data.fy ? ` (ปีงบ ${data.fy - 1})` : "";
  const link = hiddenLink ? ` <a href="#/hidden">ไปหน้าซ่อนรายการ</a>` : "";
  return `<div class="dash-card"><h3>ยังไม่เคยเบิกปีนี้</h3>
    <p class="muted small dash-caption">รายการในฟอร์มที่ยังไม่มีการขอเบิกในปีงบ ${esc(data.fy)} (ไม่รวมรายการที่ซ่อน) · ชื่อตามฟอร์มล่าสุด</p>
    ${prev.length ? detailsListHtml(`ปีก่อนเคยเบิก${prevYear}`, prev.map((r) => ({ ...r, note: `ปีก่อน ${fmt(r.prevQty)}` }))) : ""}
    ${never.length ? detailsListHtml("ไม่เคยเบิกทั้ง 2 ปี — พิจารณาซ่อนรายการ", never) : ""}
    ${never.length && link ? `<p class="small">${link}</p>` : ""}</div>`;
}

/** Heat colour: single-hue (--dv-req) mixed into the surface; capped at 50 % so text in primary ink stays legible in light + dark. */
export function heatPct(baht, max) {
  return baht > 0 && max > 0 ? Math.round(8 + (baht / max) * 42) : 0;
}

export function heatLegendHtml() {
  return `<div class="dash-heat-legend small muted" aria-hidden="true"><span>สีตามยอดบาทต่อช่อง (ต่ำ</span>${[0.1, 0.35, 0.6, 0.85, 1]
    .map((f) => `<i style="background:color-mix(in srgb, var(--dv-req) ${Math.round(8 + f * 42)}%, transparent)"></i>`).join("")}<span>สูง) · ไม่ระบายสี = ไม่ได้ขอ</span></div>`;
}

/** Rows matching the current search / show-all (before paging) — shared by the table and the CSV export. */
export function visibleRows(agg) {
  const q = ui.search.trim().toLowerCase();
  const list = agg.rows.filter((r) => {
    if (q) return r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q);
    return ui.showAll || r.cum.req > 0 || r.cum.got > 0 || r.cum.used > 0;
  });
  return list.sort((a, b) => b.cum.req - a.cum.req || a.name.localeCompare(b.name, "th"));
}

export function downloadCsv(data, rows) {
  const text = buildCsv(data, rows);
  const pcu = data.pcu && (data.pcu.code || (typeof data.pcu === "string" ? data.pcu : ""));
  const name = `dashboard_${pcu ? `${pcu}_` : ""}${data.fy}.csv`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function tableHtml(agg, data, { heat } = {}) {
  const { rounds, rows, flagged } = agg;
  let list = visibleRows(agg);
  const total = list.length;
  list = list.slice(0, ui.limit);
  const dash = '<span class="muted">–</span>';
  const cell = (v) => (v ? fmt(v) : dash);
  const elapsed = Number(data.elapsed) || 0;
  const maxHeat = heat ? Math.max(0, ...list.flatMap((r) => r.rb)) : 0;
  const roundCell = (r, i) => {
    if (!heat) return `<td class="num">${cell(r.m.req[i])}</td>`;
    const q = r.rq[i];
    const b = r.rb[i];
    if (!(q > 0) && !(b > 0)) return `<td class="num dash-heatcell">${dash}</td>`;
    const p = heatPct(b, maxHeat);
    return `<td class="num dash-heatcell"${p ? ` style="background:color-mix(in srgb, var(--dv-req) ${p}%, transparent)"` : ""}><div>${fmt(q)}</div><div class="dash-heat-sub">${fmt(b)} บาท</div></td>`;
  };
  const body = list
    .map((r) => {
      const f = flagged.get(r.code);
      const flag = f
        ? ` <span class="badge badge-info dash-flag" title="${esc(f.plan_qty != null ? `สะสม ${fmt(f.cum_qty != null ? f.cum_qty : f.value)} จากแผนปี ${fmt(f.plan_qty)} (ผ่านไป ${f.elapsed}/12 รอบ)` : `สะสม ${fmt(f.value)} เกินเกณฑ์ ${fmt(f.threshold)}`)}">⏱ เบิกเร็วกว่าแผน</span>`
        : "";
      const avg = avgPerMonth(r.cum.req, elapsed);
      return `<tr>
        <th scope="row" class="dash-name"><div>${esc(r.name)}${flag}</div><div class="muted small">${esc(r.code)}${r.unit ? ` · ${esc(r.unit)}` : ""} · ${esc(r.group)}</div></th>
        ${rounds.map((_, i) => roundCell(r, i)).join("")}
        <td class="num strong">${cell(r.cum.req)}</td>
        <td class="num">${cell(r.cum.got)}</td>
        <td class="num">${cell(r.cum.used)}</td>
        <td class="num">${r.plan != null ? fmt(r.plan) : dash}</td>
        <td class="num">${esc(pctText(r.pct))}</td>
        <td class="num">${avg == null ? dash : cell(avg)}</td>
        <td class="num">${avg == null ? dash : cell(avg * 12)}</td>
      </tr>`;
    })
    .join("");
  const more = total > ui.limit ? `<button type="button" class="btn btn-secondary dash-more">แสดงเพิ่ม (เหลืออีก ${total - ui.limit} รายการ)</button>` : "";
  const cellNote = heat ? "ช่องรายเดือน = จำนวน (บรรทัดบน) / บาท (บรรทัดล่าง)" : `ค่ารายเดือน = ขอเบิก (${ui.mode === "baht" ? "บาท" : "จำนวน"})`;
  return `
    <p class="muted small" aria-live="polite">แสดง ${list.length} จาก ${total} รายการ · ${cellNote} · เฉลี่ย/เดือน = สะสมขอเบิก ÷ ${elapsed || "–"} รอบที่ผ่านไป (${ui.mode === "baht" ? "บาท" : "จำนวน"}) · แผนปี${ui.mode === "baht" ? "เป็นบาท = แผน × ราคาล่าสุด" : ""}</p>
    ${heat && total ? heatLegendHtml() : ""}
    ${total === 0 ? `<p class="muted">ไม่พบรายการ</p>` : `
    <div class="table-scroll dash-table-wrap">
      <table class="dash-table${heat ? " dash-heat" : ""}">
        <thead><tr>
          <th scope="col" class="dash-name">รายการ</th>
          ${rounds.map((m) => `<th scope="col" class="num" title="${esc(fullRound(m))}">${esc(shortRound(m))}</th>`).join("")}
          <th scope="col" class="num">สะสมขอเบิก</th><th scope="col" class="num">ได้รับจริง</th><th scope="col" class="num">ใช้ไป</th>
          <th scope="col" class="num">แผนปี</th><th scope="col" class="num">% แผน</th>
          <th scope="col" class="num">เฉลี่ย/เดือน</th><th scope="col" class="num">คาดทั้งปี</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>${more}`}`;
}

// rows for the group breakdown (ignores the unit filter) — cached per payload+mode
const rowCache = { data: null, mode: null, rows: null };
export function buildAll(data) {
  if (rowCache.data === data && rowCache.mode === ui.mode) return rowCache.rows;
  rowCache.rows = aggregate(data, ui.mode, "all").allRows;
  rowCache.data = data;
  rowCache.mode = ui.mode;
  return rowCache.rows;
}

// ---------------------------------------------------------------- page
export function seg(name, options, current, labelId) {
  return `<div class="dash-seg" role="group" aria-labelledby="${labelId}">${options
    .map((o) => `<button type="button" class="dash-seg-btn${o.value === current ? " is-on" : ""}" data-${name}="${esc(o.value)}" aria-pressed="${o.value === current}">${esc(o.label)}</button>`)
    .join("")}</div>`;
}

/** Controls row: [fy select] + mode (จำนวน/บาท; `mode:false` omits it — admin is baht only) + unit filter. `fys` only matters when it has more than one year. */
export function controlsHtml(data, groups, { mode = true } = {}) {
  const fys = Array.isArray(data.fys) ? data.fys : [];
  const fySel = fys.length > 1
    ? `<label class="dash-ctl"><span class="dash-ctl-label">ปีงบประมาณ</span>
          <select class="fy-select dash-fy" aria-label="เลือกปีงบประมาณ">${fys.map((f) => `<option value="${esc(f)}"${f === data.fy ? " selected" : ""}>ปีงบ ${esc(f)}</option>`).join("")}</select></label>`
    : "";
  return `<div class="dash-controls">
        ${fySel}
        ${mode ? `<div class="dash-ctl"><span class="dash-ctl-label" id="dash-l-mode">แสดงเป็น</span>${seg("mode", [{ value: "qty", label: "จำนวน" }, { value: "baht", label: "บาท" }], ui.mode, "dash-l-mode")}</div>` : ""}
        <div class="dash-ctl"><span class="dash-ctl-label" id="dash-l-unit">หน่วยจ่าย</span>${seg("unit", [{ value: "all", label: "ทั้งหมด" }, ...groups.map((g) => ({ value: g, label: g }))], ui.unit, "dash-l-unit")}</div>
      </div>`;
}

/** The per-item body of the PCU dashboard (KPI, charts, unit groups, top 10, table). */
export function bodyShellHtml() {
  return `<div id="dash-body">
        <div id="dash-kpi"></div>
        <div id="dash-spent"></div>
        <div id="dash-bars"></div>
        <div id="dash-cum"></div>
        <div id="dash-stock"></div>
        <div id="dash-limit"></div>
        <div id="dash-never"></div>
        <div class="dash-card"><h3>แยกตามหน่วยจ่าย</h3>
          <p class="muted small dash-caption">ยอดขอเบิกสะสมปีงบ — แสดงทุกหน่วยจ่ายเสมอ กดแถวเพื่อกรองทั้งหน้า</p><div id="dash-groups"></div></div>
        <div id="dash-top"></div>
        <div class="dash-card"><h3>รายการทั้งหมด</h3>
          <div class="dash-tools">
            <input type="text" class="select-input dash-search" placeholder="ค้นหาชื่อหรือรหัสรายการ" aria-label="ค้นหารายการ" autocomplete="off">
            <label class="switch-label"><input type="checkbox" class="dash-showall"> รวมรายการที่ยังไม่เบิก</label>
            <button type="button" class="btn btn-secondary dash-export-xlsx" title="ไฟล์ Excel (.xlsx) แยกทุกเดือน ทุกรายการ — แผ่น data สำหรับทำสถิติ + แผ่น สรุป">ดาวน์โหลด Excel (.xlsx)</button>
            <button type="button" class="btn btn-secondary dash-export" title="ไฟล์ CSV สรุปตามตารางนี้ เปิดด้วย Excel ได้">ดาวน์โหลด CSV</button>
          </div>
          <div id="dash-table"></div></div>
      </div>`;
}

/**
 * Wires the controls + body inside `box` (which holds controlsHtml() and bodyShellHtml()) for a pcuDashboard-shaped payload.
 * `onRender(agg)` runs after every body render (the admin view hangs its extra sections there).
 * `heat` = heatmap table (admin per-PCU view); `hiddenLink` = link to #/hidden in the never-requested card (PCU page only).
 */
export function createBody(box, data, { onRender, heat = false, hiddenLink = false, xlsx = null } = {}) {
  let agg = null;
  const $ = (id) => box.querySelector(id);

  function syncSeg() {
    box.querySelectorAll(".dash-seg-btn").forEach((b) => {
      const on = b.dataset.mode ? b.dataset.mode === ui.mode : b.dataset.unit === ui.unit;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function setUnit(u) {
    ui.unit = u;
    ui.limit = ROW_PAGE;
    ui.stockLimit = STOCK_PAGE;
    syncSeg();
    renderBody();
  }

  function renderTable() {
    const t = $("#dash-table");
    if (!t || !agg) return;
    t.innerHTML = tableHtml(agg, data, { heat });
    const more = t.querySelector(".dash-more");
    if (more) more.addEventListener("click", () => { ui.limit += ROW_PAGE; renderTable(); });
  }

  function renderStock() {
    const host = $("#dash-stock");
    host.innerHTML = stockCardHtml(data);
    const more = host.querySelector(".dash-stock-more");
    if (more) more.addEventListener("click", () => { ui.stockLimit += STOCK_PAGE; renderStock(); });
  }

  function renderBody() {
    agg = aggregate(data, ui.mode, ui.unit);
    $("#dash-kpi").innerHTML = kpiHtml(agg, data);
    $("#dash-spent").innerHTML = spentHtml(agg.rows, data);
    renderStock();
    $("#dash-limit").innerHTML = limitCardHtml(agg.rows, data);
    $("#dash-never").innerHTML = neverCardHtml(agg.rows, data, { hiddenLink });

    const mixed = ui.mode === "qty" ? ` · ${MIXED_UNITS}` : "";
    const scope = ui.unit === "all" ? "ทุกหน่วยจ่าย" : `หน่วยจ่าย ${ui.unit}`;
    const bars = barChart(agg);
    $("#dash-bars").innerHTML = chartCardHtml("dash-bars-card", "ยอดรายรอบ", `${esc(scope)} · ${ui.mode === "baht" ? "บาท" : "จำนวน"}${esc(mixed)}`,
      legendHtml(SERIES.map((s) => ({ cls: s.cls, label: s.label }))), bars);
    attachTips($("#dash-bars-card"), bars.tips);

    const line = lineChart(agg, data);
    const legend = SERIES.filter((s) => s.key !== "used" || line.hasUsed).map((s) => ({ cls: s.cls, label: `${s.label}สะสม`, shape: "line" }));
    if (agg.prevCum) legend.push({ cls: "prev", label: line.prevLabel, shape: "line-dashed" });
    const prevNote = data.prev_fy
      ? (agg.prevCum ? "" : " · เส้นปีก่อนแสดงเมื่อเลือกหน่วยจ่าย “ทั้งหมด”")
      : "";
    $("#dash-cum").innerHTML = chartCardHtml("dash-cum-card", "ยอดสะสมตลอดปีงบ", `${esc(scope)} · ${ui.mode === "baht" ? "บาท" : "จำนวน"}${esc(mixed)}${esc(prevNote)}`,
      legendHtml(legend), line);
    attachTips($("#dash-cum-card"), line.tips);

    const g = $("#dash-groups");
    g.innerHTML = groupsHtml(data);
    g.querySelectorAll(".dash-group").forEach((b) => b.addEventListener("click", () => setUnit(ui.unit === b.dataset.unit ? "all" : b.dataset.unit)));

    $("#dash-top").innerHTML = twoColCardHtml("3 รายการที่ขอเบิกมากที่สุด", `ยอดขอเบิกสะสมปีงบ · ${scope} · แสดงทั้งตามจำนวนและตามบาท`, top3Rows(agg.rows, 3));
    renderTable();
    if (onRender) onRender(agg);
  }

  function bind() {
    box.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { ui.mode = b.dataset.mode; syncSeg(); renderBody(); }));
    box.querySelectorAll("[data-unit]:not(.dash-group)").forEach((b) => b.addEventListener("click", () => setUnit(b.dataset.unit)));
    const search = $(".dash-search");
    search.value = ui.search;
    search.addEventListener("input", () => { ui.search = search.value; ui.limit = ROW_PAGE; renderTable(); });
    const showAll = $(".dash-showall");
    showAll.checked = ui.showAll;
    showAll.addEventListener("change", () => { ui.showAll = showAll.checked; ui.limit = ROW_PAGE; renderTable(); });
    renderBody();
    const exp = $(".dash-export");
    if (exp) exp.addEventListener("click", () => { if (agg) downloadCsv(data, visibleRows(agg)); });
    // 2ag: the Excel (.xlsx) button exists only where the page supplies a builder (the PCU dashboard)
    const xl = $(".dash-export-xlsx");
    if (xl && !xlsx) xl.remove();
    else if (xl) {
      xl.addEventListener("click", async () => {
        const label = xl.textContent;
        xl.disabled = true;
        xl.textContent = "กำลังสร้างไฟล์…";
        try { await xlsx(); } finally { xl.disabled = false; xl.textContent = label; }
      });
    }
  }

  return { bind, renderBody, setUnit, syncSeg };
}

export { isEmpty, unitGroups };
