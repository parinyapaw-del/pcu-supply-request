// importer.js — adminImportSeed: the idempotent import of a `pcu-supply-import/1` JSON (seed/FORMAT.md).
// Every top-level key except `format`/`fy` is optional, so a large seed can be sent in several calls
// (the per-table "replace the fy" rules apply per call — send each table+fy at most once).
import { err, isStr, sha256Hex, stableStringify } from "./http.js";
import { auditStmt, batchChunked, configStmt, getConfigAll, insertStatements, normalizeForm } from "./db.js";
import { DEFAULT_PIN, hashSecret, newSalt } from "./auth.js";
import { isMonth, nowIso } from "./time.js";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const nn = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round2 = (x) => Math.round(x * 100) / 100;
const CONFIG_KEYS = ["fy_current", "limit_mode", "stock_required", "budget_op", "budget_pp", "budget_total", "deadline_day"];

function validateForm(form) {
  if (!isObj(form) || !Array.isArray(form.steps) || !form.steps.length) throw err("BAD_REQUEST", "form.steps ไม่ถูกต้อง");
  const seen = new Set();
  for (const s of form.steps) {
    if (!isObj(s) || !isStr(s.code) || !Array.isArray(s.rows)) throw err("BAD_REQUEST", "form: step ไม่ถูกต้อง");
    for (const r of s.rows) {
      if (r.type === "section") { if (!isStr(r.title)) throw err("BAD_REQUEST", "form: section ไม่มี title"); continue; }
      if (r.type !== "item" || !isStr(r.code) || !isStr(r.name)) throw err("BAD_REQUEST", "form: row ไม่ถูกต้อง");
      if (seen.has(r.code)) throw err("BAD_REQUEST", "form: รหัสรายการซ้ำ " + r.code);
      if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price < 0) throw err("BAD_REQUEST", "form: ราคาไม่ถูกต้อง " + r.code);
      seen.add(r.code);
    }
  }
}

