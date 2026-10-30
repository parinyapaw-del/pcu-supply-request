// Tab 13 — Feedback (2ab, admin only; functions/API.md §5.6): feedback review (filters · status · reply · CSV · "สร้าง FAQ จาก feedback นี้")
// + FAQ editor (adminFaqSave / adminFaqDelete, preview through faq_render.js). The tab badge = count of status "new" (ctx.setFeedbackBadge).
import { el, escapeHtml, toast, errMessage, confirmDialog, formatBangkokDateTime, downloadBlob } from "./util.js";
import { FB_CATEGORIES, FB_LEGACY_CATEGORIES, FB_STATUS, fbCategoryLabel } from "../feedback_widget.js";
import { renderFaqAnswer } from "../faq_render.js";
import { csvField } from "../pages/dashboard_calc.js";

const ROLE_LABEL = { pcu: "รพ.สต.", dispenser: "ผู้จ่าย", admin: "admin", guest: "ไม่ได้ login" };
const AUD = [["pcu", "รพ.สต."], ["dispenser", "ผู้จ่าย"], ["admin", "admin"]];
const STATUS_CLS = { new: "badge-warn", ack: "badge-info", fixed: "badge-success" };
const CTX_LABEL = { app: "หน้า", route: "route", tab: "แท็บ", step: "ขั้นตอน", month: "รอบ", request: "ใบ", fy: "ปีงบ", pcu: "pcu", unit: "หน่วย", mode: "โหมด", screen: "จอ", ua: "เบราว์เซอร์" };
const PAGE = 100;

