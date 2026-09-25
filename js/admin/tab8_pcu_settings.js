// Tab 8 — ตั้งค่า รพ.สต. (PIN + รายการที่ไม่เบิก) — phase 1.5.md §4 item 8.
import { escapeHtml, tableScroll, el, openModal, formatBangkokDateTime } from "./util.js";
import { STEP_CODES } from "./compute.js";

export function renderTab8(container, ctx) {
  const { state } = ctx;
  draw();

  function draw() {
    container.innerHTML = "";
    const rows = state.bootstrap.pcus.map((pcu) => {
      const locked = pcu.pin_locked_until && new Date(pcu.pin_locked_until).getTime() > Date.now();
      const hiddenCount = (state.bootstrap.hidden[pcu.code] || []).length;
      return `<tr data-pcu="${pcu.code}">
        <td class="left">${pcu.code}</td>
        <td class="left">${escapeHtml(pcu.name)}${pcu.group === "พิเศษ" ? ' <span class="pcu-group-tag">(พิเศษ)</span>' : ""}</td>
        <td class="left">${locked ? `<span class="badge badge-danger">ล็อกถึง ${escapeHtml(formatBangkokDateTime(pcu.pin_locked_until))}</span>` : `<span class="badge badge-muted">ไม่ถูกล็อก</span>`} <span class="muted">(ผิด ${pcu.pin_fail || 0} ครั้ง)</span></td>
        <td class="left">
          <button type="button" class="btn btn-secondary btn-sm" data-act="unlock" ${locked || pcu.pin_fail ? "" : "disabled"}>ปลดล็อก</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="pin">เปลี่ยน PIN</button>
          <button type="button" class="btn btn-secondary btn-sm" data-act="hidden">รายการที่ไม่เบิก (${hiddenCount})</button>
        </td>
      </tr>`;
    }).join("");

    const tableHost = document.createElement("div");
    tableHost.innerHTML = tableScroll(`<table class="admin-table">
      <thead><tr><th class="left">รหัส</th><th class="left">รพ.สต.</th><th class="left">สถานะ PIN</th><th class="left">การดำเนินการ</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`);
    container.appendChild(tableHost);

    tableHost.querySelectorAll("tr[data-pcu]").forEach((tr) => {
      const pcu = tr.dataset.pcu;
      tr.querySelector('[data-act="unlock"]').addEventListener("click", () => doUnlock(pcu));
      tr.querySelector('[data-act="pin"]').addEventListener("click", () => openPinModal(pcu));
      tr.querySelector('[data-act="hidden"]').addEventListener("click", () => openHiddenModal(pcu));
    });
  }

  async function doUnlock(pcu) {
    try {
      await ctx.adminCall("adminUnlockPin", { pcu });
      const row = state.bootstrap.pcus.find((p) => p.code === pcu);
      if (row) { row.pin_fail = 0; row.pin_locked_until = null; }
      draw();
    } catch (err) {
      alert("ปลดล็อกไม่สำเร็จ: " + (err.message || err));
    }
  }

  function openPinModal(pcu) {
    const body = el("div");
    body.appendChild(el("p", {}, `ตั้ง PIN ใหม่ 5 หลักสำหรับ ${pcu}`));
    const p1 = el("input", { type: "text", inputmode: "numeric", maxlength: "5", placeholder: "PIN ใหม่ (5 หลัก)" });
    const p2 = el("input", { type: "text", inputmode: "numeric", maxlength: "5", placeholder: "ยืนยัน PIN อีกครั้ง" });
    const err = el("p", { class: "admin-err-text", style: "display:none" });
    body.appendChild(el("div", { class: "field-row" }, p1));
    body.appendChild(el("div", { class: "field-row" }, p2));
    body.appendChild(err);
    const actions = el("div", { class: "admin-modal-actions" });
    const cancelBtn = el("button", { type: "button", class: "btn btn-secondary" }, "ยกเลิก");
    const saveBtn = el("button", { type: "button", class: "btn btn-primary" }, "บันทึก");
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);
    body.appendChild(actions);

    const { close } = openModal(`เปลี่ยน PIN — ${pcu}`, body);
    cancelBtn.addEventListener("click", close);
    saveBtn.addEventListener("click", async () => {
      err.style.display = "none";
      if (!/^[0-9]{5}$/.test(p1.value)) { err.textContent = "PIN ต้องเป็นเลข 5 หลัก"; err.style.display = ""; return; }
      if (p1.value !== p2.value) { err.textContent = "PIN ทั้งสองช่องไม่ตรงกัน"; err.style.display = ""; return; }
      saveBtn.disabled = true;
      try {
        await ctx.adminCall("adminSetPin", { pcu, pin: p1.value });
        close();
        alert(`ตั้ง PIN ใหม่สำหรับ ${pcu} สำเร็จ`);
      } catch (e) {
        err.textContent = e.message || "บันทึกไม่สำเร็จ"; err.style.display = "";
        saveBtn.disabled = false;
      }
    });
  }

  function openHiddenModal(pcu) {
    const current = new Set(state.bootstrap.hidden[pcu] || []);
    const body = el("div");
    body.appendChild(el("p", { class: "muted" }, `รายการที่ ${pcu} ตั้งไว้ว่า "ไม่เบิก" — ไม่ต้องกรอกคงเหลือ แต่ใบพิมพ์ยังมีแถว (ว่าง)`));
    const grid = el("div", { class: "hidden-editor-grid" });
    const checkboxes = [];
    STEP_CODES.forEach((step) => {
      const stepItems = state.items.filter((it) => it.step === step);
      if (!stepItems.length) return;
      grid.appendChild(el("div", { class: "hidden-editor-step" }, step));
      stepItems.forEach((item) => {
        const row = el("label", { class: "hidden-editor-row" });
        const cb = el("input", { type: "checkbox" });
        cb.checked = current.has(item.code);
        cb.dataset.code = item.code;
        checkboxes.push(cb);
        row.appendChild(cb);
        row.appendChild(document.createTextNode(`${item.name} (${item.code})`));
        grid.appendChild(row);
      });
    });
    body.appendChild(grid);
    const err = el("p", { class: "admin-err-text", style: "display:none" });
    body.appendChild(err);
    const actions = el("div", { class: "admin-modal-actions" });
    const cancelBtn = el("button", { type: "button", class: "btn btn-secondary" }, "ยกเลิก");
    const saveBtn = el("button", { type: "button", class: "btn btn-primary" }, "บันทึก");
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);
    body.appendChild(actions);

    const { close } = openModal(`รายการที่ไม่เบิก — ${pcu}`, body);
    cancelBtn.addEventListener("click", close);
    saveBtn.addEventListener("click", async () => {
      const codes = checkboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.code);
      saveBtn.disabled = true;
      try {
        const data = await ctx.adminCall("adminSetHidden", { pcu, codes });
        state.bootstrap.hidden[pcu] = data.hidden;
        close();
        draw();
      } catch (e) {
        err.textContent = e.message || "บันทึกไม่สำเร็จ"; err.style.display = "";
        saveBtn.disabled = false;
      }
    });
  }
}
