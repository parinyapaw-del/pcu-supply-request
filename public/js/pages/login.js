// Login page: pick PCU → 5-digit PIN → pcuLogin (spec §3.1).
import { ApiError } from "../api.js";
import * as auth from "../auth.js";
import * as store from "../store.js";
import { formatBangkokHHMM } from "../format.js";

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function renderLogin(container, app, onLoggedIn) {
  const savedPcu = store.getLastPcu();
  const box = document.createElement("div");
  box.className = "login-page";

  // The 15 PCUs are in the static form JSON — render instantly instead of waiting 3–15 s for the
  // Apps Script `pcuList` call (only used as a fallback if the form data has no pcus).
  let pcuList = app.pcuList || (app.form && app.form.pcus && app.form.pcus.length
    ? (app.pcuList = app.form.pcus.map((p) => ({ code: p.code, name: p.name, group: p.group })))
    : null);
  // Warm up the Apps Script instance while the user types the PIN (first call after idle is slow).
  auth.fetchPcuList().catch(() => {});
  if (!pcuList) {
    box.innerHTML = '<p class="muted">กำลังโหลดรายชื่อ รพ.สต. ...</p>';
    container.innerHTML = "";
    container.appendChild(box);
    try {
      pcuList = app.pcuList = await auth.fetchPcuList();
    } catch (err) {
      box.innerHTML = `<div class="notice notice-error">โหลดรายชื่อ รพ.สต. ไม่สำเร็จ: ${esc(err.message)}</div>`;
      return;
    }
  }

  const selected = pcuList.some((p) => p.code === savedPcu) ? savedPcu : pcuList[0].code;

  box.innerHTML = `
    <h2>เข้าสู่ระบบ รพ.สต.</h2>
    ${app.flash ? `<div class="notice notice-error">${esc(app.flash)}</div>` : ""}
    <div class="field-row">
      <label class="field-label" for="pcu-select">โรงพยาบาลส่งเสริมสุขภาพตำบล</label>
      <select id="pcu-select" class="select-input">
        ${pcuList.map((p) => `<option value="${p.code}" ${p.code === selected ? "selected" : ""}>${esc(p.code)} — ${esc(p.name)}${p.group === "พิเศษ" ? " (พิเศษ)" : ""}</option>`).join("")}
      </select>
    </div>
    <div class="field-row">
      <label class="field-label" for="pin-input">PIN 5 หลัก</label>
      <input id="pin-input" class="pin-input" type="text" inputmode="numeric" pattern="[0-9]*"
        autocomplete="off" maxlength="5" placeholder="•••••">
      <div class="pin-keypad" id="pin-keypad">
        ${["1","2","3","4","5","6","7","8","9","","0","⌫"].map((k) =>
          k === "" ? '<span></span>' : `<button type="button" class="pin-key" data-key="${esc(k)}">${esc(k)}</button>`
        ).join("")}
      </div>
    </div>
    <div id="login-msg" class="notice notice-error" style="display:none"></div>
    <button type="button" class="btn btn-primary btn-lg" id="btn-login">เข้าสู่ระบบ</button>
    <p class="muted login-forgot">ลืม PIN ติดต่อผู้ดูแลระบบ</p>
  `;

  container.innerHTML = "";
  container.appendChild(box);
  app.flash = null;

  const pcuSelect = box.querySelector("#pcu-select");
  const pinInput = box.querySelector("#pin-input");
  const msg = box.querySelector("#login-msg");
  const loginBtn = box.querySelector("#btn-login");

  function showMsg(text) {
    msg.textContent = text;
    msg.style.display = text ? "" : "none";
  }

  function sanitizePin() {
    const digits = pinInput.value.replace(/[^0-9]/g, "").slice(0, 5);
    pinInput.value = digits;
  }
  pinInput.addEventListener("input", sanitizePin);
  pinInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") doLogin();
  });

  box.querySelectorAll(".pin-key").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.key === "⌫") {
        pinInput.value = pinInput.value.slice(0, -1);
      } else if (pinInput.value.length < 5) {
        pinInput.value += btn.dataset.key;
      }
      pinInput.focus();
    });
  });

  async function doLogin() {
    const pcu = pcuSelect.value;
    const pin = pinInput.value;
    if (!/^[0-9]{5}$/.test(pin)) {
      showMsg("กรอก PIN ให้ครบ 5 หลัก");
      return;
    }
    loginBtn.disabled = true;
    showMsg("กำลังเข้าสู่ระบบและโหลดข้อมูล… (ระบบออนไลน์อาจใช้เวลา 5–20 วินาที)");
    try {
      const res = await auth.login(pcu, pin);
      await onLoggedIn(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === "BAD_PIN") {
        showMsg(`PIN ไม่ถูกต้อง — เหลือโอกาสอีก ${err.remaining} ครั้ง`);
      } else if (err instanceof ApiError && err.code === "PIN_LOCKED") {
        showMsg(`ใส่ PIN ผิดครบ 5 ครั้ง — ล็อกชั่วคราว ลองใหม่ได้เวลา ${formatBangkokHHMM(err.until)} น.`);
      } else if (err instanceof ApiError && err.code === "NOT_FOUND") {
        showMsg("ไม่พบ รพ.สต. นี้");
      } else {
        showMsg(err.message || "เข้าสู่ระบบไม่สำเร็จ");
      }
    } finally {
      loginBtn.disabled = false;
    }
  }

  loginBtn.addEventListener("click", doLogin);
}
