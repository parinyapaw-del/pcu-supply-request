// Fill wizard (phase 2 spec §4.2/§4.3): one step per form step (ordered by `order`, ≤ 10) -> summary page.
// Columns คงเหลือ / OP / PP — คงเหลือ is optional unless config.stock_required === 1. Brief 2o: stock mode B adds
// a ใช้ไป column + "± ปรับยอด" and calculates คงเหลือ <-> ใช้ไป from the previous round's คงเหลือ. Autosave via sync.js;
// บันทึก and พิมพ์ on the summary page both SEND (saveLines{send:true}, see send.js).
import { getOrderedSteps, getActiveItemRows } from "../data.js";
import { call, getPcuToken } from "../api.js";
import * as sync from "../sync.js";
import * as store from "../store.js";
import { formatInt, formatMoney, nowTimeHHMM } from "../format.js";
import { limitStatus } from "../limits.js";
import {
  esc, pcuCode, roundOf, monthData, unlocksOf, isEditable, isLocked, isActiveRound, roundUsesCurrentFy,
  requestOf, requestStatus, fyShort, roundTitle, currentRoundTagHtml, trialBadgeHtml, deadlineText, trialNote, adminEntryTagHtml,
  alertDialog, toast, requesterOf,
} from "./common.js";
import { trySend, collectIssues, sendUi, lineTotal } from "./send.js";

let unsubStatus = null;
const ITEM_HIGHLIGHT_MS = 2000; // .row-highlight animation = 2 x 1 s

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

// 2p: price of an item in the shown round = boot.prices[round][code] (only listed when it differs from the form) ?? form price.
function priceOf(app, month, item) {
  const p = app.boot.prices && app.boot.prices[month] ? app.boot.prices[month][item.code] : null;
  return p !== null && p !== undefined ? Number(p) : item.price;
}

function stepTotals(app, step, month) {
  let op = 0, pp = 0, qty = 0, money = 0;
  for (const it of activeStepItems(app, step)) {
    const line = sync.getLine(pcuCode(app), month, it.code);
    const o = Number(line.op) || 0, p = Number(line.pp) || 0;
    op += o; pp += p; qty += o + p; money += (o + p) * priceOf(app, month, it);
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
    else if (params && params.get("item")) {
      // 4.3 item search landing: scroll to the row, focus its first editable input (stock if required, else op),
      // then drop `item` from the hash (replaceState = no hashchange) so a reload does not re-focus.
      focusItem(params.get("item"), stockRequired(app) ? "stock" : "op", ITEM_HIGHLIGHT_MS);
      try {
        params.delete("item");
        const qs = params.toString();
        history.replaceState(null, "", `${location.pathname}${location.search}${location.hash.split("?")[0]}${qs ? "?" + qs : ""}`);
      } catch (e) { /* history API unavailable: harmless */ }
    }
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
  const rnd = roundOf(app, month);
  if (rnd && rnd.trial) {
    parts.push(`<div class="notice notice-trial" id="fill-trial-banner"><strong>ทดลองกรอก</strong> — ${esc(trialNote(rnd))}${rnd.deadline_date ? ` (${esc(deadlineText(rnd))})` : ""}</div>`);
  }
  parts.push(formVersionBanner(app, request));
  const negRows = isEditable(app, month) ? negativeCalcRows(app, month) : [];
  if (negRows.length) {
    // 2o §3.4: a recalc (the received amount changed after this request was keyed) left คงเหลือ blank
    parts.push(`<div class="notice notice-trial" id="fill-recalc-banner"><strong>ยอดได้รับเปลี่ยน</strong> มี ${negRows.length} รายการที่คงเหลือคำนวณติดลบ —
      <a href="#" data-jump="${esc(negRows[0].stepCode)}" data-code="${esc(negRows[0].code)}">ไปที่รายการแรก</a>
      ${negRows.length > 1 ? `<details class="recalc-list"><summary>ดูทุกรายการ</summary><ul class="jump-list">${negRows.map((r) => `<li><a href="#" data-jump="${esc(r.stepCode)}" data-code="${esc(r.code)}">${esc(r.name)} (${esc(r.code)})</a></li>`).join("")}</ul></details>` : ""}</div>`);
  }
  parts.push(`<div class="fill-status" id="fill-status"></div>`);
  host.innerHTML = parts.join("");
  host.querySelectorAll("[data-jump]").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      location.hash = `#/fill/${a.dataset.jump}?month=${month}&focus=${encodeURIComponent(a.dataset.code)}&field=${isModeB(app) ? "used" : "stock"}`;
    });
  });
  return host;
}

