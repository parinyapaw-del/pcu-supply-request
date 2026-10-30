// Tab 6 — Excel (phase 2.md §5.8, functions/API.md §6): GET /api/export.xlsx?month=|fy=. Downloaded with fetch +
// an Authorization header so the token never lands in the URL / browser history.
import { getAdminToken } from "../api.js";
import { el, downloadBlob, monthLong, toast } from "./util.js";
import { loadMonth } from "./requests.js";
import { getXLSX, requestRows, yearWorkbook, saveWorkbook } from "../xlsx_export.js";

export function renderTab6(container, ctx) {
  const { state } = ctx;
  const cur = ctx.roundMonth();
  const fy = ctx.fySelected();
  const pick = ctx.defaultMonth() || cur;
  container.innerHTML = "";

  const card = el("div", { class: "admin-card", id: "t6-card" });
  card.appendChild(el("h2", {}, "ดาวน์โหลด Excel"));
  card.appendChild(el("p", { class: "admin-note" }, "ไฟล์ .xlsx 3 แผ่น: รายบรรทัด · รพ.สต. × รายการ · สรุปเงินต่อ รพ.สต. (ราคา ณ วันส่ง) — จ่ายจริงจะมีค่าเมื่อเริ่มบันทึกจ่ายจริง (phase 2c)"));
  const msg = el("p", { class: "admin-note", id: "t6-msg", role: "status" });

  async function download(query, label) {
    msg.textContent = `กำลังสร้างไฟล์ ${label}...`;
    msg.className = "admin-note";
    try {
      const res = await fetch("/api/export.xlsx?" + query, { headers: { Authorization: "Bearer " + getAdminToken() } });
      if (!res.ok) {
        let m = `ดาวน์โหลดไม่สำเร็จ (HTTP ${res.status})`;
        try { const j = await res.json(); if (j && j.error && j.error.message) m = j.error.message; } catch (e) { /* ignore */ }
        throw new Error(m);
      }
      const blob = await res.blob();
      let name = "export.xlsx";
      const cd = res.headers.get("Content-Disposition") || "";
      const mStar = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const mPlain = /filename="?([^";]+)"?/i.exec(cd);
      if (mStar) { try { name = decodeURIComponent(mStar[1]); } catch (e) { name = mStar[1]; } } else if (mPlain) name = mPlain[1];
      downloadBlob(blob, name);
      msg.textContent = `ดาวน์โหลดแล้ว: ${name} (${Math.round(blob.size / 1024)} KB)`;
      msg.className = "admin-ok-text";
    } catch (err) {
      msg.textContent = err.message || String(err);
      msg.className = "admin-err-text";
      toast(msg.textContent, "err");
    }
  }

  const row1 = el("div", { class: "admin-toolbar" });
  const btnCur = el("button", { type: "button", class: "btn btn-primary", id: "t6-month-now" }, `ดาวน์โหลด Excel รอบปัจจุบัน (ขอเบิก ${monthLong(cur)})`);
  btnCur.addEventListener("click", () => download("month=" + encodeURIComponent(cur), monthLong(cur)));
  row1.appendChild(btnCur);
  if (ctx.isCurrentFy()) card.appendChild(row1);

  const row2 = el("div", { class: "admin-toolbar" });
  const picker = el("input", { type: "month", id: "t6-month", value: pick });
  const btnPick = el("button", { type: "button", class: "btn btn-secondary", id: "t6-month-pick" }, "ดาวน์โหลดเดือนที่เลือก");
  btnPick.addEventListener("click", () => {
    if (!/^\d{4}-\d{2}$/.test(picker.value)) { toast("เลือกเดือนให้ถูกต้อง", "err"); return; }
    download("month=" + encodeURIComponent(picker.value), monthLong(picker.value));
  });
  row2.appendChild(el("label", {}, ["เดือน: ", picker]));
  row2.appendChild(btnPick);
  card.appendChild(row2);

  const row3 = el("div", { class: "admin-toolbar" });
  const btnFy = el("button", { type: "button", class: "btn btn-secondary", id: "t6-fy" }, `ทั้งปีงบ ${fy}`);
  btnFy.addEventListener("click", () => download("fy=" + encodeURIComponent(fy), `ปีงบ ${fy}`));
  row3.appendChild(btnFy);
  card.appendChild(row3);

  // 2ag: per-line sheets of every PCU (stock / used / OP / PP / issued / received / mismatch), built in the browser from the same
  // adminRequests + adminGetRequest data as the status tabs (cached); a PCU column is added, sheets `data` + `สรุป`.
  card.appendChild(el("h3", {}, "ใบเบิกรายบรรทัด ทุก รพ.สต. (สำหรับทำสถิติ)"));
  card.appendChild(el("p", { class: "admin-note" }, "ไฟล์ .xlsx แผ่น data (1 แถว = รพ.สต. × เดือน × รายการ) + แผ่น สรุป (รายการ × เดือน) · สร้างในเบราว์เซอร์ อาจใช้เวลาครู่หนึ่งเมื่อเลือกทั้งปีงบ"));
  async function downloadLines(months, filename) {
    msg.textContent = "กำลังรวบรวมข้อมูลใบเบิก...";
    msg.className = "admin-note";
    try {
      const entries = [];
      for (const m of months) {
        const data = await loadMonth(ctx, m, (d, n) => { msg.textContent = `กำลังรวบรวม ${monthLong(m)} (${d}/${n})...`; });
        const nameOf = new Map(data.requests.map((r) => [r.pcu, r.pcu_name || r.pcu]));
        data.entries.forEach((e) => {
          const base = {};
          ((e.form && e.form.steps) || []).forEach((st) => (st.rows || []).forEach((r) => { if (r.type === "item") base[r.code] = r.price; }));
          const rows = requestRows(e.request, e.form, (code, l) => (l.price_print ?? l.price_snapshot ?? base[code]));
          if (rows.length) entries.push({ pcu: e.pcu, pcu_name: nameOf.get(e.pcu), month: m, rows });
        });
      }
      if (!entries.length) throw new Error("ยังไม่มีใบเบิกที่ส่งแล้วในช่วงนี้");
      const XLSX = await getXLSX();
      entries.sort((a, b) => a.month.localeCompare(b.month) || String(a.pcu).localeCompare(String(b.pcu)));
      saveWorkbook(XLSX, yearWorkbook(XLSX, entries, { withPcu: true }), filename);
      msg.textContent = `ดาวน์โหลดแล้ว: ${filename}`;
      msg.className = "admin-ok-text";
    } catch (err) {
      msg.textContent = err.message || String(err);
      msg.className = "admin-err-text";
      toast(msg.textContent, "err");
    }
  }
  const row4 = el("div", { class: "admin-toolbar" });
  const btnLinesMonth = el("button", { type: "button", class: "btn btn-secondary", id: "t6-lines-month" }, "รายบรรทัด เดือนที่เลือก");
  btnLinesMonth.addEventListener("click", () => {
    if (!/^\d{4}-\d{2}$/.test(picker.value)) { toast("เลือกเดือนให้ถูกต้อง", "err"); return; }
    downloadLines([picker.value], `ใบเบิก_ทุกรพสต_${picker.value}.xlsx`);
  });
  const btnLinesFy = el("button", { type: "button", class: "btn btn-secondary", id: "t6-lines-fy" }, `รายบรรทัด ทั้งปีงบ ${fy}`);
  btnLinesFy.addEventListener("click", () => {
    const trial = new Set(((ctx.state.bootstrap && ctx.state.bootstrap.rounds) || []).filter((r) => r.trial).map((r) => r.month));
    const months = ctx.fyMonths().filter((m) => /^\d{4}-\d{2}$/.test(m) && !trial.has(m)).sort();
    downloadLines(months, `ใบเบิก_ทุกรพสต_ปีงบ${fy}.xlsx`);
  });
  row4.appendChild(btnLinesMonth);
  row4.appendChild(btnLinesFy);
  card.appendChild(row4);
  card.appendChild(msg);
  container.appendChild(card);
  return null;
}
