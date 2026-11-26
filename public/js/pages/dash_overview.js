// 2ao (brief 2ao §3 D) — "ภาพรวมต่อรายการ": one table per item = ได้รับจริง · ใช้ไป · คงเหลือ · พอใช้อีก ~เดือน.
// 2aq: ได้รับจริง split into ขอเบิก · ได้รับ (รพ.สต. กรอก) · จ่ายจริง (หน่วยจ่าย) from item_src (0 = entered · none = "ยังไม่มีข้อมูล") ·
// the PCU dashboard's คงเหลือ card is merged in (ได้เพิ่ม → รวม under คงเหลือ) · opts.page / opts.collapsible (folded card, first N rows).
// Shared by the PCU dashboard, the admin per-PCU view (createBody in dashboard_parts.js) and the admin network overview (tab12_dashboard.js).
// Pure row builders (no DOM) + a small mount() that owns search / sort / paging. Styles: css/2ao_ui.css (.ov-*).
import { esc } from "../esc.js";
import { formatInt } from "../format.js";
import { formatQty } from "../units.js";
import { num } from "../calc_common.js";
import { shortRound } from "./dashboard_calc.js";
import { ledgerTableHtml } from "./dash_ledger.js"; // 2as

const PAGE = 50;
const dash = '<span class="muted">–</span>';
const r1 = (v) => Math.round(v * 10) / 10;
export const monthsText = (m) => (m == null ? null : m < 0.05 ? "<0.1" : r1(m).toLocaleString("en-US", { maximumFractionDigits: 1 }));

// เดือนที่พอใช้ = คงเหลือ ÷ ใช้ไปเฉลี่ยต่อเดือน (qty always — the ratio is the same in baht) · null when no stock figure / no used.
function monthsLeft(stock, usedQ, usedMonths) {
  if (stock == null || !(usedQ > 0) || !(usedMonths > 0)) return null;
  return stock / (usedQ / usedMonths);
}

// 2aq: Σ of item_src over the rounds → {reqQ, reqB, pcuQ, pcuB, pcuN, issQ, issB, issN, n}
function srcSum(byM, rounds) {
  const o = { reqQ: 0, reqB: 0, pcuQ: 0, pcuB: 0, pcuN: 0, issQ: 0, issB: 0, issN: 0, n: 0 };
  (rounds || Object.keys(byM || {})).forEach((m) => {
    const t = byM && byM[m];
    if (!t) return;
    o.reqQ += num(t[0]); o.reqB += num(t[1]); o.pcuQ += num(t[2]); o.pcuB += num(t[3]); o.pcuN += num(t[4]);
    o.issQ += num(t[5]); o.issB += num(t[6]); o.issN += num(t[7]); o.n += num(t[8]);
  });
  return o;
}

/** Rows from a pcuDashboard-shaped payload (the PCU page, and adminDashboard{pcu}). Average = over rounds that have a used (or estimated) figure. */
export function pcuOverviewRows(data) {
  const items = data.items || {}, monthly = data.monthly || {}, st = data.stock_latest || {}, src = data.item_src || {};
  const rounds = data.rounds || [];
  const codes = new Set([...Object.keys(items), ...Object.keys(monthly), ...Object.keys(st), ...Object.keys(src)]);
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
      gotQ: gq, gotB: gb, usedQ: uq, usedB: ub, estQ: eq, ...srcSum(src[code], rounds),
      stockQ: stock, stockB: stock == null ? null : stock * price, stockNote: e ? shortRound(e.round) : "",
      stockGot: e ? (e.got == null ? null : num(e.got)) : 0, // 2aq: ได้เพิ่ม in the stock's round (null = requested, not received yet)
      left: monthsLeft(stock, uq, um),
      ledger: (data.ledger || {})[code] || null, mode: data.received_mode || "pcu", // 2as: the per-round ledger (expand row)
    });
  });
  return rows;
}

