// #/feedback (2ab) — "ความคิดเห็นของฉัน": the unit's named feedback (anonymous rows are never listed) + status + admin reply.
import { call, getPcuToken } from "../api.js";
import { mineListHtml } from "../feedback_widget.js";

export async function renderFeedback(container, app, widget) {
  container.innerHTML = `
    <p><a href="#/home">‹ กลับหน้าหลัก</a></p>
    <h2>ความคิดเห็นของฉัน</h2>
    <p class="muted">แสดงเฉพาะที่ส่งแบบระบุชื่อหน่วย (ที่ติ๊ก "ไม่ระบุชื่อ" จะไม่แสดงที่นี่ และตอบกลับรายคนไม่ได้)</p>
    <p><button type="button" class="btn btn-primary" id="fb-new">ส่งความคิดเห็นใหม่</button></p>
    <div id="fb-mine-list"><p class="muted">กำลังโหลด...</p></div>`;
  container.querySelector("#fb-new").addEventListener("click", () => widget && widget.open("send"));
  const d = await call("feedbackMine", {}, { token: getPcuToken() });
  const box = container.querySelector("#fb-mine-list");
  if (box) box.innerHTML = mineListHtml(d.items || []);
}
