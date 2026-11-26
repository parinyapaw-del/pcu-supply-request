// 2as (brief briefs/2as_ledger_received_mode.md) — Save's ledger: per round M of one item = คงเหลือ(M) · เบิก(M) · ได้มาจริง(M) ·
// ใช้ไป(M) = คงเหลือ(M) + ได้มาจริง(M) − คงเหลือ(M+1). ได้มาจริง missing → ยอดเบิกแทน (≈, flag 1) · a count missing → no ใช้ไป yet.
// Data = pcuDashboard / adminDashboard{pcu}: ledger {code: {round: [stock|null, req, recv|null, used|null, flag]}}, missing
// {round: [req lines, recv missing, stock lines]}, received_mode, item_src (S9) · network: missing {pcu: {round: [..]}}, recv_cmp
// {pcu: [both, differ, |diff| baht, pcu only, issuer only]}. Pure HTML builders (no state); styles in css/2ao_ui.css (.led-*).
import { esc } from "../esc.js";
import { formatInt } from "../format.js";
import { formatQty } from "../units.js";
import { num } from "../calc_common.js";
import { shortRound } from "./dashboard_calc.js";

const fullRound = (m) => `ขอเบิก ${shortRound(m)}`; // = dashboard_parts.fullRound (that module imports this one)

const dash = '<span class="muted">–</span>';
const tag = (text, cls = "") => `<span class="led-tag${cls ? " " + cls : ""}">${esc(text)}</span>`;
const nextOf = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
export const recvWho = (mode) => (mode === "issuer" ? "หน่วยจ่ายยังไม่บันทึก" : "ยังไม่กรอก");

/** One item's ledger as a small table (rounds in order). `byM` = ledger[code]. */
export function ledgerTableHtml(byM, mode) {
  const rounds = Object.keys(byM || {}).sort();
  if (!rounds.length) return `<p class="muted small">ยังไม่มีข้อมูลรายเดือน</p>`;
  const rows = rounds.map((m) => {
    const [st, req, recv, used, flag] = byM[m];
    const nx = byM[nextOf(m)];
    const recvCell = !(num(req) > 0) ? dash : recv != null ? formatQty(recv) : nx ? tag(recvWho(mode), "led-miss") : tag("รอเดือนถัดไป"); // not due yet
    let usedCell;
    if (used != null) usedCell = flag === 1 ? `≈ ${formatQty(used)} <span class="muted small">(ใช้ยอดเบิกแทน)</span>` : formatQty(used);
    else if (st == null) usedCell = tag("ยังไม่กรอกคงเหลือ", "led-miss");
    else if (flag === 2) usedCell = tag("ติดลบ — ตรวจตัวเลข", "led-warn");
    else if (!nx || nx[0] == null) usedCell = tag("รอคงเหลือเดือนถัดไป");
    else usedCell = dash;
    return `<tr><th scope="row" title="${esc(fullRound(m))}">${esc(shortRound(m))}</th>
      <td class="num">${st == null ? tag("ยังไม่กรอก", "led-miss") : formatQty(st)}</td><td class="num">${num(req) > 0 ? formatQty(req) : dash}</td>
      <td class="num">${recvCell}</td><td class="num">${usedCell}</td></tr>`;
  }).join("");
  return `<table class="dash-table dash-table-sm led-tbl"><caption class="sr-only">รายเดือน: คงเหลือ เบิก ได้มาจริง ใช้ไป</caption>
    <thead><tr><th scope="col">รอบ</th><th scope="col" class="num">คงเหลือ</th><th scope="col" class="num">เบิก</th><th scope="col" class="num">ได้มาจริง</th><th scope="col" class="num">ใช้ไป</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted small">ใช้ไปของรอบ = คงเหลือรอบนั้น + ได้มาจริง − คงเหลือรอบถัดไป (รู้เมื่อทำใบเดือนถัดไป) · ได้มาจริงยังไม่กรอก → ใช้ยอดเบิกแทน (≈)</p>`;
}

// rounds whose ได้มาจริง is due: the next round's sheet exists (= the PCU has moved on) · stock: requested but no คงเหลือ at all
function dueOf(missing) {
  const ms = Object.keys(missing || {}).sort();
  const recv = [], stock = [];
  ms.forEach((m) => {
    const [req, rmiss, st] = missing[m].map(num);
    if (rmiss > 0 && missing[nextOf(m)]) recv.push([m, rmiss, req]);
    if (req > 0 && st === 0) stock.push(m);
  });
  return { recv, stock };
}