export function renderTab13(container, ctx) {
  const { state } = ctx;
  container.innerHTML = "";
  const pcus = state.bootstrap.pcus || [];
  const pcuName = (code) => { const p = pcus.find((x) => x.code === code); return p ? `${p.code} ${p.name}` : code; };
  const f = { role: "", category: "", status: "", pcu: "" };
  let items = [], nextBefore = null;
  let faqs = [];

  // ---------------- feedback ----------------
  const fbCard = el("div", { class: "admin-card", id: "t13-fb" });
  const faqCard = el("div", { class: "admin-card", id: "t13-faq" });
  container.appendChild(fbCard);
  container.appendChild(faqCard);

  fbCard.appendChild(el("h2", {}, "ความคิดเห็น (feedback)"));
  fbCard.appendChild(el("p", { class: "admin-note" }, "ใหม่ → รับทราบ → แก้แล้ว · คำตอบจะแสดงให้ผู้ส่งเห็น (รพ.สต. ที่หน้า \"ความคิดเห็นของฉัน\" · ผู้จ่าย/admin ที่ปุ่ม 💬 → \"ที่ส่งแล้ว\") · เก็บทุกข้อถาวร"));
  const sel = (id, label, opts) => {
    const s = el("select", { class: "select-input", id });
    s.appendChild(el("option", { value: "" }, "ทั้งหมด"));
    opts.forEach(([v, l]) => s.appendChild(el("option", { value: v }, l)));
    return [el("label", { class: "t13-filter" }, [label + " ", s]), s];
  };
  const [roleL, roleS] = sel("t13-role", "ผู้ส่ง", Object.entries(ROLE_LABEL));
  const [catL, catS] = sel("t13-cat", "หมวด", [...FB_CATEGORIES, ...FB_LEGACY_CATEGORIES].map((c) => [c.value, c.label]));
  const [stL, stS] = sel("t13-status", "สถานะ", Object.entries(FB_STATUS));
  const [pcuL, pcuS] = sel("t13-pcu", "รพ.สต.", pcus.map((p) => [p.code, `${p.code} ${p.name}`]));
  const csvBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t13-csv" }, "ส่งออก CSV");
  fbCard.appendChild(el("div", { class: "admin-toolbar" }, [roleL, catL, stL, pcuL, csvBtn]));
  const countsLine = el("p", { class: "t13-counts", id: "t13-counts" });
  const listBox = el("div", { id: "t13-list" });
  const moreBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t13-more", style: "display:none" }, "โหลดเพิ่ม");
  fbCard.appendChild(countsLine);
  fbCard.appendChild(listBox);
  fbCard.appendChild(moreBtn);

  [[roleS, "role"], [catS, "category"], [stS, "status"], [pcuS, "pcu"]].forEach(([s, k]) => s.addEventListener("change", () => { f[k] = s.value; load(false); }));
  moreBtn.addEventListener("click", () => load(true));
  csvBtn.addEventListener("click", exportCsv);

  const params = () => Object.fromEntries(Object.entries(f).filter(([, v]) => v));

  function setCounts(c) {
    countsLine.innerHTML = `<span class="badge badge-warn">ใหม่ ${c.new}</span> <span class="badge badge-info">รับทราบ ${c.ack}</span> <span class="badge badge-success">แก้แล้ว ${c.fixed}</span>`;
    ctx.setFeedbackBadge(c.new);
  }

  async function load(more) {
    if (!more) listBox.innerHTML = `<p class="muted">กำลังโหลด...</p>`;
    moreBtn.disabled = true;
    try {
      const d = await ctx.adminCall("adminFeedbackList", { ...params(), limit: PAGE, ...(more && nextBefore ? { before: nextBefore } : {}) });
      items = more ? items.concat(d.items) : d.items;
      nextBefore = d.next_before;
      setCounts(d.counts);
      drawList();
    } catch (err) {
      listBox.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    } finally { moreBtn.disabled = false; }
  }

  function whoText(x) {
    if (x.role === "pcu") return x.anonymous ? "นิรนาม (รพ.สต. ไม่ระบุชื่อ)" : pcuName(x.pcu);
    if (x.role === "guest") return (x.pcu ? pcuName(x.pcu) + " " : "") + "(ไม่ได้ login)";
    return `${x.email} (${ROLE_LABEL[x.role]})`;
  }
  function ctxText(c) {
    if (!c) return "";
    return Object.keys(c).filter((k) => k !== "client_at").map((k) => `${CTX_LABEL[k] || k}: ${typeof c[k] === "object" ? JSON.stringify(c[k]) : c[k]}`).join(" · ");
  }

  function drawList() {
    listBox.innerHTML = "";
    if (!items.length) listBox.appendChild(el("p", { class: "muted" }, "ไม่มีรายการตามตัวกรอง"));
    items.forEach((x) => listBox.appendChild(itemCard(x)));
    moreBtn.style.display = nextBefore ? "" : "none";
  }

  function itemCard(x) {
    const card = el("div", { class: "t13-item t13-st-" + x.status, "data-id": String(x.id) });
    card.appendChild(el("div", { class: "t13-item-head" }, [
      el("span", { class: "badge " + (STATUS_CLS[x.status] || "badge-muted") }, FB_STATUS[x.status] || x.status),
      el("strong", {}, ` #${x.id} `),
      el("span", {}, whoText(x)),
      el("span", { class: "muted" }, ` · ${formatBangkokDateTime(x.created_at)} · ${fbCategoryLabel(x.category)}`),
    ]));
    card.appendChild(el("div", { class: "fb-body" }, x.body));
    const ct = ctxText(x.context);
    if (ct) card.appendChild(el("div", { class: "t13-ctx muted" }, "บริบท: " + ct));

    const stBox = el("div", { class: "t13-status-btns" });
    Object.entries(FB_STATUS).forEach(([v, l]) => {
      const b = el("button", { type: "button", class: "btn btn-sm " + (x.status === v ? "btn-primary" : "btn-secondary"), "data-status": v, disabled: x.status === v }, l);
      b.addEventListener("click", () => update(x, { status: v }, b));
      stBox.appendChild(b);
    });
    const faqBtn = el("button", { type: "button", class: "btn btn-sm btn-secondary", "data-faq-from": String(x.id) }, "สร้าง FAQ จาก feedback นี้");
    faqBtn.addEventListener("click", () => openFaqForm(null, x));
    stBox.appendChild(faqBtn);
    card.appendChild(stBox);

    if (x.anonymous) {
      card.appendChild(el("p", { class: "admin-note" }, "นิรนาม — ตอบกลับรายคนไม่ได้ ตอบได้ทาง FAQ"));
    } else {
      const ta = el("textarea", { rows: 2, maxlength: 2000, class: "t13-reply", placeholder: "พิมพ์คำตอบถึงผู้ส่ง (เว้นว่าง = ไม่มีคำตอบ)" });
      ta.value = x.reply || "";
      const save = el("button", { type: "button", class: "btn btn-sm btn-primary" }, "บันทึกคำตอบ");
      save.addEventListener("click", () => update(x, { reply: ta.value }, save));
      const meta = x.reply ? el("span", { class: "muted" }, ` ตอบแล้ว ${formatBangkokDateTime(x.reply_at)} โดย ${x.reply_by || ""}`) : null;
      card.appendChild(el("div", { class: "t13-reply-box" }, [
        ta, el("div", {}, [save, meta]),
        x.role === "guest" ? el("p", { class: "admin-note" }, "ผู้ส่งไม่ได้ login — จะไม่เห็นคำตอบในระบบ (ถ้าเป็นเรื่องทั่วไป ทำเป็น FAQ)") : null,
      ]));
    }
    return card;
  }

  async function update(x, change, btn) {
    btn.disabled = true;
    try {
      const d = await ctx.adminCall("adminFeedbackUpdate", { id: x.id, ...change });
      const i = items.findIndex((y) => y.id === x.id);
      if (i >= 0) items[i] = d.item;
      const old = listBox.querySelector(`.t13-item[data-id="${x.id}"]`);
      if (old) old.replaceWith(itemCard(d.item));
      toast(change.status ? `#${x.id} → ${FB_STATUS[change.status]}` : "บันทึกคำตอบแล้ว");
      if (change.status) {
        // refresh the counts / badge (one cheap read)
        const c = await ctx.adminCall("adminFeedbackList", { limit: 1 });
        setCounts(c.counts);
      }
    } catch (err) { toast(errMessage(err), "err"); btn.disabled = false; }
  }

  async function exportCsv() {
    csvBtn.disabled = true;
    try {
      let all = [], before = null;
      for (let i = 0; i < 50; i++) {
        const d = await ctx.adminCall("adminFeedbackList", { ...params(), limit: 1000, ...(before ? { before } : {}) });
        all = all.concat(d.items);
        before = d.next_before;
        if (!before) break;
      }
      const head = ["id", "เวลา", "วันที่ (ไทย)", "ผู้ส่ง", "รพ.สต.", "อีเมล", "นิรนาม", "หมวด", "ข้อความ", "สถานะ", "เปลี่ยนสถานะเมื่อ", "เปลี่ยนโดย", "คำตอบ", "ตอบเมื่อ", "ตอบโดย", "บริบท"];
      const lines = [head.map(csvField).join(",")];
      all.forEach((x) => lines.push([
        x.id, formatBangkokDateTime(x.created_at), x.day, ROLE_LABEL[x.role] || x.role, x.pcu || "", x.email || "", x.anonymous ? "ใช่" : "",
        fbCategoryLabel(x.category), x.body, FB_STATUS[x.status] || x.status, x.status_at ? formatBangkokDateTime(x.status_at) : "", x.status_by || "",
        x.reply || "", x.reply_at ? formatBangkokDateTime(x.reply_at) : "", x.reply_by || "", x.context ? JSON.stringify(x.context) : "",
      ].map(csvField).join(",")));
      const text = "﻿" + lines.join("\r\n") + "\r\n";
      const stamp = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
      downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), `feedback_${stamp}.csv`);
      toast(`ส่งออก ${all.length} แถว`);
    } catch (err) { toast(errMessage(err), "err"); } finally { csvBtn.disabled = false; }
  }

  // ---------------- FAQ ----------------
  faqCard.appendChild(el("h2", {}, "คำถามที่พบบ่อย (FAQ)"));
  faqCard.appendChild(el("p", { class: "admin-note" }, "FAQ กลุ่ม รพ.สต. อ่านได้โดยไม่ต้อง login · ผู้จ่าย/admin อ่านได้หลัง login · ลบแล้วกู้คืนไม่ได้ — แนะนำ \"ซ่อน\" แทน"));
  const addBtn = el("button", { type: "button", class: "btn btn-primary", id: "t13-faq-add" }, "+ เพิ่มคำถาม");
  addBtn.addEventListener("click", () => openFaqForm(null, null));
  faqCard.appendChild(el("div", { class: "admin-toolbar" }, [addBtn]));
  const formBox = el("div", { id: "t13-faq-form", class: "t13-faq-form", style: "display:none" });
  const faqList = el("div", { id: "t13-faq-list" });
  faqCard.appendChild(formBox);
  faqCard.appendChild(faqList);

  async function loadFaq() {
    try {
      faqs = (await ctx.adminCall("faqList", { all: true })).faqs;
      drawFaq();
    } catch (err) { faqList.innerHTML = `<p class="admin-err-text">โหลด FAQ ไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`; }
  }

  function drawFaq() {
    faqList.innerHTML = "";
    if (!faqs.length) { faqList.appendChild(el("p", { class: "muted" }, "ยังไม่มี FAQ")); return; }
    faqs.forEach((q) => {
      const row = el("div", { class: "t13-faq-row" + (q.hidden ? " t13-faq-hidden" : ""), "data-faq": String(q.id) });
      row.appendChild(el("div", { class: "t13-faq-q" }, [
        el("strong", {}, q.question),
        el("span", { class: "muted" }, ` · ${q.category || "ไม่มีหมวด"} · ลำดับ ${q.sort} · ผู้อ่าน: ${q.aud.map((a) => (AUD.find((x) => x[0] === a) || [a, a])[1]).join(", ")}`),
        q.hidden ? el("span", { class: "badge badge-muted" }, "ซ่อน") : null,
        q.from_feedback_id ? el("span", { class: "muted" }, ` · จาก feedback #${q.from_feedback_id}`) : null,
      ]));
      row.appendChild(el("div", { class: "t13-faq-a", html: renderFaqAnswer(q.answer) }));
      const edit = el("button", { type: "button", class: "btn btn-sm btn-secondary" }, "แก้");
      edit.addEventListener("click", () => openFaqForm(q, null));
      const hide = el("button", { type: "button", class: "btn btn-sm btn-secondary" }, q.hidden ? "แสดง" : "ซ่อน");
      hide.addEventListener("click", () => saveFaq({ id: q.id, question: q.question, answer: q.answer, aud: q.aud, category: q.category, sort: q.sort, hidden: !q.hidden }, hide));
      const del = el("button", { type: "button", class: "btn btn-sm btn-danger" }, "ลบ");
      del.addEventListener("click", async () => {
        if (!(await confirmDialog(`ลบถาวร กู้คืนไม่ได้ — แนะนำซ่อนแทน\n\n"${q.question}"`, { title: "ลบ FAQ", okText: "ลบถาวร", danger: true }))) return;
        try { await ctx.adminCall("adminFaqDelete", { id: q.id, confirm: "ลบ" }); toast("ลบแล้ว"); loadFaq(); } catch (err) { toast(errMessage(err), "err"); }
      });
      row.appendChild(el("div", { class: "t13-faq-actions" }, [edit, hide, del]));
      faqList.appendChild(row);
    });
  }

  async function saveFaq(payload, btn) {
    if (btn) btn.disabled = true;
    try {
      await ctx.adminCall("adminFaqSave", payload);
      toast("บันทึก FAQ แล้ว");
      formBox.style.display = "none";
      await loadFaq();
      return true;
    } catch (err) { toast(errMessage(err), "err"); return false; } finally { if (btn) btn.disabled = false; }
  }

  // q = FAQ to edit (null = new) · fb = feedback to start from (prefills the question)
  function openFaqForm(q, fb) {
    formBox.innerHTML = "";
    formBox.style.display = "";
    formBox.appendChild(el("h3", {}, q ? `แก้ FAQ #${q.id}` : fb ? `FAQ ใหม่จาก feedback #${fb.id}` : "FAQ ใหม่"));
    const qIn = el("input", { type: "text", id: "t13-q", maxlength: 300 });
    qIn.value = q ? q.question : fb ? fb.body.replace(/\s+/g, " ").slice(0, 300) : "";
    const aIn = el("textarea", { id: "t13-a", rows: 6, maxlength: 5000 });
    aIn.value = q ? q.answer : "";
    const preview = el("div", { class: "t13-preview", id: "t13-preview" });
    const upd = () => { preview.innerHTML = aIn.value.trim() ? renderFaqAnswer(aIn.value) : `<span class="muted">ตัวอย่างคำตอบ</span>`; };
    aIn.addEventListener("input", upd);
    upd();
    const defAud = q ? q.aud : fb ? [fb.role === "dispenser" ? "dispenser" : fb.role === "admin" ? "admin" : "pcu"] : ["pcu"];
    const audCbs = AUD.map(([v, l]) => {
      const cb = el("input", { type: "checkbox", value: v, checked: defAud.includes(v) });
      return [cb, el("label", { class: "admin-inline-check" }, [cb, l])];
    });
    const cats = [...new Set(faqs.map((x) => x.category).filter(Boolean))];
    const dl = el("datalist", { id: "t13-cats" }, cats.map((c) => el("option", { value: c })));
    const catIn = el("input", { type: "text", id: "t13-cat-in", maxlength: 60, list: "t13-cats" });
    catIn.value = q ? q.category || "" : "";
    const sortIn = el("input", { type: "number", id: "t13-sort", step: 1 });
    sortIn.value = q ? String(q.sort) : "0";
    const hidCb = el("input", { type: "checkbox", id: "t13-hidden", checked: q ? q.hidden : false });
    const errP = el("p", { class: "admin-err-text", style: "display:none" });
    const save = el("button", { type: "button", class: "btn btn-primary", id: "t13-faq-save" }, "บันทึก FAQ");
    const cancel = el("button", { type: "button", class: "btn btn-secondary" }, "ยกเลิก");
    cancel.addEventListener("click", () => { formBox.style.display = "none"; });
    save.addEventListener("click", async () => {
      const aud = audCbs.filter(([cb]) => cb.checked).map(([cb]) => cb.value);
      const msg = !qIn.value.trim() ? "กรุณากรอกคำถาม" : !aIn.value.trim() ? "กรุณากรอกคำตอบ" : !aud.length ? "เลือกกลุ่มผู้อ่านอย่างน้อย 1 กลุ่ม" : "";
      if (msg) { errP.textContent = msg; errP.style.display = ""; return; }
      const payload = { question: qIn.value, answer: aIn.value, aud, category: catIn.value, sort: Number(sortIn.value) || 0, hidden: hidCb.checked };
      if (q) payload.id = q.id;
      if (fb) payload.from_feedback_id = fb.id;
      await saveFaq(payload, save);
    });
    formBox.append(
      el("label", { class: "admin-form-field" }, [el("span", {}, "คำถาม *"), qIn]),
      el("label", { class: "admin-form-field" }, [el("span", {}, "คำตอบ * — **ตัวหนา** · [ข้อความลิงก์](https://…) · ขึ้นบรรทัดใหม่ได้"), aIn]),
      el("div", { class: "admin-form-field" }, [el("span", {}, "ตัวอย่าง"), preview]),
      el("div", { class: "admin-form-field" }, [el("span", {}, "กลุ่มผู้อ่าน *"), el("div", { class: "unit-checks" }, audCbs.map((x) => x[1]))]),
      el("div", { class: "t13-faq-inline" }, [
        el("label", { class: "admin-form-field" }, [el("span", {}, "หมวด"), catIn, dl]),
        el("label", { class: "admin-form-field" }, [el("span", {}, "ลำดับ"), sortIn]),
        el("label", { class: "admin-inline-check" }, [hidCb, "ซ่อน"]),
      ]),
      errP,
      el("div", { class: "admin-modal-actions" }, [cancel, save]),
    );
    formBox.scrollIntoView({ block: "start", behavior: "smooth" });
    qIn.focus({ preventScroll: true });
  }

  load(false);
  loadFaq();
  return {};
}