/** Rows from the admin network payload: network.items (V8 fy-to-date) + stock_net. Average = used ÷ elapsed rounds (the payload has no per-item months). */
export function networkOverviewRows(data) {
  const items = data.items || {}, ni = (data.network || {}).items || {}, sn = data.stock_net || {}, src = (data.network || {}).item_src || {};
  const elapsed = num(data.elapsed);
  const codes = new Set([...Object.keys(ni), ...Object.keys(sn), ...Object.keys(src)]);
  const rows = [];
  codes.forEach((code) => {
    const it = items[code] || {}, v = ni[code] || [];
    const s = sn[code];
    const stock = s ? num(s.qty) : null;
    const uq = num(v[4]) + num(v[6]);
    rows.push({
      code, name: it.name || code, unit: it.unit || "", group: it.unit_group || "",
      gotQ: num(v[2]), gotB: num(v[3]), usedQ: uq, usedB: num(v[5]) + num(v[7]), estQ: num(v[6]), ...srcSum(src[code], data.rounds),
      stockQ: stock, stockB: s ? num(s.baht) : null, stockNote: s ? `${(s.pcus || []).length} แห่ง` : "", stockGot: 0,
      left: monthsLeft(stock, uq, elapsed),
    });
  });
  return rows;
}

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name, "th") || a.code.localeCompare(b.code),
  req: (a, b, m) => (m === "baht" ? a.reqB - b.reqB : a.reqQ - b.reqQ),
  pcu: (a, b, m) => (m === "baht" ? a.pcuB - b.pcuB : a.pcuQ - b.pcuQ),
  iss: (a, b, m) => (m === "baht" ? a.issB - b.issB : a.issQ - b.issQ),
  used: (a, b, m) => (m === "baht" ? a.usedB - b.usedB : a.usedQ - b.usedQ),
  stock: (a, b, m) => ((m === "baht" ? a.stockB : a.stockQ) ?? -1) - ((m === "baht" ? b.stockB : b.stockQ) ?? -1),
  left: (a, b) => (a.left ?? -1) - (b.left ?? -1),
};

/**
 * mount(host, opts) — opts: getRows() → rows, getMode() → "qty"|"baht", getUnit() → unit_group|"all", title, caption (html),
 * headHtml (extra controls above the search box, e.g. the admin PCU picker), onHead(host) (binds them),
 * 2aq: page (rows shown before "ดูทั้งหมด", default 50) · collapsible (the card folds; open at first) · srcNote (what a/n counts).
 * Returns {render}: call after the data / mode / unit changed. The shell (search box) is built once so typing keeps focus.
 */
