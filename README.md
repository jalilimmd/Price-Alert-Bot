# Price Alert Bot — two-tier, permanently free

A Telegram bot that watches three prices and messages you when one crosses a
threshold you set:

1. **One gram of 18-karat (750) gold, in Iranian Toman.** Explicitly *not*
   mesghal/mazaneh, *not* melted gold (abshodeh). Every alert repeats this.
2. **BTC/USDT** spot.
3. **USDT/IRT** — the real Iranian-market rate, from Iranian exchanges.

Everything runs on permanently free tiers. No paid services, no trials, no
credit card.

> This tool **observes and notifies only**. It gives no financial advice, no
> trading signals, and no price predictions.

---

## 1. Architecture in one paragraph

Two tiers share state through a single GitHub Gist holding three JSON files.
**Tier 1** is a Cloudflare Worker: an always-on HTTPS endpoint that receives the
Telegram webhook and answers every user command (`/add`, `/list`, `/price`, …)
in well under a second. It is the *only* writer of `alerts.json`. **Tier 2** is a
GitHub Actions workflow on a 5-minute cron: it fetches each price once per run,
evaluates every alert, sends notifications, and maintains a 24-hour price
history. It is the *only* writer of `runtime.json` and `history.json`, and it
reads `alerts.json`. Command handling lives on Workers because it needs a public
endpoint and sub-second latency; price evaluation lives on Actions because public
repositories get unlimited minutes, a full Node runtime with no dependency
restrictions, and no per-invocation CPU ceiling — none of which the Workers free
plan offers. Neither tier alone covers both needs, and because each of the three
files has exactly one writer, the two tiers can never overwrite each other.

**What runs where**

| | Tier 1 — Cloudflare Worker | Tier 2 — GitHub Actions |
|---|---|---|
| Trigger | Telegram webhook (per message) | cron `*/5` + manual dispatch |
| Job | parse & answer commands | fetch prices, evaluate, notify |
| Latency | < 1 second | 5–20 min (cron is delayed at peak) |
| Writes | `alerts.json` | `runtime.json`, `history.json` |
| Reads | `alerts.json`, `runtime.json` | `alerts.json` |
| Sends Telegram | yes (command replies) | yes (alert delivery) |
| Calls `getUpdates` | never (webhook) | never (would break the webhook) |

---

## 2. Data-source comparison

Verified 2026-07-24. Endpoints without a public contract (the two gold sources)
can change field names without notice; `npm run diagnose` re-checks them live
from the runner and dumps what they currently return.

| Asset | Source | Endpoint | Auth | Documented rate limit | History? | Reliability | Geo-block risk |
|---|---|---|---|---|---|---|---|
| **BTC/USDT** | OKX (primary) | `GET www.okx.com/api/v5/market/ticker` · `/market/candles?bar=1D` | none | generous public IP limits | **yes** (klines → 7d/30d) | high | low |
| | KuCoin (fallback) | `GET api.kucoin.com/api/v1/market/orderbook/level1` · `/market/candles?type=1day` | none | public | yes (klines) | high | low |
| | Coinbase (fallback) | `GET api.exchange.coinbase.com/products/BTC-USDT/ticker` | none | public | ticker only | high | low |
| | ~~Binance~~ | ~~api.binance.com~~ | — | — | — | — | **HTTP 451 to US IPs — excluded** |
| **Gold 18k** | BrsAPI (primary) | `GET Api.BrsApi.ir/Market/Gold_Currency.php?key=` | free key | **1,500 req/day** (shared) | Pro only | medium | Iran-hosted; may throttle non-IR IPs |
| | TGJU (fallback) | `GET call1.tgju.org/ajax.json` (`geram18`) | none | undocumented | no | medium | **unofficial, no contract** |
| **USDT/IRT** | Nobitex (primary) | `POST api.nobitex.ir/market/stats` (`usdt-rls`) | none | per-IP/token, 403 on hit | no (bounds only) | high | Iran-hosted; may throttle non-IR IPs |
| | Wallex (fallback) | `GET api.wallex.ir/v1/depth?symbol=USDTTMN` | none | public | no | high | Iran-hosted |

