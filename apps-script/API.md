# API contract — phase 1.5 (Apps Script web app)

Spec: `../../phase 1.5.md` (§3–§5). This file is the single contract between the backend (`apps-script/*.js`),
the PCU frontend (`index.html`, `js/pages/*`) and the admin frontend (`admin.html`, `js/admin*.js`).

## Transport
- One endpoint: the Apps Script web-app URL (`/exec`). Frontend config in `js/config.js`:
  `API_URL` = deployed URL; when `location.hostname` is `localhost`/`127.0.0.1`, use `"/api"` (local dev server, see below).
- Every call: `POST` with header `Content-Type: text/plain;charset=utf-8` (no CORS preflight), body = JSON string
  `{ "action": "<name>", "token": "<token or omitted>", ...params }`.
- Response body (always HTTP 200): `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": { "code": "...", "message": "<Thai text>", ...extra } }`.
- Error codes: `BAD_REQUEST`, `AUTH_REQUIRED`, `AUTH_EXPIRED`, `FORBIDDEN`, `BAD_PIN` (extra `remaining`), `PIN_LOCKED` (extra `until` ISO),
  `NOT_FOUND`, `CONFLICT` (e.g. edit after submit), `INCOMPLETE` (extra `missing`: [item_code]), `OVER_LIMIT` (extra `items`: [...]),
  `SERVER_ERROR`.
- Times: ISO 8601 strings (UTC, `new Date().toISOString()`); frontend displays Asia/Bangkok.
- Month keys: CE `"YYYY-MM"`. Seed months = `2024-10 … 2025-09` (index 0–11 = ต.ค. 67 … ก.ย. 68).

## Constants (backend `Config.js`, mirrored in frontend `js/constants.js`)
```
ROUNDS = [
  { month: "2025-09", label: "ก.ย. 2568", fy: 2568, deadlineLabel: "25 ก.ย. 2568", prevMonth: "2025-08", default: true },
  { month: "2025-10", label: "ต.ค. 2568", fy: 2569, deadlineLabel: "25 ต.ค. 2568", prevMonth: "2025-09", next: true }
]
PIN_LENGTH = 5 · PIN_MAX_FAIL = 5 · PIN_LOCK_MIN = 5 · PCU_TOKEN_DAYS = 7
ADMIN_TOKEN_HOURS = 12 · BACKUP_MAX_FAIL = 5 · BACKUP_LOCK_MIN = 15
```

## Tokens
`base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))`; secret in Script Properties `TOKEN_SECRET`
(created by `setup()`). Payloads: PCU `{t:"pcu", pcu, v:<pin_version>, exp}` · admin `{t:"admin", sub:<email>|"backup", v:<backup_version if backup>, exp}`.
Verify signature + exp + (pcu) `v == pcus.pin_version` / (backup) `v == BACKUP_VERSION`. PCU tokens may only touch their own PCU.

## Request status
`draft` → `submitted` → `received` · `returned` is stored as `draft` with `return_reason` non-empty (cleared on next submit).
`not_started` = no row yet (virtual).

## PCU actions
| action | params | data |
|---|---|---|
| `pcuList` (public) | – | `{ pcus:[{code,name,group}] }` |
| `pcuLogin` (public) | `pcu, pin` | `{ token, exp, pcu:{code,name,print_name,group} }` · errors `BAD_PIN{remaining}`, `PIN_LOCKED{until}` |
| `pcuBootstrap` | – | see below |
| `saveLines` | `month, lines:{code:{stock,op,pp,updated_at}}, last_step?, submitter_name?` | `{ saved_at, status, request }` · `CONFLICT` if status is `submitted`/`received` |
| `submit` | `month` | `{ request }` · `INCOMPLETE{missing}` (non-hidden items without stock) · `OVER_LIMIT{items}` only when `limit_mode=="enforce"` |
| `withdraw` | `month` | `{ request }` · `CONFLICT` if `received` |
| `setHidden` | `codes:[item_code]` (full replacement) | `{ hidden:[...] }` |

