// Brief 2q — PCU dashboard (#/dashboard): ขอเบิก / ได้รับจริง / ใช้ไป per round + FY cumulative, by quantity or baht,
// unit-group breakdown, top 10 and a searchable per-item table. Data = pcuDashboard{fy} (fetched when the page opens,
// not part of the bootstrap). Charts are hand-written SVG (no library); colors come from the --dv-* tokens in main.css.
import { call, getPcuToken } from "../api.js";
import * as auth from "../auth.js";
import { formatInt } from "../format.js";
import { esc } from "./common.js";
import { aggregate, groupTotals, isEmpty, unitGroups, shortRound, niceTicks, compact } from "./dashboard_calc.js";

const SERIES = [
  { key: "req", label: "ขอเบิก", cls: "req" },
  { key: "got", label: "ได้รับจริง", cls: "got" },
  { key: "used", label: "ใช้ไป", cls: "used" },
];
const MIXED_UNITS = "หน่วยนับรวม (ต่างชนิด)";
const ROW_PAGE = 50;

// UI state survives re-opening the page (toggle / unit); the FY and search do not.
const ui = { mode: "qty", unit: "all", search: "", showAll: false, limit: ROW_PAGE };

const fullRound = (m) => `ขอเบิก ${shortRound(m)}`;
const fmt = (v) => formatInt(v);
const unitWord = () => (ui.mode === "baht" ? "บาท" : "หน่วย");
const pctText = (p) => (p == null ? "—" : `${Math.round(p * 1000) / 10}%`);

// ---------------------------------------------------------------- SVG pieces
function barPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function legendHtml(items) {
  return `<ul class="dash-legend">${items
    .map((s) => {
      const shape = s.shape === "line-dashed" ? "line dash-key-dashed" : s.shape === "line" ? "line" : "box";
      return `<li><span class="dash-key dash-key-${shape} dash-c-${s.cls}" aria-hidden="true"></span>${esc(s.label)}</li>`;
    })
    .join("")}</ul>`;
}