**Price semantics (USDT/IRT and the crypto book):** the value is the **mid of
best bid and best ask** (`(bestBuy + bestSell) / 2`), not the last trade. Iranian
order books are thin and a single stale or wash print can sit far from the market
for minutes; the top-of-book mid is what you could actually transact near right
now and it updates even with no trades. When the spread is implausibly wide
(> `MAX_SPREAD_PCT`, default 1.5%) the book is treated as untrustworthy and the
code falls back to the last trade — the more conservative of two bad options. The
method used is printed in every `/price` reply and every alert.

**Why 7d/30d are BTC-only:** those windows come from the exchange's daily kline
endpoint at zero storage cost. No free Iranian source exposes 7-day or 30-day
history for gram-18k gold or USDT/IRT, and the local history buffer spans only 24
hours by design. The Worker rejects those combinations at command time with an
explicit reason rather than accepting them and returning wrong numbers a month
later.

---

## 3. Project layout

```
price-alert-bot/
├── shared/                      # canonical source of truth (edit here)
│   ├── schema.js                # alert record, matrix, defaults, validation, migrations
│   ├── format.js                # Persian digits, separators, Tehran time
│   └── sources.js               # price adapters, fallback chains, backoff
├── scripts/
│   ├── sync-shared.mjs          # copies shared/ into both tiers; --check in CI
│   ├── generate-secrets.mjs     # makes the webhook token + path secret
│   └── register-webhook.mjs     # setWebhook / getWebhookInfo / deleteWebhook
│
├── worker/                      # ── TIER 1 · Cloudflare Workers ──
│   ├── wrangler.toml
│   └── src/
│       ├── index.js             # webhook security + always-200 handler
│       ├── commands.js          # /start /help /price /list /add /del /pause /resume
│       ├── gist.js              # reads alerts+runtime; writes ONLY alerts.json
│       ├── telegram.js          # sendMessage, callbacks, inline keyboards
│       ├── schema.js  format.js  sources.js   # generated copies (do not edit)
│
├── actions/                     # ── TIER 2 · GitHub Actions ──
│   └── src/
│       ├── run.js               # orchestrator (read → evaluate → write)
│       ├── evaluate.js          # snapshots, guards, edge triggers, lifecycle
│       ├── history.js           # 288-point ring buffer, proximity lookup
│       ├── gist.js              # reads alerts; writes ONLY runtime+history
│       ├── messages.js          # Persian alert text (reason, time, source)
│       ├── config.js            # all tunables from env
│       ├── diagnose.js          # live endpoint + channel probe
│       ├── channels/
│       │   ├── index.js         # pluggable dispatcher (delivery-only)
│       │   ├── telegram.js  ntfy.js  bale.js
│       └── schema.js  format.js  sources.js   # generated copies (do not edit)
│
├── test/                        # network-stubbed tests of the real code
│   ├── engine.test.mjs          # trigger semantics + single-writer (33 checks)
│   ├── worker.test.mjs          # parsing, validation, formatting (49 checks)
│   └── worker-handler.test.mjs  # webhook security + always-200 (17 checks)
│
└── .github/workflows/
    ├── alerts.yml               # the 5-minute evaluation cron
    ├── schema-check.yml         # fails CI if the two tiers' copies diverge
    └── keepalive.yml            # prevents the 60-day scheduled-workflow disable
```

---

## 4. Reasoning done before the code

### 4.1 Single-writer proof — no file has two writers

Two independent writers exist: the Worker (on command) and Actions (every 5
min). A shared object read-modified-written by both would eventually lose a
write. The fix is **ownership**, not locking: each file has exactly one writer,
which makes a conflict structurally impossible.

Every write path in the codebase:

