// Tab 15 card 3 (admin only, 2ai; functions/API.md §5.7) — "ล็อกรายการ": a locked item takes no requested qty (OP/PP) from round
// from_month on, for every PCU except the ones the admin released (per PCU, kept until taken back). The PCU sees a 🔒 note on the row
// and a combined home-page notice for 3 rounds from from_month. Admin keying (tab1 คีย์/แก้ใบ) is never locked.
import { el, escapeHtml, toast, errMessage, confirmDialog, formDialog, formatBangkokDateTime, tableScroll } from "./util.js";
import { formatMonthKeyThai } from "../format.js";

const MAX_RESULTS = 50;
const plusMonths = (m, n) => {
  const [y, mo] = m.split("-").map(Number);
  const k = y * 12 + (mo - 1) + n;
  return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;
};

export function mountLockCard(container, ctx) {
  const { state } = ctx;
  const cat = state.cat;
  const pcus = (state.bootstrap && state.bootstrap.pcus) || [];
  const pcuName = (code) => { const p = pcus.find((x) => x.code === code); return p ? p.name : code; };
  let locks = [], curRound = null, search = "";

  const card = el("div", { class: "admin-card", id: "t15-locks" });
  container.appendChild(card);
  card.appendChild(el("h2", {}, "ล็อกรายการ (งดขอเบิก)"));
  card.appendChild(el("p", { class: "admin-note" },
    "รายการที่ล็อก: รพ.สต. กรอกยอดขอ (OP/PP) ไม่ได้ตั้งแต่รอบที่เลือก — คงเหลือ/ใช้ไปยังกรอกได้ · รพ.สต. เห็นข้อความ \"ติดต่อ admin\" ที่แถว และประกาศรวมบนหน้าแรก 3 รอบ"
    + " · ปลดล็อกให้ รพ.สต. รายแห่งได้ (ปลดถาวรจนกว่าจะกดล็อกคืน) · admin คีย์ใบแทนได้เสมอ"));
  const list = el("div", { id: "t15-lock-list" });
  card.appendChild(list);
  card.appendChild(el("h3", {}, "ล็อกรายการเพิ่ม"));
  const searchIn = el("input", { type: "search", class: "search-input", id: "t15-lock-search", placeholder: "ค้นหารหัส/ชื่อรายการ", autocomplete: "off" });
  card.appendChild(el("div", { class: "admin-toolbar" }, [searchIn]));
  const results = el("div", { id: "t15-lock-results" });
  card.appendChild(results);
  searchIn.addEventListener("input", () => { search = searchIn.value; renderResults(); });

  const itemOf = (code) => cat.byCode[code] || null;
  const lockOf = (code) => locks.find((l) => l.code === code) || null;

  function renderList() {
    if (!locks.length) { list.innerHTML = `<p class="muted" id="t15-lock-empty">ยังไม่มีรายการที่ล็อก</p>`; return; }
    const rows = locks.map((l) => {
      const it = itemOf(l.code);
      const ex = l.exempt.length
        ? l.exempt.map((e) => `<span class="badge badge-success" title="${escapeHtml(formatBangkokDateTime(e.set_at))}">${escapeHtml(pcuName(e.pcu))}
            <button type="button" class="btn btn-link btn-sm" data-unexempt="${escapeHtml(l.code)}" data-pcu="${escapeHtml(e.pcu)}">ล็อกคืน</button></span>`).join(" ")
        : `<span class="muted small">–</span>`;
      return `<tr data-code="${escapeHtml(l.code)}">
        <td class="left"><span class="code-cell">${escapeHtml(l.code)}</span> ${escapeHtml(it ? it.name : "(ไม่อยู่ในแบบฟอร์มปีนี้)")}</td>
        <td class="left">${escapeHtml(formatMonthKeyThai(l.from_month))}</td>
        <td class="left">${escapeHtml(l.note || "")}</td>
        <td class="left">${ex}</td>
        <td class="left small muted">${escapeHtml(formatBangkokDateTime(l.set_at))}<br>${escapeHtml(l.set_by === "backup" ? "รหัสสำรอง" : l.set_by || "")}</td>
        <td class="left"><button type="button" class="btn btn-link" data-exempt="${escapeHtml(l.code)}">ปลดให้ รพ.สต.</button>
          <button type="button" class="btn btn-link" data-ledit="${escapeHtml(l.code)}">แก้</button>
          <button type="button" class="btn btn-link" data-lclear="${escapeHtml(l.code)}">เลิกล็อก</button></td></tr>`;
    }).join("");
    list.innerHTML = `<h3>รายการที่ล็อกอยู่ (${locks.length})</h3>` + tableScroll(`<table class="admin-table" id="t15-lock-tbl">
      <thead><tr><th class="left">รายการ</th><th class="left">ล็อกตั้งแต่รอบ</th><th class="left">หมายเหตุ</th><th class="left">ปลดให้แล้ว</th><th class="left">ตั้งเมื่อ / โดย</th><th class="left"></th></tr></thead>
      <tbody>${rows}</tbody></table>`);
    list.querySelectorAll("[data-ledit]").forEach((b) => b.addEventListener("click", () => editLock(b.dataset.ledit)));
    list.querySelectorAll("[data-lclear]").forEach((b) => b.addEventListener("click", () => clearLock(b.dataset.lclear)));
    list.querySelectorAll("[data-exempt]").forEach((b) => b.addEventListener("click", () => addExempt(b.dataset.exempt)));
    list.querySelectorAll("[data-unexempt]").forEach((b) => b.addEventListener("click", () => setExempt(b.dataset.unexempt, b.dataset.pcu, false)));
  }

  function renderResults() {
    const f = search.trim().toLowerCase();
    if (!f) { results.innerHTML = `<p class="muted small">พิมพ์รหัสหรือชื่อรายการเพื่อค้นหา</p>`; return; }
    const items = cat.items.filter((it) => it.active && (it.code.toLowerCase().includes(f) || it.name.toLowerCase().includes(f)));
    if (!items.length) { results.innerHTML = `<p class="muted small">ไม่พบรายการ</p>`; return; }
    const rows = items.slice(0, MAX_RESULTS).map((it) => {
      const lk = lockOf(it.code);
      return `<tr data-code="${escapeHtml(it.code)}"><td class="left"><span class="code-cell">${escapeHtml(it.code)}</span> ${escapeHtml(it.name)}${it.unit ? ` <span class="muted small">(${escapeHtml(it.unit)})</span>` : ""}</td>
        <td class="left">${lk ? `<span class="badge badge-warn">ล็อกตั้งแต่ ${escapeHtml(formatMonthKeyThai(lk.from_month))}</span>` : ""}</td>
        <td class="left"><button type="button" class="btn btn-secondary btn-sm" data-lset="${escapeHtml(it.code)}">${lk ? "แก้ล็อก" : "ล็อก"}</button></td></tr>`;
    }).join("");
    results.innerHTML = (items.length > MAX_RESULTS ? `<p class="muted small">แสดง ${MAX_RESULTS} จาก ${items.length} รายการ — พิมพ์ให้เจาะจงขึ้น</p>` : "")
      + tableScroll(`<table class="admin-table" id="t15-lock-result-tbl"><tbody>${rows}</tbody></table>`);
    results.querySelectorAll("[data-lset]").forEach((b) => b.addEventListener("click", () => editLock(b.dataset.lset)));
  }

  async function editLock(code) {
    const it = itemOf(code);
    const cur = lockOf(code);
    const base = curRound || plusMonths(new Date().toISOString().slice(0, 7), 1);
    const months = [];
    for (let i = 0; i < 12; i++) months.push(plusMonths(base, i));
    if (cur && !months.includes(cur.from_month)) months.unshift(cur.from_month);
    const v = await formDialog(`ล็อกรายการ ${code}${it ? " — " + it.name : ""}`, [
      { key: "from_month", label: "ล็อกตั้งแต่รอบขอเบิก", type: "select", value: cur ? cur.from_month : plusMonths(base, 1),
        options: months.map((m) => ({ value: m, label: `${formatMonthKeyThai(m)}${m === base ? " (รอบที่เปิดกรอกตอนนี้)" : ""}` })) },
      { key: "note", label: "หมายเหตุถึง รพ.สต. (ถ้ามี)", maxlength: 200, value: cur ? cur.note || "" : "", placeholder: "เช่น ใช้รายการ … แทน" },
    ], { okText: "บันทึกล็อก", intro: "รพ.สต. ที่กรอกยอดขอไว้แล้วในรอบนั้น ยอดเดิมยังอยู่ (ลดได้ เพิ่มไม่ได้) — admin แก้ให้ได้ในคีย์/แก้ใบ" });
    if (!v) return;
    try {
      await ctx.adminCall("adminItemLockSet", { code, from_month: v.from_month, note: v.note || null });
      toast("บันทึกล็อกแล้ว");
      await load();
    } catch (e) { toast(errMessage(e), "err"); }
  }

  async function clearLock(code) {
    const it = itemOf(code);
    if (!(await confirmDialog(`เลิกล็อก ${code}${it ? " — " + it.name : ""}? (รพ.สต. ทุกแห่งขอได้ตามปกติ · รายการปลดราย รพ.สต. ถูกล้างด้วย)`, { title: "เลิกล็อก", okText: "เลิกล็อก" }))) return;
    try {
      await ctx.adminCall("adminItemLockClear", { code });
      toast("เลิกล็อกแล้ว");
      await load();
    } catch (e) { toast(errMessage(e), "err"); }
  }

  async function addExempt(code) {
    const lk = lockOf(code);
    const done = new Set(lk ? lk.exempt.map((e) => e.pcu) : []);
    const opts = pcus.filter((p) => !done.has(p.code)).map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }));
    if (!opts.length) { toast("ปลดให้ครบทุกแห่งแล้ว"); return; }
    const v = await formDialog(`ปลดล็อก ${code} ให้ รพ.สต.`, [
      { key: "pcu", label: "รพ.สต.", type: "select", options: opts, value: opts[0].value },
    ], { okText: "ปลดล็อก", intro: "ปลดถาวรจนกว่าจะกด \"ล็อกคืน\"" });
    if (!v) return;
    await setExempt(code, v.pcu, true);
  }

  async function setExempt(code, pcu, exempt) {
    try {
      await ctx.adminCall("adminItemLockExempt", { code, pcu, exempt });
      toast(exempt ? `ปลดล็อกให้ ${pcuName(pcu)} แล้ว` : `ล็อกคืน ${pcuName(pcu)} แล้ว`);
      await load();
    } catch (e) { toast(errMessage(e), "err"); }
  }

  async function load() {
    try {
      const d = await ctx.adminCall("adminItemLockList", {});
      locks = d.locks; curRound = d.current_round;
    } catch (e) {
      list.innerHTML = `<p class="admin-err-text">โหลดรายการล็อกไม่สำเร็จ: ${escapeHtml(errMessage(e))}</p>`;
      return;
    }
    renderList();
    renderResults();
  }

  renderResults();
  return { load };
}
