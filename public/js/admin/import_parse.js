// js/admin/import_parse.js — phase 2e: pure parsing / mapping for "เปิดปีงบใหม่" (phase 2.md §5.10).
// No DOM, no API, no imports: used by tab11_import.js in the browser (SheetJS workbook from getXLSX())
// and by tools/check_import_2570.mjs in node (workbook from the `xlsx` package). Only plain workbook
// objects are read ({SheetNames, Sheets[name]["!ref"|"!merges"|A1...]}) so both SheetJS builds work.
//
// Robustness rules (spec): header rows are located by keywords (ลำดับ/รายการ/หน่วย/ราคา, PCU names, OP/PP,
// รวมเป็นเงิน) — never by fixed row/column indexes; sheet names may change; merged header cells, blank rows
// and blank columns are tolerated; numbers may be strings ("1,234.50").
//
// Reference implementation: tools/build_data.py (form file), tools/build_map_2570.py (plan file + matching).

export const IMPORT_FORMAT = "pcu-supply-import/1";
export const FUZZY_MIN = 0.6;          // brief 2e: fuzzy suggestion threshold (name similarity)
export const MAX_ACTIVE_ITEMS = 24;    // functions/_lib/form_editor.js
export const MAX_ACTIVE_STEPS = 10;
export const MAX_SECTIONS = 2;
const ITEM_CODE_RE = /^([A-Z0-9]+)-(\d{2,3})$/;
const STEP_CODE_RE = /^[A-Z0-9]{1,6}$/;
const DISPENSE_UNITS = ["พัสดุ", "จ่ายกลาง", "LAB"];

// ---- small value helpers -------------------------------------------------------------------------------------------------
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
export const round2 = (x) => Math.round((Number(x) + (x >= 0 ? 1e-9 : -1e-9)) * 100) / 100;

// Any cell value -> single-line trimmed string ("" for null/undefined).
export function cleanText(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[\r\n\t ​]+/g, " ").replace(/\s+/g, " ").trim();
}

// Cell value -> number or null. Accepts numbers and numeric strings ("1,234.5", " 12 ", "฿ 30").
export function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null || v === undefined) return null;
  const s = String(v).replace(/[,\s ฿]/g, "").replace(/บาท$/, "");
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// quantity: integer when whole, else up to 6 decimals (FORMAT.md)
export function qty(x) {
  const n = Number(x) || 0;
  return Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : Math.round(n * 1e6) / 1e6;
}

// Header keyword key: no whitespace at all, lower case ("ลำ\nดับ" -> "ลำดับ", "ราคา/\nหน่วย" -> "ราคา/หน่วย").
const hk = (v) => cleanText(v).replace(/\s+/g, "").toLowerCase();

