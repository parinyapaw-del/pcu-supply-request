// feedback_widget.js — floating "ส่งความคิดเห็น" button + panel (2ab), shared by index.html (รพ.สต., incl. the login page) and
// admin.html (admin / ผู้จ่าย, incl. its login screen). API: feedbackSend / feedbackMine / faqList / pcuList (functions/API.md §4.3).
// The owner page passes getAuth() → {token, role: "pcu"|"admin"|"dispenser"} or null (= guest) and getContext() → page details
// (route / tab, round, request); screen size, a short UA and the client time are added here.
import { call } from "./api.js";
import { renderFaqAnswer } from "./faq_render.js";

export const FB_CATEGORIES = [
  { value: "wording", label: "ข้อความ/คำในระบบที่อ่านแล้วไม่สบายใจ" },
  { value: "entry", label: "ปัญหาการกรอก/ส่ง" },
  { value: "dashboard", label: "อยากให้แดชบอร์ดเพิ่ม/ปรับ" },
  { value: "other", label: "อื่น ๆ / คำถาม" },
];
export const FB_STATUS = { new: "ใหม่", ack: "รับทราบ", fixed: "แก้แล้ว" };
const STATUS_CLS = { new: "badge-warn", ack: "badge-info", fixed: "badge-success" };
export const fbCategoryLabel = (v) => (FB_CATEGORIES.find((c) => c.value === v) || { label: v }).label;
const MAX_BODY = 2000, MAX_BODY_GUEST = 1000;
const DEVICE_KEY = "pcuSupply2:fbDevice";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmtNum = (n) => Number(n).toLocaleString("en-US");

export function fbDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
      timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
  } catch (e) { return d.toLocaleString(); }
}