/** Notice on the PCU dashboard / admin per-PCU view: what this PCU has not entered yet (empty string when nothing). */
export function missingNoticeHtml(data, { staff = false } = {}) {
  const mode = data.received_mode || "pcu";
  const { recv, stock } = dueOf(data.missing);
  const parts = [];
  if (recv.length && (mode === "pcu" || staff)) {
    const who = mode === "issuer" ? "หน่วยจ่ายยังไม่บันทึกยอดจ่าย" : "ยังไม่กรอกได้มาจริง";
    parts.push(`<li><strong>${who}</strong>: ${recv.map(([m, n, t]) => `${esc(shortRound(m))} ${formatInt(n)}/${formatInt(t)} รายการ`
      + (mode === "pcu" && !staff ? ` <a href="#/received?month=${esc(m)}">กรอก</a>` : "")).join(" · ")}</li>`);
  }
  if (stock.length) parts.push(`<li><strong>ไม่ได้กรอกคงเหลือ</strong>: ${stock.map((m) => esc(shortRound(m))).join(" · ")}</li>`);
  if (!parts.length) return "";
  return `<div class="notice notice-info led-notice" role="status"><ul class="led-list">${parts.join("")}</ul>
    <p class="small">ใช้ไปของรายการที่ยังไม่กรอกได้มาจริงคำนวณด้วยยอดเบิกแทน (≈) · ไม่มีคงเหลือ = ยังคำนวณใช้ไปไม่ได้</p></div>`;
}

/** Admin network card: which PCU has not entered what, per round. `names` = Map code → name. */
export function netMissingCardHtml(data, names) {
  const mode = data.received_mode || "pcu";
  const miss = data.missing || {};
  const rows = Object.keys(miss).sort().map((pcu) => {
    const { recv, stock } = dueOf(miss[pcu]);
    if (!recv.length && !stock.length) return null;
    const r = recv.map(([m, n, t]) => tag(`${shortRound(m)} ${formatInt(n)}/${formatInt(t)}`, "led-miss")).join(" ");
    const s = stock.map((m) => tag(shortRound(m), "led-miss")).join(" ");
    return `<tr><th scope="row" class="adm-name"><button type="button" class="adm-link" data-pcu="${esc(pcu)}">${esc(names.get(pcu) || pcu)}</button></th>
      <td>${r || dash}</td><td>${s || dash}</td></tr>`;
  }).filter(Boolean);
  return `<div class="dash-card" id="adm-missing"><h3>ข้อมูลที่ยังไม่กรอก</h3>
    <p class="muted small dash-caption">ได้มาจริง (${mode === "issuer" ? "หน่วยจ่ายกรอก" : "รพ.สต. กรอก"}) ของรอบที่ทำใบเดือนถัดไปแล้ว = ขาด/ขอเบิก รายการ · คงเหลือ = รอบที่ขอเบิกแต่ไม่กรอกคงเหลือเลย · ใช้ไปของรายการที่ขาดได้มาจริงใช้ยอดเบิกแทน (≈) · กดชื่อเพื่อดูราย รพ.สต.</p>
    ${rows.length ? `<div class="table-scroll"><table class="dash-table dash-table-sm"><thead><tr><th scope="col">รพ.สต.</th><th scope="col">ได้มาจริงยังไม่กรอก</th><th scope="col">ไม่ได้กรอกคงเหลือ</th></tr></thead>
      <tbody>${rows.join("")}</tbody></table></div>` : `<p class="muted">กรอกครบทุกแห่ง</p>`}</div>`;
}

