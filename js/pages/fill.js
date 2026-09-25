// Fill wizard: P1 -> P2 -> P3 -> P4 -> P5 -> CS (จ่ายกลาง) -> LAB -> สรุป (spec §3.2).
import { WIZARD_STEPS, NEW_2569_ITEMS } from "../constants.js";
import { getStep, getItemRows } from "../data.js";
import { getPcuToken, call, ApiError } from "../api.js";
import * as sync from "../sync.js";
import { formatInt, formatMoney, shortMonthKeyThai, nowTimeHHMM } from "../format.js";
import {
  computeLimitInfo,
  monthOverMessage,
  yearInfoMessage,
  yearOverMessage,
  isAnyLimitExceeded,
  computeCoverInfo,
  coverMessage,
} from "../limits.js";

const STEP_LABELS = {
  P1: "แบบ พัสดุ 1", P2: "แบบ พัสดุ 2", P3: "แบบ พัสดุ 3", P4: "แบบ พัสดุ 4",
  P5: "แบบ พัสดุ 5", CS: "จ่ายกลาง", LAB: "LAB", summary: "สรุป",
};

// Highlight-after-blocked-submit state; reset whenever the PCU/month changes.
let UI = { pcu: null, month: null, missing: new Set() };
let unsubStatus = null;

function ensureUi(app, month) {
  if (UI.pcu !== app.boot.pcu.code || UI.month !== month) {
    UI = { pcu: app.boot.pcu.code, month, missing: new Set() };
  }
  return UI;
}

function esc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pcuCode(app) {
  return app.boot.pcu.code;
}

function hiddenSet(app) {
  return new Set(app.boot.hidden || []);
}

function roundOf(app, month) {
  return app.boot.rounds.find((r) => r.month === month);
}

function byRoundOf(app, month) {
  return app.boot.byRound[month] || { prev: { items: {} }, plan: null, used_fy: {}, avg3: {} };
}

function isReadonly(app, month) {
  const session = sync.getSession(pcuCode(app), month);
  const status = session && session.request.status;
  return status === "submitted" || status === "received";
}

function activeStepItems(app, step) {
  const hidden = hiddenSet(app);
  return getItemRows(step).filter((it) => !hidden.has(it.code));
}

function stepTotals(app, step) {
  let op = 0, pp = 0, qty = 0, money = 0;
  for (const it of activeStepItems(app, step)) {
    const line = sync.getLine(pcuCode(app), app.monthKey, it.code);
    const o = Number(line.op) || 0, p = Number(line.pp) || 0;
    op += o; pp += p; qty += o + p; money += (o + p) * it.price;
  }
  return { op, pp, qty, money };
}

function stepMissingCodes(app, step) {
  return activeStepItems(app, step)
    .filter((it) => sync.getLine(pcuCode(app), app.monthKey, it.code).stock == null)
    .map((it) => it.code);
}

async function goToStep(app, month, stepCode, extraQuery = "") {
  sync.setLastStep(pcuCode(app), month, stepCode);
  sync.flush(pcuCode(app), month);
  location.hash = `#/fill/${stepCode}?month=${month}${extraQuery}`;
}

async function goToPrint(app, month) {
  await sync.flush(pcuCode(app), month);
  location.hash = `#/print?month=${month}`;
}

