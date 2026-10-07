// App entry point + hash router for index.html (phase 2 — PIN login, bootstrap from the Pages Functions API).
import { call, ApiError, getPcuToken, clearPcuToken } from "./api.js";
import * as auth from "./auth.js";
import * as sync from "./sync.js";
import * as store from "./store.js";
import { renderLogin } from "./pages/login.js";
import { renderHome } from "./pages/home.js";
import { renderHidden } from "./pages/hidden.js";
import { renderChangePin } from "./pages/pin.js";
import { renderFill } from "./pages/fill.js";
import { renderPrint } from "./pages/print.js";
import { renderIssue } from "./pages/issue.js";
import { loadOlderMonth } from "./pages/common.js";

// app.boot = pcuBootstrap (functions/API.md §4.1) · app.older = months loaded via pcuGetMonth · app.offline = running on the cached bootstrap
const app = { pcuList: null, boot: null, monthKey: null, flash: null, older: {}, bootAt: 0, offline: false };
const BOOT_REFRESH_AFTER_MS = 5000;

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

function applyBootstrap(data, offline) {
  app.boot = data;
  app.bootAt = Date.now();
  app.offline = !!offline;
  const pcu = data.pcu.code;
  Object.keys(data.byMonth || {}).forEach((month) => {
    sync.initSession(pcu, month, data.byMonth[month].request);
  });
  if (!offline) store.setCachedBootstrap(pcu, data);
}

// `pre` = bootstrap already returned by pcuLogin. Without it: pcuBootstrap, falling back to the cached copy
// (offline resume) when the network is down.
async function loadBootstrap(pre) {
  if (pre) {
    applyBootstrap(pre, false);
    return;
  }
  try {
    applyBootstrap(await call("pcuBootstrap", {}, { token: getPcuToken() }), false);
  } catch (err) {
    const code = auth.tokenPcuCode();
    const cached = err instanceof ApiError && err.code === "NETWORK" && code ? store.getCachedBootstrap(code) : null;
    if (!cached) throw err;
    applyBootstrap(cached, true);
  }
}

// Home page refreshes the bootstrap (lock state, admin note, deadline may have changed) — typed values are kept (sync.initSession).
async function refreshBootstrapIfStale() {
  if (app.boot && Date.now() - app.bootAt < BOOT_REFRESH_AFTER_MS && !app.offline) return;
  try {
    await loadBootstrap();
  } catch (err) {
    if (auth.isAuthError(err)) throw err;
    console.warn("bootstrap refresh failed", err);
  }
}

function logoutLocal() {
  clearPcuToken();
  store.clearCachedBootstraps();
  sync.resetSessions();
  app.boot = null;
  app.older = {};
}

function renderHeader() {
  const el = document.getElementById("app-header");
  if (!el) return;
  if (app.boot) {
    el.innerHTML = `
      <span class="app-header-pcu">${escapeHtml(app.boot.pcu.code)} — ${escapeHtml(app.boot.pcu.name)}</span>
      ${app.offline ? '<span class="badge badge-warn">ออฟไลน์</span>' : ""}
      <a href="#/home" class="app-header-link">หน้าหลัก</a>
      <button type="button" class="btn btn-link" id="btn-logout">ออกจากระบบ</button>
    `;
    el.style.display = "";
    document.getElementById("btn-logout").addEventListener("click", () => {
      logoutLocal();
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
  // Admin reprint (C4's admin page links here): uses the admin token, not the PCU session.
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
            logoutLocal();
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
      // Have a token but haven't bootstrapped yet in this page life (deep link / reload).
      await loadBootstrap();
      renderHeader();
    }

    if (path === "home") {
      app.monthKey = null;
      await refreshBootstrapIfStale();
      renderHeader();
      await renderHome(container, app);
    } else if (path === "hidden") {
      await renderHidden(container, app);
    } else if (path === "pin") {
      await renderChangePin(container, app);
    } else if (path === "fill") {
      const stepCode = segments[1] || "";
      app.monthKey = params.get("month") || app.boot.rounds[0].month;
      await loadOlderMonth(app, app.monthKey); // no-op for current/previous month
      await renderFill(container, app, stepCode, params);
    } else if (path === "print") {
      if (!isAdminPrint) {
        app.monthKey = params.get("month") || app.boot.rounds[0].month;
        await loadOlderMonth(app, app.monthKey);
      }
      await renderPrint(container, app, params);
    } else if (path === "issue") {
      await renderIssue(container, app, params);
    } else {
      location.hash = "#/home";
    }
  } catch (err) {
    (auth.isAuthError(err) ? console.warn : console.error)(err);
    if (auth.isAuthError(err)) {
      logoutLocal();
      app.flash = err.message || "กรุณาเข้าสู่ระบบใหม่";
      renderHeader();
      location.hash = "#/login";
      return;
    }
    container.innerHTML = `<div class="notice notice-error">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</div>
      <p><a href="#/home">กลับหน้าหลัก</a></p>`;
  }
}

function wireFooter() {
  const clearBtn = document.getElementById("btn-clear-local");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("ล้างข้อมูลในเครื่องนี้และออกจากระบบ? (ข้อมูลบน server จะยังอยู่ — แต่ค่าที่ยังไม่ได้บันทึกขึ้น server จะหายไป)")) {
        sync.clearAllLocalMirrors();
        logoutLocal();
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

wireFooter();
wireBeforeUnload();
window.addEventListener("hashchange", route);
route();
