// 2aq (brief 2aq) — heat map "รายการทั้งหมด": item × round, one source at a time — ใบเบิก / รพ.สต. กรอกรับ / หน่วยจ่ายจ่าย.
// Data = item_src {code: {round: S9}} (S9 = [req_q, req_b, pcu_q, pcu_b, pcu_n, iss_q, iss_b, iss_n, n]) — network.item_src on the admin
// network view. A source nobody entered shows "ยังไม่มีข้อมูล"; a typed 0 shows 0. Styles: css/2ao_ui.css (.hm-*).
import { esc } from "../esc.js";
import { formatInt } from "../format.js";
import { formatQty } from "../units.js";
import { num } from "../calc_common.js";
import { shortRound } from "./dashboard_calc.js";
import { heatPct } from "./dashboard_parts.js";

export const HEAT_SRC = [
  { key: "req", label: "ตามใบเบิก", i: [0, 1, 8], none: "" },
  { key: "pcu", label: "ตามที่ รพ.สต. กรอกรับ", i: [2, 3, 4], none: "รพ.สต. ยังไม่ได้กรอกยอดที่ได้รับ" },
  { key: "iss", label: "ตามที่หน่วยจ่ายจ่าย", i: [5, 6, 7], none: "หน่วยจ่ายยังไม่ได้บันทึกยอดจ่าย" },
];
const PAGE = 30;
const dash = '<span class="muted">–</span>';

/** Rows of one source: {code, name, unit, group, cells: [{q, b, have, n} | null], q, b, have, n, reqB} — items requested in some round. */
export function heatRows(src, items, rounds, key) {
  const [qi, bi, hi] = (HEAT_SRC.find((s) => s.key === key) || HEAT_SRC[0]).i;
  const rows = [];
  Object.entries(src || {}).forEach(([code, byM]) => {
    const it = (items || {})[code] || {};
    let q = 0, b = 0, have = 0, n = 0, reqB = 0;
    const cells = rounds.map((m) => {
      const t = byM[m];
      if (!t || !(num(t[8]) > 0)) return null;
      const c = { q: num(t[qi]), b: num(t[bi]), have: num(t[hi]), n: num(t[8]) };
      n += c.n; reqB += num(t[1]);
      if (c.have > 0) { q += c.q; b += c.b; have += c.have; }
      return c;
    });
    if (n > 0) rows.push({ code, name: it.name || code, unit: it.unit || "", group: it.unit_group || "", cells, q, b, have, n, reqB });
  });
  return rows;
}

