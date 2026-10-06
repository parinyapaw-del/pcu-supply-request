// Fill wizard (phase 2 spec §4.2/§4.3): one step per form step (ordered by `order`, ≤ 10) -> summary page.
// Columns คงเหลือ / OP / PP — คงเหลือ is optional unless config.stock_required === 1. Autosave via sync.js;
// บันทึก and พิมพ์ on the summary page both SEND (saveLines{send:true}, see send.js).
import { getOrderedSteps, getActiveItemRows } from "../data.js";
import { call, getPcuToken } from "../api.js";
import * as sync from "../sync.js";
import { formatInt, formatMoney, nowTimeHHMM } from "../format.js";
import { limitStatus } from "../limits.js";
import {
  esc, pcuCode, roundOf, monthData, unlocksOf, isEditable, isLocked, isActiveRound, roundUsesCurrentFy,
  requestOf, requestStatus, fyShort, monthLabel, formatThaiYmd, alertDialog, toast,
} from "./common.js";
import { trySend, collectIssues, sendUi, lineTotal } from "./send.js";

let unsubStatus = null;

function hiddenSet(app) {
  return new Set(app.boot.hidden || []);
}

function stockRequired(app) {
  return app.boot.config.stock_required === 1;
}

function activeStepItems(app, step) {
  const hidden = hiddenSet(app);
  return getActiveItemRows(step).filter((it) => !hidden.has(it.code));
}

function stepLabel(step) {
  return step.sheet || step.title || step.code;
}

function stepTotals(app, step, month) {
  let op = 0, pp = 0, qty = 0, money = 0;
  for (const it of activeStepItems(app, step)) {
    const line = sync.getLine(pcuCode(app), month, it.code);
    const o = Number(line.op) || 0, p = Number(line.pp) || 0;
    op += o; pp += p; qty += o + p; money += (o + p) * it.price;
  }
  return { op, pp, qty, money };
}

// ---------------- 2c: pages of issued units are locked (spec §4.3) ----------------
function unitOfStep(step) {
  if (step.dispense_unit) return step.dispense_unit;
  if (step.code === "CS") return "จ่ายกลาง";
  if (step.code === "LAB") return "LAB";
  return "พัสดุ";
}

// Units whose issue_status is done for this month (IssueInfo.units[u].done).
function issuedUnits(app, month) {
  const issue = monthData(app, month).issue;
  const out = new Set();
  if (issue && issue.units) Object.entries(issue.units).forEach(([u, x]) => { if (x && x.done) out.add(u); });
  return out;
}

function isStepIssued(app, month, step) {
  return !!step && issuedUnits(app, month).has(unitOfStep(step));
}

// After a CONFLICT: store the fresh IssueInfo; when the round is open and some unit is issued, the refusal was
// about an issued page — lift the month-wide read-only state so only those pages stay locked.
function applyIssueRefresh(app, month, d) {
  if (!d) return false;
  if (app.boot.byMonth && app.boot.byMonth[month]) app.boot.byMonth[month].issue = d.issue || null;
  else if (app.older && app.older[month]) app.older[month].issue = d.issue || null;
  const anyDone = !!(d.issue && d.issue.units && Object.values(d.issue.units).some((x) => x && x.done));
  if (anyDone && !(d.round && d.round.locked)) {
    const sess = sync.getSession(pcuCode(app), month);
    if (sess) { sess.conflict = false; sess.conflictMessage = ""; sess.lastOutcome = "ok"; }
    return true;
  }
  return false;
}

function goToStep(app, month, stepCode) {
  sync.setLastStep(pcuCode(app), month, stepCode);
  sync.flush(pcuCode(app), month);
  location.hash = `#/fill/${stepCode}?month=${month}`;
}