`pcuBootstrap` data:
```
{
  pcu: {code,name,print_name,group},
  config: { limit_mode:"warn"|"enforce", cover_over:3, cover_short:0.5 },
  rounds: ROUNDS,
  hidden: [item_code],
  never68: [item_code],                 // items this PCU never withdrew in FY68 (for "ซ่อนรายการที่ปี 68 ไม่เคยเบิก")
  limits: { code: [limit_month|null, limit_year|null] },
  byRound: {
    "2025-09": {
      prev: { month:"2025-08", items: { code: { stock, stock_src:"sim"|"trial", op, pp } } },   // only codes with any value
      plan: { code: [plan_op, plan_pp] } | null,       // FY68 plan (null for FY69 round)
      used_fy: { code: qty },                          // OP+PP already used this FY excluding this round's request
      avg3: { code: number },
      regular: [code],                                 // items withdrawn in ≥ 6 of 12 FY68 months (cover warning only for these)                          // avg withdrawal of the 3 months before this round (fallback: annual mean) – for "พอใช้ ~n เดือน"
      request: RequestObj | null
    },
    "2025-10": { ... same shape; prev from submitted/received trial 2025-09 request if any (stock_src "trial"), else actual Sep 68 + sim stock }
  }
}
RequestObj = { pcu, month, status, return_reason, submitter_name, last_step, created_at, updated_at, submitted_at, received_at,
               lines: { code: { stock, op, pp, updated_at } } }
```
`used_fy` for 2025-09 = Σ actual Oct 67 – Aug 68 · for 2025-10 = Σ OP+PP of this PCU's other submitted/received trial requests in FY2569 (none today).

`saveLines`: upsert per line; a line is written only if its `updated_at` ≥ stored `updated_at` (last-write-wins per line).
Values: integers ≥ 0 or `null` (empty). Creates the request (status `draft`) if missing. Updates `last_step`/`submitter_name` if given.

## Admin actions (token `t:"admin"` unless marked)
| action | params | data |
|---|---|---|
| `adminLoginGoogle` (public) | `id_token` | `{ token, exp, email }` — verify via `https://oauth2.googleapis.com/tokeninfo?id_token=…`: `aud == GOOGLE_CLIENT_ID`, `email_verified == "true"`, email in `admins` (case-insensitive); cache verified email 5 min |
| `adminLoginBackup` (public) | `password` | `{ token, exp }` · `BAD_PIN`/`PIN_LOCKED` style errors (`BAD_PASSWORD{remaining}`, `LOCKED{until}`) · `NOT_FOUND` if no backup password set |
| `adminBootstrap` | – | see below |
| `adminRequests` | – | `{ requests:[RequestObj without lines + progress], server_time }` (fast refresh) |
| `adminGetRequest` | `pcu, month` | `{ request: RequestObj\|null, pcu:{code,name,print_name,group}, hidden:[code] }` — used by the print page when an admin reprints any PCU's form (`index.html#/print?pcu=..&month=..&as=admin` with the admin token) |
| `adminReceive` | `pcu, month` | `{ request }` (only from `submitted`) |
| `adminReturn` | `pcu, month, reason` (non-empty) | `{ request }` (from `submitted` → `draft` + reason) |
| `adminSetLimit` | `pcu, code, limit_month, limit_year` (int ≥ 0 or null) | `{ limit:{pcu,code,limit_month,limit_year,source:"admin",updated_by,updated_at} }` |
| `adminResetLimit` | `pcu, code` | `{ limit }` restored from `stats_2568` (source `stat68`) or removed |
| `adminSetMode` | `mode: "warn"|"enforce"` | `{ config }` |
| `adminSetPin` | `pcu, pin` (5 digits) | `{ ok:true }` — new salt+hash, `pin_version++`, clears fail/lock |
| `adminUnlockPin` | `pcu` | `{ ok:true }` |
| `adminSetHidden` | `pcu, codes` | `{ hidden }` |
| `adminSetBackupPassword` | `password` (≥ 8 chars) — **Google admin token only** | `{ ok:true }` — hash in Script Properties, `BACKUP_VERSION++` |
| `adminClearTrial` | `confirm: "ล้างข้อมูล"` | `{ deleted_requests, deleted_lines }` — deletes `requests` + `request_lines` only |