| File | Written by | The only write path | Read by |
|---|---|---|---|
| `alerts.json` | **Worker only** | `worker/src/gist.js` → `patchAlertsFile()` builds a PATCH body with the single key `FILE_ALERTS` | Worker (`/list`), Actions |
| `runtime.json` | **Actions only** | `actions/src/gist.js` → `writeOwnedFiles()` PATCH keys `FILE_RUNTIME`, `FILE_HISTORY` | Worker (`/list`) |
| `history.json` | **Actions only** | same `writeOwnedFiles()` call | no one else |

Why this holds, mechanically: the GitHub Gist API **leaves files not named in an
edit unchanged**. The Worker's PATCH body literally cannot contain
`runtime.json` or `history.json` — `FILE_ALERTS` is the only filename it ever
puts in a write body. The Actions PATCH body literally cannot contain
`alerts.json` — `FILE_ALERTS` is imported there for *reading only*. You can
confirm this by grep: search the repo for `runtime.json`/`history.json` in
`worker/src/` and you find only comments and one user-facing status string;
search `actions/src/gist.js` for `alerts.json` as a write key and you find none.
There is deliberately no ETag or lock scheme — ownership makes one unnecessary.

A direct consequence: auto-disable (max-triggers, expiry) is recorded in
`runtime.json` as `system_disabled`, **not** by flipping `alerts[].enabled`.
`enabled` is the user's own pause toggle, owned by the Worker. **Effective status
= `enabled AND NOT system_disabled`**, joined at read time by whichever tier
needs it. `/list` shows the combined status and the `disabled_reason`.

The intra-tier case (one user firing two commands in the same second) is handled
separately by a read-modify-write-**verify** loop in the Worker: it re-reads
after writing and retries against fresh state, so a retry never replays a stale
document. This is belt-and-braces on top of ownership, not a substitute for it.

The `test/engine.test.mjs` suite asserts the Actions tier only ever PATCHes
`runtime.json` + `history.json` (never `alerts.json`) by capturing real PATCH
bodies.

### 4.2 API-call budget

288 runs/day (one per 5-minute slot; fewer in practice, since GitHub skips slots
under load).

**Per Actions run:** exactly **one fetch per asset**, fanned out to every alert
(never per alert), plus **at most one** BTC kline call, made only when a live
7d/30d alert exists.

| Source | Calls/run | Calls/day (×288) | Provider ceiling | Headroom |
|---|---|---|---|---|
| BTC ticker (OKX, +fallbacks only on failure) | 1 | 288 | generous public | vast |
| BTC klines (only if a 7d/30d alert exists) | 0–1 | ≤ 288 | generous public | vast |
| Gold (BrsAPI) | 1 | 288 | **1,500/day** | ~5× headroom |
| Gold (TGJU, only on BrsAPI failure) | 0–1 | ≤ 288 | undocumented | n/a |
| USDT (Nobitex) | 1 | 288 | per-IP, unpublished | fine at this rate |

BrsAPI's 1,500/day free cap is the tightest limit and 288 sits comfortably
inside it. Even if the primary fails every run and both sources are hit, the
worst case is 576 gold calls/day, still under the cap.

**Cloudflare Workers free plan** (verified 2026-07-24): 100,000 requests/day,
1,000 requests/min, **10 ms CPU per request**, 50 external subrequests per
invocation, 6 concurrent connections. Each command is one request; the Worker
does no meaningful computation (it parses a small JSON body and awaits network
calls, and *waiting on `fetch()` does not count toward CPU time*). The heaviest
command, `/price`, makes three concurrent upstream calls — inside both the
50-subrequest and 6-connection limits. A single user generates on the order of
tens of requests a day against a 100,000 ceiling.

**GitHub Actions:** public repositories get unlimited minutes. Each run is well
under a minute.

### 4.3 What if only one tier is deployed

- **Worker up, Actions not running.** Commands all work: you can add, list,
  pause, delete alerts and fetch `/price` live. But **nothing is ever
  evaluated**, so no alert fires. `runtime.json` does not exist yet, so `/list`
  prints a visible banner: "runtime.json does not exist — the evaluation tier has
  not run yet; no alert will fire until it does." No silent failure.