export async function renderFill(container, app, stepCode, params) {
  const month = app.monthKey;
  const steps = getOrderedSteps(app.boot.form);
  const codes = steps.map((s) => s.code).concat("summary");
  if (!codes.includes(stepCode)) stepCode = codes[0];
  const editable = isEditable(app, month);

  if (sendUi.month !== month) sendUi.missing = new Set();
  if (unsubStatus) { unsubStatus(); unsubStatus = null; }

  // Remember wherever the user actually lands (reload / bookmark / back button included).
  if (editable && stepCode !== "summary") sync.setLastStep(pcuCode(app), month, stepCode);

  const curStep = stepCode === "summary" ? null : steps.find((s) => s.code === stepCode);
  const stepLocked = isStepIssued(app, month, curStep);
  const stepEditable = editable && !stepLocked;

  const wrap = document.createElement("div");
  wrap.className = "fill-page";
  wrap.appendChild(renderProgressBar(app, month, stepCode, steps, codes));
  wrap.appendChild(renderBanners(app, month, stepLocked));

  const content = document.createElement("div");
  content.className = "fill-content";
  if (stepCode === "summary") {
    content.appendChild(renderSummary(app, month, steps));
  } else {
    content.appendChild(renderStepForm(app, month, curStep, stepEditable));
  }
  wrap.appendChild(content);
  wrap.appendChild(renderNav(app, month, stepCode, codes));

  container.innerHTML = "";
  container.appendChild(wrap);
  refreshStatusChip(app, month);
  const sess = sync.getSession(pcuCode(app), month);
  if (sess) updateAutosaveStatus({ state: sess.conflict ? "conflict" : sess.offline ? "offline" : sess.saving ? "saving" : "idle", lastSavedAt: sess.lastSavedAt });

  if (stepCode !== "summary") {
    const step = curStep;
    wireStepEvents(app, month, step, stepEditable);
    markMissing(step, content, app, month);
    if (params && params.get("focus")) focusItem(params.get("focus"), params.get("field") || "stock");
  }
}

// ---------------- banners: locked / admin note / form version / status ----------------

function formVersionBanner(app, request) {
  if (!request || !request.form_version_id || request.form_version_id >= app.boot.form_version_id) return "";
  // 2d: pcuBootstrap.forms holds the (PCU-stripped) form version a request is bound to when it differs from the latest.
  // n = active items of the latest form not in the bound version · m = price changes · k = items closed since.
  const bound = (app.boot.forms || {})[request.form_version_id];
  const latest = {};
  app.boot.form.steps.forEach((s) => getActiveItemRows(s).forEach((it) => { latest[it.code] = it; }));
  let n = 0, m = 0, k = 0;
  if (bound && Array.isArray(bound.steps)) {
    const old = {};
    bound.steps.forEach((s) => (s.rows || []).forEach((r) => { if (r.type === "item") old[r.code] = r; }));
    Object.values(latest).forEach((it) => {
      const o = old[it.code];
      if (!o) n++;
      else if (Math.round(Number(o.price) * 100) !== Math.round(Number(it.price) * 100)) m++;
    });
    Object.values(old).forEach((o) => { if (o.active !== false && !latest[o.code]) k++; });
  } else {
    // bound version not available: count active items that have no line in the request
    const have = request.lines || {};
    Object.keys(latest).forEach((code) => { if (!(code in have)) n++; });
  }
  return `<div class="notice notice-info" id="fill-form-banner">ฟอร์มมีการปรับ: เพิ่ม ${n} รายการ · ราคาเปลี่ยน ${m} รายการ${k > 0 ? ` · ปิด ${k} รายการ` : ""} — ค่าที่กรอกไว้คงอยู่ตามรหัสรายการ</div>`;
}

function renderBanners(app, month, stepLocked) {
  const host = document.createElement("div");
  host.className = "fill-banners";
  const request = requestOf(app, month);
  const parts = [];
  if (stepLocked) {
    parts.push('<div class="notice notice-issued" id="fill-issued-banner"><strong>หน้านี้จ่ายของแล้ว — แก้ไขไม่ได้</strong> <a href="#/issue?month=' + esc(month) + '">ดูการจ่าย</a></div>');
  }
  if (isLocked(app, month)) {
    parts.push('<div class="notice notice-error"><strong>รอบนี้ปิดรับแล้ว</strong> — ดูใบเบิกได้อย่างเดียว แก้ไขไม่ได้</div>');
  } else if (!isActiveRound(app, month)) {
    parts.push('<div class="notice notice-info">เดือนเก่า — ดูอย่างเดียว</div>');
  }
  if (request && request.admin_note) {
    parts.push(`<div class="admin-note-box"><strong>ข้อความจากผู้ดูแล:</strong> ${esc(request.admin_note)}</div>`);
  }
  parts.push(formVersionBanner(app, request));
  parts.push(`<div class="fill-status" id="fill-status"></div>`);
  host.innerHTML = parts.join("");
  return host;
}