/** Admin network card: the PCU's report vs the dispenser's figure — baht of the differences, per PCU. */
export function recvCmpCardHtml(data, names) {
  const cmp = data.recv_cmp || {};
  const list = Object.entries(cmp).map(([pcu, v]) => ({ pcu, both: num(v[0]), differ: num(v[1]), baht: num(v[2]), pOnly: num(v[3]), iOnly: num(v[4]) }))
    .filter((r) => r.both || r.pOnly || r.iOnly).sort((a, b) => b.baht - a.baht || b.differ - a.differ);
  const anyIss = list.some((r) => r.both || r.iOnly);
  const tot = list.reduce((a, r) => ({ differ: a.differ + r.differ, baht: a.baht + r.baht, both: a.both + r.both }), { differ: 0, baht: 0, both: 0 });
  const body = !anyIss ? `<p class="muted">ยังไม่มีข้อมูลจากหน่วยจ่าย — เทียบได้เมื่อหน่วยจ่ายบันทึกยอดจ่าย</p>` : `
    <p><strong>${formatInt(Math.round(tot.baht))} บาท</strong> <span class="muted">ต่างกันรวม · ${formatInt(tot.differ)} จาก ${formatInt(tot.both)} บรรทัดที่มีทั้ง 2 แหล่งไม่ตรงกัน</span></p>
    <div class="table-scroll"><table class="dash-table dash-table-sm"><thead><tr><th scope="col">รพ.สต.</th><th scope="col" class="num">ต่างกัน (บาท)</th>
      <th scope="col" class="num">ไม่ตรง / มีทั้งคู่</th><th scope="col" class="num">รพ.สต. กรอกอย่างเดียว</th><th scope="col" class="num">หน่วยจ่ายกรอกอย่างเดียว</th></tr></thead>
    <tbody>${list.map((r) => `<tr><th scope="row" class="adm-name"><button type="button" class="adm-link" data-pcu="${esc(r.pcu)}">${esc(names.get(r.pcu) || r.pcu)}</button></th>
      <td class="num">${r.baht ? formatInt(Math.round(r.baht)) : dash}</td><td class="num">${formatInt(r.differ)} / ${formatInt(r.both)}</td>
      <td class="num">${formatInt(r.pOnly)}</td><td class="num">${formatInt(r.iOnly)}</td></tr>`).join("")}</tbody></table></div>`;
  return `<div class="dash-card" id="adm-recv-cmp"><h3>ได้มาจริง: รพ.สต. กรอก เทียบ หน่วยจ่ายกรอก</h3>
    <p class="muted small dash-caption">โหมดที่ใช้คำนวณตอนนี้: <strong>${data.received_mode === "issuer" ? "หน่วยจ่ายกรอก" : "รพ.สต. กรอก"}</strong> (เปลี่ยนได้ที่ ตั้งค่าระบบ) · ต่างกัน = |รพ.สต. − หน่วยจ่าย| × ราคา เฉพาะบรรทัดที่มีทั้งคู่ · กดชื่อเพื่อดูรายการที่ไม่ตรง</p>${body}</div>`;
}

/** Admin per-PCU card: the item × round lines where the two sources differ (from item_src, staff view). */
export function pcuMismatchCardHtml(data) {
  const src = data.item_src || {}, items = data.items || {};
  const rows = [];
  let pOnly = 0, iOnly = 0;
  Object.entries(src).forEach(([code, byM]) => Object.entries(byM).forEach(([m, t]) => {
    const hasP = num(t[4]) > 0, hasI = num(t[7]) > 0;
    if (hasP && !hasI) pOnly++;
    if (hasI && !hasP) iOnly++;
    if (!hasP || !hasI || num(t[2]) === num(t[5])) return;
    rows.push({ code, m, p: num(t[2]), i: num(t[5]), baht: Math.abs(num(t[3]) - num(t[6])) });
  }));
  if (!rows.length && !iOnly) return "";
  rows.sort((a, b) => b.baht - a.baht);
  return `<div class="dash-card" id="adm-pcu-mismatch"><h3>ได้มาจริงที่ไม่ตรงกัน (รพ.สต. เทียบ หน่วยจ่าย)</h3>
    <p class="muted small dash-caption">${formatInt(rows.length)} บรรทัดไม่ตรง · รพ.สต. กรอกอย่างเดียว ${formatInt(pOnly)} · หน่วยจ่ายกรอกอย่างเดียว ${formatInt(iOnly)}</p>
    ${rows.length ? `<div class="table-scroll"><table class="dash-table dash-table-sm"><thead><tr><th scope="col">รายการ</th><th scope="col">รอบ</th>
      <th scope="col" class="num">รพ.สต. กรอก</th><th scope="col" class="num">หน่วยจ่าย</th><th scope="col" class="num">ต่าง (บาท)</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><th scope="row" class="dash-name"><div>${esc((items[r.code] || {}).name || r.code)}</div><div class="muted small">${esc(r.code)}</div></th>
      <td>${esc(shortRound(r.m))}</td><td class="num">${formatQty(r.p)}</td><td class="num">${formatQty(r.i)}</td><td class="num">${formatInt(Math.round(r.baht))}</td></tr>`).join("")}</tbody></table></div>` : ""}</div>`;
}
