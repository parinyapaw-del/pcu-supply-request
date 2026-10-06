// Tab 11 — นำเข้า / เปิดปีงบใหม่ (phase 2.md §5.10, briefs/2e_frontend.md). Admin only.
// 3-step wizard: (1) files — Excel form + plan (parsed in the browser with SheetJS) or an import_<ปี>.json,
// (2) item mapping to the current codes (exact / fuzzy / new; every non-exact row confirmed),
// (3) server preview (adminImportPreview) → download the JSON → "เปิดปีงบ <fy>" (adminImportApply).
// Parsing / mapping / JSON building are pure and live in import_parse.js (shared with tools/check_import_2570.mjs).
import { formatMoney } from "../format.js";
import { el, escapeHtml, tableScroll, toast, errMessage, confirmDialog, formDialog, downloadJson, getXLSX } from "./util.js";
import {
  parseFormWorkbook, parsePlanWorkbook, mapItems, resolveMapping, buildImportJson, validateImportJson,
  mapJsonItems, buildFromJson, round2, similarity, FUZZY_MIN
} from "./import_parse.js";

const ALL_TABS = ["tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7", "tab8", "tab9", "tab10"];
const KIND_LABEL = { exact: "ตรงกัน", fuzzy: "ใกล้เคียง", new: "รายการใหม่", file: "รหัสจากไฟล์", manual: "เลือกเอง" };
const fmt = (n) => (n === null || n === undefined ? "–" : formatMoney(n));
const pct = (x) => `${Math.round((x || 0) * 100)}%`;