/** mount(host, {getData() → {src, items, rounds}, getUnit() → unit_group|"all", scope() → text}) → {render}. */
export function mount(host, opts) {
  const st = { key: "req", search: "", limit: PAGE, built: false };

  function shell() {
    host.innerHTML = `<div class="dash-card hm-card"><h3>รายการทั้งหมด (heat map)</h3>
      <p class="muted small dash-caption hm-cap"></p>
      <div class="dash-controls hm-head"><div class="dash-ctl"><span class="dash-ctl-label" id="hm-l-src">ดูตาม</span>
        <div class="dash-seg" role="group" aria-labelledby="hm-l-src">${HEAT_SRC.map((s) => `<button type="button" class="dash-seg-btn${s.key === st.key ? " is-on" : ""}" data-hmsrc="${s.key}" aria-pressed="${s.key === st.key}">${esc(s.label)}</button>`).join("")}</div></div></div>
      <div class="dash-tools"><input type="text" class="select-input hm-search" placeholder="ค้นหาชื่อหรือรหัสรายการ" aria-label="ค้นหารายการ (heat map)" autocomplete="off"></div>
      <div class="hm-body"></div></div>`;
    const inp = host.querySelector(".hm-search");
    inp.value = st.search;
    inp.addEventListener("input", () => { st.search = inp.value; st.limit = PAGE; body(); });
    host.querySelectorAll("[data-hmsrc]").forEach((b) => b.addEventListener("click", () => {
      st.key = b.dataset.hmsrc; st.limit = PAGE;
      host.querySelectorAll("[data-hmsrc]").forEach((x) => { const on = x.dataset.hmsrc === st.key; x.classList.toggle("is-on", on); x.setAttribute("aria-pressed", String(on)); });
      body();
    }));
    st.built = true;
  }

  function body() {
    const t = host.querySelector(".hm-body");
    if (!t) return;
    const { src, items, rounds: all } = opts.getData();
    // rounds up to the last one with a request (the rest of the fy is empty)
    let last = -1;
    (all || []).forEach((m, i) => { if (Object.values(src || {}).some((byM) => byM[m] && num(byM[m][8]) > 0)) last = i; });
    const rounds = (all || []).slice(0, last + 1);
    const def = HEAT_SRC.find((s) => s.key === st.key);
    const unit = opts.getUnit ? opts.getUnit() : "all";
    const q = st.search.trim().toLowerCase();
    let rows = heatRows(src, items, rounds, st.key).filter((r) => (unit === "all" || r.group === unit)
      && (!q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q)));
    const anyData = rows.some((r) => r.have > 0);
    host.querySelector(".hm-cap").textContent = `${opts.scope ? opts.scope() : ""} · รวมทุก รพ.สต. · ช่อง = จำนวน (บน) / บาท (ล่าง) · สีเข้มตามยอดบาท · `
      + `${st.key === "req" ? "ยอดตามใบเบิกที่ส่งแล้ว" : `${def.label.replace("ตาม", "")} — กรอก 0 แสดง 0 · “ไม่มีข้อมูล” = ขอเบิกแต่ยังไม่มีใครกรอก · a/n แห่ง = กรอกแล้ว a จาก n แห่งที่ขอ`}`;
    if (!rows.length) { t.innerHTML = `<p class="muted">ไม่พบรายการ</p>`; return; }
    if (st.key !== "req" && !anyData) {
      t.innerHTML = `<div class="notice notice-info" role="status"><strong>ยังไม่มีข้อมูล</strong> — ${esc(def.none)}ในปีงบนี้${unit !== "all" ? ` (หน่วยจ่าย ${esc(unit)})` : ""}</div>`;
      return;
    }
    rows.sort((a, b) => b.b - a.b || b.reqB - a.reqB || a.name.localeCompare(b.name, "th"));
    const total = rows.length;
    rows = rows.slice(0, st.limit);
    const max = Math.max(0, ...rows.flatMap((r) => r.cells.map((c) => (c && c.have > 0 ? c.b : 0))));
    const cell = (c) => {
      if (!c) return `<td class="num dash-heatcell">${dash}</td>`;
      if (!(c.have > 0)) return `<td class="num dash-heatcell hm-none"><span class="muted small">ไม่มีข้อมูล</span></td>`;
      const p = heatPct(c.b, max);
      const part = st.key !== "req" && c.have < c.n ? `<div class="hm-part muted">${formatInt(c.have)}/${formatInt(c.n)} แห่ง</div>` : "";
      return `<td class="num dash-heatcell"${p ? ` style="background:color-mix(in srgb, var(--dv-req) ${p}%, transparent)"` : ""}><div>${formatQty(c.q)}</div><div class="dash-heat-sub">${formatInt(c.b)} บาท</div>${part}</td>`;
    };
    const tot = (r) => (r.have > 0 ? `<div class="strong">${formatQty(r.q)}</div><div class="dash-heat-sub">${formatInt(r.b)} บาท</div>` : `<span class="muted small">ไม่มีข้อมูล</span>`);
    const more = total > rows.length ? `<button type="button" class="btn btn-secondary hm-more">แสดงเพิ่ม (เหลืออีก ${total - rows.length} รายการ)</button>` : "";
    t.innerHTML = `<p class="muted small" aria-live="polite">แสดง ${rows.length} จาก ${total} รายการ · เรียงตามยอดบาท (มาก → น้อย)</p>
      <div class="dash-heat-legend small muted" aria-hidden="true"><span>สีตามยอดบาทต่อช่อง (ต่ำ</span>${[0.1, 0.35, 0.6, 0.85, 1]
        .map((f) => `<i style="background:color-mix(in srgb, var(--dv-req) ${Math.round(8 + f * 42)}%, transparent)"></i>`).join("")}<span>สูง) · – = ไม่ได้ขอเบิก</span></div>
      <div class="table-scroll dash-table-wrap"><table class="dash-table dash-heat hm-tbl">
        <caption class="sr-only">รายการทั้งหมด ${esc(def.label)} รายรอบ</caption>
        <thead><tr><th scope="col" class="dash-name">รายการ</th>${rounds.map((m) => `<th scope="col" class="num">${esc(shortRound(m))}</th>`).join("")}<th scope="col" class="num">รวม</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><th scope="row" class="dash-name"><div>${esc(r.name)}</div><div class="muted small">${esc(r.code)}${r.unit ? ` · ${esc(r.unit)}` : ""}${r.group ? ` · ${esc(r.group)}` : ""}</div></th>
          ${r.cells.map(cell).join("")}<td class="num dash-heatcell">${tot(r)}</td></tr>`).join("")}</tbody></table></div>${more}`;
    const mb = t.querySelector(".hm-more");
    if (mb) mb.addEventListener("click", () => { st.limit += PAGE; body(); });
  }

  return {
    render(rebuild) {
      if (!st.built || rebuild || !host.querySelector(".hm-card")) shell();
      body();
    },
  };
}
