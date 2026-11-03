// calc_common.js — helpers shared by the PCU dashboard (pages/dashboard_calc.js) and the admin dashboard (admin/dash_calc.js) (2ak D2).
// Pure, no DOM. V6 = [req_qty, req_baht, got_qty, got_baht, used_qty, used_baht].

export const UNIT_ORDER = ["พัสดุ", "จ่ายกลาง", "LAB"];
export const IDX = { qty: { req: 0, got: 2, used: 4 }, baht: { req: 1, got: 3, used: 5 } };

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const zeros = (n) => new Array(n).fill(0);

export function cumulative(arr) {
  let s = 0;
  return arr.map((v) => (s += v));
}

/** Sets o.share = o.req / Σ req on every entry of `out` (0 when nothing was requested). */
export function withShares(out) {
  const total = out.reduce((a, o) => a + o.req, 0);
  out.forEach((o) => { o.share = total > 0 ? o.req / total : 0; });
  return out;
}
