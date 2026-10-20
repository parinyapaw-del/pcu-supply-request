// price.js — 2p: a price is effective from a round (spec 2o-2s §4, brief 2p). functions/API.md §5.2 / §8.
// price_history(fy, item_code, from_round, price) — the price of item X in round R of fy F = the row of (F, X) with the newest from_round ≤ R;
// no such row → the price in the form (fallback). The form's price is the "latest price" (shown in the admin editor); every computation uses priceFor.
// CPU: one query per fy (loadPriceHistory), never one per line.
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

// The price of `code` in `round` (round must belong to the fy `hist` was loaded for): newest history row with from_round ≤ round,
// else the form price, else null.
export function priceFor(hist, form, code, round) {
  const arr = hist && hist.get(code);
  if (arr) {
    let p = null;
    for (const r of arr) {
      if (r.from_round <= round) p = r.price;
      else break;
    }
    if (p !== null) return p;
  }
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

// The end (exclusive) of the range a row at `from` governs: the next from_round of the item in `hist`, else the round after the fy's last.
export function rangeEnd(hist, code, from, fy) {
  const arr = (hist && hist.get(code)) || [];
  for (const r of arr) if (r.from_round > from) return r.from_round;
  return nextMonth(fyMonths(fy)[11]);
}

// Effect of back-dating prices (adminPricePreview = what adminFormSave will do). `changes` = [{code, price, from_round}] with from_round ≤ curRound (current-round sends included)
// (others are reported with zeros). Affected = lines of SENT (submitted/issued) requests with month in [from_round, rangeEnd) whose
// price_snapshot is set and differs from the new price and whose op+pp > 0 — exactly the money that moves. (adminFormSave rewrites
// price_snapshot of every line in the range; a qty-0 / unchanged line moves no money.)
// → { requests, months:[first,last]|[], delta_baht, per_code:[{code, n_lines, delta, old, from_round, to_round, requests}] }
export async function priceEffect(DB, fy, hist, form, changes, curRound) {
  const per = changes.map((c) => ({
    code: c.code, price: c.price, from_round: c.from_round,
    to_round: rangeEnd(hist, c.code, c.from_round, fy),
    old: priceFor(hist, form, c.code, c.from_round),
    back: c.from_round <= curRound,
    n_lines: 0, delta: 0, reqs: new Set(),
  }));
  const back = per.filter((x) => x.back);
  const allReq = new Set(), months = [];
  if (back.length) {
    const lo = back.reduce((a, x) => (x.from_round < a ? x.from_round : a), back[0].from_round);
    const hi = back.reduce((a, x) => (x.to_round > a ? x.to_round : a), back[0].to_round);
    const byCode = new Map(back.map((x) => [x.code, x]));
    const codes = [...byCode.keys()];
    for (let i = 0; i < codes.length; i += 90) {
      const part = codes.slice(i, i + 90);
      const { results } = await DB.prepare(
        `SELECT l.item_code, r.id, r.month, l.op, l.pp, l.price_snapshot FROM request_lines l JOIN requests r ON r.id = l.request_id
          WHERE r.status IN ('submitted','issued') AND r.month >= ? AND r.month < ? AND l.item_code IN (${part.map(() => "?").join(",")})
            AND l.price_snapshot IS NOT NULL AND (COALESCE(l.op,0) + COALESCE(l.pp,0)) > 0`
      ).bind(lo, hi, ...part).all();
      for (const l of results) {
        const x = byCode.get(l.item_code);
        if (!x || l.month < x.from_round || l.month >= x.to_round || l.price_snapshot === x.price) continue;
        x.n_lines++;
        x.delta += ((l.op || 0) + (l.pp || 0)) * (x.price - l.price_snapshot);
        x.reqs.add(l.id); allReq.add(l.id); months.push(l.month);
      }
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
      requests: x.reqs.size, backdate: x.back,
    })),
  };
}

// UPDATE statements that apply a back-date: price_snapshot of every line of `code` on a sent request in [from, to). price_print is never touched.
export function backdateStmts(DB, per) {
  return per.filter((x) => x.backdate).map((x) => DB.prepare(
    `UPDATE request_lines SET price_snapshot = ? WHERE item_code = ?
       AND request_id IN (SELECT id FROM requests WHERE status IN ('submitted','issued') AND month >= ? AND month < ?)`
  ).bind(x.price, x.code, x.from_round, x.to_round));
}
