# API contract — phase 2a (Cloudflare Pages Functions + D1 + R2)

Spec: `../../phase 2.md` (§1, §3, §4.3, §5). Supersedes `apps-script/API.md` (phase 1.5). Import format: `../seed/FORMAT.md`.
This file is the single contract between the backend (`functions/**`), the PCU frontend and the admin frontend.
Items marked **2b–2e** (except 2d, now live) are reserved: the action name exists and returns `NOT_IMPLEMENTED`.

## 1. Transport
- `POST /api` — body JSON `{ "action": "<name>", "token": "<token|omit>", ...params }`. Content-Type may be `text/plain` (no CORS preflight,
  what `js/api.js` sends) or `application/json`. Same-origin only (no CORS headers).
- Response is **always HTTP 200**: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": { "code", "message": "<Thai>", ...extra } }`.
  (Exceptions: `GET /api/export.xlsx` and `POST /api/cron/backup` use real HTTP status codes because they are not called through `api.js`.)
- `GET /api` → `{ok:true,data:{service:"pcu-supply",time}}` (health check, no DB access).
- Error codes: `BAD_REQUEST` · `AUTH_REQUIRED` · `AUTH_EXPIRED` · `FORBIDDEN` · `BAD_PIN{remaining}` · `PIN_LOCKED{until}` ·
  `BAD_PASSWORD{remaining}` · `LOCKED{until}` (backup password) · `NOT_FOUND` · `CONFLICT` · `INCOMPLETE{missing:[item_code]}` ·
  `OVER_LIMIT{items:[{code,total,limit_month,limit_year,used_fy}]}` · `NOT_IMPLEMENTED` · `SERVER_ERROR`.
- Times: ISO 8601 UTC strings (`2026-10-06T08:00:00.000Z`); display in Asia/Bangkok. Month keys: CE `"YYYY-MM"`.
  Dates (`deadline_date`): `"YYYY-MM-DD"` (a Bangkok calendar date).
- Fiscal year (พ.ศ.): `fy(month) = CE_year + (month >= 10 ? 1 : 0) + 543` → `2026-10` … `2027-09` = FY2570.
- **Current round** = the calendar month in Asia/Bangkok at request time. A month "exists" implicitly; `rounds` rows are created lazily
  when an admin sets a deadline / lock / note. PCU home = current month + previous month.
- Removed (1.5) actions return `BAD_REQUEST` with a Thai hint: `submit`, `withdraw` (use `saveLines{send:true}`; no withdraw),
  `adminReceive`, `adminReturn` (→ `adminNote`), `adminSetMode` (→ `adminSetLimitMode`). Unknown action → `BAD_REQUEST`.

## 2. Tokens
`base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, env.TOKEN_SECRET))` (same format as 1.5; `exp` is epoch **ms**).
- PCU: `{t:"pcu", pcu, v:<pcus.pin_version>, exp}` — 7 days. Valid only while `v == pcus.pin_version` (admin PIN change invalidates).
  A PCU action always operates on `token.pcu` (never a request param).
- Staff: `{t:"admin"|"dispenser", sub:<email>|"backup", v:<backup_version if backup else 0>, exp}` — 12 hours.
  The role is **re-read from the `users` table on every call** (token `t` is only informative); removed user → `FORBIDDEN`.
  Effective users = `users` table; **if the table is empty**, emails in `env.ADMIN_EMAILS` (comma list, case-insensitive) are admins.
  The first `adminUsersAdd/Remove` materialises the env admins into the table (so adding a dispenser never locks the env admin out).
  `sub:"backup"` (backup-password login) is always admin and valid while `v == config.backup_version`.
- Exports accept the token as `?token=` or `Authorization: Bearer <token>`.
- Passwords/PINs: salted SHA-256 (`sha256(salt + ":" + secret)`, hex) — deliberately not PBKDF2 (free-plan CPU limit). PIN = 5 digits,
  5 failures → locked 5 min (`PIN_LOCKED{until}`); backup password ≥ 8 chars, 5 failures → locked 15 min (`LOCKED{until}`).
