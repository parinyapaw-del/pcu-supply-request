// Fill wizard: step 1 = P1, step 2 = LAB, step 3 = สรุป (summary).
import { ACTIVE_STEPS } from "../constants.js";
import { getStep, getItemRows } from "../data.js";
import * as store from "../store.js";
import { simMonth } from "../sim.js";
import { prevMonthKey, formatInt, formatMoney, nowTimeHHMM, isAfterDeadline } from "../format.js";
import { computeLimitInfo, monthOverMessage, yearInfoMessage, yearOverMessage, isAnyLimitExceeded, getLimitEntry } from "../limits.js";

const WIZARD_STEPS = [...ACTIVE_STEPS, "summary"];

// Module-scoped mutable state for whichever PCU/month is currently open in the wizard.
let S = null;

function ensureState(app) {
  if (S && S.pcu === app.pcu && S.monthKey === app.monthKey) return S;
  S = {
    pcu: app.pcu,
    monthKey: app.monthKey,
    request: store.getOrCreateRequest(app.pcu, app.monthKey),
    saveTimer: null,
    missing: new Set(),
    over: new Set(),
  };
  return S;
}

function flushSave() {
  if (!S) return;
  if (S.saveTimer) {
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
  }
  S.request.updated_at = new Date().toISOString();
  store.saveRequest(S.pcu, S.monthKey, S.request);
  S.lastSavedAt = new Date();
}

function scheduleSave(onSaved) {
  if (S.saveTimer) clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => {
    flushSave();
    if (onSaved) onSaved();
  }, 2000);
}

function isHidden(pcu, code) {
  return store.getHiddenItems(pcu).includes(code);
}

function getLine(code) {
  return S.request.lines[code] || { stock: null, op: 0, pp: 0 };
}

function setLineField(code, field, value) {
  if (!S.request.lines[code]) S.request.lines[code] = { stock: null, op: 0, pp: 0 };
  S.request.lines[code][field] = value;
}

function activeStepItems(step, pcu) {
  return getItemRows(step).filter((it) => !isHidden(pcu, it.code));
}

function stepTotals(step, pcu) {
  let op = 0, pp = 0, qty = 0, money = 0;
  for (const it of activeStepItems(step, pcu)) {
    const line = getLine(it.code);
    const o = Number(line.op) || 0, p = Number(line.pp) || 0;
    op += o; pp += p; qty += o + p; money += (o + p) * it.price;
  }
  return { op, pp, qty, money };
}

function stepMissingCodes(step, pcu) {
  return activeStepItems(step, pcu)
    .filter((it) => getLine(it.code).stock == null)
    .map((it) => it.code);
}

export async function renderFill(container, app, stepCode, params) {
  if (!WIZARD_STEPS.includes(stepCode)) stepCode = WIZARD_STEPS.find((c) => c.toLowerCase() === String(stepCode).toLowerCase()) || WIZARD_STEPS[0];
  const state = ensureState(app);
  const round = app.rounds.find((r) => r.monthKey === app.monthKey);
  const pcuInfo = app.form.pcus.find((p) => p.code === app.pcu);

  const wrap = document.createElement("div");
  wrap.className = "fill-page";

  wrap.appendChild(renderProgressBar(app, stepCode));

  const content = document.createElement("div");
  content.className = "fill-content";
  if (stepCode === "summary") {
    content.appendChild(renderSummary(app, state, round, pcuInfo));
  } else {
    const step = getStep(app.form, stepCode);
    if (!step) {
      content.textContent = "ไม่พบขั้นตอนนี้";
    } else {
      content.appendChild(renderStepForm(app, state, step));
    }
  }
  wrap.appendChild(content);

  wrap.appendChild(renderNav(app, state, stepCode));

  container.innerHTML = "";
  container.appendChild(wrap);

  if (stepCode !== "summary") {
    wireStepEvents(app, state, getStep(app.form, stepCode));
    markMissing(state, getStep(app.form, stepCode), content);
    if (params && params.get("focus")) {
      focusItem(params.get("focus"), params.get("field") || "stock");
    }
  }
}