- **Actions running, Worker not deployed.** The evaluator reads `alerts.json`;
  if it is absent (the Worker was never used) it logs that fact and **still
  samples prices**, so the ring buffer is warm and percent-change windows are
  ready the moment the first alert appears. It writes `runtime.json` and
  `history.json` normally. No alert can exist yet, so nothing fires. The instant
  the Worker is deployed and an alert is added, evaluation already has history.
- **First run, no files at all.** Every read path treats a missing file as an
  empty document; the first Actions run creates `runtime.json` + `history.json`,
  the first `/add` creates `alerts.json`.

---

## 5. Command reference

```
/start                 Overview, the three assets, a sample, and the latency note.
/help                  Full syntax, the availability matrix, trigger rules, examples.
/price                 Live price of all three assets, fetched by the Worker now.
/list                  Your alerts with id, type, bounds, and EFFECTIVE status,
                       each with inline Pause/Resume and Delete buttons.
/add <asset> <type> [below=x] [above=y] [cooldown=m] [max=n] [expires=d] [hyst=h]
/del <id>              Delete one of your alerts.
/pause <id>            Your pause toggle (enabled=false).
/resume <id>           Undo pause. (If the SYSTEM disabled it, it stays disabled.)
```

**Assets:** `btc` · `gold` (one gram 18k, Toman) · `usdt` (Toman).
**Types:** `abs` · `30m` · `4h` · `24h` · `7d`\* · `30d`\*  (\* BTC only).
Numbers accept `70000`, `70,000`, `70_000`, `18.8m`, `1.2k`, `-5`, and Persian
digits (`۷۰۰۰۰`).

**Worked examples**

| Command | Meaning |
|---|---|
| `/price` | show all three prices now |
| `/add btc abs above=70000` | fire when BTC rises above 70,000 USDT |
| `/add gold abs above=19,500,000 below=17m` | fire if a gram of 18k gold leaves the 17m–19.5m Toman band (OR) |
| `/add usdt 24h below=-3 above=3 cooldown=60` | fire on a ±3% USDT/IRT move over 24h, at most hourly |
| `/add btc 7d above=15 max=1` | fire once if BTC is up > 15% over 7 days |
| `/add btc 30m below=-2 hyst=1` | fire on a −2% BTC move over 30m, re-arm margin 1% of the bound |
| `/list` | list your alerts with buttons |
| `/pause a1b2c3d` · `/resume a1b2c3d` | pause / resume |
| `/del a1b2c3d` | delete |

**Bounds** combine with OR; at least one of `below`/`above` is required. For
`abs` they are prices in the quote currency; for any percent type they are signed
percentages (e.g. `below=-5 above=8`).

**Trigger behaviour** is edge-triggered: an alert fires only at the moment the
value crosses a bound, not for the whole time it stays across. It re-arms only
after the value returns past the bound by a hysteresis margin (`hyst`, default
0.5% of the bound), which prevents flapping. `cooldown_minutes` is an independent
floor — at most one notification per window, even across several crossings. After
`max_triggers` fires (default 3) or `expires_after_days` (default 30), whichever
comes first, the alert auto-disables and records why.

**Latency:** commands answer immediately, but alerts are evaluated on a schedule
and **may arrive up to 20 minutes late**. This is stated in `/start` and `/help`.

---

## 6. Setup, in dependency order

You need: a Telegram account, a GitHub account, and a Cloudflare account (all
free). Total time ~20 minutes. Do the steps in order — each depends on the one
before.

### Step 0 — get the code onto GitHub
Create a **public** repository (public repos get unlimited Actions minutes) and
push this project to it.
```bash
git init && git add . && git commit -m "price alert bot"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
**Verify:** the `schema-check` workflow runs on push and goes green (Actions tab).

### Step 1 — create the bot
In Telegram, message **@BotFather** → `/newbot` → follow prompts. Copy the
**bot token** it gives you. Message **@userinfobot** to get your numeric
**chat id**.
**Verify:** `curl https://api.telegram.org/bot<TOKEN>/getMe` returns your bot.

