# ใบเบิกวัสดุการแพทย์ รพ.สต. — phase 2 (Cloudflare Pages + Functions + D1 + R2)

Live: https://pcu-supply-request.pages.dev · **เริ่ม session: อ่าน `../CLAUDE.md` ก่อน** · Spec: `../phase 2.md` · สถานะงาน: `../progression_phase2.md` · API contract: `functions/API.md` · seed/import format: `seed/FORMAT.md`

## โครง
- `public/` — static site: `index.html` (ฝั่ง รพ.สต. — PIN, กรอก, ส่ง, พิมพ์, PDF), `admin.html` (หลังบ้าน), `print.html` (shell ที่ Browser Rendering ใช้สร้าง PDF), `docs/import_template.md` (คู่มือ AI สำหรับนำเข้าปีใหม่)
- `functions/` — Pages Functions: `api/index.js` router (POST /api) · `api/export.xlsx.js` · `api/pdf/[id].js` · `api/cron/backup.js` · `_lib/*` (auth, db schema+migrations, pcu, admin, form_editor, issue, importer, import_fy, pdf, export, backup)
- `seed/` — `FORMAT.md` + `seed_2570.json` (**gitignored** — hospital data; import through admin → ระบบ)
- `tools/` — `test_api.mjs` (HTTP test suite), `build_*.py` (seed builders from the Excel sources), `check_import_2570.mjs`
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