export function mount(host, opts) {
  const page = opts.page || PAGE;
  const st = { search: "", sort: { key: "req", dir: "desc" }, limit: page, built: false, open: new Set() }; // 2as: open = codes showing their ledger

  function shell() {
    const inner = `<p class="muted small dash-caption">${opts.caption || ""}</p>
      ${opts.headHtml || ""}
      <div class="dash-tools"><input type="text" class="select-input ov-search" placeholder="ค้นหาชื่อหรือรหัสรายการ" aria-label="ค้นหารายการ (ภาพรวมต่อรายการ)" autocomplete="off"></div>
      <div class="ov-table"></div>`;
    host.innerHTML = opts.collapsible
      ? `<details class="dash-card ov-card ov-fold" open><summary class="ov-sum"><h3>${esc(opts.title || "ภาพรวมต่อรายการ")}</h3><span class="muted small ov-sum-hint">กดเพื่อพับ / เปิด</span></summary>${inner}</details>`
      : `<div class="dash-card ov-card"><h3>${esc(opts.title || "ภาพรวมต่อรายการ")}</h3>${inner}</div>`;
    const inp = host.querySelector(".ov-search");
    inp.value = st.search;
    inp.addEventListener("input", () => { st.search = inp.value; st.limit = page; table(); });
    if (opts.onHead) opts.onHead(host);
    st.built = true;
  }

  function table() {
    const t = host.querySelector(".ov-table");
    if (!t) return;
    const mode = opts.getMode() === "baht" ? "baht" : "qty";
    const unit = opts.getUnit ? opts.getUnit() : "all";
    const q = st.search.trim().toLowerCase();
    const all = opts.getRows();
    // 2ar: no dispenser figure anywhere in this payload (fy) → no จ่ายจริง column (comes back once a dispenser keys one)
    const showIss = all.some((r) => r.issN > 0);
    if (!showIss && st.sort.key === "iss") st.sort = { key: "req", dir: "desc" };
    let rows = all.filter((r) => (unit === "all" || r.group === unit)
      && (q ? r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q) : r.n > 0 || r.gotQ > 0 || r.usedQ > 0 || r.stockQ != null));
    const { key, dir } = st.sort;
    const sign = dir === "asc" ? 1 : -1;
    // empty values (no คงเหลือ / no used / nothing entered) sink to the bottom whichever way the column is sorted
    const empty = (r) => (key === "stock" ? r.stockQ == null : key === "left" ? r.left == null
      : key === "pcu" ? !(r.pcuN > 0) : key === "iss" ? !(r.issN > 0) : false);
    rows = rows.slice().sort((a, b) => (empty(a) - empty(b)) || sign * SORTERS[key](a, b, mode) || SORTERS.name(a, b));
    const total = rows.length;
    rows = rows.slice(0, st.limit);
    const money = mode === "baht";
    const f = (v) => (money ? formatInt(v) : formatQty(v));
    const cell = (v) => (v ? f(v) : dash);
    const none = '<span class="muted small">ยังไม่มีข้อมูล</span>';
    // 2aq: a source column — not requested → – · requested, nobody entered → ยังไม่มีข้อมูล · entered (0 counts) → value (+ a/n when partial)
    const srcCell = (r, qv, bv, have) => {
      if (!(r.n > 0)) return `<td class="num">${dash}</td>`;
      if (!(have > 0)) return `<td class="num">${none}</td>`;
      const part = have < r.n ? ` <span class="muted small" title="${esc(opts.srcNote || "บรรทัดที่กรอกแล้ว / บรรทัดที่ขอเบิก")}">(${formatInt(have)}/${formatInt(r.n)})</span>` : "";
      return `<td class="num">${f(money ? bv : qv)}${part}</td>`;
    };
    const th = (k, label, title) => {
      const on = st.sort.key === k;
      return `<th scope="col" class="${k === "name" ? "dash-name" : "num"}" aria-sort="${on ? (st.sort.dir === "asc" ? "ascending" : "descending") : "none"}"${title ? ` title="${esc(title)}"` : ""}><button type="button" class="ov-sort" data-sort="${k}">${esc(label)}${on ? (st.sort.dir === "asc" ? " ▲" : " ▼") : ""}</button></th>`;
    };
    const body = rows.map((r) => {
      const used = money ? r.usedB : r.usedQ;
      const est = r.estQ > 0;
      const stock = money ? r.stockB : r.stockQ;
      // 2aq: the old คงเหลือ card's ของเดิม + ได้เพิ่ม = รวม, under the figure (qty mode, PCU rows only)
      const add = !money && stock != null && r.stockGot !== 0
        ? `<div class="muted small">${r.stockGot == null ? "ได้เพิ่ม รอจ่าย" : `+ ได้เพิ่ม ${formatQty(r.stockGot)} = ${formatQty(r.stockQ + r.stockGot)}`}</div>` : "";
      const open = r.ledger && st.open.has(r.code);
      const ledBtn = r.ledger ? ` <button type="button" class="ov-led-btn" data-led="${esc(r.code)}" aria-expanded="${open}">${open ? "ซ่อนรายเดือน" : "ดูรายเดือน"}</button>` : "";
      const ledRow = open ? `<tr class="ov-led-row"><td colspan="${showIss ? 7 : 6}">${ledgerTableHtml(r.ledger, r.mode)}</td></tr>` : "";
      return `<tr>
        <th scope="row" class="dash-name"><div>${esc(r.name)}</div><div class="muted small">${esc(r.code)}${r.unit ? ` · ${esc(r.unit)}` : ""}${ledBtn}</div></th>
        <td class="num">${cell(money ? r.reqB : r.reqQ)}</td>
        ${srcCell(r, r.pcuQ, r.pcuB, r.pcuN)}
        ${showIss ? srcCell(r, r.issQ, r.issB, r.issN) : ""}
        <td class="num"${est ? ` title="${esc(`ในนี้ ${formatQty(r.estQ)} คิดด้วยยอดเบิกแทนได้มาจริง (ยังไม่กรอก)`)}"` : ""}>${est ? "≈ " : ""}${cell(used)}</td>
        <td class="num">${stock == null ? dash : `<span class="strong">${f(stock)}</span>${r.stockNote ? ` <span class="muted small">${esc(r.stockNote)}</span>` : ""}${add}`}</td>
        <td class="num">${r.left == null ? dash : `<strong>~${esc(monthsText(r.left))}</strong> <span class="muted small">เดือน</span>`}</td></tr>${ledRow}`;
    }).join("");
    const rest = total - rows.length;
    const more = rest > 0 ? `<div class="ov-more-row"><button type="button" class="btn btn-secondary ov-more">${opts.page ? `ดูทั้งหมด (อีก ${rest} รายการ)` : `แสดงเพิ่ม (เหลืออีก ${rest} รายการ)`}</button></div>`
      : opts.page && total > page ? `<div class="ov-more-row"><button type="button" class="btn btn-secondary ov-less">ย่อเหลือ ${page} รายการ</button></div>` : "";
    t.innerHTML = `<p class="muted small" aria-live="polite">แสดง ${rows.length} จาก ${total} รายการ · ${money ? "บาท" : "จำนวน (หน่วยเบิก)"} · ${showIss ? "ได้รับ / จ่ายจริง" : "ได้รับ"}: กรอก 0 แสดง 0 · “ยังไม่มีข้อมูล” = ขอเบิกแต่ยังไม่ได้กรอก · (a/n) = กรอกแล้วบางส่วน · พอใช้อีก = คงเหลือ ÷ ใช้ไปเฉลี่ยต่อเดือน · ใช้ไป = คงเหลือ + ได้มาจริง − คงเหลือรอบถัดไป · ≈ บางรอบยังไม่กรอกได้มาจริง คิดด้วยยอดเบิกแทน (อาจไม่ถูกต้อง)${showIss ? "" : " · ยังไม่มียอดจ่ายจริงจากหน่วยจ่ายในปีงบนี้ (ซ่อนคอลัมน์ไว้)"}</p>
      ${total === 0 ? `<p class="muted">ไม่พบรายการ</p>` : `
      <div class="table-scroll dash-table-wrap"><table class="dash-table dash-table-sm ov-tbl">
        <caption class="sr-only">ภาพรวมต่อรายการ: ขอเบิก ได้รับที่ รพ.สต. กรอก${showIss ? " จ่ายจริงที่หน่วยจ่ายบันทึก" : ""} ใช้ไป คงเหลือ พอใช้อีกกี่เดือน</caption>
        <thead><tr>${th("name", "รายการ")}${th("req", "ขอเบิก")}${th("pcu", "ได้รับ (รพ.สต. กรอก)", "ยอดที่ รพ.สต. แจ้งว่าได้รับ")}${showIss ? th("iss", "จ่ายจริง (หน่วยจ่าย)", "ยอดที่หน่วยจ่ายบันทึกว่าจ่าย") : ""}${th("used", "ใช้ไป")}${th("stock", "คงเหลือ")}${th("left", "พอใช้อีก ~เดือน")}</tr></thead>
        <tbody>${body}</tbody></table></div>${more}`}`;
    t.querySelectorAll(".ov-sort").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.sort;
      st.sort = st.sort.key === k ? { key: k, dir: st.sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" ? "asc" : "desc" };
      table();
    }));
    t.querySelectorAll(".ov-led-btn").forEach((b) => b.addEventListener("click", () => { // 2as
      const k = b.dataset.led;
      if (st.open.has(k)) st.open.delete(k); else st.open.add(k);
      table();
    }));
    const mb = t.querySelector(".ov-more");
    if (mb) mb.addEventListener("click", () => { st.limit = opts.page ? Infinity : st.limit + PAGE; table(); });
    const lb = t.querySelector(".ov-less");
    if (lb) lb.addEventListener("click", () => { st.limit = page; table(); host.querySelector(".ov-card").scrollIntoView({ block: "nearest" }); });
  }

  return {
    render(rebuild) {
      if (!st.built || rebuild || !host.querySelector(".ov-card")) shell();
      table();
    },
  };
}