// Item-name key for "exact" (build_map_2570.py norm): drop whitespace + quotes, lowercase, unify ×/x/*.
export function normName(s) {
  let t = cleanText(s).toLowerCase().replace(/×/g, "*");
  t = t.replace(/[\s"'“”″‘’]+/g, "");
  t = t.replace(/(\d)x(?=\d)/g, "$1*");
  return t;
}

// Extra folding used only for similarity (never for "exact"): also strip punctuation and the bracketed
// pack notes "(100 ชิ้น/กล่อง)" the brief mentions, plus a few spelling variants seen in the real files.
export function looseName(s) {
  let t = normName(s);
  for (const [a, b] of [["syringes", "syringe"], ["disposable", "dispos"], ["oxygen", "oxgen"]]) t = t.split(a).join(b);
  return t.replace(/[-()/.,:;_\[\]]/g, "");
}
function noParens(s) {
  return normName(cleanText(s).replace(/\([^()]*\)/g, " "));
}

// Levenshtein ratio (len(a)+len(b)-dist)/(len(a)+len(b)) — same spirit as python difflib's ratio.
function levRatio(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  let prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return (la + lb - prev[lb]) / (la + lb);
}

// Name similarity in [0,1]: best of the strict key, the loose key and the key without "( … )" notes.
export function similarity(a, b) {
  return Math.max(levRatio(normName(a), normName(b)), levRatio(looseName(a), looseName(b)), levRatio(noParens(a), noParens(b)));
}

const unitKey = (u) => cleanText(u).replace(/\s+/g, "").toLowerCase();

// ---- worksheet -> grid ------------------------------------------------------------------------------------------------------
function decodeCol(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function decodeCell(a1) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(a1).toUpperCase());
  return m ? { c: decodeCol(m[1]), r: Number(m[2]) - 1 } : null;
}
function decodeRange(ref) {
  const [a, b] = String(ref || "").split(":");
  const s = decodeCell(a);
  const e = decodeCell(b || a);
  return s && e ? { s, e } : null;
}

// {rows: raw values [r][c] ("" when empty), filled: same with merged ranges filled by their top-left value, nrows, ncols, merges}
export function sheetGrid(ws) {
  const range = ws && decodeRange(ws["!ref"]);
  if (!range) return { rows: [], filled: [], nrows: 0, ncols: 0, merges: [] };
  const nrows = range.e.r + 1, ncols = range.e.c + 1;
  const rows = Array.from({ length: nrows }, () => new Array(ncols).fill(""));
  for (const key of Object.keys(ws)) {
    if (key[0] === "!") continue;
    const p = decodeCell(key);
    if (!p || p.r >= nrows || p.c >= ncols) continue;
    const cell = ws[key];
    if (!cell || cell.t === "e" || cell.t === "z") continue;
    let v = cell.v;
    if (v === undefined || v === null) v = cell.w !== undefined ? cell.w : "";
    if (v instanceof Date) v = v.toISOString().slice(0, 10);
    rows[p.r][p.c] = v;
  }
  const merges = (ws["!merges"] || []).map((m) => (typeof m === "string" ? decodeRange(m) : m)).filter(Boolean);
  const filled = rows.map((r) => r.slice());
  for (const m of merges) {
    const v = rows[m.s.r] && rows[m.s.r][m.s.c];
    if (v === "" || v === undefined) continue;
    for (let r = m.s.r; r <= Math.min(m.e.r, nrows - 1); r++) {
      for (let c = m.s.c; c <= Math.min(m.e.c, ncols - 1); c++) if (filled[r][c] === "") filled[r][c] = v;
    }
  }
  return { rows, filled, nrows, ncols, merges };
}

// ---- item table header (ลำดับ / รายการ / หน่วย / ราคา) -------------------------------------------------------------------------
// Looks at a window of 3 rows (the header is often 2–3 rows with merged cells). Returns {row, cols:{seq,name,unit,price}} or null.
function findItemHeader(g, fromRow = 0, toRow = Math.min(g.nrows, 80)) {
  for (let r = fromRow; r < toRow; r++) {
    const cols = {};
    for (let rr = r; rr < Math.min(r + 3, g.nrows); rr++) {
      const row = g.rows[rr];
      for (let c = 0; c < g.ncols; c++) {
        const k = hk(row[c]);
        if (!k) continue;
        if (cols.seq === undefined && /^(ลำดับ|ลำดับที่|ที่|no\.?|seq)$/.test(k) && rr === r) cols.seq = c;
        else if (cols.name === undefined && /^(รายการ|ชื่อรายการ|รายการวัสดุ)/.test(k)) cols.name = c;
        else if (cols.price === undefined && /^ราคา/.test(k)) cols.price = c;
        else if (cols.unit === undefined && /^หน่วย(นับ)?$/.test(k)) cols.unit = c;
      }
    }
    if (cols.seq !== undefined && cols.name !== undefined && cols.unit !== undefined && cols.price !== undefined) return { row: r, cols };
  }
  return null;
}

const isTotalLabel = (v) => /^(รวม|รวมทั้งสิ้น|รวมเป็นเงิน|รวมเงิน|total)$/.test(hk(v));
const isSignature = (v) => /^ลงชื่อ/.test(hk(v));

// Item name of a row: the name column, else the first text cell between the name and unit columns (merged layouts).
function rowName(row, cols) {
  const direct = cleanText(row[cols.name]);
  if (direct) return direct;
  for (let c = cols.name + 1; c < cols.unit; c++) {
    const t = cleanText(row[c]);
    if (t && toNum(t) === null) return t;
  }
  return "";
}

// Walks the rows below a header: items (numeric seq + name), sections (no seq, text name, no price), stops at the totals row
// (first cell "รวม…") or a signature row. → {rows:[...], totalRow, lastRow}
function readItemRows(g, header, startRow) {
  const { cols } = header;
  const out = [];
  let totalRow = null, r = startRow;
  for (; r < g.nrows; r++) {
    const row = g.rows[r];
    const firstText = row.slice(0, cols.unit).map(cleanText).find((t) => t) || "";
    if (isTotalLabel(firstText) || row.slice(0, Math.max(cols.price + 4, 8)).some((v) => /^รวมเป็นเงิน/.test(hk(v)))) { totalRow = r; break; }
    if (isSignature(firstText)) break;
    const seq = toNum(row[cols.seq]);
    const name = rowName(row, cols);
    if (seq !== null && seq > 0 && Number.isInteger(seq) && name) {
      out.push({ type: "item", seq, name, unit: cleanText(row[cols.unit]), price: toNum(row[cols.price]), row: r });
    } else if (seq === null && name && cleanText(row[cols.seq]) === "" && toNum(row[cols.price]) === null && toNum(name) === null) {
      if (/^(\/|op|pp|รวม|\(จำนวน\)|หน่วย)$/i.test(hk(name))) continue; // header continuation
      out.push({ type: "section", title: name, row: r });
    }
  }
  while (out.length && out[out.length - 1].type === "section") out.pop(); // trailing headings with no items
  return { rows: out, totalRow, lastRow: r };
}

// Text that follows a label ("เรื่อง", "เรียน") in the rows above the header: same cell after the label, else the next text cell.
function labelValue(g, uptoRow, label) {
  for (let r = 0; r < uptoRow; r++) {
    const row = g.rows[r];
    for (let c = 0; c < g.ncols; c++) {
      const t = cleanText(row[c]);
      if (!t.startsWith(label)) continue;
      const rest = t.slice(label.length).replace(/^[\s:：]+/, "");
      if (rest) return rest;
      for (let cc = c + 1; cc < g.ncols; cc++) { const v = cleanText(row[cc]); if (v) return v; }
    }
  }
  return "";
}

// ---- form file: แบบฟอร์มเบิก ปี XXXX (1 sheet = 1 page) ---------------------------------------------------------------------------
// → {pages:[{sheet, title, subject, to, header_row, total_row, rows:[{type:"section",title}|{type:"item",seq,name,unit,price}]}],
//    skipped:[{sheet, reason}], items:n, warnings:[...]}
export function parseFormWorkbook(wb) {
  const pages = [], skipped = [], warnings = [];
  for (const sheet of (wb && wb.SheetNames) || []) {
    const g = sheetGrid(wb.Sheets[sheet]);
    const header = findItemHeader(g);
    if (!header) { skipped.push({ sheet, reason: "ไม่พบหัวตาราง ลำดับ/รายการ/หน่วย/ราคา" }); continue; }
    const body = readItemRows(g, header, header.row + 1);
    const items = body.rows.filter((x) => x.type === "item");
    if (!items.length) { skipped.push({ sheet, reason: "ไม่มีรายการในตาราง" }); continue; }
    let title = "";
    for (let r = 0; r < header.row && !title; r++) {
      for (const v of g.rows[r]) {
        const t = cleanText(v);
        if (t && !/^(เรื่อง|เรียน|เลขที่|วันที่)/.test(t) && toNum(t) === null) { title = t; break; }
      }
    }
    const page = {
      sheet, title, subject: labelValue(g, header.row, "เรื่อง"), to: labelValue(g, header.row, "เรียน"),
      header_row: header.row, total_row: body.totalRow,
      rows: body.rows.map((x) => (x.type === "item" ? { type: "item", seq: x.seq, name: x.name, unit: x.unit, price: x.price } : { type: "section", title: x.title }))
    };
    const nSec = page.rows.filter((x) => x.type === "section").length;
    if (nSec > MAX_SECTIONS) warnings.push(`แผ่น "${sheet}": มีหัวหมวด ${nSec} หัว (ระบบรับได้ไม่เกิน ${MAX_SECTIONS}) — จะใช้ ${MAX_SECTIONS} หัวแรก`);
    if (items.length > MAX_ACTIVE_ITEMS) warnings.push(`แผ่น "${sheet}": มี ${items.length} รายการ (เกิน ${MAX_ACTIVE_ITEMS} ต่อหน้า) — ระบบจะไม่รับจนกว่าจะแบ่งหน้า`);
    if (body.totalRow === null) warnings.push(`แผ่น "${sheet}": ไม่พบแถว "รวม" ท้ายตาราง — อ่านถึงแถวสุดท้ายที่มีรายการ`);
    items.forEach((it) => { if (it.price === null) warnings.push(`แผ่น "${sheet}" ลำดับ ${it.seq}: ไม่มีราคาในไฟล์แบบฟอร์ม`); });
    pages.push(page);
  }
  // global sequence check (P2 continues after P1)
  const seqs = pages.flatMap((p) => p.rows.filter((x) => x.type === "item").map((x) => x.seq));
  for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) { warnings.push(`ลำดับรายการไม่ต่อเนื่อง: ${seqs[i - 1]} → ${seqs[i]}`); break; }
  if (pages.length > MAX_ACTIVE_STEPS) warnings.push(`พบ ${pages.length} หน้า (ระบบรับได้ไม่เกิน ${MAX_ACTIVE_STEPS} หน้า)`);
  return { pages, skipped, items: seqs.length, warnings };
}