export function renderTab11(container, ctx) {
  const { state } = ctx;
  const b = () => state.bootstrap;
  container.innerHTML = "";
  container.classList.add("t11-root");

  const fyCur = () => Number(b().config.fy_current) || 0;
  const w = {
    step: 1,
    fy: fyCur() + 1,
    source: null,          // "excel" | "json"
    formFile: null, planFile: null, jsonFile: null,
    parsed: null,          // {form, plan}
    json: null,            // uploaded JSON object
    mapping: null,
    seed: null,            // built import JSON (step 3)
    preview: null,
    busy: false,
    filter: "all"
  };

  const head = el("div", { class: "admin-card t11-head", id: "t11-head" });
  const body = el("div", { id: "t11-body" });
  container.appendChild(head);
  container.appendChild(body);

  function drawHead() {
    head.innerHTML = "";
    head.appendChild(el("h2", {}, "นำเข้า / เปิดปีงบใหม่"));
    head.appendChild(el("p", { class: "admin-note" },
      `ปีงบปัจจุบัน ${fyCur()} · อัปโหลดไฟล์แบบฟอร์มเบิก + ไฟล์ประมาณการของปีใหม่ (หรือไฟล์ import_<ปี>.json) → จับคู่รายการกับรหัสเดิม → ตรวจสอบ → เปิดปีงบ`));
    const steps = el("ol", { class: "t11-steps", id: "t11-steps" });
    ["ไฟล์", "จับคู่รายการ", "ตรวจสอบ + ยืนยัน"].forEach((t, i) => {
      const n = i + 1;
      steps.appendChild(el("li", { class: (w.step === n ? "active" : "") + (w.step > n ? " done" : ""), "data-step": n }, [el("span", { class: "t11-step-no" }, String(n)), t]));
    });
    head.appendChild(steps);
  }

  function go(step) {
    w.step = step;
    drawHead();
    body.innerHTML = "";
    if (step === 1) drawStep1();
    else if (step === 2) drawStep2();
    else drawStep3();
    try { head.scrollIntoView({ block: "start" }); } catch (e) { /* ignore */ }
  }

  // ================================================================================================================================
  // step 1 — files
  // ================================================================================================================================
  function drawStep1() {
    const card = el("div", { class: "admin-card", id: "t11-step1" });
    card.appendChild(el("h3", {}, "ขั้น 1 — ไฟล์"));

    const fyIn = el("input", { type: "number", id: "t11-fy", min: 2500, max: 2700, value: w.fy, inputmode: "numeric", class: "t11-fy-input" });
    fyIn.addEventListener("change", () => {
      const v = Number(fyIn.value);
      w.fy = Number.isInteger(v) ? v : fyCur() + 1;
      fyHint.textContent = fyHintText();
      if (w.parsed) drawReport();
    });
    const fyHint = el("span", { class: "muted small", id: "t11-fy-hint" });
    const fyHintText = () => (w.fy === fyCur() + 1 ? `เปิดปีงบใหม่ (ปีงบปัจจุบัน ${fyCur()} จะย้ายไปแท็บ "ปีก่อน")`
      : w.fy === fyCur() ? "ปีงบเดียวกับปัจจุบัน — ดูตัวอย่างได้ แต่เปิดปีงบไม่ได้ (ใช้ \"นำเข้าข้อมูลตั้งต้น\" ที่แท็บระบบแทน)"
        : `ระบบเปิดได้เฉพาะปีงบ ${fyCur() + 1}`);
    fyHint.textContent = fyHintText();
    card.appendChild(el("div", { class: "admin-toolbar" }, [el("label", { for: "t11-fy" }, "ปีงบที่จะเปิด (พ.ศ.)"), fyIn, fyHint]));

    // (A) Excel
    const formIn = el("input", { type: "file", id: "t11-form-file", accept: ".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const planIn = el("input", { type: "file", id: "t11-plan-file", accept: ".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = el("div", { class: "t11-src", id: "t11-src-excel" });
    a.appendChild(el("h4", {}, "(A) ไฟล์ Excel 2 ไฟล์"));
    a.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, "แบบฟอร์มเบิก ปี XXXX (.xls/.xlsx — 1 แผ่น = 1 หน้า)"), formIn]));
    a.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, "ประมาณการ ปีงบ XX (.xls/.xlsx — แผ่นรวมทุก รพ.สต.)"), planIn]));
    const b1 = el("div", { class: "t11-src", id: "t11-src-json" });
    const jsonIn = el("input", { type: "file", id: "t11-json-file", accept: ".json,application/json" });
    b1.appendChild(el("h4", {}, "(B) หรือไฟล์ import_<ปี>.json"));
    b1.appendChild(el("label", { class: "admin-form-field" }, [el("span", {}, "ไฟล์ JSON ที่ได้จาก AI หรือที่ดาวน์โหลดจากขั้น 3"), jsonIn]));
    const guide = el("a", { class: "btn btn-secondary btn-sm", id: "t11-guide", href: "docs/import_template.md", download: "import_template.md" }, "ดาวน์โหลดคู่มือ+แม่แบบสำหรับ AI");
    b1.appendChild(el("p", { class: "admin-note" }, "รูปแบบไฟล์เปลี่ยนจนอ่านไม่ได้? ส่งไฟล์ Excel + คู่มือนี้ให้ Claude/AI แปลงเป็น import_<ปี>.json แล้วอัปโหลดที่ช่องนี้"));
    b1.appendChild(guide);
    card.appendChild(el("div", { class: "t11-src-grid" }, [a, b1]));

    const report = el("div", { id: "t11-report" });
    card.appendChild(report);
    const next = el("button", { type: "button", class: "btn btn-primary", id: "t11-next1", disabled: true }, "ถัดไป: จับคู่รายการ");
    card.appendChild(el("div", { class: "admin-toolbar t11-nav" }, [next]));
    body.appendChild(card);

    function setNext() {
      const okExcel = w.source === "excel" && w.parsed && w.parsed.form.pages.length && w.parsed.plan && !w.parsed.plan.error;
      const okJson = w.source === "json" && w.json && !w.jsonCheck.errors.length;
      next.disabled = !(okExcel || okJson) || w.busy;
      next.textContent = okJson && w.jsonCheck.allCoded ? "ถัดไป: ตรวจสอบ (ข้ามขั้นจับคู่ — ทุกรายการมีรหัส)" : "ถัดไป: จับคู่รายการ";
    }

    async function readExcel() {
      if (!w.formFile || !w.planFile) {
        w.source = "excel"; w.parsed = null;
        report.innerHTML = `<p class="admin-note">${w.formFile ? "เลือกไฟล์ประมาณการด้วย" : w.planFile ? "เลือกไฟล์แบบฟอร์มเบิกด้วย" : ""}</p>`;
        setNext();
        return;
      }
      w.busy = true; setNext();
      report.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังอ่านไฟล์ Excel...</div>';
      try {
        const XLSX = await getXLSX();
        const [fb, pb] = await Promise.all([w.formFile.arrayBuffer(), w.planFile.arrayBuffer()]);
        const fwb = XLSX.read(fb, { type: "array" });
        const pwb = XLSX.read(pb, { type: "array" });
        const form = parseFormWorkbook(fwb);
        const plan = parsePlanWorkbook(pwb, b().pcus);
        w.source = "excel"; w.json = null; w.mapping = null; w.seed = null;
        w.parsed = { form, plan };
        drawReport();
      } catch (err) {
        w.parsed = null;
        report.innerHTML = `<p class="admin-err-text">อ่านไฟล์ไม่สำเร็จ: ${escapeHtml(errMessage(err))}</p>`;
      } finally { w.busy = false; setNext(); }
    }

    function drawReport() {
      if (w.source !== "excel" || !w.parsed) return;
      const { form, plan } = w.parsed;
      const probe = form.pages.length ? mapItems({ form, plan: plan.error ? null : plan }, b().form) : null;
      const pageRows = form.pages.map((p, i) => {
        const pg = probe ? probe.pages[i] : null;
        const items = p.rows.filter((r) => r.type === "item");
        return `<tr><td class="left">${escapeHtml(p.sheet)}</td><td class="left">${pg ? `<strong>${escapeHtml(pg.step_code)}</strong> <span class="muted small">(${escapeHtml(pg.step_how)})</span>` : "–"}</td>
          <td class="num">${items.length}</td><td class="left small">${items.length ? `${items[0].seq}–${items[items.length - 1].seq}` : ""}</td>
          <td class="left small">${escapeHtml(p.rows.filter((r) => r.type === "section").map((r) => r.title).join(" · "))}</td></tr>`;
      }).join("");
      let html = `<h4>ผลการอ่านไฟล์</h4>`;
      html += `<p><strong>แบบฟอร์ม:</strong> ${form.pages.length} หน้า · ${form.items} รายการ` + (form.skipped.length ? ` · ข้ามแผ่น: ${escapeHtml(form.skipped.map((s) => `${s.sheet} (${s.reason})`).join(", "))}` : "") + "</p>";
      html += tableScroll(`<table class="admin-table" id="t11-pages-tbl"><thead><tr><th class="left">แผ่น</th><th class="left">หน้าในระบบ</th><th>รายการ</th><th class="left">ลำดับ</th><th class="left">หัวหมวด</th></tr></thead><tbody>${pageRows || '<tr><td colspan="5" class="left admin-err-text">ไม่พบตารางรายการ (ลำดับ/รายการ/หน่วย/ราคา) ในไฟล์นี้</td></tr>'}</tbody></table>`);
      if (plan.error) html += `<p class="admin-err-text" id="t11-plan-err">ไฟล์ประมาณการ: ${escapeHtml(plan.error)}</p>`;
      else {
        const names = Object.fromEntries(b().pcus.map((p) => [p.code, p.name]));
        html += `<p id="t11-plan-info"><strong>ประมาณการ:</strong> แผ่น "${escapeHtml(plan.sheet)}" <span class="muted small">(เลือกจาก${escapeHtml(plan.sheet_rule)}${plan.candidates.length > 1 ? ` · แผ่นที่มีชื่อ รพ.สต. ${escapeHtml(plan.candidates.join(", "))}` : ""})</span> · ${plan.items.length} รายการ · รพ.สต. ${plan.pcus.length}/${b().pcus.length}`
          + (plan.missing_pcus.length ? ` · <span class="admin-err-text">ไม่พบ: ${escapeHtml(plan.missing_pcus.map((c) => names[c] || c).join(", "))}</span>` : " ✓")
          + ` · แถว "รวมเป็นเงิน" ${plan.totals.row === null ? '<span class="admin-err-text">ไม่พบ</span>' : `แถว ${plan.totals.row + 1}`}`
          + (plan.totals.network ? ` · ยอดรวมเครือข่ายในไฟล์ <strong>${fmt(plan.totals.network.total)}</strong> บาท (OP ${fmt(plan.totals.network.op)} / PP ${fmt(plan.totals.network.pp)})` : "") + "</p>";
        const hdr = plan.pcus.map((p) => `${escapeHtml(names[p.code] || p.code)} ← "${escapeHtml(p.header)}"`).join(" · ");
        html += `<details class="t11-details"><summary>หัวคอลัมน์ รพ.สต. ที่พบ (${plan.pcus.length})</summary><p class="small">${hdr}</p></details>`;
      }
      const warns = [...form.warnings, ...(plan.error ? [] : plan.warnings), ...(probe ? probe.warnings : [])];
      if (probe && probe.plan_unmatched.length) warns.push(`รายการในไฟล์ประมาณการที่ไม่ตรงกับแบบฟอร์ม ${probe.plan_unmatched.length} รายการ (ดูในขั้น 2)`);
      if (warns.length) html += `<div class="notice warn-card"><strong>ข้อสังเกต (${warns.length})</strong><ul class="t11-warn-list">${warns.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`;
      report.innerHTML = html;
    }

    formIn.addEventListener("change", () => { w.formFile = formIn.files[0] || null; jsonIn.value = ""; w.jsonFile = null; readExcel(); });
    planIn.addEventListener("change", () => { w.planFile = planIn.files[0] || null; jsonIn.value = ""; w.jsonFile = null; readExcel(); });
    jsonIn.addEventListener("change", async () => {
      const f = jsonIn.files[0];
      if (!f) return;
      formIn.value = ""; planIn.value = ""; w.formFile = null; w.planFile = null;
      w.source = "json"; w.parsed = null; w.mapping = null; w.seed = null; w.jsonFile = f;
      try {
        let obj;
        try { obj = JSON.parse(await f.text()); } catch (e) { throw new Error("ไฟล์ไม่ใช่ JSON ที่ถูกต้อง"); }
        if (obj && Number.isInteger(obj.fy) && obj.fy !== w.fy && (obj.fy === fyCur() + 1 || obj.fy === fyCur())) { w.fy = obj.fy; fyIn.value = obj.fy; fyHint.textContent = fyHintText(); }
        w.json = obj;
        w.jsonCheck = validateImportJson(obj, { pcus: b().pcus, fyExpected: w.fy });
        const c = w.jsonCheck;
        let html = `<h4>ผลการตรวจไฟล์ JSON</h4><p id="t11-json-info">${escapeHtml(f.name)} · ปีงบ ${escapeHtml(String(obj && obj.fy))} · ${c.items} รายการ · ` +
          (c.allCoded ? "ทุกรายการมีรหัส → ข้ามไปขั้นตรวจสอบได้" : "บางรายการยังไม่มีรหัส → จับคู่ในขั้น 2") + "</p>";
        if (c.errors.length) html += `<div class="notice notice-error" id="t11-json-errors"><strong>ไฟล์ไม่ผ่านการตรวจ (${c.errors.length})</strong><ul>${c.errors.slice(0, 30).map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`;
        if (c.warnings.length) html += `<div class="notice warn-card"><ul>${c.warnings.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`;
        report.innerHTML = html;
      } catch (err) {
        w.json = null; w.jsonCheck = { errors: [errMessage(err)], warnings: [] };
        report.innerHTML = `<p class="admin-err-text">${escapeHtml(errMessage(err))}</p>`;
      }
      setNext();
    });

    next.addEventListener("click", () => {
      if (w.source === "excel") {
        w.mapping = mapItems(w.parsed, b().form);
        go(2);
      } else if (w.source === "json") {
        if (w.jsonCheck.allCoded) { w.mapping = null; w.seed = w.json; go(3); }
        else { const r = mapJsonItems(w.json, b().form); w.parsed = r.parsed; w.mapping = r.mapping; go(2); }
      }
    });

    // restore a previous selection when coming back from step 2/3
    if (w.source === "json" && w.json) {
      report.innerHTML = `<p class="admin-note">ไฟล์ JSON ที่เลือกไว้: ${escapeHtml(w.jsonFile ? w.jsonFile.name : "")} — เลือกใหม่ได้</p>`;
      w.jsonCheck = validateImportJson(w.json, { pcus: b().pcus, fyExpected: w.fy });
    } else if (w.source === "excel" && w.parsed) {
      drawReport();
      report.insertBefore(el("p", { class: "admin-note" }, `ไฟล์ที่เลือกไว้: ${w.formFile ? w.formFile.name : ""} · ${w.planFile ? w.planFile.name : ""}`), report.firstChild);
    }
    setNext();
  }

  // ================================================================================================================================
  // step 2 — item mapping
  // ================================================================================================================================
  function drawStep2() {
    const m = w.mapping;
    const cur = new Map(m.current.map((c) => [c.code, c]));
    const card = el("div", { class: "admin-card", id: "t11-step2" });
    card.appendChild(el("h3", {}, "ขั้น 2 — จับคู่รายการกับรหัสเดิม"));
    card.appendChild(el("p", { class: "admin-note" },
      `"ตรงกัน" = ชื่อเหมือนเดิม (ยืนยันอัตโนมัติ) · "ใกล้เคียง" = ชื่อคล้าย ≥ ${Math.round(FUZZY_MIN * 100)}% ต้องกด ✓ · "รายการใหม่" = ได้รหัสถัดไปในหน้านั้น · รายการที่ใช้รหัสเดิมจะเก็บประวัติ/เพดาน/สถิติต่อเนื่อง`));

    const counts = el("div", { class: "t11-counts", id: "t11-counts" });
    const seg = el("div", { class: "admin-seg", id: "t11-filter" });
    [["all", "ทั้งหมด"], ["todo", "ต้องตรวจ"], ["fuzzy", "ใกล้เคียง"], ["new", "ใหม่"]].forEach(([k, t]) => {
      const btn = el("button", { type: "button", "data-f": k, class: w.filter === k ? "active" : "" }, t);
      btn.addEventListener("click", () => { w.filter = k; seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === btn)); applyFilter(); });
      seg.appendChild(btn);
    });
    const confirmAll = el("button", { type: "button", class: "btn btn-secondary btn-sm", id: "t11-confirm-fuzzy" }, "ยืนยันคู่ที่ fuzzy ทั้งหมด");
    card.appendChild(el("div", { class: "admin-toolbar" }, [seg, confirmAll, counts]));

    const tbody = el("tbody");
    const table = el("table", { class: "admin-table t11-map-table", id: "t11-map-tbl" }, [
      el("thead", {}, el("tr", {}, [
        el("th", { class: "left" }, "หน้า"), el("th", {}, "ลำดับ"), el("th", { class: "left" }, "ชื่อในไฟล์"), el("th", { class: "left" }, "หน่วย"),
        el("th", {}, "ราคา"), el("th", { class: "left" }, "จับคู่กับ"), el("th", {}, "✓")
      ])),
      tbody
    ]);
    card.appendChild(el("div", { class: "table-scroll tall t11-map-scroll" }, table));

    const extra = el("div", { id: "t11-map-extra" });
    card.appendChild(extra);
    const msg = el("p", { class: "admin-note", id: "t11-map-msg" });
    const back = el("button", { type: "button", class: "btn btn-secondary", id: "t11-back2" }, "ย้อนกลับ");
    const next = el("button", { type: "button", class: "btn btn-primary", id: "t11-next2" }, "ถัดไป: ตรวจสอบ");
    card.appendChild(el("div", { class: "admin-toolbar t11-nav" }, [back, next, msg]));
    body.appendChild(card);

    const rowEls = new Map();
    let res = resolveMapping(m);
    res.stamp = "0";

    function optLabel(code, sim) {
      const c = cur.get(code);
      if (!c) return code;
      const name = c.name.length > 46 ? c.name.slice(0, 45) + "…" : c.name;
      return `${code} · ${name}${sim !== undefined ? ` (${pct(sim)})` : ""}${c.active ? "" : " [ปิดแล้ว]"}`;
    }
    function fillSelect(sel, it, full) {
      const want = it.choice.code ? it.choice.code : "__new";
      sel.innerHTML = "";
      const seen = new Set();
      const add = (parent, value, label) => { if (seen.has(value)) return; seen.add(value); parent.appendChild(el("option", { value }, label)); };
      if (it.suggestion.code) add(sel, it.suggestion.code, (it.suggestion.kind === "file" ? "จากไฟล์: " : "") + optLabel(it.suggestion.code, it.suggestion.kind === "fuzzy" ? it.suggestion.sim : undefined));
      if (it.choice.code && !seen.has(it.choice.code)) add(sel, it.choice.code, optLabel(it.choice.code));
      add(sel, "__new", `รายการใหม่ (รหัส ${res.codes[it.key] && !it.choice.code ? res.codes[it.key] : "ถัดไปในหน้า " + (m.pages[it.page].step_code || "")})`);
      // current items no row has taken yet (would be closed) — the likely answer for a "new" / wrong row
      const open = res.missing.filter((c) => !seen.has(c.code));
      if (open.length) {
        const g = el("optgroup", { label: "รายการเดิมที่ยังไม่ถูกจับคู่ (จะถูกปิด)" });
        open.map((c) => ({ c, sim: similarity(it.name, c.name) })).sort((a, b) => b.sim - a.sim).forEach(({ c, sim }) => add(g, c.code, optLabel(c.code, sim)));
        sel.appendChild(g);
      }
      const top = el("optgroup", { label: "ชื่อใกล้เคียง" });
      (it.candidates || []).forEach((c) => { if (!seen.has(c.code)) add(top, c.code, optLabel(c.code, c.sim)); });
      if (top.children.length) sel.appendChild(top);
      if (full) {
        const rest = el("optgroup", { label: "รายการอื่นในฟอร์มปัจจุบัน" });
        m.current.forEach((c) => { if (!seen.has(c.code)) add(rest, c.code, optLabel(c.code)); });
        sel.appendChild(rest);
      } else sel.appendChild(el("option", { value: "__more" }, "เลือกรายการอื่น…"));
      sel.value = want;
    }

    function kindOf(it) {
      if (it.fixed) return "file";
      if (it.choice.new) return "new";
      if (it.choice.code === it.suggestion.code) return it.suggestion.kind;
      return "manual";
    }

    function buildRow(it) {
      const pg = m.pages[it.page];
      const tr = el("tr", { "data-key": it.key, "data-seq": it.seq });
      const sel = el("select", { class: "select-input t11-sel", "aria-label": `จับคู่ลำดับ ${it.seq}`, disabled: it.fixed || null });
      fillSelect(sel, it, false);
      const loadFull = () => { if (sel.dataset.full !== res.stamp) { const v = sel.value; fillSelect(sel, it, true); sel.dataset.full = res.stamp; sel.value = v; } };
      sel.addEventListener("focus", loadFull);
      sel.addEventListener("mousedown", loadFull);
      sel.addEventListener("change", () => {
        if (sel.value === "__more") { fillSelect(sel, it, true); sel.dataset.full = res.stamp; sel.focus(); return; }
        it.choice = sel.value === "__new" ? { new: true } : { code: sel.value };
        it.confirmed = true;
        refresh();
      });
      const cb = el("input", { type: "checkbox", class: "t11-ok", "aria-label": `ยืนยันลำดับ ${it.seq}`, disabled: it.fixed || null });
      cb.checked = !!it.confirmed;
      cb.addEventListener("change", () => { it.confirmed = cb.checked; refresh(); });
      const info = el("div", { class: "t11-cur small" });
      const priceTxt = it.price_src === "plan" ? fmt(it.price) : `${fmt(it.price)}${it.price_src === "form" ? ' <span class="badge badge-warn" title="ไม่พบในไฟล์ประมาณการ">ไฟล์ฟอร์ม</span>' : ""}`;
      tr.innerHTML = `<td class="left code-cell">${escapeHtml(pg.step_code || "")}</td><td class="num">${it.seq}</td>
        <td class="left name-cell">${escapeHtml(it.name)}</td><td class="left">${escapeHtml(it.unit)}${it.plan_unit ? ` <span class="muted small" title="หน่วยในไฟล์ประมาณการ">(${escapeHtml(it.plan_unit)})</span>` : ""}</td>
        <td class="num">${priceTxt}</td><td class="left t11-sel-cell"></td><td class="t11-ok-cell"></td>`;
      const selCell = tr.querySelector(".t11-sel-cell");
      selCell.appendChild(el("span", { class: "t11-kind badge" }));
      selCell.appendChild(sel);
      selCell.appendChild(info);
      tr.querySelector(".t11-ok-cell").appendChild(cb);
      rowEls.set(it.key, { tr, sel, cb, info, badge: selCell.querySelector(".t11-kind") });
      return tr;
    }

    function updateRow(it, dupSet) {
      const r = rowEls.get(it.key);
      const k = kindOf(it);
      r.badge.className = "t11-kind badge " + (k === "exact" || k === "file" ? "badge-success" : k === "fuzzy" ? "badge-warn" : k === "new" ? "badge-muted" : "badge-warn");
      r.badge.textContent = KIND_LABEL[k] + (k === "fuzzy" ? " " + pct(it.suggestion.sim) : "");
      const want = it.choice.code ? it.choice.code : "__new";
      if (r.sel.value !== want) r.sel.value = want;
      if (it.choice.new) {
        const o = r.sel.querySelector('option[value="__new"]');
        if (o) o.textContent = `รายการใหม่ (รหัส ${res.codes[it.key] || "?"})`;
      }
      r.cb.checked = !!it.confirmed;
      const c = it.choice.code ? cur.get(it.choice.code) : null;
      if (c) {
        const bits = [`เดิม: ${c.name}`, c.unit, `${fmt(c.price)} บาท`];
        if (round2(c.price) !== round2(it.price)) bits.push(`→ ${fmt(it.price)} (${c.price ? (it.price >= c.price ? "+" : "") + Math.round((it.price / c.price - 1) * 100) + "%" : "ใหม่"})`);
        if (c.step !== m.pages[it.page].step_code) bits.push(`ย้ายจากหน้า ${c.step}`);
        if (!c.active) bits.push("เปิดใช้อีกครั้ง");
        r.info.textContent = bits.join(" · ");
      } else r.info.textContent = it.choice.new ? "ยังไม่มีในฟอร์มปัจจุบัน — ไม่มีแผน/เพดานเดิม" : "";
      const dup = it.choice.code && dupSet.has(it.choice.code);
      r.tr.classList.toggle("t11-dup", !!dup);
      r.tr.classList.toggle("t11-todo", !it.confirmed);
      r.tr.dataset.kind = k;
    }

    function applyFilter() {
      for (const it of m.items) {
        const r = rowEls.get(it.key);
        const k = r.tr.dataset.kind;
        const show = w.filter === "all" || (w.filter === "todo" && (!it.confirmed || r.tr.classList.contains("t11-dup")))
          || (w.filter === "fuzzy" && it.suggestion.kind === "fuzzy") || (w.filter === "new" && k === "new");
        r.tr.style.display = show ? "" : "none";
      }
    }

    let stampN = 0;
    function refresh() {
      res = resolveMapping(m);
      res.stamp = String(++stampN);
      const dupSet = new Set(res.duplicates);
      m.items.forEach((it) => updateRow(it, dupSet));
      const n = { exact: 0, fuzzy: 0, new: 0, file: 0, manual: 0 };
      m.items.forEach((it) => { n[kindOf(it)]++; });
      counts.textContent = `${m.items.length} รายการ · ตรงกัน ${n.exact + n.file} · ใกล้เคียง ${n.fuzzy} · เลือกเอง ${n.manual} · ใหม่ ${n.new} · ยังไม่ยืนยัน ${res.unconfirmed}`;
      const problems = [];
      if (res.unconfirmed) problems.push(`ยังไม่ยืนยัน ${res.unconfirmed} แถว`);
      if (res.duplicates.length) problems.push(`รหัสซ้ำ: ${res.duplicates.join(", ")} (หลายแถวจับคู่กับรหัสเดียวกัน)`);
      next.disabled = !res.ok;
      msg.className = res.ok ? "admin-ok-text" : "admin-err-text";
      msg.textContent = res.ok ? "จับคู่ครบแล้ว" : problems.join(" · ");
      drawExtra();
      applyFilter();
    }

    function drawExtra() {
      let html = "";
      if (res.missing.length) {
        html += `<div class="notice warn-card" id="t11-missing"><strong>รายการที่หายไป (จะถูกปิด) — ${res.missing.length} รายการ</strong>
          <p class="small">มีในฟอร์มปัจจุบันแต่ไม่มีในไฟล์ใหม่: จะเก็บรหัสไว้เป็นรายการที่ปิดแล้ว (รพ.สต. ไม่เห็น) — ถ้าจริง ๆ คือรายการเดียวกับแถวด้านบน ให้เลือกจับคู่แทน</p>
          <ul>${res.missing.map((c) => `<li><code>${escapeHtml(c.code)}</code> ${escapeHtml(c.name)} · ${escapeHtml(c.unit || "")} · ${fmt(c.price)} บาท (หน้า ${escapeHtml(c.step)})</li>`).join("")}</ul></div>`;
      }
      if (m.plan_unmatched.length) {
        html += `<div class="notice warn-card" id="t11-plan-unmatched"><strong>รายการในไฟล์ประมาณการที่ไม่ตรงกับแบบฟอร์ม — ${m.plan_unmatched.length} รายการ (แผนของรายการเหล่านี้จะไม่ถูกนำเข้า)</strong>
          <ul>${m.plan_unmatched.map((p) => `<li>ลำดับ ${p.seq} · ${escapeHtml(p.name)} · ${escapeHtml(p.unit || "")} · ${fmt(p.price)}</li>`).join("")}</ul></div>`;
      }
      if (m.warnings.length) html += `<details class="t11-details" open><summary>ข้อสังเกตการจับคู่ไฟล์ประมาณการ (${m.warnings.length})</summary><ul class="small">${m.warnings.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></details>`;
      extra.innerHTML = html;
    }

    m.items.forEach((it) => tbody.appendChild(buildRow(it)));
    confirmAll.addEventListener("click", () => {
      let n = 0;
      m.items.forEach((it) => { if (!it.confirmed && kindOf(it) === "fuzzy") { it.confirmed = true; n++; } });
      refresh();
      toast(n ? `ยืนยันคู่ใกล้เคียงแล้ว ${n} แถว` : "ไม่มีคู่ใกล้เคียงที่รอยืนยัน");
    });
    back.addEventListener("click", () => go(1));
    next.addEventListener("click", () => {
      if (!resolveMapping(m).ok) return;
      try {
        if (w.source === "excel") {
          w.seed = buildImportJson({
            fy: w.fy, parsed: w.parsed, mapping: m, pcus: b().pcus,
            sources: [w.formFile && w.formFile.name, w.planFile && w.planFile.name].filter(Boolean), currentForm: b().form
          });
        } else {
          const r = buildFromJson(w.json, m);
          w.seed = r.seed;
          w.localWarnings = r.warnings;
        }
        go(3);
      } catch (err) { msg.className = "admin-err-text"; msg.textContent = "สร้างไฟล์นำเข้าไม่สำเร็จ: " + errMessage(err); }
    });
    refresh();
  }

  // ================================================================================================================================
  // step 3 — preview + apply
  // ================================================================================================================================
  function drawStep3() {
    const card = el("div", { class: "admin-card", id: "t11-step3" });
    card.appendChild(el("h3", {}, "ขั้น 3 — ตรวจสอบ + ยืนยัน"));
    const out = el("div", { id: "t11-preview" });
    card.appendChild(out);
    const back = el("button", { type: "button", class: "btn btn-secondary", id: "t11-back3" }, "ย้อนกลับ");
    const dl = el("button", { type: "button", class: "btn btn-secondary", id: "t11-download" }, `ดาวน์โหลด import_${w.seed.fy}.json`);
    const apply = el("button", { type: "button", class: "btn btn-danger", id: "t11-apply", disabled: true }, `เปิดปีงบ ${w.seed.fy}`);
    const msg = el("p", { class: "admin-note", id: "t11-apply-msg" });
    card.appendChild(el("div", { class: "admin-toolbar t11-nav" }, [back, dl, apply]));
    card.appendChild(msg);
    body.appendChild(card);

    back.addEventListener("click", () => go(w.mapping ? 2 : 1));
    dl.addEventListener("click", () => downloadJson(w.seed, `import_${w.seed.fy}.json`));

    out.innerHTML = '<div class="admin-loading-block"><div class="admin-spinner"></div>กำลังตรวจสอบกับข้อมูลในระบบ (adminImportPreview)...</div>';
    ctx.adminCall("adminImportPreview", { seed: w.seed }).then((pv) => {
      w.preview = pv;
      drawPreview(pv);
      const canApply = pv.mode === "rollover" && pv.summary && pv.summary.form && pv.summary.form.version_action === "insert";
      apply.disabled = !canApply;
      if (!canApply) {
        msg.className = "admin-err-text";
        msg.textContent = pv.mode === "same_fy" ? `ปีงบ ${pv.fy} เป็นปีงบปัจจุบัน — เปิดปีงบซ้ำไม่ได้ (ถ้าต้องการนำเข้าข้อมูลปีนี้ ใช้ "นำเข้าข้อมูลตั้งต้น" ที่แท็บระบบ)`
          : `ปีงบ ${pv.fy} มีฟอร์มอยู่แล้ว — เปิดปีงบซ้ำไม่ได้`;
      }
    }).catch((err) => {
      const code = err && err.code;
      out.innerHTML = `<div class="notice notice-error" id="t11-preview-err"><strong>ตรวจสอบไม่ผ่าน</strong><p>${escapeHtml(errMessage(err))}</p>${code === "NOT_IMPLEMENTED" ? "<p>ฝั่งเซิร์ฟเวอร์ยังไม่เปิดใช้การนำเข้าปีงบใหม่ — ดาวน์โหลดไฟล์ JSON เก็บไว้ก่อนได้</p>" : ""}</div>`;
    });

    apply.addEventListener("click", async () => {
      const pv = w.preview;
      if (!pv) return;
      const s = pv.summary;
      const ok = await confirmDialog(
        `เปิดปีงบ ${pv.fy} แทนปีงบ ${pv.fy_current}\n\n` +
        `• ฟอร์มใหม่ ${s.form.active_items} รายการ (${s.form.steps} หน้า) · ใหม่ ${s.form.items_new.length} · ปิด ${s.form.items_closed.length} · ราคาเปลี่ยน ${s.form.price_changed.length}\n` +
        `• แผนรวมเครือข่าย ${fmt(s.plans.network.total)} บาท\n` +
        `• ปีงบ ${pv.fy_current} ย้ายไปแท็บ "ปีก่อน" (ยอดเบิกจริงจากใบเบิกในระบบ) · ยอดปีเริ่มนับใหม่\n` +
        `• เพดานตั้งต้น ${s.limits.in_file ? s.limits.in_file + " แถวจากไฟล์" : s.limits.will_default + " แถว (คำนวณอัตโนมัติ)"}\n\nย้อนกลับไม่ได้ — แนะนำให้ Export backup ที่แท็บระบบก่อน`,
        { title: `เปิดปีงบ ${pv.fy}`, okText: "ดำเนินการต่อ", danger: true });
      if (!ok) return;
      const phrase = `เปิดปีงบ ${pv.fy}`;
      const typed = await formDialog(`ยืนยันเปิดปีงบ ${pv.fy}`, [
        { key: "confirm", label: `พิมพ์ "${phrase}" เพื่อยืนยัน`, required: true, placeholder: phrase }
      ], { okText: phrase, intro: "ขั้นสุดท้าย — ระบบจะเปลี่ยนปีงบปัจจุบันทันที", validate: (v) => (v.confirm === phrase ? "" : `ต้องพิมพ์ "${phrase}" ให้ตรง`) });
      if (!typed) return;
      apply.disabled = true; back.disabled = true;
      msg.className = "admin-note"; msg.textContent = "กำลังเปิดปีงบ...";
      try {
        const r = await ctx.adminCall("adminImportApply", { seed: w.seed, confirm: typed.confirm });
        toast(`เปิดปีงบ ${r.fy_current} แล้ว`);
        msg.className = "admin-ok-text";
        msg.textContent = `เปิดปีงบ ${r.fy_current} แล้ว · ฟอร์ม version ใหม่ #${r.rollover ? r.rollover.form_version_id : "?"} · เบิกจริงปีก่อน ${r.rollover ? r.rollover.actual_rows : 0} แถว · สถิติ ${r.rollover ? r.rollover.stats_rows : 0} · เพดาน ${r.rollover ? r.rollover.limits_rows : 0}`;
        await ctx.refreshBootstrap();
        ctx.markStale(ALL_TABS);
        const btn = document.querySelector('.admin-tabbar button[data-tab="tab4"]');
        if (btn) btn.click();
        ctx.markStale(["tab11"]);
      } catch (err) {
        msg.className = "admin-err-text";
        msg.textContent = "เปิดปีงบไม่สำเร็จ: " + errMessage(err);
        apply.disabled = false; back.disabled = false;
      }
    });

    function drawPreview(pv) {
      const s = pv.summary || {};
      const names = Object.fromEntries(b().pcus.map((p) => [p.code, p.name]));
      const fileTot = fileTotals();
      let html = `<p class="t11-mode" id="t11-mode">${pv.mode === "rollover" ? `<span class="badge badge-warn">เปิดปีงบใหม่</span> ${pv.fy_current} → <strong>${pv.fy}</strong>` : `<span class="badge badge-muted">ปีงบเดียวกัน</span> ${pv.fy}`}
        · ฟอร์ม: <strong>${escapeHtml(versionLabel(s.form && s.form.version_action))}</strong></p>`;
      // form
      const f = s.form || {};
      const itemName = itemNames();
      html += `<h4>แบบฟอร์ม</h4><ul class="t11-sum" id="t11-sum-form">
        <li>${f.steps} หน้า · รายการที่เปิดใช้ <strong>${f.active_items}</strong></li>
        <li>รายการใหม่ ${(f.items_new || []).length}${(f.items_new || []).length ? ": " + escapeHtml(f.items_new.map((c) => `${c} ${itemName[c] || ""}`).join(" · ")) : ""}</li>
        <li>ปิด (ไม่มีในไฟล์) ${(f.items_closed || []).length}${(f.items_closed || []).length ? ": " + escapeHtml(f.items_closed.join(", ")) : ""}${(f.items_reopened || []).length ? ` · เปิดใช้อีกครั้ง ${f.items_reopened.length}: ${escapeHtml(f.items_reopened.join(", "))}` : ""}</li>
        <li>ราคาเปลี่ยน ${(f.price_changed || []).length} · เปลี่ยนชื่อ ${f.renamed || 0}</li></ul>`;
      if ((f.price_changed || []).length) {
        const rows = f.price_changed.map((p) => `<tr><td class="left code-cell">${escapeHtml(p.code)}</td><td class="left name-cell">${escapeHtml(itemName[p.code] || "")}</td><td class="num">${fmt(p.old)}</td><td class="num">${fmt(p.new)}</td><td class="num">${p.old ? (p.new >= p.old ? "+" : "") + Math.round((p.new / p.old - 1) * 100) + "%" : "–"}</td></tr>`).join("");
        html += `<details class="t11-details"><summary>ราคาเปลี่ยน ${f.price_changed.length} รายการ</summary>${tableScroll(`<table class="admin-table" id="t11-price-tbl"><thead><tr><th class="left">รหัส</th><th class="left">รายการ</th><th>เดิม</th><th>ใหม่</th><th>%</th></tr></thead><tbody>${rows}</tbody></table>`, "short")}</details>`;
      }
      // plans
      const pl = s.plans || { per_pcu: {}, network: {} };
      const pcuRows = b().pcus.map((p) => {
        const t = pl.per_pcu[p.code];
        const ft = fileTot.per_pcu ? fileTot.per_pcu[p.code] : null;
        let mark = '<span class="muted">–</span>', note = "";
        if (t && ft) {
          const same = ["op", "pp", "total"].every((k) => ft[k] === null || ft[k] === undefined || Math.abs(ft[k] - t[k]) <= 0.01);
          mark = same ? '<span class="admin-ok-text">✓</span>' : '<span class="admin-err-text">✗</span>';
          if (!same) note = `ไฟล์: ${fmt(ft.op)} / ${fmt(ft.pp)} / ${fmt(ft.total)}`;
        }
        return `<tr data-pcu="${escapeHtml(p.code)}"><td class="left">${escapeHtml(names[p.code])}</td><td class="num">${fmt(t && t.op)}</td><td class="num">${fmt(t && t.pp)}</td><td class="num"><strong>${fmt(t && t.total)}</strong></td>
          <td class="num">${ft ? fmt(ft.total) : "–"}</td><td class="t11-mark">${mark}</td><td class="left small">${escapeHtml(note)}</td></tr>`;
      }).join("");
      const net = pl.network || {};
      const fnet = fileTot.network;
      const netOk = fnet ? Math.abs(fnet.total - net.total) <= 0.01 : null;
      html += `<h4>แผนปีงบ ${pv.fy} ต่อ รพ.สต. (จำนวน × ราคา)</h4>`;
      html += tableScroll(`<table class="admin-table" id="t11-plan-tbl"><thead><tr><th class="left">รพ.สต.</th><th>OP</th><th>PP</th><th>รวม</th><th>"รวมเป็นเงิน" ในไฟล์</th><th></th><th class="left">หมายเหตุ</th></tr></thead>
        <tbody>${pcuRows}</tbody><tfoot><tr class="grand-row"><td class="left"><strong>รวมเครือข่าย</strong></td><td class="num">${fmt(net.op)}</td><td class="num">${fmt(net.pp)}</td><td class="num" id="t11-net-total"><strong>${fmt(net.total)}</strong></td>
        <td class="num">${fnet ? fmt(fnet.total) : "–"}</td><td class="t11-mark">${netOk === null ? "–" : netOk ? '<span class="admin-ok-text">✓</span>' : '<span class="admin-err-text">✗</span>'}</td><td class="left small">${pl.rows || 0} แถวแผน</td></tr></tfoot></table>`);
      if (fileTot.per_pcu && b().pcus.some((p) => { const t = pl.per_pcu[p.code], ft = fileTot.per_pcu[p.code]; return t && ft && Math.abs(ft.total - t.total) > 0.01; })) {
        html += `<p class="admin-note">✗ = แถว "รวมเป็นเงิน" ในไฟล์ไม่เท่าผลรวมรายรายการ (มักเป็นสูตรในไฟล์ที่ไม่ครอบคลุมทุกหมวด) — ระบบใช้ผลรวมรายรายการ ตรวจสูตรในไฟล์ต้นทาง</p>`;
      }
      // limits / config / rollover
      const lim = s.limits || {};
      const ro = s.rollover;
      html += `<h4>เพดาน · ค่าตั้งต้น · ข้อมูลปีก่อน</h4><ul class="t11-sum" id="t11-sum-other">
        <li>เพดานปีงบ ${pv.fy}: ${lim.in_file ? `${lim.in_file} แถวจากไฟล์` : `คำนวณอัตโนมัติ ${lim.will_default || 0} แถว (ต่อปี = แผน OP+PP · ต่อเดือน = P90 รายเดือนปีก่อน หรือ แผน/12×2)`}</li>
        <li>ค่าตั้งต้นที่จะตั้ง: ${escapeHtml(((s.config && s.config.will_set) || []).join(", ") || "–")}</li>
        ${ro ? `<li>ปีงบ ${ro.from_fy} → แท็บ "ปีก่อน": ${monthRange(ro.actual_months)} · จากใบเบิกที่ส่งแล้ว ${ro.requests_counted || 0} ใบ${ro.source ? ` <span class="muted small">(เบิกจริง: ${srcLabel(ro.source.actual_prev)} · ราคา: ${srcLabel(ro.source.prices_prev)} · สถิติ: ${srcLabel(ro.source.stats)})</span>` : ""}</li>` : ""}
        <li>รพ.สต.: ในระบบ ${(s.pcus && s.pcus.known || []).length}${s.pcus && s.pcus.new && s.pcus.new.length ? ` · ใหม่ ${s.pcus.new.join(", ")}` : ""}${s.pcus && s.pcus.missing_in_file && s.pcus.missing_in_file.length ? ` · ไม่อยู่ในไฟล์ ${s.pcus.missing_in_file.join(", ")}` : ""}</li></ul>`;
      const warns = [...(pv.warnings || []), ...(w.localWarnings || [])];
      if (warns.length) html += `<div class="notice warn-card" id="t11-warnings"><strong>คำเตือน (${warns.length})</strong><ul>${warns.map((x) => `<li>${escapeHtml(typeof x === "string" ? x : JSON.stringify(x))}</li>`).join("")}</ul></div>`;
      out.innerHTML = html;
    }

    function fileTotals() {
      if (w.source === "excel" && w.parsed && w.parsed.plan && w.parsed.plan.totals) return { per_pcu: w.parsed.plan.totals.per_pcu, network: w.parsed.plan.totals.network };
      const v = w.seed.verify && w.seed.verify[`plan_${w.seed.fy}_per_pcu`];
      const n = w.seed.config && w.seed.config.plan_total && w.seed.config.plan_total[String(w.seed.fy)];
      return { per_pcu: v || null, network: n || null };
    }
    function itemNames() {
      const o = {};
      (w.seed.form.steps || []).forEach((st) => (st.rows || []).forEach((r) => { if (r.type === "item") o[r.code] = r.name; }));
      return o;
    }
  }

  drawHead();
  go(1);
  return {
    onShow() {
      // a different fiscal year (e.g. after opening one) resets the default target year
      if (w.step === 1 && !w.parsed && !w.json) { w.fy = fyCur() + 1; const i = document.getElementById("t11-fy"); if (i) i.value = w.fy; }
    }
  };
}

function versionLabel(a) {
  return a === "insert" ? "จะสร้าง version 1 ของปีงบใหม่" : a === "same" ? "เหมือนฟอร์มที่มีอยู่ (ไม่สร้างใหม่)" : a === "skipped_differs" ? "มีฟอร์มของปีนี้อยู่แล้วและต่างกัน (จะไม่ทับ)" : (a || "–");
}
function srcLabel(s) { return s === "file" ? "ไฟล์" : s === "db" ? "ใบเบิกในระบบ" : (s || "–"); }
function monthRange(ms) {
  if (!Array.isArray(ms) || !ms.length) return "ไม่มีเดือนที่มีข้อมูล";
  const th = (k) => { const [y, m] = k.split("-").map(Number); return `${["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."][m - 1]} ${String(y + 543).slice(2)}`; };
  return `${ms.length} เดือน (${th(ms[0])} – ${th(ms[ms.length - 1])})`;
}