function refreshStatusChip(app, month) {
  const el = document.getElementById("fill-status");
  if (!el) return;
  const session = sync.getSession(pcuCode(app), month);
  const st = requestStatus(requestOf(app, month), roundOf(app, month), session && session.conflict);
  const round = roundOf(app, month);
  el.innerHTML = `<span class="muted">${esc(roundTitle(month, round))}${round && !round.trial ? ` · ปีงบ ${esc(round.fy)}` : ""} · สถานะ</span>${trialBadgeHtml(round)}${currentRoundTagHtml(app, month)}${adminEntryTagHtml(requestOf(app, month))} <span class="badge ${st.cls}">${esc(st.label)}</span>` +
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
    // 2o: the server recalculated these rows (stock <-> used) differently from what is on screen -> repaint them
    if (st.recalc) st.recalc.forEach((code) => repaintRow(app, month, code));
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

  box.appendChild(buildStockModeSwitch(app, month, step));
  box.appendChild(buildItemSearch(app, month, step));

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

// ---------------- 4.3 item search (all active items of all active pages) ----------------

const SEARCH_MAX = 30;

// Index over app.boot.form — the same form renderFill draws the pages from — grouped by page in wizard order.
function searchIndex(app) {
  const hidden = hiddenSet(app);
  const steps = getOrderedSteps(app.boot.form).filter((s) => s.active !== false);
  return steps.map((step, i) => ({
    step,
    pageNo: step.page_no != null ? step.page_no : i + 1,
    items: getActiveItemRows(step).map((it) => ({
      item: it,
      hidden: hidden.has(it.code),
      hay: `${it.code} ${it.name}`.toLowerCase(),
    })),
  }));
}

function searchMatches(app, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { groups: [], total: 0 };
  const groups = [];
  let total = 0, shown = 0;
  for (const g of searchIndex(app)) {
    const hits = g.items.filter((x) => tokens.every((t) => x.hay.includes(t)));
    total += hits.length;
    if (!hits.length || shown >= SEARCH_MAX) continue;
    const take = hits.slice(0, SEARCH_MAX - shown);
    shown += take.length;
    groups.push({ step: g.step, pageNo: g.pageNo, hits: take });
  }
  return { groups, total };
}

function buildItemSearch(app, month, step) {
  const wrap = document.createElement("div");
  wrap.className = "item-search no-print";
  wrap.innerHTML = `
    <input type="text" id="item-search" class="item-search-input" placeholder="ค้นหารายการ (รหัส/ชื่อ) ทุกหน้า"
      autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
      role="combobox" aria-expanded="false" aria-controls="item-search-results" aria-label="ค้นหารายการ">
    <div class="item-search-results" id="item-search-results" role="listbox" hidden></div>`;
  const input = wrap.querySelector("#item-search");
  const list = wrap.querySelector("#item-search-results");

  const close = () => {
    list.hidden = true;
    list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
  };
  const reset = () => { input.value = ""; close(); };

  const pick = (stepCode, code) => {
    reset();
    if (stepCode === step.code) {
      // already on that page: no re-render needed, just jump to the row
      focusItem(code, stockRequired(app) ? "stock" : "op", ITEM_HIGHLIGHT_MS);
      return;
    }
    sync.flush(pcuCode(app), month);
    location.hash = `#/fill/${stepCode}?month=${month}&item=${encodeURIComponent(code)}`;
  };

  const render = () => {
    const q = input.value.trim();
    if (!q) { close(); return; }
    const { groups, total } = searchMatches(app, q);
    let html = "";
    if (!groups.length) {
      html = `<div class="item-search-empty muted">ไม่พบรายการที่ตรงกับ “${esc(q)}”</div>`;
    } else {
      groups.forEach((g) => {
        html += `<div class="item-search-group" role="presentation">หน้า ${esc(g.pageNo)} — ${esc(stepLabel(g.step))}</div>`;
        g.hits.forEach((h) => {
          const it = h.item;
          const label = `<span class="hit-code">${esc(it.code)}</span> <span class="hit-name">${esc(it.name)}</span> <span class="hit-unit">(${esc(it.unit || "")})</span>`;
          html += h.hidden
            // hidden (ไม่เบิก) items have no row on the page: greyed, not pickable; the tag links to the settings page
            ? `<div class="item-search-hit is-hidden" role="option" aria-disabled="true">${label}
                <a class="hit-tag" href="#/hidden">ซ่อนอยู่ — ตั้งค่ารายการที่ไม่เบิก</a></div>`
            : `<button type="button" class="item-search-hit" role="option" data-step="${esc(g.step.code)}" data-code="${esc(it.code)}">${label}</button>`;
        });
      });
      if (total > SEARCH_MAX) html += `<div class="item-search-more muted">แสดง ${SEARCH_MAX} จาก ${total} รายการ — พิมพ์เพิ่มเพื่อกรอง</div>`;
    }
    list.innerHTML = html;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  input.addEventListener("input", render);
  input.addEventListener("focus", () => { if (input.value.trim()) render(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const first = list.querySelector("button.item-search-hit");
      if (first) pick(first.dataset.step, first.dataset.code);
    } else if (ev.key === "ArrowDown") {
      const first = list.querySelector("button.item-search-hit");
      if (first) { ev.preventDefault(); first.focus(); }
    }
  });
  list.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button.item-search-hit");
    if (btn) pick(btn.dataset.step, btn.dataset.code);
  });
  list.addEventListener("keydown", (ev) => {
    const hits = Array.from(list.querySelectorAll("button.item-search-hit"));
    const i = hits.indexOf(document.activeElement);
    if (ev.key === "ArrowDown" && i >= 0 && i < hits.length - 1) { ev.preventDefault(); hits[i + 1].focus(); }
    else if (ev.key === "ArrowUp" && i >= 0) { ev.preventDefault(); (hits[i - 1] || input).focus(); }
    else if (ev.key === "Escape") { ev.preventDefault(); close(); input.focus(); }
  });
  return wrap;
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

// ---------------- 2o: stock mode B (ใช้ไป / ปรับยอด / calc_from) ----------------
// คงเหลือ = ยกมา + ได้รับ + ปรับยอด − ใช้ไป. The server owns the formula and re-derives on save; the client uses the same
// formula only to show the result straight away and then accepts the server's values (sync.js `recalc`).
const ADJ_REASONS = [
  ["received_extra", "ได้รับเพิ่ม"], ["borrow_return", "ยืม/คืน"], ["expired_damaged", "หมดอายุ/เสียหาย"],
  ["recount", "นับใหม่"], ["other", "อื่น ๆ"],
];

function isModeB(app) {
  return app.boot.pcu.stock_mode === "B";
}

// Baseline (ยกมา) = the previous round's คงเหลือ; null = none (no request / draft / stock not keyed) -> Q13.
function baselineOf(app, month, code) {
  const pl = monthData(app, month).prev_lines;
  const prev = pl && pl[code];
  return prev && prev.stock != null ? prev : null;
}

function availableOf(base, line) {
  return (Number(base.stock) || 0) + (Number(base.received) || 0) + (Number(line.adj) || 0);
}

// The derived field of a line from its driver (`calc_from`): { stock } (driver used) or { used } (driver stock).
// A negative result becomes null (Q14).
function deriveFields(base, line) {
  if (!base || !line.calc_from) return {};
  const avail = availableOf(base, line);
  if (line.calc_from === "used" && line.used != null) {
    const v = avail - Number(line.used);
    return { stock: v < 0 ? null : v };
  }
  if (line.calc_from === "stock" && line.stock != null) {
    const v = avail - Number(line.stock);
    return { used: v < 0 ? null : v };
  }
  return {};
}

// "ok" | "nobase" | "neg" (ใช้ไป > available: red, stock not computed) | "surplus" (stock > available: yellow + put-as-received)
function calcStatus(base, line) {
  if (!base) return "nobase";
  if (line.calc_from === "used" && line.used != null && line.stock == null) return "neg";
  if (line.calc_from === "stock" && line.stock != null && line.used == null) return "surplus";
  return "ok";
}

// What one typed value changes on the line (field: stock | used | adj | adj_reason | op | pp). The last-typed of
// used/stock is the driver (calc_from); mode A / no baseline = plain typing (calc_from:null, spec §3.5).
function patchForEdit(modeB, base, line, field, value) {
  const patch = { [field]: value };
  if (field === "stock") {
    if (!modeB || !base) { patch.calc_from = null; return patch; }
    if (value == null) {
      if (line.calc_from === "stock") { patch.calc_from = null; patch.used = null; } // driver cleared: its derived value goes too
      return patch;
    }
    patch.calc_from = "stock";
  } else if (field === "used") {
    if (value == null) {
      if (line.calc_from === "used") { patch.calc_from = null; patch.stock = null; }
      return patch;
    }
    patch.calc_from = "used";
  } else if (field === "adj") {
    if (value == null) patch.adj_reason = null;
  } else {
    return patch; // op / pp / adj_reason: nothing to recompute
  }
  return Object.assign(patch, deriveFields(base, { ...line, ...patch }));
}

function calcHintText(base, line) {
  const adj = Number(line.adj) || 0;
  return `ยกมา ${formatInt(base.stock)} + ได้รับ ${formatInt(Number(base.received) || 0)}${adj ? ` (${adj > 0 ? "+" : "−"} ปรับ ${formatInt(Math.abs(adj))})` : ""} = ${formatInt(availableOf(base, line))}`;
}

// Mode-B block under the item name: ยกมา hint, "± ปรับยอด" link + input, message slot (filled by refreshRowCalc).
function calcBlockHtml(app, month, item, line, editable) {
  if (!isModeB(app)) return "";
  const base = baselineOf(app, month, item.code);
  if (!base) return `<div class="ghost-line calc-nobase">ไม่มียอดยกมา — กรอกคงเหลือเอง</div>`;
  const open = (Number(line.adj) || 0) !== 0 || !!line.adj_reason;
  return `<div class="ghost-line calc-hint" data-calc-hint>${esc(calcHintText(base, line))}</div>
    <div class="adj-wrap">
      ${editable ? `<button type="button" class="btn btn-link adj-toggle" data-adj-toggle>± ปรับยอด</button>` : ""}
      <span class="adj-box" data-adj-box ${open ? "" : "hidden"}>
        <input class="num-input adj-input" data-field="adj" inputmode="text" autocomplete="off" maxlength="6" placeholder="± จำนวน" aria-label="ปรับยอด" value="${esc(valStr(line.adj))}" ${editable ? "" : "disabled"}>
        <select class="adj-reason" data-field="adj_reason" aria-label="เหตุผลปรับยอด" ${editable ? "" : "disabled"}>
          <option value="">เหตุผล…</option>${ADJ_REASONS.map(([v, l]) => `<option value="${v}"${line.adj_reason === v ? " selected" : ""}>${l}</option>`).join("")}
        </select>
      </span>
    </div>
    <div class="calc-msg" data-calc-msg></div>`;
}

// Repaints the mode-B state of one item row (table row + mobile card): synced input values, "คำนวณ" tags,
// computed-field background, red / yellow states, the ยกมา hint and the Q14 message. Never touches the focused input.
function refreshRowCalc(app, month, item) {
  const modeB = isModeB(app);
  const line = sync.getLine(pcuCode(app), month, item.code);
  const base = baselineOf(app, month, item.code);
  const st = modeB ? calcStatus(base, line) : "ok";
  const stockComputed = modeB && !!base && line.calc_from === "used" && line.stock != null;
  const usedComputed = modeB && !!base && line.calc_from === "stock" && line.used != null;
  document.querySelectorAll(`[data-code="${item.code}"]`).forEach((root) => {
    const setVal = (field, v) => {
      const el = root.querySelector(`[data-field="${field}"]`);
      if (el && document.activeElement !== el) el.value = field === "adj_reason" ? (v || "") : valStr(v);
    };
    setVal("stock", line.stock); setVal("used", line.used); setVal("adj", line.adj); setVal("adj_reason", line.adj_reason);
    const stockEl = root.querySelector('input[data-field="stock"]');
    const usedEl = root.querySelector('input[data-field="used"]');
    if (stockEl) {
      stockEl.classList.toggle("calc-field", stockComputed);
      stockEl.classList.toggle("input-warn", st === "surplus");
      if (line.stock != null) stockEl.classList.remove("input-error");
    }
    if (usedEl) {
      usedEl.classList.toggle("calc-field", usedComputed);
      usedEl.classList.toggle("input-error", st === "neg");
    }
    root.querySelectorAll("[data-calc-tag]").forEach((tag) => { tag.hidden = !(tag.dataset.calcTag === "stock" ? stockComputed : usedComputed); });
    const hint = root.querySelector("[data-calc-hint]");
    if (hint && base) hint.textContent = calcHintText(base, line);
    const box = root.querySelector("[data-adj-box]");
    if (box && ((Number(line.adj) || 0) !== 0 || line.adj_reason)) box.hidden = false; // never auto-closes under the user
    const msg = root.querySelector("[data-calc-msg]");
    if (msg) {
      const editable = !!stockEl && !stockEl.disabled;
      if (st === "neg") {
        msg.innerHTML = `<div class="limit-line limit-danger">ใช้ไป ${formatInt(line.used)} มากกว่ายอดที่มี ${formatInt(availableOf(base, line))} — ตรวจสอบยอดใช้ไป หรือ “± ปรับยอด” (ยังไม่คำนวณคงเหลือ)</div>`;
      } else if (st === "surplus") {
        msg.innerHTML = `<div class="calc-warn">คงเหลือ ${formatInt(line.stock)} มากกว่ายอดที่มี ${formatInt(availableOf(base, line))} (บันทึกคงเหลือ ไม่คำนวณใช้ไป)
          ${editable ? `<button type="button" class="btn btn-secondary btn-sm" data-put-extra>ใส่เป็นยอดรับเพิ่ม</button>` : ""}</div>`;
      } else {
        msg.innerHTML = "";
      }
    }
  });
  if (line.stock != null) sendUi.missing.delete(item.code);
}

function repaintRow(app, month, code) {
  for (const step of getOrderedSteps(app.boot.form)) {
    const item = getActiveItemRows(step).find((it) => it.code === code);
    if (item) { refreshRowCalc(app, month, item); return; }
  }
}

// Hidden-item-free list of rows with calc_from set, used keyed and stock blank (a recalc went negative) — spec §3.4 banner.
function negativeCalcRows(app, month) {
  const request = requestOf(app, month);
  if (!request || !request.lines) return [];
  const hidden = hiddenSet(app);
  const out = [];
  getOrderedSteps(app.boot.form).forEach((step) => {
    getActiveItemRows(step).forEach((it) => {
      const l = request.lines[it.code];
      if (l && l.calc_from && l.used != null && l.stock == null && !hidden.has(it.code)) out.push({ code: it.code, name: it.name, stepCode: step.code });
    });
  });
  return out;
}

// Top-of-page switch "คำนวณคงเหลือจากยอดใช้ไป" (= stock mode B), stored per PCU on the server (pcuSetStockMode).
// Switching back to A only hides the column — values are kept.
function buildStockModeSwitch(app, month, step) {
  const wrap = document.createElement("div");
  wrap.className = "stock-mode-switch";
  wrap.innerHTML = `<label class="switch-label"><input type="checkbox" id="stock-mode-toggle" ${isModeB(app) ? "checked" : ""}>
    <span><strong>คำนวณคงเหลือจากยอดใช้ไป</strong></span></label>
    <span class="muted small">กรอก “ใช้ไป” แล้วระบบคำนวณคงเหลือจากยอดยกมาให้ (หรือกรอกคงเหลือแล้วระบบคำนวณใช้ไป) — ปิดไว้ = กรอกคงเหลือเองแบบเดิม</span>`;
  const cb = wrap.querySelector("#stock-mode-toggle");
  cb.addEventListener("change", async () => {
    const want = cb.checked ? "B" : "A";
    cb.disabled = true;
    try {
      await sync.flush(pcuCode(app), month);
      const data = await call("pcuSetStockMode", { mode: want }, { token: getPcuToken() });
      app.boot.pcu.stock_mode = data && data.stock_mode ? data.stock_mode : want;
      if (!app.offline) store.setCachedBootstrap(pcuCode(app), app.boot);
      renderFill(document.getElementById("app"), app, step.code, null);
    } catch (err) {
      cb.checked = !cb.checked;
      cb.disabled = false;
      toast(err && err.message ? err.message : "เปลี่ยนโหมดไม่สำเร็จ", "error");
    }
  });
  return wrap;
}

// Q90 helper lines. Plan / used-this-FY are fy_current numbers, so they only show on rounds of fy_current
// (never any previous-FY numbers); "รอบก่อน" comes from the previous round's submitted request (2o: คงเหลือ + ได้รับ).
function hintHtml(app, month, item) {
  const data = monthData(app, month);
  const lines = [];
  if (roundUsesCurrentFy(app, month)) {
    const plan = app.boot.plans && app.boot.plans[item.code];
    const planTotal = plan ? (Number(plan[0]) || 0) + (Number(plan[1]) || 0) : 0;
    const used = (data.used_fy && data.used_fy[item.code]) || 0;
    lines.push(`แผนปี ${fyShort(app.boot.config.fy_current)}: ${formatInt(planTotal)} · เบิกแล้วปีนี้: ${formatInt(used)}`);
  }
  let html = lines.map((t) => `<div class="ghost-line">${esc(t)}</div>`).join("");
  const prev = data.prev_lines && data.prev_lines[item.code];
  if (prev) {
    const opPp = `<span class="hint-opp"> · ขอ OP ${formatInt(prev.op)} / PP ${formatInt(prev.pp)}</span>`;
    if (prev.received === undefined) {
      html += `<div class="ghost-line">รอบก่อน: OP ${formatInt(prev.op)} / PP ${formatInt(prev.pp)}</div>`; // old server without 2o fields
    } else {
      const src = prev.received_src === "issued" ? "จ่ายจริง" : "ตามที่ขอ";
      html += `<div class="ghost-line">รอบก่อน: ${prev.stock == null ? "ไม่ได้กรอกคงเหลือ" : `คงเหลือ ${formatInt(prev.stock)}`} · ได้รับ ${formatInt(Number(prev.received) || 0)} (${src})${opPp}</div>`;
    }
  }
  return html;
}

function valStr(v) {
  return v == null ? "" : String(v);
}

function buildItemTable(app, month, step, editable) {
  const table = document.createElement("table");
  table.className = "item-table";
  const req = stockRequired(app);
  const modeB = isModeB(app);
  table.innerHTML = `<thead><tr>
    <th class="col-seq">ลำดับ</th>
    <th class="col-name">รายการ</th>
    <th class="col-unit">หน่วย</th>
    <th class="col-price">ราคา/หน่วย</th>
    ${modeB ? '<th class="col-num col-used">ใช้ไป</th>' : ""}
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
      tr.innerHTML = `<td colspan="${modeB ? 11 : 10}">${esc(row.title)}</td>`;
      tbody.appendChild(tr);
      continue;
    }
    if (row.active === false || hidden.has(row.code)) continue;
    tbody.appendChild(buildItemTr(app, month, row, editable));
  }
  table.appendChild(tbody);
  return table;
}

function inputHtml(field, value, editable, title) {
  return `<input class="num-input" data-field="${field}" inputmode="numeric" autocomplete="off" maxlength="5" value="${esc(valStr(value))}" ${editable ? "" : "disabled"}${title ? ` title="${esc(title)}"` : ""}>`;
}

const CALC_TAG = (field) => `<span class="calc-tag" data-calc-tag="${field}" hidden>คำนวณ</span>`;
const NO_BASE_TITLE = "ไม่มียอดยกมา — กรอกคงเหลือเอง";

// ใช้ไป input (mode B): disabled when the row has no baseline (Q13).
function usedInputHtml(app, month, item, line, editable) {
  const base = baselineOf(app, month, item.code);
  return inputHtml("used", line.used, editable && !!base, base ? "" : NO_BASE_TITLE);
}

function buildItemTr(app, month, item, editable) {
  const tr = document.createElement("tr");
  tr.className = "item-row";
  tr.dataset.code = item.code;
  const line = sync.getLine(pcuCode(app), month, item.code);
  const total = lineTotal(line);
  const modeB = isModeB(app);

  tr.innerHTML = `
    <td class="col-seq">${esc(item.seq)}</td>
    <td class="col-name"><div class="item-name">${esc(item.name)}</div>
      ${hintHtml(app, month, item)}
      ${calcBlockHtml(app, month, item, line, editable)}
      <div class="limit-msg" data-limit-for="${esc(item.code)}"></div></td>
    <td class="col-unit">${esc(item.unit || "")}</td>
    <td class="col-price">${formatMoney(priceOf(app, month, item))}</td>
    ${modeB ? `<td class="col-num col-used">${usedInputHtml(app, month, item, line, editable)}${CALC_TAG("used")}</td>` : ""}
    <td class="col-num">${inputHtml("stock", line.stock, editable)}${modeB ? CALC_TAG("stock") : ""}</td>
    <td class="col-num">${inputHtml("op", line.op, editable)}</td>
    <td class="col-num">${inputHtml("pp", line.pp, editable)}</td>
    <td class="col-num row-total">${formatInt(total)}</td>
    <td class="col-money row-money">${formatMoney(total * priceOf(app, month, item))}</td>
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
  const modeB = isModeB(app);

  card.innerHTML = `
    <div class="item-card-head">
      <span class="item-seq">${esc(item.seq)}</span>
      <span class="item-name">${esc(item.name)}</span>
      ${editable ? `<button type="button" class="btn btn-link btn-hide" data-hide="${esc(item.code)}">ไม่เบิก</button>` : ""}
    </div>
    <div class="item-card-meta">หน่วย: ${esc(item.unit || "")} · ราคา/หน่วย: ${formatMoney(priceOf(app, month, item))}</div>
    ${hintHtml(app, month, item)}
    ${calcBlockHtml(app, month, item, line, editable)}
    <div class="item-card-inputs${modeB ? " item-card-inputs-4" : ""}">
      ${modeB ? `<label>ใช้ไป${usedInputHtml(app, month, item, line, editable)}${CALC_TAG("used")}</label>` : ""}
      <label>คงเหลือ${req ? " *" : ""}${inputHtml("stock", line.stock, editable)}${modeB ? CALC_TAG("stock") : ""}</label>
      <label>OP${inputHtml("op", line.op, editable)}</label>
      <label>PP${inputHtml("pp", line.pp, editable)}</label>
    </div>
    <div class="item-card-total">รวม <span class="row-total">${formatInt(total)}</span> · เป็นเงิน <span class="row-money">${formatMoney(total * priceOf(app, month, item))}</span></div>
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
    if (inp.dataset.field !== "op" && inp.dataset.field !== "pp") return; // stock/used/adj have their own states (refreshRowCalc)
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
      const tr = input.closest("[data-code]");
      const code = tr.dataset.code;
      const field = input.dataset.field;
      const item = items.find((it) => it.code === code);

      let value;
      if (field === "adj") {
        // ± integer: optional leading "-", up to 5 digits
        let s = input.value.replace(/[^0-9-]/g, "");
        const neg = s.startsWith("-");
        s = (neg ? "-" : "") + s.replace(/-/g, "").slice(0, 5);
        if (s !== input.value) input.value = s;
        if (s === "-") return; // sign typed, digits to come
        value = s === "" ? null : parseInt(s, 10);
      } else {
        const digits = input.value.replace(/[^0-9]/g, "").slice(0, 5);
        if (digits !== input.value) input.value = digits;
        value = digits === "" ? null : parseInt(digits, 10);
      }

      const cur = sync.getLine(pcuCode(app), month, code);
      sync.setLineFields(pcuCode(app), month, code, patchForEdit(isModeB(app), baselineOf(app, month, code), cur, field, value));
      if (field === "stock") {
        input.classList.remove("input-error");
        sendUi.missing.delete(code);
      }
      const line = sync.getLine(pcuCode(app), month, code);
      const total = lineTotal(line);
      document.querySelectorAll(`[data-code="${code}"] .row-total`).forEach((el) => { el.textContent = formatInt(total); });
      document.querySelectorAll(`[data-code="${code}"] .row-money`).forEach((el) => { el.textContent = formatMoney(total * priceOf(app, month, item)); });
      refreshStepTotals(app, month, step);
      refreshRowLimit(app, month, item);
      refreshRowCalc(app, month, item);
      refreshStatusChip(app, month);
    });

    input.addEventListener("blur", () => sync.flush(pcuCode(app), month));

    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      moveToNextInput(app, input, step);
    });
  });

  // 2o: ± ปรับยอด reason dropdown, the "± ปรับยอด" link, and the Q14 "ใส่เป็นยอดรับเพิ่ม" button
  container.querySelectorAll("select.adj-reason").forEach((sel) => {
    sel.addEventListener("change", () => {
      const code = sel.closest("[data-code]").dataset.code;
      const item = items.find((it) => it.code === code);
      const cur = sync.getLine(pcuCode(app), month, code);
      sync.setLineFields(pcuCode(app), month, code, patchForEdit(true, baselineOf(app, month, code), cur, "adj_reason", sel.value || null));
      refreshRowCalc(app, month, item);
      sync.flush(pcuCode(app), month);
    });
  });
  const formEl = container.querySelector(".step-form");
  if (formEl) {
    formEl.addEventListener("click", (ev) => {
      const toggle = ev.target.closest("[data-adj-toggle]");
      if (toggle) {
        const box = toggle.closest("[data-code]").querySelector("[data-adj-box]");
        if (box) {
          box.hidden = !box.hidden;
          const inp = box.querySelector("input");
          if (!box.hidden && inp) inp.focus();
        }
        return;
      }
      const put = ev.target.closest("[data-put-extra]");
      if (put) {
        const code = put.closest("[data-code]").dataset.code;
        const item = items.find((it) => it.code === code);
        const line = sync.getLine(pcuCode(app), month, code);
        const base = baselineOf(app, month, code);
        if (!base || line.stock == null) return;
        const diff = Number(line.stock) - availableOf(base, line);
        if (diff <= 0) return;
        const adj = Math.min(99999, (Number(line.adj) || 0) + diff);
        const patch = { adj, adj_reason: "received_extra", calc_from: "stock" };
        Object.assign(patch, deriveFields(base, { ...line, ...patch }));
        sync.setLineFields(pcuCode(app), month, code, patch);
        refreshRowCalc(app, month, item);
        sync.flush(pcuCode(app), month);
      }
    });
  }

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

  items.forEach((item) => { refreshRowLimit(app, month, item); refreshRowCalc(app, month, item); });
  refreshStatusChip(app, month);
}

function moveToNextInput(app, currentInput, step) {
  const order = isModeB(app) ? ["used", "stock", "op", "pp"] : ["stock", "op", "pp"];
  const items = activeStepItems(app, step);
  const tr = currentInput.closest("[data-code]");
  const code = tr.dataset.code;
  let itemIdx = items.findIndex((it) => it.code === code);
  let fieldIdx = order.indexOf(currentInput.dataset.field);
  if (itemIdx < 0 || fieldIdx < 0) return;

  const isCard = !!currentInput.closest(".item-card");
  const scope = document.querySelector(isCard ? ".item-cards" : ".item-table");
  // Next enabled input in reading order — a disabled one (e.g. ใช้ไป of a row without baseline) is skipped.
  for (let guard = 0; guard < order.length * items.length; guard++) {
    fieldIdx++;
    if (fieldIdx >= order.length) { fieldIdx = 0; itemIdx++; }
    if (itemIdx >= items.length) return;
    const sel = `[data-code="${items[itemIdx].code}"] input[data-field="${order[fieldIdx]}"]`;
    const next = (scope && scope.querySelector(sel)) || document.querySelector(sel);
    if (next && !next.disabled) { next.focus(); return; }
  }
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

function focusItem(code, field, highlightMs = 3000) {
  setTimeout(() => {
    const visibleInputs = Array.from(document.querySelectorAll(`[data-code="${code}"] input[data-field="${field}"]`))
      .filter((el) => el.offsetParent !== null);
    const target = visibleInputs[0];
    const rowEls = document.querySelectorAll(`[data-code="${code}"]`);
    rowEls.forEach((el) => {
      el.classList.add("row-highlight");
      setTimeout(() => el.classList.remove("row-highlight"), highlightMs);
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
      <p class="muted small" id="requester-line">ผู้เบิกในใบ: ${esc(requesterOf(app.boot.pcu, request) || "— ยังไม่ได้ตั้ง")} (เปลี่ยนได้โดย รพ.)</p>
    </div>

    <div class="summary-actions">
      ${editable
        ? `<button type="button" class="btn btn-primary" id="btn-save">บันทึก</button>
           <button type="button" class="btn btn-secondary" id="btn-print">พิมพ์</button>
           <!-- 2b: "ดาวน์โหลด PDF" button goes here (requestPdf; = send + download, spec §4.4). Not in 2a. -->`
        : `<button type="button" class="btn btn-secondary" id="btn-print-view">ดู/พิมพ์ใบเบิก</button>`}
    </div>
    <p class="muted send-hint">${editable ? "บันทึก และ พิมพ์ = ส่งใบเบิกให้ผู้ดูแล (กดซ้ำเพื่อส่งใหม่หลังแก้ไข)" : ""}</p>
    ${round && editable && round.deadline_date ? `<p class="muted">${esc(deadlineText(round))}</p>` : ""}
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