`adminBootstrap` data:
```
{
  me: { email | "backup" },
  config: { limit_mode, cover_over, cover_short, budget_op, budget_pp, budget_total },
  rounds: ROUNDS,
  months: ["2024-10", …, "2025-09"],
  pcus: [{code,name,print_name,group, pin_locked_until|null, pin_fail}],
  items_extra: { "X-113": { name, unit, price_2568 } },          // not in 2569 form, counted in baht totals
  price_2568: { code: price },
  actual: { pcu: { code: { op:[12], pp:[12] } } },                // includes "X-113"
  plan: { pcu: { code: [plan_op, plan_pp] } },
  stats: { pcu: { code: [median_m, p90_m, annual_qty] } },
  stock_sim: { pcu: { code: [12] } },
  scenarios: { overstock:[pcu], short:[pcu] },
  limits: { pcu: { code: { limit_month, limit_year, source, updated_by, updated_at } } },
  hidden: { pcu: [code] },
  requests: [RequestObj]                                         // all trial requests with lines
}
```
progress (in `adminRequests` and derivable client-side): `{ last_step, stock_filled, stock_required, items_requested, baht_2569 }`
(`stock_required` = 125 − hidden · baht uses 2569 form prices from `data/form2569.json`, computed client-side if easier — backend may omit `baht_2569`).

## Sheets (created by `setup()`)
`config`(key,value) · `admins`(email,added_at) · `pcus`(code,name,print_name,group,pin_hash,pin_salt,pin_version,pin_fail,pin_locked_until) ·
`item_map` · `actual_2568`(month,pcu,item_code,op,pp — non-zero rows only, "X-113" included) · `plan_2568`(pcu,item_code,plan_op,plan_pp) ·
`stats_2568`(pcu,item_code,median_m,p90_m,annual_qty) · `stock_sim_2568`(month,pcu,item_code,stock,scenario) ·
`limits`(pcu,item_code,limit_month,limit_year,source,updated_by,updated_at) ·
`requests`(id,pcu,month,status,submitter_name,last_step,created_at,updated_at,submitted_at,received_at,return_reason) ·
`request_lines`(request_id,item_code,stock,op,pp,updated_at) · `pcu_hidden_items`(pcu,item_code,hidden_at,by) · `audit_log`(ts,actor,action,pcu,month,detail)

## Setup / seed
- `setup()` (run once by the owner in the Apps Script editor → grants scopes): create sheets + headers if missing, default `config`,
  `admins` = `parinya.paw@gmail.com`, `pcus` from seed with PIN `12345` (salted SHA-256), `TOKEN_SECRET`, then `importSeed_()`.
  Idempotent: re-running never touches `requests`, `request_lines`, `pcu_hidden_items`, `audit_log`, PINs already set, or admin-edited limits.
- Seed data: `apps-script/_seed.html` (generated by `tools/make_seed_html.py` from `../phase15_seed/seed_2568.json`; **gitignored**, pushed to
  Apps Script only) read with `HtmlService.createHtmlOutputFromFile("_seed").getContent()`.

## Local dev server (no Google needed)
`node tools/dev_server.mjs [port] [--reset] [--state <path>]` — serves `webapp/` statically and `POST /api` by running the
real `apps-script/*.js` inside a Node `vm` (see `tools/gas_mock.mjs`) with in-memory mocks of `SpreadsheetApp`,
`PropertiesService`, `CacheService`, `LockService`, `Utilities`, `ContentService`, `HtmlService`,
`UrlFetchApp` (`tokeninfo` mocked: token `"dev:<email>"` → that email). State (sheets + Script Properties) persists to
`tools/.devstate.json` after every `/api` request (gitignored, pattern `tools/.devstate*.json`). Runs `setup()` on first
start (no state file yet). `--reset` deletes the state file and re-runs `setup()` from scratch. `--state <path>` uses a
different state file instead of the default — run two dev servers on two ports against separate state, e.g.
`node tools/dev_server.mjs 8770` and `node tools/dev_server.mjs 8771 --state tools/.devstate.b.json`.