function refreshStatusChip(app, month) {
  const el = document.getElementById("fill-status");
  if (!el) return;
  const session = sync.getSession(pcuCode(app), month);
  const st = requestStatus(requestOf(app, month), roundOf(app, month), session && session.conflict);
  const round = roundOf(app, month);
  el.innerHTML = `<span class="muted">${esc(monthLabel(month))}${round ? ` · ปีงบ ${esc(round.fy)}` : ""} · สถานะ</span> <span class="badge ${st.cls}">${esc(st.label)}</span>` +
    st.extra.map((e) => ` <span class="badge ${e.cls}">${esc(e.label)}</span>`).join("");
}

// ---------------- progress + nav ----------------

function renderProgressBar(app, month, stepCode, steps, codes) {
  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const idx = codes.indexOf(stepCode);

  const pills = document.createElement("div");
  pills.className = "progress-pills";
  const issued = issuedUnits(app, month);
  codes.forEach((code, i) => {
    const isSummary = code === "summary";
    const locked = !isSummary && issued.has(unitOfStep(steps[i]));
    const dot = document.createElement("a");
    dot.className = "progress-pill" + (isSummary ? " pill-summary" : "") + (code === stepCode ? " active" : i < idx ? " done" : "") + (locked ? " pill-issued" : "");
    dot.textContent = isSummary ? "สรุป" : String(i + 1);
    dot.title = isSummary ? "สรุป" : stepLabel(steps[i]) + (locked ? " (จ่ายของแล้ว — แก้ไขไม่ได้)" : "");
    dot.href = `#/fill/${code}?month=${month}`;
    dot.addEventListener("click", (ev) => {
      ev.preventDefault();
      goToStep(app, month, code);
    });
    pills.appendChild(dot);
  });
  bar.appendChild(pills);

  const current = document.createElement("div");
  current.className = "progress-current";
  const label = stepCode === "summary" ? "สรุป" : stepLabel(steps[idx]);
  current.textContent = `ขั้นตอนที่ ${idx + 1}/${codes.length} — ${label}`;
  bar.appendChild(current);
  return bar;
}

function renderNav(app, month, stepCode, codes) {
  const nav = document.createElement("div");
  nav.className = "wizard-nav";
  const idx = codes.indexOf(stepCode);

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn-secondary";
  backBtn.textContent = "ย้อนกลับ";
  backBtn.disabled = idx <= 0;
  backBtn.addEventListener("click", () => goToStep(app, month, codes[idx - 1]));

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn btn-primary";
  nextBtn.textContent = idx >= codes.length - 2 ? "ไปหน้าสรุป" : "ถัดไป";
  nextBtn.disabled = idx >= codes.length - 1;
  nextBtn.addEventListener("click", () => goToStep(app, month, codes[idx + 1]));

  const status = document.createElement("span");
  status.className = "autosave-status";
  status.id = "autosave-status";

  nav.appendChild(backBtn);
  nav.appendChild(status);
  nav.appendChild(nextBtn);

  let wasEditable = isEditable(app, month);
  unsubStatus = sync.subscribe(pcuCode(app), month, (st) => {
    updateAutosaveStatus(st);
    refreshStatusChip(app, month);
    if (st.state === "conflict" && wasEditable) {
      // The server refused an edit (round locked meanwhile): re-render read-only with the "รอบนี้ปิดรับแล้ว" banner.
      wasEditable = false;
      setTimeout(async () => {
        try {
          const d = await sync.reloadSession(pcuCode(app), month); // drop the refused local edits, show the server's copy
          const r = app.boot.rounds.find((x) => x.month === month);
          if (r && d && d.round) Object.assign(r, d.round);
          // 2c: the refusal may be an issued page (not a locked round) — lock only the pages of issued units
          if (applyIssueRefresh(app, month, d)) toast("บางหน้าจ่ายของแล้ว — แก้ไขไม่ได้ (ค่าที่แก้ในหน้านั้นไม่ถูกบันทึก)", "error");
        } catch (err) { /* keep the local view; the banner still says closed */ }
        renderFill(document.getElementById("app"), app, stepCode, null);
      }, 0);
    }
  });
  return nav;
}