function renderProgressBar(app, stepCode) {
  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const labels = { P1: "1. แบบ พัสดุ 1", LAB: "2. แบบ LAB", summary: "3. สรุป" };
  WIZARD_STEPS.forEach((code, i) => {
    const dot = document.createElement("a");
    const idx = WIZARD_STEPS.indexOf(stepCode);
    dot.className = "progress-step" + (code === stepCode ? " active" : i < idx ? " done" : "");
    dot.textContent = labels[code] || code;
    dot.href = `#/fill/${code}?pcu=${app.pcu}&month=${app.monthKey}`;
    dot.addEventListener("click", () => flushSave());
    bar.appendChild(dot);
  });
  return bar;
}

function renderNav(app, state, stepCode) {
  const nav = document.createElement("div");
  nav.className = "wizard-nav";

  const idx = WIZARD_STEPS.indexOf(stepCode);
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn-secondary";
  backBtn.textContent = "ย้อนกลับ";
  backBtn.disabled = idx <= 0;
  backBtn.addEventListener("click", () => {
    flushSave();
    location.hash = `#/fill/${WIZARD_STEPS[idx - 1]}?pcu=${app.pcu}&month=${app.monthKey}`;
  });

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn btn-primary";
  nextBtn.textContent = idx >= WIZARD_STEPS.length - 1 ? "ไปหน้าสรุป" : "ถัดไป";
  nextBtn.disabled = idx >= WIZARD_STEPS.length - 1;
  nextBtn.addEventListener("click", () => {
    flushSave();
    location.hash = `#/fill/${WIZARD_STEPS[idx + 1]}?pcu=${app.pcu}&month=${app.monthKey}`;
  });

  const status = document.createElement("span");
  status.className = "autosave-status";
  status.id = "autosave-status";
  status.textContent = S.lastSavedAt ? `บันทึกแล้ว ${nowTimeHHMM(S.lastSavedAt)}` : "";

  nav.appendChild(backBtn);
  nav.appendChild(status);
  nav.appendChild(nextBtn);
  return nav;
}

function updateAutosaveStatus() {
  const el = document.getElementById("autosave-status");
  if (el) el.textContent = `บันทึกแล้ว ${nowTimeHHMM(new Date())}`;
}

// ---------------- item step (P1 / LAB) ----------------

