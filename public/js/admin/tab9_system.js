// Tab 9 — ระบบ (phase 2.md §5.11): backup password, seed import, stock_required switch, clear trial data,
// backup now, audit log. Admin only.
import {
  el, escapeHtml, tableScroll, toast, errMessage, confirmDialog, formDialog, downloadJson, formatBangkokDateTime, monthLong
} from "./util.js";
import { getAdminToken } from "../api.js";
import { startPdfDownload } from "../pdf_client.js";

const CHUNK_BYTES = 800 * 1024;

export function renderTab9(container, ctx) {
  const { state } = ctx;
  const b = () => state.bootstrap;
  container.innerHTML = "";

  // ---- backup password (Google admin only) ------------------------------------------------------------
  const pwCard = el("div", { class: "admin-card", id: "t9-pw-card" });
  pwCard.appendChild(el("h2", {}, "รหัสผ่านสำรอง"));
  if (state.me.email === "backup") {
    pwCard.appendChild(el("p", { class: "admin-note" }, "ตั้ง/เปลี่ยนรหัสสำรองได้เฉพาะเมื่อเข้าด้วยบัญชี Google"));
  } else {
    pwCard.appendChild(el("p", { class: "admin-note" }, "ใช้เข้าหน้านี้เมื่อ Google Sign-In ใช้ไม่ได้ (สิทธิ์ admin) · อย่างน้อย 8 ตัวอักษร · การเปลี่ยนรหัสจะออกจากระบบทุกคนที่เข้าด้วยรหัสสำรอง"));
    const pw1 = el("input", { type: "password", id: "t9-pw1", autocomplete: "new-password", placeholder: "รหัสผ่านใหม่ (≥ 8 ตัวอักษร)" });
    const pw2 = el("input", { type: "password", id: "t9-pw2", autocomplete: "new-password", placeholder: "ยืนยันรหัสผ่าน" });
    const btn = el("button", { type: "button", class: "btn btn-primary btn-sm", id: "t9-pw-save" }, "ตั้งรหัสผ่านสำรอง");
    const msg = el("p", { class: "admin-note", id: "t9-pw-msg" });
    btn.addEventListener("click", async () => {
      msg.className = "admin-err-text";
      if (pw1.value.length < 8) { msg.textContent = "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร"; return; }
      if (pw1.value !== pw2.value) { msg.textContent = "รหัสผ่านไม่ตรงกัน"; return; }
      try {
        await ctx.adminCall("adminSetBackupPassword", { password: pw1.value });
        pw1.value = ""; pw2.value = "";
        msg.className = "admin-ok-text"; msg.textContent = "ตั้งรหัสผ่านสำรองแล้ว";
      } catch (err) { msg.textContent = errMessage(err); }
    });
    pwCard.appendChild(el("div", { class: "pw-grid" }, [pw1, pw2, btn]));
    pwCard.appendChild(msg);
  }
  container.appendChild(pwCard);

  // ---- seed import -----------------------------------------------------------------------------------------
  const impCard = el("div", { class: "admin-card", id: "t9-import-card" });
  impCard.appendChild(el("h2", {}, "นำเข้าข้อมูลตั้งต้น (pcu-supply-import/1)"));
  impCard.appendChild(el("p", { class: "admin-note" }, "เลือกไฟล์ JSON (เช่น seed_2570.json) — รันซ้ำได้ ไม่ทับใบเบิก/ผู้ใช้/PIN/เพดานที่ admin แก้ · แผน/สถิติ/ข้อมูลปีก่อนของปีนั้นจะถูกแทนที่ทั้งปี"));
  const file = el("input", { type: "file", accept: ".json,application/json", id: "t9-seed-file" });
  const setFy = el("input", { type: "checkbox", id: "t9-set-fy" });
  const impMsg = el("div", { id: "t9-import-result" });
  impCard.appendChild(el("div", { class: "admin-toolbar" }, [file, el("label", { class: "admin-inline-check" }, [setFy, "ตั้งเป็นปีงบปัจจุบัน (set_current_fy)"])]));
  impCard.appendChild(impMsg);

  // 2d: download the live DB state in the same import format (adminExportSeed)
  const expBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t9-export-seed" }, "ดาวน์โหลดข้อมูลตั้งต้นปัจจุบัน (JSON)");
  const expMsg = el("p", { class: "admin-note", id: "t9-export-msg" }, "ไฟล์นี้อยู่ในรูปแบบเดียวกับไฟล์นำเข้า — เก็บไว้เป็นต้นฉบับหลังแก้ฟอร์ม/เพดาน");
  expBtn.addEventListener("click", async () => {
    expBtn.disabled = true;
    try {
      const res = await ctx.adminCall("adminExportSeed", {});
      const seed = res.seed;
      const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
      downloadJson(seed, `seed_${seed.fy || b().config.fy_current}_${ymd}.json`);
      toast("ดาวน์โหลดข้อมูลตั้งต้นแล้ว");
    } catch (err) { toast("ดาวน์โหลดไม่สำเร็จ: " + errMessage(err), "err"); } finally { expBtn.disabled = false; }
  });
  impCard.appendChild(el("hr"));
  impCard.appendChild(el("div", { class: "admin-toolbar" }, [expBtn]));
  impCard.appendChild(expMsg);
  container.appendChild(impCard);

  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    impMsg.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังอ่านและนำเข้า...</div>';
    try {
      const text = await f.text();
      let seed;
      try { seed = JSON.parse(text); } catch (e) { throw new Error("ไฟล์ไม่ใช่ JSON ที่ถูกต้อง"); }
      if (!seed || seed.format !== "pcu-supply-import/1") throw new Error(`รูปแบบไฟล์ไม่ถูกต้อง (format = ${seed && seed.format ? seed.format : "ไม่มี"}) — ต้องเป็น "pcu-supply-import/1"`);
      if (!Number.isInteger(seed.fy)) throw new Error("ไม่พบ fy (ปีงบ พ.ศ.) ในไฟล์");
      const ok = await confirmDialog(`นำเข้าข้อมูลตั้งต้นปีงบ ${seed.fy} จากไฟล์ ${f.name} (${Math.round(f.size / 1024)} KB)?\nแผน/สถิติ/ข้อมูลปีก่อนของปีงบนี้จะถูกแทนที่`, { title: "นำเข้าข้อมูลตั้งต้น", okText: "นำเข้า" });
      if (!ok) { impMsg.innerHTML = ""; file.value = ""; return; }
      const results = [];
      if (f.size > CHUNK_BYTES && seed.actual_prev) {
        const { actual_prev, ...rest } = seed;
        results.push(await ctx.adminCall("adminImportSeed", { seed: rest, set_current_fy: setFy.checked }));
        results.push(await ctx.adminCall("adminImportSeed", { seed: { format: seed.format, fy: seed.fy, actual_prev } }));
      } else {
        results.push(await ctx.adminCall("adminImportSeed", { seed, set_current_fy: setFy.checked }));
      }
      showImportResult(results);
      await ctx.refreshBootstrap();
      ctx.markStale(["tab4"]);
    } catch (err) {
      impMsg.innerHTML = `<p class="admin-err-text">นำเข้าไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
    } finally {
      file.value = "";
    }
  });

  function showImportResult(results) {
    const merged = {};
    const warnings = [];
    results.forEach((r) => {
      Object.entries(r.imported || {}).forEach(([k, v]) => {
        if (v === 0 || v === null || v === undefined || v === "none") { if (!(k in merged)) merged[k] = v; return; }
        merged[k] = v;
      });
      (r.warnings || []).forEach((w) => warnings.push(w));
    });
    const LABEL = { pcus: "รพ.สต.", form: "ฟอร์ม", plans: "แถวแผน", actual_rows: "แถวเบิกจริงปีก่อน", prices_prev: "ราคาปีก่อน", stats: "แถวสถิติ", limits_inserted: "เพดานที่เพิ่ม", limits_kept_admin: "เพดานที่ admin แก้ (คงไว้)", config_set: "config ที่ตั้งใหม่" };
    const rows = Object.entries(merged).map(([k, v]) => `<tr><td class="left">${escapeHtml(LABEL[k] || k)}</td><td class="left" data-k="${escapeHtml(k)}">${escapeHtml(Array.isArray(v) ? (v.join(", ") || "–") : String(v))}</td></tr>`).join("");
    impMsg.innerHTML = `<p class="admin-ok-text" id="t9-import-ok">นำเข้าสำเร็จ${results.length > 1 ? ` (${results.length} ส่วน)` : ""}</p>`
      + tableScroll(`<table class="admin-table" id="t9-import-tbl"><tbody>${rows}</tbody></table>`)
      + (warnings.length ? `<h3>คำเตือน (${warnings.length})</h3><ul>${warnings.slice(0, 50).map((w) => `<li>${escapeHtml(typeof w === "string" ? w : JSON.stringify(w))}</li>`).join("")}</ul>` : "");
  }

  // ---- stock_required --------------------------------------------------------------------------------------
  const stCard = el("div", { class: "admin-card", id: "t9-stock-card" });
  stCard.appendChild(el("h2", {}, "บังคับกรอกคงเหลือ"));
  const stCb = el("input", { type: "checkbox", id: "t9-stock-required", checked: !!b().config.stock_required });
  stCard.appendChild(el("label", { class: "admin-inline-check" }, [stCb, "บังคับให้กรอกช่อง \"คงเหลือ\" ทุกรายการก่อนส่ง"]));
  stCard.appendChild(el("p", { class: "admin-note" }, "ปิดไว้เป็นค่าตั้งต้น — ช่องคงเหลือยังกรอกได้ตามปกติ"));
  stCb.addEventListener("change", async () => {
    const want = stCb.checked ? 1 : 0;
    try {
      const res = await ctx.adminCall("adminSetConfig", { key: "stock_required", value: want });
      Object.assign(b().config, res.config);
      toast(want ? "เปิดบังคับกรอกคงเหลือแล้ว" : "ปิดบังคับกรอกคงเหลือแล้ว");
    } catch (err) { stCb.checked = !stCb.checked; toast(errMessage(err), "err"); }
  });
  container.appendChild(stCard);

  // ---- backup now / clear trial ------------------------------------------------------------------------------
  const opCard = el("div", { class: "admin-card", id: "t9-ops-card" });
  opCard.appendChild(el("h2", {}, "สำรองข้อมูล / ล้างข้อมูลทดลอง"));
  const bkBtn = el("button", { type: "button", class: "btn btn-secondary", id: "t9-backup-now" }, "Export backup ตอนนี้");
  const bkMsg = el("p", { class: "admin-note", id: "t9-backup-msg" });
  bkBtn.addEventListener("click", async () => {
    bkBtn.disabled = true;
    try {
      const res = await ctx.adminCall("adminBackupNow", {});
      bkMsg.className = "admin-ok-text";
      bkMsg.textContent = `สำรองแล้ว: ${res.key} (${Math.round((res.size || 0) / 1024)} KB)` + (res.deleted && res.deleted.length ? ` · ลบของเก่า ${res.deleted.length} ไฟล์` : "");
    } catch (err) { bkMsg.className = "admin-err-text"; bkMsg.textContent = errMessage(err); } finally { bkBtn.disabled = false; }
  });
  opCard.appendChild(el("div", { class: "admin-toolbar" }, [bkBtn]));
  opCard.appendChild(bkMsg);

  opCard.appendChild(el("hr"));
  opCard.appendChild(el("p", { class: "admin-note" }, "ล้างเฉพาะ \"ใบเบิก\" (ใบ รายการในใบ สถานะการจ่าย ไฟล์ PDF) — ไม่แตะผู้ใช้ PIN แผน เพดาน ฟอร์ม และ audit log · ใช้ก่อนเริ่มใช้งานจริงเท่านั้น ย้อนกลับไม่ได้"));
  const clrBtn = el("button", { type: "button", class: "btn btn-danger", id: "t9-clear" }, "ล้างข้อมูลทดลอง...");
  const clrMsg = el("p", { class: "admin-note", id: "t9-clear-msg" });
  clrBtn.addEventListener("click", async () => {
    const res = await formDialog("ล้างข้อมูลทดลอง", [
      { key: "confirm", label: "พิมพ์ \"ล้างข้อมูล\" เพื่อยืนยัน", required: true, placeholder: "ล้างข้อมูล" }
    ], { okText: "ล้างใบเบิกทั้งหมด", intro: "จะลบใบเบิกทุกเดือนของทุกแห่ง — ย้อนกลับไม่ได้ (แนะนำให้ Export backup ก่อน)", validate: (v) => (v.confirm === "ล้างข้อมูล" ? "" : "ต้องพิมพ์ \"ล้างข้อมูล\" ให้ตรง") });
    if (!res) return;
    try {
      const out = await ctx.adminCall("adminClearTrial", { confirm: res.confirm });
      clrMsg.className = "admin-ok-text";
      clrMsg.textContent = `ล้างแล้ว: ใบ ${out.deleted_requests} · รายการ ${out.deleted_lines} · สถานะจ่าย ${out.deleted_issue_status} · PDF ${out.deleted_pdf_files}`;
      await ctx.refreshBootstrap();
    } catch (err) { clrMsg.className = "admin-err-text"; clrMsg.textContent = errMessage(err); }
  });
  opCard.appendChild(el("div", { class: "admin-toolbar" }, [clrBtn]));
  opCard.appendChild(clrMsg);
  container.appendChild(opCard);

  // ---- stored PDF files + R2 usage (2b-R: adminPdfFiles / adminPdfPrune / adminSetConfig r2_max_*) -----------------
  const pdfCard = el("div", { class: "admin-card", id: "t9-pdf-card" });
  pdfCard.appendChild(el("h2", {}, "ไฟล์ PDF ที่เก็บไว้"));
  const pdfBar = el("div", { class: "admin-toolbar" });
  const pdfReload = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t9-pdf-reload" }, "โหลดใหม่");
  const pdfPrune = el("button", { type: "button", class: "btn btn-danger btn-sm", id: "t9-pdf-prune" }, "ตัดไฟล์เก่าตอนนี้");
  pdfBar.appendChild(pdfReload); pdfBar.appendChild(pdfPrune);
  pdfCard.appendChild(pdfBar);
  const pdfHost = el("div", { id: "t9-pdf-host" });
  pdfCard.appendChild(pdfHost);
  container.appendChild(pdfCard);

  const R2_DEFAULTS = { r2_max_bytes: 1000000000, r2_max_class_a: 100000, r2_max_class_b: 1000000 };
  const fmtMB = (n) => ((Number(n) || 0) / 1e6).toFixed(1);
  const fmtInt = (n) => (Number(n) || 0).toLocaleString("en-US");
  const pdfState = { files: [], seq: 0, loading: false };

  function usageRow(id, label, used, cap, free, fmt) {
    const pctCap = cap > 0 ? (used / cap) * 100 : 0;
    const pctFree = free > 0 ? (used / free) * 100 : 0;
    const cls = pctCap >= 100 ? " over" : (pctCap >= 70 ? " warn" : "");
    const width = Math.max(0, Math.min(100, pctCap));
    return `<div class="t9-pdf-usage-row" id="${id}">
      <div class="t9-pdf-usage-label"><span>${escapeHtml(label)}</span><span class="t9-pdf-usage-text">${escapeHtml(fmt(used))} / ${escapeHtml(fmt(cap))} (${pctFree.toFixed(2)} % ของ free tier)</span></div>
      <div class="t9-pdf-bar"><div class="t9-pdf-bar-fill${cls}" id="${id}-fill" style="width:${width.toFixed(1)}%"></div></div></div>`;
  }

  function drawPdf(res) {
    const files = Array.isArray(res.files) ? res.files : [];
    const u = res.usage || {};
    const lim = u.limits || {};
    const free = u.free_tier || { bytes: 10000000000, class_a: 1000000, class_b: 10000000 };
    const rule = res.rule || {};
    pdfState.files = files;

    const ruleLine = `เก็บ: เดือนล่าสุด${rule.latest_month ? ` (${monthLong(rule.latest_month)})` : ""} ${rule.keep_latest ?? 2} เวอร์ชัน · เดือนอื่น ${rule.keep_other ?? 1} เวอร์ชัน · ลบไฟล์เก่ากว่า ${rule.months ?? 12} เดือน`;
    const capBytes = lim.r2_max_bytes || R2_DEFAULTS.r2_max_bytes;
    const capA = lim.r2_max_class_a || R2_DEFAULTS.r2_max_class_a;
    const capB = lim.r2_max_class_b || R2_DEFAULTS.r2_max_class_b;

    const rows = files.map((f, i) => `<tr><td class="left">${escapeHtml(f.pcu_name || f.pcu || "")}${f.pcu_name && f.pcu ? ` <span class="muted small">${escapeHtml(f.pcu)}</span>` : ""}</td>
      <td class="left">${escapeHtml(f.month ? monthLong(f.month) : "")}</td>
      <td class="left small">${escapeHtml(f.created_at ? formatBangkokDateTime(f.created_at) : "")}</td>
      <td class="num">${f.bytes === null || f.bytes === undefined ? "–" : escapeHtml((f.bytes / 1024).toFixed(1))}</td>
      <td class="left small"><code>${escapeHtml(String(f.content_key || "").slice(0, 8))}</code></td>
      <td class="left"><button type="button" class="btn btn-secondary btn-sm" data-act="open" data-idx="${i}">เปิด</button></td></tr>`).join("");

    pdfHost.innerHTML = `<p class="admin-note" id="t9-pdf-summary">ไฟล์ ${fmtInt(res.total_files ?? files.length)} · ขนาดรวม ${fmtMB(res.total_bytes)} MB · ${escapeHtml(ruleLine)}</p>
      <h3>การใช้ R2 เดือนนี้ (UTC)${u.period ? ` — ${escapeHtml(u.period)}` : ""}</h3>
      <div id="t9-pdf-usage">
        ${usageRow("t9-pdf-use-bytes", "พื้นที่ (PDF + backup)", u.bytes_total ?? ((u.pdf_bytes || 0) + (u.backup_bytes || 0)), capBytes, free.bytes, (n) => `${fmtMB(n)} MB`)}
        ${usageRow("t9-pdf-use-a", "Class A (เขียน/list)", u.class_a || 0, capA, free.class_a, fmtInt)}
        ${usageRow("t9-pdf-use-b", "Class B (ดาวน์โหลด)", u.class_b || 0, capB, free.class_b, fmtInt)}
      </div>
      <p class="admin-note" id="t9-pdf-renders">สร้าง PDF วันนี้ ${fmtInt(u.renders_today)} ครั้ง · เดือนนี้ ${fmtInt(u.renders_month)} ครั้ง (Browser Rendering free = 10 นาที/วัน, Cloudflare ตัดเอง ไม่คิดเงิน)</p>
      <div id="t9-pdf-caps"></div>
      <hr>
      ${files.length
        ? tableScroll(`<table class="admin-table" id="t9-pdf-tbl"><thead><tr><th class="left">รพ.สต.</th><th class="left">เดือน</th><th class="left">สร้างเมื่อ</th><th class="num">ขนาด (KB)</th><th class="left">เวอร์ชัน</th><th class="left">ลิงก์</th></tr></thead><tbody>${rows}</tbody></table>`, "tall")
        : '<p class="muted" id="t9-pdf-empty">ยังไม่มีไฟล์ PDF บน server</p>'}`;

    pdfHost.querySelectorAll('[data-act="open"]').forEach((btn) => btn.addEventListener("click", () => {
      const f = pdfState.files[Number(btn.dataset.idx)];
      if (!f || !f.url) return;
      const token = getAdminToken();
      if (!token) { toast("ไม่พบ token ผู้ดูแล — เข้าสู่ระบบใหม่", "err"); return; }
      startPdfDownload(f.url, token);
    }));

    // cap form: blank = default (sent as null); only changed keys are sent
    const capDefs = [
      ["r2_max_bytes", "พื้นที่สูงสุด (bytes)", capBytes],
      ["r2_max_class_a", "Class A สูงสุด/เดือน", capA],
      ["r2_max_class_b", "Class B สูงสุด/เดือน", capB]
    ];
    const inputs = {};
    const capBar = el("div", { class: "admin-toolbar" });
    capDefs.forEach(([key, label, cur]) => {
      const inp = el("input", { type: "number", min: 1, step: 1, inputmode: "numeric", id: `t9-pdf-cap-${key}`, placeholder: `ค่าตั้งต้น ${fmtInt(R2_DEFAULTS[key])}`, value: String(cur) });
      inputs[key] = inp;
      capBar.appendChild(el("label", {}, [label, inp]));
    });
    const capSave = el("button", { type: "button", class: "btn btn-primary btn-sm", id: "t9-pdf-caps-save" }, "บันทึกเพดาน");
    capBar.appendChild(capSave);
    const capMsg = el("p", { class: "admin-note", id: "t9-pdf-caps-msg" }, "เว้นว่าง = ค่าตั้งต้น (10 % ของ free tier) · เพดานเป็นตัวกันไม่ให้เกิดค่าใช้จ่าย R2");
    capSave.addEventListener("click", async () => {
      capMsg.className = "admin-err-text";
      const todo = [];
      for (const [key, , cur] of capDefs) {
        const raw = inputs[key].value.trim();
        let want;
        if (raw === "") want = null;
        else {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1) { capMsg.textContent = "เพดานต้องเป็นจำนวนเต็ม ≥ 1 (หรือเว้นว่าง = ค่าตั้งต้น)"; return; }
          want = n;
        }
        if ((want === null ? R2_DEFAULTS[key] : want) !== cur) todo.push([key, want]);
      }
      if (!todo.length) { capMsg.className = "admin-note"; capMsg.textContent = "ไม่มีค่าที่เปลี่ยน"; return; }
      capSave.disabled = true;
      try {
        for (const [key, value] of todo) {
          const r = await ctx.adminCall("adminSetConfig", { key, value });
          if (r && r.config && b() && b().config) Object.assign(b().config, r.config);
        }
        toast("บันทึกเพดานแล้ว");
        await loadPdf();
      } catch (err) { capMsg.textContent = errMessage(err); } finally { capSave.disabled = false; }
    });
    const capHost = pdfHost.querySelector("#t9-pdf-caps");
    capHost.appendChild(el("h3", {}, "เพดานการใช้ R2"));
    capHost.appendChild(capBar);
    capHost.appendChild(capMsg);
  }

  async function loadPdf() {
    const my = ++pdfState.seq;
    pdfReload.disabled = true;
    try {
      const res = await ctx.adminCall("adminPdfFiles", {});
      if (my !== pdfState.seq) return;
      drawPdf(res || {});
    } catch (err) {
      if (my !== pdfState.seq) return;
      pdfState.files = [];
      pdfHost.innerHTML = `<p class="admin-err-text" id="t9-pdf-err">${escapeHtml(errMessage(err))}</p>`;
    } finally { if (my === pdfState.seq) pdfReload.disabled = false; }
  }
  pdfReload.addEventListener("click", () => loadPdf());
  pdfPrune.addEventListener("click", async () => {
    const ok = await confirmDialog("ตัดไฟล์ PDF เก่าตามกฎที่เก็บไว้ตอนนี้?\nไฟล์ที่เกินกฎจะถูกลบออกจาก server (สร้างใหม่ได้เมื่อกดดาวน์โหลดอีกครั้ง)", { title: "ตัดไฟล์เก่า", okText: "ตัดไฟล์", danger: true });
    if (!ok) return;
    pdfPrune.disabled = true;
    try {
      const r = await ctx.adminCall("adminPdfPrune", {});
      toast(`ลบ ${(r.deleted || []).length} ไฟล์ (${fmtMB(r.bytes)} MB)`);
      await loadPdf();
    } catch (err) {
      pdfHost.innerHTML = `<p class="admin-err-text" id="t9-pdf-err">${escapeHtml(errMessage(err))}</p>`;
    } finally { pdfPrune.disabled = false; }
  });

  // ---- audit log -----------------------------------------------------------------------------------------------
  const auCard = el("div", { class: "admin-card", id: "t9-audit-card" });
  auCard.appendChild(el("h2", {}, "Audit log"));
  const auBar = el("div", { class: "admin-toolbar" });
  const auReload = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t9-audit-reload" }, "โหลดใหม่");
  const auMore = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t9-audit-more" }, "โหลดเพิ่ม");
  const auDl = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t9-audit-dl" }, "ดาวน์โหลด JSON");
  const auInfo = el("span", { class: "muted small", id: "t9-audit-info" });
  auBar.appendChild(auReload); auBar.appendChild(auMore); auBar.appendChild(auDl); auBar.appendChild(auInfo);
  auCard.appendChild(auBar);
  const auHost = el("div", { id: "t9-audit-host" });
  auCard.appendChild(auHost);
  container.appendChild(auCard);

  const au = { entries: [], next: null, loading: false };
  async function loadAudit(more) {
    if (au.loading) return;
    au.loading = true;
    try {
      const params = { limit: 100 };
      if (more && au.next) params.before = au.next;
      const res = await ctx.adminCall("adminAuditLog", params);
      au.entries = more ? au.entries.concat(res.entries) : res.entries;
      au.next = res.next_before;
      drawAudit();
    } catch (err) { auHost.innerHTML = `<p class="admin-err-text">${escapeHtml(errMessage(err))}</p>`; } finally { au.loading = false; }
  }
  function drawAudit() {
    auInfo.textContent = `โหลดแล้ว ${au.entries.length} รายการ`;
    auMore.disabled = !au.next;
    const rows = au.entries.map((e) => `<tr><td class="num">${e.id}</td><td class="left small">${escapeHtml(formatBangkokDateTime(e.ts))}</td><td class="left">${escapeHtml(e.actor)}</td><td class="left">${escapeHtml(e.role || "")}</td>
      <td class="left"><strong>${escapeHtml(e.action)}</strong></td><td class="left">${escapeHtml(e.pcu || "")}</td><td class="left">${escapeHtml(e.month || "")}</td><td class="left name-cell">${escapeHtml(e.detail || "")}</td></tr>`).join("");
    auHost.innerHTML = tableScroll(`<table class="admin-table admin-table-wide" id="t9-audit-tbl"><thead><tr><th>#</th><th class="left">เวลา</th><th class="left">ผู้ทำ</th><th class="left">role</th><th class="left">การกระทำ</th><th class="left">รพ.สต.</th><th class="left">เดือน</th><th class="left">รายละเอียด</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="left muted">ไม่มีรายการ</td></tr>'}</tbody></table>`, "tall");
  }
  auReload.addEventListener("click", () => loadAudit(false));
  auMore.addEventListener("click", () => loadAudit(true));
  auDl.addEventListener("click", () => downloadJson({ exported_at: new Date().toISOString(), count: au.entries.length, entries: au.entries }, `audit_log_${new Date().toISOString().slice(0, 10)}.json`));
  loadAudit(false);
  loadPdf();

  return { onShow() { stCb.checked = !!b().config.stock_required; loadPdf(); loadAudit(false); } };
}
