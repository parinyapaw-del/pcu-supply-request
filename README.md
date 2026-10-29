# ใบเบิกวัสดุการแพทย์ รพ.สต. — phase 2 (Cloudflare Pages + Functions + D1 + R2)

Live: https://pcu-supply-request.pages.dev · **เริ่ม session: อ่าน `../CLAUDE.md` ก่อน** · Spec: `../phase 2.md` · สถานะงาน: `../progression_phase2.md` · API contract: `functions/API.md` · seed/import format: `seed/FORMAT.md`

## โครง
- `public/` — static site: `index.html` (ฝั่ง รพ.สต. — PIN, กรอก, ส่ง, พิมพ์, PDF), `admin.html` (หลังบ้าน), `print.html` (shell ที่ Browser Rendering ใช้สร้าง PDF), `help.html` (= `/help` คู่มือ รพ.สต. สาธารณะ) + `help/` (เนื้อหาคู่มือ `manual_pcu.js` / `manual_staff.js`, ภาพ `img/`, `shots.json`), `docs/import_template.md` (คู่มือ AI สำหรับนำเข้าปีใหม่)
- `functions/` — Pages Functions: `api/index.js` router (POST /api) · `api/export.xlsx.js` · `api/pdf/[id].js` · `api/cron/backup.js` · `_lib/*` (auth, db schema+migrations, pcu, admin, form_editor, issue, importer, import_fy, pdf, export, backup)
- `seed/` — `FORMAT.md` + `seed_2570.json` (**gitignored** — hospital data; import through admin → ระบบ)
- `tools/` — `test_api.mjs` (HTTP test suite), `capture_help.mjs` (ภาพคู่มือ), `build_*.py` (seed builders from the Excel sources), `check_import_2570.mjs`
- phase 1.5 backend (Apps Script) ลบออกจาก git 2026-10-07 — ดู tag `archive/phase1.5` ถ้าต้องย้อนดู
- repo root `index.html`/`admin.html` — redirect stubs for the old GitHub Pages URL (served by GitHub Pages from `main`; Cloudflare serves `public/`)

## Dev
```
npm install
cp .dev.vars.example .dev.vars      # once (DEV_FAKE_GOOGLE=1 → dev login box + devReset)
npm run dev                         # http://localhost:8788  (wrangler pages dev --local --r2 FILES)
npm test                            # node tools/test_api.mjs  (WIPES the DB it talks to; use API_BASE=http://localhost:8791 for a throw-away server)
```
Deploy = push `main` (Cloudflare Pages auto-build). Secrets in the Pages dashboard: `TOKEN_SECRET`, `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS`, `BACKUP_KEY`, `CF_ACCOUNT_ID`, `CF_BR_TOKEN` (PDF). Bindings: D1 `DB`, R2 `FILES` (`wrangler.toml`).

## ภาพคู่มือ (2ac)
```
node tools/capture_help.mjs         # ภาพใหม่ทั้งชุด → public/help/img/*.png + public/help/shots.json
```
- ต้องมี Google Chrome (`CHROME_PATH` ถ้าไม่ได้อยู่ที่ `/Applications/Google Chrome.app/...`) + `npm install` (puppeteer-core) + `.dev.vars` ที่มี `DEV_FAKE_GOOGLE=1`
- สคริปต์เปิด server ชั่วคราวเองที่ :8791 (state `.wrangler/capture-state` ลบทุกครั้ง) แล้วปิดตอนจบ — ไม่แตะ :8788 · ถ้ามีอะไรค้างที่ :8791 ให้ปิดก่อน
- **ไม่ใช้ข้อมูลจริง**: ชื่อรายการ/ราคาจาก `public/data/form2569.json` · จำนวน/ยอดใช้/แผน/เพดาน/แดชบอร์ด = ตัวเลขสมมติ (seeded random) · หน่วยในภาพ = PCU00 "ทดลอง" · ไม่อ่าน `seed/seed_2570.json` · บัญชีในภาพ = `@example.com` (สคริปต์ fail ถ้าหน้าใดแสดงอีเมล ADMIN_EMAILS)
- หมายเลข ①②③ ไม่ได้อยู่ในภาพ: สคริปต์วัดกรอบจาก selector (`SHOTS` ในสคริปต์) เขียนลง `shots.json` แล้ว `js/help_render.js` วางทับเป็น HTML (% ของภาพ) · selector ไม่เจอ / เนื้อหาคู่มืออ้างภาพหรือ mark ที่ไม่มี → สคริปต์ fail พร้อมบอกชื่อ
- UI เปลี่ยน → รันใหม่ · เพิ่ม/แก้ภาพ → แก้ `SHOTS` + ข้อความใน `public/help/manual_*.js` (ข้อความใต้ภาพอ้างหมายเลขเดียวกัน) · ตัวเลขเวลา "ส่งแล้ว …" ในภาพใช้นาฬิกาจริง (ต่างกันเล็กน้อยทุกครั้งที่รัน)
