// "Send" flow shared by the summary page (บันทึก / พิมพ์) and the print page (พิมพ์):
// completeness check (stock only when config.stock_required=1) -> ceiling check per mode
// (off: none · warn: one confirm · enforce: blocked unless an admin unlock exists) -> saveLines{send:true}.
// phase 2 spec §4.3 — there is no withdraw; re-sending overwrites.
import { ApiError } from "../api.js";
import { getOrderedSteps, getActiveItemRows, getItemRows } from "../data.js";
import * as sync from "../sync.js";
import { limitStatus } from "../limits.js";
import { esc, pcuCode, monthData, unlocksOf, roundUsesCurrentFy, alertDialog, confirmDialog, toast } from "./common.js";

export function lineTotal(line) {
  return (Number(line && line.op) || 0) + (Number(line && line.pp) || 0);
}

// What would block / warn if the request were sent now.
export function collectIssues(app, month) {
  const code = pcuCode(app);
  const cfg = app.boot.config;
  const hidden = new Set(app.boot.hidden || []);
  const data = monthData(app, month);
  const unlocks = unlocksOf(app, month);
  const useLimits = roundUsesCurrentFy(app, month);
  const missing = [];
  const overs = [];
  getOrderedSteps(app.boot.form).forEach((step) => {
    getActiveItemRows(step).forEach((item) => {
      if (cfg.stock_required === 1 && !hidden.has(item.code) && sync.getLine(code, month, item.code).stock == null) {
        missing.push({ code: item.code, name: item.name, stepCode: step.code });
      }
    });
    // the server checks every line with qty > 0 (hidden or inactive items included)
    getItemRows(step).forEach((item) => {
      const total = lineTotal(sync.getLine(code, month, item.code));
      if (!useLimits || total <= 0) return;
      const st = limitStatus({ mode: cfg.limit_mode, limits: app.boot.limits, usedFy: data.used_fy, unlocks, code: item.code, total });
      if (st) overs.push({ code: item.code, name: item.name, stepCode: step.code, status: st });
    });
  });
  return { missing, overs };
}

function gotoItem(month, stepCode, code, field) {
  location.hash = `#/fill/${stepCode}?month=${month}&focus=${encodeURIComponent(code)}&field=${field}`;
}

function findStepOf(app, code) {
  for (const step of app.boot.form.steps) {
    if (step.rows.some((r) => r.type === "item" && r.code === code)) return step.code;
  }
  return null;
}

// UI state shared with fill.js: item codes to highlight in red after a blocked send.
export const sendUi = { missing: new Set(), month: null };

/** @returns {Promise<boolean>} true when the request was sent (status "submitted"). */
export async function trySend(app, month) {
  const code = pcuCode(app);
  const cfg = app.boot.config;
  const { missing, overs } = collectIssues(app, month);

  if (missing.length) {
    sendUi.month = month;
    sendUi.missing = new Set(missing.map((m) => m.code));
    await alertDialog("กรอกคงเหลือไม่ครบ", `<p>ระบบตั้งให้ต้องกรอก “คงเหลือ” ทุกรายการ — ยังขาด ${missing.length} รายการ (ถ้าไม่มีของให้กรอก 0)</p><p class="muted">จะพาไปยังรายการแรกที่ยังขาด</p>`);
    gotoItem(month, missing[0].stepCode, missing[0].code, "stock");
    return false;
  }

  const blocked = overs.filter((o) => o.status.blocked);
  if (blocked.length) {
    await alertDialog("ส่งไม่ได้ — เกินเพดานการเบิก", overListHtml(blocked) + `<p class="muted">ลดจำนวนลง หรือแจ้ง admin เพื่อปลดล็อกรายการนี้</p>`);
    gotoItem(month, blocked[0].stepCode, blocked[0].code, "op");
    return false;
  }
  const warned = overs.filter((o) => !o.status.unlockReason);
  if (warned.length && cfg.limit_mode === "warn") {
    const ok = await confirmDialog("มีรายการเกินเพดาน", overListHtml(warned) + `<p>ยังส่งใบเบิกได้ (โหมดเตือน) — ยืนยันส่ง?</p>`, "ยืนยันส่ง", "กลับไปแก้");
    if (!ok) return false;
  }

  try {
    await sync.sendRequest(code, month);
    toast("บันทึกและส่งใบเบิกแล้ว");
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === "INCOMPLETE") {
      const miss = err.missing || [];
      sendUi.month = month;
      sendUi.missing = new Set(miss);
      await alertDialog("กรอกคงเหลือไม่ครบ", `<p>เซิร์ฟเวอร์แจ้งว่ายังไม่ได้กรอกคงเหลือ ${miss.length} รายการ</p>`);
      const first = miss[0] && findStepOf(app, miss[0]);
      if (first) gotoItem(month, first, miss[0], "stock");
    } else if (err instanceof ApiError && err.code === "OVER_LIMIT") {
      const items = err.items || [];
      // The server says these are not unlocked (an admin may have removed the unlock) — drop the stale client copy.
      const cur = app.boot.unlocks && app.boot.unlocks[month];
      if (cur) items.forEach((i) => { delete cur[i.code]; });
      const rows = items.map((i) => `<li>${esc(itemName(app, i.code))} (${esc(i.code)}): ขอ ${i.total}${i.limit_month != null ? ` · เพดานเดือน ${i.limit_month}` : ""}${i.limit_year != null ? ` · เพดานปี ${i.limit_year} (เบิกแล้ว ${i.used_fy})` : ""}</li>`).join("");
      await alertDialog("ส่งไม่ได้ — เกินเพดานการเบิก", `<ul>${rows}</ul>`);
      const first = items[0] && findStepOf(app, items[0].code);
      if (first) gotoItem(month, first, items[0].code, "op");
    } else if (err instanceof ApiError && err.code === "CONFLICT") {
      await alertDialog("รอบนี้ปิดรับแล้ว", `<p>${esc(err.message || "รอบนี้ปิดรับแล้ว แก้ไขไม่ได้")}</p>`);
      try {
        const d = await sync.reloadSession(code, month);
        const r = app.boot.rounds.find((x) => x.month === month);
        if (r && d && d.round) Object.assign(r, d.round);
      } catch (e) { /* ignore */ }
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else if (err instanceof ApiError && String(err.code).startsWith("AUTH_")) {
      throw err;
    } else {
      await alertDialog("ส่งไม่สำเร็จ", `<p>${esc(err.message || "ลองใหม่อีกครั้ง")}</p>`);
    }
    return false;
  }
}

function itemName(app, code) {
  for (const step of app.boot.form.steps) {
    const r = step.rows.find((x) => x.type === "item" && x.code === code);
    if (r) return r.name;
  }
  return code;
}

export function overListHtml(list) {
  return `<ul class="dlg-list">${list.map((o) => `<li><strong>${esc(o.name)}</strong> (${esc(o.code)})<br>${o.status.messages.map(esc).join("<br>")}</li>`).join("")}</ul>`;
}
