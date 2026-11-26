// units.js — 2ao: request unit vs pieces, decimal คงเหลือ / ใช้ไป, and the "ยอดสูงผิดปกติ — หน่วยถูกไหม" checks. Pure, no DOM
// (used by pages/fill.js, the admin sheet and the dashboards; tools/test_api.mjs imports it).

// Pieces word that may follow a number in an item name: "(50 ชิ้น/กล่อง)", "(100แผ่น/ห่อ)", "8 ก้อน/แผง", "(10 test)".
const PIECE_WORDS = "ชิ้น|ใบ|แผ่น|ก้อน|test|เทส|อัน|คู่|ม้วน|ซอง|เส้น|ดวง|ขวด";
const RE_PER = new RegExp(`(\\d[\\d,]*)\\s*(${PIECE_WORDS})\\s*/\\s*([^\\s)/]+)`, "i");
const RE_TEST = /\((\d[\d,]*)\s*(test)\s*\)/i;

/** Pieces per request unit of `item`: {n, piece} or null. item.pack (set by the admin in the form editor) wins over the name. */
export function packOf(item) {
  if (!item) return null;
  const unit = String(item.unit || "").trim();
  const fromName = parsePack(item.name, unit);
  if (Number.isInteger(item.pack) && item.pack >= 1) return { n: item.pack, piece: (fromName && fromName.piece) || "ชิ้น", src: "admin" };
  return fromName ? { ...fromName, src: "name" } : null;
}

export function parsePack(name, unit) {
  const s = String(name || "");
  let m = s.match(RE_PER);
  let piece = null, n = 0;
  if (m) { n = Number(m[1].replace(/,/g, "")); piece = m[2]; if (unit && m[3] && !m[3].startsWith(unit) && !unit.startsWith(m[3])) m = null; }
  if (!m) {
    const t = s.match(RE_TEST);
    if (t) { n = Number(t[1].replace(/,/g, "")); piece = "test"; m = t; }
  }
  if (!m || !Number.isFinite(n) || n < 2 || piece === unit) return null; // "1 test/กล่อง" is the unit itself — nothing to convert
  return { n, piece };
}

export const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** คงเหลือ / ใช้ไป for display: whole numbers as before, otherwise up to 2 decimals ("0.4"). */
export function formatQty(v) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "≈ 40 ชิ้น" for a figure with a fraction of a unit (null when whole / no pack). */
export function piecesHint(v, pack) {
  if (v === null || v === undefined || !pack) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Number.isInteger(n)) return null;
  return `≈ ${Math.round(n * pack.n).toLocaleString("en-US")} ${pack.piece}`;
}

/** A value typed in pieces → the stored figure in request units (2 decimals). */
export const piecesToUnits = (pieces, pack) => (pieces === null ? null : round2(pieces / pack.n));
/** A stored figure → what the input shows in pieces mode (whole pieces). */
export const unitsToPieces = (v, pack) => (v === null || v === undefined ? null : Math.round(Number(v) * pack.n));

// ---- "ยอดขอสูงผิดปกติ" (Save 2ao): base = max(p90/month of this PCU last fy, the highest month it already sent this fy — the
// round being filled left out) · warn when op+pp > WARN_FACTOR × base · no base (new item, first request) → no warning.
export const WARN_FACTOR = 3;

export function qtyBase(hist, month) {
  if (!hist) return 0;
  const [p90, months] = hist;
  let base = Number(p90) || 0;
  for (const [m, q] of Object.entries(months || {})) if (m !== month && q > base) base = q;
  return base;
}

/** {base, factor} when `qty` requested in `month` looks unusually high for this PCU, else null. */
export function qtyWarn(hist, month, qty) {
  const q = Number(qty) || 0;
  const base = qtyBase(hist, month);
  if (q <= 0 || base <= 0 || q <= WARN_FACTOR * base) return null;
  return { base, factor: q / base };
}

/** ใช้ไป more than what there was (ยกมา + ได้รับ + ปรับ) — only when last round's คงเหลือ exists (Save: no คงเหลือ → no warning). */
export function usedWarn(base, line) {
  if (!base || base.stock === null || base.stock === undefined || line.used === null || line.used === undefined) return null;
  const avail = (Number(base.stock) || 0) + (Number(base.received) || 0) + (Number(line.adj) || 0);
  return Number(line.used) > avail ? { avail } : null;
}
