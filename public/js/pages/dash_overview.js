// 2ao (brief 2ao §3 D) — "ภาพรวมต่อรายการ": one table per item = ได้รับจริง · ใช้ไป · คงเหลือ · พอใช้อีก ~เดือน.
// Shared by the PCU dashboard, the admin per-PCU view (createBody in dashboard_parts.js) and the admin network overview (tab12_dashboard.js).
// Pure row builders (no DOM) + a small mount() that owns search / sort / paging. Styles: css/2ao_ui.css (.ov-*).
import { esc } from "../esc.js";
import { formatInt } from "../format.js";
import { formatQty } from "../units.js";
import { num } from "../calc_common.js";
import { shortRound } from "./dashboard_calc.js";

const PAGE = 50;
const dash = '<span class="muted">–</span>';
const r1 = (v) => Math.round(v * 10) / 10;
export const monthsText = (m) => (m == null ? null : m < 0.05 ? "<0.1" : r1(m).toLocaleString("en-US", { maximumFractionDigits: 1 }));

// เดือนที่พอใช้ = คงเหลือ ÷ ใช้ไปเฉลี่ยต่อเดือน (qty always — the ratio is the same in baht) · null when no stock figure / no used.
function monthsLeft(stock, usedQ, usedMonths) {
  if (stock == null || !(usedQ > 0) || !(usedMonths > 0)) return null;
  return stock / (usedQ / usedMonths);
}

/** Rows from a pcuDashboard-shaped payload (the PCU page, and adminDashboard{pcu}). Average = over rounds that have a used (or estimated) figure. */
export function pcuOverviewRows(data) {
  const items = data.items || {}, monthly = data.monthly || {}, st = data.stock_latest || {};
  const rounds = data.rounds || [];
  const codes = new Set([...Object.keys(items), ...Object.keys(monthly), ...Object.keys(st)]);
  const rows = [];
  codes.forEach((code) => {
    const it = items[code] || {}, by = monthly[code] || {};
    let gq = 0, gb = 0, uq = 0, ub = 0, eq = 0, um = 0, lastPrice = 0;
    rounds.forEach((r) => {
      const v = by[r];
      if (!v) return;
      gq += num(v[2]); gb += num(v[3]);
      const u = num(v[4]) + num(v[6]);
      uq += u; ub += num(v[5]) + num(v[7]); eq += num(v[6]);
      if (u > 0) um++;
      if (num(v[0]) > 0 && num(v[1]) > 0) lastPrice = num(v[1]) / num(v[0]);
    });
    const e = st[code];
    const stock = e ? num(e.stock) : null;
    // price for คงเหลือ in baht: latest form price (plan_baht ÷ plan_qty), else the last round's request price
    const price = num(it.plan_qty) > 0 && num(it.plan_baht) > 0 ? num(it.plan_baht) / num(it.plan_qty) : lastPrice || (gq > 0 ? gb / gq : 0);
    rows.push({
      code, name: it.name || code, unit: it.unit || "", group: it.unit_group || "",
      gotQ: gq, gotB: gb, usedQ: uq, usedB: ub, estQ: eq,
      stockQ: stock, stockB: stock == null ? null : stock * price, stockNote: e ? shortRound(e.round) : "",
      left: monthsLeft(stock, uq, um),
    });
  });
  return rows;
}

/** Rows from the admin network payload: network.items (V8 fy-to-date) + stock_net. Average = used ÷ elapsed rounds (the payload has no per-item months). */
export function networkOverviewRows(data) {
  const items = data.items || {}, ni = (data.network || {}).items || {}, sn = data.stock_net || {};
  const elapsed = num(data.elapsed);
  const codes = new Set([...Object.keys(ni), ...Object.keys(sn)]);
  const rows = [];
  codes.forEach((code) => {
    const it = items[code] || {}, v = ni[code] || [];
    const s = sn[code];
    const stock = s ? num(s.qty) : null;
    const uq = num(v[4]) + num(v[6]);
    rows.push({
      code, name: it.name || code, unit: it.unit || "", group: it.unit_group || "",
      gotQ: num(v[2]), gotB: num(v[3]), usedQ: uq, usedB: num(v[5]) + num(v[7]), estQ: num(v[6]),
      stockQ: stock, stockB: s ? num(s.baht) : null, stockNote: s ? `${(s.pcus || []).length} แห่ง` : "",
      left: monthsLeft(stock, uq, elapsed),
    });
  });
  return rows;
}

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name, "th") || a.code.localeCompare(b.code),
  got: (a, b, m) => (m === "baht" ? a.gotB - b.gotB : a.gotQ - b.gotQ),
  used: (a, b, m) => (m === "baht" ? a.usedB - b.usedB : a.usedQ - b.usedQ),
  stock: (a, b, m) => ((m === "baht" ? a.stockB : a.stockQ) ?? -1) - ((m === "baht" ? b.stockB : b.stockQ) ?? -1),
  left: (a, b) => (a.left ?? -1) - (b.left ?? -1),
};

/**
 * mount(host, opts) — opts: getRows() → rows, getMode() → "qty"|"baht", getUnit() → unit_group|"all", title, caption (html),
 * headHtml (extra controls above the search box, e.g. the admin PCU picker), onHead(host) (binds them).
 * Returns {render}: call after the data / mode / unit changed. The shell (search box) is built once so typing keeps focus.
 */
