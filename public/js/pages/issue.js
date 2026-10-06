// Issue-notice detail (#/issue?month=YYYY-MM) — SKELETON for checkpoint 2c (phase 2 spec §4.1, Q77).
// In 2a `issue_notices` is always empty, so this page is not reachable from the UI; it only reads
// byMonth[month].issue and offers "รับทราบ" (pcuAck). The per-item table (ขอ OP/PP · ได้ OP/PP · เหตุผล)
// arrives with 2c, when the API returns issued_* fields to the PCU.
import { call, getPcuToken } from "../api.js";
import { esc, monthData, monthLabel, loadOlderMonth, alertDialog } from "./common.js";

export async function renderIssue(container, app, params) {
  const month = params.get("month") || (app.boot.rounds[0] && app.boot.rounds[0].month);
  await loadOlderMonth(app, month);
  const issue = monthData(app, month).issue;

  const box = document.createElement("div");
  box.className = "issue-page";
  box.innerHTML = `
    <h2>การจ่ายวัสดุ ${esc(monthLabel(month))}</h2>
    ${issue
      ? `<p>พัสดุจ่ายแล้ว ${esc(issue.units_done)}/${esc(issue.units_total)} หน่วย — ครบ ${esc(issue.complete)} รายการ · ไม่ครบ ${esc(issue.incomplete)} รายการ</p>
         <p class="muted">รายละเอียดรายการ (ขอ · ได้ · เหตุผล) จะแสดงที่นี่ใน phase 2c</p>`
      : `<p class="muted">ยังไม่มีข้อมูลการจ่ายของเดือนนี้</p>`}
    <div class="summary-actions">
      <button type="button" class="btn btn-secondary" id="btn-issue-back">กลับหน้าหลัก</button>
      ${issue ? '<button type="button" class="btn btn-primary" id="btn-ack">รับทราบ</button>' : ""}
    </div>`;
  container.innerHTML = "";
  container.appendChild(box);

  box.querySelector("#btn-issue-back").addEventListener("click", () => { location.hash = "#/home"; });
  const ack = box.querySelector("#btn-ack");
  if (ack) {
    ack.addEventListener("click", async () => {
      ack.disabled = true;
      try {
        await call("pcuAck", { month }, { token: getPcuToken() });
        app.boot.issue_notices = (app.boot.issue_notices || []).filter((n) => n.month !== month);
        location.hash = "#/home";
      } catch (err) {
        ack.disabled = false;
        await alertDialog("รับทราบไม่สำเร็จ", `<p>${esc(err.message || "")}</p>`);
      }
    });
  }
}
