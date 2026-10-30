// Brief 2s — "จ่ายไม่พอ" (issueShortage, briefs/2s_admin_dashboard.md §6.3): items where the dispenser issued less than requested.
// Shared by the admin dashboard tab (a card) and the dispenser's "จ่ายจริง" tab (a collapsible section).
// Summary on top -> top 5 items (or all, sortable) -> click an item for the per-PCU rows. Toggle รอบนี้ / สะสมปีงบ + unit filter.
import { formatInt, formatMoney } from "../format.js";
import { escapeHtml as esc, errMessage } from "./util.js";
import { shortRound } from "../pages/dashboard_calc.js";

const UNITS = ["พัสดุ", "จ่ายกลาง", "LAB"];
const SORTS = [
  { key: "short_qty", label: "จำนวนที่ขาด" },
  { key: "short_baht", label: "บาทที่ขาด" },
  { key: "n_pcus", label: "จำนวนแห่ง" },
];
const REASON = { out_of_stock: "ของหมด", other: "อื่น ๆ" };

const nz = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Sorted copy of the item list: primary = key (desc), then short_qty, short_baht, code. */
export function sortShortItems(items, key) {
  return (items || []).slice().sort((a, b) =>
    nz(b[key]) - nz(a[key]) || nz(b.short_qty) - nz(a.short_qty) || nz(b.short_baht) - nz(a.short_baht) || String(a.code).localeCompare(String(b.code)));
}

export function reasonText(row) {
  if (row.reason === "out_of_stock") return row.note ? `${REASON.out_of_stock} — ${row.note}` : REASON.out_of_stock; // 2ae
  if (row.reason === "other") return row.note ? `${REASON.other} — ${row.note}` : REASON.other;
  return row.reason ? String(row.reason) : "ไม่ระบุ";
}

/**
 * host: element to fill. call(action, params): the admin API caller. defaultUnit: undefined (dispenser: let the server pick
 * the dispenser's own unit) or "all". Returns { reload(fy) }.
 */
