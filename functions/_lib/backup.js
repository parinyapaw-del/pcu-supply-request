// backup.js — dump every D1 table to R2 `backup/YYYY-MM-DD.json` (Bangkok date), prune backups older than 90 days,
// then apply the PDF retention rule to every PCU (2b-R). Backups are never blocked by the R2 caps, but their ops are counted.
import { TABLES, configStmt, currentSchemaVersion, ensureSchema, getDb } from "./db.js";
import { err } from "./http.js";
import { bangkokDate, nowIso } from "./time.js";
import { bumpStmt } from "./usage.js";
import { prunePdfFiles } from "./pdf.js";

const KEEP_DAYS = 90;

export async function runBackup(env) {
  if (!env.FILES) throw err("SERVER_ERROR", "ไม่พบที่เก็บไฟล์ (binding FILES)");
  await ensureSchema(env);
  const DB = getDb(env);
  const tables = {};
  for (const t of TABLES) tables[t] = (await DB.prepare(`SELECT * FROM ${t}`).all()).results;
  const body = new TextEncoder().encode(JSON.stringify({ exported_at: nowIso(), schema_version: await currentSchemaVersion(DB), tables }));
  const today = bangkokDate();
  const key = `backup/${today}.json`;
  await env.FILES.put(key, body, { httpMetadata: { contentType: "application/json" } });
  let classA = 1; // the put

  // prune old backups; what survives is the "last known backup bytes" of the R2 cost guard
  const cutoff = new Date(Date.parse(today + "T00:00:00Z") - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const deleted = [];
  let keptBytes = 0, keptFiles = 0;
  let cursor;
  do {
    const list = await env.FILES.list({ prefix: "backup/", cursor });
    classA++;
    for (const o of list.objects) {
      const m = /^backup\/(\d{4}-\d{2}-\d{2})\.json$/.exec(o.key);
      if (m && m[1] < cutoff) { await env.FILES.delete(o.key); deleted.push(o.key); }
      else { keptBytes += Number(o.size) || 0; keptFiles++; }
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await DB.batch([
    bumpStmt(DB, "r2_class_a", undefined, classA),
    configStmt(DB, "r2_backup_bytes", keptBytes),
    configStmt(DB, "r2_backup_files", keptFiles),
  ]);

  // PDF retention for all PCUs (nightly)
  const pr = await prunePdfFiles(env, DB, { reason: "backup" });
  return { key, size: body.length, deleted, pdf_pruned: pr.deleted };
}
