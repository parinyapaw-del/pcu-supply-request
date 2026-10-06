#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_map_2570.py — phase 2 checkpoint C1 (phase 2.md §2.2).

Maps the 125 items of the FY2570 plan file (new names/sections) onto the 125 item codes of
public/data/form2569.json and writes, OUTSIDE the repo:

  <project>/phase2_seed/item_map_2570.csv         seq_70 → item_code (exact | fuzzy | manual)
  <project>/phase2_seed/item_map_2570_REVIEW.md   fuzzy + manual rows only, for Save to confirm

Matching: normalize (drop whitespace + quotes, lowercase, unify x/*/×) → exact against the form
name · otherwise the 12 known hard cases are hard-coded (MANUAL) · the rest are fuzzy: candidates
restricted to the same region (office / non-drug medical / central supply / LAB / test kits),
scored by difflib similarity + unit match + relative position, assigned greedily best-first.
Asserts a 125 ↔ 125 bijection.

Usage (from the repo):  python3 tools/build_map_2570.py
"""
import csv, difflib, json, re, sys
from pathlib import Path

import xlrd

REPO = Path(__file__).resolve().parents[1]
PROJ = REPO.parent
OUT = PROJ / "phase2_seed"
FORM = REPO / "public" / "data" / "form2569.json"
PLAN_XLS = PROJ / "2. ประมาณการเบิกวัสดุการแพทย์ ประจำปีงบ70.xls"
MAP_CSV = OUT / "item_map_2570.csv"
REVIEW_MD = OUT / "item_map_2570_REVIEW.md"
COLUMNS = ["seq_70", "name_70", "unit_70", "price_70", "item_code", "name_2569", "unit_2569", "price_2569",
           "match", "confidence", "note"]

# plan-70 sheet "รวม" layout
PLAN_SHEET = "รวม"
PLAN_ITEM_ROWS = range(5, 136)        # rows 5..135 (section headers have empty seq)
PLAN_TOTAL_ROW = 136                  # "รวมเป็นเงิน"
PLAN_PCU_COL0, PLAN_PCU_W = 4, 6      # 15 blocks × (OP, PP, รวม, ฿OP, ฿PP, ฿รวม)
PLAN_NET_COLS = (97, 98, 99)          # network baht OP / PP / รวม on the total row
# file column header → PCU name in form2569.json (file order has เทศบาลฯ before เรือนจำ)
PLAN_PCU_ALIAS = {"ศูนย์ฯเทศบาลเมืองอ่างทอง": "เทศบาลเมืองฯ", "เรือนจำจังหวัดอ่างทอง": "เรือนจำ"}

# plan-70 section header → region; form regions are derived from step/section (see form_region)
PLAN_SECTION_REGION = {
    "คลังวัสดุงานบ้านงานครัวและสำนักงาน": "office",
    "คลังเวชภัณฑ์ที่มิใช่ยา (พัสดุ)": "medical",
    "เบิกหน่วยจ่ายกลาง": "cs",
    "เบิกห้อง LAB": "lab",
    "ชุดทดสอบสารปนเปื้อน": "labkit",
}

# the 12 known hard cases (phase 2.md §2.2): seq_70 → (item_code, expected name_70 fragment, note)
MANUAL = {
    1: ("P1-01", "ถุงดำ ( 13 x 21", "ชื่อใหม่ ถุงดำ = ถุงใส่ขยะสีดำ 13x21"),
    2: ("P1-02", "ถุงดำ  ( 16 x 28", "ชื่อใหม่ ถุงดำ = ถุงใส่ขยะสีดำ 16x28"),
    3: ("P1-03", "ถุงแดง ( 13 x 21", "ชื่อใหม่ ถุงแดง = ถุงใส่ขยะสีแดง 13x21"),
    4: ("P1-04", "ถุงแดง ( 16 x 28", "ชื่อใหม่ ถุงแดง = ถุงใส่ขยะสีแดง 16x28"),
    51: ("P5-07", "Gauze 3*4\" sterile", "Gauze sterile 8 ชั้น 5 ชิ้น = ก๊อส 5 แผ่น (หัตถการ)"),
    52: ("P5-02", "Gauze drain 5\"", "Gauze drain 5\" sterile = Gauze drain 5\" (โทรแจ้งก่อน)"),
    59: ("P1-17", "K-Y Gel", "K-Y Gel (สารหล่อลื่นสูตรน้ำ) = K-Y Gel"),
    82: ("P5-09", "Top dressing 11*12", "Top dressing 11*12\" = TOP Gauze 11*12\" (2 ชิ้น/ซอง)"),
    89: ("P5-04", "ถุงมือ Sterile (Exam)", "ถุงมือ Sterile (Exam) ไม่มีแป้ง XS = ถุงมือ sterile XS"),
    90: ("P5-05", "ถุงมือ Sterile (Exam)", "ถุงมือ Sterile (Exam) ไม่มีแป้ง S = ถุงมือ sterile S"),
    91: ("P5-06", "ถุงมือ Sterile (Exam)", "ถุงมือ Sterile (Exam) ไม่มีแป้ง M = ถุงมือ sterile M"),
    96: ("P5-01", "สำลีพันก้านไม้", "สำลีพันก้านไม้ sterile 2 ก้าน = ไม้พันสำลี 2 ก้าน"),
}
FUZZY_MIN = 0.55      # a fuzzy pair below this → stop (add it to MANUAL after a human look)


def norm(s):
    """§2.2 normalize: drop whitespace + quotes, lowercase, unify ×/x/* (x only between digits)."""
    s = str(s).lower().replace("×", "*")
    s = re.sub(r"[\s\"'“”″]+", "", s)
    s = re.sub(r"(?<=\d)x(?=\d)", "*", s)
    return s


def loose(s):
    """extra folding used only for fuzzy similarity (not for 'exact')."""
    s = norm(s)
    for a, b in (("syringes", "syringe"), ("disposable", "dispos"), ("-", ""), ("(", ""), (")", ""),
                 ("/", ""), (".", ""), (",", "")):
        s = s.replace(a, b)
    return s


def unit_norm(u):
    return str(u).strip()


def num(v):
    return float(v) if v not in ("", None) else 0.0


def fmt_price(p):
    return f"{p:g}"


def load_form():
    form = json.loads(FORM.read_text(encoding="utf-8"))
    items = []
    for s in form["steps"]:
        section = None
        for r in s["rows"]:
            if r["type"] == "section":
                section = r["title"]
                continue
            items.append(dict(r, step=s["code"], section=section))
    assert len(items) == 125, len(items)
    return form, items


def form_region(it):
    if it["step"] == "CS":
        return "cs"
    if it["step"] == "LAB":
        return "labkit" if it["section"] == "ชุดทดสอบสารปนเปื้อน" else "lab"
    return "office" if it["section"] == "วัสดุสำนักงาน" else "medical"


def load_plan70(path=PLAN_XLS):
    """→ (items[125], pcu_cols{form pcu name: col0}, total_row_values) from sheet รวม."""
    sh = xlrd.open_workbook(str(path)).sheet_by_name(PLAN_SHEET)
    items, region, section = [], None, None
    for r in PLAN_ITEM_ROWS:
        seq, name = sh.cell_value(r, 0), sh.cell_value(r, 1)
        if seq == "":
            if str(name).strip():
                section = str(name).strip()
                region = PLAN_SECTION_REGION.get(section, region)
            continue
        items.append(dict(seq=int(seq), name=str(name), unit=unit_norm(sh.cell_value(r, 2)),
                          price=float(sh.cell_value(r, 3)), row=r, region=region, section=section))
    assert [i["seq"] for i in items] == list(range(1, 126)), "plan-70 seq is not 1..125"
    assert all(i["price"] > 0 for i in items), "plan-70 price ≤ 0"
    assert all(i["region"] for i in items)
    pcu_cols = {}
    for k in range(15):
        c = PLAN_PCU_COL0 + k * PLAN_PCU_W
        nm = str(sh.cell_value(3, c)).strip()
        assert [str(sh.cell_value(4, c + j)).strip() for j in range(3)] == ["OP", "PP", "รวม"], f"bad header at col {c}"
        pcu_cols[PLAN_PCU_ALIAS.get(nm, nm)] = c
    assert str(sh.cell_value(PLAN_TOTAL_ROW, PLAN_PCU_COL0)).strip() == "รวมเป็นเงิน"
    return items, pcu_cols, sh


def build():
    _, f_items = load_form()
    p_items, _, _ = load_plan70()
    by_code = {f["code"]: f for f in f_items}
    for f in f_items:
        f["region"] = form_region(f)
    reg_codes = {}
    for f in f_items:
        reg_codes.setdefault(f["region"], []).append(f["code"])
    reg_seqs = {}
    for p in p_items:
        reg_seqs.setdefault(p["region"], []).append(p["seq"])

    assign = {}   # seq → (code, match, confidence, note)
    # 1) exact on normalized name
    fnorm = {}
    for f in f_items:
        fnorm.setdefault(norm(f["name"]), []).append(f["code"])
    for p in p_items:
        hits = fnorm.get(norm(p["name"]), [])
        if len(hits) == 1:
            assign[p["seq"]] = (hits[0], "exact", 1.0, "")
    # 2) manual
    for seq, (code, frag, note) in MANUAL.items():
        p = p_items[seq - 1]
        assert frag in p["name"], f"MANUAL seq {seq}: '{frag}' not in '{p['name']}' — plan file changed?"
        assert seq not in assign, f"MANUAL seq {seq} already exact"
        assign[seq] = (code, "manual", "", note)
    # 3) fuzzy: greedy best-first within region
    used = {a[0] for a in assign.values()}
    assert len(used) == len(assign), "duplicate code among exact/manual"
    cand = []
    for p in p_items:
        if p["seq"] in assign:
            continue
        rs = reg_seqs[p["region"]]
        ppos = rs.index(p["seq"]) / max(1, len(rs) - 1)
        for code in reg_codes.get(p["region"], []):
            if code in used:
                continue
            f = by_code[code]
            rc = reg_codes[p["region"]]
            fpos = rc.index(code) / max(1, len(rc) - 1)
            sim = max(difflib.SequenceMatcher(None, norm(p["name"]), norm(f["name"])).ratio(),
                      difflib.SequenceMatcher(None, loose(p["name"]), loose(f["name"])).ratio())
            score = 0.80 * sim + 0.10 * (unit_norm(p["unit"]) == unit_norm(f["unit"])) + 0.10 * (1 - abs(ppos - fpos))
            cand.append((score, sim, p["seq"], code))
    cand.sort(key=lambda t: (-t[0], t[2], t[3]))
    for score, sim, seq, code in cand:
        if seq in assign or code in used:
            continue
        assign[seq] = (code, "fuzzy", round(score, 2), f"sim {sim:.2f}")
        used.add(code)
    missing = [p["seq"] for p in p_items if p["seq"] not in assign]
    assert not missing, f"unmatched plan-70 seq: {missing}"
    low = [(s, a) for s, a in assign.items() if a[1] == "fuzzy" and a[2] < FUZZY_MIN]
    assert not low, f"fuzzy pairs below {FUZZY_MIN} — review and move to MANUAL: {low}"

    rows = []
    for p in p_items:
        code, match, conf, note = assign[p["seq"]]
        f = by_code[code]
        notes = [note] if note else []
        if abs(p["price"] - float(f["price"])) > 1e-9:
            notes.append(f"ราคา {fmt_price(float(f['price']))} → {fmt_price(p['price'])}")
        if unit_norm(p["unit"]) != unit_norm(f["unit"]):
            notes.append(f"หน่วย {unit_norm(f['unit'])} → {unit_norm(p['unit'])}")
        rows.append(dict(seq_70=p["seq"], name_70=p["name"].strip(), unit_70=p["unit"], price_70=p["price"],
                         item_code=code, name_2569=f["name"].strip(), unit_2569=unit_norm(f["unit"]),
                         price_2569=float(f["price"]), match=match,
                         confidence=("" if conf == "" else conf), note="; ".join(notes)))
    codes = [r["item_code"] for r in rows]
    assert len(rows) == 125 and len(set(codes)) == 125 and set(codes) == set(by_code), "map is not a 125↔125 bijection"
    return rows


def write(rows):
    OUT.mkdir(exist_ok=True)
    with open(MAP_CSV, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    n = {k: sum(1 for r in rows if r["match"] == k) for k in ("exact", "fuzzy", "manual")}
    esc = lambda s: str(s).replace("|", "\\|")
    md = ["# ตรวจ map รายการ แผนปี 70 → รหัสฟอร์ม 2569 (เฉพาะแถว fuzzy + manual)", "",
          f"สร้างโดย `webapp/tools/build_map_2570.py` · ไฟล์เต็ม `phase2_seed/item_map_2570.csv` (125 แถว)", "",
          f"**exact {n['exact']} / fuzzy {n['fuzzy']} / manual {n['manual']}** — รวม {len(rows)} · bijection 125↔125 ✓", "",
          "ถ้าแถวไหนผิด แก้คอลัมน์ `item_code` ใน CSV ได้เลย (seed อ่าน CSV นี้) แล้วตอบ \"map ok\"", "",
          "| seq_70 | ชื่อแผน 70 | หน่วย/ราคา 70 | → รหัส | ชื่อฟอร์ม 2569 | หน่วย/ราคา 69 | match/conf | หมายเหตุ |",
          "|---:|---|---|---|---|---|---|---|"]
    for r in rows:
        if r["match"] == "exact":
            continue
        md.append(f"| {r['seq_70']} | {esc(r['name_70'])} | {r['unit_70']} / {fmt_price(r['price_70'])} | {r['item_code']} | "
                  f"{esc(r['name_2569'])} | {r['unit_2569']} / {fmt_price(r['price_2569'])} | "
                  f"{r['match']}{'/' + str(r['confidence']) if r['confidence'] != '' else ''} | {esc(r['note'])} |")
    md += ["", "หน่วยต่างกัน (ทุกแถว รวม exact) — ฟอร์มปี 70 ใช้หน่วยตามฟอร์ม 2569 แต่ราคาตามแผน 70:", ""]
    for r in rows:
        if r["unit_70"] != r["unit_2569"]:
            md.append(f"- {r['item_code']} ({r['match']}) {r['name_2569']}: {r['unit_2569']} {fmt_price(r['price_2569'])} ฿ → "
                      f"{r['unit_70']} {fmt_price(r['price_70'])} ฿")
    REVIEW_MD.write_text("\n".join(md) + "\n", encoding="utf-8")
    return n


def main():
    rows = build()
    n = write(rows)
    print(f"item_map_2570.csv: exact {n['exact']} / fuzzy {n['fuzzy']} / manual {n['manual']} → {MAP_CSV}")
    for r in rows:
        if r["match"] != "exact":
            print(f"  {r['seq_70']:>3} {r['match']:6} {str(r['confidence']):5} {r['item_code']:7} {r['name_70']}  ⇒  {r['name_2569']}  [{r['note']}]")


if __name__ == "__main__":
    main()
