// App entry point + hash router for index.html (phase 1.5 — online, PIN login).
import { call, getPcuToken, clearPcuToken } from "./api.js";
import { loadFormData } from "./data.js";
import * as auth from "./auth.js";
import * as sync from "./sync.js";
import { renderLogin } from "./pages/login.js";
import { renderHome } from "./pages/home.js";
import { renderHidden } from "./pages/hidden.js";
import { renderFill } from "./pages/fill.js";
import { renderPrint } from "./pages/print.js";

const app = { pcuList: null, form: null, boot: null, monthKey: null, flash: null };

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/login";
  const [path, queryStr] = raw.split("?");
  const params = new URLSearchParams(queryStr || "");
  const segments = path.split("/").filter(Boolean);
  return { segments, params };
}

// `pre` = bootstrap already returned by pcuLogin (saves one 3–15 s round trip).
async function loadBootstrap(pre) {
  const data = pre || (await call("pcuBootstrap", {}, { token: getPcuToken() }));
  app.boot = data;
  data.rounds.forEach((r) => {
    const existing = data.byRound[r.month];
    sync.initSession(data.pcu.code, r.month, existing && existing.request);
  });
}

function renderHeader() {
  const el = document.getElementById("app-header");
  if (!el) return;
  if (app.boot) {
    el.innerHTML = `
      <span class="app-header-pcu">${escapeHtml(app.boot.pcu.code)} — ${escapeHtml(app.boot.pcu.name)}</span>
      <a href="#/home" class="app-header-link">หน้าหลัก</a>
      <button type="button" class="btn btn-link" id="btn-logout">ออกจากระบบ</button>
    `;
    el.style.display = "";
    document.getElementById("btn-logout").addEventListener("click", () => {
      clearPcuToken();
      app.boot = null;
      location.hash = "#/login";
    });
  } else {
    el.innerHTML = "";
    el.style.display = "none";
  }
}

async function route() {
  const container = document.getElementById("app");
  const { segments, params } = parseHash();
  const path = segments[0] || "login";
  const isAdminPrint = path === "print" && params.get("as") === "admin";

  renderHeader();

  if (!isAdminPrint && !auth.isLoggedIn() && path !== "login") {
    location.hash = "#/login";
    return;
  }

  try {
    if (path === "login") {
      if (auth.isLoggedIn() && !app.boot) {
        // Already have a token from a previous visit (localStorage) — resume without re-asking PIN.
        try {
          await loadBootstrap();
          renderHeader();
        } catch (err) {
          if (auth.isAuthError(err)) {
            clearPcuToken();
            app.flash = err.message || "กรุณาเข้าสู่ระบบใหม่";
          } else {
            throw err;
          }
        }
      }
      if (app.boot) {
        location.hash = "#/home";
        return;
      }
      await renderLogin(container, app, async (res) => {
        await loadBootstrap(res && res.bootstrap);
        renderHeader();
        location.hash = "#/home";
      });
      return;
    }

    if (!isAdminPrint && !app.boot) {
      // Have a token but haven't bootstrapped yet in this page life (e.g. deep link / reload).
      await loadBootstrap();
      renderHeader();
    }

    if (path === "home") {
      app.monthKey = null;
      await renderHome(container, app);
    } else if (path === "hidden") {
      await renderHidden(container, app);
    } else if (path === "fill") {
      const stepCode = segments[1] || "P1";
      app.monthKey = params.get("month") || app.boot.rounds[0].month;
      await renderFill(container, app, stepCode, params);
    } else if (path === "print") {
      if (!isAdminPrint) app.monthKey = params.get("month") || app.boot.rounds[0].month;
      await renderPrint(container, app, params);
    } else {
      location.hash = "#/home";
    }
  } catch (err) {
    console.error(err);
    if (auth.isAuthError(err)) {
      clearPcuToken();
      app.boot = null;
      app.flash = err.message || "กรุณาเข้าสู่ระบบใหม่";
      renderHeader();
      location.hash = "#/login";
      return;
    }
    container.innerHTML = `<div class="notice notice-error">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</div>`;
  }
}

function wireFooter() {
  const clearBtn = document.getElementById("btn-clear-local");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("ล้างข้อมูลในเครื่องนี้และออกจากระบบ? (ข้อมูลบน server จะยังอยู่)")) {
        sync.clearAllLocalMirrors();
        clearPcuToken();
        app.boot = null;
        location.hash = "#/login";
        location.reload();
      }
    });
  }
}

function wireBeforeUnload() {
  window.addEventListener("beforeunload", (ev) => {
    if (sync.anyDirty()) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });
}

async function boot() {
  const container = document.getElementById("app");
  container.innerHTML = '<p class="muted">กำลังโหลดข้อมูล… (ระบบออนไลน์อาจใช้เวลา 5–20 วินาที)</p>';
  wireFooter();
  wireBeforeUnload();

  try {
    app.form = await loadFormData();
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="notice notice-error">โหลดข้อมูลฟอร์มไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return;
  }

  window.addEventListener("hashchange", route);
  route();
}

boot();
