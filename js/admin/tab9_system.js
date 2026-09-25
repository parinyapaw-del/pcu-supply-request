// Tab 9 — ระบบ — phase 1.5.md §4 item 9.
import { el } from "./util.js";

export function renderTab9(container, ctx) {
  const { state } = ctx;
  container.innerHTML = "";
  const isGoogleAdmin = state.bootstrap.me.email !== "backup";

  // ---- backup password ----
  const pwCard = el("div", { class: "admin-card" });
  pwCard.appendChild(el("h2", {}, "รหัสผ่านสำรอง (backup admin)"));
  pwCard.appendChild(el("p", { class: "muted" }, "ใช้เข้าระบบเมื่อ Google Sign-In ใช้ไม่ได้ — ตั้ง/เปลี่ยนได้เฉพาะตอนเข้าระบบด้วย Google เท่านั้น"));
  if (!isGoogleAdmin) {
    pwCard.appendChild(el("p", { class: "admin-note" }, "ขณะนี้เข้าระบบด้วยรหัสสำรอง — ออกจากระบบแล้วเข้าใหม่ด้วย Google เพื่อตั้ง/เปลี่ยนรหัสผ่านสำรอง"));
  } else {
    const p1 = el("input", { type: "password", placeholder: "รหัสผ่านสำรองใหม่ (อย่างน้อย 8 ตัวอักษร)" });
    const p2 = el("input", { type: "password", placeholder: "ยืนยันอีกครั้ง" });
    const msg = el("p", { style: "display:none" });
    const btn = el("button", { type: "button", class: "btn btn-primary" }, "บันทึกรหัสผ่านสำรอง");
    const form = el("div", { class: "admin-backup-form" }, [p1, p2, btn, msg]);
    pwCard.appendChild(form);
    btn.addEventListener("click", async () => {
      msg.style.display = "none";
      if (p1.value.length < 8) { msg.className = "admin-err-text"; msg.textContent = "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร"; msg.style.display = ""; return; }
      if (p1.value !== p2.value) { msg.className = "admin-err-text"; msg.textContent = "รหัสผ่านทั้งสองช่องไม่ตรงกัน"; msg.style.display = ""; return; }
      btn.disabled = true;
      try {
        await ctx.adminCall("adminSetBackupPassword", { password: p1.value });
        msg.className = "admin-ok-text"; msg.textContent = "บันทึกรหัสผ่านสำรองแล้ว"; msg.style.display = "";
        p1.value = ""; p2.value = "";
      } catch (err) {
        msg.className = "admin-err-text"; msg.textContent = err.message || "บันทึกไม่สำเร็จ"; msg.style.display = "";
      } finally {
        btn.disabled = false;
      }
    });
  }
  container.appendChild(pwCard);

  // ---- clear trial data ----
  const clearCard = el("div", { class: "admin-card" });
  clearCard.appendChild(el("h2", {}, "ล้างข้อมูลทดลองทั้งหมด"));
  clearCard.appendChild(el("p", { class: "muted" }, "ลบใบเบิกรอบทดลองทั้งหมด (requests + request_lines) — ไม่ลบ PIN / เพดาน / รายการที่ไม่เบิก พิมพ์คำว่า \"ล้างข้อมูล\" เพื่อยืนยัน"));
  const confirmInput = el("input", { type: "text", placeholder: "พิมพ์: ล้างข้อมูล" });
  const clearBtn = el("button", { type: "button", class: "btn btn-secondary" }, "ล้างข้อมูลทดลองทั้งหมด");
  clearBtn.style.borderColor = "var(--danger)"; clearBtn.style.color = "var(--danger)";
  const clearMsg = el("p", { style: "display:none" });
  clearCard.appendChild(el("div", { class: "field-row" }, confirmInput));
  clearCard.appendChild(clearBtn);
  clearCard.appendChild(clearMsg);
  container.appendChild(clearCard);

  clearBtn.addEventListener("click", async () => {
    clearMsg.style.display = "none";
    if (confirmInput.value !== "ล้างข้อมูล") {
      clearMsg.className = "admin-err-text"; clearMsg.textContent = 'พิมพ์คำว่า "ล้างข้อมูล" ให้ตรงก่อน'; clearMsg.style.display = "";
      return;
    }
    if (!window.confirm("ยืนยันล้างใบเบิกรอบทดลองทั้งหมด? การกระทำนี้ย้อนกลับไม่ได้")) return;
    clearBtn.disabled = true;
    try {
      const data = await ctx.adminCall("adminClearTrial", { confirm: "ล้างข้อมูล" });
      state.bootstrap.requests = [];
      ctx.markStale(["tab1", "tab2", "tab6"]);
      clearMsg.className = "admin-ok-text";
      clearMsg.textContent = `ล้างข้อมูลแล้ว (ลบ ${data.deleted_requests} ใบ, ${data.deleted_lines} รายการ)`;
      clearMsg.style.display = "";
      confirmInput.value = "";
    } catch (err) {
      clearMsg.className = "admin-err-text"; clearMsg.textContent = err.message || "ล้างข้อมูลไม่สำเร็จ"; clearMsg.style.display = "";
    } finally {
      clearBtn.disabled = false;
    }
  });

  // ---- about ----
  const aboutCard = el("div", { class: "admin-card" });
  aboutCard.appendChild(el("h2", {}, "เกี่ยวกับข้อมูลชุดนี้"));
  aboutCard.appendChild(el("p", { class: "admin-note" },
    "หน้านี้ใช้ข้อมูลเบิกจริงปีงบ 2568 (ราคาปี 2568) ผสมยอดคงเหลือจำลองที่สอดคล้องกับยอดเบิก และใบเบิกรอบทดลอง (ก.ย./ต.ค. 2568) ที่ รพ.สต. กรอกจริงผ่านระบบนี้ — ไม่ใช่ข้อมูลผู้ป่วย"));
  aboutCard.appendChild(el("p", { class: "admin-note" },
    "การเพิ่ม/ถอด admin ยังทำผ่านการแก้ sheet \"admins\" ของ Google Sheet โดยตรง (หน้าจอจัดการ admin ไว้ทำใน phase 2)"));
  container.appendChild(aboutCard);
}
