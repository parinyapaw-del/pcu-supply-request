// Tab 15 — ของหมด / ประกาศ (2ae; functions/API.md §5.7).
// Card 1 (admin + dispenser): per-item flags "ของหมด" / "รอจัดซื้อ" shown to every PCU on the fill page — never block ordering, cleared by hand.
//   A dispenser edits only items of its own dispense units (the server answers FORBIDDEN otherwise); every flag is listed for everyone.
// Card 2 (admin only): free-text announcements on the PCU home page (optional last day, can be switched off).
// Card 3 (admin only, 2ai): item locks — tab15_locks.js.
import { el, escapeHtml, toast, errMessage, confirmDialog, formDialog, formatBangkokDateTime, formatDateThai, tableScroll } from "./util.js";
import { DISPENSE_UNITS } from "./compute.js";
import { mountLockCard } from "./tab15_locks.js";

export const FLAG_LABEL = { out: "ของหมด", pending: "รอจัดซื้อ" };
const MAX_RESULTS = 50;

export function renderTab15(container, ctx) {
  const { state } = ctx;
  const myUnits = state.isAdmin ? DISPENSE_UNITS : ((state.me && state.me.units) || []);
  const cat = state.cat;
  let flags = [];
  let anns = [];
  let search = "";

  container.innerHTML = "";
  const flagCard = el("div", { class: "admin-card", id: "t15-flags" });
  container.appendChild(flagCard);
  flagCard.appendChild(el("h2", {}, "ป้ายรายการ: ของหมด / รอจัดซื้อ"));
  flagCard.appendChild(el("p", { class: "admin-note" },
    "รพ.สต. ทุกแห่งจะเห็นป้ายนี้ในหน้ากรอกใบเบิก — ยังสั่งรายการนั้นได้ตามปกติ · ป้ายอยู่จนกว่าจะกด \"เอาป้ายออก\" (เมื่อมีของแล้ว)"
    + (state.isAdmin ? "" : ` · บัญชีนี้ตั้งป้ายได้เฉพาะรายการของหน่วย ${myUnits.join(", ") || "–"}`)));
  const flagList = el("div", { id: "t15-flag-list" });
  flagCard.appendChild(flagList);
  flagCard.appendChild(el("h3", {}, "ติดป้ายรายการ"));
  const searchIn = el("input", { type: "search", class: "search-input", id: "t15-search", placeholder: "ค้นหารหัส/ชื่อรายการ", autocomplete: "off" });
  flagCard.appendChild(el("div", { class: "admin-toolbar" }, [searchIn]));
  const results = el("div", { id: "t15-results" });
  flagCard.appendChild(results);
  searchIn.addEventListener("input", () => { search = searchIn.value; renderResults(); });

  let annCard = null, annList = null;
  if (state.isAdmin) {
    annCard = el("div", { class: "admin-card", id: "t15-ann" });
    container.appendChild(annCard);
    annCard.appendChild(el("h2", {}, "ประกาศหน้าแรก รพ.สต."));
    annCard.appendChild(el("p", { class: "admin-note" }, "ข้อความแสดงบนหน้าหลักของ รพ.สต. ทุกแห่ง (ใหม่สุดอยู่บน) · ใส่วันสุดท้ายที่แสดงได้ (ไม่ใส่ = แสดงจนกว่าจะปิด) · ผู้ใช้กดซ่อนประกาศบนเครื่องตัวเองได้"));
    const addBtn = el("button", { type: "button", class: "btn btn-primary", id: "t15-ann-add" }, "+ เพิ่มประกาศ");
    addBtn.addEventListener("click", () => editAnn(null));
    annCard.appendChild(el("div", { class: "admin-toolbar" }, [addBtn]));
    annList = el("div", { id: "t15-ann-list" });
    annCard.appendChild(annList);
  }
  const lockCard = state.isAdmin ? mountLockCard(container, ctx) : null;

  const canEdit = (unit) => state.isAdmin || (!!unit && myUnits.includes(unit));
  const itemOf = (code) => cat.byCode[code] || null;
  const flagOf = (code) => flags.find((f) => f.code === code) || null;
  const flagBadge = (f) => `<span class="badge ${f.status === "out" ? "badge-warn" : "badge-muted"}">${escapeHtml(FLAG_LABEL[f.status] || f.status)}</span>`;

  // ---------------- flags ----------------
  function renderFlags() {
    if (!flags.length) { flagList.innerHTML = `<p class="muted" id="t15-flag-empty">ยังไม่มีรายการที่ติดป้าย</p>`; return; }
    const rows = flags.map((f) => {
      const it = itemOf(f.code);
      const unit = it ? it.dispenseUnit : "";
      const act = canEdit(unit)
        ? `<button type="button" class="btn btn-link" data-edit="${escapeHtml(f.code)}">แก้</button> <button type="button" class="btn btn-link" data-clear="${escapeHtml(f.code)}">เอาป้ายออก</button>`
        : `<span class="muted small">หน่วย ${escapeHtml(unit || "–")}</span>`;
      return `<tr data-code="${escapeHtml(f.code)}">
        <td class="left"><span class="code-cell">${escapeHtml(f.code)}</span> ${escapeHtml(it ? it.name : "(ไม่อยู่ในแบบฟอร์มปีนี้)")}</td>
        <td class="left">${escapeHtml(unit || "–")}</td>
        <td class="left">${flagBadge(f)}</td>
        <td class="left">${f.eta ? escapeHtml(formatDateThai(f.eta)) : "–"}</td>
        <td class="left">${escapeHtml(f.note || "")}</td>
        <td class="left small muted">${escapeHtml(formatBangkokDateTime(f.set_at))}<br>${escapeHtml(f.set_by === "backup" ? "รหัสสำรอง" : f.set_by || "")}</td>
        <td class="left">${act}</td></tr>`;
    }).join("");
    flagList.innerHTML = `<h3>ป้ายที่ติดอยู่ (${flags.length})</h3>` + tableScroll(`<table class="admin-table" id="t15-flag-tbl">
      <thead><tr><th class="left">รายการ</th><th class="left">หน่วยจ่าย</th><th class="left">ป้าย</th><th class="left">คาดว่าจะมี</th><th class="left">หมายเหตุ</th><th class="left">ตั้งเมื่อ / โดย</th><th class="left"></th></tr></thead>
      <tbody>${rows}</tbody></table>`);
    flagList.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editFlag(b.dataset.edit)));
    flagList.querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => clearFlag(b.dataset.clear)));
  }

  function renderResults() {
    const f = search.trim().toLowerCase();
    if (!f) { results.innerHTML = `<p class="muted small">พิมพ์รหัสหรือชื่อรายการเพื่อค้นหา</p>`; return; }
    const items = cat.items.filter((it) => it.active && myUnits.includes(it.dispenseUnit) && (it.code.toLowerCase().includes(f) || it.name.toLowerCase().includes(f)));
    if (!items.length) { results.innerHTML = `<p class="muted small">ไม่พบรายการ${state.isAdmin ? "" : "ในหน่วยจ่ายของบัญชีนี้"}</p>`; return; }
    const rows = items.slice(0, MAX_RESULTS).map((it) => {
      const fl = flagOf(it.code);
      return `<tr data-code="${escapeHtml(it.code)}"><td class="left"><span class="code-cell">${escapeHtml(it.code)}</span> ${escapeHtml(it.name)}${it.unit ? ` <span class="muted small">(${escapeHtml(it.unit)})</span>` : ""}</td>
        <td class="left">${escapeHtml(it.dispenseUnit)}</td><td class="left">${fl ? flagBadge(fl) : ""}</td>
        <td class="left"><button type="button" class="btn btn-secondary btn-sm" data-set="${escapeHtml(it.code)}">${fl ? "แก้ป้าย" : "ติดป้าย"}</button></td></tr>`;
    }).join("");
    results.innerHTML = (items.length > MAX_RESULTS ? `<p class="muted small">แสดง ${MAX_RESULTS} จาก ${items.length} รายการ — พิมพ์ให้เจาะจงขึ้น</p>` : "")
      + tableScroll(`<table class="admin-table" id="t15-result-tbl"><tbody>${rows}</tbody></table>`);
    results.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => editFlag(b.dataset.set)));
  }

  async function editFlag(code) {
    const it = itemOf(code);
    const cur = flagOf(code);
    const v = await formDialog(`ป้ายรายการ ${code}${it ? " — " + it.name : ""}`, [
      { key: "status", label: "สถานะ", type: "select", options: [{ value: "out", label: "ของหมด" }, { value: "pending", label: "รอจัดซื้อ" }], value: cur ? cur.status : "out" },
      { key: "eta", label: "คาดว่าจะมีของ (ถ้าทราบ)", type: "date", value: cur ? cur.eta || "" : "" },
      { key: "note", label: "หมายเหตุ (ถ้ามี)", maxlength: 200, value: cur ? cur.note || "" : "", placeholder: "เช่น ใช้รายการ … แทนได้" },
    ], { okText: "บันทึกป้าย", intro: "รพ.สต. ยังสั่งรายการนี้ได้ตามปกติ — ป้ายช่วยให้รู้ล่วงหน้า" });
    if (!v) return;
    try {
      await ctx.adminCall("itemFlagSet", { code, status: v.status, eta: v.eta || null, note: v.note || null });
      toast("บันทึกป้ายแล้ว");
      await loadFlags();
    } catch (e) { toast(errMessage(e), "err"); }
  }

  async function clearFlag(code) {
    const it = itemOf(code);
    if (!(await confirmDialog(`เอาป้ายของ ${code}${it ? " — " + it.name : ""} ออก?`, { title: "เอาป้ายออก", okText: "เอาป้ายออก" }))) return;
    try {
      await ctx.adminCall("itemFlagClear", { code });
      toast("เอาป้ายออกแล้ว");
      await loadFlags();
    } catch (e) { toast(errMessage(e), "err"); }
  }

  async function loadFlags() {
    try {
      flags = (await ctx.adminCall("itemFlagList", {})).flags;
    } catch (e) {
      flagList.innerHTML = `<p class="admin-err-text">โหลดป้ายไม่สำเร็จ: ${escapeHtml(errMessage(e))}</p>`;
      return;
    }
    renderFlags();
    renderResults();
  }

  // ---------------- announcements (admin) ----------------
  function annState(a) {
    if (!a.active) return `<span class="badge badge-muted">ปิดอยู่</span>`;
    if (!a.live) return `<span class="badge badge-muted">หมดอายุแล้ว</span>`;
    return `<span class="badge badge-success">แสดงอยู่</span>`;
  }
  function renderAnns() {
    if (!anns.length) { annList.innerHTML = `<p class="muted" id="t15-ann-empty">ยังไม่มีประกาศ</p>`; return; }
    annList.innerHTML = tableScroll(`<table class="admin-table" id="t15-ann-tbl">
      <thead><tr><th class="left">ข้อความ</th><th class="left">แสดงถึง</th><th class="left">สถานะ</th><th class="left">แก้ล่าสุด</th><th class="left"></th></tr></thead>
      <tbody>${anns.map((a) => `<tr data-id="${a.id}">
        <td class="left t15-ann-text">${escapeHtml(a.text)}</td>
        <td class="left">${a.expires_at ? escapeHtml(formatDateThai(a.expires_at)) : "ไม่กำหนด"}</td>
        <td class="left">${annState(a)}</td>
        <td class="left small muted">${escapeHtml(formatBangkokDateTime(a.updated_at))}<br>${escapeHtml(a.updated_by === "backup" ? "รหัสสำรอง" : a.updated_by || "")}</td>
        <td class="left"><button type="button" class="btn btn-link" data-aedit="${a.id}">แก้</button>
          <button type="button" class="btn btn-link" data-atoggle="${a.id}">${a.active ? "ปิด" : "เปิด"}</button>
          <button type="button" class="btn btn-link" data-adel="${a.id}">ลบ</button></td></tr>`).join("")}</tbody></table>`);
    const byId = (id) => anns.find((a) => a.id === Number(id));
    annList.querySelectorAll("[data-aedit]").forEach((b) => b.addEventListener("click", () => editAnn(byId(b.dataset.aedit))));
    annList.querySelectorAll("[data-atoggle]").forEach((b) => b.addEventListener("click", () => toggleAnn(byId(b.dataset.atoggle))));
    annList.querySelectorAll("[data-adel]").forEach((b) => b.addEventListener("click", () => deleteAnn(byId(b.dataset.adel))));
  }

  async function editAnn(a) {
    const v = await formDialog(a ? "แก้ประกาศ" : "เพิ่มประกาศ", [
      { key: "text", label: "ข้อความ", type: "textarea", rows: 4, maxlength: 1000, required: true, value: a ? a.text : "" },
      { key: "expires_at", label: "แสดงถึงวันที่ (ไม่ใส่ = ไม่กำหนด)", type: "date", value: a ? a.expires_at || "" : "" },
    ], { okText: a ? "บันทึก" : "เพิ่มประกาศ" });
    if (!v) return;
    try {
      const params = { text: v.text, expires_at: v.expires_at || null };
      if (a) params.id = a.id;
      await ctx.adminCall("adminAnnouncementSave", params);
      toast(a ? "บันทึกประกาศแล้ว" : "เพิ่มประกาศแล้ว");
      await loadAnns();
    } catch (e) { toast(errMessage(e), "err"); }
  }
  async function toggleAnn(a) {
    if (!a) return;
    try {
      await ctx.adminCall("adminAnnouncementSave", { id: a.id, text: a.text, expires_at: a.expires_at, active: !a.active });
      toast(a.active ? "ปิดประกาศแล้ว" : "เปิดประกาศแล้ว");
      await loadAnns();
    } catch (e) { toast(errMessage(e), "err"); }
  }
  async function deleteAnn(a) {
    if (!a) return;
    if (!(await confirmDialog("ลบประกาศนี้ถาวร? (ถ้าแค่ไม่ต้องการให้แสดง กด \"ปิด\" แทนได้)", { title: "ลบประกาศ", okText: "ลบ", danger: true }))) return;
    try {
      await ctx.adminCall("adminAnnouncementDelete", { id: a.id });
      toast("ลบประกาศแล้ว");
      await loadAnns();
    } catch (e) { toast(errMessage(e), "err"); }
  }
  async function loadAnns() {
    try {
      anns = (await ctx.adminCall("adminAnnouncementList", {})).announcements;
    } catch (e) {
      annList.innerHTML = `<p class="admin-err-text">โหลดประกาศไม่สำเร็จ: ${escapeHtml(errMessage(e))}</p>`;
      return;
    }
    renderAnns();
  }

  renderResults();
  return {
    onShow() { loadFlags(); if (state.isAdmin) { loadAnns(); lockCard.load(); } },
  };
}
