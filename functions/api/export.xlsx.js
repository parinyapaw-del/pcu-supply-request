// GET /api/export.xlsx?month=YYYY-MM | fy=2570   (token = ?token= or Authorization: Bearer)  — admin + dispenser. Spec §5.8.
import { ApiError, errorBody, jsonResponse } from "../_lib/http.js";
import { ensureSchema, getDb } from "../_lib/db.js";
import { requireStaff } from "../_lib/auth.js";
import { buildExport, parseExportScope } from "../_lib/export.js";
import { setDevMonth } from "../_lib/time.js";

const STATUS = { AUTH_REQUIRED: 401, AUTH_EXPIRED: 401, FORBIDDEN: 403, BAD_REQUEST: 400, NOT_FOUND: 404 };

export async function onRequestGet({ request, env }) {
  try {
    setDevMonth(env.DEV_FAKE_GOOGLE === "1" ? request.headers.get("x-dev-month") : null);
    const url = new URL(request.url);
    const auth = request.headers.get("authorization") || "";
    const token = url.searchParams.get("token") || (/^Bearer\s+(.+)$/i.exec(auth) || [])[1] || "";
    const DB = getDb(env);
    await ensureSchema(env);
    await requireStaff(env, DB, token, ["admin", "dispenser"]);
    const scope = parseExportScope(url);
    const { bytes, filename } = await buildExport(DB, scope);
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return jsonResponse(errorBody(e, env), e instanceof ApiError ? STATUS[e.code] || 400 : 500);
  }
}
