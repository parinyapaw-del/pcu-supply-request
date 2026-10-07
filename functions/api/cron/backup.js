// POST /api/cron/backup — D1 → R2 dump, called nightly by .github/workflows/backup.yml (header X-Backup-Key == env.BACKUP_KEY).
import { constantTimeEq } from "../../_lib/auth.js";
import { errorBody, jsonResponse, okResponse } from "../../_lib/http.js";
import { runBackup } from "../../_lib/backup.js";
import { setDevMonth } from "../../_lib/time.js";

export async function onRequestPost({ request, env }) {
  // the PDF retention inside runBackup uses currentMonth(): honour X-Dev-Month in dev like POST /api (and never keep a stale value)
  setDevMonth(env.DEV_FAKE_GOOGLE === "1" ? request.headers.get("x-dev-month") : null);
  const key = request.headers.get("x-backup-key") || "";
  if (!env.BACKUP_KEY || !constantTimeEq(key, String(env.BACKUP_KEY))) {
    return jsonResponse({ ok: false, error: { code: "FORBIDDEN", message: "ไม่มีสิทธิ์" } }, 403);
  }
  try {
    return okResponse(await runBackup(env));
  } catch (e) {
    return jsonResponse(errorBody(e, env), 500);
  }
}

export async function onRequest() {
  return jsonResponse({ ok: false, error: { code: "BAD_REQUEST", message: "ใช้ POST เท่านั้น" } }, 405);
}
