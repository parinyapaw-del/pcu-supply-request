// POST /api — the single JSON router (functions/API.md §1). Always answers HTTP 200 {ok,data|error}.
import { ApiError, err, errorBody, jsonResponse, okResponse, readJson } from "../_lib/http.js";
import { dropAllTables, ensureSchema, getDb } from "../_lib/db.js";
import { requirePcu, requireStaff } from "../_lib/auth.js";
import * as pcu from "../_lib/pcu.js";
import * as admin from "../_lib/admin.js";
import { adminImportSeed } from "../_lib/importer.js";
import { adminImportApply, adminImportPreview } from "../_lib/import_fy.js";
import { adminExportSeed, adminFormGet, adminFormSave } from "../_lib/form_editor.js";
import * as pdf from "../_lib/pdf.js";
import { nowIso, setDevMonth } from "../_lib/time.js";

const PUBLIC = {
  pcuList: pcu.pcuList,
  pcuLogin: pcu.pcuLogin,
  adminLoginGoogle: admin.adminLoginGoogle,
  adminLoginBackup: admin.adminLoginBackup,
  printData: pdf.printData,
};
const PCU = {
  pcuBootstrap: pcu.pcuBootstrap,
  pcuGetMonth: pcu.pcuGetMonth,
  saveLines: pcu.saveLines,
  setHidden: pcu.setHidden,
  pcuAck: pcu.pcuAck,
  requestPdf: pdf.requestPdf,
};
// admin + dispenser
const STAFF = {
  adminBootstrap: admin.adminBootstrap,
  adminRequests: admin.adminRequests,
  adminGetRequest: admin.adminGetRequest,
  adminRequestPdf: pdf.adminRequestPdf,
};
// admin only
const ADMIN = {
  adminNote: admin.adminNote,
  adminSetRound: admin.adminSetRound,
  adminLockRound: admin.adminLockRound,
  adminSetLimitMode: admin.adminSetLimitMode,
  adminSetConfig: admin.adminSetConfig,
  adminSetLimit: admin.adminSetLimit,
  adminResetLimit: admin.adminResetLimit,
  adminLimitsUpload: admin.adminLimitsUpload,
  adminUnlockLimit: admin.adminUnlockLimit,
  adminRemoveUnlock: admin.adminRemoveUnlock,
  adminSetPin: admin.adminSetPin,
  adminUnlockPin: admin.adminUnlockPin,
  adminSetHidden: admin.adminSetHidden,
  adminSetBackupPassword: admin.adminSetBackupPassword,
  adminUsersList: admin.adminUsersList,
  adminUsersAdd: admin.adminUsersAdd,
  adminUsersRemove: admin.adminUsersRemove,
  adminImportSeed,
  adminImportPreview,
  adminImportApply,
  adminExportSeed,
  adminFormGet,
  adminFormSave,
  adminClearTrial: admin.adminClearTrial,
  adminBackupNow: admin.adminBackupNow,
  adminAuditLog: admin.adminAuditLog,
};
const REMOVED = {
  submit: "ไม่มี action submit แล้ว — ใช้ saveLines พร้อม send:true",
  withdraw: "ไม่มีการถอนใบเบิกแล้ว (แก้ไขแล้วบันทึกใหม่ได้)",
  adminReceive: "ไม่มีการรับเรื่องแล้ว",
  adminReturn: "ใช้ adminNote (โน้ตขอให้แก้) แทน adminReturn",
  adminSetMode: "ใช้ adminSetLimitMode (off/warn/enforce) แทน adminSetMode",
};
const RESERVED = new Set(["issueLines", "issueAll", "issueDone"]);
const isReserved = (a) => RESERVED.has(a);
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// dev-only helpers (DEV_FAKE_GOOGLE=1)
async function devAction(action, ctx, p) {
  if (ctx.env.DEV_FAKE_GOOGLE !== "1") throw err("FORBIDDEN", "ใช้ได้เฉพาะโหมดพัฒนา");
  if (action === "devReset") { await dropAllTables(ctx.env); return { ok: true }; }
  if (action === "devPutBackup") { // seed a fake old backup to test pruning
    if (!/^backup\/\d{4}-\d{2}-\d{2}\.json$/.test(String(p.key || ""))) throw err("BAD_REQUEST", "key ไม่ถูกต้อง");
    await ctx.env.FILES.put(p.key, "{}");
    return { ok: true };
  }
  if (action === "devListBackups") {
    const l = await ctx.env.FILES.list({ prefix: "backup/" });
    return { keys: l.objects.map((o) => o.key), sizes: Object.fromEntries(l.objects.map((o) => [o.key, o.size])) };
  }
  if (action === "devListFiles") { // R2 keys under a prefix (2b tests: pdf/…)
    const prefix = String(p.prefix || "");
    const keys = [];
    let cursor;
    do {
      const l = await ctx.env.FILES.list({ prefix, cursor });
      keys.push(...l.objects.map((o) => o.key));
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    return { keys };
  }
  if (action === "devPrintToken") return pdf.devPrintToken(ctx, p); // fresh print token for {pcu, month}
  throw err("BAD_REQUEST", "ไม่รู้จัก action");
}

export async function onRequestPost({ request, env }) {
  try {
    setDevMonth(env.DEV_FAKE_GOOGLE === "1" ? request.headers.get("x-dev-month") : null);
    const body = await readJson(request);
    const action = typeof body.action === "string" ? body.action : "";
    if (!action) throw err("BAD_REQUEST", "ต้องระบุ action");
    if (isReserved(action)) throw err("NOT_IMPLEMENTED", "ยังไม่เปิดใช้งานฟังก์ชันนี้");
    if (has(REMOVED, action)) throw err("BAD_REQUEST", REMOVED[action]);

    const known = has(PUBLIC, action) || has(PCU, action) || has(STAFF, action) || has(ADMIN, action) || /^dev(Reset|PutBackup|ListBackups|ListFiles|PrintToken)$/.test(action);
    if (!known) throw err("BAD_REQUEST", "ไม่รู้จัก action: " + action.slice(0, 60));

    const DB = getDb(env);
    await ensureSchema(env);
    const ctx = { env, DB, request };
    let data;
    if (has(PUBLIC, action)) data = await PUBLIC[action](ctx, body);
    else if (/^dev/.test(action)) data = await devAction(action, ctx, body);
    else if (has(PCU, action)) { ctx.pcu = await requirePcu(env, DB, body.token); data = await PCU[action](ctx, body); }
    else if (has(STAFF, action)) { ctx.who = await requireStaff(env, DB, body.token, ["admin", "dispenser"]); data = await STAFF[action](ctx, body); }
    else { ctx.who = await requireStaff(env, DB, body.token, ["admin"]); data = await ADMIN[action](ctx, body); }
    return okResponse(data);
  } catch (e) {
    return jsonResponse(errorBody(e, env));
  }
}

export async function onRequestGet() {
  return okResponse({ service: "pcu-supply", time: nowIso() });
}

export async function onRequest() {
  return jsonResponse({ ok: false, error: { code: "BAD_REQUEST", message: "ใช้ POST เท่านั้น" } }, 405);
}
