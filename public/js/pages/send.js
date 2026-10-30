// "Send" flow shared by the summary page (บันทึก / พิมพ์) and the print page (พิมพ์):
// completeness check (stock only when config.stock_required=1) -> saveLines{send:true}. 2z (Q10): the yearly ceiling never blocks nor asks —
// items over it are only mentioned in the toast after sending (the fill/summary pages show the info note). 2ad: no ceiling from fy 2570
// (config.limit_mode "off"); over the annual plan is a light-yellow note (row + summary + toast), never a block.
// phase 2 spec §4.3 — there is no withdraw; re-sending overwrites.
import { ApiError } from "../api.js";
import { getOrderedSteps, getActiveItemRows, getItemRows } from "../data.js";
import * as sync from "../sync.js";
import { limitStatus } from "../limits.js";
import { esc, pcuCode, monthData, roundUsesCurrentFy, alertDialog, toast } from "./common.js";

export function lineTotal(line) {
  return (Number(line && line.op) || 0) + (Number(line && line.pp) || 0);
}

// 2ad (Q3=ก): used this fy (other sent rounds) + requested now > annual plan (plan_op + plan_pp of fy_current) → note. No plan / plan 0 /
// nothing requested → null. Only meaningful on rounds of fy_current (the caller checks roundUsesCurrentFy).
export function planStatus(app, month, item, total) {
  if (!(total > 0)) return null;
  const plan = app.boot.plans && app.boot.plans[item.code];
  const planTotal = plan ? (Number(plan[0]) || 0) + (Number(plan[1]) || 0) : 0;
  if (planTotal <= 0) return null;
  const data = monthData(app, month);
  const used = (data.used_fy && Number(data.used_fy[item.code])) || 0;
  const over = used + total - planTotal;
  if (over <= 0) return null;
  return { over, planTotal, used, message: `ยอดรวมปีนี้จะเกินแผน ${over.toLocaleString("en-US")} ${item.unit || "หน่วย"} — ส่งได้ตามปกติ` };
}

// What would block (missing stock) / be noted (over the yearly ceiling · 2ad over the annual plan) if the request were sent now.
export function collectIssues(app, month) {
  const code = pcuCode(app);
  const cfg = app.boot.config;
  const hidden = new Set(app.boot.hidden || []);
  const data = monthData(app, month);
  const useLimits = roundUsesCurrentFy(app, month);
  const missing = [];
  const overs = [];
  const planOvers = [];
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
      const st = limitStatus({ mode: cfg.limit_mode, limits: app.boot.limits, usedFy: data.used_fy, code: item.code, total });
      if (st) overs.push({ code: item.code, name: item.name, stepCode: step.code, status: st });
      const plan = planStatus(app, month, item, total);
      if (plan) planOvers.push({ code: item.code, name: item.name, stepCode: step.code, plan });
    });
  });
  return { missing, overs, planOvers };
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
  const { missing, overs, planOvers } = collectIssues(app, month);

  if (missing.length) {
    sendUi.month = month;
    sendUi.missing = new Set(missing.map((m) => m.code));
    await alertDialog("กรอกคงเหลือไม่ครบ", `<p>ระบบตั้งให้ต้องกรอก “คงเหลือ” ทุกรายการ — ยังขาด ${missing.length} รายการ (ถ้าไม่มีของให้กรอก 0)</p><p class="muted">จะพาไปยังรายการแรกที่ยังขาด</p>`);
    gotoItem(month, missing[0].stepCode, missing[0].code, "stock");
    return false;
  }

  try {
    await sync.sendRequest(code, month);
    const notes = [];
    if (overs.length) notes.push(`${overs.length} รายการเกินเพดานรายปี (แจ้งเพื่อประมาณการปีถัดไป)`);
    if (planOvers.length) notes.push(`${planOvers.length} รายการยอดรวมปีนี้จะเกินแผน (ส่งได้ตามปกติ)`);
    toast(["บันทึกและส่งใบเบิกแล้ว", ...notes].join(" · "));
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === "INCOMPLETE") {
      const miss = err.missing || [];
      sendUi.month = month;
      sendUi.missing = new Set(miss);
      await alertDialog("กรอกคงเหลือไม่ครบ", `<p>เซิร์ฟเวอร์แจ้งว่ายังไม่ได้กรอกคงเหลือ ${miss.length} รายการ</p>`);
      const first = miss[0] && findStepOf(app, miss[0]);
      if (first) gotoItem(month, first, miss[0], "stock");
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
