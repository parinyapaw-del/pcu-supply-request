#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_seed_2570.py — phase 2 checkpoint C1 (phase 2.md §2.3, seed/FORMAT.md `pcu-supply-import/1`).

Reads (read-only):
  public/data/form2569.json                                   form structure (7 steps, 125 items, 15 PCUs)
  <project>/phase2_seed/item_map_2570.csv  (or --map PATH)     seq_70 → item_code (hand edits honored)
  <project>/2. ประมาณการเบิกวัสดุการแพทย์ ประจำปีงบ70.xls  sheet รวม      plan FY2570 + price_70 (+ unit_70)
  <project>/2. สถิติการเบิกวัสดุทางการแพทย์  ปี 2569.xls   15 PCU sheets  plan/price/actual FY2569
  <project>/phase15_seed/item_map_2568_2569.csv                old (2568-style) names used by the FY69 file
Writes:
  seed/seed_2570.json                       compact JSON, ensure_ascii=False
  <project>/phase2_seed/verify_report.txt   PASS / WARN / FAIL / INFO lines — exit 1 on any FAIL
  <project>/phase2_seed/item_map_2570_REVIEW.md   (re)writes the "ข้อที่ต้องตัดสินใจ" section at the end

Decisions (coordinator, 2026-10-06):
  - FY69 rows are matched to item codes by normalized NAME (form name, 2568 name, aliases below);
    position is only a fallback (WARN). Every sheet must resolve all 125 codes exactly once.
  - FY69 prices come from the stats file itself (they reproduce its "รวมเป็นเงิน" totals);
    differences vs form2569 are INFO.
  - verify.plan_2570_per_pcu = item-row sums; row-136 cells that disagree → WARN + verify.source_row136_discrepancies.
  - --units 2570 (default): form items take the plan-70 unit (price_70 is per that unit).
  - PACK_CHANGED items never use stat69 for limit_month (FY69 qty is in the old pack unit) → plan70 fallback.

