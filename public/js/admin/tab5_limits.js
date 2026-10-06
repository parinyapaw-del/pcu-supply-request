// Tab 5 — เพดาน (phase 2.md §5.7 + limit_upload_format.md): mode switch, per PCU x item limits with inline
// edit / reset, Excel download + upload (client parses with SheetJS, server validates via dry_run first),
// and temporary unlocks (adminUnlockLimit / adminRemoveUnlock).
import { formatInt } from "../format.js";
import {
  el, escapeHtml, tableScroll, toast, errMessage, confirmDialog, downloadBlob, getXLSX, formatBangkokDateTime, monthLong
} from "./util.js";
import { planFor } from "./compute.js";

const MODES = [
  { id: "off", label: "ปิด", hint: "ไม่ตรวจเพดาน" },
  { id: "warn", label: "เตือน", hint: "ส่งได้ แต่แสดงคำเตือนเมื่อเกินเพดาน (ค่าตั้งต้น)" },
  { id: "enforce", label: "บังคับ", hint: "ส่งใบเบิกที่เกินเพดานไม่ได้" }
];
const SOURCE_BADGE = {
  plan70: { label: "แผนปี 70", cls: "badge-muted" },
  stat69: { label: "สถิติปี 69", cls: "badge-warn" },
  admin: { label: "admin", cls: "badge-success" }
};
const HEADERS = ["pcu_code", "item_code", "item_name", "limit_month", "limit_year", "note"];

function parseLimitInput(text) {
  const t = String(text).trim();
  if (t === "") return { value: null };
  if (!/^\d+$/.test(t)) return { error: "ต้องเป็นจำนวนเต็ม ≥ 0 หรือเว้นว่าง" };
  return { value: Number(t) };
}

