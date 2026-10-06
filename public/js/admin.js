// js/admin.js — admin / back-office entry point (phase 2a, checkpoint C4).
// login -> adminBootstrap -> role-aware tab shell -> lazy per-tab rendering.
// Tab modules live in js/admin/tabN_*.js; aggregation in js/admin/compute.js (functions/API.md §5).
import { call, ApiError, getAdminToken, clearAdminToken } from "./api.js";
import { mountLogin } from "./admin/login.js";
import { el, escapeHtml, toast } from "./admin/util.js";
import { buildCatalog } from "./admin/compute.js";
import { clearRequestCache } from "./admin/requests.js";
import { renderTab1 } from "./admin/tab1_status.js";
import { renderTab2 } from "./admin/tab2_totals.js";
import { renderTab3 } from "./admin/tab3_budget.js";
import { renderTab4 } from "./admin/tab4_prev.js";
import { renderTab5 } from "./admin/tab5_limits.js";
import { renderTab6 } from "./admin/tab6_excel.js";
import { renderTab7 } from "./admin/tab7_pcu.js";
import { renderTab8 } from "./admin/tab8_users.js";
import { renderTab9 } from "./admin/tab9_system.js";
import { renderTab10 } from "./admin/tab10_form.js";
import { renderTab11 } from "./admin/tab11_import.js";

const root = document.getElementById("admin-root");

// `staff: true` = also visible to the dispenser role (API.md §5: dispenser may only call adminBootstrap,
// adminRequests, adminGetRequest and the export).
const TABS = [
  { id: "tab1", hash: "status", label: "สถานะรอบ", render: renderTab1, staff: true },
  { id: "tab2", hash: "totals", label: "ยอดรวม / ใบจัดของ", render: renderTab2, staff: true },
  { id: "tab3", hash: "budget", label: "งบ", render: renderTab3 },
  { id: "tab4", hash: "prev", label: "ปีก่อน", render: renderTab4 },
  { id: "tab5", hash: "limits", label: "เพดาน", render: renderTab5 },
  { id: "tab10", hash: "form", label: "แบบฟอร์ม", render: renderTab10 },
  { id: "tab11", hash: "import", label: "นำเข้า / เปิดปีงบใหม่", render: renderTab11 },
  { id: "tab6", hash: "excel", label: "Excel", render: renderTab6, staff: true },
  { id: "tab7", hash: "pcu", label: "รพ.สต. (PIN / รายการที่ซ่อน)", render: renderTab7 },
  { id: "tab8", hash: "users", label: "ผู้ใช้", render: renderTab8 },
  { id: "tab9", hash: "system", label: "ระบบ", render: renderTab9 }
];

const state = { bootstrap: null, cat: null, me: null, isAdmin: false };
const panels = {}; // tabId -> { section, rendered, lifecycle }
let activeTabId = null;

const ctx = { state, adminCall, refreshBootstrap, markStale, tabs: TABS };

function showLoading(msg) {
  root.innerHTML = "";
  root.appendChild(el("div", { class: "admin-loading-block" }, [
    el("div", { class: "admin-spinner" }),
    el("p", {}, msg || "กำลังโหลดข้อมูล...")
  ]));
}

function resetPanels() {
  activeTabId = null;
  for (const k of Object.keys(panels)) {
    const p = panels[k];
    if (p.lifecycle && p.lifecycle.onHide) { try { p.lifecycle.onHide(); } catch (e) { /* ignore */ } }
    delete panels[k];
  }
}

function showLogin(msg) {
  resetPanels();
  clearRequestCache();
  mountLogin(root, { onLoggedIn: () => boot(), initialError: msg });
}

