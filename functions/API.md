# API contract — phase 2a (Cloudflare Pages Functions + D1 + R2)

Spec: `../../phase 2.md` (§1, §3, §4.3, §5). Supersedes `apps-script/API.md` (phase 1.5). Import format: `../seed/FORMAT.md`.
This file is the single contract between the backend (`functions/**`), the PCU frontend and the admin frontend.
Nothing is reserved any more: 2b PDF, 2c issuing, 2d form editor and 2e fiscal-year rollover are all live.

## 1. Transport
- `POST /api` — body JSON `{ "action": "<name>", "token": "<token|omit>", ...params }`. Content-Type may be `text/plain` (no CORS preflight,
  what `js/api.js` sends) or `application/json`. Same-origin only (no CORS headers).
- Response is **always HTTP 200**: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": { "code", "message": "<Thai>", ...extra } }`.
  (Exceptions: `GET /api/export.xlsx`, `GET /api/pdf/:id` and `POST /api/cron/backup` use real HTTP status codes because they are not called through `api.js`.)
- `GET /api` → `{ok:true,data:{service:"pcu-supply",time}}` (health check, no DB access).
- Error codes: `BAD_REQUEST` · `AUTH_REQUIRED` · `AUTH_EXPIRED` · `FORBIDDEN` · `BAD_PIN{remaining}` · `PIN_LOCKED{until}` ·
  `BAD_PASSWORD{remaining}` · `LOCKED{until}` (backup password) · `NOT_FOUND` · `CONFLICT` · `INCOMPLETE{missing:[item_code]}` ·
  `OVER_LIMIT{items:[{code,total,limit_month,limit_year,used_fy}]}` · `PDF_UNAVAILABLE` · `PDF_FAILED{detail}` · `PDF_QUOTA{detail,usage}` (2b-R, §6b) · `NOT_IMPLEMENTED` · `SERVER_ERROR`.
- Times: ISO 8601 UTC strings (`2026-10-06T08:00:00.000Z`); display in Asia/Bangkok. Month keys: CE `"YYYY-MM"`.
  Dates (`deadline_date`): `"YYYY-MM-DD"` (a Bangkok calendar date).
- **Rounds (brief 2j).** A round is keyed by the month the supplies are *for* ("ขอเบิกเดือน X"); it is filled and submitted during the month
  before (X−1). `calMonth` = the Bangkok calendar month at request time (`currentMonth()`, honours `X-Dev-Month` in dev) ·
  **`currentRound` = `nextMonth(calMonth)`** (open for keying) · **`prevRound` = `calMonth`** (still editable). PCU home = currentRound + prevRound.
  A round "exists" implicitly; `rounds` rows are created lazily when an admin sets a deadline / lock / note.
- Fiscal year (พ.ศ.) of a round = FY of its submission month: `monthFy(m) = fy(prevMonth(m))` with `fy(c) = CE_year + (c.month >= 10 ? 1 : 0) + 543`
  → round `2026-11` = FY2570 (the first round of 2570) · round `2026-10` = FY2569. `fyMonths(fy)` = the 12 **round** months: FY2570 = `2026-11` … `2027-10`.
  `fyExcelMonths(fy)` = the old calendar list Oct … Sep (`2025-10` … `2026-09` for 2569) — used **only** for imported/Excel-shaped data
  (`actual_prev`, `stats`, seed import/export, `adminBootstrap.prev[fy].months`). `config.fy_current` defaults to `monthFy(currentRound)`.
- **Trial round** (2j): `config.trial_month` (`"YYYY-MM"` or `null`) marks one round as practice only → every RoundInfo has `trial: month === trial_month`.
  Nothing else changes for it (it can be submitted; its data stays in its own fy).
- Removed (1.5) actions return `BAD_REQUEST` with a Thai hint: `submit`, `withdraw` (use `saveLines{send:true}`; no withdraw),
  `adminReceive`, `adminReturn` (→ `adminNote`), `adminSetMode` (→ `adminSetLimitMode`). Unknown action → `BAD_REQUEST`.