// ---- PCU names in headers ------------------------------------------------------------------------------------------------------
function pcuKey(s) {
  return cleanText(s).replace(/\s+/g, "").replace(/ฯ/g, "").replace(/^(รพ\.?สต\.?|โรงพยาบาลส่งเสริมสุขภาพตำบล|สอ\.|ศูนย์)/, "").toLowerCase();
}
// Header text -> PCU code (exact name > header contains name > name contains header), longest name wins.
export function matchPcu(text, pcus) {
  const h = pcuKey(text);
  if (!h || h.length < 2 || toNum(text) !== null) return null;
  let best = null, bestScore = 0, bestLen = 0;
  for (const p of pcus || []) {
    for (const nm of [p.name, p.print_name, p.code]) {
      const k = pcuKey(nm);
      if (!k || k.length < 2) continue;
      const score = h === k ? 3 : h.includes(k) ? 2 : k.includes(h) && h.length >= 3 ? 1 : 0;
      if (score > bestScore || (score === bestScore && score > 0 && k.length > bestLen)) { best = p.code; bestScore = score; bestLen = k.length; }
    }
  }
  return best;
}

// Finds the PCU header row of a sheet: the row (first 40) whose cells name the most PCUs (≥ 2 and ≥ half of them).
function findPcuRow(g, pcus) {
  let best = null;
  for (let r = 0; r < Math.min(g.nrows, 40); r++) {
    const found = new Map();
    for (let c = 0; c < g.ncols; c++) {
      const v = g.rows[r][c];
      if (typeof v !== "string") continue;
      const code = matchPcu(v, pcus);
      if (code && !found.has(code)) found.set(code, { col: c, header: cleanText(v) });
    }
    if (found.size >= 2 && found.size >= Math.ceil((pcus || []).length / 2) && (!best || found.size > best.found.size)) best = { row: r, found };
  }
  return best;
}

// ---- plan file: ประมาณการ ปีงบ XX ---------------------------------------------------------------------------------------------------
// pcus = [{code,name,print_name}] (bootstrap.pcus). → {sheet, sheet_rule, candidates:[sheet], pcus:[{code,header,op_col,pp_col}],
//   missing_pcus:[code], items:[{seq,name,unit,price,section,qty:{pcu:[op,pp]}}], sections:[...],
//   totals:{per_pcu:{pcu:{op,pp,total}}|null, network:{op,pp,total}|null, row}, warnings:[...]}  — or {error}
export function parsePlanWorkbook(wb, pcus) {
  const cands = [];
  for (const sheet of (wb && wb.SheetNames) || []) {
    const g = sheetGrid(wb.Sheets[sheet]);
    const pr = findPcuRow(g, pcus);
    if (!pr) continue;
    const title = g.rows.slice(0, pr.row).map((r) => r.map(cleanText).filter(Boolean).join(" ")).join(" ");
    cands.push({ sheet, g, pr, title });
  }
  if (!cands.length) return { error: "ไม่พบแผ่นงานที่มีหัวคอลัมน์เป็นชื่อ รพ.สต. (ตรวจว่าเป็นไฟล์ประมาณการ และชื่อ รพ.สต. ตรงกับในระบบ)" };
  const parsedAll = cands.map((c) => ({ c, res: parsePlanSheet(c.g, c.pr, pcus) }));
  const ok = parsedAll.filter((x) => !x.res.error);
  if (!ok.length) return { error: parsedAll[0].res.error, candidates: cands.map((c) => c.sheet) };
  // which sheet is the "รวม" plan: named รวม > title "( รวม )" / "รวม" > largest network total
  let pick = ok.find((x) => hk(x.c.sheet) === "รวม"), rule = "ชื่อแผ่น \"รวม\"";
  if (!pick) { pick = ok.find((x) => /\(\s*รวม\s*\)/.test(x.c.title)); rule = "หัวกระดาษ \"( รวม )\""; }
  if (!pick && ok.length > 1) {
    pick = ok.slice().sort((a, b) => netQty(b.res) - netQty(a.res))[0];
    rule = "ยอดรวมมากที่สุด (รวม = ทั่วไป + NCD)";
  }
  if (!pick) { pick = ok[0]; rule = "แผ่นเดียวที่มีชื่อ รพ.สต."; }
  return { sheet: pick.c.sheet, sheet_rule: rule, candidates: cands.map((c) => c.sheet), ...pick.res };
}
function netQty(res) {
  let s = 0;
  for (const it of res.items) for (const v of Object.values(it.qty)) s += v[0] + v[1];
  return s;
}