function renderStepForm(app, state, step) {
  const box = document.createElement("div");
  box.className = "step-form";

  const readonly = S.request.status === "submitted";
  if (readonly) {
    const note = document.createElement("div");
    note.className = "notice notice-info";
    note.textContent = "ใบนี้ส่งแล้ว — ข้อมูลอ่านอย่างเดียว กด “ถอนการส่ง” ที่หน้าสรุปหากต้องการแก้ไข";
    box.appendChild(note);
  }

  const hiddenCodes = store.getHiddenItems(app.pcu).filter((c) => getItemRows(step).some((it) => it.code === c));
  const hiddenDrawer = document.createElement("details");
  hiddenDrawer.className = "hidden-drawer";
  hiddenDrawer.innerHTML = `<summary>รายการที่ซ่อน (${hiddenCodes.length})</summary>`;
  const hiddenList = document.createElement("div");
  hiddenList.className = "hidden-list";
  if (hiddenCodes.length === 0) {
    hiddenList.innerHTML = `<p class="muted">ไม่มีรายการที่ซ่อนในขั้นตอนนี้</p>`;
  } else {
    hiddenCodes.forEach((code) => {
      const item = getItemRows(step).find((it) => it.code === code);
      const row = document.createElement("div");
      row.className = "hidden-item-row";
      row.innerHTML = `<span>${escapeHtml(item.name)}</span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-link";
      btn.textContent = "กู้คืน";
      btn.disabled = readonly;
      btn.addEventListener("click", () => {
        store.unhideItem(app.pcu, code);
        renderFill(document.getElementById("app"), app, step.code);
      });
      row.appendChild(btn);
      hiddenList.appendChild(row);
    });
  }
  hiddenDrawer.appendChild(hiddenList);
  box.appendChild(hiddenDrawer);

  box.appendChild(buildItemTable(app, state, step, readonly));
  box.appendChild(buildMobileCards(app, state, step, readonly));

  const totalsBar = document.createElement("div");
  totalsBar.className = "step-totals sticky-totals";
  totalsBar.id = "step-totals";
  box.appendChild(totalsBar);
  refreshStepTotals(step, app.pcu);

  return box;
}

function itemHasPrice(item) {
  return item.price > 0;
}

function buildItemTable(app, state, step, readonly) {
  const table = document.createElement("table");
  table.className = "item-table";
  table.innerHTML = `<thead><tr>
    <th class="col-seq">ลำดับ</th>
    <th class="col-name">รายการ</th>
    <th class="col-unit">หน่วย</th>
    <th class="col-price">ราคา/หน่วย</th>
    <th class="col-num">คงเหลือ</th>
    <th class="col-num">OP</th>
    <th class="col-num">PP</th>
    <th class="col-num">รวม</th>
    <th class="col-money">เป็นเงิน</th>
    <th class="col-action"></th>
  </tr></thead>`;
  const tbody = document.createElement("tbody");

  for (const row of step.rows) {
    if (row.type === "section") {
      const tr = document.createElement("tr");
      tr.className = "section-row";
      tr.innerHTML = `<td colspan="10">${escapeHtml(row.title)}</td>`;
      tbody.appendChild(tr);
      continue;
    }
    if (isHidden(app.pcu, row.code)) continue;
    tbody.appendChild(buildItemTr(app, step, row, readonly));
  }
  table.appendChild(tbody);
  return table;
}

function ghostInfo(app, item) {
  const prevKey = prevMonthKey(app.monthKey);
  const prevReq = store.getRequest(app.pcu, prevKey);
  if (prevReq && prevReq.lines && prevReq.lines[item.code]) {
    const l = prevReq.lines[item.code];
    return { stock: l.stock, op: l.op || 0, pp: l.pp || 0, simulated: false };
  }
  const limitEntry = getLimitEntry(app.limits, app.pcu, item.code);
  const limitYear = limitEntry ? limitEntry.limit_year : null;
  const sim = simMonth(app.pcu, item.code, item.price, prevKey, limitYear);
  return { stock: sim.stock, op: sim.op, pp: sim.pp, simulated: true };
}

function buildItemTr(app, step, item, readonly) {
  const tr = document.createElement("tr");
  tr.className = "item-row";
  tr.dataset.code = item.code;
  const line = getLine(item.code);
  const ghost = ghostInfo(app, item);
  const priceKnown = itemHasPrice(item);

  const nameCell = `<div class="item-name">${escapeHtml(item.name)}${priceKnown ? "" : ' <span class="badge badge-warn">ยังไม่มีราคา</span>'}</div>
    <div class="ghost-line" title="${ghost.simulated ? "ค่าเดือนก่อนเป็นข้อมูลจำลอง" : "ค่าเดือนก่อนจากข้อมูลจริงที่บันทึกไว้"}">
      เดือนก่อน: คงเหลือ ${ghost.stock == null ? "-" : formatInt(ghost.stock)} · OP ${formatInt(ghost.op)} · PP ${formatInt(ghost.pp)}${ghost.simulated ? " <span class=\"tag-sim\">(จำลอง)</span>" : ""}
    </div>
    <div class="limit-msg" data-limit-for="${item.code}"></div>`;

  tr.innerHTML = `
    <td class="col-seq">${item.seq}</td>
    <td class="col-name">${nameCell}</td>
    <td class="col-unit">${escapeHtml(item.unit || "")}</td>
    <td class="col-price">${formatMoney(item.price)}</td>
    <td class="col-num"><input class="num-input" data-field="stock" inputmode="numeric" autocomplete="off" value="${line.stock == null ? "" : line.stock}" ${readonly ? "disabled" : ""}></td>
    <td class="col-num"><input class="num-input" data-field="op" inputmode="numeric" autocomplete="off" value="${line.op || ""}" ${readonly ? "disabled" : ""}></td>
    <td class="col-num"><input class="num-input" data-field="pp" inputmode="numeric" autocomplete="off" value="${line.pp || ""}" ${readonly ? "disabled" : ""}></td>
    <td class="col-num row-total">${formatInt((line.op || 0) + (line.pp || 0))}</td>
    <td class="col-money row-money">${formatMoney(((line.op || 0) + (line.pp || 0)) * item.price)}</td>
    <td class="col-action">${readonly ? "" : `<button type="button" class="btn btn-link btn-hide" data-hide="${item.code}">ซ่อน</button>`}</td>`;
  return tr;
}

function buildMobileCards(app, state, step, readonly) {
  const wrap = document.createElement("div");
  wrap.className = "item-cards";
  for (const row of step.rows) {
    if (row.type === "section") {
      const h = document.createElement("div");
      h.className = "section-heading";
      h.textContent = row.title;
      wrap.appendChild(h);
      continue;
    }
    if (isHidden(app.pcu, row.code)) continue;
    wrap.appendChild(buildItemCard(app, step, row, readonly));
  }
  return wrap;
}

function buildItemCard(app, step, item, readonly) {
  const card = document.createElement("div");
  card.className = "item-card";
  card.dataset.code = item.code;
  const line = getLine(item.code);
  const ghost = ghostInfo(app, item);
  const priceKnown = itemHasPrice(item);

  card.innerHTML = `
    <div class="item-card-head">
      <span class="item-seq">${item.seq}</span>
      <span class="item-name">${escapeHtml(item.name)}${priceKnown ? "" : ' <span class="badge badge-warn">ยังไม่มีราคา</span>'}</span>
      ${readonly ? "" : `<button type="button" class="btn btn-link btn-hide" data-hide="${item.code}">ซ่อน</button>`}
    </div>
    <div class="item-card-meta">หน่วย: ${escapeHtml(item.unit || "")} · ราคา/หน่วย: ${formatMoney(item.price)}</div>
    <div class="ghost-line" title="${ghost.simulated ? "ค่าเดือนก่อนเป็นข้อมูลจำลอง" : "ค่าเดือนก่อนจากข้อมูลจริงที่บันทึกไว้"}">
      เดือนก่อน: คงเหลือ ${ghost.stock == null ? "-" : formatInt(ghost.stock)} · OP ${formatInt(ghost.op)} · PP ${formatInt(ghost.pp)}${ghost.simulated ? " <span class=\"tag-sim\">(จำลอง)</span>" : ""}
    </div>
    <div class="item-card-inputs">
      <label>คงเหลือ<input class="num-input" data-field="stock" inputmode="numeric" autocomplete="off" value="${line.stock == null ? "" : line.stock}" ${readonly ? "disabled" : ""}></label>
      <label>OP<input class="num-input" data-field="op" inputmode="numeric" autocomplete="off" value="${line.op || ""}" ${readonly ? "disabled" : ""}></label>
      <label>PP<input class="num-input" data-field="pp" inputmode="numeric" autocomplete="off" value="${line.pp || ""}" ${readonly ? "disabled" : ""}></label>
    </div>
    <div class="item-card-total">รวม <span class="row-total">${formatInt((line.op || 0) + (line.pp || 0))}</span> · เป็นเงิน <span class="row-money">${formatMoney(((line.op || 0) + (line.pp || 0)) * item.price)}</span></div>
    <div class="limit-msg" data-limit-for="${item.code}"></div>`;
  return card;
}

function refreshStepTotals(step, pcu) {
  const t = stepTotals(step, pcu);
  const el = document.getElementById("step-totals");
  if (!el) return;
  el.innerHTML = `<strong>รวมขั้นตอนนี้</strong> — OP ${formatInt(t.op)} · PP ${formatInt(t.pp)} · รวม ${formatInt(t.qty)} · เป็นเงิน ${formatMoney(t.money)} บาท`;
}

function refreshRowLimit(app, item) {
  const line = getLine(item.code);
  const opPp = (Number(line.op) || 0) + (Number(line.pp) || 0);
  const info = computeLimitInfo(app.limits, app.pcu, item.code, item.price, app.monthKey, opPp);
  document.querySelectorAll(`[data-code="${item.code}"] input.num-input`).forEach((inp) => {
    inp.classList.toggle("input-error", !!info && isAnyLimitExceeded(info) && (inp.dataset.field === "op" || inp.dataset.field === "pp"));
  });
  document.querySelectorAll(`[data-limit-for="${item.code}"]`).forEach((box) => {
    if (!info) {
      box.innerHTML = "";
      return;
    }
    const parts = [];
    const monthMsg = monthOverMessage(info);
    if (monthMsg) parts.push(`<div class="limit-line limit-danger">${escapeHtml(monthMsg)}</div>`);
    const yearMsg = yearInfoMessage(info);
    if (yearMsg && !info.yearOver) parts.push(`<div class="limit-line limit-info">${escapeHtml(yearMsg)}</div>`);
    const yearOver = yearOverMessage(info);
    if (yearOver) parts.push(`<div class="limit-line limit-danger">${escapeHtml(yearOver)}</div>`);
    box.innerHTML = parts.join("");
  });
}

function sanitizeDigits(str) {
  return str.replace(/[^0-9]/g, "");
}

function wireStepEvents(app, state, step) {
  const container = document.getElementById("app");

  container.querySelectorAll(".num-input").forEach((input) => {
    input.addEventListener("input", () => {
      const digits = sanitizeDigits(input.value);
      if (digits !== input.value) input.value = digits;
      const tr = input.closest("[data-code]");
      const code = tr.dataset.code;
      const field = input.dataset.field;
      const item = getItemRows(step).find((it) => it.code === code);

      if (field === "stock") {
        setLineField(code, "stock", digits === "" ? null : parseInt(digits, 10));
        input.classList.remove("input-error");
        state.missing.delete(code);
      } else {
        setLineField(code, field, digits === "" ? 0 : parseInt(digits, 10));
      }

      document.querySelectorAll(`[data-code="${code}"] .row-total`).forEach((el) => {
        const line = getLine(code);
        el.textContent = formatInt((line.op || 0) + (line.pp || 0));
      });
      document.querySelectorAll(`[data-code="${code}"] .row-money`).forEach((el) => {
        const line = getLine(code);
        el.textContent = formatMoney(((line.op || 0) + (line.pp || 0)) * item.price);
      });
      refreshStepTotals(step, app.pcu);
      refreshRowLimit(app, item);
      scheduleSave(updateAutosaveStatus);
    });

    input.addEventListener("blur", () => flushSave());

    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      moveToNextInput(input, step, app.pcu);
    });
  });

  container.querySelectorAll("[data-hide]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.hide;
      store.hideItem(app.pcu, code);
      flushSave();
      renderFill(container, app, step.code);
    });
  });

  // pre-existing limit/refresh pass for items that already have values on load
  getItemRows(step).forEach((item) => refreshRowLimit(app, item));
}

function moveToNextInput(currentInput, step, pcu) {
  const order = ["stock", "op", "pp"];
  const items = activeStepItems(step, pcu);
  const tr = currentInput.closest("[data-code]");
  const code = tr.dataset.code;
  const field = currentInput.dataset.field;
  const itemIdx = items.findIndex((it) => it.code === code);
  const fieldIdx = order.indexOf(field);

  let nextSelector = null;
  if (fieldIdx < order.length - 1) {
    nextSelector = `[data-code="${code}"] input[data-field="${order[fieldIdx + 1]}"]`;
  } else if (itemIdx < items.length - 1) {
    const nextCode = items[itemIdx + 1].code;
    nextSelector = `[data-code="${nextCode}"] input[data-field="stock"]`;
  } else {
    return; // last input of the step: Enter does nothing special
  }
  // Prefer the visible layout (table row vs mobile card) matching current input's container type.
  const isCard = !!currentInput.closest(".item-card");
  const scopeClass = isCard ? ".item-cards" : ".item-table";
  const scope = document.querySelector(scopeClass);
  const next = (scope && scope.querySelector(nextSelector)) || document.querySelector(nextSelector);
  if (next) next.focus();
}

// After a blocked submit, keep every still-missing คงเหลือ input red and show a count at the top of the step.
function markMissing(state, step, content) {
  if (!state.missing.size || !step) return;
  const hidden = new Set(store.getHiddenItems(state.pcu));
  let n = 0;
  getItemRows(step).forEach((item) => {
    const line = getLine(item.code);
    if (!state.missing.has(item.code) || hidden.has(item.code) || line.stock != null) return;
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
      target.classList.add("input-error");
    } else if (rowEls[0]) {
      rowEls[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 30);
}

// ---------------- summary step ----------------

function renderSummary(app, state, round, pcuInfo) {
  const box = document.createElement("div");
  box.className = "summary-page";

  const readonly = S.request.status === "submitted";

  let grandOp = 0, grandPp = 0, grandQty = 0, grandMoney = 0;
  const stepRows = ACTIVE_STEPS.map((code) => {
    const step = getStep(app.form, code);
    const t = stepTotals(step, app.pcu);
    grandOp += t.op; grandPp += t.pp; grandQty += t.qty; grandMoney += t.money;
    return { code, title: step.title, t };
  });

  const missing = [];
  const overLimit = [];
  ACTIVE_STEPS.forEach((code) => {
    const step = getStep(app.form, code);
    activeStepItems(step, app.pcu).forEach((item) => {
      const line = getLine(item.code);
      if (line.stock == null) missing.push({ code: item.code, name: item.name, stepCode: code });
      const opPp = (Number(line.op) || 0) + (Number(line.pp) || 0);
      const info = computeLimitInfo(app.limits, app.pcu, item.code, item.price, app.monthKey, opPp);
      if (isAnyLimitExceeded(info)) overLimit.push({ code: item.code, name: item.name, stepCode: code, info });
    });
  });

  box.innerHTML = `
    <h2>สรุปยอดก่อนส่ง</h2>
    <table class="summary-table">
      <thead><tr><th>ขั้นตอน</th><th>OP</th><th>PP</th><th>รวม</th><th>เป็นเงิน</th></tr></thead>
      <tbody>
        ${stepRows.map((s) => `<tr><td>${escapeHtml(s.title)}</td><td>${formatInt(s.t.op)}</td><td>${formatInt(s.t.pp)}</td><td>${formatInt(s.t.qty)}</td><td>${formatMoney(s.t.money)}</td></tr>`).join("")}
        <tr class="grand-row"><td>รวมทั้งหมด</td><td>${formatInt(grandOp)}</td><td>${formatInt(grandPp)}</td><td>${formatInt(grandQty)}</td><td>${formatMoney(grandMoney)}</td></tr>
      </tbody>
    </table>

    <div class="summary-section" id="missing-box">
      <h3>รายการที่ยังไม่กรอกคงเหลือ (${missing.length})</h3>
      ${missing.length === 0 ? '<p class="muted">กรอกครบทุกรายการแล้ว</p>' : `<ul class="jump-list">${missing.map((m) => `<li><a href="#" data-jump="${m.stepCode}" data-code="${m.code}">${escapeHtml(m.name)} (${m.code})</a></li>`).join("")}</ul>`}
    </div>

    <div class="summary-section" id="over-box">
      <h3>รายการที่เกินเพดาน (${overLimit.length})</h3>
      ${overLimit.length === 0 ? '<p class="muted">ไม่มีรายการเกินเพดาน</p>' : `<ul class="jump-list">${overLimit.map((m) => `<li><a href="#" data-jump="${m.stepCode}" data-code="${m.code}" data-field="op">${escapeHtml(m.name)} (${m.code}) — ${escapeHtml(monthOverMessage(m.info) || yearOverMessage(m.info))}</a></li>`).join("")}</ul>`}
    </div>

    <div class="summary-section">
      <label class="field-label">ชื่อผู้กรอก (ไม่บังคับ, ไม่พิมพ์ในใบเบิก)
        <input type="text" id="submitter-name" value="${escapeHtml(S.request.submitter_name || "")}" ${readonly ? "disabled" : ""}>
      </label>
    </div>

    <div class="summary-actions">
      <button type="button" class="btn btn-secondary" id="btn-preview">ดูตัวอย่างใบพิมพ์</button>
      ${readonly
        ? `<button type="button" class="btn btn-secondary" id="btn-withdraw">ถอนการส่ง</button>
           <button type="button" class="btn btn-primary" id="btn-print">พิมพ์ใบเบิก</button>`
        : `<button type="button" class="btn btn-primary" id="btn-submit">ส่งใบเบิก</button>`}
    </div>
    <div class="status-line">${statusLine(round)}</div>
  `;

  box.querySelectorAll("[data-jump]").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const stepCode = a.dataset.jump;
      const code = a.dataset.code;
      const field = a.dataset.field || "stock";
      location.hash = `#/fill/${stepCode}?pcu=${app.pcu}&month=${app.monthKey}&focus=${code}&field=${field}`;
    });
  });

  const nameInput = box.querySelector("#submitter-name");
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      S.request.submitter_name = nameInput.value;
      scheduleSave();
    });
    nameInput.addEventListener("blur", () => flushSave());
  }

  box.querySelector("#btn-preview").addEventListener("click", () => {
    flushSave();
    location.hash = `#/print?pcu=${app.pcu}&month=${app.monthKey}`;
  });

  const printBtn = box.querySelector("#btn-print");
  if (printBtn) {
    printBtn.addEventListener("click", () => {
      location.hash = `#/print?pcu=${app.pcu}&month=${app.monthKey}`;
    });
  }

  const withdrawBtn = box.querySelector("#btn-withdraw");
  if (withdrawBtn) {
    withdrawBtn.addEventListener("click", () => {
      S.request.status = "draft";
      S.request.submitted_at = null;
      S.request.late = false;
      flushSave();
      renderFill(document.getElementById("app"), app, "summary");
    });
  }

  const submitBtn = box.querySelector("#btn-submit");
  if (submitBtn) {
    submitBtn.addEventListener("click", () => handleSubmit(app, round, missing, overLimit));
  }

  return box;
}

