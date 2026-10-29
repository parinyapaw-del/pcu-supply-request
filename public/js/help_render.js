// help_render.js — user-manual topics → HTML (2ac). Shared by /help (help.js, รพ.สต. manual) and the admin tab "คู่มือ" (tab14_manual.js).
// A topic = {id, title, intro, shots:[{img, alt, marks:[{n, sel_key}], steps:["① …"]}], warn?}. The numbered marks are HTML laid over
// the screenshot: their boxes come from help/shots.json ({<img>: {w, h, marks: {<sel_key>: {x, y, w, h}}}}, written by
// tools/capture_help.mjs from the selectors) and are placed in % of the image so they follow the image at any width.
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (v, of) => `${Math.round((v / of) * 10000) / 100}%`;

// shots.json once per page
let shotsPromise = null;
export function loadShots(url) {
  if (!shotsPromise) shotsPromise = fetch(url).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return shotsPromise;
}

function marksHtml(shot, meta) {
  if (!meta || !meta.w || !meta.h) return "";
  return (shot.marks || []).map((m) => {
    const b = meta.marks && meta.marks[m.sel_key];
    if (!b) return "";
    const style = `left:${pct(b.x, meta.w)};top:${pct(b.y, meta.h)};width:${pct(b.w, meta.w)};height:${pct(b.h, meta.h)}`;
    return `<span class="help-mark" style="${style}" aria-hidden="true"><span class="help-mark-n">${esc(m.n)}</span></span>`;
  }).join("");
}

function shotHtml(shot, shots, imgBase) {
  const meta = shots[shot.img];
  const size = meta ? ` width="${meta.w}" height="${meta.h}"` : "";
  return `<figure class="help-shot">
    <div class="help-imgwrap"><img src="${esc(imgBase + shot.img)}" alt="${esc(shot.alt || "")}" loading="lazy"${size}>${marksHtml(shot, meta)}</div>
    ${shot.steps && shot.steps.length ? `<ol class="help-steps">${shot.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
  </figure>`;
}

/** @param {string} prefix id prefix of the section element ("" on /help — anchors are #<id>; "m-" in the admin tab) */
export function topicHtml(t, shots, imgBase, prefix = "") {
  return `<section class="help-topic" id="${esc(prefix + t.id)}">
    <h2>${esc(t.title)}</h2>
    ${t.intro ? `<p class="help-intro">${esc(t.intro)}</p>` : ""}
    ${t.warn ? `<div class="help-warn" role="note">${(Array.isArray(t.warn) ? t.warn : [t.warn]).map((w) => `<p>⚠️ ${esc(w)}</p>`).join("")}</div>` : ""}
    ${(t.shots || []).map((s) => shotHtml(s, shots, imgBase)).join("")}
    ${t.after ? `<ol class="help-steps help-after">${t.after.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
  </section>`;
}

export function tocHtml(topics, hrefOf) {
  return `<ol class="help-toc">${topics.map((t) => `<li><a href="${esc(hrefOf(t))}">${esc(t.title)}</a></li>`).join("")}</ol>`;
}
