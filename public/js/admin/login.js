// js/admin/login.js — admin sign-in screen: Google Identity Services + backup password + a
// dev-only email box (GIS's OAuth client only allows the github.io origin, so it cannot complete
// on localhost; the dev box calls adminLoginGoogle with "dev:<email>", which the local dev API accepts when DEV_FAKE_GOOGLE=1 — see functions/API.md §2).
import { call, ApiError, setAdminToken } from "../api.js";
import { GOOGLE_CLIENT_ID } from "../constants.js";
import { el, formatBangkokDateTime } from "./util.js";

const GIS_SRC = "https://accounts.google.com/gsi/client";
let gisLoadPromise = null;

function loadGis() {
  if (gisLoadPromise) return gisLoadPromise;
  gisLoadPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("โหลด Google Identity Services ไม่สำเร็จ"));
    document.head.appendChild(s);
  });
  return gisLoadPromise;
}

function isLocalDev() {
  try {
    return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  } catch (err) {
    return false;
  }
}

export function mountLogin(root, { onLoggedIn, initialError } = {}) {
  root.innerHTML = "";
  const wrap = el("div", { class: "admin-login-wrap" });
  const card = el("div", { class: "admin-login-card" });
  card.appendChild(el("h1", {}, "เข้าสู่ระบบผู้ดูแล"));
  card.appendChild(el("p", { class: "muted" }, "ระบบเบิกวัสดุ รพ.สต. — ผู้ดูแล / ผู้จ่าย"));

  if (initialError) {
    card.appendChild(el("p", { class: "admin-err-text" }, initialError));
  }

  const gsiHost = el("div", { id: "gsi-button-host" }, el("p", { class: "muted" }, "กำลังโหลดปุ่ม Google..."));
  card.appendChild(gsiHost);

  const errBox = el("p", { class: "admin-err-text", style: "display:none" });
  card.appendChild(errBox);

  function showError(msg) {
    errBox.textContent = msg;
    errBox.style.display = "";
  }
  function clearError() {
    errBox.style.display = "none";
  }

  async function handleIdToken(idToken) {
    clearError();
    try {
      const data = await call("adminLoginGoogle", { id_token: idToken });
      setAdminToken(data.token, data.exp);
      onLoggedIn && onLoggedIn();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "FORBIDDEN") showError("บัญชีนี้ไม่มีสิทธิ์ใช้งาน — ติดต่อผู้ดูแลระบบ (parinya.paw@gmail.com)");
        else showError(err.message || "เข้าสู่ระบบไม่สำเร็จ");
      } else {
        showError("เข้าสู่ระบบไม่สำเร็จ");
      }
    }
  }

  loadGis()
    .then(() => {
      // initialize() may only run once per page load; later logins (after logout) reuse the latest callback
      window.__adminGisCallback = handleIdToken;
      if (!window.__adminGisInit) {
        window.__adminGisInit = true;
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (resp) => window.__adminGisCallback && window.__adminGisCallback(resp.credential)
        });
      }
      gsiHost.innerHTML = "";
      window.google.accounts.id.renderButton(gsiHost, { theme: "outline", size: "large", text: "signin_with" });
    })
    .catch(() => {
      gsiHost.innerHTML = "";
      gsiHost.appendChild(el("p", { class: "muted" }, "โหลดปุ่ม Google Sign-In ไม่สำเร็จ (ตรวจอินเทอร์เน็ต) — ใช้รหัสสำรองด้านล่างแทนได้"));
    });

  // ---- backup password (collapsible) --------------------------------------------------------
  const details = el("details", { class: "admin-backup-details" });
  details.appendChild(el("summary", {}, "เข้าด้วยรหัสสำรอง"));
  const backupForm = el("div", { class: "admin-backup-form" });
  const pwInput = el("input", { type: "password", placeholder: "รหัสผ่านสำรอง", autocomplete: "current-password" });
  const backupBtn = el("button", { type: "button", class: "btn btn-secondary" }, "เข้าสู่ระบบด้วยรหัสสำรอง");
  const backupMsg = el("p", { class: "admin-err-text", style: "display:none" });
  backupForm.appendChild(pwInput);
  backupForm.appendChild(backupBtn);
  backupForm.appendChild(backupMsg);
  details.appendChild(backupForm);
  card.appendChild(details);

  backupBtn.addEventListener("click", async () => {
    backupMsg.style.display = "none";
    const password = pwInput.value;
    if (!password) return;
    backupBtn.disabled = true;
    try {
      const data = await call("adminLoginBackup", { password });
      setAdminToken(data.token, data.exp);
      onLoggedIn && onLoggedIn();
    } catch (err) {
      backupMsg.style.display = "";
      if (err instanceof ApiError) {
        if (err.code === "BAD_PASSWORD") backupMsg.textContent = `รหัสผ่านไม่ถูกต้อง (เหลือ ${err.remaining ?? "?"} ครั้ง)`;
        else if (err.code === "LOCKED") backupMsg.textContent = `ถูกล็อกชั่วคราว — ลองใหม่หลัง ${formatBangkokDateTime(err.until)}`;
        else if (err.code === "NOT_FOUND") backupMsg.textContent = "ยังไม่ได้ตั้งรหัสผ่านสำรอง — เข้าด้วย Google ก่อนแล้วตั้งในหน้า \"ระบบ\"";
        else backupMsg.textContent = err.message || "เข้าสู่ระบบไม่สำเร็จ";
      } else {
        backupMsg.textContent = "เข้าสู่ระบบไม่สำเร็จ";
      }
    } finally {
      backupBtn.disabled = false;
    }
  });

  // ---- dev-only login (localhost/127.0.0.1 only) ---------------------------------------------
  if (isLocalDev()) {
    const devBox = el("div", { class: "admin-dev-login" });
    devBox.appendChild(el("p", { class: "muted" }, "Dev only: Google Sign-In ใช้ไม่ได้บน localhost (origin ไม่ตรง) — เข้าด้วยอีเมลจำลองแทน"));
    const row = el("div", { class: "field-row" });
    const emailInput = el("input", { type: "email", placeholder: "you@example.com", value: "parinya.paw@gmail.com" });
    const devBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, "เข้าระบบ (dev)");
    row.appendChild(emailInput);
    row.appendChild(devBtn);
    devBox.appendChild(row);
    card.appendChild(devBox);

    devBtn.addEventListener("click", () => {
      const email = emailInput.value.trim();
      if (!email) return;
      handleIdToken("dev:" + email);
    });
  }

  wrap.appendChild(card);
  root.appendChild(wrap);
}