export async function renderFill(container, app, stepCode, params) {
  if (!WIZARD_STEPS.includes(stepCode)) stepCode = WIZARD_STEPS[0];
  const month = app.monthKey;
  const ui = ensureUi(app, month);
  const round = roundOf(app, month);

  if (unsubStatus) { unsubStatus(); unsubStatus = null; }

  // Record wherever the user actually lands (nav buttons/pills already do this before navigating,
  // but this also covers a reload, a bookmark, or the browser back/forward button — "last_step
  // updated when the user changes step" should hold no matter how they got there).
  sync.setLastStep(pcuCode(app), month, stepCode);

  const wrap = document.createElement("div");
  wrap.className = "fill-page";

  wrap.appendChild(renderProgressBar(app, month, stepCode));

  const session = sync.getSession(pcuCode(app), month);
  if (session && session.request.status === "draft" && session.request.return_reason) {
    const banner = document.createElement("div");
    banner.className = "notice notice-error";
    banner.innerHTML = `<strong>ส่งกลับแก้ไข:</strong> ${esc(session.request.return_reason)}`;
    wrap.appendChild(banner);
  }

  const content = document.createElement("div");
  content.className = "fill-content";
  if (stepCode === "summary") {
    content.appendChild(renderSummary(app, month, round));
  } else {
    const step = getStep(app.form, stepCode);
    if (!step) {
      content.textContent = "ไม่พบขั้นตอนนี้";
    } else {
      content.appendChild(renderStepForm(app, month, step));
    }
  }
  wrap.appendChild(content);

  wrap.appendChild(renderNav(app, month, stepCode));

  container.innerHTML = "";
  container.appendChild(wrap);

  if (stepCode !== "summary") {
    wireStepEvents(app, month, getStep(app.form, stepCode));
    markMissing(ui, getStep(app.form, stepCode), content, app);
    if (params && params.get("focus")) {
      focusItem(params.get("focus"), params.get("field") || "stock");
    }
  }
}