function updateAutosaveStatus(st) {
  const el = document.getElementById("autosave-status");
  if (!el) return;
  el.classList.remove("autosave-offline", "autosave-saving");
  if (st.state === "saving") {
    el.textContent = "กำลังบันทึก…";
    el.classList.add("autosave-saving");
  } else if (st.state === "offline") {
    el.textContent = "ยังไม่ขึ้น server — จะลองใหม่อัตโนมัติ";
    el.classList.add("autosave-offline");
  } else if (st.state === "conflict") {
    el.textContent = "รอบนี้ปิดรับแล้ว — แก้ไขไม่ได้";
    el.classList.add("autosave-offline");
  } else if (st.state === "error") {
    el.textContent = "บันทึกไม่สำเร็จ — ลองแก้ค่าอีกครั้ง";
    el.classList.add("autosave-offline");
  } else if (st.state === "pending") {
    el.textContent = "รอบันทึก…";
  } else if (st.lastSavedAt) {
    el.textContent = `บันทึกบน server แล้ว ${nowTimeHHMM(st.lastSavedAt)}`;
  } else {
    el.textContent = "";
  }
}

// ---------------- item step ----------------

function renderStepForm(app, month, step, editable) {
  const box = document.createElement("div");
  box.className = "step-form";

  if (!stockRequired(app) && editable) {
    const hint = document.createElement("p");
    hint.className = "muted stock-hint";
    hint.textContent = "ช่อง “คงเหลือ” ไม่บังคับ — กรอกเท่าที่ทราบ";
    box.appendChild(hint);
  }

  const hidden = hiddenSet(app);
  const hiddenCodes = Array.from(hidden).filter((c) => getActiveItemRows(step).some((it) => it.code === c));
  const hiddenDrawer = document.createElement("details");
  hiddenDrawer.className = "hidden-drawer";
  hiddenDrawer.innerHTML = `<summary>รายการที่ไม่เบิก ในขั้นตอนนี้ (${hiddenCodes.length})</summary>`;
  const hiddenList = document.createElement("div");
  hiddenList.className = "hidden-list";
  if (hiddenCodes.length === 0) {
    hiddenList.innerHTML = `<p class="muted">ไม่มีรายการที่ไม่เบิกในขั้นตอนนี้</p>`;
  } else {
    hiddenCodes.forEach((code) => {
      const item = getActiveItemRows(step).find((it) => it.code === code);
      const row = document.createElement("div");
      row.className = "hidden-item-row";
      row.innerHTML = `<span>${esc(item.name)}</span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-link";
      btn.textContent = "กู้คืน";
      btn.disabled = !editable;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await toggleHidden(app, code, false);
          renderFill(document.getElementById("app"), app, step.code, null);
        } catch (err) {
          btn.disabled = false;
        }
      });
      row.appendChild(btn);
      hiddenList.appendChild(row);
    });
  }
  hiddenDrawer.appendChild(hiddenList);
  box.appendChild(hiddenDrawer);

  box.appendChild(buildItemTable(app, month, step, editable));
  box.appendChild(buildMobileCards(app, month, step, editable));

  const totalsBar = document.createElement("div");
  totalsBar.className = "step-totals sticky-totals";
  totalsBar.id = "step-totals";
  box.appendChild(totalsBar);
  refreshStepTotals(app, month, step);
  return box;
}

async function toggleHidden(app, code, hide) {
  const cur = new Set(app.boot.hidden || []);
  if (hide) cur.add(code); else cur.delete(code);
  try {
    const data = await call("setHidden", { codes: Array.from(cur) }, { token: getPcuToken() });
    app.boot.hidden = data.hidden;
  } catch (err) {
    await alertDialog("บันทึกรายการที่ไม่เบิกไม่สำเร็จ", `<p>${esc(err.message || "")}</p>`);
    throw err;
  }
}

// Q90 helper lines. Plan / used-this-FY are fy_current numbers, so they only show on rounds of fy_current
// (never any previous-FY numbers); "เดือนก่อน" comes from the previous calendar month's submitted request.
function hintHtml(app, month, item) {
  const data = monthData(app, month);
  const lines = [];
  if (roundUsesCurrentFy(app, month)) {
    const plan = app.boot.plans && app.boot.plans[item.code];
    const planTotal = plan ? (Number(plan[0]) || 0) + (Number(plan[1]) || 0) : 0;
    const used = (data.used_fy && data.used_fy[item.code]) || 0;
    lines.push(`แผนปี ${fyShort(app.boot.config.fy_current)}: ${formatInt(planTotal)} · เบิกแล้วปีนี้: ${formatInt(used)}`);
  }
  const prev = data.prev_lines && data.prev_lines[item.code];
  if (prev) lines.push(`เดือนก่อน: OP ${formatInt(prev.op)} / PP ${formatInt(prev.pp)}`);
  return lines.map((t) => `<div class="ghost-line">${esc(t)}</div>`).join("");
}

function valStr(v) {
  return v == null ? "" : String(v);
}

function buildItemTable(app, month, step, editable) {
  const table = document.createElement("table");
  table.className = "item-table";
  const req = stockRequired(app);
  table.innerHTML = `<thead><tr>
    <th class="col-seq">ลำดับ</th>
    <th class="col-name">รายการ</th>
    <th class="col-unit">หน่วย</th>
    <th class="col-price">ราคา/หน่วย</th>
    <th class="col-num">คงเหลือ${req ? " *" : ""}</th>
    <th class="col-num">OP</th>
    <th class="col-num">PP</th>
    <th class="col-num">รวม</th>
    <th class="col-money">เป็นเงิน</th>
    <th class="col-action"></th>
  </tr></thead>`;
  const tbody = document.createElement("tbody");
  const hidden = hiddenSet(app);
  for (const row of step.rows) {
    if (row.type === "section") {
      const tr = document.createElement("tr");
      tr.className = "section-row";
      tr.innerHTML = `<td colspan="10">${esc(row.title)}</td>`;
      tbody.appendChild(tr);
      continue;
    }
    if (row.active === false || hidden.has(row.code)) continue;
    tbody.appendChild(buildItemTr(app, month, row, editable));
  }
  table.appendChild(tbody);
  return table;
}

function inputHtml(field, value, editable) {
  return `<input class="num-input" data-field="${field}" inputmode="numeric" autocomplete="off" maxlength="5" value="${esc(valStr(value))}" ${editable ? "" : "disabled"}>`;
}

function buildItemTr(app, month, item, editable) {
  const tr = document.createElement("tr");
  tr.className = "item-row";
  tr.dataset.code = item.code;
  const line = sync.getLine(pcuCode(app), month, item.code);
  const total = lineTotal(line);

  tr.innerHTML = `
    <td class="col-seq">${esc(item.seq)}</td>
    <td class="col-name"><div class="item-name">${esc(item.name)}</div>
      ${hintHtml(app, month, item)}
      <div class="limit-msg" data-limit-for="${esc(item.code)}"></div></td>
    <td class="col-unit">${esc(item.unit || "")}</td>
    <td class="col-price">${formatMoney(item.price)}</td>
    <td class="col-num">${inputHtml("stock", line.stock, editable)}</td>
    <td class="col-num">${inputHtml("op", line.op, editable)}</td>
    <td class="col-num">${inputHtml("pp", line.pp, editable)}</td>
    <td class="col-num row-total">${formatInt(total)}</td>
    <td class="col-money row-money">${formatMoney(total * item.price)}</td>
    <td class="col-action">${editable ? `<button type="button" class="btn btn-link btn-hide" data-hide="${esc(item.code)}">ไม่เบิก</button>` : ""}</td>`;
  return tr;
}

function buildMobileCards(app, month, step, editable) {
  const wrap = document.createElement("div");
  wrap.className = "item-cards";
  const hidden = hiddenSet(app);
  for (const row of step.rows) {
    if (row.type === "section") {
      const h = document.createElement("div");
      h.className = "section-heading";
      h.textContent = row.title;
      wrap.appendChild(h);
      continue;
    }
    if (row.active === false || hidden.has(row.code)) continue;
    wrap.appendChild(buildItemCard(app, month, row, editable));
  }
  return wrap;
}

function buildItemCard(app, month, item, editable) {
  const card = document.createElement("div");
  card.className = "item-card";
  card.dataset.code = item.code;
  const line = sync.getLine(pcuCode(app), month, item.code);
  const total = lineTotal(line);
  const req = stockRequired(app);

  card.innerHTML = `
    <div class="item-card-head">
      <span class="item-seq">${esc(item.seq)}</span>
      <span class="item-name">${esc(item.name)}</span>
      ${editable ? `<button type="button" class="btn btn-link btn-hide" data-hide="${esc(item.code)}">ไม่เบิก</button>` : ""}
    </div>
    <div class="item-card-meta">หน่วย: ${esc(item.unit || "")} · ราคา/หน่วย: ${formatMoney(item.price)}</div>
    ${hintHtml(app, month, item)}
    <div class="item-card-inputs">
      <label>คงเหลือ${req ? " *" : ""}${inputHtml("stock", line.stock, editable)}</label>
      <label>OP${inputHtml("op", line.op, editable)}</label>
      <label>PP${inputHtml("pp", line.pp, editable)}</label>
    </div>
    <div class="item-card-total">รวม <span class="row-total">${formatInt(total)}</span> · เป็นเงิน <span class="row-money">${formatMoney(total * item.price)}</span></div>
    <div class="limit-msg" data-limit-for="${esc(item.code)}"></div>`;
  return card;
}

function refreshStepTotals(app, month, step) {
  const t = stepTotals(app, step, month);
  const el = document.getElementById("step-totals");
  if (!el) return;
  el.innerHTML = `<strong>รวมขั้นตอนนี้</strong> — OP ${formatInt(t.op)} · PP ${formatInt(t.pp)} · รวม ${formatInt(t.qty)} · เป็นเงิน ${formatMoney(t.money)} บาท`;
}

// Ceiling feedback for one item — only when exceeded (Q90): warn = red, enforce = red + blocked, or the
// admin's unlock reason when an unlock exists for this month.
function refreshRowLimit(app, month, item) {
  const line = sync.getLine(pcuCode(app), month, item.code);
  const st = roundUsesCurrentFy(app, month)
    ? limitStatus({
        mode: app.boot.config.limit_mode, limits: app.boot.limits, usedFy: monthData(app, month).used_fy,
        unlocks: unlocksOf(app, month), code: item.code, total: lineTotal(line),
      })
    : null;
  const unlocked = !!st && st.unlockReason !== null;
  document.querySelectorAll(`[data-code="${item.code}"] input.num-input`).forEach((inp) => {
    if (inp.dataset.field === "stock") return;
    inp.classList.toggle("input-error", !!st && !unlocked);
    inp.classList.toggle("input-warn", unlocked);
  });
  document.querySelectorAll(`[data-limit-for="${item.code}"]`).forEach((box) => {
    if (!st) { box.innerHTML = ""; return; }
    const msgs = st.messages.map((m) => `<div class="limit-line ${unlocked ? "limit-info" : "limit-danger"}">${esc(m)}</div>`);
    if (unlocked) msgs.push(`<div class="limit-line limit-unlocked">ปลดล็อกโดย admin${st.unlockReason ? ": " + esc(st.unlockReason) : ""}</div>`);
    else if (st.blocked) msgs.push(`<div class="limit-line limit-danger">ส่งไม่ได้จนกว่า admin จะปลดล็อก</div>`);
    box.innerHTML = msgs.join("");
  });
}

function wireStepEvents(app, month, step, editable) {
  const container = document.getElementById("app");
  const items = getActiveItemRows(step);

  container.querySelectorAll(".num-input").forEach((input) => {
    input.addEventListener("input", () => {
      const digits = input.value.replace(/[^0-9]/g, "").slice(0, 5);
      if (digits !== input.value) input.value = digits;
      const tr = input.closest("[data-code]");
      const code = tr.dataset.code;
      const field = input.dataset.field;
      const item = items.find((it) => it.code === code);

      sync.setLine(pcuCode(app), month, code, field, digits === "" ? null : parseInt(digits, 10));
      if (field === "stock") {
        input.classList.remove("input-error");
        sendUi.missing.delete(code);
      }
      const line = sync.getLine(pcuCode(app), month, code);
      const total = lineTotal(line);
      document.querySelectorAll(`[data-code="${code}"] .row-total`).forEach((el) => { el.textContent = formatInt(total); });
      document.querySelectorAll(`[data-code="${code}"] .row-money`).forEach((el) => { el.textContent = formatMoney(total * item.price); });
      refreshStepTotals(app, month, step);
      refreshRowLimit(app, month, item);
      refreshStatusChip(app, month);
    });

    input.addEventListener("blur", () => sync.flush(pcuCode(app), month));

    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      moveToNextInput(app, input, step);
    });
  });

  container.querySelectorAll("[data-hide]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const code = btn.dataset.hide;
      btn.disabled = true;
      try {
        await toggleHidden(app, code, true);
        renderFill(container, app, step.code, null);
      } catch (err) {
        btn.disabled = false;
      }
    });
  });

  items.forEach((item) => refreshRowLimit(app, month, item));
  refreshStatusChip(app, month);
}

function moveToNextInput(app, currentInput, step) {
  const order = ["stock", "op", "pp"];
  const items = activeStepItems(app, step);
  const tr = currentInput.closest("[data-code]");
  const code = tr.dataset.code;
  const field = currentInput.dataset.field;
  const itemIdx = items.findIndex((it) => it.code === code);
  const fieldIdx = order.indexOf(field);

  let nextSelector = null;
  if (fieldIdx < order.length - 1) {
    nextSelector = `[data-code="${code}"] input[data-field="${order[fieldIdx + 1]}"]`;
  } else if (itemIdx < items.length - 1) {
    nextSelector = `[data-code="${items[itemIdx + 1].code}"] input[data-field="stock"]`;
  } else {
    return;
  }
  const isCard = !!currentInput.closest(".item-card");
  const scope = document.querySelector(isCard ? ".item-cards" : ".item-table");
  const next = (scope && scope.querySelector(nextSelector)) || document.querySelector(nextSelector);
  if (next) next.focus();
}

// After a blocked send for missing คงเหลือ (stock_required=1): red fields + a note on the step.
function markMissing(step, content, app, month) {
  if (!sendUi.missing.size || sendUi.month !== month || !step) return;
  const hidden = hiddenSet(app);
  let n = 0;
  getActiveItemRows(step).forEach((item) => {
    const line = sync.getLine(pcuCode(app), month, item.code);
    if (!sendUi.missing.has(item.code) || hidden.has(item.code) || line.stock != null) return;
    n++;
    document.querySelectorAll(`[data-code="${item.code}"] input[data-field="stock"]`).forEach((el) => el.classList.add("input-error"));
  });
  if (n > 0) {
    const note = document.createElement("div");
    note.className = "notice notice-error";
    note.textContent = `ยังไม่กรอกคงเหลือ ${n} รายการในหน้านี้ (ช่องสีแดง) — ไม่มีของให้กรอก 0`;
    content.prepend(note);
  }
}

function focusItem(code, field) {
  setTimeout(() => {
    const visibleInputs = Array.from(document.querySelectorAll(`[data-code="${code}"] input[data-field="${field}"]`))
      .filter((el) => el.offsetParent !== null);
    const target = visibleInputs[0];
    const rowEls = document.querySelectorAll(`[data-code="${code}"]`);
    rowEls.forEach((el) => {
      el.classList.add("row-highlight");
      setTimeout(() => el.classList.remove("row-highlight"), 3000);
    });
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.focus();
    } else if (rowEls[0]) {
      rowEls[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 30);
}

// ---------------- summary step ----------------

function renderSummary(app, month, steps) {
  const box = document.createElement("div");
  box.className = "summary-page";
  const request = requestOf(app, month);
  const issueInfo = monthData(app, month).issue;
  // every needed unit issued -> nothing left to send (re-sending an issued request is pointless)
  const editable = isEditable(app, month) && !(issueInfo && issueInfo.done);
  const round = roundOf(app, month);

  let grandOp = 0, grandPp = 0, grandQty = 0, grandMoney = 0;
  const stepRows = steps.map((step) => {
    const t = stepTotals(app, step, month);
    grandOp += t.op; grandPp += t.pp; grandQty += t.qty; grandMoney += t.money;
    return { code: step.code, title: stepLabel(step), t, issued: isStepIssued(app, month, step) };
  });
  const lockedSteps = stepRows.filter((s) => s.issued);
  const { missing, overs } = collectIssues(app, month);

  box.innerHTML = `
    <h2>สรุปยอด${editable ? "ก่อนส่ง" : ""}</h2>
    <table class="summary-table">
      <thead><tr><th>หน้า</th><th>OP</th><th>PP</th><th>รวม</th><th>เป็นเงิน (บาท)</th></tr></thead>
      <tbody>
        ${stepRows.map((s) => `<tr${s.issued ? ' class="row-issued"' : ""}><td>${esc(s.title)}${s.issued ? ' <span class="badge badge-success">จ่ายแล้ว</span>' : ""}</td><td>${formatInt(s.t.op)}</td><td>${formatInt(s.t.pp)}</td><td>${formatInt(s.t.qty)}</td><td>${formatMoney(s.t.money)}</td></tr>`).join("")}
        <tr class="grand-row"><td>รวมทั้งหมด</td><td>${formatInt(grandOp)}</td><td>${formatInt(grandPp)}</td><td>${formatInt(grandQty)}</td><td>${formatMoney(grandMoney)}</td></tr>
      </tbody>
    </table>

    ${lockedSteps.length ? `
    <div class="notice notice-issued" id="summary-issued">หน้าที่จ่ายของแล้ว (แก้ไขไม่ได้): ${lockedSteps.map((s) => esc(s.title)).join(", ")}
      — <a href="#/issue?month=${esc(month)}">ดูการจ่าย</a></div>` : ""}

    ${stockRequired(app) ? `
    <div class="summary-section" id="missing-box">
      <h3>รายการที่ยังไม่กรอกคงเหลือ (${missing.length})</h3>
      ${missing.length === 0 ? '<p class="muted">กรอกครบทุกรายการแล้ว</p>' : `<ul class="jump-list">${missing.map((m) => `<li><a href="#" data-jump="${esc(m.stepCode)}" data-code="${esc(m.code)}">${esc(m.name)} (${esc(m.code)})</a></li>`).join("")}</ul>`}
    </div>` : ""}

    ${app.boot.config.limit_mode !== "off" && overs.length ? `
    <div class="summary-section" id="over-box">
      <h3>รายการที่เกินเพดาน (${overs.length})</h3>
      <ul class="jump-list">${overs.map((o) => `<li><a href="#" data-jump="${esc(o.stepCode)}" data-code="${esc(o.code)}" data-field="op">${esc(o.name)} (${esc(o.code)})</a>
        <div class="${o.status.unlockReason !== null ? "limit-info" : "limit-danger"} small">${o.status.messages.map(esc).join(" · ")}${o.status.unlockReason !== null ? ` — ปลดล็อกโดย admin${o.status.unlockReason ? ": " + esc(o.status.unlockReason) : ""}` : o.status.blocked ? " — ส่งไม่ได้จนกว่า admin จะปลดล็อก" : ""}</div></li>`).join("")}</ul>
    </div>` : ""}

    <div class="summary-section">
      <label class="field-label">ชื่อผู้กรอก (ไม่บังคับ, ไม่พิมพ์ในใบเบิก)
        <input type="text" id="submitter-name" maxlength="120" value="${esc(request ? request.submitter_name || "" : "")}" ${editable ? "" : "disabled"}>
      </label>
    </div>

    <div class="summary-actions">
      ${editable
        ? `<button type="button" class="btn btn-primary" id="btn-save">บันทึก</button>
           <button type="button" class="btn btn-secondary" id="btn-print">พิมพ์</button>
           <!-- 2b: "ดาวน์โหลด PDF" button goes here (requestPdf; = send + download, spec §4.4). Not in 2a. -->`
        : `<button type="button" class="btn btn-secondary" id="btn-print-view">ดู/พิมพ์ใบเบิก</button>`}
    </div>
    <p class="muted send-hint">${editable ? "บันทึก และ พิมพ์ = ส่งใบเบิกให้ผู้ดูแล (กดซ้ำเพื่อส่งใหม่หลังแก้ไข)" : ""}</p>
    ${round && editable && round.deadline_date ? `<p class="muted">กรุณาส่งภายใน ${esc(formatThaiYmd(round.deadline_date))}</p>` : ""}
  `;

  box.querySelectorAll("[data-jump]").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      location.hash = `#/fill/${a.dataset.jump}?month=${month}&focus=${encodeURIComponent(a.dataset.code)}&field=${a.dataset.field || "stock"}`;
    });
  });

  const nameInput = box.querySelector("#submitter-name");
  if (nameInput) {
    nameInput.addEventListener("input", () => sync.setSubmitterName(pcuCode(app), month, nameInput.value));
    nameInput.addEventListener("blur", () => sync.flush(pcuCode(app), month));
  }

  const saveBtn = box.querySelector("#btn-save");
  const printBtn = box.querySelector("#btn-print");
  const viewBtn = box.querySelector("#btn-print-view");
  if (viewBtn) viewBtn.addEventListener("click", () => { location.hash = `#/print?month=${month}`; });
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true; printBtn.disabled = true;
      try {
        if (await trySend(app, month)) await renderFill(document.getElementById("app"), app, "summary", null);
      } finally {
        saveBtn.disabled = false; printBtn.disabled = false;
      }
    });
  }
  if (printBtn) {
    printBtn.addEventListener("click", async () => {
      saveBtn.disabled = true; printBtn.disabled = true;
      try {
        if (await trySend(app, month)) location.hash = `#/print?month=${month}`;
      } finally {
        saveBtn.disabled = false; printBtn.disabled = false;
      }
    });
  }
  return box;
}
