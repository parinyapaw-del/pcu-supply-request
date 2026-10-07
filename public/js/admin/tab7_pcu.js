// Tab 7 — รพ.สต. (PIN / รายการที่ซ่อน), admin only (functions/API.md §5: adminSetPin, adminUnlockPin, adminSetHidden).
import {
  el, escapeHtml, tableScroll, toast, errMessage, confirmDialog, formDialog, openModal, formatBangkokDateTime, realPcus, pcuTag, TRIAL_GROUP
} from "./util.js";

export function renderTab7(container, ctx) {
  const { state } = ctx;
  const b = () => state.bootstrap;
  container.innerHTML = "";
  const intro = el("p", { class: "admin-note" }, "ตั้ง PIN ของแต่ละแห่งก่อนแจก (PIN ตั้งต้น 12345 ใช้กับทุกแห่งที่ยังไม่เปลี่ยน) · การเปลี่ยน PIN ทำให้ผู้ที่ล็อกอินค้างอยู่ต้องเข้าใหม่ · แห่งกลุ่ม ทดลอง ไม่ถูกนับในยอดรวม/งบ/Excel");
  const warn = el("div", { class: "admin-card warn-card", id: "t7-warn", style: "display:none" });
  const host = el("div", { id: "t7-host" });
  const addBtn = el("button", { type: "button", class: "btn btn-primary btn-sm", id: "t7-add" }, "เพิ่ม รพ.สต.");
  addBtn.addEventListener("click", () => addPcu());
  container.appendChild(intro);
  container.appendChild(el("div", { class: "admin-toolbar" }, addBtn));
  container.appendChild(warn);
  container.appendChild(host);

  function isLocked(p) { return p.pin_locked_until && new Date(p.pin_locked_until).getTime() > Date.now(); }

  function draw() {
    const pcus = b().pcus;
    const real = realPcus(pcus); // 2n: trial PCUs are not part of the warnings
    const defaults = real.filter((p) => !p.pin_custom);
    const neverIn = real.filter((p) => !(p.login_count > 0));
    const warnLines = [];
    if (defaults.length) warnLines.push(`<div><strong>ยังใช้ PIN ตั้งต้น 12345:</strong> ${defaults.length} แห่ง (${defaults.map((p) => escapeHtml(p.name)).join(", ")}) — ควรตั้ง PIN เฉพาะแห่งก่อนแจก</div>`);
    if (neverIn.length) warnLines.push(`<div><strong>ยังไม่เคยเข้าใช้:</strong> ${neverIn.length} แห่ง (${neverIn.map((p) => escapeHtml(p.name)).join(", ")})</div>`);
    warn.style.display = warnLines.length ? "" : "none";
    warn.innerHTML = warnLines.join("");
    const hiddenMap = b().hidden || {};
    const rows = pcus.map((p) => {
      const nHidden = (hiddenMap[p.code] || []).length;
      const locked = isLocked(p);
      return `<tr data-pcu="${p.code}">
        <td class="left"><strong>${p.code}</strong> ${escapeHtml(p.name)}${pcuTag(p)}</td>
        <td class="left">${p.pin_custom ? '<span class="badge badge-success">ตั้ง PIN แล้ว</span>' : '<span class="badge badge-warn" title="ยังใช้ PIN ตั้งต้น 12345">ยังใช้ PIN ตั้งต้น 12345</span>'}</td>
        <td class="left">${locked ? `<span class="badge badge-danger">ล็อก ถึง ${escapeHtml(formatBangkokDateTime(p.pin_locked_until))}</span>` : (p.pin_fail > 0 ? `<span class="badge badge-warn">กรอกผิด ${p.pin_fail} ครั้ง</span>` : '<span class="muted">ปกติ</span>')}</td>
        <td class="left">${(p.login_count || 0) > 0 ? `<strong>${p.login_count}</strong> ครั้ง · ล่าสุด ${escapeHtml(formatBangkokDateTime(p.last_login_at))}` : '<span class="badge badge-muted">ยังไม่เคยเข้า</span>'}</td>
        <td class="num">${nHidden}</td>
        <td class="left actions-cell">
          <button type="button" class="btn btn-secondary btn-sm" data-act="edit">แก้ชื่อ</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="pin">ตั้ง PIN</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="unlock" ${locked || p.pin_fail > 0 ? "" : "disabled"}>ปลดล็อก PIN</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="hidden">รายการที่ซ่อน</button>
        </td></tr>`;
    }).join("");
    host.innerHTML = tableScroll(`<table class="admin-table admin-table-wide" id="t7-tbl"><thead><tr><th class="left">รพ.สต.</th><th class="left">PIN</th><th class="left">สถานะการล็อก</th><th class="left">เข้าใช้ (PIN)</th><th class="num">รายการที่ซ่อน</th><th class="left">การดำเนินการ</th></tr></thead><tbody>${rows}</tbody></table>`);
    host.querySelectorAll("tr[data-pcu]").forEach((tr) => {
      const code = tr.dataset.pcu;
      tr.querySelector('[data-act="edit"]').addEventListener("click", () => editPcu(code));
      tr.querySelector('[data-act="pin"]').addEventListener("click", () => setPin(code));
      tr.querySelector('[data-act="unlock"]').addEventListener("click", () => unlockPin(code));
      tr.querySelector('[data-act="hidden"]').addEventListener("click", () => editHidden(code));
    });
  }

  async function reloadPcus() {
    await ctx.refreshBootstrap();
    draw();
  }

  const GROUP_OPTIONS = [{ value: "ทั่วไป", label: "ทั่วไป" }, { value: "พิเศษ", label: "พิเศษ" }, { value: TRIAL_GROUP, label: "ทดลอง (ไม่นับในยอดรวม/งบ/Excel)" }];
  const nameFields = (p) => [
    { key: "name", label: "ชื่อ รพ.สต.", type: "text", required: true, maxlength: 60, value: p ? p.name : "" },
    { key: "print_name", label: "ชื่อในใบพิมพ์ (ไม่บังคับ)", type: "text", maxlength: 80, value: p ? (p.print_name || "") : "" },
    { key: "group", label: "กลุ่ม", type: "select", options: GROUP_OPTIONS, value: p ? (p.group || "ทั่วไป") : "ทั่วไป" }
  ];

  async function addPcu() {
    const res = await formDialog("เพิ่ม รพ.สต.", [
      { key: "code", label: "รหัส", type: "text", required: true, maxlength: 12, placeholder: "PCU00" },
      ...nameFields(null)
    ], {
      okText: "เพิ่ม",
      intro: "แห่งใหม่ใช้ PIN ตั้งต้น 12345 · ชื่อในใบพิมพ์ว่าง = ใช้ชื่อเดียวกับชื่อ รพ.สต. · รหัสแก้ภายหลังไม่ได้",
      validate: (v) => (/^[A-Z0-9][A-Z0-9_-]{1,11}$/i.test(v.code) ? "" : "รหัสต้องเป็น A–Z/0–9/_/- ยาว 2–12 ตัว (เช่น PCU00)")
    });
    if (!res) return;
    try {
      const out = await ctx.adminCall("adminPcuAdd", { code: res.code.toUpperCase(), name: res.name, print_name: res.print_name, group: res.group });
      toast(`เพิ่ม ${out.pcu.code} ${out.pcu.name} แล้ว (PIN ตั้งต้น 12345)`);
      await reloadPcus();
    } catch (err) { toast(errMessage(err), "err"); }
  }

  async function editPcu(code) {
    const p = b().pcus.find((x) => x.code === code);
    if (!p) return;
    const res = await formDialog(`แก้ไข ${code}`, nameFields(p), { okText: "บันทึก", intro: "ชื่อในใบพิมพ์ว่าง = ใช้ชื่อเดียวกับชื่อ รพ.สต. · รหัสแก้ไม่ได้" });
    if (!res) return;
    try {
      await ctx.adminCall("adminPcuEdit", { code, name: res.name, print_name: res.print_name, group: res.group });
      toast(`บันทึกข้อมูล ${code} แล้ว`);
      await reloadPcus();
    } catch (err) { toast(errMessage(err), "err"); }
  }

  async function setPin(code) {
    const p = b().pcus.find((x) => x.code === code);
    const res = await formDialog(`ตั้ง PIN — ${code} ${p.name}`, [
      { key: "pin", label: "PIN ใหม่ (ตัวเลข 5 หลัก)", type: "text", required: true, maxlength: 5, inputmode: "numeric", placeholder: "00000" }
    ], { okText: "ตั้ง PIN", intro: "ผู้ที่ล็อกอินค้างอยู่ของแห่งนี้จะถูกออกจากระบบ", validate: (v) => (/^\d{5}$/.test(v.pin) ? "" : "PIN ต้องเป็นตัวเลข 5 หลัก") });
    if (!res) return;
    try {
      await ctx.adminCall("adminSetPin", { pcu: code, pin: res.pin });
      toast(`ตั้ง PIN ของ ${code} แล้ว`);
      await reloadPcus();
    } catch (err) { toast(errMessage(err), "err"); }
  }

  async function unlockPin(code) {
    try {
      await ctx.adminCall("adminUnlockPin", { pcu: code });
      toast(`ปลดล็อก PIN ของ ${code} แล้ว`);
      await reloadPcus();
    } catch (err) { toast(errMessage(err), "err"); }
  }

  function editHidden(code) {
    const p = b().pcus.find((x) => x.code === code);
    const current = new Set((b().hidden || {})[code] || []);
    const body = el("div");
    body.appendChild(el("p", { class: "admin-note" }, "ติ๊กรายการที่ \"ซ่อน\" (รพ.สต. นี้จะไม่เห็นในใบเบิก)"));
    const grid = el("div", { class: "hidden-editor-grid" });
    const boxes = [];
    state.cat.steps.forEach((s) => {
      const items = state.cat.items.filter((it) => it.stepCode === s.code);
      if (!items.length) return;
      grid.appendChild(el("div", { class: "hidden-editor-step" }, `หน้า ${s.pageNo} — ${s.sheet}`));
      items.forEach((it) => {
        const cb = el("input", { type: "checkbox", value: it.code, checked: current.has(it.code) });
        boxes.push(cb);
        grid.appendChild(el("label", { class: "hidden-editor-row" }, [cb, el("span", {}, `${it.code} ${it.name}`)]));
      });
    });
    body.appendChild(grid);
    const actions = el("div", { class: "admin-modal-actions" });
    const cancel = el("button", { type: "button", class: "btn btn-secondary" }, "ยกเลิก");
    const save = el("button", { type: "button", class: "btn btn-primary", id: "t7-hidden-save" }, "บันทึก");
    actions.appendChild(cancel); actions.appendChild(save);
    body.appendChild(actions);
    const m = openModal(`รายการที่ซ่อน — ${code} ${p.name}`, body);
    cancel.addEventListener("click", m.close);
    save.addEventListener("click", async () => {
      const codes = boxes.filter((c) => c.checked).map((c) => c.value);
      // keep hidden codes that are not in the current form (e.g. retired items) so we never silently un-hide them
      current.forEach((c) => { if (!state.cat.byCode[c]) codes.push(c); });
      save.disabled = true;
      try {
        const res = await ctx.adminCall("adminSetHidden", { pcu: code, codes });
        b().hidden = b().hidden || {};
        b().hidden[code] = res.hidden;
        toast(`บันทึกรายการที่ซ่อนของ ${code} (${res.hidden.length} รายการ)`);
        m.close();
        draw();
      } catch (err) { toast(errMessage(err), "err"); save.disabled = false; }
    });
  }

  draw();
  return { onShow() { reloadPcus().catch(() => {}); } };
}