Usage (from the repo):  python3 tools/build_seed_2570.py [--map path/to/item_map_2570.csv] [--units 2569|2570]
"""
import argparse, csv, json, math, random, re, sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import xlrd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_map_2570 import (REPO, PROJ, OUT, PLAN_XLS, MAP_CSV, REVIEW_MD, PLAN_TOTAL_ROW, PLAN_NET_COLS,  # noqa: E402
                            COLUMNS, load_form, load_plan70, norm, num)

FY = 2570
SEED_JSON = REPO / "seed" / "seed_2570.json"
REPORT = OUT / "verify_report.txt"
STAT_XLS = PROJ / "2. สถิติการเบิกวัสดุทางการแพทย์  ปี 2569.xls"
MAP_6869 = PROJ / "phase15_seed" / "item_map_2568_2569.csv"
MONTHS_2569 = [f"2025-{m:02d}" for m in (10, 11, 12)] + [f"2026-{m:02d}" for m in range(1, 10)]
DISPENSE_UNIT = {"CS": "จ่ายกลาง", "LAB": "LAB"}          # everything else (P1–P5) = พัสดุ
EXPECT_PLAN_NET = dict(op=1355995.02, pp=577581.85, total=1933576.87)   # phase 2.md §2.1
PACK_CHANGED = {"LAB-04", "LAB-21", "P2-05", "P4-07"}   # FY70 pack/unit ≠ FY69 → no stat69 monthly limit

# FY69 per-PCU sheet layout (same as the FY68 file)
S_ITEM_ROWS = range(8, 137)       # seq 1..125 in col 0, section rows in between
S_TOTAL_ROW = 137                 # "รวมเป็นเงิน" baht in cols 47..49
S_PRICE, S_PLAN_OP, S_PLAN_PP = 3, 4, 5
S_MON0 = 7                        # month m: OP 7+3m, PP 8+3m, รวม 9+3m (m = 0 → ต.ค. 68)
S_YEAR_QTY = (43, 44, 45)
S_BAHT = (47, 48, 49)
BUDGET = dict(budget_op=520000, budget_pp=390000, budget_total=910000)
# FY69 file name variants → item code (normalized with norm69)
FY69_ALIAS = {
    'TOP Gauze 8*10" (2 ชิ้น/ซอง) (ต้องโทรแจ้งก่อน 1 เดือน)': "P5-09",   # เทศบาลเมืองฯ sheet, same slot + price 40.45
}
REVIEW_MARK = "## ข้อที่ต้องตัดสินใจ"


def norm69(s):
    s = norm(s).replace("(ไม่อยู่ในรายการเบิก)", "")
    return s.replace("oxygen", "oxgen")


def r2(x):
    return round(x + 1e-9, 2) if x >= 0 else round(x - 1e-9, 2)


def q(x):
    """quantity: int if whole else float"""
    x = float(x)
    return int(round(x)) if abs(x - round(x)) < 1e-9 else round(x, 6)


def ceil_(x):
    return math.ceil(x - 1e-9)


def g(x):
    return f"{x:,.2f}".rstrip("0").rstrip(".") if isinstance(x, float) else f"{x:,}"


# ---------------------------------------------------------------- inputs
def load_map(path, f_items, p_items):
    rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    assert rows and list(rows[0].keys()) == COLUMNS, f"{path}: columns must be exactly {COLUMNS}"
    codes = [r["item_code"].strip() for r in rows]
    seqs = [int(r["seq_70"]) for r in rows]
    form_codes = {f["code"] for f in f_items}
    assert len(rows) == 125 and sorted(seqs) == list(range(1, 126)), "map: seq_70 must be 1..125 once each"
    assert len(set(codes)) == 125 and set(codes) == form_codes, \
        f"map is not a bijection onto form codes: dup={sorted({c for c in codes if codes.count(c) > 1})} " \
        f"missing={sorted(form_codes - set(codes))} unknown={sorted(set(codes) - form_codes)}"
    seq2code = {}
    for r in rows:
        p = p_items[int(r["seq_70"]) - 1]
        assert r["name_70"].strip() == p["name"].strip(), f"map seq {r['seq_70']}: name_70 differs from plan file"
        assert abs(float(r["price_70"]) - p["price"]) < 1e-9, f"map seq {r['seq_70']}: price_70 differs from plan file"
        seq2code[int(r["seq_70"])] = r["item_code"].strip()
    return seq2code, rows


def read_fy69(f_items, pcus):
    """Name-based row matching. → data{pc:{code:{...}}}, totals, network ref, warns, infos."""
    old_name = {r["item_code"]: r["name_2568"] for r in csv.DictReader(open(MAP_6869, encoding="utf-8-sig"))}
    lookup = {}
    for fi in f_items:
        for nm in (fi["name"], old_name.get(fi["code"], "")):
            if nm:
                k = norm69(nm)
                assert lookup.get(k, fi["code"]) == fi["code"], f"name key {nm!r} ambiguous"
                lookup[k] = fi["code"]
    for nm, code in FY69_ALIAS.items():
        lookup[norm69(nm)] = code
    form_name = {fi["code"]: fi["name"] for fi in f_items}
    wb = xlrd.open_workbook(str(STAT_XLS))
    out, totals, warns, infos, how = {}, {}, [], [], {}
    for p in pcus:
        sh = wb.sheet_by_name(p["name"])
        assert wb.sheet_names().index(p["name"]) >= 1
        assert str(sh.cell_value(S_TOTAL_ROW, 0)).strip() == "รวมเป็นเงิน", f"{p['name']}: total row moved"
        rows = [r for r in S_ITEM_ROWS if isinstance(sh.cell_value(r, 0), float)]
        assert [int(sh.cell_value(r, 0)) for r in rows] == list(range(1, 126)), f"{p['name']}: seq not 1..125"
        row_code = {}
        for i, r in enumerate(rows):
            nm = str(sh.cell_value(r, 1))
            code = lookup.get(norm69(nm))
            if code is None:
                code = f_items[i]["code"]
                warns.append(f"WARN FY69 {p['code']} {p['name']} row {r + 1}: name \"{nm.strip()}\" unmatched → position fallback {code}")
            elif code != f_items[i]["code"]:
                how.setdefault("moved", []).append(f"{p['name']} row {r + 1} \"{nm.strip()}\" → {code} (position slot {f_items[i]['code']})")
            if norm(nm) not in (norm(form_name[code]), norm(old_name.get(code, ""))):
                how.setdefault("alias", {}).setdefault((nm.strip(), code), []).append(p["name"])
            row_code[r] = code
        codes = list(row_code.values())
        dup = sorted({c for c in codes if codes.count(c) > 1})
        assert len(set(codes)) == 125 and not dup, f"{p['name']}: codes not resolved exactly once (dup {dup})"
        d = {}
        for r, code in row_code.items():
            op = [num(sh.cell_value(r, S_MON0 + 3 * m)) for m in range(12)]
            pp = [num(sh.cell_value(r, S_MON0 + 3 * m + 1)) for m in range(12)]
            for m in range(12):
                tot = num(sh.cell_value(r, S_MON0 + 3 * m + 2))
                if abs(op[m] + pp[m] - tot) > 1e-9:
                    infos.append(f"INFO FY69 cell {p['code']} {p['name']} {code} {MONTHS_2569[m]}: OP {q(op[m])} + PP {q(pp[m])} ≠ รวม {q(tot)} → used OP/PP (matches file totals)")
            for c in range(50, sh.ncols):
                v = sh.cell_value(r, c)
                if str(v).strip():
                    infos.append(f"INFO FY69 note {p['code']} {p['name']} {code}: \"{str(v).strip()}\" → kept file numbers")
            d[code] = dict(price=num(sh.cell_value(r, S_PRICE)),
                           plan=[num(sh.cell_value(r, S_PLAN_OP)), num(sh.cell_value(r, S_PLAN_PP))],
                           op=op, pp=pp, year_qty=[num(sh.cell_value(r, c)) for c in S_YEAR_QTY])
        out[p["code"]] = d
        totals[p["code"]] = [num(sh.cell_value(S_TOTAL_ROW, c)) for c in S_BAHT]
    s0, ref = wb.sheet_by_index(0), None
    for r in range(s0.nrows):
        for c in range(s0.ncols):
            if str(s0.cell_value(r, c)).strip() == "ยอดเงินตามที่เบิกจริง ปี 2569":
                ref = dict(op=num(s0.cell_value(r, 52)), pp=num(s0.cell_value(r, 53)), total=num(s0.cell_value(r, 54)))
    assert ref, "network reference cell not found on sheet 0"
    return out, totals, ref, warns, infos, how


# ---------------------------------------------------------------- build
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--map", default=str(MAP_CSV), help="item map CSV (default phase2_seed/item_map_2570.csv)")
    ap.add_argument("--units", choices=("2569", "2570"), default="2570",
                    help="unit shown on form items: 2570 = plan-70 unit (default, price_70 is per it) · 2569 = form2569 unit")
    args = ap.parse_args()

    form, f_items = load_form()
    pcus = form["pcus"]
    assert len(pcus) == 15
    pcode = [p["code"] for p in pcus]
    p_items, pcu_cols, ash = load_plan70()
    assert set(pcu_cols) == {p["name"] for p in pcus}, f"plan-70 PCU headers {sorted(pcu_cols)}"
    seq2code, map_rows = load_map(args.map, f_items, p_items)
    code2seq = {c: s for s, c in seq2code.items()}
    price70 = {c: p_items[s - 1]["price"] for s, c in seq2code.items()}
    unit70 = {c: p_items[s - 1]["unit"] for s, c in seq2code.items()}
    form_by_code = {f["code"]: f for f in f_items}

    fy69, tot69, ref69, warn69, info69, how69 = read_fy69(f_items, pcus)

    # FY69 prices from the stats file (must be identical across the 15 sheets)
    prices_prev, price_incons = {}, []
    for fi in f_items:
        vals = {fy69[pc][fi["code"]]["price"] for pc in pcode}
        if len(vals) > 1:
            price_incons.append((fi["code"], sorted(vals)))
        prices_prev[fi["code"]] = fy69[pcode[0]][fi["code"]]["price"]

    # form (form2569 verbatim + dispense_unit + active, price → price_70, unit per --units)
    steps = []
    for s in form["steps"]:
        st = {k: v for k, v in s.items() if k != "rows"}
        st["dispense_unit"] = DISPENSE_UNIT.get(s["code"], "พัสดุ")
        rows = []
        for r in s["rows"]:
            r = dict(r)
            if r["type"] == "item":
                if args.units == "2570":
                    r["unit"] = unit70[r["code"]]
                r["price"] = price70[r["code"]]
                r["active"] = True
            rows.append(r)
        st["rows"] = rows
        steps.append(st)
    note = "โครงฟอร์ม 2569 + ราคาตามแผนปี 70" + (" + หน่วยตามแผนปี 70" if args.units == "2570" else "")
    form70 = dict(fy=FY, note=note, steps=steps)

    # plans 2570 (sheet รวม) + per-PCU plan baht from item rows (+ per section, for row-136 diagnosis)
    plans70, plan_baht, sec_baht = {}, {}, {}
    name2code = {p["name"]: p["code"] for p in pcus}
    for nm, c0 in pcu_cols.items():
        pc = name2code[nm]
        bo = bp = 0.0
        for pi in p_items:
            op, pp = num(ash.cell_value(pi["row"], c0)), num(ash.cell_value(pi["row"], c0 + 1))
            code = seq2code[pi["seq"]]
            bo += op * pi["price"]; bp += pp * pi["price"]
            sb = sec_baht.setdefault((pc, pi["section"]), [0.0, 0.0])
            sb[0] += op * pi["price"]; sb[1] += pp * pi["price"]
            if op or pp:
                plans70.setdefault(pc, {})[code] = [q(op), q(pp)]
        plan_baht[pc] = [bo, bp, bo + bp]
    plan_row136 = {name2code[nm]: [num(ash.cell_value(PLAN_TOTAL_ROW, c0 + 3 + j)) for j in range(3)]
                   for nm, c0 in pcu_cols.items()}
    plan_net136 = [num(ash.cell_value(PLAN_TOTAL_ROW, c)) for c in PLAN_NET_COLS]
    sections = list(dict.fromkeys(pi["section"] for pi in p_items))
    discrepancies = []
    for pc in pcode:
        for j, col in enumerate(("op", "pp", "total")):
            diff = plan_baht[pc][j] - plan_row136[pc][j]
            if abs(diff) <= 0.01:
                continue
            omitted = None
            for a in range(len(sections)):          # contiguous run of sections whose sum = diff
                for b in range(a, len(sections)):
                    run = sum((sec_baht[(pc, sections[k])][0] if j == 0 else sec_baht[(pc, sections[k])][1] if j == 1
                               else sum(sec_baht[(pc, sections[k])])) for k in range(a, b + 1))
                    if omitted is None and abs(run - diff) <= 0.01:
                        omitted = sections[a:b + 1]
            discrepancies.append(dict(pcu=pc, col=col, row136=r2(plan_row136[pc][j]), items_sum=r2(plan_baht[pc][j]),
                                      diff=r2(diff), omitted_sections=omitted))

    # FY69: plans / actual / stats
    plans69, actual, stats, p90raw = {}, {}, {}, {}
    for pc in pcode:
        for code, d in fy69[pc].items():
            if any(d["plan"]):
                plans69.setdefault(pc, {})[code] = [q(x) for x in d["plan"]]
            if any(d["op"]) or any(d["pp"]):
                actual.setdefault(pc, {})[code] = dict(op=[q(x) for x in d["op"]], pp=[q(x) for x in d["pp"]])
            w = np.array([d["op"][m] + d["pp"][m] for m in range(12)], dtype=float)
            ann = float(w.sum())
            if ann > 0:
                med, p90 = float(np.median(w)), float(np.percentile(w, 90))   # numpy default = linear
                stats.setdefault(pc, {})[code] = [q(med), q(r2(p90)), q(ann)]
                p90raw[(pc, code)] = p90

    # limits 2570 (FORMAT.md / Q81) — PACK_CHANGED never uses stat69
    def limit_for(pc, code):
        pl = plans70.get(pc, {}).get(code)
        ly = (ceil_(pl[0] + pl[1]) or None) if pl else None
        p90 = 0.0 if code in PACK_CHANGED else p90raw.get((pc, code), 0.0)
        if p90 > 0:
            return [ceil_(p90), ly, "stat69"]
        if ly is not None:
            return [ceil_(ly / 12 * 2), ly, "plan70"]
        return None

    limits = {}
    for pc in pcode:
        for fi in f_items:
            v = limit_for(pc, fi["code"])
            if v:
                limits.setdefault(pc, {})[fi["code"]] = v

    verify = dict(
        plan_2570_per_pcu={pc: dict(op=r2(v[0]), pp=r2(v[1]), total=r2(v[2])) for pc, v in sorted(plan_baht.items())},
        actual_2569_per_pcu={pc: dict(op=r2(tot69[pc][0]), pp=r2(tot69[pc][1]), total=r2(tot69[pc][2])) for pc in pcode},
        actual_2569_network=dict(op=r2(ref69["op"]), pp=r2(ref69["pp"])),
        source_row136_discrepancies=discrepancies,
    )
    config = dict(fy_current=FY, limit_mode="warn", stock_required=0, **BUDGET, deadline_day=None,
                  plan_total={str(FY): dict(op=r2(plan_net136[0]), pp=r2(plan_net136[1]), total=r2(plan_net136[2]))})
    seed = {
        "format": "pcu-supply-import/1",
        "fy": FY,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_by": "tools/build_seed_2570.py",
        "sources": [PLAN_XLS.name + " (แผ่น รวม)", STAT_XLS.name + " (แผ่นราย รพ.สต. 15 แผ่น)",
                    "public/data/form2569.json", Path(args.map).name],
        "pcus": [dict(code=p["code"], name=p["name"], print_name=p["print_name"], group=p["group"]) for p in pcus],
        "form": form70,
        "plans": {str(FY): plans70, "2569": plans69},
        "prices_prev": {"2569": prices_prev},
        "actual_prev": {"2569": dict(months=MONTHS_2569, data=actual)},
        "stats": {"2569": stats},
        "limits": {str(FY): limits},
        "config": config,
        "verify": verify,
    }
    SEED_JSON.parent.mkdir(exist_ok=True)
    SEED_JSON.write_text(json.dumps(seed, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ------------------------------------------------------------ verification
    rep, ok = [], True

    def check(cond, msg):
        nonlocal ok
        ok &= bool(cond)
        rep.append(("PASS " if cond else "FAIL ") + msg)

    rep.append(f"verify_report — seed_2570.json ({seed['generated_at']}) · map {Path(args.map).name} · units {args.units}")
    # (a) network plan baht
    net = [sum(v[j] for v in plan_baht.values()) for j in range(3)]
    exp = [EXPECT_PLAN_NET["op"], EXPECT_PLAN_NET["pp"], EXPECT_PLAN_NET["total"]]
    check(all(abs(r2(a) - e) < 0.01 for a, e in zip(net, exp)) and all(abs(r2(a) - r2(b)) < 0.01 for a, b in zip(net, plan_net136)),
          f"(a) Σ plans.2570 qty×price_70 network OP {r2(net[0]):,.2f} / PP {r2(net[1]):,.2f} / total {r2(net[2]):,.2f} "
          f"(expect {exp[0]:,.2f} / {exp[1]:,.2f} / {exp[2]:,.2f}; = row 136 network cols)")
    # (b) per-PCU plan baht vs row 136
    unexplained = [d for d in discrepancies if not d["omitted_sections"]]
    n_ok = sum(1 for pc in pcode if not any(d["pcu"] == pc for d in discrepancies))
    check(not unexplained, f"(b) per-PCU plan-70 baht (item rows) = row 136 for {n_ok}/15 PCUs; "
                           f"unexplained differences: {unexplained or 'none'}")
    for d in discrepancies:
        if d["omitted_sections"]:
            rep.append(f"WARN (b) source-file formula error {d['pcu']} {d['col'].upper()}: row 136 {d['row136']:,.2f} vs item rows "
                       f"{d['items_sum']:,.2f} (diff {d['diff']:,.2f}) — row 136 omits section {' + '.join(d['omitted_sections'])} "
                       f"→ seed uses item-row sum")
    s136 = [sum(plan_row136[pc][j] for pc in pcode) for j in range(3)]
    rep.append(f"INFO Σ row-136 per-PCU cells OP {r2(s136[0]):,.2f} / PP {r2(s136[1]):,.2f} / total {r2(s136[2]):,.2f} "
               f"(network cell {plan_net136[2]:,.2f})")
    # (c) per-PCU FY69 actual baht + qty totals
    bad_b, bad_q, net69 = [], [], [0.0, 0.0]
    for pc in pcode:
        bo = sum(sum(d["op"]) * d["price"] for d in fy69[pc].values())
        bp = sum(sum(d["pp"]) * d["price"] for d in fy69[pc].values())
        net69[0] += bo; net69[1] += bp
        t = tot69[pc]
        if abs(bo - t[0]) > 0.01 or abs(bp - t[1]) > 0.01 or abs(bo + bp - t[2]) > 0.01:
            bad_b.append((pc, r2(bo), r2(bp), t))
        for code, d in fy69[pc].items():
            so, sp = sum(d["op"]), sum(d["pp"])
            yq = d["year_qty"]
            if abs(so - yq[0]) > 1e-9 or abs(sp - yq[1]) > 1e-9 or abs(so + sp - yq[2]) > 1e-9:
                bad_q.append((pc, code, so, sp, yq))
    check(not bad_b, f"(c) per-PCU FY69 actual baht (Σ qty×price_69 from file) = row 137 cols 47–49 for 15/15 PCUs {bad_b or ''}")
    check(not bad_q, f"(c) per-PCU × item FY69 qty Σ12 months = cols 43–45 (OP/PP/รวม) for 15×125 cells {bad_q[:5] or ''}")
    # (d) codes + bijection + FY69 name matching
    fcodes = [r["code"] for s in steps for r in s["rows"] if r["type"] == "item"]
    check(len(fcodes) == 125 and len(set(fcodes)) == 125 and set(fcodes) == set(code2seq),
          "(d) 125 item codes present in form, map seq_70 ↔ item_code bijective")
    check(all(len(fy69[pc]) == 125 for pc in pcode),
          f"(d) FY69: 15 sheets × 125 rows matched by name, every sheet resolves all 125 codes exactly once "
          f"(position fallback: {len(warn69)})")
    rep.extend(warn69)
    for line in how69.get("moved", []):
        rep.append(f"INFO FY69 row order differs, matched by name: {line}")
    for (nm, code), sheets in sorted(how69.get("alias", {}).items()):
        rep.append(f"INFO FY69 name variant matched: \"{nm}\" → {code} — "
                   f"{'all 15 sheets' if len(sheets) == 15 else ', '.join(sheets)}")
    check(not price_incons, f"(d) FY69 price identical across 15 sheets for all 125 codes {price_incons or ''}")
    for c, v in prices_prev.items():
        fp = float(form_by_code[c]["price"])
        if abs(v - fp) > 1e-9:
            rep.append(f"INFO FY69 price {c} {form_by_code[c]['name'].strip()}: stats file {v:g} vs form2569 {fp:g} → seed uses {v:g}")
    check(all(r["price"] > 0 for s in steps for r in s["rows"] if r["type"] == "item"), "(d) all 125 form prices (price_70) > 0")
    # (e) limits sanity
    cells = [(pc, c, v) for pc, d in limits.items() for c, v in d.items()]
    by_src = {s: sum(1 for *_, v in cells if v[2] == s) for s in ("stat69", "plan70")}
    zero = [(pc, c, v) for pc, c, v in cells if v[0] == 0 or v[1] == 0]
    check(not zero, f"(e) limits: {len(cells)} cells (stat69 {by_src['stat69']} / plan70 {by_src['plan70']}), "
                    f"no limit_month/limit_year == 0 {zero[:5] or ''}")
    check(not any(v[2] == "stat69" and c in PACK_CHANGED for _, c, v in cells),
          f"(e) PACK_CHANGED {sorted(PACK_CHANGED)} never use stat69 for limit_month")
    for c in sorted(PACK_CHANGED):
        fc = form_by_code[c]
        n_pl = sum(1 for pc in pcode if c in limits.get(pc, {}))
        n_st = sum(1 for pc in pcode if p90raw.get((pc, c), 0) > 0)
        rep.append(f"INFO PACK_CHANGED {c}: {fc['unit']} {float(fc['price']):g}฿ → {unit70[c]} {price70[c]:g}฿ · "
                   f"limit_month from plan70 for {n_pl} PCUs (stat69 p90>0 ignored for {n_st} PCUs; FY69 qty in old unit)")
    nolim_y = sum(1 for *_, v in cells if v[1] is None)
    rep.append(f"INFO limits with limit_year null (stat69 only, no plan 70): {nolim_y}")
    single = sum(1 for k, v in p90raw.items() if v <= 0)
    rep.append(f"INFO stats cells {sum(len(v) for v in stats.values())} (p90 = 0, withdrawn in only 1 month: {single} → plan70 rule)")
    rng = random.Random(FY)
    pick = sorted(cells, key=lambda t: (t[0], t[1]))
    spots = rng.sample(pick, 8) + [t for t in pick if t[1] in PACK_CHANGED][:2]
    bad_spot = []
    for pc, c, v in sorted(spots, key=lambda t: (t[0], t[1])):
        pl = plans70.get(pc, {}).get(c)
        ly = (ceil_(pl[0] + pl[1]) or None) if pl else None
        p90 = 0.0 if c in PACK_CHANGED else p90raw.get((pc, c), 0.0)
        want = [ceil_(p90), ly, "stat69"] if p90 > 0 else [ceil_(ly / 12 * 2), ly, "plan70"]
        if want != v:
            bad_spot.append((pc, c, v, want))
        rep.append(f"INFO   spot {pc} {c}: plan70 {pl} · stats69 [median,p90,annual] {stats.get(pc, {}).get(c)} → limit {v}")
    check(not bad_spot, f"(e) limits spot check {len(spots)} cells recomputed {bad_spot or ''}")
    # (f) INFO
    gap = [net69[0] - ref69["op"], net69[1] - ref69["pp"]]
    rep.append(f"INFO network FY69 Σ15 PCU sheets OP {r2(net69[0]):,.2f} / PP {r2(net69[1]):,.2f} / total {r2(sum(net69)):,.2f} "
               f"vs sheet 'ข้อมูลเบิกปีงบ 2569' {ref69['op']:,.2f} / {ref69['pp']:,.2f} → gap {r2(gap[0]):,.2f} / {r2(gap[1]):,.2f}"
               + (" (match)" if max(abs(x) for x in gap) <= 0.01 else " (MISMATCH)"))
    never = {pc: sum(1 for fi in f_items if fi["code"] not in actual.get(pc, {})) for pc in pcode}
    rep.append(f"INFO items never withdrawn in FY69 per PCU (of 125): {never}")
    zero69 = [c for c, v in prices_prev.items() if v == 0]
    if zero69:
        rep.append(f"INFO FY69 price = 0 (actual baht counts 0): {zero69}")
    rep.extend(info69)
    n_unit = sum(1 for r in map_rows if r["unit_70"].strip() != r["unit_2569"].strip())
    rep.append(f"INFO unit wording plan70 ≠ form2569 on {n_unit} items (list in item_map_2570_REVIEW.md) → form uses "
               f"{'plan-70' if args.units == '2570' else 'form-2569'} units")
    size = SEED_JSON.stat().st_size
    rep.append(f"INFO seed size: {size:,} bytes · plans70 cells {sum(len(v) for v in plans70.values())} · plans69 cells "
               f"{sum(len(v) for v in plans69.values())} · actual cells {sum(len(v) for v in actual.values())} · limits {len(cells)}")
    n_warn = sum(1 for x in rep if x.startswith("WARN"))
    rep.append(("ALL PASS" if ok else "SOME CHECKS FAILED") + f" · WARN {n_warn}")
    REPORT.write_text("\n".join(rep) + "\n", encoding="utf-8")
    print("\n".join(rep))

    write_review_decisions(map_rows, form_by_code, price70, unit70, plans70, fy69, pcode)
    sys.exit(0 if ok else 1)


def write_review_decisions(map_rows, form_by_code, price70, unit70, plans70, fy69, pcode):
    """(Re)write the trailing 'ข้อที่ต้องตัดสินใจ' section of item_map_2570_REVIEW.md."""
    if not REVIEW_MD.exists():
        return
    text = REVIEW_MD.read_text(encoding="utf-8")
    text = text.split("\n" + REVIEW_MARK)[0].rstrip("\n") + "\n"
    L = ["", REVIEW_MARK, "",
         "### 1) รายการที่เปลี่ยนขนาดบรรจุ/หน่วย (PACK_CHANGED) — เพดานรายเดือนใช้สูตรแผนปี 70 (ไม่ใช้ P90 ปี 69 เพราะหน่วยเก่า)", "",
         "| รหัส | ชื่อฟอร์ม 2569 | หน่วย/ราคา 69 → แผน 70 | ชื่อแผน 70 | แผน 70 (จำนวน) | แผน 69 / ใช้จริง 69 (หน่วยเก่า) |",
         "|---|---|---|---|---:|---:|"]
    by_code = {r["item_code"]: r for r in map_rows}
    for c in sorted(PACK_CHANGED):
        r = by_code[c]
        q70 = sum(sum(plans70.get(pc, {}).get(c, [0, 0])) for pc in pcode)
        p69 = sum(sum(fy69[pc][c]["plan"]) for pc in pcode)
        a69 = sum(sum(fy69[pc][c]["op"]) + sum(fy69[pc][c]["pp"]) for pc in pcode)
        L.append(f"| {c} | {r['name_2569']} | {r['unit_2569']} {float(r['price_2569']):g} ฿ → {r['unit_70']} {float(r['price_70']):g} ฿ | "
                 f"{r['name_70']} | {g(q70)} | {g(p69)} / {g(a69)} |")
    L += ["", "### 2) ราคาเปลี่ยนมาก (≥ ±40% หรือราคาปี 69 = 0; ไม่รวมข้อ 1)", "",
          "| รหัส | ชื่อฟอร์ม 2569 | ราคา 69 → 70 | เปลี่ยน | ข้อสังเกต |", "|---|---|---|---:|---|"]
    remarks = {"P4-09": "ขนาดเข็มในชื่อเปลี่ยน 25*1\" → 26*1\"", "P4-01": "1\" ถูกกว่า 1/2\" (7.94) — ตรวจราคา",
               "P5-09": "แผน 70 ชื่อ Top dressing — สินค้าเดียวกันหรือไม่", "P4-08": "ปี 69 ราคา 0 (ยอดเงินปี 69 นับ 0)"}
    for r in map_rows:
        c = r["item_code"]
        if c in PACK_CHANGED:
            continue
        p69, p70 = float(r["price_2569"]), float(r["price_70"])
        if p69 == 0 or abs(p70 / p69 - 1) >= 0.40:
            ch = "ใหม่" if p69 == 0 else f"{(p70 / p69 - 1) * 100:+.0f}%"
            L.append(f"| {c} | {r['name_2569']} | {p69:g} → {p70:g} | {ch} | {remarks.get(c, '')} |")
    L += ["", "### 3) หน่วยเขียนต่างกัน — ดูรายการ \"หน่วยต่างกัน\" ด้านบน "
          f"({sum(1 for r in map_rows if r['unit_70'] != r['unit_2569'])} รายการ) · seed ตั้งต้นใช้หน่วยตามแผนปี 70 (`--units 2570`)", ""]
    REVIEW_MD.write_text(text + "\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    main()
