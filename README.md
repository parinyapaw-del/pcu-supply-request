# ระบบเบิกวัสดุการแพทย์ รพ.สต. — phase 1.5 (รอบทดลองออนไลน์)

## คืออะไร
เว็บให้ รพ.สต. 15 แห่ง กรอกใบเบิกวัสดุการแพทย์ (ฟอร์มปี 2569, 7 แบบ 125 รายการ) บนมือถือ/คอม แล้วพิมพ์ใบ A4 เหมือนฟอร์ม Excel เดิม
ข้อมูลบันทึกบน server กลาง (Google Apps Script + Google Sheet) — กรอกเครื่องหนึ่งแล้วไปทำต่ออีกเครื่องได้

phase 1.5 = **รอบทดลอง** ย้อนเล่นปีงบ 2568 (รอบ ก.ย. 2568 + ต.ค. 2568) โดยใช้ข้อมูลเบิกจริงปี 2568 + ยอดคงเหลือจำลอง
- รพ.สต. เข้าด้วย PIN 5 หลัก (เริ่มต้น 12345 ทุกแห่ง, ผู้ดูแลเปลี่ยนได้)
- ตั้ง "รายการที่ไม่เบิก" ของแต่ละแห่งได้ (ไม่ขึ้นตอนกรอก แต่ยังพิมพ์ในใบ)
- เพดานเบิกต่อรายการ (ตั้งต้นจากสถิติปี 68, ผู้ดูแลแก้ได้, โหมดเตือน/บังคับ)
- หน้าผู้ดูแล `admin.html` (Sign in with Google หรือรหัสสำรอง): ความคืบหน้า, รับเรื่อง/ส่งกลับ, ใบจัดของ, งบ, คงเหลือ, เพดาน, PIN

Spec: `../phase 1.5.md` · สถานะ: `../progression_phase2.md` · API: `apps-script/API.md`

## โครงสร้าง
- `index.html` + `js/main.js`, `js/pages/*` — ฝั่ง รพ.สต. (login PIN, หน้าหลัก, กรอก 7 step, รายการที่ไม่เบิก, พิมพ์)
- `admin.html` + `js/admin.js`, `js/admin/*` — ฝั่งผู้ดูแล 9 แท็บ
- `js/api.js`, `js/config.js` (URL ของ Apps Script), `js/sync.js` (autosave + สำเนาในเครื่องกันเน็ตหลุด)
- `apps-script/` — backend (clasp) · `_seed.html` = ข้อมูลตั้งต้น (gitignored, สร้างด้วย `tools/make_seed_html.py`)
- `tools/build_seed_2568.py` — สร้างข้อมูลตั้งต้นจากไฟล์สถิติปี 2568 (อยู่นอก repo: `../phase15_seed/`)
- `tools/dev_server.mjs` + `tools/gas_mock.mjs` — รัน backend จริงในเครื่องด้วย mock ของ Google (ไม่ต้องใช้บัญชี Google)
- `tools/test_api.mjs` — ทดสอบ API (`node tools/test_api.mjs`)

## รันในเครื่อง
```bash
node tools/dev_server.mjs 8770 --reset
```
เปิด `http://localhost:8770/` (PIN 12345) และ `http://localhost:8770/admin.html` (ช่อง dev login ใส่อีเมล admin)

## Deploy
- frontend: push `main` → GitHub Pages
- backend: `cd apps-script && clasp push --force && clasp create-deployment --deploymentId <ID เดิม>` (URL คงเดิม) ·
  เจ้าของรัน `RUN_ME_setup` ใน editor เมื่อข้อมูลตั้งต้นเปลี่ยน