- Google: `adminLoginGoogle{id_token}` verifies via `https://oauth2.googleapis.com/tokeninfo` (`aud == env.GOOGLE_CLIENT_ID`,
  `email_verified == "true"`, cached 5 min). **Dev only** (`env.DEV_FAKE_GOOGLE === "1"`): `id_token` of the form `dev:<email>` is accepted as that email.

## 3. Status model (`requests.status`)
`draft` → `submitted` → `issued` (2c: every dispense unit that has requested lines is marked done). `not_started` = no row (virtual).
- `saveLines` (autosave) creates the row as `draft`; on an already `submitted` request it keeps `submitted` and bumps `updated_at`.
- **Submit = `saveLines{send:true}`** (also what the Save/Print/PDF buttons do): validate → `status='submitted'`, `submitted_at=now`,
  `first_submitted_at` (once), `submit_count++`, `form_version_id` = latest version for the round's fy, `price_snapshot` on every line.
  Re-submit overwrites. No withdraw.
- `edited_after_submit = (updated_at > submitted_at)` (request has autosaved edits after its last submit). Submit sets both to the same `now`.
- Not editable (`CONFLICT`): round locked (`rounds.locked=1`) · **2c**: a changed line belongs to a step whose `dispense_unit` has an `issue_status` row.
- Admin note (`admin_note`) never changes status.

