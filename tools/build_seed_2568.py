#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_seed_2568.py — phase 1.5 seed data (phase 1.5.md §2).

Reads (read-only) the canonical FY2568 dataset produced by output/scripts/build_dataset.py
and data/form2569.json, and writes the seed OUTSIDE the public repo:

  <project>/phase15_seed/item_map_2568_2569.csv   2569 item_code ↔ 2568 item_key (§2.2)
  <project>/phase15_seed/seed_2568.json           actual / plan / simulated stock / limits / stats
  <project>/phase15_seed/verify_report.txt        acceptance checks §9 items 1–4

Usage:  python3 webapp/tools/build_seed_2568.py
"""
import csv, json, math, random, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PROJ = REPO.parent
DATA = PROJ / "output" / "data"
OUT = PROJ / "phase15_seed"
SEED = 2568_1_5

MONTHS = [f"2024-{m:02d}" for m in (10, 11, 12)] + [f"2025-{m:02d}" for m in range(1, 10)]
MON_COLS = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]

# 2568 item_key for each 2569 code that is NOT a straight sequential match (see alignment in §2.2)
MANUAL = {"P5-07": "110", "P5-08": "111", "CS-02": "109", "CS-03": "112"}
NEW_2569 = {"P5-09", "CS-01"}
EXCLUDED_KEYS = {"113"}          # TOP Gauze 8*10 — not in 2569 form; counted in admin baht totals only
RENAMED = {"P1-01", "P1-02", "P1-03", "P1-04", "P1-11", "P1-15", "P1-16", "P5-03", "P5-04", "P5-05", "P5-06", "P5-08"}

# simulated-stock scenarios (§2.3)
OVER_COEF = (0.50, 0.60)
REGULAR_MIN_MONTHS = 6          # stock flags only for items withdrawn in ≥ 6 of 12 months
SHORT_COEF = (1.10, 1.25)


def r2(x):
    return round(x + 1e-9, 2)


def load():
    form = json.loads((REPO / "data" / "form2569.json").read_text(encoding="utf-8"))
    f_items = [dict(r, step=s["code"]) for s in form["steps"] for r in s["rows"] if r["type"] == "item"]
    pcus = form["pcus"]
    items = list(csv.DictReader(open(DATA / "items.csv", encoding="utf-8-sig")))
    it68 = sorted([r for r in items if r["exists_2568"] == "True"], key=lambda r: int(r["seq_2568"]))
    piy = [r for r in csv.DictReader(open(DATA / "pcu_item_year.csv", encoding="utf-8-sig")) if r["year"] == "2568"]
    stats = [r for r in csv.DictReader(open(DATA / "pcu_item_stats.csv", encoding="utf-8-sig")) if r["basis"] == "2568"]
    return form, f_items, pcus, it68, piy, stats


def build_map(f_items, it68):
    by_key = {r["item_key"]: r for r in it68}
    seq_keys = [r["item_key"] for r in it68]
    rows, used = [], set()
    # straight sequential alignment holds for the first 98 items (P1-01 … P5-06)
    for i, fi in enumerate(f_items):
        code = fi["code"]
        if code in NEW_2569:
            key = None
        elif code in MANUAL:
            key = MANUAL[code]
        elif code.startswith("LAB-"):
            n = int(code.split("-")[1])
            lab_keys = [k for k in seq_keys if int(by_key[k]["seq_2568"]) >= 104]
            key = lab_keys[n - 1]
        else:
            key = seq_keys[i]
        if key is None:
            rows.append(dict(item_code=code, item_key_2568="", name_2568="", name_2569=fi["name"], unit_2569=fi["unit"],
                             price_2568="", price_2569=fi["price"], match_type="new_2569",
                             note="รายการใหม่ปี 2569 — ไม่มีข้อมูลปี 2568"))
            continue
        assert key not in used, f"duplicate key {key}"
        used.add(key)
        k = by_key[key]
        p68, p69 = float(k["price_2568"]), float(fi["price"])
        mt = "renamed" if code in RENAMED else "same"
        note = []
        if abs(p68 - p69) > 1e-9:
            note.append(f"ราคา {p68:g} → {p69:g}")
        rows.append(dict(item_code=code, item_key_2568=key, name_2568=k["name"], name_2569=fi["name"], unit_2569=fi["unit"],
                         price_2568=p68, price_2569=p69, match_type=mt, note="; ".join(note)))
    leftover = [k for k in seq_keys if k not in used]
    assert leftover == sorted(EXCLUDED_KEYS), f"unmapped 2568 keys: {leftover}"
    return rows, by_key


def main():
    form, f_items, pcus, it68, piy, stats = load()
    OUT.mkdir(exist_ok=True)
    mp, by_key = build_map(f_items, it68)
    with open(OUT / "item_map_2568_2569.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(mp[0].keys()))
        w.writeheader(); w.writerows(mp)
    key2code = {r["item_key_2568"]: r["item_code"] for r in mp if r["item_key_2568"]}
    row2key = {by_key[k]["row_2568"]: k for k in by_key}
    name2code = {p["name"]: p["code"] for p in pcus}

    actual, plan, extra = {}, {}, {}
    for r in piy:
        pc = name2code[r["pcu"]]
        key = row2key[str(int(float(r["row"])))]
        op = [float(r[f"op_{m}"] or 0) for m in MON_COLS]
        pp = [float(r[f"pp_{m}"] or 0) for m in MON_COLS]
        pl = [float(r["plan_op"] or 0), float(r["plan_pp"] or 0)]
        if key in EXCLUDED_KEYS:
            if any(op + pp):
                extra.setdefault(pc, {})[key] = dict(op=op, pp=pp)
            continue
        code = key2code[key]
        if any(op + pp):
            actual.setdefault(pc, {})[code] = dict(op=[int(x) if x == int(x) else x for x in op],
                                                   pp=[int(x) if x == int(x) else x for x in pp])
        if any(pl):
            plan.setdefault(pc, {})[code] = [int(x) if x == int(x) else x for x in pl]

    price68 = {r["item_code"]: r["price_2568"] for r in mp if r["item_key_2568"]}
    extra_items = {k: dict(name=by_key[k]["name"], unit=by_key[k]["unit_2568"], price_2568=float(by_key[k]["price_2568"]))
                   for k in EXCLUDED_KEYS}

    # ---------------- stats + limits (§2.4) ----------------
    stat, limits = {}, {}
    for r in stats:
        if r["item_key"] in EXCLUDED_KEYS or r["item_key"] not in key2code:
            continue
        pc, code = name2code[r["pcu"]], key2code[r["item_key"]]
        med, p90, ann = float(r["median_all"]), float(r["p90_all"]), float(r["annual_qty"])
        stat.setdefault(pc, {})[code] = [med, r2(p90), ann]
        lm, ly = math.ceil(p90 - 1e-9), math.ceil(ann - 1e-9)
        if lm > 0 or ly > 0:
            limits.setdefault(pc, {})[code] = [lm or None, ly or None]

    # ---------------- simulated stock (§2.3) ----------------
    rng = random.Random(SEED)
    general = [p["code"] for p in pcus if p["group"] == "ทั่วไป"]

    def active_items(pc, min_months):
        out = []
        for code, a in actual.get(pc, {}).items():
            w = [a["op"][i] + a["pp"][i] for i in range(12)]
            if sum(1 for x in w if x > 0) >= min_months:
                out.append((sum(w) * float(price68[code]), code))
        return [c for _, c in sorted(out, reverse=True)]

    ranked = sorted(general, key=lambda pc: -len(active_items(pc, 6)))
    over_pcus, short_pcus = ranked[0:2], ranked[2:4]
    scen = {}
    for pc in over_pcus:
        for code in active_items(pc, 6)[:7]:
            scen[(pc, code)] = "overstock"
    for pc in short_pcus:
        for code in active_items(pc, 6)[:4]:
            scen[(pc, code)] = "short"

    stock, usage = {}, {}
    for pc in [p["code"] for p in pcus]:
        for code, a in actual.get(pc, {}).items():
            w = [a["op"][i] + a["pp"][i] for i in range(12)]
            mean = sum(w) / 12
            kind = scen.get((pc, code), "normal")
            coef_lo, coef_hi = {"overstock": OVER_COEF, "short": SHORT_COEF}.get(kind, (1.0, 1.0))
            coef = rng.uniform(coef_lo, coef_hi)
            s = [0] * 12
            u = [0] * 12
            # usage tracks what the unit withdraws (avg of this and last month's withdrawal — units
            # reorder what they use); scenario coef scales it (overstock ~0.55, short ~1.15)
            s[0] = round(mean * rng.uniform(1.2, 2.0))
            for m in range(12):
                base = 0.5 * w[m] + 0.5 * (w[m - 1] if m > 0 else mean)
                want = round(base * coef * rng.uniform(0.85, 1.15))
                avail = s[m] + w[m]
                u[m] = min(want, avail)
                if m < 11:
                    s[m + 1] = int(avail - u[m])
            stock.setdefault(pc, {})[code] = [int(x) for x in s]
            usage.setdefault(pc, {})[code] = [int(x) for x in u]

    seed = dict(
        generated_by="webapp/tools/build_seed_2568.py", fiscal_year=2568, months=MONTHS,
        source="4. สถิติการเบิกวัสดุทางการแพทย์  ปี 2568.xlsx (via output/data/pcu_item_year.csv)",
        pcus=pcus, price_2568=price68, extra_items=extra_items,
        actual=actual, actual_extra=extra, plan=plan, stats=stat, limits=limits,
        stock_sim=stock,
        stock_scenarios=dict(overstock=over_pcus, short=short_pcus,
                             items={f"{pc}|{c}": k for (pc, c), k in scen.items()}),
        stock_note="[จำลอง] stock[m] = คงเหลือ ณ วันกรอกใบเดือน m; stock[m+1] = stock[m] + เบิก[m] − ใช้[m]",
    )
    (OUT / "seed_2568.json").write_text(json.dumps(seed, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "usage_sim_2568.json").write_text(json.dumps(usage, ensure_ascii=False), encoding="utf-8")

    # ---------------- verification (§9 items 1–4) ----------------
    rep = []
    ok = True

    def check(cond, msg):
        nonlocal ok
        ok &= bool(cond)
        rep.append(("PASS " if cond else "FAIL ") + msg)

    ns = json.loads((DATA / "network_summary.json").read_text(encoding="utf-8"))["actual"]["2568"]
    tot = dict(op=0.0, pp=0.0)
    per_pcu, per_pm = {}, {}
    for pc in [p["code"] for p in pcus]:
        rows = [(float(price68[c]), a) for c, a in actual.get(pc, {}).items()]
        rows += [(extra_items[k]["price_2568"], a) for k, a in extra.get(pc, {}).items()]
        for price, a in rows:
            for m in range(12):
                o, p_ = a["op"][m] * price, a["pp"][m] * price
                tot["op"] += o; tot["pp"] += p_
                per_pcu.setdefault(pc, [0.0, 0.0]); per_pcu[pc][0] += o; per_pcu[pc][1] += p_
                per_pm[(pc, m)] = per_pm.get((pc, m), 0.0) + o + p_
    check(abs(r2(tot["op"]) - ns["op"]) < 0.01 and abs(r2(tot["pp"]) - ns["pp"]) < 0.01,
          f"network 2568 incl key113: OP {r2(tot['op']):,.2f} PP {r2(tot['pp']):,.2f} total {r2(tot['op']+tot['pp']):,.2f} "
          f"(expect {ns['op']:,.2f} / {ns['pp']:,.2f} / {ns['total']:,.2f})")
    code2name = {p["code"]: p["name"] for p in pcus}
    py = {r["pcu"]: r for r in csv.DictReader(open(DATA / "pcu_year.csv", encoding="utf-8-sig")) if r["year"] == "2568"}
    bad = [pc for pc, (o, p_) in per_pcu.items()
           if abs(r2(o) - float(py[code2name[pc]]["op_baht"])) > 0.01 or abs(r2(p_) - float(py[code2name[pc]]["pp_baht"])) > 0.01]
    check(not bad, f"per-PCU totals match pcu_year.csv (15 PCUs) {bad or ''}")
    pm = [r for r in csv.DictReader(open(DATA / "pcu_month.csv", encoding="utf-8-sig")) if r["year"] == "2568"]
    name2c = {v: k for k, v in code2name.items()}
    badm = [(r["pcu"], r["m"]) for r in pm
            if abs(r2(per_pm.get((name2c[r["pcu"]], int(r["m"]) - 1), 0.0)) - float(r["total_baht"])) > 0.01]
    check(not badm and len(pm) == 180, f"PCU × month totals match pcu_month.csv (180 cells) {badm[:5] or ''}")
    k113 = sum(extra_items["113"]["price_2568"] * (sum(a["op"]) + sum(a["pp"])) for d in extra.values() for a in d.values())
    rep.append(f"INFO key 113 baht (excluded from form, included in totals): {k113:,.2f}")

    n_map = sum(1 for r in mp if r["item_key_2568"])
    check(len(mp) == 125 and n_map == 123 and {r["item_code"] for r in mp if not r["item_key_2568"]} == NEW_2569,
          f"map rows {len(mp)} = {n_map} mapped + {len(mp) - n_map} new ({sorted(NEW_2569)})")
    ren = [r for r in mp if r["match_type"] == "renamed"]
    rep.append(f"INFO renamed rows ({len(ren)}): " + " | ".join(f"{r['item_code']}←{r['item_key_2568']}" for r in ren))

    neg = 0; ident = 0
    for pc, d in stock.items():
        for code, s in d.items():
            a = actual[pc][code]; u = usage[pc][code]
            for m in range(12):
                neg += s[m] < 0
                if m < 11:
                    ident += s[m + 1] != s[m] + a["op"][m] + a["pp"][m] - u[m]
    check(neg == 0 and ident == 0, f"stock identity holds, no negatives (violations: neg={neg}, identity={ident})")

    def cover(pc, code, m):
        a = actual[pc][code]
        w = [a["op"][i] + a["pp"][i] for i in range(12)]
        prev = w[max(0, m - 3):m]
        avg = (sum(prev) / len(prev)) if prev and sum(prev) > 0 else sum(w) / 12
        return stock[pc][code][m] / avg if avg else None

    def regular(pc, c):
        a = actual[pc][c]
        return sum(1 for i in range(12) if a["op"][i] + a["pp"][i] > 0) >= REGULAR_MIN_MONTHS

    for kind in ("overstock", "short"):
        for pc in seed["stock_scenarios"][kind]:
            codes = [c for (p, c), k in scen.items() if p == pc and k == kind]
            flagged = 0
            for c in codes:
                if not regular(pc, c):
                    continue
                cv = [cover(pc, c, m) for m in range(6, 12)]
                wm = [actual[pc][c]["op"][m] + actual[pc][c]["pp"][m] for m in range(6, 12)]
                if kind == "overstock" and any(x is not None and x > 3 and wm[i] > 0 for i, x in enumerate(cv)):
                    flagged += 1
                if kind == "short" and any(x is not None and x < 0.5 for x in cv):
                    flagged += 1
            check(flagged >= max(1, len(codes) // 2),
                  f"scenario {kind} {pc} ({code2name[pc]}): {flagged}/{len(codes)} items flagged in Apr–Sep")
    # flags (§2.3) apply only to regular items (withdrawn in ≥ REGULAR_MIN_MONTHS of 12) — cover is
    # meaningless for lumpy/sporadic items. overstock = cover > 3 AND withdrawing that month; short = cover < 0.5
    normal_reg = [(pc, c) for pc in stock for c in stock[pc] if scen.get((pc, c)) is None and regular(pc, c)]
    rep.append(f"INFO regular items (≥{REGULAR_MIN_MONTHS} months): normal {len(normal_reg)} · scenario {sum(1 for k in scen)}")
    for m in (8, 9, 10, 11):
        no = sum(1 for pc, c in normal_reg if (cover(pc, c, m) or 0) > 3 and actual[pc][c]["op"][m] + actual[pc][c]["pp"][m] > 0)
        ns = sum(1 for pc, c in normal_reg if cover(pc, c, m) is not None and cover(pc, c, m) < 0.5)
        so = sum(1 for (pc, c), k in scen.items() if k == "overstock" and (cover(pc, c, m) or 0) > 3 and actual[pc][c]["op"][m] + actual[pc][c]["pp"][m] > 0)
        ss = sum(1 for (pc, c), k in scen.items() if k == "short" and cover(pc, c, m) is not None and cover(pc, c, m) < 0.5)
        check((no + ns) / len(normal_reg) < 0.20 and (so + ss) / len(scen) > 0.5,
              f"month idx {m}: normal regular items flagged over {no} / short {ns} of {len(normal_reg)} (< 20%) · scenario over {so}/14 short {ss}/8 (> 50%)")
    # per-PCU contrast in Aug 68 (what the admin sees): every scenario PCU has more flagged items than any normal PCU
    def flags_pcu(pc, m):
        n = 0
        for c in stock[pc]:
            if not regular(pc, c):
                continue
            cv = cover(pc, c, m)
            wm = actual[pc][c]["op"][m] + actual[pc][c]["pp"][m]
            n += (cv is not None and cv > 3 and wm > 0) or (cv is not None and cv < 0.5)
        return n
    scen_p = set(over_pcus + short_pcus)
    fs = {pc: flags_pcu(pc, 10) for pc in stock}
    check(min(fs[p] for p in scen_p) > max(v for p, v in fs.items() if p not in scen_p),
          f"Aug 68 flagged items per PCU — scenario {[(p, fs[p]) for p in sorted(scen_p)]} > normal max {max(v for p, v in fs.items() if p not in scen_p)}")

    # limits spot check (5 items × 3 PCUs)
    srow = {(r["pcu"], r["item_key"]): r for r in stats}
    rng2 = random.Random(7)
    samp_p = rng2.sample([p["code"] for p in pcus], 3)
    bad_l = []
    for pc in samp_p:
        codes = rng2.sample(sorted(stat[pc].keys()), 5)
        for c in codes:
            r = srow[(code2name[pc], [k for k, v in key2code.items() if v == c][0])]
            lm, ly = math.ceil(float(r["p90_all"]) - 1e-9), math.ceil(float(r["annual_qty"]) - 1e-9)
            got = limits.get(pc, {}).get(c, [None, None])
            if [lm or None, ly or None] != got:
                bad_l.append((pc, c, got, lm, ly))
            rep.append(f"INFO limit {pc} {c}: p90={r['p90_all']} annual={r['annual_qty']} → {got}")
    check(not bad_l, f"limits spot check 15 cells {bad_l or ''}")
    n_lim = sum(len(v) for v in limits.values())
    rep.append(f"INFO limit cells seeded: {n_lim} (PCU × item with P90 or annual > 0)")
    rep.append(f"INFO scenarios: overstock={[(p, code2name[p]) for p in over_pcus]} short={[(p, code2name[p]) for p in short_pcus]}")
    never = {pc: sum(1 for fi in f_items if fi["code"] not in NEW_2569 and fi["code"] not in actual.get(pc, {}))
             for pc in [p["code"] for p in pcus]}
    rep.append(f"INFO items never withdrawn in 2568 per PCU (excl. 2 new): {never}")
    rep.append(f"INFO seed size: {(OUT / 'seed_2568.json').stat().st_size:,} bytes")
    (OUT / "verify_report.txt").write_text("\n".join(rep) + "\n", encoding="utf-8")
    print("\n".join(rep))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