function parsePlanSheet(g, pr, pcus) {
  const warnings = [];
  // PCU blocks: start = header cell col; end = its merge end, else next PCU start - 1
  const starts = [...pr.found.entries()].map(([code, v]) => ({ code, header: v.header, col: v.col })).sort((a, b) => a.col - b.col);
  starts.forEach((b, i) => {
    const m = g.merges.find((mm) => mm.s.r <= pr.row && mm.e.r >= pr.row && mm.s.c === b.col);
    const next = i + 1 < starts.length ? starts[i + 1].col - 1 : g.ncols - 1;
    b.end = m ? Math.min(m.e.c, next) : next;
  });
  // OP/PP sub-header: first row below the PCU row that has OP and PP inside the first block
  let subRow = null;
  for (let r = pr.row + 1; r < Math.min(pr.row + 4, g.nrows) && subRow === null; r++) {
    const b = starts[0];
    const ks = g.rows[r].slice(b.col, b.end + 1).map(hk);
    if (ks.includes("op") && ks.includes("pp")) subRow = r;
  }
  if (subRow === null) return { error: "ไม่พบหัวคอลัมน์ OP / PP ใต้ชื่อ รพ.สต." };
  const blocks = [];
  for (const b of starts) {
    const ks = g.rows[subRow].map(hk);
    let op = null, pp = null;
    const baht = [];
    for (let c = b.col; c <= b.end; c++) {
      if (ks[c] === "op" && op === null) op = c;
      else if (ks[c] === "pp" && pp === null) pp = c;
      else if (/เป็นเงิน|บาท/.test(ks[c])) baht.push(c);
    }
    if (op === null || pp === null) { warnings.push(`คอลัมน์ ${b.header}: ไม่พบ OP/PP — ข้าม`); continue; }
    blocks.push({ code: b.code, header: b.header, op_col: op, pp_col: pp, baht_cols: baht, col: b.col, end: b.end });
  }
  // item columns: keyword header within a few rows around the PCU row
  const header = findItemHeader(g, Math.max(0, pr.row - 3), Math.min(g.nrows, subRow + 1));
  if (!header) return { error: "ไม่พบหัวตาราง ลำดับ/รายการ/หน่วย/ราคา ในแผ่นประมาณการ" };
  const body = readItemRows(g, header, subRow + 1);
  const items = [], sections = [];
  let section = "";
  for (const x of body.rows) {
    if (x.type === "section") { section = x.title; sections.push(x.title); continue; }
    const row = g.rows[x.row];
    const q = {};
    for (const b of blocks) {
      const op = toNum(row[b.op_col]) || 0, pp = toNum(row[b.pp_col]) || 0;
      q[b.code] = [op, pp];
    }
    items.push({ seq: x.seq, name: x.name, unit: x.unit, price: x.price, section, qty: q });
  }
  // totals row ("รวมเป็นเงิน"): per-PCU baht from the block's เป็นเงิน columns (OP, PP, รวม), network from a "…เป็นเงิน" group
  let per = null, network = null;
  if (body.totalRow !== null) {
    const row = g.rows[body.totalRow];
    per = {};
    for (const b of blocks) {
      const vals = b.baht_cols.map((c) => toNum(row[c]));
      if (vals.length >= 3) per[b.code] = { op: round2(vals[0] || 0), pp: round2(vals[1] || 0), total: round2(vals[2] || 0) };
      else if (vals.length === 1) per[b.code] = { op: null, pp: null, total: round2(vals[0] || 0) };
    }
    const lastEnd = Math.max(...starts.map((b) => b.end));
    for (let r = Math.max(0, pr.row - 2); r <= pr.row && !network; r++) {
      for (let c = lastEnd + 1; c < g.ncols && !network; c++) {
        if (!/เป็นเงิน/.test(hk(g.rows[r][c]))) continue;
        const m = g.merges.find((mm) => mm.s.r === r && mm.s.c === c);
        const end = m ? m.e.c : Math.min(c + 2, g.ncols - 1);
        let sr = null;
        for (let rr = r + 1; rr <= subRow && sr === null; rr++) if (g.rows[rr].slice(c, end + 1).map(hk).includes("op")) sr = rr;
        if (sr === null) continue;
        const ks = g.rows[sr].map(hk);
        const pick = (k) => { for (let cc = c; cc <= end; cc++) if (ks[cc] === k) return toNum(row[cc]); return null; };
        const n = { op: pick("op"), pp: pick("pp"), total: pick("รวม") };
        if (n.total !== null) network = { op: round2(n.op || 0), pp: round2(n.pp || 0), total: round2(n.total) };
      }
    }
  } else warnings.push("ไม่พบแถว \"รวมเป็นเงิน\" — ตรวจยอดต่อแห่งกับไฟล์ไม่ได้");
  const missing = (pcus || []).map((p) => p.code).filter((c) => !blocks.some((b) => b.code === c));
  items.forEach((it) => { if (it.price === null) warnings.push(`ประมาณการ ลำดับ ${it.seq}: ไม่มีราคา`); });
  return {
    pcus: blocks.map((b) => ({ code: b.code, header: b.header, op_col: b.op_col, pp_col: b.pp_col })),
    missing_pcus: missing, items, sections,
    totals: { per_pcu: per, network, row: body.totalRow },
    header_row: header.row, pcu_row: pr.row, warnings
  };
}

// ---- mapping -----------------------------------------------------------------------------------------------------------------------
function currentItems(form) {
  const out = [];
  ((form && form.steps) || []).forEach((s, si) => {
    let section = "";
    (s.rows || []).forEach((r) => {
      if (r.type === "section") { section = r.title; return; }
      if (r.type !== "item") return;
      out.push({ code: r.code, name: r.name, unit: r.unit, price: r.price, active: r.active !== false && s.active !== false, step: s.code, stepIdx: si, section });
    });
  });
  return out;
}

// default dispense unit for a brand-new page, from its title
function guessDispenseUnit(title) {
  const t = cleanText(title);
  if (/จ่ายกลาง/.test(t)) return "จ่ายกลาง";
  if (/LAB|เทคนิคการแพทย์|พยาธิ|ชันสูตร/i.test(t)) return "LAB";
  return "พัสดุ";
}

