// price.js — 2z: ONE price per (fy, item) = the price in the latest form of the fy (brief 2z, reverses 2p's "effective from a round").
// functions/API.md §5.2 / §8. price_history(fy, item_code, from_round, price) is kept only as a log of who set which price when (admin editor
// tooltip); it no longer decides any price. Changing a price rewrites price_snapshot AND price_print of every sent line of the fy (priceEffect).
// Signatures of 2p (hist, round) are kept so the call sites stay unchanged.
import { insertStatements } from "./db.js";
import { fyMonths, nextMonth, nowIso } from "./time.js";

const round2 = (x) => Math.round(x * 100) / 100;

// Map code → [{from_round, price}] ascending, of one fiscal year (1 query).
export async function loadPriceHistory(DB, fy) {
  const { results } = await DB.prepare(`SELECT item_code, from_round, price FROM price_history WHERE fy = ? ORDER BY item_code, from_round`).bind(fy).all();
  const m = new Map();
  for (const r of results) {
    if (!m.has(r.item_code)) m.set(r.item_code, []);
    m.get(r.item_code).push({ from_round: r.from_round, price: Number(r.price) || 0 });
  }
  return m;
}

// Per-call memo: fy → Promise<history> (a request touching several fiscal years still runs one query per fy).
export function priceHistories(DB) {
  const cache = new Map();
  return (fy) => {
    if (!cache.has(fy)) cache.set(fy, loadPriceHistory(DB, fy));
    return cache.get(fy);
  };
}

// price of `code` in `form` (null when the form does not have it)
export function formPrice(form, code) {
  const ent = form && form.index && form.index.get(code);
  return ent ? Number(ent.item.price) || 0 : null;
}

// The price of `code` (2z: `hist` and `round` are ignored — the fy has one price, the one in its latest form; callers pass the latest form,
// or the line's bound form when the latest lacks the code). null when the form does not have it.
export function priceFor(hist, form, code, round) {
  return formPrice(form, code);
}

// {code: price} of every item of `form` in `round`.
export function pricesForRound(hist, form, round) {
  const out = {};
  if (form) for (const code of form.index.keys()) out[code] = priceFor(hist, form, code, round);
  return out;
}

// bootstrap `prices` (API.md §4.1 / §5.1): { round: {code: price} } — only the codes whose round price differs from the price in `form`
// (or in any of `alsoForms[round]`, the forms the client may show for that round). Every round in `rounds` is a key ({} = nothing differs).
export async function roundPriceOverrides(H, form, rounds, monthFy, alsoForms = {}) {
  const out = {};
  for (const m of rounds) {
    const hist = await H(monthFy(m));
    const o = {};
    if (form) {
      const others = (alsoForms[m] || []).filter((f) => f && f !== form);
      for (const code of form.index.keys()) {
        const p = priceFor(hist, form, code, m);
        if (p === null) continue;
        if (p !== formPrice(form, code) || others.some((f) => { const fp = formPrice(f, code); return fp !== null && fp !== p; })) o[code] = p;
      }
    }
    out[m] = o;
  }
  return out;
}

// INSERT OR IGNORE statements: one row per item of `steps` at the fy's first round (a newly opened fy / first form of an fy).
export function seedHistoryStmts(DB, fy, steps, by, note) {
  const first = fyMonths(fy)[0], ts = nowIso();
  const rows = [];
  for (const s of steps || []) for (const r of s.rows || []) {
    if (r.type === "item" && r.code) rows.push([fy, r.code, first, Number(r.price) || 0, by || "", ts, note || null]);
  }
  return insertStatements(DB, "price_history", ["fy", "item_code", "from_round", "price", "set_by", "set_at", "note"], rows, { prefix: "INSERT OR IGNORE INTO" });
}

// 2z: effect of new prices on the SENT (submitted/issued) requests of fy `fy` (adminPricePreview = what adminFormSave will write).
// `changes` = [{code, price}]. Written = every sent line of the code in the fy whose price_snapshot or price_print differs from the new price
// (only those rows are updated — D1 write quota). delta = Σ (op+pp) × (new − price_snapshot) over the written lines.
// `hist` / `curRound` are unused (kept from 2p's signature); `form` gives `old`.
// → { requests, months:[first,last]|[], delta_baht, per_code:[{code, n_lines, delta, old, price, requests, from_round, to_round, backdate}] }
export async function priceEffect(DB, fy, hist, form, changes, curRound) {
  const ms = fyMonths(fy), lo = ms[0], hi = nextMonth(ms[11]);
  const per = changes.map((c) => ({
    code: c.code, price: c.price, old: formPrice(form, c.code), from_round: lo, to_round: hi, backdate: true,
    n_lines: 0, delta: 0, reqs: new Set(),
  }));
  const byCode = new Map(per.map((x) => [x.code, x]));
  const allReq = new Set(), months = [];
  const codes = [...byCode.keys()];
  for (let i = 0; i < codes.length; i += 90) {
    const part = codes.slice(i, i + 90);
    const { results } = await DB.prepare(
      `SELECT l.item_code, r.id, r.month, l.op, l.pp, l.price_snapshot, l.price_print FROM request_lines l JOIN requests r ON r.id = l.request_id
        WHERE r.status IN ('submitted','issued') AND r.month >= ? AND r.month < ? AND l.item_code IN (${part.map(() => "?").join(",")})`
    ).bind(lo, hi, ...part).all();
    for (const l of results) {
      const x = byCode.get(l.item_code);
      if (!x || (l.price_snapshot === x.price && l.price_print === x.price)) continue;
      x.n_lines++;
      if (l.price_snapshot !== null && l.price_snapshot !== undefined) x.delta += ((l.op || 0) + (l.pp || 0)) * (x.price - l.price_snapshot);
      x.reqs.add(l.id); allReq.add(l.id); months.push(l.month);
    }
  }
  months.sort();
  const total = per.reduce((a, x) => a + x.delta, 0);
  return {
    requests: allReq.size,
    months: months.length ? [months[0], months[months.length - 1]] : [],
    delta_baht: round2(total),
    per_code: per.map((x) => ({
      code: x.code, n_lines: x.n_lines, delta: round2(x.delta), old: x.old, price: x.price, from_round: x.from_round, to_round: x.to_round,
      requests: x.reqs.size, backdate: x.n_lines > 0,
    })),
  };
}

// UPDATE statements that apply priceEffect: price_snapshot AND price_print of every sent line of `code` in [from, to) that differs (2z).
export function backdateStmts(DB, per) {
  return per.filter((x) => x.backdate).map((x) => DB.prepare(
    `UPDATE request_lines SET price_snapshot = ?, price_print = ? WHERE item_code = ?
       AND (price_snapshot IS NOT ? OR price_print IS NOT ?)
       AND request_id IN (SELECT id FROM requests WHERE status IN ('submitted','issued') AND month >= ? AND month < ?)`
  ).bind(x.price, x.price, x.code, x.price, x.price, x.from_round, x.to_round));
}
