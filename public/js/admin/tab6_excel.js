// Tab 6 — Excel (phase 2.md §5.8, functions/API.md §6): GET /api/export.xlsx?month=|fy=. Downloaded with fetch +
// an Authorization header so the token never lands in the URL / browser history.
import { getAdminToken } from "../api.js";
import { el, downloadBlob, monthLong, toast } from "./util.js";

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
  card.appendChild(msg);
  container.appendChild(card);
  return null;
}
