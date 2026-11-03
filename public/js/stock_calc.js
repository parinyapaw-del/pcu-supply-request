// stock_calc.js — the client copy of the stock-mode B formula (2o; server: functions/_lib/stock.js computeLine). Pure, no DOM, so
// tools/test_api.mjs can check both give the same figures (2ak D5). คงเหลือ = ยกมา + ได้รับ + ปรับยอด − ใช้ไป.

export function availableOf(base, line) {
  return (Number(base.stock) || 0) + (Number(base.received) || 0) + (Number(line.adj) || 0);
}

// The derived field of a line from its driver (`calc_from`): { stock } (driver used) or { used } (driver stock).
// A negative result becomes null (Q14).
export function deriveFields(base, line) {
  if (!base || !line.calc_from) return {};
  const avail = availableOf(base, line);
  if (line.calc_from === "used" && line.used != null) {
    const v = avail - Number(line.used);
    return { stock: v < 0 ? null : v };
  }
  if (line.calc_from === "stock" && line.stock != null) {
    const v = avail - Number(line.stock);
    return { used: v < 0 ? null : v };
  }
  return {};
}
