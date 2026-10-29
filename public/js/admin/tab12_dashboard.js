// Tab "แดชบอร์ด" (admin only; brief 2s, briefs/2s_admin_dashboard.md §6): network overview + per-PCU drill-down + "จ่ายไม่พอ".
// Data = adminDashboard{fy} (overview) / adminDashboard{fy, pcu} (one PCU, pcuDashboard-shaped) — loaded when the tab first opens.
// Charts / KPI / table come from pages/dashboard_parts.js (shared with the PCU dashboard); aggregation from dash_calc.js.
import { formatInt } from "../format.js";
import { escapeHtml as esc, errMessage } from "./util.js";
import { shortRound } from "../pages/dashboard_calc.js";
import {
  ui, ROW_PAGE, fmt, pctText, controlsHtml, bodyShellHtml, createBody, kpiHtml, barChart, lineChart, chartCardHtml,
  attachTips, legendHtml, groupRowsHtml, SERIES, MIXED_UNITS, twoColCardHtml, detailsListHtml,
} from "../pages/dashboard_parts.js";
import {
  RULE_LABEL, RULE_ORDER, adminGroups, isAdminEmpty, overviewAgg, topItemsNetwork, bottomItemsNetwork, neverItemsNetwork, overPlanItems,
  groupBreakdown, anomalyRows, rankRows, sortRank,
} from "./dash_calc.js";
import { mountShortage } from "./shortage.js";

const ANOM_PAGE = 30;
const pct1 = (v) => `${Math.round(Number(v) * 1000) / 10}%`;

function anomalyDetail(r) {
  switch (r.rule) {
    case "p90":
      return `${r.round ? `ขอเบิก ${shortRound(r.round)}: ` : ""}${fmt(r.value)} หน่วย (เกณฑ์ P90 ≈ ${fmt(r.threshold)})`;
    case "pace":
      return r.cum_qty != null && r.plan_qty != null
        ? `สะสม ${fmt(r.cum_qty)} จากแผนปี ${fmt(r.plan_qty)} (ผ่านไป ${r.elapsed}/12 รอบ · เกณฑ์ ${fmt(r.threshold)})`
        : `สะสม ${fmt(r.value)} หน่วย (เกณฑ์ตามแผน ${fmt(r.threshold)})`;
    case "share":
      return `ใช้ ${pct1(r.value)} ของยอดรายการนี้ทั้งเครือข่าย (เกณฑ์ ${pct1(r.threshold)})`;
    case "info_new":
      return "ปีงบก่อนไม่เคยเบิก แต่ปีนี้เริ่มเบิกแล้ว";
    default:
      return "";
  }
}