export function mountShortage(host, { call, fy, defaultUnit, heading = "จ่ายไม่พอ" }) {
  const st = {
    fy: fy || null,
    scope: "round",
    unit: defaultUnit || undefined, // undefined => omitted from the request, the answer tells the resolved unit
    sort: "short_qty",
    showAll: false,
    open: new Set(),
    data: null,
    seq: 0,
    focus: null, // selector to re-focus after a re-render (keyboard users keep their place on the segmented buttons)
  };

  host.innerHTML = "";
  const card = document.createElement("div");
  card.className = "dash-card sh-card";
  host.appendChild(card);

  function segHtml(name, options, current, labelId) {
    return `<div class="dash-seg" role="group" aria-labelledby="${labelId}">${options
      .map((o) => `<button type="button" class="dash-seg-btn${o.value === current ? " is-on" : ""}" data-${name}="${esc(o.value)}" aria-pressed="${o.value === current}">${esc(o.label)}</button>`)
      .join("")}</div>`;
  }

  function controlsHtml() {
    const unit = st.unit || "all";
    return `<div class="dash-controls sh-controls">
      <div class="dash-ctl"><span class="dash-ctl-label" id="sh-l-scope">ช่วงเวลา</span>${segHtml("scope", [{ value: "round", label: "รอบนี้" }, { value: "fy", label: "สะสมปีงบ" }], st.scope, "sh-l-scope")}</div>
      <div class="dash-ctl"><span class="dash-ctl-label" id="sh-l-unit">หน่วยจ่าย</span>${segHtml("unit", [{ value: "all", label: "ทั้งหมด" }, ...UNITS.map((u) => ({ value: u, label: u }))], unit, "sh-l-unit")}</div>
    </div>`;
  }

  function scopeText(d) {
    if (d.scope === "fy") return `สะสมปีงบ ${d.fy}`;
    return d.month ? `รอบ ขอเบิก ${shortRound(d.month)}` : "รอบนี้";
  }

  function summaryHtml(d) {
    const s = d.summary || {};
    const tile = (label, value, sub, cls) => `<div class="dash-kpi${cls ? " " + cls : ""}"><div class="dash-kpi-label">${esc(label)}</div><div class="dash-kpi-value"><strong>${value}</strong></div><div class="dash-kpi-unit muted small">${esc(sub)}</div></div>`;
    return `<div class="dash-kpis">
      ${tile("จ่ายครบ", formatInt(s.complete), "รายการ")}
      ${tile("จ่ายไม่ครบ", formatInt(s.incomplete), "รายการ")}
      ${tile("ขาดรวม", formatInt(s.short_qty), "หน่วย (ต่างชนิดรวมกัน)")}
      ${tile("ยอดเงินที่ขาดรวม", formatMoney(s.short_baht), "บาท")}
    </div>
    <p class="muted small sh-note">นับเป็นบรรทัด (รพ.สต. × รายการ × รอบ) ที่ผู้จ่ายกรอกยอดจ่ายแล้วเท่านั้น · ${esc(scopeText(d))}</p>`;
  }

  function detailHtml(d, code) {
    const rows = (d.by_pcu || {})[code] || [];
    if (!rows.length) return `<p class="muted small">ไม่มีรายละเอียด</p>`;
    const withMonth = d.scope === "fy";
    return `<div class="table-scroll"><table class="dash-table dash-table-sm sh-detail-table">
      <caption class="sr-only">รายละเอียดรายการที่จ่ายไม่พอ แยกตาม รพ.สต.</caption>
      <thead><tr><th scope="col">รพ.สต.</th>${withMonth ? `<th scope="col">รอบ</th>` : ""}<th scope="col" class="num">ขอ</th><th scope="col" class="num">จ่าย</th><th scope="col" class="num">ขาด</th><th scope="col" class="num">บาทขาด</th><th scope="col">เหตุผล</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <th scope="row">${esc(r.pcu_name || r.pcu)}</th>${withMonth ? `<td>${esc(r.month ? shortRound(r.month) : "–")}</td>` : ""}
        <td class="num">${formatInt(r.req)}</td><td class="num">${formatInt(r.issued)}</td><td class="num strong">${formatInt(r.short)}</td><td class="num">${formatMoney(r.short_baht)}</td>
        <td class="sh-reason">${esc(reasonText(r))}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function itemsHtml(d) {
    const all = sortShortItems(d.items, st.showAll ? st.sort : "short_qty");
    if (!all.length) {
      const s = d.summary || {};
      return (nz(s.complete) + nz(s.incomplete)) > 0
        ? `<div class="notice notice-info" role="status">ไม่มีรายการที่จ่ายไม่พอ — จ่ายครบทุกรายการที่บันทึกแล้ว</div>`
        : `<div class="notice notice-info" role="status">ยังไม่มีข้อมูลการจ่ายจริงในช่วงนี้ — เมื่อผู้จ่ายบันทึกยอดจ่ายแล้ว รายการที่ได้ไม่ครบจะแสดงที่นี่</div>`;
    }
    const list = st.showAll ? all : all.slice(0, 5);
    const sortBar = st.showAll
      ? `<div class="dash-ctl sh-sort"><span class="dash-ctl-label" id="sh-l-sort">เรียงตาม</span>${segHtml("sort", SORTS.map((x) => ({ value: x.key, label: x.label })), st.sort, "sh-l-sort")}</div>`
      : "";
    const body = list.map((it) => {
      const open = st.open.has(it.code);
      return `<tr class="sh-row${open ? " is-open" : ""}">
        <th scope="row" class="dash-name"><button type="button" class="sh-row-btn" data-code="${esc(it.code)}" aria-expanded="${open}"><span class="sh-caret" aria-hidden="true">${open ? "▾" : "▸"}</span> <strong>${esc(it.name)}</strong></button>
          <div class="muted small">${esc(it.code)}${it.unit ? ` · ${esc(it.unit)}` : ""}${it.unit_group ? ` · ${esc(it.unit_group)}` : ""}</div></th>
        <td class="num strong">${formatInt(it.short_qty)}</td><td class="num">${formatMoney(it.short_baht)}</td><td class="num">${formatInt(it.n_pcus)}</td></tr>${open ? `
      <tr class="sh-detail"><td colspan="4">${detailHtml(d, it.code)}</td></tr>` : ""}`;
    }).join("");
    const more = !st.showAll && all.length > 5
      ? `<button type="button" class="btn btn-secondary sh-all" data-act="all">ดูทั้งหมด (${formatInt(all.length)} รายการ)</button>`
      : st.showAll && all.length > 5
        ? `<button type="button" class="btn btn-secondary sh-all" data-act="top">แสดงเฉพาะ 5 อันดับแรก</button>`
        : "";
    return `${sortBar}
      <p class="muted small">${st.showAll ? `ทั้งหมด ${formatInt(all.length)} รายการ` : "5 อันดับแรก เรียงตามจำนวนที่ขาดรวม"} · กดชื่อรายการเพื่อดูรายละเอียดแต่ละ รพ.สต.</p>
      <div class="table-scroll dash-table-wrap sh-table-wrap"><table class="dash-table sh-table">
        <caption class="sr-only">รายการที่จ่ายไม่พอ</caption>
        <thead><tr><th scope="col" class="dash-name">รายการ</th><th scope="col" class="num">ขาด (หน่วย)</th><th scope="col" class="num">บาทที่ขาด</th><th scope="col" class="num">จำนวนแห่ง</th></tr></thead>
        <tbody>${body}</tbody></table></div>${more}`;
  }

  function render(extra) {
    card.innerHTML = `<h3>${esc(heading)}</h3>
      <p class="muted small dash-caption">รายการที่ผู้จ่ายจ่ายน้อยกว่าที่ขอ (ขาด = ขอ − จ่าย) เห็นข้อมูลทุกหน่วยจ่าย</p>
      ${controlsHtml()}<div class="sh-body">${extra}</div>`;
    if (st.focus) {
      const f = card.querySelector(st.focus);
      if (f) f.focus();
    }
    card.querySelectorAll("[data-scope]").forEach((b) => b.addEventListener("click", () => {
      if (st.scope === b.dataset.scope) return;
      st.scope = b.dataset.scope; st.open.clear(); st.focus = `[data-scope="${b.dataset.scope}"]`; load();
    }));
    card.querySelectorAll("[data-unit]").forEach((b) => b.addEventListener("click", () => {
      if ((st.unit || "all") === b.dataset.unit) return;
      st.unit = b.dataset.unit; st.open.clear(); st.focus = `[data-unit="${b.dataset.unit}"]`; load();
    }));
  }

  function renderData() {
    const d = st.data;
    render(`${summaryHtml(d)}${itemsHtml(d)}`);
    st.focus = null;
    card.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => { st.sort = b.dataset.sort; st.focus = `[data-sort="${b.dataset.sort}"]`; renderData(); }));
    card.querySelectorAll(".sh-all").forEach((b) => b.addEventListener("click", () => { st.showAll = b.dataset.act === "all"; st.focus = ".sh-all"; renderData(); }));
    card.querySelectorAll(".sh-row-btn").forEach((b) => b.addEventListener("click", () => {
      const c = b.dataset.code;
      if (st.open.has(c)) st.open.delete(c); else st.open.add(c);
      renderData();
      const again = card.querySelector(`.sh-row-btn[data-code="${CSS.escape(c)}"]`);
      if (again) again.focus();
    }));
  }

  async function load() {
    const my = ++st.seq;
    render(`<p class="muted" role="status">กำลังโหลดข้อมูล...</p>`);
    const params = { scope: st.scope };
    if (st.fy) params.fy = st.fy;
    if (st.unit) params.unit = st.unit;
    try {
      const d = await call("issueShortage", params);
      if (my !== st.seq) return; // host may be detached for a moment while the dashboard redraws (it is re-attached) — never drop the answer
      st.data = d;
      if (d && d.unit) st.unit = d.unit;
      renderData();
    } catch (err) {
      if (my !== st.seq) return; // host may be detached for a moment while the dashboard redraws (it is re-attached) — never drop the answer
      render(`<div class="notice notice-error" role="alert">โหลดข้อมูลจ่ายไม่พอไม่สำเร็จ: ${esc(errMessage(err))}</div>
        <p><button type="button" class="btn btn-secondary" data-act="retry">ลองใหม่</button></p>`);
      const r = card.querySelector('[data-act="retry"]');
      if (r) r.addEventListener("click", load);
    }
  }

  load();
  return {
    reload(newFy) {
      if (newFy !== undefined) st.fy = newFy;
      st.open.clear();
      load();
    },
  };
}
