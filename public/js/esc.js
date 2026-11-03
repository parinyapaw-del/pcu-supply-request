// esc.js — the one HTML escaper of both frontends (2ak D6): & < > " (safe in text and in double-quoted attributes).
export function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