## 4. PCU actions
| action | params | data |
|---|---|---|
| `pcuList` (public) | – | `{pcus:[{code,name,print_name,group}]}` |
| `pcuLogin` (public) | `pcu, pin` | `{token, exp, pcu:{code,name,print_name,group}, bootstrap:<pcuBootstrap>}` · `BAD_PIN{remaining}` · `PIN_LOCKED{until}` · `NOT_FOUND` |
| `pcuBootstrap` | – | see §4.1 |
| `pcuGetMonth` | `month` | one `byMonth` entry (§4.1) + `round` + `unlocks` — for "older months" · + `form` (the request's bound version, PCU-stripped) **only when** it differs from the latest of `fy_current` (2d) |
| `saveLines` | `month, lines:{code:{stock,op,pp,updated_at}}, last_step?, submitter_name?, send?:true` | `{saved_at, status, request, submitted:bool, over_limit:[...] }` |
| `setHidden` | `codes:[item_code]` (full replacement) | `{hidden:[...]}` |
| `pcuAck` | `month` | `{issued_seen_at}` (acknowledge the issue notice; `NOT_FOUND` if no request) |
| `requestPdf` | – | **2b** `NOT_IMPLEMENTED` |
| `issueLines`, `issueAll`, `issueDone` (staff) | – | **2c** `NOT_IMPLEMENTED` |

`saveLines` rules
- `month`: `YYYY-MM`, must be the current month, the previous month, or a month where this PCU already has a request; never a future month.
- Values: integer 0–99999 or `null`. Per-line **last-write-wins** (done in SQL): a line is written only if its `updated_at` is **strictly newer**
  than the stored one (equal = idempotent retry → no-op; missing `updated_at` = now). Item codes must exist in the latest form (or the request's bound version) else `BAD_REQUEST`.
- Request `updated_at` is bumped only when at least one line actually changed (an all-stale or empty call is a no-op for `edited_after_submit`).
  `last_step` / `submitter_name` are stored when present.
- Autosave is **not** written to `audit_log` (would flood it); `send:true` is (`submit`).
- `send:true`, in order: round locked → `CONFLICT` · `config.stock_required=1` → every non-hidden **active** item of the latest form needs `stock`
  else `INCOMPLETE{missing}` · `limit_mode="enforce"` → per line `total=op+pp`: over if `total > limit_month` or `used_fy + total > limit_year`
  (limits of the round's fy; skipped for items with a `limit_unlocks` row for (pcu,item,month)) → `OVER_LIMIT{items}`.
  Lines saved earlier in the same call stay saved (it is autosave + submit). `warn` mode: submit succeeds and the same list is returned as `over_limit`.
  `off`: `over_limit:[]`.

### 4.1 `pcuBootstrap` data
```
{
  server_time, current_month,
  pcu: {code,name,print_name,group},
  config: { limit_mode:"off"|"warn"|"enforce", stock_required:0|1, deadline_day:int|null, fy_current:2570 },
  form_version_id: 12,
  form: { id, fy, created_at, note, steps:[ {code,order,sheet,page_no,title,subject,to,dispense_unit,active?,rows:[
            {type:"section",title} | {type:"item",code,seq,name,unit,price,active} ]} ] },     // latest version of fy_current; steps with active:false are STRIPPED (2d)
  forms: { "11": <form, same shape, PCU-stripped> },   // 2d: for every shown (byMonth) request whose form_version_id is set and ≠ form_version_id — the version it was submitted on ({} when none)
  rounds: [ {month, fy, deadline_date:"YYYY-MM-DD", deadline_source:"round"|"config"|"month_end", locked:bool, note:string|null} ],  // [current, previous]
  older_months: ["2026-08", ...],            // months before `previous` where this PCU has a request (newest first)
  hidden: [item_code],
  never_prev: [item_code],                   // items of the form this PCU never withdrew in FY(fy_current-1) per actual_prev ([] if no history for this PCU)
  limits: { code: [limit_month|null, limit_year|null] },     // fy_current
  plans:  { code: [plan_op, plan_pp] },                      // fy_current
  unlocks:{ "2026-10": { code: "<reason>" } },               // for the 2 shown months
  byMonth: { "2026-10": {                                    // for the 2 shown months (also returned by pcuGetMonth)
      request: RequestObj | null,
      used_fy: { code: qty },        // Σ(op+pp) of this PCU's submitted/issued requests in that month's fy, excluding that month
      prev_lines: { code: {op,pp} }, // from the previous calendar month's submitted/issued request (only op+pp>0); {} if none
      issue: null | {units_total, units_done, done:bool, complete, incomplete, issued_seen_at}   // 2c data; null in 2a
  } },
  issue_notices: [ {month, complete, incomplete} ]   // issued requests with issued_seen_at null (notice bar); [] in 2a
}
RequestObj = { id, pcu, month, status, form_version_id|null, submitter_name, last_step, created_at, updated_at,
               first_submitted_at|null, submitted_at|null, submit_count, admin_note|null, admin_note_at|null, issued_seen_at|null,
               edited_after_submit:bool, lines: { code: {stock,op,pp,updated_at} } }
```
PCU-side lines never include price/issued fields (Q78).
Form fallback: if no `form_versions` row exists for the round's fy, the latest version of any fy is used (so Sep 2026 = FY2569 still works).

## 5. Admin / dispenser actions
Admin = all. **Dispenser** may call only `adminBootstrap` (reduced), `adminRequests`, `adminGetRequest`, `GET /api/export.xlsx`; everything else `FORBIDDEN`.
`adminLoginGoogle` / `adminLoginBackup` are public.

| action | params | data |
|---|---|---|
| `adminLoginGoogle` | `id_token` | `{token, exp, email, role, units}` · `FORBIDDEN` if not a user |
| `adminLoginBackup` | `password` | `{token, exp, role:"admin"}` · `BAD_PASSWORD{remaining}` · `LOCKED{until}` · `NOT_FOUND` if none set |
| `adminBootstrap` | – | §5.1 |
| `adminRequests` | `month?` (omitted = current + previous month) | `{requests:[RequestObj without lines + pcu_name + progress], rounds:[RoundInfo], server_time, current_month}` · `progress={items_requested, stock_filled, lines, qty_op, qty_pp, baht, last_step}` |
| `adminGetRequest` | `pcu, month` | `{request: RequestObj(+price_snapshot & issued_* per line)|null, pcu:{...}, hidden:[code], form_version_id, form:{id,fy,created_at,note,steps}}` (form = version bound to the request, else latest of the round's fy). A **dispenser** only gets the lines of items on pages of its own `units`. |
| `adminNote` | `pcu, month, note` (empty/blank clears) | `{request}` — creates a `draft` row if none; status unchanged |
| `adminSetRound` | `month, deadline_date: "YYYY-MM-DD"\|null, note?` | `{round}` (null clears the per-round override; `note` only touched when the key is present) |
| `adminLockRound` | `month, locked:0\|1` | `{round}` |
| `adminSetLimitMode` | `mode:"off"\|"warn"\|"enforce"` | `{config}` |
| `adminSetConfig` | `key, value` — keys: `stock_required`(0/1) `budget_op` `budget_pp` `budget_total` (number ≥ 0) `deadline_day`(int 1–31 \| null) | `{config}` |
| `adminSetLimit` | `pcu, code, limit_month, limit_year` (int ≥ 0 \| null) | `{limit}` (source `admin`) |
| `adminResetLimit` | `pcu, code` | `{limit\|null}` recomputed per FORMAT.md rule from `plans[fy_current]` / `stats[fy_current-1]` (row removed if nothing) |
| `adminLimitsUpload` | `rows:[{pcu_code,item_code,item_name?,limit_month,limit_year,note?}], fy?, mode?:"merge"\|"replace", dry_run?:bool` | `{errors:[{row,pcu_code,item_code,error}], warnings:[...], changes:[{pcu,item_code,old:[m,y]\|null,new:[m,y]\|null}], added, updated, deleted, applied:bool}` — rules of `limit_upload_format.md` §2/§3 (`CLEAR` in merge mode; blank = untouched in merge). Valid rows are applied unless `dry_run`. Row number = index+2 unless row has `row`. A pair duplicated in the file gets one `errors` entry per row (rows that already carry another error are not listed twice). |
| `adminUnlockLimit` | `pcu, item_code, month, reason` (reason required) | `{unlock}` |
| `adminRemoveUnlock` | `pcu, item_code, month` | `{ok:true}` |
| `adminSetPin` | `pcu, pin` (5 digits) | `{ok:true}` (new salt, `pin_version++`, clears fail/lock, `pin_custom=1`) |
| `adminUnlockPin` | `pcu` | `{ok:true}` |
| `adminSetHidden` | `pcu, codes` (full replacement) | `{hidden}` |
| `adminSetBackupPassword` | `password` (≥ 8) — **Google admin only** | `{ok:true}` (`backup_version++` invalidates backup sessions) |
| `adminUsersList` | – | `{users:[{email,role,units,added_at,added_by}], source:"table"\|"env"}` |
| `adminUsersAdd` | `email, role:"admin"\|"dispenser", units:["พัสดุ"\|"จ่ายกลาง"\|"LAB"]` (dispenser needs ≥ 1; upsert; demoting the last admin → `CONFLICT`) | `{users}` |
| `adminUsersRemove` | `email` | `{users}` · refuses to remove the last admin (`CONFLICT`) |
| `adminImportSeed` | `seed` (FORMAT.md JSON; every top-level key except `format`/`fy` is optional ⇒ may be sent in chunks), `set_current_fy?:bool` | `{imported:{pcus, form:"inserted"\|"same"\|"skipped_differs"\|"none", plans, actual_rows, prices_prev, stats, limits_inserted, limits_kept_admin, config_set:[key]}, warnings:[...]}` — idempotent, rules in FORMAT.md |
| `adminClearTrial` | `confirm:"ล้างข้อมูล"` | `{deleted_requests, deleted_lines, deleted_issue_status, deleted_pdf_files}` — only those tables (+R2 PDFs listed in `pdf_files`) |
| `adminBackupNow` | – | `{key, size, deleted:[old keys]}` (same as the cron endpoint) |
| `adminAuditLog` | `limit?` (default 100, max 500), `before?` (audit id → older rows) | `{entries:[{id,ts,actor,role,action,pcu,month,detail}], next_before:id\|null}` |
| `adminFormGet` | `id` | `{form:{id,fy,created_at,created_by,note,steps}}` of any version (steps incl. closed pages) · `NOT_FOUND` — §5.2 |
| `adminFormSave` | `base_version_id:int, note?:string(≤200), form:{steps:[...]}` | `{saved:true, form, versions, diff}` or `{saved:false, same:true, form, versions}` — new form version, §5.2 |
| `adminExportSeed` | `fy?` (default `config.fy_current`) | `{seed:<seed/FORMAT.md object>}` — the live DB in import format, §5.2 |
| `adminImportPreview` / `adminImportApply` / other `adminImport*` ≠ `adminImportSeed` | – | **2e** `NOT_IMPLEMENTED` |
| `devReset`, `devPutBackup{key}`, `devListBackups` (public, only if `env.DEV_FAKE_GOOGLE==="1"`, else `FORBIDDEN`) | – | tests only: `devReset` drops every table and recreates the schema → `{ok:true}`; `devPutBackup` writes a dummy `backup/YYYY-MM-DD.json` to R2 (to test the 90-day prune); `devListBackups` → `{keys,sizes}` |
| header `X-Dev-Month: YYYY-MM` | – | only honoured when `DEV_FAKE_GOOGLE==="1"` (POST /api and the export): overrides "the current Bangkok month" so tests do not depend on the real date |

All mutating admin/PCU actions (except autosave) append to `audit_log` in the same D1 batch.

### 5.2 Form editor + seed export (2d) — admin only (dispenser/PCU/no token → `FORBIDDEN`/`FORBIDDEN`/`AUTH_REQUIRED`)
A form version is immutable. "Editing" the form = `adminFormSave` inserts a new `form_versions` row (`data = {fy, note, steps}`, `fy` = the base's fy,
`created_by` = actor email or `"backup"`). Pages and items are **never deleted, only closed** (`active:false`) so every request keeps resolving its codes.
New data fields: `step.active` (default true; false = closed page). `adminBootstrap.form`, `adminGetRequest.form`, `adminFormGet` keep closed pages;
every PCU-facing form (`pcuBootstrap.form`/`forms`, `pcuGetMonth.form`) strips them. Existing requests keep their `form_version_id`; drafts follow the latest version
(`pcuBootstrap.form`); `saveLines` accepts any code of the latest or bound version, so a closed item with qty > 0 on an old submitted request still resubmits.

`adminFormSave{base_version_id, note?, form:{steps}}`
- `base_version_id` must be the **latest** version of its fy, else `CONFLICT` ("มีการบันทึกฟอร์ม version ใหม่ไปแล้ว — โหลดใหม่ก่อนแก้"); unknown id → `NOT_FOUND`.
  The check is atomic in SQL (two simultaneous saves → the second gets `CONFLICT`).
- Input per step: `{code, title, sheet?, subject?, to?, dispense_unit?, active?, rows:[...]}`; per row `{type:"section",title}` or
  `{type:"item",code,name,unit,price,active?}`. `order`, `page_no`, `seq` are ignored and recomputed. Unknown fields are dropped; strings are trimmed.
- Validation (first error wins → `BAD_REQUEST`, Thai message names the page/item): 1 ≤ active steps ≤ 10 (≤ 60 steps in all) · step `code` `^[A-Z0-9]{1,6}$`, unique ·
  `title` non-empty ≤ 120 · `sheet`/`subject`/`to` ≤ 120 · `dispense_unit` ∈ {พัสดุ, จ่ายกลาง, LAB} (default by step code) · `active` boolean · ≤ 200 rows per step ·
  sections: title non-empty ≤ 80, ≤ 2 per step · items: `code` `^[A-Z0-9]+-\d{2,3}$` unique across the whole form · `name` non-empty ≤ 200 · `unit` ≤ 30 ·
  `price` number ≥ 0 (rounded to 2 decimals) · active items per step ≤ 24 · a step may be `active:false` only when it has no active item ·
  every step code of the base must still exist ("ลบหน้าไม่ได้ ให้ปิดหน้าแทน") · every item code of the base must still exist somewhere — moving between pages is fine
  ("ลบรายการไม่ได้ ให้ปิดรายการแทน").
- Normalisation (server): `step.order` = 1..n by array order · `step.page_no` = running number among **active** steps (`null` for closed ones) ·
  `item.seq` = **one running number over the whole form** (every item row, closed ones included; items of active steps first, in order, then those of closed steps) —
  the seed numbers items globally (P2 continues after P1), so an unedited form keeps its numbers · defaults `active:true`, `dispense_unit`.
- "Same" = the normalised `{fy, steps}` equals the base's (note ignored; the base is normalised the same way) → `{saved:false, same:true, form:<base>, versions}`, no row.
- `diff` (vs. the base): `{steps_added:[code], steps_closed:[code], steps_reopened:[code], items_added:[code], items_closed:[code], items_reopened:[code],
  price_changed:[{code,old,new}], renamed:[{code,old,new}], unit_changed:[code], moved:[{code,from,to}]}`; stored in `audit_log` as `form_save`
  (`detail` = JSON `{id, note, diff}`; a very large diff is reduced to `{id, note, diff_counts, truncated:true}` to stay valid JSON inside the 2000-char cap).
- `versions` = every row of `form_versions` newest first `[{id,fy,created_at,created_by,note}]` (same list as `adminBootstrap.form_versions`).
- Nothing else changes (requests, lines, plans, limits untouched). New items have no plan/limit until an admin sets one.

`adminExportSeed{fy?}` → `{seed}` in the `seed/FORMAT.md` shape: `format, fy, generated_at, generated_by:"adminExportSeed", sources:["D1 export"], pcus` (code,name,print_name,group),
`form` (latest version of `fy`: `{fy,note,steps}` with every step incl. closed ones; key omitted if that fy has no version), `plans` / `prices_prev` / `actual_prev` / `stats`
(every fy present; `actual_prev[fy].months` = the 12 months of that fy, 12-element `op`/`pp` arrays) , `limits` (`fy` only; `[limit_month, limit_year, source]`, `admin` rows included),
`config` (fy_current, limit_mode, stock_required, budget_op/pp/total, deadline_day). No `verify` block. Re-importing it is a no-op: `form:"same"`, `limits_inserted:0`
(the importer skips a limits row identical to the stored one), every table keeps its row count, and export → import → export is a fixed point.

### 5.1 `adminBootstrap` data (admin; dispenser gets only `me, server_time, current_month, config, pcus(code,name,print_name,group), form, form_versions, rounds, months`)
```
{
  me: {email|"backup", role, units:[...]}, server_time, current_month,
  config: { limit_mode, stock_required, deadline_day, fy_current, budget_op, budget_pp, budget_total },
  pcus: [ {code,name,print_name,group, pin_locked_until|null, pin_fail, pin_custom:bool} ],
  form: {id,fy,created_at,note,steps}, form_versions: [ {id,fy,created_at,created_by,note} ],     // form = latest of fy_current (incl. closed pages, §5.2)
  plans:  { pcu: { code: [plan_op, plan_pp] } },                       // fy_current
  plan_totals: { fy, op, pp, total },                                  // Σ plan × price (latest form of fy_current), 2 decimals
  stats:  { fy: <fy_current-1>, data: { pcu: { code: [median_m, p90_m, annual_qty] } } },   // basis for limits/reset
  limits: { pcu: { code: {limit_month, limit_year, source, updated_by, updated_at, note} } },   // fy_current
  unlocks: [ {pcu, item_code, month, reason, by, at} ],                // all rows with month in fy_current
  hidden: { pcu: [code] },
  prev: { "2569": { months:["2025-10",...,"2026-09"], actual:{ pcu:{ code:{op:[12],pp:[12]} } }, plans:{ pcu:{code:[op,pp]} }, prices:{code:price} } },  // one entry per fy in actual_prev
  months: ["2026-10", ...],                                            // months having any request, newest first
  rounds: [RoundInfo],                                                 // union(current, previous, months with requests, rounds rows) newest first
  users: [ ...adminUsersList ] , users_source: "table"|"env"           // admin only
}
RoundInfo = { month, fy, deadline_date, deadline_source, locked:bool, locked_at, locked_by, note }
```
`deadline_date` = `rounds.deadline_date` if set, else `config.deadline_day` (clamped to the month length), else the last day of the month.

## 6. `GET /api/export.xlsx?month=YYYY-MM | fy=2570 &token=…` (admin or dispenser)
`Content-Disposition: attachment; filename*=UTF-8''เบิกวัสดุ_2026-10.xlsx` (or `เบิกวัสดุ_ปีงบ2570.xlsx`). Errors: HTTP 400/401/403 with the usual JSON body.
Three sheets (Thai headers): **รายบรรทัด** (one row per line with op+pp>0 or issued data: เดือน · รพ.สต. · หน้า · รหัส · รายการ · หน่วย · ราคา(snapshot, else form price) ·
OP · PP · รวม · เป็นเงิน · จ่ายจริง OP/PP/รวม · เหตุผล · สถานะ · เวลาส่ง(Bangkok) · form version; all statuses) ·
**รพ.สต. × รายการ** (rows = items, columns = 15 PCUs + รวม; block 1 = ขอ, block 2 below = จ่ายจริง (0 in 2a); submitted/issued only) ·
**สรุปเงินต่อ รพ.สต.** (แผน OP/PP/รวม of the fy × form price · ขอ OP/PP/รวม (price_snapshot) · จ่ายจริง OP/PP/รวม · ส่วนต่าง = แผนรวม − ขอรวม; submitted/issued only).

## 7. `POST /api/cron/backup` (header `X-Backup-Key == env.BACKUP_KEY`)
Dumps every table to R2 `backup/YYYY-MM-DD.json` (Bangkok date) = `{exported_at, schema_version, tables:{name:[rows]}}`, deletes `backup/*` older than 90 days.
HTTP 403 on wrong/missing key (or `BACKUP_KEY` unset). `{ok:true,data:{key,size,deleted}}`. Called nightly by `.github/workflows/backup.yml`
(cron `0 19 * * *` UTC; repo secret `BACKUP_KEY`, repo variable `SITE_URL`). `GET /api/pdf/:id` → HTTP 501 (2b).

## 8. D1 schema as implemented (`functions/_lib/db.js`, migration v1)
Base = spec §3.3 verbatim. **Additions** (all documented here): `pcus.pin_custom`; `form_versions.data_hash`;
`requests.submit_count`; `limits.note`; table `prices_prev(fy,item_code,price)`; `schema_version` holds one row per applied migration (`MAX(v)` = current).
```
config(key PK, value)                     -- value = JSON text (e.g. "0", "\"warn\"", "null"); secrets: backup_pw_hash/salt, backup_version, backup_fail, backup_locked_until
schema_version(v)
users(email PK, role 'admin'|'dispenser', units JSON, added_at, added_by)
pcus(code PK, name, print_name, "group", pin_hash, pin_salt, pin_version, pin_fail, pin_locked_until, pin_custom)
form_versions(id PK AUTOINCREMENT, fy, created_at, created_by, note, data JSON, data_hash)   -- data = FORMAT.md `form` object {fy,note,steps}
rounds(month PK, fy, deadline_date, locked, locked_at, locked_by, note)
requests(id PK 'PCU01_2026-10', pcu, month, status, form_version_id, submitter_name, last_step, created_at, updated_at,
         first_submitted_at, submitted_at, submit_count, admin_note, admin_note_at, issued_seen_at)   UNIQUE(pcu,month)
request_lines(request_id, item_code, stock, op, pp, price_snapshot, updated_at,
              issued_total, issued_op, issued_pp, issue_reason, issue_note, issued_at, issued_by)    PK(request_id,item_code)
issue_status(request_id, dispense_unit, done_at, done_by)   PK(request_id,dispense_unit)
hidden_items(pcu, item_code, hidden_at, by)                 PK(pcu,item_code)
limits(fy, pcu, item_code, limit_month, limit_year, source, updated_by, updated_at, note)   PK(fy,pcu,item_code)
limit_unlocks(pcu, item_code, month, reason, by, at)        PK(pcu,item_code,month)
plans(fy, pcu, item_code, plan_op, plan_pp)                 PK(fy,pcu,item_code)
actual_prev(fy, month, pcu, item_code, op, pp)              PK(fy,month,pcu,item_code)
prices_prev(fy, item_code, price)                           PK(fy,item_code)
stats(fy, pcu, item_code, median_m, p90_m, annual_qty)      PK(fy,pcu,item_code)
pdf_files(request_id, content_key, r2_key, created_at)      PK(request_id,content_key)
audit_log(id PK AUTOINCREMENT, ts, actor, role, action, pcu, month, detail)
```
- Migrations run automatically at the start of each request when `schema_version` is behind (cached per isolate). They must be idempotent.
- Multi-statement writes use `DB.batch()`; bulk inserts are chunked (≤ 100 statements per batch, ≤ 100 bound params per statement — D1 limits).
- `form_versions.data` items: `active` defaults to true, `dispense_unit` defaults from the step code (P* = พัสดุ, CS = จ่ายกลาง, LAB = LAB) when a seed omits them.

## 9. Environment
| name | use |
|---|---|
| `TOKEN_SECRET` | HMAC key (required) |
| `GOOGLE_CLIENT_ID` | tokeninfo `aud` check |
| `ADMIN_EMAILS` | comma list; admins while `users` is empty |
| `BACKUP_KEY` | `X-Backup-Key` for `/api/cron/backup` |
| `CF_ACCOUNT_ID`, `CF_BR_TOKEN` | Browser Rendering (2b) — unused in 2a |
| `DEV_FAKE_GOOGLE=1` | **local only**: `dev:<email>` id_tokens + `devReset` |
Bindings: `DB` (D1 `pcu-supply`), `FILES` (R2 `pcu-supply-files`). Local values: `.dev.vars` (gitignored; template `.dev.vars.example`).

## 10. Local dev & tests
```
npm install
cp .dev.vars.example .dev.vars          # once
npm run dev                             # wrangler pages dev public --local --port 8788  (D1/R2 under .wrangler/state)
npm test                                # node tools/test_api.mjs   → http://localhost:8788 (override with API_BASE=...)
```
`npm test` uses a server already listening on `API_BASE`; if none is reachable it starts `wrangler pages dev` itself with a throw-away
`--persist-to .wrangler/test-state` and stops it at the end. In both cases the suite calls `devReset` first (clean D1), then imports the
fixture (`seed/seed_2570.json` if present, else a synthetic seed built from `public/data/form2569.json`). Two-terminal flow: terminal 1 `npm run dev`, terminal 2 `npm test`
(**this wipes the dev database**; use `API_BASE` against a throw-away instance if you have data you want to keep).
