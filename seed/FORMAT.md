# Import / seed JSON — `pcu-supply-import/1`
ล็อก 2026-10-06 (phase 2 §2.3, §5.10) · ไฟล์เดียวใช้ทั้ง `seed/seed_2570.json` (seed ปี 70 ด้วยมือ) และ `import_<ปี>.json`
(2e อัปโหลดผ่านหน้า admin) · backend นำเข้าแบบ **idempotent** (§ด้านล่าง) · ห้ามแก้รูปแบบโดยไม่อัปเดตไฟล์นี้ + `functions/API.md`

## โครง
```jsonc
{
  "format": "pcu-supply-import/1",
  "fy": 2570,                                   // ปีงบที่ไฟล์นี้เปิด (พ.ศ.)
  "generated_at": "2026-10-06T08:00:00Z", "generated_by": "tools/build_seed_2570.py", "sources": ["..."],
  "pcus": [ { "code":"PCU01", "name":"มหาดไทย", "print_name":"มหาดไทย", "group":"ทั่วไป" } ],      // 15 แห่ง
  "form": {                                     // form version แรกของปีงบนี้ (โครงเดียวกับ data/form2569.json + dispense_unit/active)
    "fy": 2570, "note": "โครงฟอร์ม 2569 + ราคาตามแผนปี 70",
    "steps": [ { "code":"P1", "order":1, "sheet":"แบบ พัสดุ 1", "page_no":1,
                 "title":"ใบเบิกวัสดุสำนักงานและวัสดุการแพทย์", "subject":"...", "to":"ผู้อำนวยการโรงพยาบาลอ่างทอง",
                 "dispense_unit": "พัสดุ",       // "พัสดุ" | "จ่ายกลาง" | "LAB"   (P1–P5 = พัสดุ, CS = จ่ายกลาง, LAB = LAB)
                 "active": true,                 // (2d, optional, default true) false = หน้าที่ปิดแล้ว (soft delete — ไม่ลบหน้า) · PCU ไม่เห็น · ปิดได้เมื่อไม่มีรายการ active เหลือในหน้า
                 "rows": [ { "type":"section", "title":"วัสดุสำนักงาน" },
                           { "type":"item", "code":"P1-01", "seq":1, "name":"...", "unit":"ห่อ", "price":34.0, "active":true } ] } ]
  },
  "plans":       { "2570": { "PCU01": { "P1-01": [plan_op, plan_pp] } },      // จำนวน (หน่วยตามฟอร์ม) เฉพาะคู่ที่ไม่เป็น 0 ทั้งคู่
                   "2569": { ... } },                                           // จากคอลัมน์ "แผนปีงบ 69" (อ้างอิง admin)
  "prices_prev": { "2569": { "P1-01": 49.0 } },                                // ราคาปีก่อน (ใช้คิดเงินปีก่อนในแท็บ "ปีก่อน")
  "actual_prev": { "2569": { "months": ["2025-10","2025-11",...,"2026-09"],   // 12 เดือน CE, index 0 = ต.ค. 68
                             "data": { "PCU01": { "P1-01": { "op":[12 ตัวเลข], "pp":[12 ตัวเลข] } } } } },  // เฉพาะรายการที่มีค่า > 0 บางเดือน
  "stats":       { "2569": { "PCU01": { "P1-01": [median_m, p90_m, annual_qty] } } },   // จากยอดรายเดือน op+pp 12 เดือน (numpy percentile linear) · เฉพาะ annual_qty > 0
  "limits":      { "2570": { "PCU01": { "P1-01": [limit_month|null, limit_year|null, "plan70"|"stat69"] } } },
  "config":      { "fy_current":2570, "limit_mode":"warn", "stock_required":0,
                   "budget_op":520000, "budget_pp":390000, "budget_total":910000, "deadline_day":null,
                   "plan_total": { "2570": { "op":1355995.02, "pp":577581.85, "total":1933576.87 } } },
  "verify":      { "plan_2570_per_pcu": { "PCU01": { "op":56390.26, "pp":6780.0, "total":63170.26 } },   // แถว "รวมเป็นเงิน" ในไฟล์ต้นทาง
                   "actual_2569_per_pcu": { "PCU01": { "op":40187.94, "pp":12570.98, "total":52758.92 } },
                   "actual_2569_network": { "op":631464.24, "pp":147392.74 } }
}
```
- ตัวเลขจำนวน: integer ถ้าเป็นจำนวนเต็ม มิฉะนั้น float · เงิน: float 2 ตำแหน่ง · `null` = ไม่มีค่า
- `limits` ตั้งต้น (Q81): `limit_year = plan_op+plan_pp` ปี fy (0 → null) · `limit_month = ceil(p90_m ปีก่อน)` ถ้า p90_m > 0 (source `stat69`)
  มิฉะนั้น `ceil(limit_year/12×2)` (source `plan70`) · ถ้า limit_year null และ p90 ไม่มี → ไม่มีแถว
- `actual_prev[fy].months` คงเป็นเดือนปฏิทินตามคอลัมน์ Excel ต.ค. … ก.ย. (`fyExcelMonths`, index 0 = ต.ค.) — ไม่เลื่อนตามรอบ (2j); นิยามปีงบของ "รอบ" (ขอเบิกเดือน X = ปีงบของเดือน X−1, FY2570 = รอบ 2026-11 … 2027-10) อยู่ใน `functions/API.md` §1 · ตอนเปิดปีใหม่ที่คำนวณจาก D1 รอบ X ลงคอลัมน์เดือน X−1
- ข้อมูลใน `actual_prev`/`plans`/`stats` เป็นข้อมูลภายใน รพ. — ไฟล์นี้อยู่ใน repo **private** เท่านั้น ไม่อยู่ใต้ `public/`

