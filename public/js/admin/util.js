// js/admin/util.js — small DOM / formatting / dialog helpers shared by the admin tab modules.
// No aggregation logic here (see compute.js) and no direct API calls (use ctx.adminCall).
import { THAI_MONTHS } from "../format.js";

export function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  });
  return node;
}

export function tableScroll(tableHtml, extraClass = "") {
  return `<div class="table-scroll ${extraClass}">${tableHtml}</div>`;
}

// ---- time / date formatting ---------------------------------------------------------------------
// ISO timestamp -> "06/10/2569 15:38" in Asia/Bangkok (Buddhist-era year).
export function formatBangkokDateTime(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "–";
  try {
    const parts = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
      timeZone: "Asia/Bangkok",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
  } catch (err) {
    return d.toLocaleString();
  }
}

export function formatBangkokTimeSec(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (isNaN(d.getTime())) return "–";
  try {
    return new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(d);
  } catch (err) {
    return d.toLocaleTimeString();
  }
}

const SHORT_TH = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
// "2026-10-31" -> "31 ต.ค. 2569"
export function formatDateThai(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "–";
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${SHORT_TH[m - 1]} ${y + 543}`;
}

// "2026-10" -> "ต.ค. 69" (compact, for column headers)
export function monthShort(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${SHORT_TH[m - 1]} ${String(y + 543).slice(2)}`;
}

export function monthLong(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${THAI_MONTHS[m - 1]} ${y + 543}`;
}

export function fmtPct(n, digits = 0) {
  if (n === null || n === undefined || !isFinite(n)) return "–";
  return n.toFixed(digits) + "%";
}

// ---- dialogs (modal based: window.confirm/prompt block automation and look out of place) -----------
export function openModal(titleText, bodyNode, { onClose, wide } = {}) {
  const backdrop = el("div", { class: "admin-modal-backdrop" });
  const modal = el("div", { class: "admin-modal" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" });
  modal.appendChild(el("h2", {}, titleText));
  modal.appendChild(bodyNode);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  }
  function onKey(ev) { if (ev.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) close(); });
  return { close, modal };
}

// Resolves true when the user confirms.
export function confirmDialog(message, { title = "ยืนยัน", okText = "ตกลง", cancelText = "ยกเลิก", danger = false } = {}) {
  return new Promise((resolve) => {
    const body = el("div");
    body.appendChild(el("p", { style: "white-space:pre-line" }, message));
    const actions = el("div", { class: "admin-modal-actions" });
    const cancel = el("button", { type: "button", class: "btn btn-secondary", "data-role": "cancel" }, cancelText);
    const ok = el("button", { type: "button", class: "btn " + (danger ? "btn-danger" : "btn-primary"), "data-role": "ok" }, okText);
    actions.appendChild(cancel);
    actions.appendChild(ok);
    body.appendChild(actions);
    let settled = false;
    const m = openModal(title, body, { onClose: () => { if (!settled) { settled = true; resolve(false); } } });
    cancel.addEventListener("click", () => { settled = true; m.close(); resolve(false); });
    ok.addEventListener("click", () => { settled = true; m.close(); resolve(true); });
    ok.focus();
  });
}

// Resolves the entered string (trimmed) or null when cancelled. `fields` = [{key,label,type,value,required,placeholder,options}]
// returns an object {key: value} when multiple fields are given via formDialog().
export function formDialog(title, fields, { okText = "บันทึก", intro = "", validate } = {}) {
  return new Promise((resolve) => {
    const body = el("div");
    if (intro) body.appendChild(el("p", { class: "muted", style: "white-space:pre-line" }, intro));
    const inputs = {};
    fields.forEach((f) => {
      const wrap = el("label", { class: "admin-form-field" });
      wrap.appendChild(el("span", {}, f.label + (f.required ? " *" : "")));
      let input;
      if (f.type === "textarea") input = el("textarea", { rows: f.rows || 3, placeholder: f.placeholder || "", maxlength: f.maxlength || null });
      else if (f.type === "select") {
        input = el("select", { class: "select-input" });
        (f.options || []).forEach((o) => input.appendChild(el("option", { value: o.value }, o.label)));
      } else input = el("input", { type: f.type || "text", placeholder: f.placeholder || "", maxlength: f.maxlength || null, min: f.min || null, max: f.max || null, inputmode: f.inputmode || null, autocomplete: "off" });
      if (f.value !== undefined && f.value !== null) input.value = f.value;
      inputs[f.key] = input;
      wrap.appendChild(input);
      body.appendChild(wrap);
    });
    const err = el("p", { class: "admin-err-text", style: "display:none" });
    body.appendChild(err);
    const actions = el("div", { class: "admin-modal-actions" });
    const cancel = el("button", { type: "button", class: "btn btn-secondary" }, "ยกเลิก");
    const ok = el("button", { type: "button", class: "btn btn-primary" }, okText);
    actions.appendChild(cancel);
    actions.appendChild(ok);
    body.appendChild(actions);
    let settled = false;
    const m = openModal(title, body, { onClose: () => { if (!settled) { settled = true; resolve(null); } } });
    cancel.addEventListener("click", () => { settled = true; m.close(); resolve(null); });
    function submit() {
      const out = {};
      for (const f of fields) {
        const v = inputs[f.key].value.trim();
        if (f.required && !v) { err.textContent = `กรุณากรอก "${f.label}"`; err.style.display = ""; inputs[f.key].focus(); return; }
        out[f.key] = v;
      }
      if (validate) {
        const msg = validate(out);
        if (msg) { err.textContent = msg; err.style.display = ""; return; }
      }
      settled = true; m.close(); resolve(out);
    }
    ok.addEventListener("click", submit);
    const first = fields.length ? inputs[fields[0].key] : null;
    if (first) {
      first.focus();
      if (first.tagName === "INPUT") first.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });
    }
  });
}

let toastTimer = null;
export function toast(message, kind = "ok") {
  let box = document.getElementById("admin-toast");
  if (!box) {
    box = el("div", { id: "admin-toast", class: "admin-toast", role: "status" });
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.className = "admin-toast show " + (kind === "err" ? "err" : "ok");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.classList.remove("show"); }, kind === "err" ? 6000 : 3000);
}

export function errMessage(err) {
  if (!err) return "เกิดข้อผิดพลาด";
  return err.message || String(err);
}

// ---- download helpers ----------------------------------------------------------------------------
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function downloadJson(obj, filename) {
  downloadBlob(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }), filename);
}

// SheetJS: admin.html loads it with a <script> tag; fall back to a dynamic load from cdnjs.
let xlsxPromise = null;
export function getXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxPromise) return xlsxPromise;
  xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error("โหลด SheetJS ไม่สำเร็จ")));
    s.onerror = () => { xlsxPromise = null; reject(new Error("โหลด SheetJS ไม่สำเร็จ (ตรวจอินเทอร์เน็ต)")); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}

// Heat shading for the previous-year heatmap: 0 -> near-transparent, max -> full accent.
export function heatColor(value, max) {
  if (!max || max <= 0 || !value) return { style: "", cls: "hm-lo" };
  const t = Math.max(0, Math.min(1, value / max));
  const alpha = 0.08 + t * 0.72;
  return { style: `background: rgba(15,110,92,${alpha.toFixed(3)});`, cls: t > 0.55 ? "" : "hm-lo" };
}

// Simple sequential promise pool: runs `worker(item)` with at most `limit` in flight.
export async function poolMap(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