export async function adminImportSeed(ctx, p) {
  const { DB, who } = ctx;
  const seed = p.seed;
  if (!isObj(seed)) throw err("BAD_REQUEST", "ต้องมี seed (object)");
  if (seed.format !== "pcu-supply-import/1") throw err("BAD_REQUEST", "format ต้องเป็น pcu-supply-import/1");
  if (!Number.isInteger(seed.fy)) throw err("BAD_REQUEST", "ต้องมี fy (พ.ศ.)");
  const warnings = [];
  const imported = { pcus: 0, form: "none", plans: 0, actual_rows: 0, prices_prev: 0, stats: 0, limits_inserted: 0, limits_kept_admin: 0, config_set: [] };
  const ts = nowIso();

  // known PCU codes (file + already in DB)
  const { results: dbPcus } = await DB.prepare(`SELECT code FROM pcus`).all();
  const pcuSet = new Set(dbPcus.map((r) => r.code));

  // ---- pcus ----
  if (Array.isArray(seed.pcus)) {
    const stmts = [];
    for (const r of seed.pcus) {
      if (!isObj(r) || !isStr(r.code) || !isStr(r.name)) throw err("BAD_REQUEST", "pcus: แถวไม่ถูกต้อง");
      pcuSet.add(r.code);
      const salt = newSalt();
      // new PCUs get PIN 12345; the DO UPDATE branch never touches pin_*
      stmts.push(DB.prepare(
        `INSERT INTO pcus (code,name,print_name,"group",pin_hash,pin_salt,pin_version,pin_fail,pin_custom) VALUES (?,?,?,?,?,?,1,0,0)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, print_name=excluded.print_name, "group"=excluded."group"`
      ).bind(r.code, r.name, r.print_name || r.name, r.group ?? null, await hashSecret(DEFAULT_PIN, salt), salt));
    }
    await batchChunked(DB, stmts);
    imported.pcus = seed.pcus.length;
  }

  // ---- form version ----
  let formForCheck = null;
  if (seed.form !== undefined && seed.form !== null) {
    validateForm(seed.form);
    const form = normalizeForm(seed.form);
    const formFy = Number.isInteger(form.fy) ? form.fy : seed.fy;
    const data = { fy: formFy, note: form.note ?? null, steps: form.steps };
    const dataJson = JSON.stringify(data);
    const hash = await sha256Hex(stableStringify(data));
    formForCheck = data;
    const { results: existing } = await DB.prepare(`SELECT id, data_hash FROM form_versions WHERE fy = ?`).bind(formFy).all();
    if (!existing.length) {
      await DB.prepare(`INSERT INTO form_versions (fy,created_at,created_by,note,data,data_hash) VALUES (?,?,?,?,?,?)`)
        .bind(formFy, ts, who.email, form.note ?? null, dataJson, hash).run();
      imported.form = "inserted";
    } else if (existing.some((r) => r.data_hash === hash)) {
      imported.form = "same";
    } else {
      imported.form = "skipped_differs";
      warnings.push(`form ปีงบ ${formFy}: มี version อยู่แล้วและต่างจากไฟล์ — ไม่ทับ (แก้ที่ form editor)`);
    }
  }

  const knownPcu = (code, what) => {
    if (pcuSet.has(code)) return true;
    warnings.push(`${what}: ไม่พบ รพ.สต. ${code} — ข้าม`);
    return false;
  };

  // ---- plans ----
  if (isObj(seed.plans)) {
    for (const [fyKey, byPcu] of Object.entries(seed.plans)) {
      const fy = Number(fyKey);
      if (!Number.isInteger(fy) || !isObj(byPcu)) throw err("BAD_REQUEST", "plans: รูปแบบไม่ถูกต้อง");
      const rows = [];
      for (const [pcu, items] of Object.entries(byPcu)) {
        if (!knownPcu(pcu, `plans.${fy}`)) continue;
        for (const [code, v] of Object.entries(items || {})) rows.push([fy, pcu, code, num(v && v[0]), num(v && v[1])]);
      }
      await batchChunked(DB, [DB.prepare(`DELETE FROM plans WHERE fy = ?`).bind(fy),
        ...insertStatements(DB, "plans", ["fy", "pcu", "item_code", "plan_op", "plan_pp"], rows)]);
      imported.plans += rows.length;
    }
  }

  // ---- actual_prev ----
  if (isObj(seed.actual_prev)) {
    for (const [fyKey, blk] of Object.entries(seed.actual_prev)) {
      const fy = Number(fyKey);
      if (!Number.isInteger(fy) || !isObj(blk) || !Array.isArray(blk.months) || blk.months.length !== 12 || !blk.months.every(isMonth) || !isObj(blk.data)) {
        throw err("BAD_REQUEST", "actual_prev: ต้องมี months (12 เดือน CE) และ data");
      }
      const rows = [];
      for (const [pcu, items] of Object.entries(blk.data)) {
        if (!knownPcu(pcu, `actual_prev.${fy}`)) continue;
        for (const [code, v] of Object.entries(items || {})) {
          for (let i = 0; i < 12; i++) {
            const op = num(v && v.op && v.op[i]), pp = num(v && v.pp && v.pp[i]);
            if (op > 0 || pp > 0) rows.push([fy, blk.months[i], pcu, code, op, pp]);
          }
        }
      }
      await batchChunked(DB, [DB.prepare(`DELETE FROM actual_prev WHERE fy = ?`).bind(fy),
        ...insertStatements(DB, "actual_prev", ["fy", "month", "pcu", "item_code", "op", "pp"], rows)]);
      imported.actual_rows += rows.length;
    }
  }

  // ---- prices_prev ----
  if (isObj(seed.prices_prev)) {
    for (const [fyKey, prices] of Object.entries(seed.prices_prev)) {
      const fy = Number(fyKey);
      if (!Number.isInteger(fy) || !isObj(prices)) throw err("BAD_REQUEST", "prices_prev: รูปแบบไม่ถูกต้อง");
      const rows = Object.entries(prices).map(([code, price]) => [fy, code, num(price)]);
      await batchChunked(DB, [DB.prepare(`DELETE FROM prices_prev WHERE fy = ?`).bind(fy),
        ...insertStatements(DB, "prices_prev", ["fy", "item_code", "price"], rows)]);
      imported.prices_prev += rows.length;
    }
  }

  // ---- stats ----
  if (isObj(seed.stats)) {
    for (const [fyKey, byPcu] of Object.entries(seed.stats)) {
      const fy = Number(fyKey);
      if (!Number.isInteger(fy) || !isObj(byPcu)) throw err("BAD_REQUEST", "stats: รูปแบบไม่ถูกต้อง");
      const rows = [];
      for (const [pcu, items] of Object.entries(byPcu)) {
        if (!knownPcu(pcu, `stats.${fy}`)) continue;
        for (const [code, v] of Object.entries(items || {})) rows.push([fy, pcu, code, num(v && v[0]), num(v && v[1]), num(v && v[2])]);
      }
      await batchChunked(DB, [DB.prepare(`DELETE FROM stats WHERE fy = ?`).bind(fy),
        ...insertStatements(DB, "stats", ["fy", "pcu", "item_code", "median_m", "p90_m", "annual_qty"], rows)]);
      imported.stats += rows.length;
    }
  }

  // ---- limits (never overwrite admin-edited rows) ----
  if (isObj(seed.limits)) {
    for (const [fyKey, byPcu] of Object.entries(seed.limits)) {
      const fy = Number(fyKey);
      if (!Number.isInteger(fy) || !isObj(byPcu)) throw err("BAD_REQUEST", "limits: รูปแบบไม่ถูกต้อง");
      const { results: have } = await DB.prepare(`SELECT pcu, item_code, limit_month, limit_year, source FROM limits WHERE fy = ?`).bind(fy).all();
      const admin = new Set(have.filter((r) => r.source === "admin").map((r) => r.pcu + "|" + r.item_code));
      const same = new Map(have.map((r) => [r.pcu + "|" + r.item_code, `${r.limit_month ?? ""}|${r.limit_year ?? ""}|${r.source ?? ""}`]));
      const rows = [];
      for (const [pcu, items] of Object.entries(byPcu)) {
        if (!knownPcu(pcu, `limits.${fy}`)) continue;
        for (const [code, v] of Object.entries(items || {})) {
          if (admin.has(pcu + "|" + code)) { imported.limits_kept_admin++; continue; }
          // an identical row is not rewritten (so a re-import of an adminExportSeed file reports limits_inserted: 0)
          if (same.get(pcu + "|" + code) === `${nn(v && v[0]) ?? ""}|${nn(v && v[1]) ?? ""}|${(v && v[2]) || "import"}`) continue;
          rows.push([fy, pcu, code, nn(v && v[0]), nn(v && v[1]), (v && v[2]) || "import", "import", ts]);
        }
      }
      await batchChunked(DB, insertStatements(DB, "limits", ["fy", "pcu", "item_code", "limit_month", "limit_year", "source", "updated_by", "updated_at"], rows, {
        suffix: `ON CONFLICT(fy,pcu,item_code) DO UPDATE SET limit_month=excluded.limit_month, limit_year=excluded.limit_year, source=excluded.source,
                 updated_by=excluded.updated_by, updated_at=excluded.updated_at WHERE limits.source != 'admin'`,
      }));
      imported.limits_inserted += rows.length;
    }
  }

  // ---- config (only keys with no value yet; fy_current also when set_current_fy) ----
  if (isObj(seed.config) || p.set_current_fy === true) {
    const cfgIn = isObj(seed.config) ? seed.config : {};
    const existing = await getConfigAll(DB);
    const stmts = [], keys = [];
    for (const k of CONFIG_KEYS) {
      if (p.set_current_fy === true && k === "fy_current") { stmts.push(configStmt(DB, k, seed.fy)); keys.push(k); continue; }
      if (cfgIn[k] === undefined || Object.prototype.hasOwnProperty.call(existing, k)) continue;
      stmts.push(configStmt(DB, k, cfgIn[k])); keys.push(k);
    }
    if (stmts.length) await batchChunked(DB, stmts);
    imported.config_set = keys;
  }

  // ---- integrity warnings against the file's own verify block ----
  try {
    const planTot = isObj(seed.config) && isObj(seed.config.plan_total) ? seed.config.plan_total[String(seed.fy)] : null;
    if (planTot && formForCheck && isObj(seed.plans) && isObj(seed.plans[String(seed.fy)])) {
      const price = {};
      for (const s of formForCheck.steps) for (const r of s.rows) if (r.type === "item") price[r.code] = r.price;
      let op = 0, pp = 0;
      for (const items of Object.values(seed.plans[String(seed.fy)])) for (const [c, v] of Object.entries(items)) { op += num(v[0]) * (price[c] || 0); pp += num(v[1]) * (price[c] || 0); }
      if (Math.abs(round2(op + pp) - num(planTot.total)) > 0.01) warnings.push(`ยอดแผนที่คำนวณ ${round2(op + pp)} ไม่ตรงกับ config.plan_total ${planTot.total}`);
    }
  } catch (e) { console.error("import verify", e); }

  await DB.batch([auditStmt(DB, who.email, who.role, "import_seed", "", "", JSON.stringify({ fy: seed.fy, ...imported }))]);
  return { imported, warnings };
}