## การนำเข้า (backend action `adminImportSeed`, idempotent — รันซ้ำได้)
| ส่วน | กฎ |
|---|---|
| `pcus` | upsert code/name/print_name/group · **ไม่แตะ** pin_hash/pin_salt/pin_version/pin_fail/pin_locked_until ที่มีอยู่ · แห่งใหม่ได้ PIN ตั้งต้น `12345` |
| `form` | ถ้ายังไม่มี `form_versions` ของ fy นี้ → insert version แรก · ถ้ามีแล้วและ data เท่ากัน (hash) → ข้าม · ถ้ามีแล้วและต่าง → **ไม่ทับ** รายงานว่าข้าม (admin ใช้ form editor แทน) |
| `plans`, `actual_prev`, `prices_prev`, `stats` | replace ทั้ง fy ที่อยู่ในไฟล์ (ลบของ fy นั้นแล้วใส่ใหม่) |
| `limits` | insert เฉพาะคู่ที่ยังไม่มีแถว หรือแถวเดิม `source != 'admin'` · แถวที่ admin แก้แล้วคงไว้ · แถวที่เหมือนของเดิมทุกค่า (เดือน/ปี/source) ไม่เขียนซ้ำและไม่นับใน `limits_inserted` |
| `config` | ตั้งเฉพาะ key ที่ยังไม่มีค่า (ไม่ทับที่ admin แก้) · ยกเว้นเมื่อเรียกด้วย `set_current_fy:true` (2e เปิดปีงบใหม่) → ตั้ง `fy_current` = fy ของไฟล์ |
| ใบเบิก / users / audit / hidden_items / limit_unlocks | ไม่แตะเลย |
ผลลัพธ์: `{ imported: {pcus, form:"inserted"|"same"|"skipped_differs", plans, actual_rows, stats, limits_inserted, limits_kept_admin, config_set}, warnings:[...] }` + audit `import_seed`

## ส่งออก (backend action `adminExportSeed`, 2d)
`adminExportSeed{fy?}` สร้างไฟล์รูปแบบเดียวกันนี้จากสถานะ D1 ปัจจุบัน (`generated_by:"adminExportSeed"`, `sources:["D1 export"]`, ไม่มี `verify`) — `form` = version ล่าสุดของ fy
(รวมหน้าที่ปิดแล้ว `active:false`) · `plans`/`prices_prev`/`actual_prev`/`stats` ทุก fy ที่มีในระบบ · `limits` เฉพาะ fy นั้น (รวมแถว `admin`) · `config` ปัจจุบัน
→ นำเข้ากลับด้วย `adminImportSeed` ได้แบบ no-op (`form:"same"`, `limits_inserted:0`) ใช้แทนไฟล์ตั้งต้นที่ล้าสมัยหลัง admin แก้ฟอร์มใน form editor
`item.seq` = เลขลำดับต่อเนื่องทั้งฟอร์ม (P2 ต่อจาก P1) และ `step.order`/`page_no` ถูก server คำนวณใหม่ทุกครั้งที่บันทึกจาก editor (page_no เฉพาะหน้า active)


## เปิดปีงบใหม่ (backend actions `adminImportPreview` / `adminImportApply`, 2e)
ไฟล์ `import_<ปี>.json` ของปีถัดไป (`fy = fy_current + 1`) ต้องมีอย่างน้อย `form` + `plans["<fy>"]` — ที่เหลือ optional · รายละเอียดใน `functions/API.md` §5.3
- `preview` ไม่เขียนอะไร (บอก mode `rollover`/`same_fy`, ผลต่างฟอร์ม/ราคา, ยอดแผนเป็นบาท, limits ที่จะสร้าง, สิ่งที่จะ config) · `apply` เปิดปีใหม่ + ตั้ง `fy_current`
- **ฟอร์มปีใหม่ = ฟอร์มในไฟล์ + รายการของปีเก่าที่ไฟล์ไม่มีแล้ว เก็บไว้เป็น `active:false`** ในหน้าเดิม (ไม่ลบ — รหัสในใบเบิก/stats เดิมยังหาเจอ) แล้ว renumber แบบ form editor
- ฟอร์มในไฟล์ถูกตรวจด้วยกฎเดียวกับ form editor (≤ 10 หน้าที่ active, ≤ 24 รายการ active/หน้า, ≤ 2 หัวหมวด/หน้า, รหัสไม่ซ้ำ …)
- `actual_prev["<fy เก่า>"]`, `prices_prev["<fy เก่า>"]`, `stats["<fy เก่า>"]`: ถ้าไฟล์ไม่มี → ระบบคำนวณจากใบเบิกที่ส่งแล้ว (`submitted`/`issued`) ของปีเก่าใน D1 (ราคา = ฟอร์มล่าสุดของปีเก่า · stats = median/p90 แบบ numpy linear ของยอด op+pp 12 เดือน)
- `limits["<fy ใหม่>"]`: ถ้าไฟล์ไม่มี → สร้างตามกฎ Q81 ข้างบนจาก `plans[fy ใหม่]` ∪ `stats[fy เก่า]` (source `stat<fy เก่า−2500>` / `plan<fy ใหม่−2500>`)
- `adminImportSeed` ตรวจรูปแบบทั้งไฟล์ก่อนเขียน (ไฟล์เสีย = ไม่เขียนอะไรเลย)