## 2. Tokens
`base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, env.TOKEN_SECRET))` (same format as 1.5; `exp` is epoch **ms**).
- PCU: `{t:"pcu", pcu, v:<pcus.pin_version>, exp}` — 7 days. Valid only while `v == pcus.pin_version` (a PIN change invalidates — `adminSetPin`, or the PCU's own `pcuChangePin` (2k), which bumps `pin_version` the same way so every other token of that PCU → `AUTH_EXPIRED` "PIN ถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่"; only the token returned by `pcuChangePin` carries the new `v`).
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
  `first_submitted_at` (once), `submit_count++`, `form_version_id` = `formForFy` of the round's fy (§4.1 form fallback), `price_snapshot` on every line.
  Re-submit overwrites. No withdraw.
- `edited_after_submit = (updated_at > submitted_at)` (request has autosaved edits after its last submit). Submit sets both to the same `now`.
- Not editable (`CONFLICT`): round locked (`rounds.locked=1`) · **2c**: a changed line belongs to a step whose `dispense_unit` has an `issue_status` row ("หน้า … ถูกจ่ายแล้ว"; saving the same values again is fine).
- `issued` (2c, §5.3): set when every dispense unit that has requested lines is marked done (`issueDone`); undoing a unit sets it back to `submitted`.
- Admin note (`admin_note`) never changes status.

## 4. PCU actions
| action | params | data |
|---|---|---|
| `pcuList` (public) | – | `{pcus:[{code,name,print_name,group}]}` |
| `pcuLogin` (public) | `pcu, pin` | `{token, exp, pcu:{code,name,print_name,group}, bootstrap:<pcuBootstrap>}` · `BAD_PIN{remaining}` · `PIN_LOCKED{until}` · `NOT_FOUND` |
| `pcuChangePin` (2k) | `old_pin, new_pin` (strings, 5 digits each) | `{token, exp}` — new PCU token (new `pin_version`) for this device; the client must replace its stored token. Success = new salt, `pin_version++`, clears fail/lock, `pin_custom=1`, audit `pcuChangePin` "ok" (actor = PCU code, role `pcu`) · `BAD_REQUEST` "กรอก PIN เดิมและ PIN ใหม่ให้ครบ 5 หลัก" (either not `^[0-9]{5}$` / not a string) · `BAD_REQUEST` "PIN ใหม่ต้องต่างจาก PIN เดิม" (`new_pin === old_pin`, before any DB access) · `BAD_PIN{remaining}` "PIN เดิมไม่ถูกต้อง" · `PIN_LOCKED{until}` — wrong old PIN shares `pcuLogin`'s counter/lock (`pin_fail`, `pin_locked_until`; 5 failures → 5-min lock; audit `bad_pin fail=<n>` / `locked`) |
| `pcuBootstrap` | – | see §4.1 |
| `pcuGetMonth` | `month` (`> currentRound` → `BAD_REQUEST` "เดือนนี้ยังไม่ถึง") | one `byMonth` entry (§4.1) + `round` + `unlocks` — for "older months" · + `form` (the request's bound version, PCU-stripped) **only when** it differs from the latest of `fy_current` (2d) |
| `saveLines` | `month, lines:{code:{stock,op,pp,updated_at}}, last_step?, submitter_name?, send?:true` | `{saved_at, status, request, submitted:bool, over_limit:[...] }` |
| `setHidden` | `codes:[item_code]` (full replacement) | `{hidden:[...]}` |
| `pcuAck` | `month` | `{issued_seen_at}` (acknowledge the issue notice; `NOT_FOUND` if no request) |
| `requestPdf` | `month, doc_date?, supply_month?` | §6b — PDF of this PCU's own request (`token.pcu`): `{status:"ready",url,filename,content_key}` or `{status:"pending",retry_after}`; 2h print options §6b |
| `printData` (public, print token) | `k` | §6b — `{pcu:{code,name,print_name,group}, month, form, request:RequestObj(+lines, PCU shape), hidden:[code], doc_date, supply_month}` for `print.html` |
| `issueLines`, `issueAll`, `issueDone`, `issueItem`, `adminItemIssue` | – | staff actions (admin or dispenser), not PCU — §5.3 |

`saveLines` rules
- `month`: `YYYY-MM`, must be `currentRound`, `prevRound` (= calMonth), or a month where this PCU already has a request; never later than
  `currentRound` (`BAD_REQUEST` "ยังไม่ถึงรอบเดือนนี้"); otherwise `BAD_REQUEST` "เดือนนี้ไม่เปิดให้กรอก". Item codes are checked against the latest
  form of the round's fy via `formForFy` (+ the bound version).
- Values: integer 0–99999 or `null`. Per-line **last-write-wins** (done in SQL): a line is written only if its `updated_at` is **strictly newer**
  than the stored one (equal = idempotent retry → no-op; missing `updated_at` = now). Item codes must exist in the latest form (or the request's bound version) else `BAD_REQUEST`.
- Request `updated_at` is bumped only when at least one line actually changed (an all-stale or empty call is a no-op for `edited_after_submit`).
  `last_step` / `submitter_name` are stored when present.
- Autosave is **not** written to `audit_log` (would flood it); `send:true` is (`submit`).
- `send:true`, in order: round locked → `CONFLICT` · `config.stock_required=1` → every non-hidden **active** item of the latest form needs `stock`
  else `INCOMPLETE{missing}` · `limit_mode="enforce"` → per line `total=op+pp`: over if `total > limit_month` or `used_fy + total > limit_year`
  (limits of the round's fy — a round whose fy has no `limits` rows, e.g. the trial round 2026-10 = FY2569, never warns; skipped for items with a
  `limit_unlocks` row for (pcu,item,month)) → `OVER_LIMIT{items}`.
  Lines saved earlier in the same call stay saved (it is autosave + submit). `warn` mode: submit succeeds and the same list is returned as `over_limit`.
  `off`: `over_limit:[]`.

### 4.1 `pcuBootstrap` data
```
{
  server_time, current_month,                // current_month = calMonth (kept for compatibility)
  current_round,                             // 2j: nextMonth(calMonth) — the round open for keying (= rounds[0].month)
  pcu: {code,name,print_name,group,pin_custom},  // 2k: pin_custom bool — false while the PCU still uses the default PIN
  config: { limit_mode:"off"|"warn"|"enforce", stock_required:0|1, deadline_day:int|null, fy_current:2570, trial_month:"YYYY-MM"|null },
  form_version_id: 12,
  form: { id, fy, created_at, note, steps:[ {code,order,sheet,page_no,title,subject,to,dispense_unit,active?,rows:[
            {type:"section",title} | {type:"item",code,seq,name,unit,price,active} ]} ] },     // latest version of fy_current; steps with active:false are STRIPPED (2d)
  forms: { "11": <form, same shape, PCU-stripped> },   // 2d: for every shown (byMonth) request whose form_version_id is set and ≠ form_version_id — the version it was submitted on ({} when none)
  rounds: [ RoundInfo ],                     // [currentRound, prevRound] (§5.1 RoundInfo, incl. trial)
  next_round: { ...RoundInfo, opens_on:"2026-12-01" },  // 2l: preview of nextMonth(currentRound) (not writable yet); opens_on = `${currentRound}-01`
  history: [ {month, fy, trial, locked,      // 2l: EVERY round month m with fyMonths(F-1)[0] <= m < prevRound (F = monthFy(currentRound)), newest first,
     status:"not_started"|"draft"|"submitted"|"issued", submitted_at|null} ],  //  ≤ 23 entries; "not_started" = no request row (replaces older_months; no lines)
  hidden: [item_code],
  never_prev: [item_code],                   // items of the form this PCU never withdrew in FY(fy_current-1) per actual_prev ([] if no history for this PCU)
  limits: { code: [limit_month|null, limit_year|null] },     // fy_current
  plans:  { code: [plan_op, plan_pp] },                      // fy_current
  unlocks:{ "2026-11": { code: "<reason>" } },               // for the 2 shown rounds
  byMonth: { "2026-11": {                                    // for the 2 shown rounds (also returned by pcuGetMonth)
      request: RequestObj | null,
      used_fy: { code: qty },        // Σ(op+pp) of this PCU's submitted/issued requests in the round's fy (fyMonths = Nov … Oct rounds), excluding that round
      prev_lines: { code: {op,pp} }, // from the previous round's (prevMonth(month)) submitted/issued request (only op+pp>0); {} if none
      issue: null | IssueInfo        // 2c; null until >= 1 unit is marked done (PCU view, see below)
  } },
  issue_notices: [ {month, complete, incomplete} ]   // status 'issued' requests with issued_seen_at null (notice bar) — cleared by pcuAck
}
RequestObj = { id, pcu, month, status, form_version_id|null, submitter_name, last_step, created_at, updated_at,
               first_submitted_at|null, submitted_at|null, submit_count, admin_note|null, admin_note_at|null, issued_seen_at|null,
               edited_after_submit:bool, lines: { code: {stock,op,pp,updated_at} },
               issued?: { code: {total,op,pp,reason:"out_of_stock"|"other"|null,note:string|null} } }   // issued: PCU view only, see below
IssueInfo = { units_total, units_done, done:bool, complete, incomplete, issued_seen_at|null,
              units: { "พัสดุ"|"จ่ายกลาง"|"LAB": {needed:bool, done:bool, done_at|null, done_by|null, lines:n, issued_lines:n} } }
```
PCU-side lines never include price/issued fields (Q78).
Form fallback (2j `formForFy(DB, fy, fyCurrent)`): when nothing is bound, a round resolves against the latest version of its own fy, else the latest
version of `fy_current`, else the newest version of any fy (so the trial round 2026-10 = FY2569, which has no form, uses the FY2570 form). Used by
`saveLines`, `adminRequests`, `adminGetRequest`, the issue actions, `printData` and the export.

**IssueInfo** (2c). `needed` = the unit has >= 1 requested line (`op+pp > 0`); `lines` = its requested lines, `issued_lines` = those with an `issued_total`;
`units_total` = number of needed units, `units_done` = needed units with an `issue_status` row, `done` = `units_total > 0 && units_done == units_total`;
`complete` / `incomplete` = lines with `issued_total >= requested` / `< requested` (lines with no figure count in neither). `units` always has all three keys
(the `dispense_unit` names). The whole object is `null` when the request has no requested line.
- **Staff view** (`adminRequests[].issue`, `adminGetRequest.issue`, `issue*` responses): counts cover every unit; `done_at` / `done_by` (e-mail) filled for done units.
- **PCU view** (`byMonth[m].issue`, `pcuGetMonth`): `null` until >= 1 unit is done; then the counts, `issued_lines` and `done_at` only cover **done units** (figures of units still being handled are
  not leaked) and `done_by` is always `null`. `units[u].done` is what the fill page uses to lock the pages of issued units (the server enforces it: `saveLines` -> `CONFLICT`).
- **`request.issued`** (PCU view only; present only when the request has >= 1 `issue_status` row): `{ code: {total, op, pp, reason, note} }` for requested lines of **done units** that have a figure
  (`op`/`pp` = the OP-first split of `total`). `request.lines` stays exactly as the PCU filled it (Q78); issued figures never feed limits / `used_fy` / `prev_lines`.

## 5. Admin / dispenser actions
Admin = all. **Dispenser** may call only `adminBootstrap` (reduced), `adminRequests`, `adminGetRequest`, `adminRequestPdf`, the issue actions of §5.3 (`issueLines`, `issueAll`, `issueDone`, `issueItem`, `adminItemIssue`; own units + time window only),
`GET /api/export.xlsx`, `GET /api/pdf/:id`; everything else `FORBIDDEN`.
`adminLoginGoogle` / `adminLoginBackup` are public.

| action | params | data |
|---|---|---|
| `adminLoginGoogle` | `id_token` | `{token, exp, email, role, units}` · `FORBIDDEN` if not a user |
| `adminRequestPdf` (admin or dispenser) | `pcu, month, doc_date?, supply_month?` | §6b — same result as `requestPdf` for that PCU's request |
| `adminLoginBackup` | `password` | `{token, exp, role:"admin"}` · `BAD_PASSWORD{remaining}` · `LOCKED{until}` · `NOT_FOUND` if none set |
| `adminBootstrap` | – | §5.1 |
| `adminRequests` | `month?` (omitted = `[currentRound, prevRound]`) | `{requests:[RequestObj without lines + pcu_name + progress + issue], rounds:[RoundInfo], server_time, current_month (calMonth), current_round}` · `progress={items_requested, stock_filled, lines, qty_op, qty_pp, baht, last_step}` · `issue` = IssueInfo (§4.1) or `null` when the request has no requested line (2c) |
| `adminGetRequest` | `pcu, month` | `{request: RequestObj(+price_snapshot & issued_* per line)|null, issue: IssueInfo|null, pcu:{...}, hidden:[code], form_version_id, form:{id,fy,created_at,note,steps}}` (form = version bound to the request, else `formForFy` of the round's fy, §4.1). A **dispenser** only gets the lines of items on pages of its own `units` (`issue` is still computed over all lines/units). `issued_*` per line = `issued_total, issued_op, issued_pp, issue_reason, issue_note, issued_at, issued_by` (all `null` until issued). |
| `issueLines` (staff) | `pcu, month, lines:{code:{issued_total:int\|null, reason?:"out_of_stock"\|"other"\|null, note?:string\|null}}` | `{request: RequestObj(admin view), issue: IssueInfo}` — §5.3 |
| `issueAll` (staff) | `pcu, month, unit?` | same — every requested line of the unit(s) = requested qty — §5.3 |
| `issueDone` (staff) | `pcu, month, unit, done:0\|1` | same — §5.3 |
| `issueItem` (staff) | `month, item_code, entries:{pcu:{issued_total, reason?, note?}}` | `{updated:[pcu], skipped:[{pcu, why}]}` — §5.3 |
| `adminItemIssue` (staff) | `month, item_code` | `{item:{code,name,unit,price,dispense_unit,step,step_title}, rows:[{pcu,pcu_name,status,op,pp,requested,issued_total,issued_op,issued_pp,reason,note,unit_done}], form_version_id}` — §5.3 |
| `adminNote` | `pcu, month, note` (empty/blank clears) | `{request}` — creates a `draft` row if none; status unchanged |
| `adminSetRound` | `month, deadline_date: "YYYY-MM-DD"\|null, note?` | `{round}` (null clears the per-round override; `note` only touched when the key is present) |
| `adminLockRound` | `month, locked:0\|1` | `{round}` |
| `adminSetLimitMode` | `mode:"off"\|"warn"\|"enforce"` | `{config}` |
| `adminSetConfig` | `key, value` — keys: `stock_required`(0/1) `budget_op` `budget_pp` `budget_total` (number ≥ 0) `deadline_day`(int 1–31 \| null) · 2j `trial_month` (`"YYYY-MM"` \| `null`/`""` = no trial round; else `BAD_REQUEST`) · 2b-R R2 caps `r2_max_bytes` `r2_max_class_a` `r2_max_class_b` (int ≥ 1, numeric string ok \| `null`/`""` = default; else `BAD_REQUEST`) | `{config}` (effective caps included) |
| `adminSetLimit` | `pcu, code, limit_month, limit_year` (int ≥ 0 \| null) | `{limit}` (source `admin`) |
| `adminResetLimit` | `pcu, code` | `{limit\|null}` recomputed per FORMAT.md rule from `plans[fy_current]` / `stats[fy_current-1]` (row removed if nothing) |
| `adminLimitsUpload` | `rows:[{pcu_code,item_code,item_name?,limit_month,limit_year,note?}], fy?, mode?:"merge"\|"replace", dry_run?:bool` | `{errors:[{row,pcu_code,item_code,error}], warnings:[...], changes:[{pcu,item_code,old:[m,y]\|null,new:[m,y]\|null}], added, updated, deleted, applied:bool}` — rules of `limit_upload_format.md` §2/§3 (`CLEAR` in merge mode; blank = untouched in merge). Valid rows are applied unless `dry_run`. Row number = index+2 unless row has `row`. A pair duplicated in the file gets one `errors` entry per row (rows that already carry another error are not listed twice). |
| `adminUnlockLimit` | `pcu, item_code, month, reason` (reason required) | `{unlock}` |
| `adminRemoveUnlock` | `pcu, item_code, month` | `{ok:true}` |
| `adminPcuAdd` (2n, admin only) | `code, name, print_name?, group?` — code trim+uppercase, `^[A-Z0-9][A-Z0-9_-]{1,11}$` · name trim 1–60 · print_name trim ≤ 80, blank → = name · group blank/absent → `"ทั่วไป"`, else one of `PCU_GROUPS` (§5.1); else `BAD_REQUEST` · code exists → `CONFLICT` "มีรหัสนี้แล้ว" | `{pcu:{code,name,print_name,group}}` — same INSERT as `adminImportSeed` (PIN `12345`, new salt, `pin_version 1`, `pin_custom 0`, `login_count 0`) + audit `adminPcuAdd` (pcu = code, detail = name), one batch |
| `adminPcuEdit` (2n, admin only) | `code, name?, print_name?, group?` — only keys sent are changed (`print_name:""` = set to name); same validation as add · code is the PK and cannot change | `{pcu}` · `NOT_FOUND` · nothing actually changes → `BAD_REQUEST` · never touches `pin_*` / `login_*` · audit `adminPcuEdit` detail = JSON `{name?:[old,new], print_name?:[old,new], group?:[old,new]}` |
| `adminSetPin` | `pcu, pin` (5 digits) | `{ok:true}` (new salt, `pin_version++`, clears fail/lock, `pin_custom=1`) |
| `adminUnlockPin` | `pcu` | `{ok:true}` |
| `adminSetHidden` | `pcu, codes` (full replacement) | `{hidden}` |
| `adminSetBackupPassword` | `password` (≥ 8) — **Google admin only** | `{ok:true}` (`backup_version++` invalidates backup sessions) |
| `adminUsersList` | – | `{users:[{email,role,units,added_at,added_by}], source:"table"\|"env"}` |
| `adminUsersAdd` | `email, role:"admin"\|"dispenser", units:["พัสดุ"\|"จ่ายกลาง"\|"LAB"]` (dispenser needs ≥ 1; upsert; demoting the last admin → `CONFLICT`) | `{users}` |
| `adminUsersRemove` | `email` | `{users}` · refuses to remove the last admin (`CONFLICT`) |
| `adminImportSeed` | `seed` (FORMAT.md JSON; every top-level key except `format`/`fy` is optional ⇒ may be sent in chunks), `set_current_fy?:bool` | `{imported:{pcus, form:"inserted"\|"same"\|"skipped_differs"\|"none", plans, actual_rows, prices_prev, stats, limits_inserted, limits_kept_admin, config_set:[key]}, warnings:[...]}` — idempotent, rules in FORMAT.md |
| `adminClearTrial` | `confirm:"ล้างข้อมูล"`, `month?:"YYYY-MM"` (2j) | `{deleted_requests, deleted_lines, deleted_issue_status, deleted_pdf_files, month?}` — only those tables (+R2 PDFs listed in `pdf_files`). Without `month`: every round. With `month` (bad format → `BAD_REQUEST`): only the `requests` of that round and their `request_lines` / `issue_status` / `pdf_files` rows + R2 objects; the response echoes `month`. Audit `adminClearTrial` (month column = the month or "") |
| `adminBackupNow` | – | `{key, size, deleted:[old keys], pdf_pruned:[r2 keys]}` (same as the cron endpoint, §7) |
| `adminPdfFiles` (admin only) | `pcu?` (filter) | `{files:[{pcu, pcu_name, month, content_key, created_at, bytes\|null, url}] (newest first), total_files, total_bytes, rule, usage}` — §6b.1 |
| `adminPdfPrune` (admin only) | – | `{deleted:[r2_key], bytes}` — runs the retention rule for all PCUs now (§6b.1; audit `pdf_prune` reason=admin when ≥ 1 file). Confirm dialog = UI's job |
| `adminAuditLog` | `limit?` (default 100, max 500), `before?` (audit id → older rows) | `{entries:[{id,ts,actor,role,action,pcu,month,detail}], next_before:id\|null}` |
| `adminFormGet` | `id` | `{form:{id,fy,created_at,created_by,note,steps}}` of any version (steps incl. closed pages) · `NOT_FOUND` — §5.2 |
| `adminFormSave` | `base_version_id:int, note?:string(≤200), form:{steps:[...]}` | `{saved:true, form, versions, diff}` or `{saved:false, same:true, form, versions}` — new form version, §5.2 |
| `adminExportSeed` | `fy?` (default `config.fy_current`) | `{seed:<seed/FORMAT.md object>}` — the live DB in import format, §5.2 |
| `adminImportPreview` | `seed` (FORMAT.md object; `form` + `plans[fy]` required, the rest optional) | `{fy, fy_current, mode:"rollover"\|"same_fy", summary, warnings:[...]}` — **no writes**, §5.3 |
| `adminImportApply` | `seed`, `confirm:"เปิดปีงบ <fy>"` | opens the new fiscal year (rollover only) → `{fy_current, imported:<adminImportSeed result>, rollover:{actual_rows, stats_rows, prices_rows, limits_rows, form_version_id}, warnings}` — §5.3 |
| `devReset`, `devPutBackup{key}`, `devListBackups`, `devListFiles{prefix}`, `devPrintToken{pcu,month,doc_date?,supply_month?}`, `devSetRequestMonth{pcu,month,new_month}` (public, only if `env.DEV_FAKE_GOOGLE==="1"`, else `FORBIDDEN`) | – | tests only: `devReset` drops every table and recreates the schema → `{ok:true}`; `devPutBackup` writes a dummy `backup/YYYY-MM-DD.json` to R2 (to test the 90-day prune); `devListBackups` → `{keys,sizes}`; `devListFiles` → `{keys}` of R2 objects under `prefix` (2b: `pdf/`); `devPrintToken` → `{token,content_key}` a fresh print token for a sent request; `devSetRequestMonth` (2b-R) back-dates a request → `{id}`: moves `requests.id`/`month` and re-points `request_lines`, `issue_status`, `pdf_files.request_id` (R2 objects and `pdf_files.r2_key` stay as stored) · `NOT_FOUND` (no request) · `CONFLICT` (target exists) · `BAD_REQUEST` (month). None of the dev actions is counted in `usage_counters` |
| header `X-Dev-PDF: pending\|fail` | – | only honoured in PDF mock mode (`DEV_FAKE_GOOGLE==="1"` and no `CF_BR_TOKEN`) on `requestPdf`/`adminRequestPdf`: simulates a Browser Rendering 429 (`pending`, `retry_after` 2) or an error (`PDF_FAILED`) |
| header `X-Dev-Month: YYYY-MM` | – | only honoured when `DEV_FAKE_GOOGLE==="1"` (POST /api and the export): overrides "the current Bangkok month" (= calMonth; currentRound = the month after it) so tests do not depend on the real date |

All mutating admin/PCU actions (except autosave) append to `audit_log` in the same D1 batch.

### 5.1 `adminBootstrap` data (admin; dispenser gets only `me, server_time, current_month, current_round, config(limit_mode, stock_required, deadline_day, fy_current, trial_month), pcus(code,name,print_name,group), form, form_versions, rounds, months`)
```
{
  me: {email|"backup", role, units:[...]}, server_time, current_month, current_round,   // current_month = calMonth · current_round = nextMonth(calMonth) (2j)
  config: { limit_mode, stock_required, deadline_day, fy_current, trial_month, budget_op, budget_pp, budget_total,
            r2_max_bytes, r2_max_class_a, r2_max_class_b },              // R2 caps = effective values (defaults applied), §6b.1
  pcus: [ {code,name,print_name,group, pin_locked_until|null, pin_fail, pin_custom:bool, login_count:int, last_login_at:iso|null} ],   // login_* = successful pcuLogin only (2m)
                                                                       // group ∈ "ทั่วไป" | "พิเศษ" | "ทดลอง" (2n, auth.js PCU_GROUPS; legacy rows may be null).
                                                                       // "ทดลอง" (TRIAL_GROUP) = sandbox PCU for outsiders/admin trials (e.g. PCU00): still listed, can log in and
                                                                       // submit, still shown in status/issue tables with a tag — but NOT counted in totals, budget, Excel export,
                                                                       // default-PIN / never-logged-in warnings or the "ส่งแล้ว n/N" counter (frontend filters; export filters server-side)
  form: {id,fy,created_at,note,steps}, form_versions: [ {id,fy,created_at,created_by,note} ],     // form = latest of fy_current (incl. closed pages, §5.2)
  plans:  { pcu: { code: [plan_op, plan_pp] } },                       // fy_current
  plan_totals: { fy, op, pp, total },                                  // Σ plan × price (latest form of fy_current), 2 decimals
  stats:  { fy: <fy_current-1>, data: { pcu: { code: [median_m, p90_m, annual_qty] } } },   // basis for limits/reset
  limits: { pcu: { code: {limit_month, limit_year, source, updated_by, updated_at, note} } },   // fy_current
  unlocks: [ {pcu, item_code, month, reason, by, at} ],                // all rows with month in fyMonths(fy_current) (round months Nov … Oct)
  hidden: { pcu: [code] },
  prev: { "2569": { months:["2025-10",...,"2026-09"],   /* = fyExcelMonths(fy): Excel columns Oct … Sep, unchanged by 2j */ actual:{ pcu:{ code:{op:[12],pp:[12]} } }, plans:{ pcu:{code:[op,pp]} }, prices:{code:price} } },  // one entry per fy in actual_prev
  months: ["2026-10", ...],                                            // months having any request, newest first
  rounds: [RoundInfo],                                                 // union(currentRound, prevRound, months with requests, rounds rows) newest first
  users: [ ...adminUsersList ] , users_source: "table"|"env"           // admin only
}
RoundInfo = { month, fy, deadline_date, deadline_source, trial:bool, locked:bool, locked_at, locked_by, note }   // fy = monthFy(month); trial = month === config.trial_month
```
`deadline_date` = `rounds.deadline_date` if set, else `config.deadline_day` (clamped to the month length) **of the submission month `prevMonth(month)`**,
else the last day of `prevMonth(month)` (2j: round 2026-11 → `2026-10-31`; round 2026-10 → `2026-09-30`). `deadline_source` = `round|config|month_end`.

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
(every fy present; `actual_prev[fy].months` = `fyExcelMonths(fy)` — the 12 Excel columns Oct … Sep, 12-element `op`/`pp` arrays) , `limits` (`fy` only; `[limit_month, limit_year, source]`, `admin` rows included),
`config` (fy_current, limit_mode, stock_required, budget_op/pp/total, deadline_day). No `verify` block. Re-importing it is a no-op: `form:"same"`, `limits_inserted:0`
(the importer skips a limits row identical to the stored one), every table keeps its row count, and export → import → export is a fixed point.

### 5.3 Issuing — บันทึกจ่ายจริง (2c) — `issueLines` · `issueAll` · `issueDone` · `issueItem` · `adminItemIssue`
Who: admin, or a dispenser (role `dispenser`, `units` subset of {พัสดุ, จ่ายกลาง, LAB}). The unit of a line = `dispense_unit` of the form step that holds its item, resolved on the form version
**bound to the request** (`form_version_id`, else `formForFy` of the round's fy). Round lock does **not** block issuing.
- **Request** must exist with status `submitted` or `issued` -> else `NOT_FOUND` "ยังไม่ได้ส่งใบเบิก". Only lines with `op+pp > 0` ("requested") can be issued -> else `BAD_REQUEST`; unknown code -> `BAD_REQUEST`.
- **Dispenser limits**: every touched line's unit must be in its `units` else `FORBIDDEN`; writes allowed only while `calMonth <= request month` (2j: round m is dispensed in m−1 and m — until the end of the round month)
  else `FORBIDDEN` "หมดเวลาแก้ไขการจ่าย (แก้ได้ถึงสิ้นเดือนถัดไป)" — applies to undo (`done:0`) and `issueItem` too, never to reads (`adminItemIssue`). Admin (incl. backup login): unlimited.
- **Values**: `issued_total` = integer `0 … requested`, or `null` = clear the line (all `issued_*`, reason, note, `issued_at`, `issued_by` -> `null`). `> requested` -> `BAD_REQUEST` "จ่ายเกินขอไม่ได้ (ขอ n)";
  not an integer / `< 0` / key missing -> `BAD_REQUEST`. `issued_total < requested` -> `reason` in `out_of_stock` | `other` required; `other` needs a non-blank `note` (trimmed, <= 200 chars; `out_of_stock` may carry a note too);
  `issued_total == requested` -> `reason`/`note` stored as `null` (whatever was sent). Writes set `issued_at = now`, `issued_by` = actor e-mail (`"backup"` for the backup login).
- **OP-first split**: `short = op+pp - issued_total`; `issued_op = max(0, op - short)`; `issued_pp = pp - max(0, short - op)` (OP 10 / PP 5: 12 -> 7/5 · 15 -> 10/5 · 3 -> 0/3 · 0 -> 0/0).
- **All-or-nothing**: every line/entry is validated (permissions first) before anything is written; one bad line rejects the whole call. Each call = one D1 batch with its `audit_log` row(s).
- **Responses** of `issueLines` / `issueAll` / `issueDone`: `{request: RequestObj(admin view: price_snapshot + issued_* per line; a dispenser only gets its own units' lines), issue: IssueInfo}` after the write.

`issueLines{pcu, month, lines}` — up to 400 lines; audit `issue_lines` (detail `CODE=total(reason:note) …`).
`issueAll{pcu, month, unit?}` — sets every requested line of the unit(s) to `issued_total = requested` (overwrites shortfalls, reason/note -> `null`). `unit` omitted: dispenser = all of its units, admin = all three;
unit given: unknown name -> `BAD_REQUEST`, dispenser not owning it -> `FORBIDDEN`. Does not touch `issue_status`. Audit `issue_all`.
`issueDone{pcu, month, unit, done:0|1}` — `issue_status(request, unit)` = "this unit has finished issuing this request".
- `done:1`: the unit must have requested lines (else `BAD_REQUEST`); every still-`null` requested line of that unit gets `issued_total = requested` (default = ขอ; existing figures are kept); the row is inserted (`done_at`, `done_by`; idempotent).
  If **every needed unit** (units having requested lines) is now done and the status is `submitted` -> `requests.status = 'issued'`, `issued_seen_at = null` (re-arms the PCU notice).
- `done:0`: the row is deleted (figures stay); if the status was `issued` -> back to `submitted` (`submitted_at`, `first_submitted_at`, `updated_at` untouched). Same unit/time rules as marking done.
- While a unit is done, PCU `saveLines` cannot change its lines (`CONFLICT`, §3). Audit `issue_done` (detail `unit=… done=… filled=n status=…`).
`issueItem{month, item_code, entries:{PCU:{issued_total, reason?, note?}}}` — the per-item (network-wide) screen. The item must exist in the `formForFy` form of the month's fy (`BAD_REQUEST`), a dispenser must own its unit (`FORBIDDEN`),
<= 60 entries. Applies the rules above to each PCU's request of `month`. Entries that cannot apply are **skipped, not errors**: `{pcu, why}` with why = "ไม่พบ รพ.สต. นี้" · "ยังไม่ได้ส่งใบเบิก" ·
"ไม่ได้ขอรายการนี้" · (dispenser) the item sits on a unit it does not own in that request's bound form. A validation error in an applicable entry rejects the whole call. Does not change `issue_status`/status.
Audit `issue_item`, one row per updated PCU (`pcu`/`month` filled, detail `CODE=total(reason)`).
`adminItemIssue{month, item_code}` — read-only table for that screen: `item = {code,name,unit,price}` from the `formForFy` form of the month's fy + `dispense_unit` and `step` (step code, e.g. `"P1"`) / `step_title` of its page;
`rows` = one per PCU (ordered by code) whose `submitted`/`issued` request of `month` has the item requested: `op, pp, requested = op+pp`, `issued_total/issued_op/issued_pp` (`null` = not issued yet),
`reason`, `note` (= `issue_reason`/`issue_note`), `unit_done` = that request's unit for the item has an `issue_status` row. Dispenser: `FORBIDDEN` unless the item's unit is theirs. `form_version_id` = the latest form it resolved against.
### 5.4 Open a new fiscal year (2e) — admin only (dispenser/PCU/no token → `FORBIDDEN`/`FORBIDDEN`/`AUTH_REQUIRED`)
`adminImportPreview{seed}` shows what `adminImportApply{seed, confirm}` will do; both run the **same analysis** (one code path), so the preview is exactly the apply.
Validation (→ `BAD_REQUEST`, Thai message): the checks of `adminImportSeed` (format `pcu-supply-import/1`, integer `fy`, `pcus` rows, shape of `form` / `plans` / `prices_prev` /
`actual_prev` / `stats` / `limits`) **run up front** (`adminImportSeed` itself now also validates the whole file before its first write) + `form` and `plans[fy]` must exist ·
`form.fy`, when given, must equal `fy` + the form rules of the editor (§5.2: ≤ 10 active pages, ≤ 24 active items per page, ≤ 2 sections, unique page/item codes, code formats, lengths,
a page can be closed only without active items — messages start with "ฟอร์มในไฟล์:").
`mode`: `"same_fy"` when `seed.fy === config.fy_current` (apply is refused — `CONFLICT`, use `adminImportSeed`) · `"rollover"` when `seed.fy === fy_current + 1` · any other fy → `BAD_REQUEST`.

**The form that gets stored (rollover).** The file's form **plus every item of the latest form of `fy_current` that the file no longer lists, kept with `active:false`** in its original
page (a page the file dropped is kept as a closed page `active:false`) — items/pages are never deleted, so old request lines, stats and `actual_prev` keep resolving their codes.
Then it is normalised exactly like the editor (`order`, `page_no`, `item.seq` recomputed; prices rounded to 2 decimals); `note` = the file's `form.note` or `"เปิดปีงบ <fy>"`.
The preview's `summary.form` describes this stored form. In `same_fy` mode nothing is merged: the raw file form is hashed like `adminImportSeed` does.

`summary` = `{ pcus:{known:[code], new:[code], missing_in_file:[code]}, form:{steps, active_items, items_new:[code], items_closed:[code], items_reopened:[code], price_changed:[{code,old,new}], renamed:n, version_action:"insert"|"same"|"skipped_differs"},
plans:{rows, per_pcu:{pcu:{op,pp,total}}, network:{op,pp,total}}, limits:{in_file, will_default}, config:{will_set:[key]}, rollover:{from_fy, actual_months:[CE month], requests_counted, source:{actual_prev,prices_prev,stats}} | null }`
- `pcus`: `known` = in file and in DB · `new` = in file only (apply creates them with PIN `12345`) · `missing_in_file` = in DB only (never deleted). A file without `pcus` → all three `[]` + a warning.
- `form`: compared with the **latest form version of `fy_current`**. `items_new` = codes absent from it · `items_closed` = active there but closed/absent in the file · `items_reopened` = closed there, active now ·
  `price_changed` = same code, different price · `renamed` = count of changed names · `steps`/`active_items` count the form that will be stored (incl. carried closed items/pages).
  `version_action`: `insert` (no `form_versions` row of `fy` yet) · `same` (a version of `fy` has the same hash) · `skipped_differs`. In rollover anything but `insert` adds a warning (apply → `CONFLICT`).
- `plans`: baht = plan qty × **price of the stored form** (2 decimals); `rows` = number of (pcu,item) entries of known pcus; `per_pcu` has every known pcu present in `plans[fy]`. Entries of unknown pcus / codes not in the form → `warnings`.
- `limits`: `in_file` = entries of `limits[fy]` in the file · `will_default` = rows apply will generate (0 when the file has `limits[fy]`, and in `same_fy`).
- `config.will_set`: the keys that will be written — in rollover always `fy_current`, plus file keys (`limit_mode, stock_required, budget_op/pp/total, deadline_day`) that have no value yet (existing values are never overwritten).
- `rollover` (null in `same_fy`): `from_fy` = `fy_current` · `requests_counted` = requests with status `submitted`/`issued` in the 12 **round** months of `from_fy` (`fyMonths`, 2j) · `actual_months` = the
  Excel columns that will hold them, i.e. `prevMonth(round)` of each such round (or the file's `actual_prev[from_fy].months` when the file supplies it) · `source` = `"file"|"db"` for each of the three old-fy blocks (a block present in the file for `from_fy` is used as it is).
- `warnings` (Thai strings): pcus missing from the file, unknown pcus/codes in plans, `config.plan_total` mismatch, dropped items kept closed, no sent requests in the old fy, form already exists …

`adminImportApply{seed, confirm}` (rollover only):
1. Guards, in this order: `seed.fy === fy_current` → `CONFLICT` · `seed.fy !== fy_current + 1` → `BAD_REQUEST` · a `form_versions` row of `seed.fy` exists → `CONFLICT` ("ปีงบ <fy> เปิดแล้ว") ·
   `confirm !== "เปิดปีงบ <fy>"` → `BAD_REQUEST` · then the file is validated (as the preview). Nothing is written before the guards and validation pass.
2. Old fy `o = fy_current`; each block is taken from the file when it has `…[o]`, otherwise derived from the DB: `actual_prev[o]` = per (round ∈ `fyMonths(o)`, pcu, item) the `op`,`pp` of requests with status
   `submitted`/`issued` (only rows with op+pp > 0), written in Excel shape: `months = fyExcelMonths(o)` and round `fyMonths(o)[i]` goes to column `i`
   (= its submission month `prevMonth(round)`; 2j — e.g. round 2026-11 → column "2026-10") · `prices_prev[o]` = prices of the latest form of `o` (every item, closed ones included) · `stats[o]` = per (pcu,item) the 12 monthly totals `op+pp` (0 for missing months):
   `median_m` = median, `p90_m` = numpy-linear percentile 90 (sorted, rank `0.9·(n−1)`, interpolated), `annual_qty` = Σ, only `annual_qty > 0`, rounded to 2 decimals.
3. `limits[seed.fy]` when the file has none for that fy: per (pcu,item) of `plans[seed.fy]` ∪ `stats[o]` (known pcus): `limit_year = plan_op+plan_pp` (0 → null); `limit_month = ceil(p90_m)` if `p90_m > 0`
   (source `stat<o−2500>`, e.g. `stat70`) else `ceil(limit_year/12×2)` (source `plan<fy−2500>`); a row is skipped when both are null (same rule as `adminResetLimit`). Rows are written like import rows (`updated_by:"import"`).
4. Writes: all tables go through the idempotent importer first (`adminImportSeed` with `{...seed, actual_prev, prices_prev, stats, limits}`, without `form`; replace-per-fy rules of FORMAT.md; audit `import_seed`), then **one atomic D1 batch**:
   insert the form version as version 1 of `seed.fy` (guarded `WHERE NOT EXISTS` — two admins applying at once cannot both open the year → the loser gets `CONFLICT`), set `config.fy_current = seed.fy`
   and append the audit row `fy_open` — the last two only run if the insert took effect. An interrupted apply (before the commit) leaves `fy_current` and the form untouched and can simply be repeated.
   (`imported.form` is reported as `"inserted"`, `imported.config_set` includes `fy_current`.)
5. Audit `fy_open` (`detail` JSON `{fy, from_fy, actual_rows, stats_rows, prices_rows, limits_rows, items_new, items_closed}`). No per-isolate cache is keyed by fy (the form cache is by immutable version id), so nothing to clear.
`rollover` in the response: `actual_rows` / `stats_rows` / `prices_rows` = rows of the old-fy blocks that were written (or accepted from the file) · `limits_rows` = limits rows of the new fy (file's or generated) ·
`form_version_id` = id of the new `form_versions` row.
Effect: `config.fy_current = seed.fy`; `adminBootstrap`/`pcuBootstrap` use the new form (`pcuBootstrap` always follows `fy_current`; requests sent earlier keep their bound old version in `forms`);
`adminBootstrap.prev` gains the old fy (12 Excel months Oct … Sep), `stats.fy` = old fy, `plan_totals.fy` = new fy. Requests, lines, users, PINs, hidden items, unlocks are not touched.
After opening, re-previewing the same file gives `mode:"same_fy"` and (because the stored form also carries the closed items) usually `version_action:"skipped_differs"`.

## 6. `GET /api/export.xlsx?month=YYYY-MM | fy=2570 &token=…` (admin or dispenser)
`month=` = that one round · `fy=` = the 12 **round** months `fyMonths(fy)` (2j: FY2570 = rounds `2026-11` … `2027-10`; the plan/form of the scope = that fy, form via `formForFy`).
`Content-Disposition: attachment; filename*=UTF-8''เบิกวัสดุ_2026-10.xlsx` (or `เบิกวัสดุ_ปีงบ2570.xlsx`). Errors: HTTP 400/401/403 with the usual JSON body.
Three sheets (Thai headers): **รายบรรทัด** (one row per line with op+pp>0 or issued data: เดือน · รพ.สต. · หน้า · รหัส · รายการ · หน่วย · ราคา(snapshot, else form price) ·
OP · PP · รวม · เป็นเงิน · จ่ายจริง OP/PP/รวม (blank until issued; `0` = issued zero) · เหตุผล (`out_of_stock` -> "ของหมด/รอจัดซื้อ", `other` -> the typed note) · สถานะ · เวลาส่ง(Bangkok) · form version; all statuses) ·
**รพ.สต. × รายการ** (rows = items, columns = 15 PCUs + รวม; block 1 = ขอ, block 2 below = จ่ายจริง (Σ `issued_total`); submitted/issued only) ·
**สรุปเงินต่อ รพ.สต.** (แผน OP/PP/รวม of the fy × form price · ขอ OP/PP/รวม (price_snapshot) · จ่ายจริง OP/PP/รวม · ส่วนต่าง = แผนรวม − ขอรวม; submitted/issued only).
2n: PCUs in group `"ทดลอง"` are excluded from all three sheets (no rows in sheet 1/3, no column in sheet 2, not in any total).

## 6b. PDF (phase 2b) — `requestPdf` · `adminRequestPdf` · `printData` · `GET /api/pdf/:id`
Result of `requestPdf{month, doc_date?, supply_month?}` (PCU token, always `token.pcu`) and `adminRequestPdf{pcu, month, doc_date?, supply_month?}` (admin or dispenser):
- `{status:"ready", url:"/api/pdf/<request_id>?k=<content_key>", filename:"ใบเบิก_<print_name>_<เดือนไทย ปีพ.ศ.>.pdf", content_key}`
- `{status:"pending", retry_after:<s>}` — Browser Rendering answered 429 (its `Retry-After`, default 10). The client retries, giving up after 60 s total.
- Errors: `NOT_FOUND` (no request, or status `draft`: "ต้องส่งใบเบิกก่อนจึงจะดาวน์โหลด PDF ได้") · `PDF_UNAVAILABLE` (no `env.FILES`, or no
  `CF_BR_TOKEN`/`CF_ACCOUNT_ID` outside dev mock) · `PDF_FAILED{detail}` (renderer error / timeout / non-PDF body / R2 error) · `BAD_REQUEST` (month / pcu /
  print options).
  The two PDF errors carry a Thai message telling the user to use พิมพ์ → Save as PDF.

Print options (2h, per print — never stored; D1 unchanged): `{doc_date:"YYYY-MM-DD"|null, supply_month:"YYYY-MM"|null}`, sent as `doc_date` / `supply_month`
next to `month` (`printOptsOf`). Absent / `null` / `""` → `null` (that header slot prints dotted). `doc_date` must pass `isDate` else `BAD_REQUEST`
"วันที่เอกสารไม่ถูกต้อง"; `supply_month` must `=== month` (2j: the round is "ขอเบิกเดือน X", so round 2026-11 → only 2026-11) else `BAD_REQUEST`
"เดือนที่เบิกต้องเป็นเดือนของรอบ";
any other type → `BAD_REQUEST`. `filename` is unchanged (still the round month).

Algorithm (`functions/_lib/pdf.js`): request must be `submitted`/`issued` → `content_key = sha256(stableStringify({lv:LAYOUT_VERSION, v:form_version_id,
pn:print_name, hidden:sorted codes, lines:{code:[op,pp]} (op+pp>0), dd:doc_date|null, sm:supply_month|null}))` → each distinct option set is
its own key / file (retention §6b.1 unchanged; `submitted_at` dropped from the key in 2h — a resend with identical content reuses the file) → row in `pdf_files(request_id, content_key)` ⇒ `ready` at once (no R2 call) →
else render `<request origin>/print.html?k=<print token>` → `FILES.put("pdf/<pcu>/<month>/<content_key>.pdf")` + `pdf_files` row + audit `pdf_create`
(actor = PCU code or staff e-mail) in one D1 batch.
- `LAYOUT_VERSION` (exported by `pdf.js`, currently **3** = brief 2h: header วันที่ / ประจำเดือน blank unless chosen at print time, PCU14/15 sentence = full
  `print_name`; 2 = brief 2g, print scale 0.78) is bumped whenever `print.css` / `print.js` change what the sheet
  looks like: the cache only sees the key, so without the bump an unchanged request would keep getting its old-layout PDF from R2 (2b-R §6b.1 prunes those).
- Print token = `signToken({t:"print", pcu, month, ck:content_key, dd:doc_date|null, sm:supply_month|null, exp: now+120000})` (same HMAC format as §2).
  `printData` verifies it, requires type `print`, recomputes the content key with `{doc_date: dd ?? null, supply_month: sm ?? null}` and answers `CONFLICT` if
  the request changed since the token was minted (so a PDF is never cached under a wrong key). It returns `doc_date`, `supply_month` (`null` when absent).
  `form` = version bound to the request (`form_version_id`), else `formForFy` of the round's fy. Lines have the PCU shape (no price/issued fields).
- Browser Rendering call (checked 2026-10-06 against the API reference; the guide page now writes the path as `.../browser-run/pdf`):
  `POST https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-rendering/pdf`, `Authorization: Bearer ${CF_BR_TOKEN}`, body
  `{"url":"<print url>","viewport":{"width":794,"height":1123},"gotoOptions":{"waitUntil":"load","timeout":30000},"waitForSelector":{"selector":".print-ready","timeout":30000},"pdfOptions":{"format":"a4","landscape":false,"printBackground":true,"preferCSSPageSize":true}}`.
  Response 200 = raw PDF bytes (must start `%PDF`); 429 → `pending`; anything else → `PDF_FAILED`.
- **Dev mock**: `DEV_FAKE_GOOGLE==="1"` and empty `CF_BR_TOKEN` ⇒ a hand-built 1-page A4 PDF (`MOCK PDF <request_id> <content_key>`, < 2 KB) is stored instead
  (R2 put, `pdf_files`, download and caching all behave as real). Never used when `CF_BR_TOKEN` is set or in production.
- `print.html?k=…` (static page, no login) calls `printData`, renders every printable step (`active !== false`) with the same builder as the print route, waits for
  fonts, then adds class `print-ready` (or `print-error` + the message on failure).

`GET /api/pdf/:id?k=<content_key>&token=<pcu|staff token>[&inline=1]` (token may also be `Authorization: Bearer`): a PCU token must own the request (`token.pcu ==
request.pcu`) else 403; admin / dispenser any. HTTP 401 (no/invalid token) · 403 · 400 (malformed `k`) · 404 JSON (no request, no `pdf_files` row or R2 object).
200 streams the R2 object: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="request.pdf"; filename*=UTF-8''<encoded filename>`,
`Cache-Control: private, max-age=0`. `inline=1` (2g: the พิมพ์ button on non-Chromium browsers opens the PDF in the same tab to print it) → same header
with `inline` instead of `attachment` (same filename parameters); any other value or no `inline` → `attachment`. Auth, quota and counters are identical. Older versions stay downloadable by their own `k` until the retention rule (§6b.1) prunes them (then 404).
`adminClearTrial` deletes every `pdf_files` row and its R2 object. 2b-R: each `FILES.get` here counts one R2 Class B op (also when the object turns out
missing; requests without a `pdf_files` row never touch R2); when this month's Class B count ≥ `r2_max_class_b` → **HTTP 429** JSON
`{ok:false,error:{code:"PDF_QUOTA",message,detail,usage}}` before touching R2 (not counted).

### 6b.1 Retention, R2 cost guard, usage counters (2b-R, decided 2026-10-07 — `functions/_lib/pdf.js` `prunePdfFiles`, `functions/_lib/usage.js`)
**Retention** — `latest` = `currentRound()` = `nextMonth(calMonth)` (2j; honours `X-Dev-Month` in dev; = `adminRequests.current_round`). A *version* = a distinct
`content_key` of the same request. Per (pcu, `requests.month`), rows ordered `created_at DESC`: month `< latest − 11` → delete all (12-month window
counted by round month, not file date) · month `≥ latest` → keep newest **2** (a future month counts as latest) · otherwise keep newest **1**.
Delete = `FILES.delete(r2_key)` (stored key; R2 ignores missing keys) + `DELETE FROM pdf_files`. Without the `FILES` binding nothing is pruned.
Returns `{deleted:[r2_key], bytes}`; audit `pdf_prune` (pcu = the pcu or "", month = latest) only when ≥ 1 file went, detail
`"<n> files / <m> bytes / pcu=<X|all> / reason=<create|backup|admin|quota>"`. Called: after each stored PDF (that PCU, inline, after its row is
written so the new file counts; a prune error never fails the request) · by `runBackup` (all PCUs, §7) · by `adminPdfPrune` · by the bytes-cap check.
A pruned `content_key` requested again is simply rendered again (cache miss).

**Cost guard** — R2 is the only billable product (Workers Free: Browser Rendering is hard-capped by Cloudflare, 10 min/day, no app limit). Caps
(`adminSetConfig`, int ≥ 1 or `null` = default; ≈ 10 % of the R2 free tier):

| config key | default | compared with |
|---|---|---|
| `r2_max_bytes` | `1000000000` | `pdf_bytes` (Σ `pdf_files.bytes`, null = 0) + `backup_bytes` (`config.r2_backup_bytes`) |
| `r2_max_class_a` | `100000` | `usage_counters(<UTC month>, r2_class_a)` |
| `r2_max_class_b` | `1000000` | `usage_counters(<UTC month>, r2_class_b)` |

`requestPdf`/`adminRequestPdf` order: request sent? → content key → `pdf_files` hit ⇒ `ready` (no quota check, no R2 call) → **quota**: `class_a ≥
r2_max_class_a` ⇒ `PDF_QUOTA`; `bytes_total + 1000000 > r2_max_bytes` ⇒ prune all PCUs (reason=quota), recompute, still over ⇒ `PDF_QUOTA` → count
the render attempt → render → `FILES.put` → `pdf_files` row (with `bytes`) + Class A count + audit `pdf_create` (one batch) → prune (that PCU, reason=create).
`PDF_QUOTA` = `{code:"PDF_QUOTA", message:"ที่เก็บไฟล์ PDF ถึงเพดานที่ตั้งไว้ — กดปุ่ม พิมพ์ แล้วเลือก Save as PDF แทน และแจ้งผู้ดูแลระบบ", detail,
usage:{bytes, class_a, class_b, limits:{r2_max_bytes, r2_max_class_a, r2_max_class_b}}}`. Backups are never blocked (but counted).

**Counters** — `usage_counters(period, metric, n)`, one `INSERT … ON CONFLICT DO UPDATE SET n = n + excluded.n` per event. `period` = UTC month
`"YYYY-MM"` (R2 billing month) or UTC day `"YYYY-MM-DD"` (renders only; real UTC clock, *not* `X-Dev-Month`).
- `r2_class_a` (month): every `FILES.put` (PDF, backup) + every `FILES.list` page in `runBackup`.
- `r2_class_b` (month): every `FILES.get` in `GET /api/pdf/:id`.
- `pdf_render` (day **and** month): every renderer attempt after the quota check — real Browser Rendering calls incl. 429/errors, the dev mock and its
  `X-Dev-PDF` simulated branches. `FILES.delete` (free) and the dev actions are not counted.

`adminPdfFiles{pcu?}` data:
```
{ files: [ {pcu, pcu_name, month, content_key, created_at, bytes|null, url:"/api/pdf/<request_id>?k=<content_key>"} ],   // newest first
  total_files, total_bytes,                                        // of the listed files, null bytes = 0
  rule: { latest_month, keep_latest: 2, keep_other: 1, months: 12 },   // latest_month = currentRound (2j)
  usage: { period:"YYYY-MM", class_a, class_b, renders_month, renders_today,
           pdf_bytes, backup_bytes, backup_files,                  // backup_* from config (0 before the first backup); pdf_bytes = all PCUs
           bytes_total,                                            // pdf_bytes + backup_bytes
           limits: { r2_max_bytes, r2_max_class_a, r2_max_class_b },        // effective
           free_tier: { bytes: 10000000000, class_a: 1000000, class_b: 10000000 } } }
```
Works without the `FILES` binding (lists D1 rows; empty in practice).

## 7. `POST /api/cron/backup` (header `X-Backup-Key == env.BACKUP_KEY`)
Dumps every table to R2 `backup/YYYY-MM-DD.json` (Bangkok date) = `{exported_at, schema_version, tables:{name:[rows]}}`, deletes `backup/*` older than 90 days.
2b-R: counts Class A (1 put + 1 per list page), stores `config.r2_backup_bytes` / `config.r2_backup_files` = Σ size / count of the `backup/` objects
it listed that survived the prune, then runs the PDF retention for all PCUs (§6b.1, reason=backup, actor `system`). Never blocked by the R2 caps.
`X-Dev-Month` is honoured in dev (as on `POST /api`).
HTTP 403 on wrong/missing key (or `BACKUP_KEY` unset). `{ok:true,data:{key,size,deleted,pdf_pruned:[r2 keys]}}`. Called nightly by `.github/workflows/backup.yml`
(cron `0 19 * * *` UTC; repo secret `BACKUP_KEY`, repo variable `SITE_URL`).

## 8. D1 schema as implemented (`functions/_lib/db.js`, migrations v1 + v2 + v3)
Base = spec §3.3 verbatim. **Additions** (all documented here): `pcus.pin_custom`; `form_versions.data_hash`;
`requests.submit_count`; `limits.note`; table `prices_prev(fy,item_code,price)`; `schema_version` holds one row per applied migration (`MAX(v)` = current).
```
config(key PK, value)                     -- value = JSON text (e.g. "0", "\"warn\"", "null"); secrets: backup_pw_hash/salt, backup_version, backup_fail, backup_locked_until
                                          -- 2b-R: r2_max_bytes / r2_max_class_a / r2_max_class_b (null = default), r2_backup_bytes / r2_backup_files (written by runBackup)
schema_version(v)
users(email PK, role 'admin'|'dispenser', units JSON, added_at, added_by)
pcus(code PK, name, print_name, "group", pin_hash, pin_salt, pin_version, pin_fail, pin_locked_until, pin_custom,
     login_count, last_login_at)   -- v3 (2m): login_count INTEGER NOT NULL DEFAULT 0 · last_login_at TEXT (iso) — +1 per successful pcuLogin
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
pdf_files(request_id, content_key, r2_key, created_at, bytes)   PK(request_id,content_key)   -- bytes: v2, nullable (rows from before v2 = null)
usage_counters(period, metric, n)                           PK(period,metric)   -- v2; period "YYYY-MM" | "YYYY-MM-DD" (UTC); metric r2_class_a|r2_class_b|pdf_render
audit_log(id PK AUTOINCREMENT, ts, actor, role, action, pcu, month, detail)
```
- Migrations run automatically at the start of each request when `schema_version` is behind (cached per isolate). They must be idempotent.
  v1 = one batch. **v2** (2b-R) = `ALTER TABLE pdf_files ADD COLUMN bytes INTEGER` + `CREATE TABLE IF NOT EXISTS usage_counters …`, run one statement
  at a time; a "duplicate column" error (a racing isolate already added it) is swallowed and `schema_version` 2 is still recorded.
  `usage_counters` is in `TABLES` (backups, `devReset`).
  **v3** (2m) = `ALTER TABLE pcus ADD COLUMN login_count …` + `ALTER TABLE pcus ADD COLUMN last_login_at TEXT` (same one-by-one / "duplicate column" rule)
  + backfill `UPDATE pcus SET login_count = COUNT(*), last_login_at = MAX(ts)` of `audit_log` rows `action='pcuLogin' AND detail='ok'` per pcu
  (a backfill error is not tolerated → migration fails and retries next request).
- Multi-statement writes use `DB.batch()`; bulk inserts are chunked (≤ 100 statements per batch, ≤ 100 bound params per statement — D1 limits).
- `form_versions.data` items: `active` defaults to true, `dispense_unit` defaults from the step code (P* = พัสดุ, CS = จ่ายกลาง, LAB = LAB) when a seed omits them.

## 9. Environment
| name | use |
|---|---|
| `TOKEN_SECRET` | HMAC key (required) |
| `GOOGLE_CLIENT_ID` | tokeninfo `aud` check |
| `ADMIN_EMAILS` | comma list; admins while `users` is empty |
| `BACKUP_KEY` | `X-Backup-Key` for `/api/cron/backup` |
| `CF_ACCOUNT_ID`, `CF_BR_TOKEN` | Browser Rendering (2b): account id + API token with permission *Browser Rendering – Edit*. Both required in production; without them (or without the `FILES` binding) PDF actions answer `PDF_UNAVAILABLE`. Leave `CF_BR_TOKEN` empty locally to get the mock |
| `DEV_FAKE_GOOGLE=1` | **local only**: `dev:<email>` id_tokens + `devReset` |
Bindings: `DB` (D1 `pcu-supply`), `FILES` (R2 `pcu-supply-files`). Local values: `.dev.vars` (gitignored; template `.dev.vars.example`).

## 10. Local dev & tests
```
npm install
cp .dev.vars.example .dev.vars          # once
npm run dev                             # wrangler pages dev public --local --port 8788 --r2 FILES  (D1/R2 under .wrangler/state)
npm test                                # node tools/test_api.mjs   → http://localhost:8788 (override with API_BASE=...)
```
`npm test` uses a server already listening on `API_BASE`; if none is reachable it starts `wrangler pages dev` itself with a throw-away
`--persist-to .wrangler/test-state` and stops it at the end. In both cases the suite calls `devReset` first (clean D1), then imports the
fixture (`seed/seed_2570.json` if present, else a synthetic seed built from `public/data/form2569.json`). Two-terminal flow: terminal 1 `npm run dev`, terminal 2 `npm test`
(**this wipes the dev database**; use `API_BASE` against a throw-away instance if you have data you want to keep).

`--r2 FILES` gives the local server the `FILES` R2 binding (backups, PDFs); `[[r2_buckets]]` in `wrangler.toml` is live since 2026-10-07 (bucket
`pcu-supply-files`, lifecycle rules pdf/ 400 d · backup/ 100 d) but `--local` never touches the real bucket — the flag keeps working with it (verified wrangler 4.x). The test runner passes it too.
Without it `devPutBackup`, the backup tests and every PDF action fail (`PDF_UNAVAILABLE`). To keep your own data when testing, run the suite on another port:
`API_BASE=http://localhost:8790 npm test` (it starts and stops a throw-away server with `--persist-to .wrangler/test-state`).
