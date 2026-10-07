// Change-PIN page: logged-in PCU sets a new 5-digit PIN via pcuChangePin (functions/API.md §4). The server returns a
// fresh token for this device (auth.changePin stores it); other devices get AUTH_EXPIRED on their next call.
import { ApiError } from "../api.js";
import * as auth from "../auth.js";
import * as store from "../store.js";
import * as sync from "../sync.js";
import { formatBangkokHHMM } from "../format.js";

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function renderChangePin(container, app) {
  const pcu = app.boot.pcu;
  const box = document.createElement("div");
  box.className = "login-page pin-page";

  const field = (id, label) => `
    <div class="field-row">
      <label class="field-label" for="${id}">${label}</label>
      <input id="${id}" class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*"
        autocomplete="off" maxlength="5" placeholder="•••••">
    </div>`;

  box.innerHTML = `
    <h2>เปลี่ยน PIN</h2>
    <p class="muted">ของ ${esc(pcu.code)} — ${esc(pcu.name)}</p>
    ${field("pin-old", "PIN เดิม")}
    ${field("pin-new", "PIN ใหม่")}
    ${field("pin-confirm", "ยืนยัน PIN ใหม่")}
    <div id="pin-msg" class="notice notice-error" style="display:none"></div>
    <button type="button" class="btn btn-primary btn-lg" id="btn-change-pin">เปลี่ยน PIN</button>
    <p class="login-forgot"><a href="#/home" id="link-cancel-pin">ยกเลิก</a></p>
  `;

  container.innerHTML = "";
  container.appendChild(box);

  const oldInput = box.querySelector("#pin-old");
  const newInput = box.querySelector("#pin-new");
  const confirmInput = box.querySelector("#pin-confirm");
  const msg = box.querySelector("#pin-msg");
  const submitBtn = box.querySelector("#btn-change-pin");

  function showMsg(text) {
    msg.textContent = text;
    msg.style.display = text ? "" : "none";
  }

  [oldInput, newInput, confirmInput].forEach((input) => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/[^0-9]/g, "").slice(0, 5);
    });
  });
  confirmInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") doChange();
  });

  async function doChange() {
    const oldPin = oldInput.value;
    const newPin = newInput.value;
    const confirmPin = confirmInput.value;
    if (![oldPin, newPin, confirmPin].every((p) => /^[0-9]{5}$/.test(p))) {
      showMsg("กรอก PIN ให้ครบ 5 หลักทุกช่อง");
      return;
    }
    if (newPin === oldPin) {
      showMsg("PIN ใหม่ต้องต่างจาก PIN เดิม");
      return;
    }
    if (confirmPin !== newPin) {
      showMsg("PIN ใหม่ทั้งสองช่องไม่ตรงกัน");
      return;
    }
    submitBtn.disabled = true;
    showMsg("");
    try {
      await auth.changePin(oldPin, newPin);
    } catch (err) {
      submitBtn.disabled = false;
      if (err instanceof ApiError && err.code === "BAD_PIN") {
        showMsg(`PIN เดิมไม่ถูกต้อง — เหลือโอกาสอีก ${err.remaining} ครั้ง`);
      } else if (err instanceof ApiError && err.code === "PIN_LOCKED") {
        showMsg(`ใส่ PIN ผิดครบ 5 ครั้ง — ล็อกชั่วคราว ลองใหม่ได้เวลา ${formatBangkokHHMM(err.until)} น.`);
      } else if (auth.isAuthError(err)) {
        // Click handlers run outside route()'s try/catch, so do the router's logout cleanup here.
        auth.logout();
        store.clearCachedBootstraps();
        sync.resetSessions();
        app.boot = null;
        app.older = {};
        app.flash = err.message || "กรุณาเข้าสู่ระบบใหม่";
        location.hash = "#/login";
      } else {
        showMsg((err && err.message) || "เปลี่ยน PIN ไม่สำเร็จ");
      }
      return;
    }

    // Success: this device keeps its session (auth.changePin stored the fresh token).
    pcu.pin_custom = true;
    if (!app.offline) store.setCachedBootstrap(pcu.code, app.boot);
    box.innerHTML = `
      <h2>เปลี่ยน PIN</h2>
      <div class="notice notice-info">เปลี่ยน PIN เรียบร้อย — เครื่องอื่นที่ล็อกอินค้างอยู่ต้องเข้าสู่ระบบใหม่ด้วย PIN ใหม่</div>
      <button type="button" class="btn btn-primary btn-lg" id="btn-pin-home">กลับหน้าหลัก</button>
    `;
    box.querySelector("#btn-pin-home").addEventListener("click", () => {
      location.hash = "#/home";
    });
  }

  submitBtn.addEventListener("click", doChange);
  oldInput.focus();
}
