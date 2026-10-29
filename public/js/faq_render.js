// faq_render.js — FAQ answer text → safe HTML (2ab; the 2ac /help page reuses it). Shared by both frontends.
// Order: escape every HTML character → **bold** → [label](url) (only https://, http://, #…, /… — anything else stays plain text)
// → line breaks. No images, no raw HTML.

export function escapeFaq(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_URL = /^(https?:\/\/[^\s]+|#[^\s]*|\/(?!\/)[^\s]*)$/i;

export function renderFaqAnswer(text) {
  let s = escapeFaq(String(text == null ? "" : text).replace(/\r\n?/g, "\n"));
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (!SAFE_URL.test(url)) return m;
    const ext = /^https?:/i.test(url);
    return `<a href="${url}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
  });
  return s.replace(/\n/g, "<br>");
}