export function mount(host, opts) {
  const st = { search: "", sort: { key: "name", dir: "asc" }, limit: PAGE, built: false };

  function shell() {
    host.innerHTML = `<div class="dash-card ov-card"><h3>${esc(opts.title || "ภาพรวมต่อรายการ")}</h3>
      <p class="muted small dash-caption">${opts.caption || ""}</p>
      ${opts.headHtml || ""}
      <div class="dash-tools"><input type="text" class="select-input ov-search" placeholder="ค้นหาชื่อหรือรหัสรายการ" aria-label="ค้นหารายการ (ภาพรวมต่อรายการ)" autocomplete="off"></div>
      <div class="ov-table"></div></div>`;
    const inp = host.querySelector(".ov-search");
    inp.value = st.search;
    inp.addEventListener("input", () => { st.search = inp.value; st.limit = PAGE; table(); });
    if (opts.onHead) opts.onHead(host);
    st.built = true;
  }

  function table() {
    const t = host.querySelector(".ov-table");
    if (!t) return;
    const mode = opts.getMode() === "baht" ? "baht" : "qty";
    const unit = opts.getUnit ? opts.getUnit() : "all";
    const q = st.search.trim().toLowerCase();
    let rows = opts.getRows().filter((r) => (unit === "all" || r.group === unit)
      && (q ? r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q) : r.gotQ > 0 || r.usedQ > 0 || r.stockQ != null));
    const { key, dir } = st.sort;
    const sign = dir === "asc" ? 1 : -1;
    // empty values (no คงเหลือ / no used) sink to the bottom whichever way the column is sorted
    const empty = (r) => (key === "stock" ? r.stockQ == null : key === "left" ? r.left == null : false);
    rows = rows.slice().sort((a, b) => (empty(a) - empty(b)) || sign * SORTERS[key](a, b, mode) || SORTERS.name(a, b));
    const total = rows.length;
    rows = rows.slice(0, st.limit);
    const money = mode === "baht";
    const f = (v) => (money ? formatInt(v) : formatQty(v));
    const cell = (v) => (v ? f(v) : dash);
    const th = (k, label) => {
      const on = st.sort.key === k;
      return `<th scope="col" class="${k === "name" ? "dash-name" : "num"}" aria-sort="${on ? (st.sort.dir === "asc" ? "ascending" : "descending") : "none"}"><button type="button" class="ov-sort" data-sort="${k}">${esc(label)}${on ? (st.sort.dir === "asc" ? " ▲" : " ▼") : ""}</button></th>`;
    };
    const body = rows.map((r) => {
      const used = money ? r.usedB : r.usedQ;
      const est = r.estQ > 0;
      const stock = money ? r.stockB : r.stockQ;
      return `<tr>
        <th scope="row" class="dash-name"><div>${esc(r.name)}</div><div class="muted small">${esc(r.code)}${r.unit ? ` · ${esc(r.unit)}` : ""}</div></th>
        <td class="num">${cell(money ? r.gotB : r.gotQ)}</td>
        <td class="num"${est ? ` title="${esc(`รวมค่าประมาณจากคงเหลือ ${formatQty(r.estQ)}`)}"` : ""}>${est ? "≈ " : ""}${cell(used)}</td>
        <td class="num">${stock == null ? dash : `<span class="strong">${f(stock)}</span>${r.stockNote ? ` <span class="muted small">${esc(r.stockNote)}</span>` : ""}`}</td>
        <td class="num">${r.left == null ? dash : `<strong>~${esc(monthsText(r.left))}</strong> <span class="muted small">เดือน</span>`}</td></tr>`;
    }).join("");
    const more = total > rows.length ? `<button type="button" class="btn btn-secondary ov-more">แสดงเพิ่ม (เหลืออีก ${total - rows.length} รายการ)</button>` : "";
    t.innerHTML = `<p class="muted small" aria-live="polite">แสดง ${rows.length} จาก ${total} รายการ · ${money ? "บาท" : "จำนวน (หน่วยเบิก)"} · พอใช้อีก = คงเหลือ ÷ ใช้ไปเฉลี่ยต่อเดือน (ใช้ตัวเลขจำนวนเสมอ) · ≈ ใช้ไปมีค่าประมาณจากคงเหลือ</p>
      ${total === 0 ? `<p class="muted">ไม่พบรายการ</p>` : `
      <div class="table-scroll dash-table-wrap"><table class="dash-table dash-table-sm ov-tbl">
        <caption class="sr-only">ภาพรวมต่อรายการ: ได้รับจริง ใช้ไป คงเหลือ พอใช้อีกกี่เดือน</caption>
        <thead><tr>${th("name", "รายการ")}${th("got", "ได้รับจริง")}${th("used", "ใช้ไป")}${th("stock", "คงเหลือ")}${th("left", "พอใช้อีก ~เดือน")}</tr></thead>
        <tbody>${body}</tbody></table></div>${more}`}`;
    t.querySelectorAll(".ov-sort").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.sort;
      st.sort = st.sort.key === k ? { key: k, dir: st.sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" ? "asc" : "desc" };
      table();
    }));
    const mb = t.querySelector(".ov-more");
    if (mb) mb.addEventListener("click", () => { st.limit += PAGE; table(); });
  }

  return {
    render(rebuild) {
      if (!st.built || rebuild || !host.querySelector(".ov-card")) shell();
      table();
    },
  };
}
