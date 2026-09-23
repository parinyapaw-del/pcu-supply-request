// App entry point + hash router for index.html.
import { DEMO_ROUNDS } from "./constants.js";
import { loadAll } from "./data.js";
import * as store from "./store.js";
import { renderStart } from "./pages/start.js";
import { renderFill } from "./pages/fill.js";
import { renderPrint } from "./pages/print.js";

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/start";
  const [path, queryStr] = raw.split("?");
  const params = new URLSearchParams(queryStr || "");
  const segments = path.split("/").filter(Boolean);
  return { segments, params };
}

async function route(app) {
  const container = document.getElementById("app");
  const { segments, params } = parseHash();
  const pcu = params.get("pcu") || store.getLastPcu() || app.form.pcus[0].code;
  const monthKey = params.get("month") || DEMO_ROUNDS[0].monthKey;
  app.pcu = pcu;
  app.monthKey = monthKey;

  updateBannerLink(pcu, monthKey);

  try {
    if (segments[0] === "fill") {
      const stepCode = segments[1] || "P1";
      await renderFill(container, app, stepCode, params);
    } else if (segments[0] === "print") {
      await renderPrint(container, app);
    } else {
      await renderStart(container, app);
    }
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="notice notice-error">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</div>`;
  }
}

function updateBannerLink(pcu, monthKey) {
  const link = document.getElementById("banner-admin-link");
  if (link) link.href = "admin.html";
}

function wireFooter() {
  const clearBtn = document.getElementById("btn-clear-demo");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("ล้างข้อมูลทดลองทั้งหมดในเบราว์เซอร์นี้? การกระทำนี้ย้อนกลับไม่ได้")) {
        store.clearAllDemoData();
        location.hash = "#/start";
        location.reload();
      }
    });
  }
}

async function boot() {
  const container = document.getElementById("app");
  container.innerHTML = '<p class="muted">กำลังโหลดข้อมูล...</p>';
  let form, limits;
  try {
    ({ form, limits } = await loadAll());
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="notice notice-error">โหลดข้อมูลไม่สำเร็จ: ${escapeHtml(err.message)}</div>`;
    return;
  }

  const app = { form, limits, rounds: DEMO_ROUNDS, pcu: null, monthKey: null };
  wireFooter();
  window.addEventListener("hashchange", () => route(app));
  route(app);
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

boot();