### Step 2 — create the Gist
Go to <https://gist.github.com>, create a **secret** Gist (it holds your chat
ids — keep it secret). Add one file so it saves; the tiers will create the rest.

- Filename: `alerts.json`  ·  Content: `{"schema_version":1,"alerts":[]}`

Copy the **Gist ID** — the 32-hex string in the URL
`https://gist.github.com/<you>/<THIS_PART>`.
**Verify:** the Gist page shows `alerts.json`.

### Step 3 — generate the fine-grained GitHub token
<https://github.com/settings/personal-access-tokens/new> → **Fine-grained**
token.
- Resource owner: your account.
- **Account permissions → Gists → Read and write.** Nothing else.
- Repository access: none needed.

Copy the token. This is a **fine-grained token scoped to Gists only** — never a
classic token with broad scope.
**Verify:**
```bash
curl -H "Authorization: Bearer <PAT>" -H "X-GitHub-Api-Version: 2022-11-28" \
     https://api.github.com/gists/<GIST_ID> | head
```
returns the Gist JSON (HTTP 200).

### Step 4 — deploy the Worker
```bash
cd worker
npx wrangler login          # opens a browser once
npx wrangler deploy
```
Note the printed URL, e.g. `https://price-alert-bot.<subdomain>.workers.dev`.
**Verify:** `curl https://<worker>.workers.dev/health` returns
`{"ok":false,...,"missing_secrets":[...]}` — false is expected here because no
secrets are set yet.

### Step 5 — generate and set the Worker secrets
```bash
cd ..
node scripts/generate-secrets.mjs      # prints WEBHOOK_SECRET_TOKEN and WEBHOOK_PATH_SECRET
```
Then, from `worker/`, set every secret (each is stored encrypted on Cloudflare;
none is ever written to `wrangler.toml`):
```bash
cd worker
echo -n '<BOT_TOKEN>'            | npx wrangler secret put BOT_TOKEN
echo -n '<FINE_GRAINED_PAT>'     | npx wrangler secret put GITHUB_TOKEN
echo -n '<GIST_ID>'              | npx wrangler secret put GIST_ID
echo -n '<WEBHOOK_SECRET_TOKEN>' | npx wrangler secret put WEBHOOK_SECRET_TOKEN
echo -n '<WEBHOOK_PATH_SECRET>'  | npx wrangler secret put WEBHOOK_PATH_SECRET
echo -n '<YOUR_CHAT_ID>'         | npx wrangler secret put ALLOWED_CHAT_IDS
# optional, enables the primary gold source:
echo -n '<BRSAPI_KEY>'           | npx wrangler secret put BRSAPI_KEY
```
(`ALLOWED_CHAT_IDS` is comma-separated for multiple users:
`111111,222222`.)
**Verify:** `npx wrangler secret list` shows all six (or seven), and
`curl https://<worker>.workers.dev/health` now returns `{"ok":true,...}`.

### Step 6 — register the webhook (with its secret token)
The webhook URL is your Worker URL + `/tg/` + the path secret.
```bash
cd ..
BOT_TOKEN='<BOT_TOKEN>' \
WEBHOOK_URL='https://<worker>.workers.dev/tg/<WEBHOOK_PATH_SECRET>' \
WEBHOOK_SECRET_TOKEN='<WEBHOOK_SECRET_TOKEN>' \
node scripts/register-webhook.mjs set
```
**Verify:** `BOT_TOKEN='<BOT_TOKEN>' node scripts/register-webhook.mjs info`
shows your URL and `last error: none`. Then message your bot `/start` — you
should get the welcome text within a second. If `info` shows a 401, the Worker's
`WEBHOOK_SECRET_TOKEN` does not match; a 404 means the URL path does not match
`WEBHOOK_PATH_SECRET`.