function renderProgressBar(app, month, stepCode) {
  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const idx = WIZARD_STEPS.indexOf(stepCode);

  const pills = document.createElement("div");
  pills.className = "progress-pills";
  WIZARD_STEPS.forEach((code, i) => {
    const dot = document.createElement("a");
    dot.className = "progress-pill" + (code === stepCode ? " active" : i < idx ? " done" : "");
    dot.textContent = String(i + 1);
    dot.title = STEP_LABELS[code] || code;
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
  current.textContent = `ขั้นตอนที่ ${idx + 1}/${WIZARD_STEPS.length} — ${STEP_LABELS[stepCode] || stepCode}`;
  bar.appendChild(current);

  return bar;
}

function renderNav(app, month, stepCode) {
  const nav = document.createElement("div");
  nav.className = "wizard-nav";

  const idx = WIZARD_STEPS.indexOf(stepCode);
  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn-secondary";
  backBtn.textContent = "ย้อนกลับ";
  backBtn.disabled = idx <= 0;
  backBtn.addEventListener("click", () => goToStep(app, month, WIZARD_STEPS[idx - 1]));

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn btn-primary";
  nextBtn.textContent = idx >= WIZARD_STEPS.length - 1 ? "ไปหน้าสรุป" : "ถัดไป";
  nextBtn.disabled = idx >= WIZARD_STEPS.length - 1;
  nextBtn.addEventListener("click", () => goToStep(app, month, WIZARD_STEPS[idx + 1]));

  const status = document.createElement("span");
  status.className = "autosave-status";
  status.id = "autosave-status";

  nav.appendChild(backBtn);
  nav.appendChild(status);
  nav.appendChild(nextBtn);

  unsubStatus = sync.subscribe(pcuCode(app), month, (st) => updateAutosaveStatus(st));

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
    el.textContent = "แบบฟอร์มถูกส่งไปแล้ว — โหลดหน้าใหม่";
  } else if (st.lastSavedAt) {
    el.textContent = `บันทึกบน server แล้ว ${nowTimeHHMM(st.lastSavedAt)}`;
  } else {
    el.textContent = "";
  }
}

// ---------------- item step ----------------

function renderStepForm(app, month, step) {
  const box = document.createElement("div");
  box.className = "step-form";

  const readonly = isReadonly(app, month);
  if (readonly) {
    const note = document.createElement("div");
    note.className = "notice notice-info";
    note.textContent = "ใบนี้ส่งแล้ว — ข้อมูลอ่านอย่างเดียว กด “ถอนการส่ง” ที่หน้าสรุปหากต้องการแก้ไข";
    box.appendChild(note);
  }

  const hidden = hiddenSet(app);
  const hiddenCodes = Array.from(hidden).filter((c) => getItemRows(step).some((it) => it.code === c));
  const hiddenDrawer = document.createElement("details");
  hiddenDrawer.className = "hidden-drawer";
  hiddenDrawer.innerHTML = `<summary>รายการที่ไม่เบิก ในขั้นตอนนี้ (${hiddenCodes.length})</summary>`;
  const hiddenList = document.createElement("div");
  hiddenList.className = "hidden-list";
  if (hiddenCodes.length === 0) {
    hiddenList.innerHTML = `<p class="muted">ไม่มีรายการที่ไม่เบิกในขั้นตอนนี้</p>`;
  } else {
    hiddenCodes.forEach((code) => {
      const item = getItemRows(step).find((it) => it.code === code);
      const row = document.createElement("div");
      row.className = "hidden-item-row";
      row.innerHTML = `<span>${esc(item.name)}</span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-link";
      btn.textContent = "กู้คืน";
      btn.disabled = readonly;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await toggleHidden(app, code, false);
          renderFill(document.getElementById("app"), app, step.code);
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

  box.appendChild(buildItemTable(app, month, step, readonly));
  box.appendChild(buildMobileCards(app, month, step, readonly));

  const totalsBar = document.createElement("div");
  totalsBar.className = "step-totals sticky-totals";
  totalsBar.id = "step-totals";
  box.appendChild(totalsBar);
  refreshStepTotals(app, step);

  return box;
}

async function toggleHidden(app, code, hide) {
  const cur = new Set(app.boot.hidden || []);
  if (hide) cur.add(code); else cur.delete(code);
  try {
    const data = await call("setHidden", { codes: Array.from(cur) }, { token: getPcuToken() });
    app.boot.hidden = data.hidden;
  } catch (err) {
    alert("บันทึกรายการที่ไม่เบิกไม่สำเร็จ: " + (err.message || ""));
    throw err;
  }
}

function itemHasPrice(item) {
  return item.price > 0;
}

function hintHtml(app, month, item) {
  if (NEW_2569_ITEMS.has(item.code)) {
    return `<div class="ghost-line">รายการใหม่ปี 2569 — ไม่มีข้อมูลปี 2568</div>`;
  }
  const byRound = byRoundOf(app, month);
  const prevMonthLabel = shortMonthKeyThai(byRound.prev.month);
  const prevItem = byRound.prev.items[item.code];
  let ghost = "";
  if (prevItem) {
    const tag = prevItem.stock_src === "sim" ? ' <span class="tag-sim">[จำลอง]</span>' : prevItem.stock_src === "trial" ? ' <span class="tag-sim">(จากใบทดลอง)</span>' : "";
    ghost = `เดือนก่อน (${esc(prevMonthLabel)}): คงเหลือ ${formatInt(prevItem.stock)}${tag} · OP ${formatInt(prevItem.op)} · PP ${formatInt(prevItem.pp)}`;
  } else {
    ghost = `เดือนก่อน (${esc(prevMonthLabel)}): ไม่มีข้อมูล`;
  }

  let planLine = "";
  if (byRound.plan !== null) {
    const planEntry = byRound.plan[item.code];
    const used = (byRound.used_fy && byRound.used_fy[item.code]) || 0;
    const planTotal = planEntry ? (planEntry[0] || 0) + (planEntry[1] || 0) : 0;
    if (planEntry && planTotal > 0) {
      const pct = Math.round((used / planTotal) * 100);
      planLine = `แผนปี 68: ${formatInt(planTotal)} · เบิกแล้ว ${formatInt(used)} (${pct}%)`;
    } else if (used > 0) {
      planLine = `ไม่มีในแผน · เบิกแล้ว ${formatInt(used)}`;
    }
  }

  return `<div class="ghost-line">${ghost}</div>${planLine ? `<div class="ghost-line plan-line">${esc(planLine)}</div>` : ""}`;
}

function buildItemTable(app, month, step, readonly) {
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
  const hidden = hiddenSet(app);

  for (const row of step.rows) {
    if (row.type === "section") {
      const tr = document.createElement("tr");
      tr.className = "section-row";
      tr.innerHTML = `<td colspan="10">${esc(row.title)}</td>`;
      tbody.appendChild(tr);
      continue;
    }
    if (hidden.has(row.code)) continue;
    tbody.appendChild(buildItemTr(app, month, row, readonly));
  }
  table.appendChild(tbody);
  return table;
}

function buildItemTr(app, month, item, readonly) {
  const tr = document.createElement("tr");
  tr.className = "item-row";
  tr.dataset.code = item.code;
  const line = sync.getLine(pcuCode(app), month, item.code);
  const priceKnown = itemHasPrice(item);

  const nameCell = `<div class="item-name">${esc(item.name)}${priceKnown ? "" : ' <span class="badge badge-warn">ยังไม่มีราคา</span>'}</div>
    ${hintHtml(app, month, item)}
    <div class="cover-msg" data-cover-for="${item.code}"></div>
    <div class="limit-msg" data-limit-for="${item.code}"></div>`;

  tr.innerHTML = `
    <td class="col-seq">${item.seq}</td>
    <td class="col-name">${nameCell}</td>
    <td class="col-unit">${esc(item.unit || "")}</td>
    <td class="col-price">${formatMoney(item.price)}</td>
    <td class="col-num"><input class="num-input" data-field="stock" inputmode="numeric" autocomplete="off" value="${line.stock == null ? "" : line.stock}" ${readonly ? "disabled" : ""}></td>
    <td class="col-num"><input class="num-input" data-field="op" inputmode="numeric" autocomplete="off" value="${line.op || ""}" ${readonly ? "disabled" : ""}></td>
    <td class="col-num"><input class="num-input" data-field="pp" inputmode="numeric" autocomplete="off" value="${line.pp || ""}" ${readonly ? "disabled" : ""}></td>
    <td class="col-num row-total">${formatInt((line.op || 0) + (line.pp || 0))}</td>
    <td class="col-money row-money">${formatMoney(((line.op || 0) + (line.pp || 0)) * item.price)}</td>
    <td class="col-action">${readonly ? "" : `<button type="button" class="btn btn-link btn-hide" data-hide="${item.code}">ไม่เบิก</button>`}</td>`;
  return tr;
}

function buildMobileCards(app, month, step, readonly) {
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
    if (hidden.has(row.code)) continue;
    wrap.appendChild(buildItemCard(app, month, row, readonly));
  }
  return wrap;
}

function buildItemCard(app, month, item, readonly) {
  const card = document.createElement("div");
  card.className = "item-card";
  card.dataset.code = item.code;
  const line = sync.getLine(pcuCode(app), month, item.code);
  const priceKnown = itemHasPrice(item);

  card.innerHTML = `
    <div class="item-card-head">
      <span class="item-seq">${item.seq}</span>
      <span class="item-name">${esc(item.name)}${priceKnown ? "" : ' <span class="badge badge-warn">ยังไม่มีราคา</span>'}</span>
      ${readonly ? "" : `<button type="button" class="btn btn-link btn-hide" data-hide="${item.code}">ไม่เบิก</button>`}
    </div>
    <div class="item-card-meta">หน่วย: ${esc(item.unit || "")} · ราคา/หน่วย: ${formatMoney(item.price)}</div>
    ${hintHtml(app, month, item)}
    <div class="item-card-inputs">
      <label>คงเหลือ<input class="num-input" data-field="stock" inputmode="numeric" autocomplete="off" value="${line.stock == null ? "" : line.stock}" ${readonly ? "disabled" : ""}></label>
      <label>OP<input class="num-input" data-field="op" inputmode="numeric" autocomplete="off" value="${line.op || ""}" ${readonly ? "disabled" : ""}></label>
      <label>PP<input class="num-input" data-field="pp" inputmode="numeric" autocomplete="off" value="${line.pp || ""}" ${readonly ? "disabled" : ""}></label>
    </div>
    <div class="item-card-total">รวม <span class="row-total">${formatInt((line.op || 0) + (line.pp || 0))}</span> · เป็นเงิน <span class="row-money">${formatMoney(((line.op || 0) + (line.pp || 0)) * item.price)}</span></div>
    <div class="cover-msg" data-cover-for="${item.code}"></div>
    <div class="limit-msg" data-limit-for="${item.code}"></div>`;
  return card;
}

function refreshStepTotals(app, step) {
  const t = stepTotals(app, step);
  const el = document.getElementById("step-totals");
  if (!el) return;
  el.innerHTML = `<strong>รวมขั้นตอนนี้</strong> — OP ${formatInt(t.op)} · PP ${formatInt(t.pp)} · รวม ${formatInt(t.qty)} · เป็นเงิน ${formatMoney(t.money)} บาท`;
}

function refreshRowLimit(app, month, item) {
  const line = sync.getLine(pcuCode(app), month, item.code);
  const opPp = (Number(line.op) || 0) + (Number(line.pp) || 0);
  const byRound = byRoundOf(app, month);
  const info = computeLimitInfo(app.boot.limits, byRound.used_fy, item.code, opPp);
  document.querySelectorAll(`[data-code="${item.code}"] input.num-input`).forEach((inp) => {
    inp.classList.toggle("input-error", !!info && isAnyLimitExceeded(info) && (inp.dataset.field === "op" || inp.dataset.field === "pp"));
  });
  document.querySelectorAll(`[data-limit-for="${item.code}"]`).forEach((box) => {
    if (!info) { box.innerHTML = ""; return; }
    const parts = [];
    const monthMsg = monthOverMessage(info);
    if (monthMsg) parts.push(`<div class="limit-line limit-danger">${esc(monthMsg)}</div>`);
    const yearMsg = yearInfoMessage(info);
    if (yearMsg && !info.yearOver) parts.push(`<div class="limit-line limit-info">${esc(yearMsg)}</div>`);
    const yearOver = yearOverMessage(info);
    if (yearOver) parts.push(`<div class="limit-line limit-danger">${esc(yearOver)}</div>`);
    box.innerHTML = parts.join("");
  });

  const cover = computeCoverInfo((byRound.avg3 || {})[item.code], line.stock, line.op, line.pp);
  document.querySelectorAll(`[data-cover-for="${item.code}"]`).forEach((box) => {
    if (!cover) { box.innerHTML = ""; return; }
    // yellow only for regularly-withdrawn items (§2.3); sporadic items just show the number
    const over = (byRound.regular || []).includes(item.code) && cover.months > (app.boot.config.cover_over || 3);
    box.innerHTML = `<span class="cover-hint${over ? " cover-hint-warn" : ""}">${esc(coverMessage(cover))}</span>`;
  });
}

function sanitizeDigits(str) {
  return str.replace(/[^0-9]/g, "");
}

function wireStepEvents(app, month, step) {
  const container = document.getElementById("app");
  const ui = ensureUi(app, month);

  container.querySelectorAll(".num-input").forEach((input) => {
    input.addEventListener("input", () => {
      const digits = sanitizeDigits(input.value);
      if (digits !== input.value) input.value = digits;
      const tr = input.closest("[data-code]");
      const code = tr.dataset.code;
      const field = input.dataset.field;
      const item = getItemRows(step).find((it) => it.code === code);

      const value = digits === "" ? (field === "stock" ? null : 0) : parseInt(digits, 10);
      sync.setLine(pcuCode(app), month, code, field, value);
      if (field === "stock") {
        input.classList.remove("input-error");
        ui.missing.delete(code);
      }

      document.querySelectorAll(`[data-code="${code}"] .row-total`).forEach((el) => {
        const line = sync.getLine(pcuCode(app), month, code);
        el.textContent = formatInt((line.op || 0) + (line.pp || 0));
      });
      document.querySelectorAll(`[data-code="${code}"] .row-money`).forEach((el) => {
        const line = sync.getLine(pcuCode(app), month, code);
        el.textContent = formatMoney(((line.op || 0) + (line.pp || 0)) * item.price);
      });
      refreshStepTotals(app, step);
      refreshRowLimit(app, month, item);
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
        renderFill(container, app, step.code);
      } catch (err) {
        btn.disabled = false;
      }
    });
  });

  getItemRows(step).forEach((item) => refreshRowLimit(app, month, item));
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
    const nextCode = items[itemIdx + 1].code;
    nextSelector = `[data-code="${nextCode}"] input[data-field="stock"]`;
  } else {
    return;
  }
  const isCard = !!currentInput.closest(".item-card");
  const scopeClass = isCard ? ".item-cards" : ".item-table";
  const scope = document.querySelector(scopeClass);
  const next = (scope && scope.querySelector(nextSelector)) || document.querySelector(nextSelector);
  if (next) next.focus();
}

function markMissing(ui, step, content, app) {
  if (!ui.missing.size || !step) return;
  const hidden = hiddenSet(app);
  let n = 0;
  getItemRows(step).forEach((item) => {
    const line = sync.getLine(pcuCode(app), ui.month, item.code);
    if (!ui.missing.has(item.code) || hidden.has(item.code) || line.stock != null) return;
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

function renderSummary(app, month, round) {
  const box = document.createElement("div");
  box.className = "summary-page";
  const session = sync.getSession(pcuCode(app), month);
  const request = session.request;
  const readonly = request.status === "submitted" || request.status === "received";
  const byRound = byRoundOf(app, month);

  let grandOp = 0, grandPp = 0, grandQty = 0, grandMoney = 0;
  const stepRows = app.form.steps.map((step) => {
    const t = stepTotals(app, step);
    grandOp += t.op; grandPp += t.pp; grandQty += t.qty; grandMoney += t.money;
    return { code: step.code, title: step.title, t };
  });

  const missing = [];
  const overLimit = [];
  app.form.steps.forEach((step) => {
    activeStepItems(app, step).forEach((item) => {
      const line = sync.getLine(pcuCode(app), month, item.code);
      if (line.stock == null) missing.push({ code: item.code, name: item.name, stepCode: step.code });
      const opPp = (Number(line.op) || 0) + (Number(line.pp) || 0);
      const info = computeLimitInfo(app.boot.limits, byRound.used_fy, item.code, opPp);
      if (isAnyLimitExceeded(info)) overLimit.push({ code: item.code, name: item.name, stepCode: step.code, info });
    });
  });

  box.innerHTML = `
    <h2>สรุปยอดก่อนส่ง</h2>
    <table class="summary-table">
      <thead><tr><th>ขั้นตอน</th><th>OP</th><th>PP</th><th>รวม</th><th>เป็นเงิน</th></tr></thead>
      <tbody>
        ${stepRows.map((s) => `<tr><td>${esc(s.title)} (${esc(s.code)})</td><td>${formatInt(s.t.op)}</td><td>${formatInt(s.t.pp)}</td><td>${formatInt(s.t.qty)}</td><td>${formatMoney(s.t.money)}</td></tr>`).join("")}
        <tr class="grand-row"><td>รวมทั้งหมด</td><td>${formatInt(grandOp)}</td><td>${formatInt(grandPp)}</td><td>${formatInt(grandQty)}</td><td>${formatMoney(grandMoney)}</td></tr>
      </tbody>
    </table>

    <div class="summary-section" id="missing-box">
      <h3>รายการที่ยังไม่กรอกคงเหลือ (${missing.length})</h3>
      ${missing.length === 0 ? '<p class="muted">กรอกครบทุกรายการแล้ว</p>' : `<ul class="jump-list">${missing.map((m) => `<li><a href="#" data-jump="${m.stepCode}" data-code="${m.code}">${esc(m.name)} (${m.code})</a></li>`).join("")}</ul>`}
    </div>

    <div class="summary-section" id="over-box">
      <h3>รายการที่เกินเพดาน (${overLimit.length})</h3>
      ${overLimit.length === 0 ? '<p class="muted">ไม่มีรายการเกินเพดาน</p>' : `<ul class="jump-list">${overLimit.map((m) => `<li><a href="#" data-jump="${m.stepCode}" data-code="${m.code}" data-field="op">${esc(m.name)} (${m.code}) — ${esc(monthOverMessage(m.info) || yearOverMessage(m.info))}</a></li>`).join("")}</ul>`}
    </div>

    <div class="summary-section">
      <label class="field-label">ชื่อผู้กรอก (ไม่บังคับ, ไม่พิมพ์ในใบเบิก)
        <input type="text" id="submitter-name" value="${esc(request.submitter_name || "")}" ${readonly ? "disabled" : ""}>
      </label>
    </div>

    <div class="summary-actions">
      <button type="button" class="btn btn-secondary" id="btn-preview">ดูตัวอย่างใบพิมพ์</button>
      ${readonly
        ? (request.status === "submitted"
          ? `<button type="button" class="btn btn-secondary" id="btn-withdraw">ถอนการส่ง</button>
             <button type="button" class="btn btn-primary" id="btn-print">พิมพ์ใบเบิก</button>`
          : `<button type="button" class="btn btn-primary" id="btn-print">พิมพ์ใบเบิก</button>`)
        : `<button type="button" class="btn btn-primary" id="btn-submit">ส่งใบเบิก</button>`}
    </div>
    <div class="status-line">${statusLine(request, round)}</div>
  `;

  box.querySelectorAll("[data-jump]").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const stepCode = a.dataset.jump;
      const code = a.dataset.code;
      const field = a.dataset.field || "stock";
      location.hash = `#/fill/${stepCode}?month=${month}&focus=${code}&field=${field}`;
    });
  });

  const nameInput = box.querySelector("#submitter-name");
  if (nameInput) {
    nameInput.addEventListener("input", () => sync.setSubmitterName(pcuCode(app), month, nameInput.value));
    nameInput.addEventListener("blur", () => sync.flush(pcuCode(app), month));
  }

  box.querySelector("#btn-preview").addEventListener("click", () => goToPrint(app, month));

  const printBtn = box.querySelector("#btn-print");
  if (printBtn) printBtn.addEventListener("click", () => goToPrint(app, month));

  const withdrawBtn = box.querySelector("#btn-withdraw");
  if (withdrawBtn) {
    withdrawBtn.addEventListener("click", async () => {
      withdrawBtn.disabled = true;
      try {
        await sync.withdrawRequest(pcuCode(app), month);
        renderFill(document.getElementById("app"), app, "summary");
      } catch (err) {
        alert("ถอนการส่งไม่สำเร็จ: " + (err.message || ""));
        withdrawBtn.disabled = false;
      }
    });
  }

  const submitBtn = box.querySelector("#btn-submit");
  if (submitBtn) {
    submitBtn.addEventListener("click", () => handleSubmit(app, month, missing, overLimit, submitBtn));
  }

  return box;
}