// Every admin call goes through here: an expired token / removed user sends the person back to login.
const READ_ACTIONS = new Set(["adminBootstrap", "adminRequests", "adminGetRequest", "adminUsersList", "adminAuditLog", "adminFormGet"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adminCall(action, params = {}) {
  try {
    try {
      return await call(action, params, { token: getAdminToken() });
    } catch (err) {
      // read-only actions are safe to retry once on a transient server/network hiccup
      if (READ_ACTIONS.has(action) && err instanceof ApiError && (err.code === "SERVER_ERROR" || err.code === "NETWORK")) {
        await sleep(700);
        return await call(action, params, { token: getAdminToken() });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof ApiError && (err.code === "AUTH_REQUIRED" || err.code === "AUTH_EXPIRED")) {
      clearAdminToken();
      showLogin("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    } else if (err instanceof ApiError && err.code === "FORBIDDEN") {
      clearAdminToken();
      showLogin("บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้ หรือถูกถอดสิทธิ์แล้ว — เข้าสู่ระบบใหม่");
    }
    throw err;
  }
}

async function refreshBootstrap() {
  const data = await adminCall("adminBootstrap", {});
  applyBootstrap(data);
  return data;
}

function applyBootstrap(data) {
  state.bootstrap = data;
  state.cat = buildCatalog(data.form);
  state.me = data.me;
  state.isAdmin = data.me.role === "admin";
}

function visibleTabs() {
  return TABS.filter((t) => state.isAdmin || t.staff);
}

function markStale(ids) {
  ids.forEach((id) => { if (panels[id]) panels[id].rendered = false; });
  if (activeTabId && ids.includes(activeTabId)) {
    const id = activeTabId;
    activeTabId = null;
    activate(id);
  }
}

function activate(id) {
  if (activeTabId === id) return;
  const p = panels[id];
  if (!p) return;
  if (activeTabId && panels[activeTabId] && panels[activeTabId].lifecycle && panels[activeTabId].lifecycle.onHide) {
    try { panels[activeTabId].lifecycle.onHide(); } catch (e) { console.error(e); }
  }
  Object.entries(panels).forEach(([tid, pp]) => pp.section.classList.toggle("active", tid === id));
  document.querySelectorAll(".admin-tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
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
  activeTabId = id;
  if (p.lifecycle && p.lifecycle.onShow) p.lifecycle.onShow();
  try { history.replaceState(null, "", "#" + TABS.find((t) => t.id === id).hash); } catch (e) { /* ignore */ }
  const btn = document.querySelector(`.admin-tabbar button[data-tab="${id}"]`);
  if (btn && btn.scrollIntoView) btn.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function roleLabel(me) {
  if (me.role === "admin") return "ผู้ดูแลระบบ";
  const units = (me.units || []).join(", ");
  return "ผู้จ่าย" + (units ? ` (${units})` : "");
}

function renderShell() {
  resetPanels();
  root.innerHTML = "";
  const shell = el("div", { class: "admin-shell" });
  const header = el("div", { class: "admin-header" });
  header.appendChild(el("h1", {}, "หน้าผู้ดูแลระบบ — เบิกวัสดุ รพ.สต."));
  const me = state.me.email === "backup" ? "รหัสสำรอง" : state.me.email;
  const meBox = el("div", { class: "admin-me" });
  meBox.appendChild(el("span", { id: "admin-me-label" }, `${me}`));
  meBox.appendChild(el("span", { class: "badge " + (state.isAdmin ? "badge-success" : "badge-warn"), id: "admin-role-badge" }, roleLabel(state.me)));
  const logoutBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "admin-logout" }, "ออกจากระบบ");
  logoutBtn.addEventListener("click", () => { clearAdminToken(); showLogin(); });
  meBox.appendChild(logoutBtn);
  header.appendChild(meBox);
  shell.appendChild(header);

  const tabs = visibleTabs();
  const tabbar = el("div", { class: "admin-tabbar", role: "tablist" });
  tabs.forEach((t) => {
    const btn = el("button", { type: "button", "data-tab": t.id, role: "tab" }, t.label);
    btn.addEventListener("click", () => activate(t.id));
    tabbar.appendChild(btn);
  });
  shell.appendChild(tabbar);

  const panelBody = el("div", { class: "admin-panel-body" });
  tabs.forEach((t) => {
    const section = el("section", { class: "admin-panel", id: "panel-" + t.id });
    panels[t.id] = { section, rendered: false, lifecycle: null };
    panelBody.appendChild(section);
  });
  shell.appendChild(panelBody);
  root.appendChild(shell);

  const wanted = TABS.find((t) => "#" + t.hash === location.hash && panels[t.id]);
  activate(wanted ? wanted.id : tabs[0].id);
}

async function boot() {
  const token = getAdminToken();
  if (!token) { showLogin(); return; }
  showLoading("กำลังโหลดข้อมูลผู้ดูแล...");
  try {
    const data = await call("adminBootstrap", {}, { token });
    applyBootstrap(data);
    renderShell();
  } catch (err) {
    if (err instanceof ApiError && (err.code === "AUTH_REQUIRED" || err.code === "AUTH_EXPIRED" || err.code === "FORBIDDEN")) {
      clearAdminToken();
      showLogin(err.code === "FORBIDDEN" ? "บัญชีนี้ไม่มีสิทธิ์ใช้งานหน้านี้" : "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
    } else {
      root.innerHTML = "";
      const retry = el("button", { type: "button", class: "btn btn-secondary" }, "ลองใหม่");
      retry.addEventListener("click", boot);
      root.appendChild(el("div", { class: "admin-loading-block" }, [
        el("p", { class: "admin-err-text" }, "โหลดข้อมูลไม่สำเร็จ: " + (err.message || String(err))),
        retry
      ]));
    }
  }
}

window.addEventListener("error", (ev) => { console.error("admin error:", ev.message); });
boot();
export { toast };
