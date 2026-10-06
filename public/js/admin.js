// js/admin.js — admin back-office entry point (checkpoint C4, phase 1.5).
// Orchestrates: login -> adminBootstrap (loading state) -> tab shell -> lazy per-tab rendering.
// Aggregation logic lives in js/admin/compute.js; each tab's DOM/rendering lives in js/admin/tabN_*.js.
import { call, ApiError, getAdminToken, clearAdminToken } from "./api.js";
import { loadFormData } from "./data.js";
import { mountLogin } from "./admin/login.js";
import { el, escapeHtml } from "./admin/util.js";
import { buildItems, extraItemDescriptor } from "./admin/compute.js";
import { renderTab1 } from "./admin/tab1_progress.js";
import { renderTab2 } from "./admin/tab2_item_totals.js";
import { renderTab3 } from "./admin/tab3_budget.js";
import { renderTab4 } from "./admin/tab4_heatmap.js";
import { renderTab5 } from "./admin/tab5_plan_vs_actual.js";
import { renderTab6 } from "./admin/tab6_stock.js";
import { renderTab7 } from "./admin/tab7_limits.js";
import { renderTab8 } from "./admin/tab8_pcu_settings.js";
import { renderTab9 } from "./admin/tab9_system.js";

const root = document.getElementById("admin-root");

const TABS = [
  { id: "tab1", label: "ความคืบหน้ารอบทดลอง", render: renderTab1 },
  { id: "tab2", label: "ยอดรวมต่อรายการ (ใบจัดของ)", render: renderTab2 },
  { id: "tab3", label: "งบสะสม vs เพดานเครือข่าย", render: renderTab3 },
  { id: "tab4", label: "รพ.สต. × เดือน (บาท)", render: renderTab4 },
  { id: "tab5", label: "แผนปี 68 vs เบิกจริง", render: renderTab5 },
  { id: "tab6", label: "คงเหลือ [จำลอง]", render: renderTab6 },
  { id: "tab7", label: "เพดานเบิก", render: renderTab7 },
  { id: "tab8", label: "ตั้งค่า รพ.สต.", render: renderTab8 },
  { id: "tab9", label: "ระบบ", render: renderTab9 }
];

const state = {}; // populated by initState(): bootstrap, items, extraItem, selected*, tab*Filter, ...
const panels = {}; // tabId -> { section, rendered, lifecycle }
let activeTabId = null;

const ctx = {
  state,
  adminCall,
  upsertRequest,
  markStale
};

function showLoading(msg) {
  root.innerHTML = "";
  root.appendChild(el("div", { class: "admin-loading-block" }, [
    el("div", { class: "admin-spinner" }),
    el("p", {}, msg || "กำลังโหลดข้อมูล...")
  ]));
}

function showLogin(msg) {
  activeTabId = null;
  for (const k of Object.keys(panels)) delete panels[k];
  mountLogin(root, { onLoggedIn: () => boot(), initialError: msg });
}