function statusLine(request, round) {
  if (request.status === "submitted") return "สถานะ: ส่งแล้ว";
  if (request.status === "received") return "สถานะ: รับเรื่องแล้ว";
  return `สถานะ: แบบร่าง${round ? ` · กำหนดส่งภายใน ${round.deadlineLabel}` : ""}`;
}

async function handleSubmit(app, month, missing, overLimit, submitBtn) {
  if (missing.length > 0) {
    alert(`กรอกคงเหลือไม่ครบ ${missing.length} รายการ — ระบบจะพาไปยังรายการแรกที่ยังขาด`);
    const ui = ensureUi(app, month);
    missing.forEach((m) => ui.missing.add(m.code));
    const first = missing[0];
    location.hash = `#/fill/${first.stepCode}?month=${month}&focus=${first.code}&field=stock`;
    return;
  }

  const mode = app.boot.config.limit_mode;
  if (overLimit.length > 0) {
    const lines = overLimit.map((m) => `- ${m.name}: ${monthOverMessage(m.info) || yearOverMessage(m.info)}`).join("\n");
    if (mode === "enforce") {
      alert(`ส่งไม่ได้ — โหมดบังคับเพดาน มีรายการเกินเพดาน:\n${lines}`);
      return;
    }
    if (!confirm(`มีรายการเกินเพดาน (โหมดเตือน สามารถส่งได้):\n${lines}\n\nยืนยันส่งใบเบิก?`)) return;
  }

  submitBtn.disabled = true;
  try {
    await sync.submitRequest(pcuCode(app), month);
    renderFill(document.getElementById("app"), app, "summary");
  } catch (err) {
    if (err instanceof ApiError && err.code === "INCOMPLETE") {
      alert("เซิร์ฟเวอร์แจ้งว่ากรอกคงเหลือไม่ครบ: " + (err.missing || []).join(", "));
    } else if (err instanceof ApiError && err.code === "OVER_LIMIT") {
      const lines = (err.items || []).map((i) => `- ${i.code}: ขอ ${i.total}${i.limit_month != null ? ` (เพดานเดือน ${i.limit_month})` : ""}${i.limit_year != null ? ` (เพดานปี ${i.limit_year})` : ""}`).join("\n");
      alert("เซิร์ฟเวอร์ปฏิเสธ — มีรายการเกินเพดาน:\n" + lines);
    } else if (err instanceof ApiError && err.code === "CONFLICT") {
      alert("แบบฟอร์มถูกส่งไปแล้ว (อาจจากเครื่องอื่น) — จะโหลดข้อมูลล่าสุด");
      location.reload();
    } else {
      alert("ส่งไม่สำเร็จ: " + (err.message || ""));
    }
  } finally {
    submitBtn.disabled = false;
  }
}