### Step 7 — set the GitHub Actions secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value | Required |
|---|---|---|
| `GIST_ID` | the Gist ID | yes |
| `GH_GIST_TOKEN` | the same fine-grained PAT | yes |
| `BOT_TOKEN` | the bot token | yes |
| `ADMIN_CHAT_ID` | your chat id (source-failure alerts) | recommended |
| `BRSAPI_KEY` | free key from brsapi.ir | recommended |
| `NTFY_TOPIC` | a long random string (secondary channel) | optional |

Optional **Variables** (not secrets) tune behaviour: `NTFY_ENABLED=true`,
`NTFY_SERVER`, `BTC_SOURCE_ORDER`, `MAX_SPREAD_PCT`, etc.
**Verify:** next step.

### Step 8 — first Actions run
Repo → **Actions → alerts → Run workflow**. First run it with **mode =
diagnose**: it prints the runner's egress IP, probes every endpoint, and dumps
the gold symbols it sees — this is how you find out whether the runner can reach
the Iranian sources and whether BrsAPI's field names still match. Then run it
with **mode = run**.
**Verify:** the run is green; its log shows `gist write: runtime.json,
history.json`; and the Gist now contains `runtime.json` and `history.json`.
Send `/list` in Telegram — the "runtime not yet run" banner is gone. Add
`/add btc abs above=1` and within ~5–20 minutes you get a fired alert (then
`/del` it).

### Step 9 — leave it running
The `keepalive` workflow commits a marker every ~40 days so GitHub does not
disable the cron after 60 days of repo inactivity. Nothing else to do.

---

## 7. Why I built it this way

**1. Ownership instead of locking.** The whole design turns on giving each Gist
file exactly one writer. Locking or ETag compare-and-swap on a Gist would be
fragile (no real transactions, last-write-wins) and would still leave a race
window. Splitting definitions (Worker-owned) from runtime state and history
(Actions-owned) makes a conflict *impossible to express*, because the Gist API
leaves unnamed files untouched. That is why auto-disable is a `runtime.json`
flag, not an edit to the user's `enabled` field — respecting the ownership line
is worth the small cost of computing effective status at read time.

**2. Two platforms because neither is enough alone.** Command handling needs a
public HTTPS endpoint that responds in under a second and stays warm — exactly
what Workers is for. Price evaluation needs an unrestricted runtime, arbitrary
run time, and no per-call CPU cap so it can hit several APIs and keep history —
exactly what a public-repo Actions runner gives for free, and exactly what the
Workers free plan's 10 ms CPU limit forbids. Using each platform for the half it
is good at is cheaper and simpler than forcing either to do both.

**3. Always return 200 to Telegram.** A non-200 makes Telegram redeliver the
update, which would execute a command twice — a real hazard when the command
mutates state (`/add`, `/del`). The Worker catches every internal error and
reports it *in the chat*, returning 200 regardless. The one deliberate exception
is a 401 on a bad secret token: that request is not proven to be Telegram, never
reaches a handler (so redelivery can duplicate nothing), and answering 200 there
would hide a misconfigured secret forever instead of surfacing it in
`getWebhookInfo` on the first update. The `worker-handler.test.mjs` suite proves
200 survives a failing Gist read, malformed JSON, and missing secrets.

**4. Edge triggers with hysteresis and an independent cooldown.** A naive
"price > bound" check spams you every 5 minutes while the condition holds. This
bot fires only on the *transition* into breach, re-arms only after the value
retreats past the bound by a margin (so noise at the boundary does not
re-trigger), and additionally caps notifications with a cooldown floor. A
suppressed crossing is *consumed*, not queued, so you never get a stale "it
crossed" message minutes after the fact. The 33-check engine test pins this
behaviour down.

**5. Correctness guards over convenience.** A missing history baseline is never
treated as zero or as the current price — the percent-change alert is skipped and
the reason is logged and shown. A feed that returns an identical value for many
runs, or a stale timestamp, is marked stale and excluded from percent-change
(Iranian gold and Toman feeds freeze overnight, on Fridays, and on holidays —
expected, not an error). Select-by-timestamp-proximity, never by array index,
because GitHub's cron is irregular and "6 slots back" is not "30 minutes ago."