export function renderTab5(container, ctx) {
  const { state } = ctx;
  const b = () => state.bootstrap;
  const ts = { pcu: b().pcus[0].code, onlyActive: true, q: "", preview: null };
  container.innerHTML = "";

  // ---- mode card -------------------------------------------------------------------------------------
  const modeCard = el("div", { class: "admin-card", id: "t5-mode-card" });
  modeCard.appendChild(el("h2", {}, "โหมดเพดานทั้งระบบ"));
  const seg = el("div", { class: "admin-seg", id: "t5-mode", role: "group" });
  const modeHint = el("p", { class: "admin-note", id: "t5-mode-hint" });
  MODES.forEach((m) => {
    const btn = el("button", { type: "button", "data-mode": m.id, id: "t5-mode-" + m.id }, m.label);
    btn.addEventListener("click", () => setMode(m.id));
    seg.appendChild(btn);
  });
  modeCard.appendChild(seg);
  modeCard.appendChild(modeHint);
  container.appendChild(modeCard);
  function drawMode() {
    const cur = b().config.limit_mode;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x.dataset.mode === cur));
    modeHint.textContent = (MODES.find((m) => m.id === cur) || {}).hint || "";
  }
  async function setMode(mode) {
    if (mode === b().config.limit_mode) return;
    if (mode === "enforce") {
      const ok = await confirmDialog("เปลี่ยนเป็นโหมด \"บังคับ\"?\nรพ.สต. จะส่งใบเบิกที่เกินเพดานรายเดือน/รายปีไม่ได้ (ยกเว้นรายการที่ปลดล็อกชั่วคราว)", { title: "บังคับเพดาน", okText: "บังคับ", danger: true });
      if (!ok) return;
    }
    try {
      const res = await ctx.adminCall("adminSetLimitMode", { mode });
      Object.assign(b().config, res.config);
      drawMode();
      toast("เปลี่ยนโหมดเพดานแล้ว");
    } catch (err) { toast(errMessage(err), "err"); }
  }
  drawMode();

  // ---- excel card ------------------------------------------------------------------------------------
  const xlCard = el("div", { class: "admin-card", id: "t5-excel-card" });
  xlCard.appendChild(el("h2", {}, "ดาวน์โหลด / อัปโหลดเพดาน (Excel)"));
  xlCard.appendChild(el("p", { class: "admin-note" }, "ไฟล์ .xlsx แผ่นแรก หัวคอลัมน์ pcu_code, item_code, item_name, limit_month, limit_year, note · ช่อง limit ว่าง = ไม่แตะค่าเดิม (โหมดรวม) · พิมพ์ CLEAR เพื่อลบเพดานของคู่นั้น"));
  const xlRow = el("div", { class: "admin-toolbar" });
  const dlBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t5-download" }, "ดาวน์โหลดเพดานปัจจุบัน");
  const tplBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t5-template" }, "ดาวน์โหลด template ว่าง");
  const fileInput = el("input", { type: "file", accept: ".xlsx,.xls", id: "t5-file" });
  const modeSel = el("select", { class: "select-input", id: "t5-up-mode" }, [
    el("option", { value: "merge" }, "รวมกับของเดิม (merge)"), el("option", { value: "replace" }, "แทนที่ทั้งหมด (replace)")
  ]);
  xlRow.appendChild(dlBtn); xlRow.appendChild(tplBtn);
  xlCard.appendChild(xlRow);
  const upRow = el("div", { class: "admin-toolbar" });
  upRow.appendChild(el("label", {}, ["อัปโหลด: ", fileInput]));
  upRow.appendChild(el("label", {}, ["โหมด: ", modeSel]));
  xlCard.appendChild(upRow);
  const previewHost = el("div", { id: "t5-preview" });
  xlCard.appendChild(previewHost);
  container.appendChild(xlCard);

  function limitRowsForExport(all) {
    const rows = [];
    b().pcus.forEach((p) => {
      const lim = b().limits[p.code] || {};
      state.cat.items.forEach((it) => {
        const l = lim[it.code];
        if (all) rows.push([p.code, it.code, it.name, null, null, null]);
        else if (l && (l.limit_month !== null || l.limit_year !== null)) rows.push([p.code, it.code, it.name, l.limit_month, l.limit_year, l.note || null]);
      });
    });
    return rows;
  }
  async function exportXlsx(rows, filename) {
    try {
      const XLSX = await getXLSX();
      const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows.map((r) => r.map((v) => (v === null ? "" : v)))]);
      ws["!cols"] = [{ wch: 8 }, { wch: 9 }, { wch: 46 }, { wch: 12 }, { wch: 11 }, { wch: 30 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "limits");
      const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      downloadBlob(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
    } catch (err) { toast(errMessage(err), "err"); }
  }
  dlBtn.addEventListener("click", () => {
    const rows = limitRowsForExport(false);
    exportXlsx(rows, `limits_${b().config.fy_current}.xlsx`);
    toast(`ดาวน์โหลดเพดาน ${rows.length} คู่`);
  });
  tplBtn.addEventListener("click", () => exportXlsx(limitRowsForExport(true), `limits_template_${b().config.fy_current}.xlsx`));

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    previewHost.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังอ่านไฟล์...</div>';
    try {
      const XLSX = await getXLSX();
      const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
      if (!json.length) throw new Error("ไฟล์ไม่มีข้อมูล");
      const keys = Object.keys(json[0]).map((k) => k.trim().toLowerCase());
      if (!keys.includes("pcu_code") || !keys.includes("item_code")) throw new Error("ไม่พบหัวคอลัมน์ pcu_code / item_code ในแถวแรกของแผ่นแรก");
      const rows = [];
      json.forEach((o, i) => {
        const r = {};
        Object.entries(o).forEach(([k, v]) => { r[k.trim().toLowerCase()] = typeof v === "string" ? v.trim() : v; });
        const blank = (v) => v === null || v === undefined || v === "";
        if (HEADERS.every((h) => blank(r[h]))) return;
        rows.push({
          row: i + 2,
          pcu_code: blank(r.pcu_code) ? "" : String(r.pcu_code),
          item_code: blank(r.item_code) ? "" : String(r.item_code),
          item_name: blank(r.item_name) ? null : String(r.item_name),
          limit_month: blank(r.limit_month) ? null : r.limit_month,
          limit_year: blank(r.limit_year) ? null : r.limit_year,
          note: blank(r.note) ? null : String(r.note)
        });
      });
      ts.preview = { rows, mode: modeSel.value, filename: f.name };
      await runPreview();
    } catch (err) {
      ts.preview = null;
      previewHost.innerHTML = `<p class="admin-err-text">${escapeHtml(errMessage(err))}</p>`;
    }
  });
  modeSel.addEventListener("change", () => { if (ts.preview) { ts.preview.mode = modeSel.value; runPreview(); } });

  async function runPreview() {
    const pv = ts.preview;
    if (!pv) return;
    previewHost.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังตรวจไฟล์ (dry run)...</div>';
    try {
      const res = await ctx.adminCall("adminLimitsUpload", { rows: pv.rows, mode: pv.mode, dry_run: true });
      pv.result = res;
      drawPreview();
    } catch (err) { previewHost.innerHTML = `<p class="admin-err-text">ตรวจไฟล์ไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`; }
  }

  function oldNewText(v) { return v ? `${v[0] ?? "–"} / ${v[1] ?? "–"}` : "—"; }
  function drawPreview() {
    const pv = ts.preview, r = pv.result;
    const nErr = (r.errors || []).length, nWarn = (r.warnings || []).length, nChg = (r.changes || []).length;
    const box = el("div", { class: "preview-box", id: "t5-preview-box" });
    box.appendChild(el("p", { id: "t5-preview-summary" }, `ไฟล์ ${pv.filename} — ${pv.rows.length} แถว · โหมด ${pv.mode === "replace" ? "แทนที่ทั้งหมด" : "รวมกับของเดิม"} · เพิ่ม ${r.added} · แก้ ${r.updated} · ลบ ${r.deleted} · เปลี่ยนแปลงรวม ${nChg} คู่ · ผิดพลาด ${nErr} · เตือน ${nWarn}`));
    if (nErr) {
      box.appendChild(el("h3", {}, `แถวที่ผิดพลาด (${nErr})`));
      box.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table"><thead><tr><th>แถว</th><th class="left">รพ.สต.</th><th class="left">รายการ</th><th class="left">ปัญหา</th></tr></thead><tbody>${
        r.errors.slice(0, 200).map((e) => `<tr><td class="num">${e.row}</td><td class="left">${escapeHtml(e.pcu_code)}</td><td class="left">${escapeHtml(e.item_code)}</td><td class="left">${escapeHtml(e.error)}</td></tr>`).join("")
      }</tbody></table>`, "short"));
      if (nErr > 200) box.appendChild(el("p", { class: "muted small" }, `แสดง 200 จาก ${nErr} แถว`));
    }
    if (nWarn) {
      box.appendChild(el("h3", {}, `คำเตือน (${nWarn})`));
      box.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table"><thead><tr><th>แถว</th><th class="left">รพ.สต.</th><th class="left">รายการ</th><th class="left">คำเตือน</th></tr></thead><tbody>${
        r.warnings.slice(0, 100).map((e) => `<tr><td class="num">${e.row ?? ""}</td><td class="left">${escapeHtml(e.pcu_code || "")}</td><td class="left">${escapeHtml(e.item_code || "")}</td><td class="left">${escapeHtml(e.warning || e.error || e.message || "")}</td></tr>`).join("")
      }</tbody></table>`, "short"));
    }
    if (nChg) {
      box.appendChild(el("h3", {}, `การเปลี่ยนแปลง (${nChg}) — ค่าเดิม → ค่าใหม่ (เดือน / ปี)`));
      box.insertAdjacentHTML("beforeend", tableScroll(`<table class="admin-table"><thead><tr><th class="left">รพ.สต.</th><th class="left">รายการ</th><th>เดิม</th><th>ใหม่</th></tr></thead><tbody>${
        r.changes.slice(0, 300).map((c) => `<tr><td class="left">${escapeHtml(c.pcu)}</td><td class="left">${escapeHtml(c.item_code)}</td><td class="num">${oldNewText(c.old)}</td><td class="num">${c.new ? oldNewText(c.new) : "<em>ลบ</em>"}</td></tr>`).join("")
      }</tbody></table>`, "short"));
      if (nChg > 300) box.appendChild(el("p", { class: "muted small" }, `แสดง 300 จาก ${nChg} คู่`));
    } else {
      box.appendChild(el("p", { class: "admin-ok-text", id: "t5-no-change" }, "ไม่มีการเปลี่ยนแปลง"));
    }
    const act = el("div", { class: "admin-modal-actions", style: "justify-content:flex-start" });
    const applyBtn = el("button", { type: "button", class: "btn btn-primary", id: "t5-apply" }, nErr ? "นำเข้าเฉพาะแถวที่ถูก" : "นำเข้า");
    applyBtn.disabled = nChg === 0;
    const cancelBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t5-cancel" }, "ยกเลิก");
    act.appendChild(applyBtn); act.appendChild(cancelBtn);
    box.appendChild(act);
    previewHost.innerHTML = "";
    previewHost.appendChild(box);
    cancelBtn.addEventListener("click", () => { ts.preview = null; fileInput.value = ""; previewHost.innerHTML = ""; });
    applyBtn.addEventListener("click", async () => {
      if (pv.mode === "replace") {
        const ok = await confirmDialog("โหมดแทนที่ทั้งหมด จะลบเพดานเดิมของคู่ที่ไม่อยู่ในไฟล์ทุกคู่ — ยืนยัน?", { title: "แทนที่เพดานทั้งหมด", okText: "นำเข้า", danger: true });
        if (!ok) return;
      }
      applyBtn.disabled = true;
      try {
        const res = await ctx.adminCall("adminLimitsUpload", { rows: pv.rows, mode: pv.mode, dry_run: false });
        toast(`นำเข้าแล้ว: เพิ่ม ${res.added} · แก้ ${res.updated} · ลบ ${res.deleted}`);
        ts.preview = null; fileInput.value = ""; previewHost.innerHTML = "";
        await ctx.refreshBootstrap();
        drawTable(); drawUnlocks();
      } catch (err) { toast(errMessage(err), "err"); applyBtn.disabled = false; }
    });
  }

  // ---- limits table ----------------------------------------------------------------------------------
  const tblCard = el("div", { class: "admin-card", id: "t5-table-card" });
  tblCard.appendChild(el("h2", {}, "เพดานต่อ รพ.สต. × รายการ"));
  const bar = el("div", { class: "admin-toolbar" });
  const pcuSel = el("select", { class: "select-input", id: "t5-pcu", "aria-label": "รพ.สต." });
  b().pcus.forEach((p) => pcuSel.appendChild(el("option", { value: p.code }, `${p.code} ${p.name}`)));
  const onlyCb = el("input", { type: "checkbox", id: "t5-only", checked: true });
  const qInput = el("input", { type: "search", placeholder: "ค้นหารายการ / รหัส", id: "t5-q", class: "search-input" });
  bar.appendChild(el("label", {}, ["รพ.สต.: ", pcuSel]));
  bar.appendChild(el("label", { class: "admin-inline-check" }, [onlyCb, "เฉพาะรายการที่มีแผนหรือเพดาน"]));
  bar.appendChild(qInput);
  tblCard.appendChild(bar);
  tblCard.appendChild(el("p", { class: "admin-note" }, "เพดานนับ OP+PP รวม · แก้ช่องแล้วออกจากช่อง (หรือกด Enter) เพื่อบันทึก · เว้นว่าง = ไม่มีเพดาน · \"แผนปี 70\" = แผน OP + PP"));
  const tblHost = el("div", { id: "t5-table" });
  tblCard.appendChild(tblHost);
  container.appendChild(tblCard);
  pcuSel.addEventListener("change", () => { ts.pcu = pcuSel.value; drawTable(); });
  onlyCb.addEventListener("change", () => { ts.onlyActive = onlyCb.checked; drawTable(); });
  qInput.addEventListener("input", () => { ts.q = qInput.value.trim().toLowerCase(); drawTable(); });

  function drawTable() {
    const lim = b().limits[ts.pcu] || (b().limits[ts.pcu] = {});
    let items = state.cat.items.filter((it) => {
      if (ts.q && !(it.name.toLowerCase().includes(ts.q) || it.code.toLowerCase().includes(ts.q))) return false;
      if (ts.onlyActive) {
        const [po, pp] = planFor(b().plans, ts.pcu, it.code);
        const l = lim[it.code];
        return po + pp > 0 || (l && (l.limit_month !== null || l.limit_year !== null));
      }
      return true;
    });
    const rows = items.map((it) => {
      const l = lim[it.code];
      const [po, pp] = planFor(b().plans, ts.pcu, it.code);
      const src = l ? (SOURCE_BADGE[l.source] || { label: l.source, cls: "badge-muted" }) : null;
      return `<tr data-code="${escapeHtml(it.code)}">
        <td class="left code-cell">${escapeHtml(it.code)}</td><td class="left name-cell">${escapeHtml(it.name)}</td><td class="left">${escapeHtml(it.unit)}</td>
        <td class="num plan-cell" title="OP ${po} + PP ${pp}">${po + pp > 0 ? `${formatInt(po)}+${formatInt(pp)}` : "–"}</td>
        <td class="num"><input class="limit-input" data-f="month" inputmode="numeric" value="${l && l.limit_month !== null ? l.limit_month : ""}" aria-label="limit เดือน ${escapeHtml(it.code)}"></td>
        <td class="num"><input class="limit-input" data-f="year" inputmode="numeric" value="${l && l.limit_year !== null ? l.limit_year : ""}" aria-label="limit ปี ${escapeHtml(it.code)}"> <span class="cell-status"></span></td>
        <td class="left">${src ? `<span class="badge ${src.cls}">${escapeHtml(src.label)}</span>` : '<span class="muted">–</span>'}</td>
        <td class="left small">${escapeHtml((l && l.note) || "")}</td>
        <td class="left"><button type="button" class="btn btn-secondary btn-sm" data-reset ${l && l.source === "admin" ? "" : "disabled"} title="คืนเป็นค่าตั้งต้น (แผนปี 70 / สถิติปี 69)">รีเซ็ต</button></td>
      </tr>`;
    }).join("");
    tblHost.innerHTML = `<p class="admin-note">${items.length} รายการ</p>` + tableScroll(`<table class="admin-table admin-table-wide" id="t5-limits-tbl"><thead><tr>
      <th class="left">รหัส</th><th class="left">รายการ</th><th class="left">หน่วย</th><th class="num">แผนปี 70 (OP+PP)</th><th class="num">เพดาน/เดือน</th><th class="num">เพดาน/ปีงบ</th><th class="left">ที่มา</th><th class="left">หมายเหตุ</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="left muted">ไม่มีรายการ</td></tr>'}</tbody></table>`);
    tblHost.querySelectorAll("tr[data-code]").forEach((tr) => {
      const code = tr.dataset.code;
      const inputs = tr.querySelectorAll("input.limit-input");
      const status = tr.querySelector(".cell-status");
      const snapshot = () => Array.from(inputs).map((i) => i.value);
      let last = snapshot().join("|");
      inputs.forEach((inp) => {
        inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") inp.blur(); });
        inp.addEventListener("blur", async () => {
          const cur = snapshot().join("|");
          if (cur === last) return;
          const m = parseLimitInput(inputs[0].value), y = parseLimitInput(inputs[1].value);
          if (m.error || y.error) {
            status.className = "cell-status err"; status.textContent = m.error || y.error;
            inp.classList.add("save-error"); return;
          }
          inputs.forEach((i) => i.classList.remove("save-error"));
          try {
            const res = await ctx.adminCall("adminSetLimit", { pcu: ts.pcu, code, limit_month: m.value, limit_year: y.value });
            const old = lim[code] || {};
            lim[code] = { ...old, ...res.limit };
            last = cur;
            status.className = "cell-status ok"; status.textContent = "บันทึกแล้ว";
            const srcCell = tr.children[6];
            srcCell.innerHTML = `<span class="badge badge-success">admin</span>`;
            tr.querySelector("[data-reset]").disabled = false;
          } catch (err) { status.className = "cell-status err"; status.textContent = errMessage(err); }
        });
      });
      tr.querySelector("[data-reset]").addEventListener("click", async () => {
        try {
          const res = await ctx.adminCall("adminResetLimit", { pcu: ts.pcu, code });
          if (res.limit) lim[code] = res.limit; else delete lim[code];
          toast("รีเซ็ตเป็นค่าตั้งต้นแล้ว");
          drawTable();
        } catch (err) { toast(errMessage(err), "err"); }
      });
    });
  }
  drawTable();

  // ---- unlocks ---------------------------------------------------------------------------------------
  const ulCard = el("div", { class: "admin-card", id: "t5-unlock-card" });
  ulCard.appendChild(el("h2", {}, "ปลดล็อกชั่วคราว (ต่อ รพ.สต. × รายการ × เดือน)"));
  ulCard.appendChild(el("p", { class: "admin-note" }, "รายการที่ปลดล็อกจะไม่ถูกตรวจเพดานในเดือนนั้น แม้อยู่ในโหมดบังคับ"));
  const form = el("div", { class: "unlock-form" });
  const uPcu = el("select", { class: "select-input", id: "t5-u-pcu" }, b().pcus.map((p) => el("option", { value: p.code }, `${p.code} ${p.name}`)));
  const uItem = el("select", { class: "select-input", id: "t5-u-item" }, state.cat.items.map((it) => el("option", { value: it.code }, `${it.code} ${it.name}`)));
  const uMonth = el("input", { type: "month", id: "t5-u-month", value: b().current_month });
  const uReason = el("input", { type: "text", id: "t5-u-reason", placeholder: "เหตุผล (จำเป็น)", maxlength: "200" });
  const uBtn = el("button", { type: "button", class: "btn btn-primary btn-sm", id: "t5-u-add" }, "ปลดล็อก");
  form.appendChild(el("label", {}, ["รพ.สต.: ", uPcu]));
  form.appendChild(el("label", {}, ["รายการ: ", uItem]));
  form.appendChild(el("label", {}, ["เดือน: ", uMonth]));
  form.appendChild(el("label", {}, ["เหตุผล: ", uReason]));
  form.appendChild(uBtn);
  ulCard.appendChild(form);
  const ulHost = el("div", { id: "t5-unlock-list" });
  ulCard.appendChild(ulHost);
  container.appendChild(ulCard);
  uBtn.addEventListener("click", async () => {
    const reason = uReason.value.trim();
    if (!reason) { toast("กรุณากรอกเหตุผล", "err"); uReason.focus(); return; }
    if (!/^\d{4}-\d{2}$/.test(uMonth.value)) { toast("เลือกเดือนให้ถูกต้อง", "err"); return; }
    try {
      const res = await ctx.adminCall("adminUnlockLimit", { pcu: uPcu.value, item_code: uItem.value, month: uMonth.value, reason });
      const list = b().unlocks || (b().unlocks = []);
      const i = list.findIndex((u) => u.pcu === res.unlock.pcu && u.item_code === res.unlock.item_code && u.month === res.unlock.month);
      if (i >= 0) list[i] = res.unlock; else list.push(res.unlock);
      uReason.value = "";
      toast("ปลดล็อกชั่วคราวแล้ว");
      drawUnlocks();
    } catch (err) { toast(errMessage(err), "err"); }
  });
  function drawUnlocks() {
    const list = (b().unlocks || []).slice().sort((a, c) => (a.at < c.at ? 1 : -1));
    const rows = list.map((u) => {
      const it = state.cat.byCode[u.item_code];
      return `<tr data-k="${escapeHtml(u.pcu + "|" + u.item_code + "|" + u.month)}"><td class="left">${escapeHtml(u.pcu)}</td><td class="left">${escapeHtml(u.item_code)} ${escapeHtml(it ? it.name : "")}</td>
        <td class="left">${escapeHtml(monthLong(u.month))}</td><td class="left">${escapeHtml(u.reason)}</td><td class="left small">${escapeHtml(u.by || "")}<br>${escapeHtml(formatBangkokDateTime(u.at))}</td>
        <td class="left"><button type="button" class="btn btn-secondary btn-sm" data-remove>ยกเลิก</button></td></tr>`;
    }).join("");
    ulHost.innerHTML = `<h3>รายการที่ปลดล็อกอยู่ (${list.length})</h3>` + tableScroll(`<table class="admin-table" id="t5-unlock-tbl"><thead><tr><th class="left">รพ.สต.</th><th class="left">รายการ</th><th class="left">เดือน</th><th class="left">เหตุผล</th><th class="left">โดย</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="left muted">ไม่มีรายการ</td></tr>'}</tbody></table>`);
    ulHost.querySelectorAll("tr[data-k]").forEach((tr) => {
      const [pcu, item_code, month] = tr.dataset.k.split("|");
      tr.querySelector("[data-remove]").addEventListener("click", async () => {
        try {
          await ctx.adminCall("adminRemoveUnlock", { pcu, item_code, month });
          b().unlocks = (b().unlocks || []).filter((u) => !(u.pcu === pcu && u.item_code === item_code && u.month === month));
          toast("ยกเลิกการปลดล็อกแล้ว");
          drawUnlocks();
        } catch (err) { toast(errMessage(err), "err"); }
      });
    });
  }
  drawUnlocks();

  return { onShow() { drawMode(); } };
}