function statusLine(round) {
  if (S.request.status === "submitted") {
    const late = S.request.late ? ' <span class="badge badge-danger">ส่งช้า</span>' : "";
    return `สถานะ: ส่งแล้ว${late}`;
  }
  return `สถานะ: แบบร่าง${round ? ` · กำหนดส่งภายใน ${round.deadlineLabel}` : ""}`;
}

function handleSubmit(app, round, missing, overLimit) {
  if (missing.length > 0) {
    alert(`กรอกคงเหลือไม่ครบ ${missing.length} รายการ — ระบบจะพาไปยังรายการแรกที่ยังขาด`);
    missing.forEach((m) => S.missing.add(m.code));
    const first = missing[0];
    location.hash = `#/fill/${first.stepCode}?pcu=${app.pcu}&month=${app.monthKey}&focus=${first.code}&field=stock`;
    return;
  }

  if (overLimit.length > 0) {
    const mode = store.getLimitMode();
    const lines = overLimit.map((m) => `- ${m.name}: ${monthOverMessage(m.info) || yearOverMessage(m.info)}`).join("\n");
    if (mode === "enforce") {
      alert(`ส่งไม่ได้ — โหมดบังคับเพดาน มีรายการเกินเพดาน:\n${lines}`);
      return;
    }
    const ok = confirm(`มีรายการเกินเพดาน (โหมดเตือน สามารถส่งได้):\n${lines}\n\nยืนยันส่งใบเบิก?`);
    if (!ok) return;
  }

  S.request.status = "submitted";
  S.request.submitted_at = new Date().toISOString();
  S.request.late = round ? isAfterDeadline(new Date(), round.deadline) : false;
  ACTIVE_STEPS.forEach((code) => {
    const step = getStep(app.form, code);
    getItemRows(step).forEach((item) => {
      S.request.price_snapshot[item.code] = item.price;
    });
  });
  flushSave();
  renderFill(document.getElementById("app"), app, "summary");
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
