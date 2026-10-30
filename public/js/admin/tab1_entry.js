// Tab 1 — "คีย์/แก้ใบ" (2w): the admin keys / edits / sends a request for a pcu (paper sheets of past rounds) — functions/API.md §5.1b
// adminSaveLines. Any round of fy_current up to the open round; deadline / round lock / ceilings / issued pages do not apply.
// One page (step) at a time; typed values are kept across pages and only changed lines are sent.
import { formatMoney, fiscalYearStartMonthKey, nextMonthKey } from "../format.js";
import { el, escapeHtml, tableScroll, monthLong, openModal, confirmDialog, toast, errMessage } from "./util.js";

const FIELDS = ["stock", "op", "pp"];
const STATUS_TH = { draft: "กำลังกรอก (ยังไม่ส่ง)", submitted: "ส่งแล้ว", issued: "จ่ายแล้ว" };

// Round months of fy_current from its first round up to the open round, newest first.
function entryMonths(ctx) {
  const out = [];
  const last = ctx.roundMonth();
  for (let m = fiscalYearStartMonthKey(ctx.fyCurrent()); m <= last && out.length < 12; m = nextMonthKey(m)) out.push(m);
  return out.reverse();
}

const numOrNull = (v) => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 99999 ? n : NaN;
};

export function openEntry(ctx, pcuCode, month, { onSaved } = {}) {
  const pcu = ctx.state.bootstrap.pcus.find((p) => p.code === pcuCode) || { code: pcuCode, name: pcuCode };
  const months = entryMonths(ctx);
  const st = { month: months.includes(month) ? month : months[0], data: null, step: null, edits: new Map(), busy: false };

  const body = el("div", { class: "entry-body", id: "t1e-body" });
  const top = el("div", { class: "admin-toolbar" });
  const mSel = el("select", { class: "select-input", id: "t1e-month", "aria-label": "รอบ" });
  months.forEach((m) => mSel.appendChild(el("option", { value: m, selected: m === st.month }, `ขอเบิก ${monthLong(m)}`)));
  const sSel = el("select", { class: "select-input", id: "t1e-step", "aria-label": "หน้า" });
  top.appendChild(el("label", {}, ["รอบ: ", mSel]));
  top.appendChild(el("label", {}, ["หน้า: ", sSel]));
  body.appendChild(top);
  const info = el("p", { class: "admin-note", id: "t1e-info" });
  body.appendChild(info);
  body.appendChild(el("p", { class: "muted small" },
    "ตัวเลขที่คีย์ที่นี่คือยอดที่ รพ.สต. ขอเสมอ ไม่ใช่ของที่ได้จริง (ของได้จริง = บันทึกในแท็บจ่ายจริง หรือ รพ.สต. แจ้งเองใน \"รายงานของได้จริง\") · "
    + "admin คีย์แทน รพ.สต. ได้ทุกรอบของปีงบปัจจุบัน — ข้ามกำหนดส่ง/ล็อกรอบ/เพดาน/ล็อกรายการ/หน้าที่จ่ายแล้ว · ใบจะติดป้าย \"คีย์โดย admin\" · ถ้ายอดขอใหม่น้อยกว่ายอดจ่ายเดิม ระบบลดยอดจ่ายให้เท่ายอดขอ"));
  const host = el("div", { id: "t1e-table" });
  body.appendChild(host);
  const actions = el("div", { class: "admin-modal-actions" });
  const closeBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t1e-close" }, "ปิด");
  const saveBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t1e-save" }, "บันทึก");
  const sendBtn = el("button", { type: "button", class: "btn btn-primary", id: "t1e-send" }, "บันทึกและส่ง");
  actions.append(closeBtn, saveBtn, sendBtn);
  body.appendChild(actions);

  let saved = false;
  const m = openModal(`คีย์/แก้ใบแทน — ${pcu.code} ${pcu.name}`, body, { wide: true, onClose: () => { if (saved && onSaved) onSaved(st.month); } });
  m.modal.classList.add("entry-modal");

  const lines = () => (st.data && st.data.request && st.data.request.lines) || {};
  const cur = (code, f) => {
    const e = st.edits.get(code);
    if (e && f in e) return e[f];
    const l = lines()[code];
    return l ? l[f] ?? null : null;
  };
  const steps = () => ((st.data && st.data.form && st.data.form.steps) || []).filter((s) => s.active !== false);

  async function load() {
    host.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังโหลด...</div>';
    try {
      st.data = await ctx.adminCall("adminGetRequest", { pcu: pcu.code, month: st.month });
      st.edits.clear();
      const ss = steps();
      sSel.innerHTML = "";
      ss.forEach((s, i) => sSel.appendChild(el("option", { value: s.code }, `หน้า ${i + 1} · ${s.sheet || s.title || s.code}`)));
      if (!ss.some((s) => s.code === st.step)) st.step = ss[0] ? ss[0].code : null;
      sSel.value = st.step || "";
      draw();
    } catch (err) {
      host.innerHTML = `<p class="admin-err-text">โหลดไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    }
  }

  function drawInfo() {
    const r = st.data && st.data.request;
    const tag = r && r.entry_by === "admin" ? ' <span class="badge badge-info" id="t1e-admin-tag">คีย์โดย admin</span>' : "";
    let baht = 0, n = 0;
    for (const s of steps()) for (const row of s.rows || []) {
      if (row.type !== "item") continue;
      const q = (cur(row.code, "op") || 0) + (cur(row.code, "pp") || 0);
      if (q > 0) { n++; baht += q * (Number(row.price) || 0); }
    }
    info.innerHTML = `สถานะ: <strong id="t1e-status">${escapeHtml(r ? STATUS_TH[r.status] || r.status : "ยังไม่มีใบ")}</strong>${tag}`
      + ` · ขอ ${n} รายการ · ประมาณ ${formatMoney(baht)} บาท (ราคาในแบบฟอร์ม)`
      + (st.edits.size ? ` · <span class="badge badge-warn" id="t1e-dirty">ยังไม่บันทึก ${st.edits.size} รายการ</span>` : "");
  }

  function draw() {
    drawInfo();
    const step = steps().find((s) => s.code === st.step);
    if (!step) { host.innerHTML = '<p class="muted">ไม่มีแบบฟอร์ม</p>'; return; }
    const hidden = new Set((st.data && st.data.hidden) || []);
    const rows = (step.rows || []).map((row) => {
      if (row.type === "section") return `<tr class="section-row"><td colspan="7" class="left"><strong>${escapeHtml(row.title || "")}</strong></td></tr>`;
      if (row.type !== "item" || row.active === false) return "";
      const l = lines()[row.code];
      const iss = l && l.issued_total !== null && l.issued_total !== undefined ? `<span class="muted small" title="ยอดจ่ายที่บันทึกไว้">จ่าย ${l.issued_total}</span>` : "";
      const inp = (f) => `<input type="number" inputmode="numeric" min="0" max="99999" step="1" class="num-input entry-input" data-code="${escapeHtml(row.code)}" data-f="${f}" value="${cur(row.code, f) ?? ""}"${st.edits.has(row.code) && f in st.edits.get(row.code) ? ' data-dirty="1"' : ""}>`;
      return `<tr data-code="${escapeHtml(row.code)}"${hidden.has(row.code) ? ' class="row-hidden" title="รพ.สต. ซ่อนรายการนี้"' : ""}>
        <td class="left">${escapeHtml(row.code)}</td><td class="left">${escapeHtml(row.name || "")}${hidden.has(row.code) ? ' <span class="muted small">(ซ่อน)</span>' : ""}</td>
        <td class="left">${escapeHtml(row.unit || "")}</td><td>${inp("stock")}</td><td>${inp("op")}</td><td>${inp("pp")}</td><td class="left">${iss}</td></tr>`;
    }).join("");
    host.innerHTML = tableScroll(`<table class="admin-table entry-table" id="t1e-tbl">
      <thead><tr><th class="left">รหัส</th><th class="left">รายการ</th><th class="left">หน่วย</th><th>คงเหลือ</th><th>OP</th><th>PP</th><th class="left"></th></tr></thead>
      <tbody>${rows}</tbody></table>`);
    host.querySelectorAll(".entry-input").forEach((inp) => inp.addEventListener("input", () => {
      const code = inp.dataset.code, f = inp.dataset.f;
      const v = numOrNull(inp.value);
      inp.classList.toggle("input-error", Number.isNaN(v));
      const e = st.edits.get(code) || {};
      const l = lines()[code];
      if (!Number.isNaN(v) && (l ? l[f] ?? null : null) === v) delete e[f]; else e[f] = v;
      if (Object.keys(e).length) st.edits.set(code, e); else st.edits.delete(code);
      inp.dataset.dirty = f in e ? "1" : "";
      drawInfo();
    }));
  }

  async function confirmDiscard() {
    if (!st.edits.size) return true;
    return confirmDialog(`มี ${st.edits.size} รายการที่ยังไม่บันทึก — ทิ้งการแก้ไข?`, { okText: "ทิ้ง", danger: true });
  }

  async function save(send) {
    if (st.busy) return;
    const payload = {};
    for (const [code, e] of st.edits) {
      if (Object.values(e).some((v) => Number.isNaN(v))) { toast(`${code}: จำนวนต้องเป็นเลขจำนวนเต็ม 0–99999`, "err"); return; }
      const o = {};
      for (const f of FIELDS) o[f] = f in e ? e[f] : cur(code, f);
      payload[code] = o;
    }
    if (!send && !Object.keys(payload).length) { toast("ไม่มีรายการที่แก้"); return; }
    if (send) {
      const ok = await confirmDialog(`ส่งใบ ขอเบิก ${monthLong(st.month)} แทน ${pcu.code} ${pcu.name}?\nใบจะเข้าคิวจ่ายของหน่วยจ่าย และติดป้าย "คีย์โดย admin"`,
        { okText: "บันทึกและส่ง" });
      if (!ok) return;
    }
    st.busy = true; saveBtn.disabled = true; sendBtn.disabled = true;
    try {
      const res = await ctx.adminCall("adminSaveLines", { pcu: pcu.code, month: st.month, lines: payload, send });
      saved = true;
      st.data.request = res.request;
      st.edits.clear();
      draw();
      const done = send ? "บันทึกและส่งแล้ว" : "บันทึกแล้ว";
      if (res.clamped && res.clamped.length) { // shown longer (err style) so the admin reads which issued figures moved
        toast(`${done} · ลดยอดจ่ายให้เท่ายอดขอ ${res.clamped.length} รายการ: ` + res.clamped.map((c) => `${c.code} ${c.from}→${c.to}`).join(", "), "err");
      } else toast(done);
    } catch (err) {
      toast(errMessage(err), "err");
    } finally {
      st.busy = false; saveBtn.disabled = false; sendBtn.disabled = false;
    }
  }

  mSel.addEventListener("change", async () => {
    if (!(await confirmDiscard())) { mSel.value = st.month; return; }
    st.month = mSel.value;
    load();
  });
  sSel.addEventListener("change", () => { st.step = sSel.value; draw(); });
  saveBtn.addEventListener("click", () => save(false));
  sendBtn.addEventListener("click", () => save(true));
  closeBtn.addEventListener("click", async () => { if (await confirmDiscard()) m.close(); });

  load();
  return m;
}