export function renderTab12(container, ctx) {
  const ts = {
    fy: ctx.fySelected(),
    pcu: null, // selected PCU code (detail view) or null (overview)
    overview: null,
    detail: null,
    seq: 0,
    rank: { key: "req", dir: "desc" },
    rule: "all",
    anomLimit: ANOM_PAGE,
    loaded: false,
  };
  const box = document.createElement("div");
  box.className = "dash-page adm-dash";
  container.innerHTML = "";
  container.appendChild(box);

  // The "จ่ายไม่พอ" card is mounted once and re-attached whenever the overview is redrawn.
  const shortHost = document.createElement("div");
  shortHost.className = "adm-short-host";
  let shortage = null;

  const pcuNames = () => {
    const m = new Map();
    ((ts.overview && ts.overview.pcus) || []).forEach((p) => m.set(p.code, p.name || p.code));
    if (ts.detail && ts.detail.pcu) m.set(ts.detail.pcu.code, ts.detail.pcu.name);
    return m;
  };

  // ------------------------------------------------------------------ loading
  async function load() {
    const my = ++ts.seq;
    if (!ts.overview && !ts.pcu) box.innerHTML = `<p class="muted" role="status">กำลังโหลดข้อมูลแดชบอร์ด...</p>`;
    else box.classList.add("is-loading");
    const params = {};
    if (ts.fy) params.fy = ts.fy;
    if (ts.pcu) params.pcu = ts.pcu;
    let d;
    try {
      d = await ctx.adminCall("adminDashboard", params);
    } catch (err) {
      if (my !== ts.seq || !box.isConnected) return;
      box.classList.remove("is-loading");
      const notFound = err && err.code === "NOT_FOUND";
      box.innerHTML = `<div class="notice ${notFound ? "notice-info" : "notice-error"}" role="alert">${notFound
        ? `ยังไม่มีข้อมูลแดชบอร์ดของ${ts.pcu ? "รพ.สต.นี้ใน" : ""}ปีงบ ${esc(ts.fy || "")} (${esc(errMessage(err))})`
        : `โหลดแดชบอร์ดไม่สำเร็จ: ${esc(errMessage(err))}`}</div>
        <p>${ts.pcu ? `<button type="button" class="btn btn-secondary" id="adm-err-back">← กลับภาพรวมเครือข่าย</button> ` : ""}
        ${ts.fy ? `<button type="button" class="btn btn-secondary" id="adm-err-cur">ใช้ปีงบปัจจุบัน</button> ` : ""}
        <button type="button" class="btn btn-secondary" id="adm-err-retry">ลองใหม่</button></p>`;
      const b = box.querySelector("#adm-err-back");
      if (b) b.addEventListener("click", () => { ts.pcu = null; ts.overview ? renderOverview() : load(); });
      const c = box.querySelector("#adm-err-cur");
      if (c) c.addEventListener("click", () => { ts.fy = null; ts.pcu = null; ts.overview = null; ts.detail = null; load(); });
      box.querySelector("#adm-err-retry").addEventListener("click", load);
      return;
    }
    if (my !== ts.seq || !box.isConnected) return;
    box.classList.remove("is-loading");
    if (d && d.fy) ts.fy = d.fy;
    if (ts.pcu) { ts.detail = d; renderDetail(); } else { ts.overview = d; renderOverview(); }
  }

  function changeFy(fy) {
    ts.fy = fy;
    ts.overview = null;
    ts.detail = null;
    if (shortage) shortage.reload(fy);
    load();
  }

  function openPcu(code) {
    ts.pcu = code;
    ts.detail = null;
    ui.search = "";
    ui.limit = ROW_PAGE;
    ui.showAll = false;
    ts.rule = "all";
    ts.anomLimit = ANOM_PAGE;
    load();
    try { window.scrollTo({ top: 0 }); } catch (e) { /* ignore */ }
  }

  function backToOverview() {
    ts.pcu = null;
    ts.detail = null;
    ts.rule = "all";
    ts.anomLimit = ANOM_PAGE;
    if (ts.overview) renderOverview(); else load();
  }

  // ------------------------------------------------------------------ shared small renderers
  function scopeText() {
    return ui.unit === "all" ? "ทุกหน่วยจ่าย" : `หน่วยจ่าย ${ui.unit}`;
  }

  // Q12: top 3 + bottom 3 (requested > 0 only) + "nobody requested" (collapsed names)
  function top3Html(d) {
    const scope = scopeText();
    const never = neverItemsNetwork(d, ui.unit);
    return twoColCardHtml("3 รายการที่ขอเบิกมากที่สุด", `ยอดขอเบิกสะสมปีงบ · ${scope} · แสดงทั้งตามจำนวนและตามบาท`, topItemsNetwork(d, ui.unit, 3))
      + twoColCardHtml("3 รายการที่ขอเบิกน้อยที่สุด", `เฉพาะรายการที่มีการขอเบิก (> 0) · ${scope} · แสดงทั้งตามจำนวนและตามบาท`, bottomItemsNetwork(d, ui.unit, 3))
      + `<div class="dash-card"><h3>ไม่มีใครเบิก ${formatInt(never.length)} รายการ</h3>
        <p class="muted small dash-caption">รายการในฟอร์มล่าสุดที่ไม่มี รพ.สต. แห่งใดขอเบิกเลยในปีงบนี้ · ${esc(scope)}</p>
        ${never.length ? detailsListHtml("ดูรายชื่อ", never) : `<p class="muted">ทุกรายการมีคนเบิกแล้ว</p>`}</div>`;
  }

  // Anomaly list (flags + info_new). State (rule filter / page) lives in ts so a mode/unit change keeps it.
  function anomalyCardHtml(rows, showPcu) {
    const names = pcuNames();
    const counts = { all: rows.length };
    RULE_ORDER.forEach((k) => { counts[k] = rows.filter((r) => r.rule === k).length; });
    if (ts.rule !== "all" && !counts[ts.rule]) ts.rule = "all";
    const filtered = rows
      .filter((r) => ts.rule === "all" || r.rule === ts.rule)
      .sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule)
        || String(names.get(a.pcu) || a.pcu).localeCompare(String(names.get(b.pcu) || b.pcu), "th") || String(a.code).localeCompare(String(b.code)));
    const shown = filtered.slice(0, ts.anomLimit);
    const items = (ts.pcu ? ts.detail : ts.overview).items || {};
    const scope = ui.unit === "all" ? "ทุกหน่วยจ่าย" : `หน่วยจ่าย ${ui.unit}`;
    const chips = [{ k: "all", label: "ทั้งหมด" }, ...RULE_ORDER.map((k) => ({ k, label: RULE_LABEL[k] }))]
      .filter((c) => c.k === "all" || counts[c.k])
      .map((c) => `<button type="button" class="dash-seg-btn${ts.rule === c.k ? " is-on" : ""}" data-rule="${c.k}" aria-pressed="${ts.rule === c.k}">${esc(c.label)} (${formatInt(counts[c.k])})</button>`)
      .join("");
    const body = shown.map((r) => {
      const it = items[r.code] || {};
      return `<tr>
        ${showPcu ? `<th scope="row" class="dash-name"><button type="button" class="adm-link" data-pcu="${esc(r.pcu)}">${esc(names.get(r.pcu) || r.pcu)}</button></th>` : ""}
        <td>${esc(it.name || r.code)}<div class="muted small">${esc(r.code)}${it.unit_group ? ` · ${esc(it.unit_group)}` : ""}</div></td>
        <td><span class="badge badge-info dash-flag adm-rule">${esc(RULE_LABEL[r.rule] || r.rule)}</span></td>
        <td class="adm-detail">${esc(anomalyDetail(r))}</td></tr>`;
    }).join("");
    return `<div class="dash-card">
      <h3>รายการที่ควรดูเป็นพิเศษ</h3>
      <p class="muted small dash-caption">${esc(scope)} · ข้อสังเกตเพื่อช่วยดูภาพรวม ไม่ใช่ข้อผิดพลาด · ตัวเลขในส่วนนี้เป็นจำนวนหน่วย</p>
      ${rows.length ? `
      <div class="dash-seg adm-chips" role="group" aria-label="กรองตามชนิดข้อสังเกต">${chips}</div>
      <div class="table-scroll dash-table-wrap adm-anom-wrap"><table class="dash-table adm-anom">
        <caption class="sr-only">รายการที่ควรดูเป็นพิเศษ</caption>
        <thead><tr>${showPcu ? `<th scope="col" class="dash-name">รพ.สต.</th>` : ""}<th scope="col">รายการ</th><th scope="col">ข้อสังเกต</th><th scope="col">รายละเอียด</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      ${filtered.length > shown.length ? `<button type="button" class="btn btn-secondary dash-more adm-more">แสดงเพิ่ม (เหลืออีก ${filtered.length - shown.length} รายการ)</button>` : ""}`
      : `<p class="muted">ไม่มีข้อสังเกตเป็นพิเศษ</p>`}</div>`;
  }

  function bindAnomalies(hostEl, rerender) {
    hostEl.querySelectorAll("[data-rule]").forEach((b) => b.addEventListener("click", () => { ts.rule = b.dataset.rule; ts.anomLimit = ANOM_PAGE; rerender(); }));
    const more = hostEl.querySelector(".adm-more");
    if (more) more.addEventListener("click", () => { ts.anomLimit += ANOM_PAGE; rerender(); });
    hostEl.querySelectorAll(".adm-link").forEach((b) => b.addEventListener("click", () => openPcu(b.dataset.pcu)));
  }

  // ------------------------------------------------------------------ overview
  function rankTableHtml(d) {
    const rows = sortRank(rankRows(d, ui.unit), ts.rank.key, ts.rank.dir);
    const th = (key, label, cls) => {
      const on = ts.rank.key === key;
      const arrow = on ? (ts.rank.dir === "asc" ? " ▲" : " ▼") : "";
      return `<th scope="col" class="${cls || ""}" aria-sort="${on ? (ts.rank.dir === "asc" ? "ascending" : "descending") : "none"}"><button type="button" class="adm-sort" data-sort="${key}">${esc(label)}${arrow}</button></th>`;
    };
    const roundCell = (x) => (x ? `${esc(shortRound(x.round))}<div class="muted small">${fmt(x.baht)} บาท</div>` : `<span class="muted">–</span>`);
    const overCell = (op) => {
      if (!op || !(op.n > 0)) return op ? "0" : `<span class="muted">–</span>`;
      const names = overPlanItems(d, op).map((x) => x.name).join(", ");
      return `<details class="dash-det adm-over"><summary title="${esc(names)}">${formatInt(op.n)}</summary><ul class="dash-plain">${overPlanItems(d, op).map((x) => `<li>${esc(x.name)} <span class="muted small">${esc(x.code)}</span></li>`).join("")}</ul></details>`;
    };
    const body = rows.map((r, i) => `<tr>
      <td class="num muted">${i + 1}</td>
      <th scope="row" class="adm-name"><button type="button" class="adm-link" data-pcu="${esc(r.code)}">${esc(r.name)}</button></th>
      <td class="num strong">${fmt(r.req)}</td>
      <td class="num">${fmt(r.got)}</td>
      <td class="num">${esc(pctText(r.pct))}</td>
      <td class="num">${roundCell(r.max_round)}</td>
      <td class="num">${roundCell(r.min_round)}</td>
      <td class="num">${overCell(r.over_plan)}</td>
      <td>${esc(r.pattern || "–")}${r.pattern_note ? `<div class="muted small">(${esc(r.pattern_note)})</div>` : ""}</td>
      <td>${esc(r.pattern_prev || "–")}${r.endyear_prev ? `<div class="muted small">เบิกหนักช่วงท้ายปีงบ</div>` : ""}</td>
      <td class="num">${r.flags > 0 ? `<span class="badge badge-info dash-flag">${formatInt(r.flags)}</span>` : `<span class="muted">–</span>`}</td></tr>`).join("");
    return `<div class="table-scroll dash-table-wrap adm-rank-wrap"><table class="dash-table adm-rank">
      <caption class="sr-only">จัดอันดับ รพ.สต. ตามยอดขอเบิกเป็นบาท</caption>
      <thead><tr><th scope="col" class="num">#</th>${th("name", "รพ.สต.", "adm-name")}${th("req", "ขอเบิก (บาท)", "num")}${th("got", "ได้รับจริง (บาท)", "num")}${th("pct", "% แผน", "num")}
        <th scope="col" class="num">เดือนสูงสุด</th><th scope="col" class="num">เดือนต่ำสุด</th><th scope="col" class="num">เกินแผน</th>
        <th scope="col">รูปแบบปีนี้</th><th scope="col">รูปแบบปีก่อน</th>${th("flags", "จำนวน flag", "num")}</tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function renderOverview() {
    const d = ts.overview;
    const groups = adminGroups(d);
    if (ui.unit !== "all" && !groups.includes(ui.unit)) ui.unit = "all";
    const empty = isAdminEmpty(d);
    ui.mode = "baht"; // Q11: admin charts / KPIs are baht only (ui is shared module state — the PCU page keeps its own toggle)
    box.classList.remove("is-loading");
    box.innerHTML = `
      <h2>แดชบอร์ดภาพรวมเครือข่าย</h2>
      <p class="muted dash-sub">ปีงบประมาณ ${esc(d.fy)} · นับเฉพาะใบเบิกที่ส่งแล้ว (ไม่รวมฉบับร่าง รอบทดลอง และ รพ.สต. กลุ่มทดลอง) · ได้รับจริง = ที่จ่ายแล้วทุกหน่วย</p>
      ${controlsHtml(d, groups, { mode: false })}
      ${empty ? `<div class="notice notice-info dash-empty" role="status">ยังไม่มีข้อมูลการเบิกในปีงบ ${esc(d.fy)} — เมื่อ รพ.สต. ส่งใบเบิกแล้ว ข้อมูลจะแสดงที่นี่</div>` : `
      <div id="adm-body">
        <div id="adm-kpi"></div><div id="adm-bars"></div><div id="adm-cum"></div>
        <div id="adm-top3"></div>
        <div class="dash-card"><h3>แยกตามหน่วยจ่าย</h3>
          <p class="muted small dash-caption">ยอดขอเบิกสะสมปีงบ — แสดงทุกหน่วยจ่ายเสมอ กดแถวเพื่อกรองทั้งหน้า</p><div id="adm-groups"></div></div>
        <div class="dash-card"><h3>จัดอันดับ รพ.สต.</h3>
          <p class="muted small dash-caption" id="adm-rank-cap"></p><div id="adm-rank"></div></div>
        <div id="adm-anom"></div>
      </div>`}
      <div id="adm-short-slot"></div>`;
    box.querySelector("#adm-short-slot").appendChild(shortHost);
    if (!shortage) shortage = mountShortage(shortHost, { call: ctx.adminCall, fy: ts.fy, defaultUnit: "all" });

    const sel = box.querySelector(".dash-fy");
    if (sel) sel.addEventListener("change", () => changeFy(Number(sel.value)));
    if (empty) return;
    // the first .dash-controls is this tab's own; the shortage card has its own (data-unit buttons) further down
    const ctl = box.querySelector(".dash-controls");
    ctl.querySelectorAll("[data-unit]").forEach((b) => b.addEventListener("click", () => setUnit(b.dataset.unit)));
    renderOverviewBody();
  }

  function syncSeg() {
    box.querySelector(".dash-controls").querySelectorAll(".dash-seg-btn").forEach((b) => {
      const on = b.dataset.mode ? b.dataset.mode === ui.mode : b.dataset.unit === ui.unit;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function setUnit(u) {
    ui.unit = u;
    syncSeg();
    renderOverviewBody();
  }

  function renderOverviewBody() {
    const d = ts.overview;
    const $ = (id) => box.querySelector(id);
    ui.mode = "baht";
    const agg = overviewAgg(d, ui.mode, ui.unit);
    agg.pctBasis = "baht";
    $("#adm-kpi").innerHTML = kpiHtml(agg, d);

    const mixed = ui.mode === "qty" ? ` · ${MIXED_UNITS}` : "";
    const scope = ui.unit === "all" ? "ทุกหน่วยจ่าย" : `หน่วยจ่าย ${ui.unit}`;
    const bars = barChart(agg);
    $("#adm-bars").innerHTML = chartCardHtml("dash-bars-card", "ยอดรายรอบ (ทั้งเครือข่าย)", `${esc(scope)} · ${ui.mode === "baht" ? "บาท" : "จำนวน"}${esc(mixed)}`,
      legendHtml(SERIES.map((s) => ({ cls: s.cls, label: s.label }))), bars);
    attachTips($("#dash-bars-card"), bars.tips);

    const line = lineChart(agg, d);
    const legend = SERIES.filter((s) => s.key !== "used" || line.hasUsed).map((s) => ({ cls: s.cls, label: `${s.label}สะสม`, shape: "line" }));
    $("#adm-cum").innerHTML = chartCardHtml("dash-cum-card", "ยอดสะสมตลอดปีงบ (ทั้งเครือข่าย)", `${esc(scope)} · ${ui.mode === "baht" ? "บาท" : "จำนวน"}${esc(mixed)}`,
      legendHtml(legend), line);
    attachTips($("#dash-cum-card"), line.tips);

    $("#adm-top3").innerHTML = top3Html(d);

    const g = $("#adm-groups");
    g.innerHTML = groupRowsHtml(groupBreakdown(d, ui.mode));
    g.querySelectorAll(".dash-group").forEach((b) => b.addEventListener("click", () => setUnit(ui.unit === b.dataset.unit ? "all" : b.dataset.unit)));

    $("#adm-rank-cap").textContent = `${scope} · ยอดเป็นบาทเสมอ · เดือนสูงสุด/ต่ำสุด (เดือนที่ไม่เบิกไม่นับ) และเกินแผน (รายการสะสมขอ > แผนปี) เป็นตัวเลขของทุกหน่วยจ่าย ไม่เปลี่ยนตามตัวกรอง · รูปแบบการเบิก (pattern) คิดจากทุกหน่วยจ่ายของแห่งนั้น ไม่เปลี่ยนตามตัวกรอง · กดชื่อ รพ.สต. เพื่อดูรายแห่ง`;
    const r = $("#adm-rank");
    r.innerHTML = rankTableHtml(d);
    r.querySelectorAll(".adm-sort").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.sort;
      ts.rank = ts.rank.key === k ? { key: k, dir: ts.rank.dir === "desc" ? "asc" : "desc" } : { key: k, dir: k === "name" ? "asc" : "desc" };
      renderOverviewBody();
    }));
    r.querySelectorAll(".adm-link").forEach((b) => b.addEventListener("click", () => openPcu(b.dataset.pcu)));

    renderAnomalies();
  }

  function renderAnomalies() {
    const slot = box.querySelector(ts.pcu ? "#adm-anom-pcu" : "#adm-anom");
    if (!slot) return;
    const d = ts.pcu ? ts.detail : ts.overview;
    slot.innerHTML = anomalyCardHtml(anomalyRows(d, ui.unit), !ts.pcu);
    bindAnomalies(slot, renderAnomalies);
  }

  // ------------------------------------------------------------------ per-PCU view
  function patternHtml(d) {
    const tile = (label, value, sub) => `<div class="dash-kpi"><div class="dash-kpi-label">${esc(label)}</div><div class="dash-kpi-value adm-pattern">${value}</div>${sub ? `<div class="dash-kpi-sub small muted">${sub}</div>` : ""}</div>`;
    const cur = d.pattern ? esc(d.pattern) : "–";
    const prev = d.pattern_prev ? esc(d.pattern_prev) : `<span class="muted">ไม่มีข้อมูลปีก่อน</span>`;
    return `<div class="dash-card">
      <h3>รูปแบบการเบิก (pattern)</h3>
      <p class="muted small dash-caption">คิดจากยอดบาทรายเดือนของทุกหน่วยจ่าย — ไม่เปลี่ยนตามตัวกรองหน่วยจ่าย</p>
      <div class="dash-kpis adm-two">
        ${tile(`ปีงบ ${d.fy} (ถึงรอบปัจจุบัน)`, cur, d.pattern_note ? esc(d.pattern_note) : "")}
        ${tile(`ปีงบ ${d.fy - 1} (ปีก่อน)`, prev, d.endyear_prev ? "เบิกหนักช่วงท้ายปีงบ (3 รอบสุดท้าย ≥ 40% ของทั้งปี)" : "")}
      </div></div>`;
  }

  // Q13: busiest / quietest month (baht, months with no request not counted) + items over the yearly plan
  function extremesHtml(d) {
    const month = (label, x) => `<div class="dash-kpi"><div class="dash-kpi-label">${esc(label)}</div>
      <div class="dash-kpi-value adm-pattern">${x ? esc(shortRound(x.round)) : "–"}</div>
      <div class="dash-kpi-sub small muted">${x ? `${fmt(x.baht)} บาท` : "ยังไม่มีข้อมูล"}</div></div>`;
    const op = d.over_plan;
    const over = overPlanItems(d, op);
    return `<div class="dash-card">
      <h3>เดือนสูงสุด/ต่ำสุด และเกินแผน</h3>
      <p class="muted small dash-caption">เป็นยอดบาทของทุกหน่วยจ่าย ไม่เปลี่ยนตามตัวกรอง · เดือนที่ไม่ได้เบิกไม่นับ</p>
      <div class="dash-kpis adm-three">
        ${month("เดือนบาทสูงสุด", d.max_round)}
        ${month("เดือนบาทต่ำสุด", d.min_round)}
        <div class="dash-kpi"><div class="dash-kpi-label">เกินแผนปี</div>
          <div class="dash-kpi-value adm-pattern">${op ? formatInt(op.n) : "–"} <span class="small muted">รายการ</span></div>
          <div class="dash-kpi-sub small muted">สะสมขอเบิก > แผนปี</div></div>
      </div>
      ${over.length ? detailsListHtml("ดูรายชื่อรายการที่เกินแผน", over) : ""}</div>`;
  }

  function renderDetail() {
    const d = ts.detail;
    // unit groups present in this PCU's payload (items of the form)
    const ordered = adminGroups({ items: d.items, pcus: [], network: {} });
    if (ui.unit !== "all" && !ordered.includes(ui.unit)) ui.unit = "all";
    const empty = !d.monthly || Object.keys(d.monthly).length === 0;
    ui.mode = "baht";
    box.classList.remove("is-loading");
    const name = (d.pcu && d.pcu.name) || ts.pcu;
    box.innerHTML = `
      <p class="dash-back"><button type="button" class="btn btn-secondary btn-sm" id="adm-back">← กลับภาพรวมเครือข่าย</button></p>
      <h2>${esc(name)} <span class="muted small">${esc((d.pcu && d.pcu.code) || "")}</span></h2>
      <p class="muted dash-sub">ปีงบประมาณ ${esc(d.fy)} · นับเฉพาะใบเบิกที่ส่งแล้ว · ได้รับจริง = ที่จ่ายแล้วทุกหน่วย</p>
      ${controlsHtml(d, ordered, { mode: false })}
      ${empty ? `<div class="notice notice-info dash-empty" role="status">รพ.สต.นี้ยังไม่มีข้อมูลการเบิกในปีงบ ${esc(d.fy)}</div>${patternHtml(d)}` : bodyShellHtml()}`;
    box.querySelector("#adm-back").addEventListener("click", backToOverview);
    const sel = box.querySelector(".dash-fy");
    if (sel) sel.addEventListener("change", () => { ts.fy = Number(sel.value); ts.detail = null; ts.overview = null; if (shortage) shortage.reload(ts.fy); load(); });
    if (empty) return;

    // extra sections (pattern / top 3 / anomalies) sit between the charts and the unit-group card
    const extra = document.createElement("div");
    extra.id = "adm-extra";
    extra.innerHTML = `${patternHtml(d)}${extremesHtml(d)}<div id="adm-anom-pcu"></div>`;
    const anchor = box.querySelector("#dash-groups").closest(".dash-card");
    anchor.parentNode.insertBefore(extra, anchor);

    const body = createBody(box, d, {
      heat: true,
      onRender: () => renderAnomalies(),
    });
    body.bind();
  }

  return {
    onShow() {
      if (ts.loaded) return;
      ts.loaded = true;
      load();
    },
  };
}
