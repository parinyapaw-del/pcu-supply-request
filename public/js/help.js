// help.js — public user manual for รพ.สต. (/help, 2ac). No login: manual_pcu.js + help/shots.json + faqList without a token.
// Only the รพ.สต. manual is loaded here — the dispenser / admin manual lives in admin.html (tab "คู่มือ").
import { call } from "./api.js";
import { faqListHtml, mountFeedbackWidget } from "./feedback_widget.js";
import { topicHtml, tocHtml, loadShots } from "./help_render.js";
import MANUAL from "../help/manual_pcu.js";

const IMG_BASE = "help/img/";

async function render() {
  const shots = await loadShots("help/shots.json");
  document.getElementById("help-toc").innerHTML = tocHtml([...MANUAL, { id: "faq", title: "คำถามที่พบบ่อย" }], (t) => "#" + t.id);
  document.getElementById("help-body").innerHTML = MANUAL.map((t) => topicHtml(t, shots, IMG_BASE)).join("");
  // the page was opened with #<id> before the sections existed → jump now
  if (location.hash.length > 1) {
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) target.scrollIntoView();
  }
}

async function renderFaq() {
  const box = document.getElementById("help-faq");
  try {
    const d = await call("faqList", {});
    box.innerHTML = faqListHtml(d.faqs || []);
  } catch (err) {
    box.innerHTML = `<p class="fb-err">โหลดคำถามที่พบบ่อยไม่สำเร็จ — ลองใหม่ภายหลัง</p>`;
  }
}

// 💬 as guest (no ❓ here — this is the manual)
mountFeedbackWidget({ getAuth: () => null, getContext: () => ({ app: "help", section: location.hash.replace(/^#/, "") }) });
render();
renderFaq();
