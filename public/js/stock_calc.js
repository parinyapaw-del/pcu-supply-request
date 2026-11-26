// stock_calc.js — the client copy of the stock-mode B formula (2o; server: functions/_lib/stock.js computeLine). Pure, no DOM, so
// tools/test_api.mjs can check both give the same figures (2ak D5). คงเหลือ = ยกมา + ได้รับ + ปรับยอด − ใช้ไป.

export function availableOf(base, line) {
  return (Number(base.stock) || 0) + (Number(base.received) || 0) + (Number(line.adj) || 0);
}

// The derived field of a line from its driver (`calc_from`): { stock } (driver used) or { used } (driver stock).
// A negative result becomes null (Q14).
// 2av: ได้มาจริง of last round unknown while something was requested → the derived field is unknown (stock.js estimatedBase)
export const estimatedBase = (base) => !!base && base.received_src === "requested" && (Number(base.op) || 0) + (Number(base.pp) || 0) > 0;

export function deriveFields(base, line) {
  if (!base || !line.calc_from) return {};
  if (estimatedBase(base)) {
    if (line.calc_from === "used" && line.used != null) return { stock: null };
    if (line.calc_from === "stock" && line.stock != null) return { used: null };
    return {};
  }
  const avail = availableOf(base, line);
  const r2 = (n) => Math.round(n * 100) / 100; // 2ao: คงเหลือ / ใช้ไป may carry 2 decimals (server stock.js does the same)
  if (line.calc_from === "used" && line.used != null) {
    const v = r2(avail - Number(line.used));
    return { stock: v < 0 ? null : v };
  }
  if (line.calc_from === "stock" && line.stock != null) {
    const v = r2(avail - Number(line.stock));
    return { used: v < 0 ? null : v };
  }
  return {};
}