async function adminCall(action, params = {}) {
  try {
    return await call(action, params, { token: getAdminToken() });
  } catch (err) {
    if (err instanceof ApiError && (err.code === "AUTH_REQUIRED" || err.code === "AUTH_EXPIRED")) {
      clearAdminToken();
      showLogin("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    }
    throw err;
  }
}

function upsertRequest(request) {
  const list = state.bootstrap.requests;
  const idx = list.findIndex((r) => r.pcu === request.pcu && r.month === request.month);
  if (idx >= 0) list[idx] = request; else list.push(request);
  markStale(["tab2", "tab6"]);
}

function markStale(ids) {
  ids.forEach((id) => { if (panels[id]) panels[id].rendered = false; });
  if (activeTabId && ids.includes(activeTabId)) {
    const id = activeTabId;
    activeTabId = null;
    activate(id);
  }
}

function initState(bootstrap, form) {
  state.bootstrap = bootstrap;
  state.form = form;
  state.items = buildItems(form, bootstrap);
  state.extraItem = extraItemDescriptor(bootstrap);
  state.selectedMonth = null;
}

function activate(id) {
  if (activeTabId === id) return;
  if (activeTabId && panels[activeTabId] && panels[activeTabId].lifecycle && panels[activeTabId].lifecycle.onHide) {
    panels[activeTabId].lifecycle.onHide();
  }
  Object.entries(panels).forEach(([tid, p]) => p.section.classList.toggle("active", tid === id));
  document.querySelectorAll(".admin-tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
  const p = panels[id];
  if (!p.rendered) {
    p.section.innerHTML = "";
    const tabDef = TABS.find((t) => t.id === id);
    let lifecycle = null;
    try {
      lifecycle = tabDef.render(p.section, ctx);
    } catch (err) {
      console.error(err);
      p.section.innerHTML = `<p class="admin-err-text">แสดงผลไม่สำเร็จ: ${escapeHtml(err.message || String(err))}</p>`;
    }
    p.lifecycle = lifecycle || null;
    p.rendered = true;
  }
  if (p.lifecycle && p.lifecycle.onShow) p.lifecycle.onShow();
  activeTabId = id;
}

function renderShell() {
  root.innerHTML = "";

  const banner = el("div", { class: "admin-top-banner" }, [
    document.createTextNode("ข้อมูลจริงปีงบ 2568 + คงเหลือ "),
    el("span", { class: "tag-sim" }, "[จำลอง]"),
    document.createTextNode(" + ใบรอบทดลอง")
  ]);
  root.appendChild(banner);

  const shell = el("div", { class: "admin-shell" });
  const header = el("div", { class: "admin-header" });
  header.appendChild(el("h1", {}, "หน้าผู้ดูแลระบบ"));
  const me = state.bootstrap.me.email === "backup" ? "รหัสสำรอง" : state.bootstrap.me.email;
  const meBox = el("div", { class: "admin-me" });
  meBox.appendChild(el("span", {}, `เข้าสู่ระบบ: ${escapeHtml(me)}`));
  const logoutBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, "ออกจากระบบ");
  logoutBtn.addEventListener("click", () => { clearAdminToken(); showLogin(); });
  meBox.appendChild(logoutBtn);
  header.appendChild(meBox);
  shell.appendChild(header);

  const tabbar = el("div", { class: "admin-tabbar" });
  TABS.forEach((t) => {
    const btn = el("button", { type: "button", "data-tab": t.id }, t.label);
    btn.addEventListener("click", () => activate(t.id));
    tabbar.appendChild(btn);
  });
  shell.appendChild(tabbar);

  const panelBody = el("div", { class: "admin-panel-body" });
  TABS.forEach((t) => {
    const section = el("section", { class: "admin-panel" });
    panels[t.id] = { section, rendered: false, lifecycle: null };
    panelBody.appendChild(section);
  });
  shell.appendChild(panelBody);

  root.appendChild(shell);
  activate(TABS[0].id);
}

async function boot() {
  const token = getAdminToken();
  if (!token) { showLogin(); return; }
  showLoading("กำลังโหลดข้อมูลผู้ดูแล (อาจใช้เวลาสักครู่)...");
  try {
    const [bootstrap, form] = await Promise.all([
      call("adminBootstrap", {}, { token }),
      loadFormData()
    ]);
    initState(bootstrap, form);
    renderShell();
  } catch (err) {
    if (err instanceof ApiError && (err.code === "AUTH_REQUIRED" || err.code === "AUTH_EXPIRED" || err.code === "FORBIDDEN")) {
      clearAdminToken();
      showLogin(err.code === "FORBIDDEN" ? "บัญชีนี้ไม่มีสิทธิ์ผู้ดูแลระบบ" : "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    } else {
      root.innerHTML = "";
      root.appendChild(el("div", { class: "admin-loading-block" }, [
        el("p", { class: "admin-err-text" }, "โหลดข้อมูลไม่สำเร็จ: " + escapeHtml(err.message || String(err))),
        (() => { const b = el("button", { type: "button", class: "btn btn-secondary" }, "ลองใหม่"); b.addEventListener("click", boot); return b; })()
      ]));
    }
  }
}

boot();
