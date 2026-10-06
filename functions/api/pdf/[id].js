// GET /api/pdf/:id?k=<content_key>&token=<pcu|staff token>  (token may also be `Authorization: Bearer`) — streams the cached PDF from R2.
// A PCU token must own the request; admin / dispenser may download any. Real HTTP status codes (not called through js/api.js).
import { ApiError, err, errorBody, jsonResponse } from "../../_lib/http.js";
import { ensureSchema, getDb } from "../../_lib/db.js";
import { requirePcu, requireStaff, verifyToken } from "../../_lib/auth.js";
import { encodeFilename, loadForDownload, pdfFilename, pdfR2Key } from "../../_lib/pdf.js";

const STATUS = { AUTH_REQUIRED: 401, AUTH_EXPIRED: 401, FORBIDDEN: 403, BAD_REQUEST: 400, NOT_FOUND: 404 };

export async function onRequestGet({ request, env, params }) {
  try {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization") || "";
    const token = url.searchParams.get("token") || (/^Bearer\s+(.+)$/i.exec(auth) || [])[1] || "";
    const key = url.searchParams.get("k") || "";
    const id = Array.isArray(params.id) ? params.id.join("/") : String(params.id || "");
    const DB = getDb(env);
    await ensureSchema(env);

    if (!token) throw err("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบ");
    const payload = await verifyToken(env, token);
    let pcuCode = null; // set for a PCU token: the only PCU whose request it may download
    if (payload.t === "pcu") pcuCode = (await requirePcu(env, DB, token)).code;
    else await requireStaff(env, DB, token, ["admin", "dispenser"]);

    if (!/^[0-9a-f]{64}$/.test(key)) throw err("BAD_REQUEST", "ลิงก์ดาวน์โหลดไม่ถูกต้อง");
    const found = await loadForDownload(DB, id);
    if (!found) throw err("NOT_FOUND", "ไม่พบไฟล์ PDF");
    if (pcuCode !== null && pcuCode !== found.reqRow.pcu) throw err("FORBIDDEN", "ไม่มีสิทธิ์ดาวน์โหลดไฟล์นี้");
    const row = await DB.prepare(`SELECT r2_key FROM pdf_files WHERE request_id = ? AND content_key = ?`).bind(found.reqRow.id, key).first();
    const obj = row && env.FILES ? await env.FILES.get(row.r2_key || pdfR2Key(found.reqRow.pcu, found.reqRow.month, key)) : null;
    if (!obj) throw err("NOT_FOUND", "ไม่พบไฟล์ PDF — กดดาวน์โหลดใหม่อีกครั้ง");

    const filename = pdfFilename(found.pcuRow && (found.pcuRow.print_name || found.pcuRow.name), found.reqRow.month);
    return new Response(obj.body, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="request.pdf"; filename*=UTF-8''${encodeFilename(filename)}`,
        "cache-control": "private, max-age=0",
      },
    });
  } catch (e) {
    return jsonResponse(errorBody(e, env), e instanceof ApiError ? STATUS[e.code] || 400 : 500);
  }
}

export async function onRequest() {
  return jsonResponse({ ok: false, error: { code: "BAD_REQUEST", message: "ใช้ GET เท่านั้น" } }, 405);
}
