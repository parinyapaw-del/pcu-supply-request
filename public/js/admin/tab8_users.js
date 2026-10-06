// Tab 8 — ผู้ใช้ (phase 2.md §5.1, functions/API.md §5: adminUsersList / adminUsersAdd / adminUsersRemove).
import { DISPENSE_UNITS } from "./compute.js";
import { el, escapeHtml, tableScroll, toast, errMessage, confirmDialog, formatBangkokDateTime } from "./util.js";

export function renderTab8(container, ctx) {
  const { state } = ctx;
  container.innerHTML = "";
  const ts = { users: state.bootstrap.users || [], source: state.bootstrap.users_source || "table" };

  const listCard = el("div", { class: "admin-card", id: "t8-list-card" });
  const addCard = el("div", { class: "admin-card", id: "t8-add-card" });
  container.appendChild(listCard);
  container.appendChild(addCard);

  addCard.appendChild(el("h2", {}, "เพิ่ม / แก้ผู้ใช้"));
  addCard.appendChild(el("p", { class: "admin-note" }, "admin = ทำได้ทุกอย่าง · ผู้จ่าย (dispenser) = ดูสถานะรอบ ยอดรวม/ใบจัดของ และ Excel เฉพาะหน่วยที่เลือก · ใส่อีเมลที่มีอยู่แล้วเพื่อแก้ role/หน่วย"));
  const email = el("input", { type: "email", id: "t8-email", placeholder: "name@example.com", autocomplete: "off" });
  const role = el("select", { class: "select-input", id: "t8-role" }, [el("option", { value: "dispenser" }, "ผู้จ่าย (dispenser)"), el("option", { value: "admin" }, "admin")]);
  const unitsBox = el("div", { class: "unit-checks", id: "t8-units" });
  const unitCbs = DISPENSE_UNITS.map((u) => {
    const cb = el("input", { type: "checkbox", value: u });
    unitsBox.appendChild(el("label", { class: "admin-inline-check" }, [cb, u]));
    return cb;
  });
  const addBtn = el("button", { type: "button", class: "btn btn-primary", id: "t8-add" }, "เพิ่ม / บันทึก");
  const msg = el("p", { class: "admin-err-text", id: "t8-msg", style: "display:none" });
  addCard.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, "อีเมล (Google)"), email]));
  addCard.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, "บทบาท"), role]));
  const unitsWrap = el("div", { class: "admin-form-field" }, [el("span", {}, "หน่วยจ่าย (สำหรับผู้จ่าย)"), unitsBox]);
  addCard.appendChild(unitsWrap);
  addCard.appendChild(addBtn);
  addCard.appendChild(msg);
  role.addEventListener("change", () => { unitsWrap.style.display = role.value === "dispenser" ? "" : "none"; });

  function showMsg(text, ok) {
    msg.textContent = text; msg.className = ok ? "admin-ok-text" : "admin-err-text"; msg.style.display = text ? "" : "none";
  }

  addBtn.addEventListener("click", async () => {
    showMsg("");
    const em = email.value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { showMsg("กรุณากรอกอีเมลให้ถูกต้อง"); return; }
    const units = role.value === "dispenser" ? unitCbs.filter((c) => c.checked).map((c) => c.value) : [];
    if (role.value === "dispenser" && !units.length) { showMsg("เลือกหน่วยจ่ายอย่างน้อย 1 หน่วย"); return; }
    addBtn.disabled = true;
    try {
      const res = await ctx.adminCall("adminUsersAdd", { email: em, role: role.value, units });
      ts.users = res.users; ts.source = "table";
      state.bootstrap.users = res.users; state.bootstrap.users_source = "table";
      email.value = ""; unitCbs.forEach((c) => { c.checked = false; });
      toast("บันทึกผู้ใช้แล้ว");
      drawList();
    } catch (err) { showMsg(errMessage(err)); } finally { addBtn.disabled = false; }
  });

  function drawList() {
    listCard.innerHTML = "";
    listCard.appendChild(el("h2", {}, "ผู้ใช้ที่เข้าหน้านี้ได้"));
    listCard.appendChild(el("p", { class: "admin-note", id: "t8-source" },
      ts.source === "env"
        ? "แหล่งข้อมูล: ค่าตั้งค่าเซิร์ฟเวอร์ (ADMIN_EMAILS) — เมื่อเพิ่ม/ถอดผู้ใช้ครั้งแรก ระบบจะย้ายเข้าตารางผู้ใช้"
        : "แหล่งข้อมูล: ตารางผู้ใช้ในระบบ · รหัสสำรอง = admin เสมอ"));
    const rows = ts.users.map((u) => `<tr data-email="${escapeHtml(u.email)}">
      <td class="left">${escapeHtml(u.email)}</td>
      <td class="left"><span class="badge ${u.role === "admin" ? "badge-success" : "badge-warn"}">${u.role === "admin" ? "admin" : "ผู้จ่าย"}</span></td>
      <td class="left">${u.role === "admin" ? '<span class="muted">ทุกหน่วย</span>' : escapeHtml((u.units || []).join(", "))}</td>
      <td class="left small">${escapeHtml(u.added_by || "")}${u.added_at ? "<br>" + escapeHtml(formatBangkokDateTime(u.added_at)) : ""}</td>
      <td class="left"><button type="button" class="btn btn-secondary btn-sm" data-remove>ถอด</button></td></tr>`).join("");
    listCard.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table" id="t8-tbl"><thead><tr><th class="left">อีเมล</th><th class="left">บทบาท</th><th class="left">หน่วยจ่าย</th><th class="left">เพิ่มโดย</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="left muted">ไม่มีผู้ใช้</td></tr>'}</tbody></table>`));
    listCard.querySelectorAll("tr[data-email]").forEach((tr) => {
      tr.querySelector("[data-remove]").addEventListener("click", async () => {
        const em = tr.dataset.email;
        const ok = await confirmDialog(`ถอดสิทธิ์ ${em} ?\nผู้ใช้นี้จะเข้าหน้านี้ไม่ได้อีก`, { title: "ถอดผู้ใช้", okText: "ถอด", danger: true });
        if (!ok) return;
        try {
          const res = await ctx.adminCall("adminUsersRemove", { email: em });
          ts.users = res.users; ts.source = "table";
          state.bootstrap.users = res.users; state.bootstrap.users_source = "table";
          toast("ถอดผู้ใช้แล้ว");
          drawList();
        } catch (err) { toast(errMessage(err), "err"); }
      });
    });
  }

  async function reload() {
    try {
      const res = await ctx.adminCall("adminUsersList", {});
      ts.users = res.users; ts.source = res.source;
    } catch (err) { /* keep the bootstrap copy */ }
    drawList();
  }
  role.dispatchEvent(new Event("change"));
  drawList();
  return { onShow() { reload(); } };
}