// random id kept in this browser — the server stores only an HMAC of it + the day (rate limit for guest / anonymous)
function deviceId() {
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id || id.length < 8 || id.length > 64) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (e) {
    return (deviceId.mem ||= "mem-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }
}

function shortUa() {
  const ua = navigator.userAgent || "";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "อื่น";
  const br = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung" : /Line\//.test(ua) ? "LINE" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "อื่น";
  return `${br}/${os}`;
}

// list of a person's own feedback (widget "ที่ส่งแล้ว" + the PCU page #/feedback)
export function mineListHtml(items) {
  if (!items.length) return `<p class="muted">ยังไม่มีความคิดเห็นที่ส่งแบบระบุชื่อ</p>`;
  return `<ul class="fb-mine">${items.map((x) => `
    <li class="fb-mine-item">
      <div class="fb-mine-head"><span class="badge ${STATUS_CLS[x.status] || "badge-muted"}">${esc(FB_STATUS[x.status] || x.status)}</span>
        <span class="muted">${esc(fbDateTime(x.created_at))} · ${esc(fbCategoryLabel(x.category))}</span></div>
      <div class="fb-body">${esc(x.body)}</div>
      ${x.reply ? `<div class="fb-reply"><strong>คำตอบจากผู้ดูแล</strong> <span class="muted">${esc(fbDateTime(x.reply_at))}</span><div>${esc(x.reply)}</div></div>` : ""}
    </li>`).join("")}</ul>`;
}

export function faqListHtml(faqs) {
  if (!faqs.length) return `<p class="muted">ยังไม่มีคำถามที่พบบ่อย</p>`;
  let html = "", cat = null;
  for (const f of faqs) {
    if ((f.category || "") !== cat) { cat = f.category || ""; if (cat) html += `<h4 class="fb-faq-cat">${esc(cat)}</h4>`; }
    html += `<details class="fb-faq"><summary>${esc(f.question)}</summary><div class="fb-faq-a">${renderFaqAnswer(f.answer)}</div></details>`;
  }
  return html;
}

/**
 * 2ac: `helpHref()` → the manual section of the current page (string) or null (no ❓ there); `helpTarget` = link target (e.g. "_blank").
 * @param {{getAuth: () => ({token: string, role: string}|null), getContext?: () => object, mineHref?: string, helpHref?: () => (string|null), helpTarget?: string}} opts
 * @returns {{open: (view?: string) => void, close: () => void, refreshHelp: () => void}}
 */
export function mountFeedbackWidget(opts) {
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fb-fab no-print";
  fab.id = "fb-fab";
  fab.setAttribute("aria-label", "ส่งความคิดเห็น");
  fab.setAttribute("aria-expanded", "false");
  fab.innerHTML = `<span class="fb-fab-icon" aria-hidden="true">💬</span><span class="fb-fab-text">ส่งความคิดเห็น</span>`;
  const panel = document.createElement("div");
  panel.className = "fb-panel no-print";
  panel.id = "fb-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "ส่งความคิดเห็น");
  panel.hidden = true;
  document.body.appendChild(panel);
  // 2ac: ❓ "คู่มือ" sits left of 💬 in one fixed dock (only when the page passes helpHref)
  let help = null;
  if (opts.helpHref) {
    const dock = document.createElement("div");
    dock.className = "fb-dock no-print";
    help = document.createElement("a");
    help.className = "fb-help";
    help.id = "fb-help";
    help.setAttribute("aria-label", "คู่มือการใช้งานของหน้านี้");
    help.innerHTML = `<span class="fb-help-icon" aria-hidden="true">❓</span><span class="fb-help-text">คู่มือ</span>`;
    if (opts.helpTarget) { help.target = opts.helpTarget; help.rel = "noopener"; }
    // the href is computed again right before the click follows it (admin tabs change without a hashchange)
    help.addEventListener("click", refreshHelp);
    help.addEventListener("pointerenter", refreshHelp);
    help.addEventListener("focus", refreshHelp);
    dock.appendChild(help);
    dock.appendChild(fab);
    document.body.appendChild(dock);
    window.addEventListener("hashchange", refreshHelp);
    refreshHelp();
  } else {
    document.body.appendChild(fab);
  }
  document.body.classList.add("has-fb-fab");

  function refreshHelp() {
    if (!help) return;
    let href = null;
    try { href = opts.helpHref(); } catch (e) { href = null; }
    help.hidden = !href;
    if (href) help.setAttribute("href", href);
  }

  let view = "send";
  const draft = { category: "", body: "", anonymous: false, pcu: "" };
  let pcuOptions = null;

  const auth = () => { try { return opts.getAuth() || null; } catch (e) { return null; } };

  function tabsHtml(a) {
    const tabs = [["send", "ส่งความคิดเห็น"]];
    if (a && a.role !== "pcu") tabs.push(["mine", "ที่ส่งแล้ว"]);
    tabs.push(["faq", "คำถามที่พบบ่อย"]);
    return `<div class="fb-tabs" role="tablist">${tabs.map(([v, l]) =>
      `<button type="button" role="tab" class="fb-tab${view === v ? " active" : ""}" data-fbview="${v}" aria-selected="${view === v}">${l}</button>`).join("")}
      ${a && a.role === "pcu" && opts.mineHref ? `<a class="fb-tab fb-tab-link" href="${esc(opts.mineHref)}" data-fbmine>ที่ส่งแล้ว ›</a>` : ""}</div>`;
  }

  function render() {
    const a = auth();
    if (view === "mine" && (!a || a.role === "pcu")) view = "send";
    panel.innerHTML = `
      <div class="fb-head"><strong>ส่งความคิดเห็นถึงผู้ดูแลระบบ</strong><button type="button" class="fb-close" aria-label="ปิด">×</button></div>
      ${tabsHtml(a)}
      <div class="fb-content" id="fb-content"></div>`;
    panel.querySelector(".fb-close").addEventListener("click", close);
    panel.querySelectorAll("[data-fbview]").forEach((b) => b.addEventListener("click", () => { view = b.dataset.fbview; render(); }));
    const mineLink = panel.querySelector("[data-fbmine]");
    if (mineLink) mineLink.addEventListener("click", close);
    const box = panel.querySelector("#fb-content");
    if (view === "send") renderSend(box, a);
    else if (view === "mine") renderMine(box, a);
    else renderFaq(box, a);
  }

  function renderSend(box, a) {
    const guest = !a;
    const max = guest ? MAX_BODY_GUEST : MAX_BODY;
    box.innerHTML = `
      <fieldset class="fb-cats"><legend>เรื่องที่ต้องการบอก</legend>
        ${FB_CATEGORIES.map((c) => `<label class="fb-cat"><input type="radio" name="fb-cat" value="${c.value}"${draft.category === c.value ? " checked" : ""}> ${esc(c.label)}</label>`).join("")}
      </fieldset>
      ${guest ? `<label class="fb-field"><span>รพ.สต. (ไม่บังคับ)</span><select id="fb-pcu" class="select-input"><option value="">— ไม่ระบุ —</option></select></label>` : ""}
      <label class="fb-field"><span>ข้อความ</span>
        <textarea id="fb-body" rows="5" maxlength="${max}" placeholder="พิมพ์สิ่งที่อยากบอก เช่น หน้าไหน ปุ่มไหน เกิดอะไรขึ้น"></textarea></label>
      <div class="fb-count muted" id="fb-count"></div>
      ${a && a.role === "pcu" ? `<label class="fb-anon"><input type="checkbox" id="fb-anon"${draft.anonymous ? " checked" : ""}> ไม่ระบุชื่อ</label>
        <p class="fb-hint muted">ถ้าติ๊ก: ระบบจะไม่เก็บชื่อหน่วย ตอบกลับรายคนไม่ได้ (ผู้ดูแลอาจตอบเป็น "คำถามที่พบบ่อย")</p>` : ""}
      <p class="fb-hint muted">ระบบแนบหน้าที่เปิดอยู่ให้อัตโนมัติ (ไม่ต้องแนบรูป) · ส่งแล้วแก้/ลบไม่ได้ ส่งเพิ่มได้</p>
      <div class="fb-msg" id="fb-msg" role="status"></div>
      <div class="fb-actions"><button type="button" class="btn btn-primary" id="fb-send">ส่ง</button></div>`;
    const body = box.querySelector("#fb-body");
    const count = box.querySelector("#fb-count");
    body.value = draft.body.slice(0, max);
    const upd = () => { draft.body = body.value; count.textContent = `${fmtNum(body.value.length)} / ${fmtNum(max)} ตัวอักษร`; };
    upd();
    body.addEventListener("input", upd);
    box.querySelectorAll('input[name="fb-cat"]').forEach((r) => r.addEventListener("change", () => { draft.category = r.value; }));
    const anon = box.querySelector("#fb-anon");
    if (anon) anon.addEventListener("change", () => { draft.anonymous = anon.checked; });
    const sel = box.querySelector("#fb-pcu");
    if (sel) {
      const fill = () => {
        (pcuOptions || []).forEach((p) => { const o = document.createElement("option"); o.value = p.code; o.textContent = `${p.code} ${p.name}`; sel.appendChild(o); });
        sel.value = draft.pcu;
      };
      if (pcuOptions) fill();
      else call("pcuList").then((d) => { pcuOptions = d.pcus || []; if (sel.isConnected) fill(); }).catch(() => { /* optional field */ });
      sel.addEventListener("change", () => { draft.pcu = sel.value; });
    }
    box.querySelector("#fb-send").addEventListener("click", () => send(box, a));
  }

  async function send(box, a) {
    const msg = box.querySelector("#fb-msg");
    const btn = box.querySelector("#fb-send");
    const show = (t, ok) => { msg.textContent = t; msg.className = "fb-msg " + (ok ? "fb-ok" : "fb-err"); };
    if (!draft.category) { show("กรุณาเลือกเรื่องที่ต้องการบอก"); return; }
    if (!draft.body.trim()) { show("กรุณาพิมพ์ข้อความ"); box.querySelector("#fb-body").focus(); return; }
    let ctx = {};
    try { ctx = (opts.getContext && opts.getContext()) || {}; } catch (e) { ctx = {}; }
    const context = { ...ctx, screen: `${window.innerWidth}x${window.innerHeight}`, ua: shortUa(), client_at: new Date().toISOString() };
    const params = { category: draft.category, body: draft.body, context, device: deviceId() };
    if (a && a.role === "pcu" && draft.anonymous) params.anonymous = true;
    if (!a && draft.pcu) params.pcu = draft.pcu;
    btn.disabled = true;
    try {
      const res = await call("feedbackSend", params, { token: a ? a.token : undefined });
      draft.body = ""; draft.category = "";
      renderSend(box, a);
      const m = box.querySelector("#fb-msg");
      m.className = "fb-msg fb-ok";
      m.textContent = `ส่งแล้ว ขอบคุณที่แจ้ง · วันนี้ส่งได้อีก ${res.remaining_today} ครั้ง` + (a && !params.anonymous ? " · ดูคำตอบได้ที่ \"ที่ส่งแล้ว\"" : "");
    } catch (err) {
      show(err && err.message ? err.message : "ส่งไม่สำเร็จ");
      btn.disabled = false;
    }
  }

  async function renderMine(box, a) {
    box.innerHTML = `<p class="muted">กำลังโหลด...</p>`;
    try {
      const d = await call("feedbackMine", {}, { token: a.token });
      box.innerHTML = mineListHtml(d.items || []);
    } catch (err) { box.innerHTML = `<p class="fb-err">${esc(err.message || "โหลดไม่สำเร็จ")}</p>`; }
  }

  async function renderFaq(box, a) {
    box.innerHTML = `<p class="muted">กำลังโหลด...</p>`;
    try {
      const d = await call("faqList", {}, { token: a ? a.token : undefined });
      box.innerHTML = faqListHtml(d.faqs || []);
    } catch (err) { box.innerHTML = `<p class="fb-err">${esc(err.message || "โหลดไม่สำเร็จ")}</p>`; }
  }

  function onKey(ev) { if (ev.key === "Escape") close(); }
  function open(v) {
    if (v) view = v;
    render();
    panel.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    fab.classList.add("open");
    document.addEventListener("keydown", onKey);
  }
  function close() {
    panel.hidden = true;
    fab.setAttribute("aria-expanded", "false");
    fab.classList.remove("open");
    document.removeEventListener("keydown", onKey);
  }
  fab.addEventListener("click", () => (panel.hidden ? open() : close()));
  return { open, close, refreshHelp };
}