function axisSvg(g) {
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

function geometry(rounds, maxV) {
  const W = 720, H = 300, L = 50, R = 12, T = 14, B = 36;
  const { ticks, top } = niceTicks(maxV);
  return { W, H, L, R, T, B, ticks, top, rounds, gw: (W - L - R) / rounds.length, ph: H - T - B };
}

function summaryLabel(prefix, parts) {
  return `${prefix} — ${parts.join(" · ")}`;
}

/** Grouped monthly bars. tips[i] = {x, title, rows:[{cls,label,value}]} */
function barChart(agg) {
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
function lineChart(agg, data) {
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

function tableForBars(agg) {
  const { rounds, perRound } = agg;
  return `<table class="dash-table dash-table-sm"><caption class="sr-only">ยอดรายรอบ (${unitWord()})</caption>
    <thead><tr><th scope="col">รอบ</th>${SERIES.map((s) => `<th scope="col" class="num">${esc(s.label)}</th>`).join("")}</tr></thead>
    <tbody>${rounds.map((m, i) => `<tr><th scope="row">${esc(fullRound(m))}</th>${SERIES.map((s) => `<td class="num">${fmt(perRound[s.key][i])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function tableForCum(agg, prevLabel, hasUsed) {
  const { rounds, cumul, prevCum, lastActive } = agg;
  const cols = SERIES.filter((s) => s.key !== "used" || hasUsed);
  return `<table class="dash-table dash-table-sm"><caption class="sr-only">ยอดสะสม (${unitWord()})</caption>
    <thead><tr><th scope="col">รอบ</th>${cols.map((s) => `<th scope="col" class="num">${esc(s.label)}สะสม</th>`).join("")}${prevCum ? `<th scope="col" class="num">${esc(prevLabel)}</th>` : ""}</tr></thead>
    <tbody>${rounds.map((m, i) => `<tr><th scope="row">${esc(fullRound(m))}</th>${cols.map((s) => `<td class="num">${i <= lastActive ? fmt(cumul[s.key][i]) : "–"}</td>`).join("")}${prevCum ? `<td class="num">${fmt(prevCum[i])}</td>` : ""}</tr>`).join("")}</tbody></table>`;
}

function chartCardHtml(id, title, caption, legend, c) {
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
function attachTips(card, tips) {
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
function kpiHtml(agg, data) {
  const { totals, coverage, pctPlan, flagged } = agg;
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
      <div class="dash-kpi-unit muted small">${pctPlan == null ? "ยังไม่มีแผนหรือราคาสำหรับคำนวณ" : `ขอเบิกเทียบแผนปี (${ui.mode === "baht" ? "บาท" : "จำนวน"}) · เฉพาะรายการที่มีแผน`}</div>
      ${pctPlan != null ? `<div class="dash-meter" role="img" aria-label="${esc(`ขอเบิกแล้ว ${pctText(pctPlan)} ของแผนปี`)}"><span style="width:${Math.min(100, pctPlan * 100).toFixed(1)}%"></span></div>` : ""}
    </div>`;
  const flagNote = flagged.size
    ? `<p class="dash-note" role="note"><span aria-hidden="true">ℹ️</span> มี ${flagged.size} รายการที่เบิกสะสมเร็วกว่าแผนเล็กน้อย — ดูรายการที่ติดป้าย “เบิกเร็วกว่าแผน” ในตารางด้านล่าง (เป็นข้อสังเกตเฉย ๆ ไม่ใช่ข้อผิดพลาด)</p>`
    : "";
  return `
    <div class="dash-kpis">
      ${tile("ขอเบิก", `<strong>${fmt(totals.req)}</strong>`, `สะสมปีงบ ${esc(data.fy)}`)}
      ${tile("ได้รับจริง", `<strong>${fmt(totals.got)}</strong>`, "นับเฉพาะหน่วยที่จ่ายแล้ว")}
      ${tile("ใช้ไป", `<strong>${fmt(totals.used)}</strong>`, `มีข้อมูล ${esc(coverage.with)}/${esc(coverage.total)} รายการ`)}
      ${pctTile}
    </div>${flagNote}`;
}

function groupsHtml(data) {
  const rows = groupTotals(buildAll(data), unitGroups(data));
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

function topHtml(agg) {
  const { top } = agg;
  if (!top.length) return `<p class="muted">ยังไม่มีรายการที่ขอเบิก</p>`;
  const max = top[0].cum.req;
  return `<ol class="dash-top">${top
    .map((r) => `
    <li>
      <span class="dash-top-name"><span class="dash-top-text">${esc(r.name)}</span> <span class="muted small">${esc(r.code)}${r.unit ? ` · ${esc(r.unit)}` : ""}</span></span>
      <span class="dash-hbar" aria-hidden="true"><span class="dash-f-req" style="width:${((r.cum.req / max) * 100).toFixed(1)}%"></span></span>
      <span class="dash-top-val"><strong>${fmt(r.cum.req)}</strong> <span class="muted small">${unitWord()}</span></span>
    </li>`)
    .join("")}</ol>`;
}

function tableHtml(agg, data) {
  const { rounds, rows, flagged } = agg;
  const q = ui.search.trim().toLowerCase();
  let list = rows.filter((r) => {
    if (q) return r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q);
    return ui.showAll || r.cum.req > 0 || r.cum.got > 0 || r.cum.used > 0;
  });
  list.sort((a, b) => b.cum.req - a.cum.req || a.name.localeCompare(b.name, "th"));
  const total = list.length;
  list = list.slice(0, ui.limit);
  const dash = '<span class="muted">–</span>';
  const cell = (v) => (v ? fmt(v) : dash);
  const body = list
    .map((r) => {
      const f = flagged.get(r.code);
      const flag = f
        ? ` <span class="badge badge-info dash-flag" title="${esc(`สะสม ${fmt(f.cum_qty)} จากแผนปี ${fmt(f.plan_qty)} (ผ่านไป ${f.elapsed}/12 รอบ)`)}">⏱ เบิกเร็วกว่าแผน</span>`
        : "";
      return `<tr>
        <th scope="row" class="dash-name"><div>${esc(r.name)}${flag}</div><div class="muted small">${esc(r.code)}${r.unit ? ` · ${esc(r.unit)}` : ""} · ${esc(r.group)}</div></th>
        ${r.m.req.map((v) => `<td class="num">${cell(v)}</td>`).join("")}
        <td class="num strong">${cell(r.cum.req)}</td>
        <td class="num">${cell(r.cum.got)}</td>
        <td class="num">${cell(r.cum.used)}</td>
        <td class="num">${r.plan != null ? fmt(r.plan) : dash}</td>
        <td class="num">${esc(pctText(r.pct))}</td>
      </tr>`;
    })
    .join("");
  const more = total > ui.limit ? `<button type="button" class="btn btn-secondary dash-more">แสดงเพิ่ม (เหลืออีก ${total - ui.limit} รายการ)</button>` : "";
  return `
    <p class="muted small" aria-live="polite">แสดง ${list.length} จาก ${total} รายการ · ค่ารายเดือน = ขอเบิก (${ui.mode === "baht" ? "บาท" : "จำนวน"}) · แผนปี${ui.mode === "baht" ? "เป็นบาท = แผน × ราคาล่าสุด" : ""}</p>
    ${total === 0 ? `<p class="muted">ไม่พบรายการ</p>` : `
    <div class="table-scroll dash-table-wrap">
      <table class="dash-table">
        <thead><tr>
          <th scope="col" class="dash-name">รายการ</th>
          ${rounds.map((m) => `<th scope="col" class="num" title="${esc(fullRound(m))}">${esc(shortRound(m))}</th>`).join("")}
          <th scope="col" class="num">สะสมขอเบิก</th><th scope="col" class="num">ได้รับจริง</th><th scope="col" class="num">ใช้ไป</th>
          <th scope="col" class="num">แผนปี</th><th scope="col" class="num">% แผน</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>${more}`}`;
}

// rows for the group breakdown (ignores the unit filter) — cached per payload+mode
const rowCache = { data: null, mode: null, rows: null };
function buildAll(data) {
  if (rowCache.data === data && rowCache.mode === ui.mode) return rowCache.rows;
  rowCache.rows = aggregate(data, ui.mode, "all").allRows;
  rowCache.data = data;
  rowCache.mode = ui.mode;
  return rowCache.rows;
}

// ---------------------------------------------------------------- page
function seg(name, options, current, labelId) {
  return `<div class="dash-seg" role="group" aria-labelledby="${labelId}">${options
    .map((o) => `<button type="button" class="dash-seg-btn${o.value === current ? " is-on" : ""}" data-${name}="${esc(o.value)}" aria-pressed="${o.value === current}">${esc(o.label)}</button>`)
    .join("")}</div>`;
}

export async function renderDashboard(container, app) {
  const box = document.createElement("div");
  box.className = "dash-page";
  container.innerHTML = "";
  container.appendChild(box);
  ui.search = "";
  ui.limit = ROW_PAGE;
  ui.showAll = false;

  let data = null;
  let seq = 0;

  const headHtml = `
    <p class="dash-back"><a href="#/home">← กลับหน้าหลัก</a></p>
    <h2>📊 แดชบอร์ดการเบิก</h2>`;

  async function load(fy, fromEvent) {
    const my = ++seq;
    if (!data) box.innerHTML = `${headHtml}<p class="muted" role="status">กำลังโหลดข้อมูล...</p>`;
    else box.classList.add("is-loading");
    let d;
    try {
      d = await call("pcuDashboard", fy ? { fy } : {}, { token: getPcuToken() });
    } catch (err) {
      if (auth.isAuthError(err)) {
        if (fromEvent) window.dispatchEvent(new HashChangeEvent("hashchange"));
        throw err;
      }
      if (my !== seq || !box.isConnected) return;
      box.classList.remove("is-loading");
      box.innerHTML = `${headHtml}
        <div class="notice notice-error" role="alert">โหลดแดชบอร์ดไม่สำเร็จ: ${esc(err.message || "เกิดข้อผิดพลาด")}</div>
        <p><button type="button" class="btn btn-secondary" id="dash-retry">ลองใหม่</button></p>`;
      box.querySelector("#dash-retry").addEventListener("click", () => load(fy, true));
      return;
    }
    if (my !== seq || !box.isConnected) return;
    box.classList.remove("is-loading");
    data = d;
    if (ui.unit !== "all" && !unitGroups(d).includes(ui.unit)) ui.unit = "all";
    renderPage();
  }

  function renderPage() {
    const groups = unitGroups(data);
    const fys = Array.isArray(data.fys) ? data.fys : [];
    const fySel = fys.length > 1
      ? `<label class="dash-ctl"><span class="dash-ctl-label">ปีงบประมาณ</span>
          <select class="fy-select dash-fy" aria-label="เลือกปีงบประมาณ">${fys.map((f) => `<option value="${esc(f)}"${f === data.fy ? " selected" : ""}>ปีงบ ${esc(f)}</option>`).join("")}</select></label>`
      : "";
    const empty = isEmpty(data);
    box.innerHTML = `
      ${headHtml}
      <p class="muted dash-sub">ปีงบประมาณ ${esc(data.fy)} · นับเฉพาะใบเบิกที่ส่งแล้ว (ไม่รวมฉบับร่างและรอบทดลอง)</p>
      <div class="dash-controls">
        ${fySel}
        <div class="dash-ctl"><span class="dash-ctl-label" id="dash-l-mode">แสดงเป็น</span>${seg("mode", [{ value: "qty", label: "จำนวน" }, { value: "baht", label: "บาท" }], ui.mode, "dash-l-mode")}</div>
        <div class="dash-ctl"><span class="dash-ctl-label" id="dash-l-unit">หน่วยจ่าย</span>${seg("unit", [{ value: "all", label: "ทั้งหมด" }, ...groups.map((g) => ({ value: g, label: g }))], ui.unit, "dash-l-unit")}</div>
      </div>
      ${empty ? `<div class="notice notice-info dash-empty" role="status">ยังไม่มีข้อมูลการเบิกในปีงบ ${esc(data.fy)} — เมื่อส่งใบเบิกแล้ว ข้อมูลจะแสดงที่นี่</div>` : `
      <div id="dash-body">
        <div id="dash-kpi"></div>
        <div id="dash-bars"></div>
        <div id="dash-cum"></div>
        <div class="dash-card"><h3>แยกตามหน่วยจ่าย</h3>
          <p class="muted small dash-caption">ยอดขอเบิกสะสมปีงบ — แสดงทุกหน่วยจ่ายเสมอ กดแถวเพื่อกรองทั้งหน้า</p><div id="dash-groups"></div></div>
        <div class="dash-card"><h3>10 รายการที่ขอเบิกมากที่สุด</h3>
          <p class="muted small dash-caption" id="dash-top-cap"></p><div id="dash-top"></div></div>
        <div class="dash-card"><h3>รายการทั้งหมด</h3>
          <div class="dash-tools">
            <input type="text" class="select-input dash-search" placeholder="ค้นหาชื่อหรือรหัสรายการ" aria-label="ค้นหารายการ" autocomplete="off">
            <label class="switch-label"><input type="checkbox" class="dash-showall"> รวมรายการที่ยังไม่เบิก</label>
          </div>
          <div id="dash-table"></div></div>
      </div>`}`;

    const sel = box.querySelector(".dash-fy");
    if (sel) sel.addEventListener("change", () => load(Number(sel.value), true));
    if (empty) return;

    box.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => { ui.mode = b.dataset.mode; syncSeg(); renderBody(); }));
    box.querySelectorAll("[data-unit]:not(.dash-group)").forEach((b) => b.addEventListener("click", () => setUnit(b.dataset.unit)));
    const search = box.querySelector(".dash-search");
    search.value = ui.search;
    search.addEventListener("input", () => { ui.search = search.value; ui.limit = ROW_PAGE; renderTable(); });
    const showAll = box.querySelector(".dash-showall");
    showAll.checked = ui.showAll;
    showAll.addEventListener("change", () => { ui.showAll = showAll.checked; ui.limit = ROW_PAGE; renderTable(); });
    renderBody();
  }

  function setUnit(u) {
    ui.unit = u;
    ui.limit = ROW_PAGE;
    syncSeg();
    renderBody();
  }

  function syncSeg() {
    box.querySelectorAll(".dash-seg-btn").forEach((b) => {
      const on = b.dataset.mode ? b.dataset.mode === ui.mode : b.dataset.unit === ui.unit;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  let agg = null;
  function renderBody() {
    agg = aggregate(data, ui.mode, ui.unit);
    const $ = (id) => box.querySelector(id);
    $("#dash-kpi").innerHTML = kpiHtml(agg, data);

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

    $("#dash-top-cap").textContent = `ตามยอดขอเบิกสะสม (${ui.mode === "baht" ? "บาท" : "จำนวน"}) · ${scope}`;
    $("#dash-top").innerHTML = topHtml(agg);
    renderTable();
  }

  function renderTable() {
    const t = box.querySelector("#dash-table");
    if (!t || !agg) return;
    t.innerHTML = tableHtml(agg, data);
    const more = t.querySelector(".dash-more");
    if (more) more.addEventListener("click", () => { ui.limit += ROW_PAGE; renderTable(); });
  }

  await load(null, false);
}
