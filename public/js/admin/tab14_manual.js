// tab14_manual.js — "คู่มือ" tab (2ac): the dispenser manual for every staff role + the admin manual (grouped by how often the job comes
// up) for admin only, then the FAQ of the signed-in role (faqList with the token). Content = help/manual_staff.js, loaded only here
// (never linked from /help). "#manual?s=<id>" (the ❓ button) scrolls to that section.
import { el } from "./util.js";
import { faqListHtml } from "../feedback_widget.js";
import { topicHtml, tocHtml, loadShots } from "../help_render.js";

const IMG_BASE = "help/img/";

export function renderTab14(container, ctx) {
  const isAdmin = ctx.state.isAdmin;
  const wrap = el("div", { class: "admin-card help-admin", id: "t14-manual" });
  wrap.appendChild(el("p", { class: "muted" }, "กำลังโหลดคู่มือ..."));
  container.appendChild(wrap);
  let ready = false, wanted = null;

  // read on show: admin.js rewrites the hash to "#manual" right after onShow
  function readWanted() { wanted = new URLSearchParams(location.hash.split("?")[1] || "").get("s"); }
  function scrollToWanted() {
    const target = wanted && document.getElementById("m-" + wanted);
    if (target) target.scrollIntoView({ block: "start" });
  }

  Promise.all([import("../../help/manual_staff.js"), loadShots(IMG_BASE.replace("img/", "shots.json"))]).then(([mod, shots]) => {
    const parts = [{ title: "คู่มือผู้จ่าย (หน่วยจ่าย พัสดุ / จ่ายกลาง / LAB)", topics: mod.DISPENSER }];
    if (isAdmin) parts.push(...mod.ADMIN_PARTS);
    const all = parts.flatMap((p) => p.topics);
    wrap.innerHTML = `
      <h2>คู่มือการใช้งาน${isAdmin ? " — ผู้จ่าย + ผู้ดูแลระบบ" : " — ผู้จ่าย"}</h2>
      <p class="muted">ภาพเป็นข้อมูลตัวอย่าง ไม่ใช่ยอดจริง · คู่มือของ รพ.สต. อยู่ที่ <a href="/help" target="_blank" rel="noopener">/help</a> (แจกลิงก์ให้ รพ.สต. ได้)</p>
      <nav aria-label="สารบัญคู่มือ">${tocHtml([...all, { id: "faq", title: "คำถามที่พบบ่อย" }], (t) => "#manual?s=" + t.id)}</nav>
      ${parts.map((p) => `<h2 class="help-part">${p.title}</h2>${p.topics.map((t) => topicHtml(t, shots, IMG_BASE, "m-")).join("")}`).join("")}
      <section class="help-topic" id="m-faq"><h2>คำถามที่พบบ่อย</h2><div id="t14-faq"><p class="muted">กำลังโหลด...</p></div></section>`;
    ready = true;
    scrollToWanted();
    ctx.adminCall("faqList", {}).then((d) => {
      const box = document.getElementById("t14-faq");
      if (box) box.innerHTML = faqListHtml(d.faqs || []);
    }).catch(() => {
      const box = document.getElementById("t14-faq");
      if (box) box.innerHTML = `<p class="admin-err-text">โหลดคำถามที่พบบ่อยไม่สำเร็จ</p>`;
    });
  }).catch((err) => {
    wrap.innerHTML = `<p class="admin-err-text">โหลดคู่มือไม่สำเร็จ: ${String(err && err.message || err)}</p>`;
  });

  // deferred: activate() scrolls the tab button into view right after onShow
  return { onShow: () => { readWanted(); if (ready) setTimeout(scrollToWanted, 0); } };
}
