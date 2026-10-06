// Settings page (#/hidden): "รายการที่ไม่เบิก" — per-PCU, stored on the server (spec §3.3).
import { call, getPcuToken } from "../api.js";
import { loadFormData } from "../data.js";

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function renderHidden(container, app) {
  app.form = app.form || (await loadFormData());
  const never68 = new Set(app.boot.never68 || []);
  let working = new Set(app.boot.hidden || []);
  const initial = new Set(working);

  const box = document.createElement("div");
  box.className = "hidden-page";

  const groupsHtml = app.form.steps
    .map((step) => {
      const items = step.rows.filter((r) => r.type === "item");
      return `
      <section class="hidden-group">
        <h3>${esc(step.title)} <span class="muted">(${esc(step.code)})</span></h3>
        ${items
          .map(
            (item) => `
          <label class="hidden-item-check">
            <input type="checkbox" data-code="${item.code}" ${working.has(item.code) ? "checked" : ""}>
            <span>${esc(item.name)}${never68.has(item.code) ? ' <span class="tag-sim">(ปี 68 ไม่เคยเบิก)</span>' : ""}</span>
          </label>`
          )
          .join("")}
      </section>`;
    })
    .join("");

  box.innerHTML = `
    <h2>ตั้งค่ารายการที่ไม่เบิก</h2>
    <p class="muted">
      รายการที่ติ๊กจะไม่ขึ้นตอนกรอก และไม่ต้องกรอกคงเหลือ แต่ยังพิมพ์ในใบเบิก (ช่องว่าง)
    </p>
    <div class="hidden-bulk-actions">
      <button type="button" class="btn btn-secondary" id="btn-never68">
        ซ่อนรายการที่ปี 68 ไม่เคยเบิก (${never68.size} รายการ)
      </button>
      <button type="button" class="btn btn-secondary" id="btn-clear-all">ล้างทั้งหมด</button>
      <span class="muted" id="hidden-count"></span>
    </div>
    <div class="hidden-groups">${groupsHtml}</div>
    <div class="save-bar sticky-totals no-print">
      <span id="hidden-save-msg" class="muted"></span>
      <button type="button" class="btn btn-secondary" id="btn-cancel">ยกเลิก / กลับ</button>
      <button type="button" class="btn btn-primary" id="btn-save-hidden">บันทึก</button>
    </div>
  `;

  container.innerHTML = "";
  container.appendChild(box);

  function updateCount() {
    box.querySelector("#hidden-count").textContent = `ติ๊กไว้ ${working.size} รายการ`;
  }
  updateCount();

  box.querySelectorAll("input[data-code]").forEach((chk) => {
    chk.addEventListener("change", () => {
      if (chk.checked) working.add(chk.dataset.code);
      else working.delete(chk.dataset.code);
      updateCount();
    });
  });

  box.querySelector("#btn-never68").addEventListener("click", () => {
    never68.forEach((code) => {
      working.add(code);
      const el = box.querySelector(`input[data-code="${code}"]`);
      if (el) el.checked = true;
    });
    updateCount();
  });

  box.querySelector("#btn-clear-all").addEventListener("click", () => {
    working = new Set();
    box.querySelectorAll("input[data-code]").forEach((chk) => (chk.checked = false));
    updateCount();
  });

  box.querySelector("#btn-cancel").addEventListener("click", () => {
    location.hash = "#/home";
  });

  const saveMsg = box.querySelector("#hidden-save-msg");
  const saveBtn = box.querySelector("#btn-save-hidden");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveMsg.textContent = "กำลังบันทึก...";
    try {
      const data = await call("setHidden", { codes: Array.from(working) }, { token: getPcuToken() });
      app.boot.hidden = data.hidden;
      initial.clear();
      data.hidden.forEach((c) => initial.add(c));
      saveMsg.textContent = "บันทึกแล้ว";
      setTimeout(() => {
        location.hash = "#/home";
      }, 400);
    } catch (err) {
      saveMsg.textContent = "บันทึกไม่สำเร็จ: " + (err.message || "");
    } finally {
      saveBtn.disabled = false;
    }
  });
}
