// GET /api/pdf/:id — PDF download. Reserved for phase 2b (Browser Rendering + R2).
import { jsonResponse } from "../../_lib/http.js";

export async function onRequest() {
  return jsonResponse({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "ยังไม่เปิดใช้งานการดาวน์โหลด PDF" } }, 501);
}
