// js/admin/util.js — small DOM / formatting helpers shared by the admin tab modules.
// Pure-ish helpers only; no API calls here (see api.js) and no aggregation logic (see compute.js).

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
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Formats an ISO timestamp as Asia/Bangkok local date+time, Buddhist-era year.
export function formatBangkokDateTime(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "–";
  try {
    const parts = new Intl.DateTimeFormat("th-TH-u-ca-buddhist", {
      timeZone: "Asia/Bangkok",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
  } catch (err) {
    return d.toLocaleString();
  }
}

export function formatBangkokTimeShort(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "–";
  try {
    return new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit"
    }).format(d);
  } catch (err) {
    return d.toLocaleTimeString();
  }
}

export function tableScroll(tableHtml, extraClass = "") {
  return `<div class="table-scroll ${extraClass}">${tableHtml}</div>`;
}

export function statusBadgeInfo(status) {
  switch (status) {
    case "not_started": return { label: "ยังไม่เริ่ม", cls: "badge-muted" };
    case "returned": return { label: "ส่งกลับแก้ไข", cls: "badge-danger" };
    case "draft": return { label: "แบบร่าง", cls: "badge-warn" };
    case "submitted": return { label: "ส่งแล้ว", cls: "badge-success" };
    case "received": return { label: "รับเรื่องแล้ว", cls: "badge-success" };
    default: return { label: status || "-", cls: "badge-muted" };
  }
}

// A request row's *display* status: "returned" is stored as draft+return_reason (API.md).
export function displayStatus(request) {
  if (!request) return "not_started";
  if (request.status === "draft" && request.return_reason) return "returned";
  return request.status;
}

export function fmtPct(n, digits = 0) {
  if (n === null || n === undefined || !isFinite(n)) return "–";
  return n.toFixed(digits) + "%";
}

export function fmt1(n) {
  if (n === null || n === undefined || !isFinite(n)) return "–";
  return n.toFixed(1);
}

// Minimal modal helper. `bodyNode` is appended inside; returns a close() function.
export function openModal(titleText, bodyNode, { onClose } = {}) {
  const backdrop = el("div", { class: "admin-modal-backdrop" });
  const modal = el("div", { class: "admin-modal" });
  modal.appendChild(el("h2", {}, titleText));
  modal.appendChild(bodyNode);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  function close() {
    backdrop.remove();
    if (onClose) onClose();
  }
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) close();
  });
  return { close, modal };
}

// Single-hue shading for the heatmap tab: 0 -> near-transparent, max -> full accent.
// Returns an inline style string; text stays readable via a computed light/dark class.
export function heatColor(value, max) {
  if (!max || max <= 0) return { style: "", cls: "hm-lo" };
  const t = Math.max(0, Math.min(1, value / max));
  // accent hue ~ teal; blend from surface to accent using alpha over a fixed base color.
  const alpha = 0.08 + t * 0.72;
  return { style: `background: rgba(15,110,92,${alpha.toFixed(3)});`, cls: t > 0.55 ? "" : "hm-lo" };
}

export function download_() { /* not used in phase 1.5 (export deferred to phase 2) */ }