---

## 8. Limitations and risks — what can break and what you'd see

**Geo-blocking of the Iranian sources (highest residual risk).** GitHub-hosted
runners egress from US IPs, and the Iranian endpoints (Nobitex, Wallex, BrsAPI,
TGJU) may throttle or refuse them. *Symptom:* gold and/or USDT show
"در دسترس نیست" and, after a few consecutive failures, the admin gets one
throttled "all sources failed" notice. *What to do:* run **mode = diagnose** to
see the exact per-source errors and the runner's IP; the code already tries the
whole fallback chain before giving up. (This is also why Binance is excluded
entirely — it returns HTTP 451 to US IPs.)

**Gold sources have no API contract.** BrsAPI and TGJU are scraping-derived; a
renamed field silently breaks gold. *Symptom:* gold unavailable while BTC/USDT
are fine. *What to do:* `diagnose` dumps the current gold symbols and names so you
can adjust the matcher in `shared/sources.js`. The gold adapter matches on both a
symbol list and Persian name hints, and explicitly excludes mesghal/melted/ounce,
to reduce the chance of silently reading the wrong instrument.

**Scheduled runs are late and occasionally skipped.** GitHub delays the cron
5–20 min at peak and can drop a slot. *Symptom:* an alert arrives late (disclosed
up front). The logic tolerates this because it uses real timestamps, never run
counts.

**60-day auto-disable.** GitHub disables the cron after 60 days with no repo
commits. *Symptom:* alerts silently stop, no banner unless you open the workflow
page. *Mitigation:* the `keepalive` workflow commits a marker every ~40 days. If
you ever see it disabled, push any commit or re-enable it in the Actions tab.

**At-least-once delivery on a write failure.** If notifications go out but the
subsequent Gist write fails, `runtime.json` is not advanced, so an alert that
fired can fire once more next run. This is a deliberate trade-off: a duplicate
notice is better than losing the alert. *Symptom:* very occasionally, a repeated
alert.

**Telegram or ntfy filtered from your network.** Delivery depends on reaching
Telegram; the ntfy secondary channel buys resilience against a Telegram *API*
outage or a bad bot token, not against network filtering — if Telegram is
filtered for you, ntfy.sh likely is too. The **Bale** channel (ships disabled)
addresses that case, as it is reachable from inside Iran; enable it only after
`diagnose` confirms the runner can reach `tapi.bale.ai`, since that call may
itself be refused from US IPs.

**Gist is a database of convenience.** Concurrent-safe only because of the
single-writer split; no history beyond 24h locally; a corrupt owned file is
rebuilt empty (losing at most 24h of history), while a corrupt or too-new
`alerts.json` makes the evaluator refuse to run rather than risk destroying alert
state it cannot read.

**Secondary channel choice (ntfy.sh).** Chosen because it is permanently free to
publish to, needs no account or credit card, and delivery is a single HTTPS POST
with no SDK — so it works from a runner with certainty. Rate limit (verified
2026-07-24): 60-message burst refilling one per 5 seconds, far above this bot's
one-message-per-alert-per-cooldown ceiling. A public topic is readable by anyone
who guesses its name, so use a long random `NTFY_TOPIC` — that is obscurity, the
same caveat as the Worker's secret path. Delivery is behind a pluggable interface
(`channels/`), so a third channel is one file plus one line in
`channels/index.js`, with zero changes to evaluation logic — the Bale adapter
demonstrates exactly that.

---

## Running the tests

Zero dependencies; Node 22+.
```bash
node test/worker.test.mjs          # 49 checks — parsing, validation, formatting
node test/worker-handler.test.mjs  # 17 checks — webhook security, always-200
node test/engine.test.mjs          # 33 checks — trigger semantics, single-writer
npm run sync:check                 # the two tiers' shared copies are identical
```