// Next free item code with `prefix` (max number among `used` + 1, 2 digits, 3 when > 99).
export function nextCode(prefix, used) {
  let max = 0;
  for (const c of used) {
    const m = ITEM_CODE_RE.exec(c);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  const n = max + 1;
  return n > 999 ? null : `${prefix}-${String(n).padStart(n > 99 ? 3 : 2, "0")}`;
}

// parsed = {form: parseFormWorkbook(), plan: parsePlanWorkbook()|null}; currentForm = latest form of fy_current (closed rows incl.).
// → mapping {pages, items, plan_link, plan_unmatched, warnings}; each item has `suggestion` {code, kind:"exact"|"fuzzy"|"new", sim}
// plus `candidates` (top similar codes). The UI keeps the user's choice in item.choice ({code}|{new:true}) + item.confirmed.
export function mapItems(parsed, currentForm) {
  const warnings = [];
  const cur = currentItems(currentForm);
  const curSteps = ((currentForm && currentForm.steps) || []);
  const pages = parsed.form.pages.map((p, i) => ({ idx: i, sheet: p.sheet, title: p.title, subject: p.subject, to: p.to, step_code: null, step_how: "", dispense_unit: null }));

  // pages -> step codes: same sheet name > same title > same position (only when the page count is unchanged) > new "Sxx"
  const usedSteps = new Set();
  const take = (p, s, how) => { p.step_code = s.code; p.step_how = how; p.dispense_unit = s.dispense_unit || null; usedSteps.add(s.code); };
  for (const p of pages) { const s = curSteps.find((x) => !usedSteps.has(x.code) && hk(x.sheet) && hk(x.sheet) === hk(p.sheet)); if (s) take(p, s, "ชื่อแผ่น"); }
  for (const p of pages) { if (p.step_code) continue; const s = curSteps.find((x) => !usedSteps.has(x.code) && hk(x.title) && hk(x.title) === hk(p.title)); if (s) take(p, s, "ชื่อใบ"); }
  const activeCur = curSteps.filter((s) => s.active !== false);
  if (activeCur.length === pages.length) {
    pages.forEach((p, i) => { if (!p.step_code && !usedSteps.has(activeCur[i].code)) take(p, activeCur[i], "ลำดับหน้า"); });
  }
  for (const p of pages) {
    if (p.step_code) continue;
    for (let n = curSteps.length + 1; n < 100; n++) {
      const c = "S" + String(n).padStart(2, "0");
      if (!usedSteps.has(c) && !curSteps.some((s) => s.code === c)) { p.step_code = c; usedSteps.add(c); break; }
    }
    p.step_how = "หน้าใหม่";
    p.dispense_unit = guessDispenseUnit(p.title);
  }
  pages.forEach((p) => { if (!p.dispense_unit) p.dispense_unit = guessDispenseUnit(p.title); });

  // plan rows -> form items: exact name key, else same seq with similarity ≥ 0.8 (reported)
  const items = [];
  parsed.form.pages.forEach((p, pi) => p.rows.forEach((r) => {
    if (r.type === "item") items.push({ key: "r" + items.length, page: pi, step_code: pages[pi].step_code, seq: r.seq, name: r.name, unit: r.unit, file_price: r.price, price: r.price, price_src: "form", plan_idx: null });
  }));
  const planItems = (parsed.plan && parsed.plan.items) || [];
  const planLink = new Map(); // plan idx -> item key
  if (planItems.length) {
    const byName = new Map();
    planItems.forEach((pl, i) => { const k = normName(pl.name); byName.set(k, byName.has(k) ? -1 : i); });
    for (const it of items) {
      const i = byName.get(normName(it.name));
      if (i !== undefined && i >= 0 && !planLink.has(i)) { it.plan_idx = i; planLink.set(i, it.key); }
    }
    for (const it of items) {
      if (it.plan_idx !== null) continue;
      const i = planItems.findIndex((pl, j) => !planLink.has(j) && pl.seq === it.seq && similarity(pl.name, it.name) >= 0.8);
      if (i >= 0) { it.plan_idx = i; planLink.set(i, it.key); warnings.push(`ลำดับ ${it.seq} "${it.name}": ชื่อในไฟล์ประมาณการต่างเล็กน้อย ("${planItems[i].name}") — จับคู่ด้วยลำดับ`); }
    }
    for (const it of items) {
      if (it.plan_idx === null) { warnings.push(`ลำดับ ${it.seq} "${it.name}": ไม่พบในไฟล์ประมาณการ — ใช้ราคาจากไฟล์แบบฟอร์ม ไม่มีแผน`); continue; }
      const pl = planItems[it.plan_idx];
      if (pl.price !== null && pl.price !== undefined) { it.price = pl.price; it.price_src = "plan"; }
      if (pl.unit && unitKey(pl.unit) !== unitKey(it.unit)) it.plan_unit = pl.unit;
    }
  }
  const planUnmatched = planItems.map((pl, i) => ({ ...pl, idx: i })).filter((pl) => !planLink.has(pl.idx)).map((pl) => ({ seq: pl.seq, name: pl.name, unit: pl.unit, price: pl.price }));
  items.forEach((it) => { if (it.price === null || it.price === undefined) { it.price = 0; warnings.push(`ลำดับ ${it.seq} "${it.name}": ไม่มีราคา — ตั้งเป็น 0`); } });

  // 1) exact: unique normalized name on both sides
  const curByKey = new Map();
  cur.forEach((c) => { const k = normName(c.name); curByKey.set(k, curByKey.has(k) ? null : c); });
  const fileKeyCount = new Map();
  items.forEach((it) => { const k = normName(it.name); fileKeyCount.set(k, (fileKeyCount.get(k) || 0) + 1); });
  const taken = new Set();
  for (const it of items) {
    const k = normName(it.name);
    const c = curByKey.get(k);
    if (c && fileKeyCount.get(k) === 1 && !taken.has(c.code)) {
      it.suggestion = { code: c.code, kind: "exact", sim: 1 };
      taken.add(c.code);
    }
  }
  // 2) fuzzy: similarity ≥ FUZZY_MIN, ranked by 0.8·sim + 0.1·same unit + 0.1·neighbourhood (same page or an exact
  //    neighbour pointing next to the candidate); greedy best-first so every code is suggested once.
  const fileIdx = new Map(items.map((it, i) => [it.key, i]));
  const curIdx = new Map(cur.map((c, i) => [c.code, i]));
  const neighbourScore = (it, c) => {
    const i = fileIdx.get(it.key);
    let s = 0;
    for (const d of [-1, 1]) {
      const nb = items[i + d];
      if (nb && nb.suggestion && nb.suggestion.kind === "exact") {
        const j = curIdx.get(nb.suggestion.code);
        if (j !== undefined && Math.abs(j - curIdx.get(c.code)) <= 2) s += 0.5;
      }
    }
    return Math.max(s, it.step_code === c.step ? 0.5 : 0);
  };
  const pairs = [];
  for (const it of items) {
    it.candidates = [];
    const sims = cur.map((c) => ({ c, sim: similarity(it.name, c.name) })).sort((a, b) => b.sim - a.sim);
    it.candidates = sims.slice(0, 6).map((x) => ({ code: x.c.code, sim: round2(x.sim) }));
    if (it.suggestion) continue;
    for (const { c, sim } of sims) {
      if (sim < FUZZY_MIN) break;
      if (taken.has(c.code)) continue;
      const score = 0.8 * sim + 0.1 * (unitKey(c.unit) === unitKey(it.unit) ? 1 : 0) + 0.1 * neighbourScore(it, c) * 2;
      pairs.push({ it, c, sim, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || fileIdx.get(a.it.key) - fileIdx.get(b.it.key));
  for (const p of pairs) {
    if (p.it.suggestion || taken.has(p.c.code)) continue;
    p.it.suggestion = { code: p.c.code, kind: "fuzzy", sim: round2(p.sim) };
    taken.add(p.c.code);
  }
  // 3) new
  for (const it of items) if (!it.suggestion) it.suggestion = { code: null, kind: "new", sim: 0 };
  for (const it of items) {
    it.choice = it.suggestion.kind === "new" ? { new: true } : { code: it.suggestion.code };
    it.confirmed = it.suggestion.kind === "exact";
  }
  return { pages, items, current: cur, current_steps: curSteps.map((s) => ({ code: s.code, title: s.title, sheet: s.sheet, active: s.active !== false, dispense_unit: s.dispense_unit })), plan_unmatched: planUnmatched, warnings };
}

// Resolves the user's choices: new codes (next number in the page, file order), duplicates, missing current items.
// → {codes:{itemKey: code}, duplicates:[code], unconfirmed:n, missing:[current item], ok:bool}
export function resolveMapping(mapping) {
  const used = new Set(mapping.current.map((c) => c.code));
  const chosen = new Map();
  const codes = {};
  for (const it of mapping.items) {
    if (it.choice && it.choice.code) {
      codes[it.key] = it.choice.code;
      chosen.set(it.choice.code, (chosen.get(it.choice.code) || 0) + 1);
    }
  }
  for (const it of mapping.items) {
    if (it.choice && it.choice.code) continue;
    const page = mapping.pages[it.page];
    const prefix = page.step_code;
    const c = nextCode(prefix, used);
    codes[it.key] = c;
    used.add(c);
  }
  const duplicates = [...chosen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  const chosenSet = new Set(Object.values(codes));
  const missing = mapping.current.filter((c) => c.active && !chosenSet.has(c.code));
  const unconfirmed = mapping.items.filter((it) => !it.confirmed).length;
  return { codes, duplicates, unconfirmed, missing, ok: !duplicates.length && !unconfirmed };
}

// ---- build the import JSON (seed/FORMAT.md) ----------------------------------------------------------------------------------
// opts: {fy, parsed, mapping, pcus:[{code,name,print_name,group}], sources:[filename], currentForm}
export function buildImportJson({ fy, parsed, mapping, pcus, sources, currentForm }) {
  const res = resolveMapping(mapping);
  const curSteps = (currentForm && currentForm.steps) || [];
  const steps = mapping.pages.map((pg, pi) => {
    const src = parsed.form.pages[pi];
    const rows = [];
    let nSec = 0, k = 0;
    const pageItems = mapping.items.filter((it) => it.page === pi);
    for (const r of src.rows) {
      if (r.type === "section") { if (++nSec <= MAX_SECTIONS) rows.push({ type: "section", title: r.title }); continue; }
      const it = pageItems[k++];
      rows.push({ type: "item", code: res.codes[it.key], seq: 0, name: it.name, unit: it.unit, price: round2(it.price), active: true });
    }
    return { code: pg.step_code, order: pi + 1, sheet: pg.sheet, page_no: pi + 1, title: pg.title || pg.sheet, subject: pg.subject, to: pg.to, dispense_unit: pg.dispense_unit, active: true, rows };
  });
  // carry every current code that is not in the file as a closed row (codes are never deleted), closed pages too
  const placed = new Set(steps.flatMap((s) => s.rows.filter((r) => r.type === "item").map((r) => r.code)));
  for (const cs of curSteps) {
    let target = steps.find((s) => s.code === cs.code);
    const leftovers = (cs.rows || []).filter((r) => r.type === "item" && !placed.has(r.code));
    if (!target) {
      target = { code: cs.code, order: 0, sheet: cs.sheet || "", page_no: null, title: cs.title || cs.code, subject: cs.subject || "", to: cs.to || "", dispense_unit: cs.dispense_unit || "พัสดุ", active: false, rows: [] };
      steps.push(target);
    }
    for (const r of leftovers) { target.rows.push({ type: "item", code: r.code, seq: 0, name: r.name, unit: r.unit, price: round2(r.price || 0), active: false }); placed.add(r.code); }
  }
  // numbering as the server does: order by array, page_no among active pages, seq global (active pages first)
  let page = 0, seq = 0;
  steps.forEach((s, i) => { s.order = i + 1; s.page_no = s.active ? ++page : null; });
  for (const pass of [true, false]) for (const s of steps) if (s.active === pass) for (const r of s.rows) if (r.type === "item") r.seq = ++seq;

  // plans[fy]: pcu -> code -> [op, pp] (only non-zero pairs)
  const planItems = (parsed.plan && parsed.plan.items) || [];
  const plans = {};
  for (const it of mapping.items) {
    if (it.plan_idx === null || it.plan_idx === undefined) continue;
    const pl = planItems[it.plan_idx];
    for (const [pc, [op, pp]] of Object.entries(pl.qty)) {
      if (!op && !pp) continue;
      (plans[pc] ||= {})[res.codes[it.key]] = [qty(op), qty(pp)];
    }
  }
  const seed = {
    format: IMPORT_FORMAT,
    fy,
    generated_at: new Date().toISOString(),
    generated_by: "admin import wizard (2e)",
    sources: sources || [],
    pcus: (pcus || []).map((p) => ({ code: p.code, name: p.name, print_name: p.print_name || p.name, group: p.group || "" })),
    form: { fy, note: `นำเข้าจากไฟล์ Excel ปีงบ ${fy}`, steps },
    plans: { [String(fy)]: plans }
  };
  const tot = parsed.plan && parsed.plan.totals;
  if (tot && tot.network) seed.config = { plan_total: { [String(fy)]: tot.network } };
  if (tot && tot.per_pcu) seed.verify = { [`plan_${fy}_per_pcu`]: tot.per_pcu };
  return seed;
}

// Σ plan qty × price per PCU (2 decimals) from an import JSON → {per_pcu:{pcu:{op,pp,total}}, network:{op,pp,total}}
export function planBaht(seed) {
  const price = {};
  for (const s of (seed.form && seed.form.steps) || []) for (const r of s.rows || []) if (r.type === "item") price[r.code] = Number(r.price) || 0;
  const per = {};
  let nop = 0, npp = 0;
  for (const [pc, items] of Object.entries((seed.plans || {})[String(seed.fy)] || {})) {
    let op = 0, pp = 0;
    for (const [c, v] of Object.entries(items)) { op += (Number(v[0]) || 0) * (price[c] || 0); pp += (Number(v[1]) || 0) * (price[c] || 0); }
    per[pc] = { op: round2(op), pp: round2(pp), total: round2(op + pp) };
    nop += op; npp += pp;
  }
  return { per_pcu: per, network: { op: round2(nop), pp: round2(npp), total: round2(nop + npp) } };
}

// ---- client-side validation of an uploaded import_<ปี>.json --------------------------------------------------------------------
// → {errors:[...], warnings:[...], items:n, allCoded:bool}
export function validateImportJson(obj, { pcus, fyExpected } = {}) {
  const errors = [], warnings = [];
  if (!isObj(obj)) return { errors: ["ไฟล์ต้องเป็น JSON object"], warnings, items: 0, allCoded: false };
  if (obj.format !== IMPORT_FORMAT) errors.push(`format ต้องเป็น "${IMPORT_FORMAT}" (พบ ${JSON.stringify(obj.format === undefined ? null : obj.format)})`);
  if (!Number.isInteger(obj.fy) || obj.fy < 2500 || obj.fy > 2700) errors.push("fy ต้องเป็นปีงบ พ.ศ. (จำนวนเต็ม เช่น 2571)");
  else if (fyExpected && obj.fy !== fyExpected) errors.push(`fy ในไฟล์ = ${obj.fy} แต่ปีงบที่จะเปิด = ${fyExpected}`);
  if (obj.pcus !== undefined) {
    if (!Array.isArray(obj.pcus)) errors.push("pcus ต้องเป็น array");
    else {
      obj.pcus.forEach((p, i) => { if (!isObj(p) || typeof p.code !== "string" || typeof p.name !== "string") errors.push(`pcus[${i}]: ต้องมี code และ name`); });
      const known = new Set((pcus || []).map((p) => p.code));
      const extra = obj.pcus.filter((p) => isObj(p) && known.size && !known.has(p.code)).map((p) => p.code);
      if (extra.length) warnings.push(`รพ.สต. ใหม่ในไฟล์ (จะถูกเพิ่ม): ${extra.join(", ")}`);
    }
  }
  let items = 0, allCoded = true;
  const codes = new Set();
  const f = obj.form;
  if (!isObj(f) || !Array.isArray(f.steps) || !f.steps.length) errors.push("ต้องมี form.steps อย่างน้อย 1 หน้า");
  else {
    let activeSteps = 0;
    const stepCodes = new Set();
    f.steps.forEach((s, i) => {
      if (!isObj(s)) { errors.push(`form.steps[${i}] ไม่ถูกต้อง`); return; }
      const label = `หน้า ${s.code || i + 1}`;
      if (typeof s.code !== "string" || !STEP_CODE_RE.test(s.code)) errors.push(`${label}: code ต้องเป็น A–Z/0–9 ไม่เกิน 6 ตัว`);
      else if (stepCodes.has(s.code)) errors.push(`รหัสหน้าซ้ำ: ${s.code}`);
      stepCodes.add(s.code);
      if (!cleanText(s.title)) errors.push(`${label}: ต้องมี title`);
      if (s.dispense_unit !== undefined && !DISPENSE_UNITS.includes(s.dispense_unit)) errors.push(`${label}: dispense_unit ต้องเป็น พัสดุ / จ่ายกลาง / LAB`);
      if (!Array.isArray(s.rows)) { errors.push(`${label}: ต้องมี rows`); return; }
      const stepActive = s.active !== false;
      if (stepActive) activeSteps++;
      let act = 0, sec = 0;
      s.rows.forEach((r, j) => {
        if (!isObj(r)) { errors.push(`${label} แถว ${j + 1} ไม่ถูกต้อง`); return; }
        if (r.type === "section") { if (!cleanText(r.title)) errors.push(`${label}: หัวหมวดต้องมี title`); if (++sec > MAX_SECTIONS) errors.push(`${label}: หัวหมวดเกิน ${MAX_SECTIONS} หัว`); return; }
        if (r.type !== "item") { errors.push(`${label} แถว ${j + 1}: type ต้องเป็น item หรือ section`); return; }
        items++;
        if (typeof r.code !== "string" || !r.code) allCoded = false;
        else if (!ITEM_CODE_RE.test(r.code)) errors.push(`${label}: รหัสรายการ "${r.code}" ไม่ถูกต้อง (รูปแบบ P1-01)`);
        else if (codes.has(r.code)) errors.push(`รหัสรายการซ้ำ: ${r.code}`);
        if (typeof r.code === "string") codes.add(r.code);
        if (!cleanText(r.name)) errors.push(`${label} รายการ ${r.code || j + 1}: ต้องมี name`);
        if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price < 0) errors.push(`${label} รายการ ${r.code || j + 1}: price ต้องเป็นตัวเลข ≥ 0`);
        if (r.active !== false) act++;
      });
      if (act > MAX_ACTIVE_ITEMS) errors.push(`${label}: รายการที่เปิดใช้เกิน ${MAX_ACTIVE_ITEMS} (${act})`);
      if (!stepActive && act) errors.push(`${label}: หน้าที่ปิด (active:false) ต้องไม่มีรายการที่เปิดใช้`);
    });
    if (activeSteps > MAX_ACTIVE_STEPS) errors.push(`หน้าที่เปิดใช้เกิน ${MAX_ACTIVE_STEPS} หน้า`);
    if (!activeSteps) errors.push("ต้องมีหน้าที่เปิดใช้อย่างน้อย 1 หน้า");
  }
  const pl = isObj(obj.plans) && Number.isInteger(obj.fy) ? obj.plans[String(obj.fy)] : undefined;
  if (!isObj(pl)) errors.push(`ต้องมี plans["${obj.fy}"] (แผนรายแห่ง × รายการ ของปีงบที่เปิด)`);
  else {
    const known = new Set([...(pcus || []).map((p) => p.code), ...((Array.isArray(obj.pcus) ? obj.pcus : []).map((p) => p && p.code))]);
    let bad = 0, unknownCode = new Set();
    for (const [pc, byItem] of Object.entries(pl)) {
      if (known.size && !known.has(pc)) warnings.push(`plans: ไม่รู้จัก รพ.สต. ${pc}`);
      if (!isObj(byItem)) { errors.push(`plans["${obj.fy}"].${pc} ต้องเป็น object`); continue; }
      for (const [c, v] of Object.entries(byItem)) {
        if (!Array.isArray(v) || v.length !== 2 || v.some((x) => typeof x !== "number" || !Number.isFinite(x) || x < 0)) bad++;
        if (codes.size && !codes.has(c) && !/^#\d+$/.test(c)) unknownCode.add(c);
      }
    }
    if (bad) errors.push(`plans: ${bad} ช่องไม่ใช่ [OP, PP] ตัวเลข ≥ 0`);
    if (unknownCode.size) errors.push(`plans อ้างรหัสที่ไม่มีในฟอร์ม: ${[...unknownCode].slice(0, 10).join(", ")}${unknownCode.size > 10 ? " …" : ""}`);
  }
  if (obj.limits !== undefined && !isObj(obj.limits)) errors.push("limits ต้องเป็น object");
  if (obj.config !== undefined && !isObj(obj.config)) errors.push("config ต้องเป็น object");
  return { errors, warnings, items, allCoded };
}

export { currentItems as currentItemsOf };

// ---- JSON path (import_<ปี>.json made by an AI or downloaded from step 3) ----------------------------------------------------------
// Active pages / active items of the JSON as a parsed-form structure (keeps each item's code when it has one).
export function jsonToParsed(obj) {
  const pages = obj.form.steps.filter((s) => s.active !== false).map((s) => ({
    sheet: s.sheet || s.code, title: s.title, subject: s.subject || "", to: s.to || "", code: s.code, dispense_unit: s.dispense_unit || null,
    rows: s.rows.filter((r) => r.type === "section" || r.active !== false).map((r) => (r.type === "section" ? { type: "section", title: r.title }
      : { type: "item", seq: r.seq || 0, name: r.name, unit: r.unit || "", price: r.price, code: typeof r.code === "string" && r.code ? r.code : null }))
  }));
  return { form: { pages, skipped: [], items: pages.reduce((n, p) => n + p.rows.filter((r) => r.type === "item").length, 0), warnings: [] }, plan: null };
}

// Step-2 mapping for a JSON whose items do not all carry a code: items with a code are fixed (kind "file"), the others get
// exact/fuzzy/new suggestions against the current form minus the codes the file already uses.
export function mapJsonItems(obj, currentForm) {
  const parsed = jsonToParsed(obj);
  const fileCodes = new Set(parsed.form.pages.flatMap((p) => p.rows.filter((r) => r.type === "item" && r.code).map((r) => r.code)));
  const reduced = { steps: ((currentForm && currentForm.steps) || []).map((s) => ({ ...s, rows: (s.rows || []).filter((r) => r.type !== "item" || !fileCodes.has(r.code)) })) };
  const mapping = mapItems(parsed, reduced);
  parsed.form.pages.forEach((p, i) => { mapping.pages[i].step_code = p.code; mapping.pages[i].step_how = "รหัสหน้าจากไฟล์"; if (p.dispense_unit) mapping.pages[i].dispense_unit = p.dispense_unit; });
  let k = 0;
  parsed.form.pages.forEach((p) => p.rows.forEach((r) => {
    if (r.type !== "item") return;
    const it = mapping.items[k++];
    it.step_code = p.code;
    it.price_src = "json";
    if (r.code) { it.suggestion = { code: r.code, kind: "file", sim: 1 }; it.choice = { code: r.code }; it.confirmed = true; it.fixed = true; }
  }));
  mapping.current = currentItems(currentForm);
  return { parsed, mapping };
}

// Applies the resolved codes of a JSON-path mapping to a copy of the JSON. Plans may reference an uncoded item as "#<seq>".
export function buildFromJson(obj, mapping) {
  const res = resolveMapping(mapping);
  const out = JSON.parse(JSON.stringify(obj));
  const warnings = [];
  const bySeq = {};
  let k = 0;
  for (const s of out.form.steps) {
    if (s.active === false) continue;
    for (const r of s.rows) {
      if (r.type !== "item" || r.active === false) continue;
      const it = mapping.items[k++];
      r.code = res.codes[it.key];
      if (r.seq !== undefined && r.seq !== null) bySeq["#" + r.seq] = r.code;
    }
  }
  const pl = out.plans && out.plans[String(out.fy)];
  if (isObj(pl)) {
    for (const [pc, items] of Object.entries(pl)) {
      if (!isObj(items)) continue;
      for (const key of Object.keys(items)) {
        if (!key.startsWith("#")) continue;
        if (bySeq[key]) items[bySeq[key]] = items[key]; else warnings.push(`plans ${pc}: ไม่พบรายการลำดับ ${key.slice(1)} — ข้าม`);
        delete items[key];
      }
    }
  }
  return { seed: out, warnings };
}
