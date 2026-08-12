# Channel Command

A private analytics dashboard for **YouTube** and **TikTok**, hosted free on
GitHub Pages. Live counters, per-video deep-dives, minute-by-minute launch
tracking, letter-grade report cards, coaching and an AI idea studio.

| | |
|---|---|
| **YouTube dashboard** | <https://reubenrich16.github.io/Analytics/> |
| **TikTok dashboard** | <https://reubenrich16.github.io/Analytics/tiktok.html> |
| **Compare** | <https://reubenrich16.github.io/Analytics/compare.html> |
| **Bookmark this** (enables the Worker features) | `…/Analytics/?worker=https://yt.reubenrichardson37.workers.dev` |

**Cost: $0.** GitHub Pages, GitHub Actions, the YouTube APIs, Cloudflare Workers
and the Gemini API all run on free tiers, and no billing account is attached
anywhere. Worst case something pauses until a quota resets.

---

## The four moving parts

```
yt-dashboard/     the websites  → deployed to GitHub Pages (gh-pages branch)
worker/           Cloudflare Worker → TikTok OAuth, AI proxy, sync, minute tracking
scripts/          GitHub Actions robots → record public stats into data/
data/             recorded history, committed by the robots
```

1. **The dashboards** (`yt-dashboard/`) are static HTML that talk to the APIs
   straight from your browser. `index.html` (YouTube) and `tiktok.html` share
   `style.css`, so themes only need building once. Deployed automatically by
   [`deploy-dashboard.yml`](.github/workflows/deploy-dashboard.yml).
2. **The Worker** (`worker/`) holds every secret that must not live in a public
   page, and runs a **one-minute cron**. Deployed by
   [`deploy-worker.yml`](.github/workflows/deploy-worker.yml).
3. **The robots** (`scripts/`) run on GitHub Actions and record public YouTube
   stats into `data/history.json` — the history YouTube itself never gives you.
4. **`data/`** is the recorded history, read by the dashboard at load.

---

## What the dashboards show

**Both platforms**

- Live counters with per-refresh movement, and a sortable table of every post
  (click any column header; it becomes readable cards on a phone)
- **Latest-upload card** with ◀ ▶ to cycle recent posts
- **Minute-by-minute launch tracking** — recorded by the Worker even when nobody
  has the site open, because the platforms don't provide it
- **Plateau projection** — "where is this one heading?", on the latest-upload card.
  A progress bar toward the launch's own likely finish, a plain-English sentence with
  the range, and a **Curve** toggle that carries the recorded line forward as a dashed
  projection inside a cone. See *How the projection works* below
- **Report Card** — an age-adjusted A+…F grade versus your own back catalogue,
  with "beats X% of your uploads" and tailored tips
- **Account breakdown** — lifetime totals and per-post averages
- **Coaching** — best day and time to post, posting rhythm, strongest tags, and a
  **next-milestone projection** ("at +12 subs/day you'll hit 7,500 around 30 October")
- **Idea Studio** — titles/captions, on-screen text, tags and next-video ideas,
  grounded in your own naming style (free) plus optional AI variations
- **Four rooms** — Now, Videos, Audience, Ideas — with a **One page** switch that turns
  them off and stacks every card exactly as it was before, so nothing is ever out of reach
- An **answer card** at the top: four chips that say in a sentence how today went, how the
  newest upload landed, who's watching and when you're next due. Computed from numbers
  already on the page, so it costs no extra quota
- **Milestone moments** — cross a subscriber or view milestone and the page blurs, the
  number fills the screen, confetti falls and a party sound plays. Once per milestone ever
- 14 themes, sound on new likes/subscribers, and a phone-friendly layout

**Type and motion**

Numbers are set in **Sora**, everything you read in **Figtree**. Eight motions carry the
moments that matter: headline numbers roll like an odometer, cards arrive staggered, a new
like sends a ring and hearts off its tile, charts draw with the fill rising underneath,
the deep-dive grows out of the row you tapped, loading shimmers in the real shape instead
of shoving the page, the date range slides in the direction you moved, and milestones get
the full-screen treatment. Every one of them respects `prefers-reduced-motion`.

**How the charts are drawn**

Every chart is hand-rolled inline SVG — no chart library, nothing to download —
and they all follow the same rules so they read the same way:

- Y-axis ticks land on **human numbers** (0 · 500 · 1,000, compacted to `k`/`M`),
  and every gridline is labelled, so a value never depends on hovering.
- Hovering shows a **crosshair** that snaps to the nearest day, plus a tooltip.
  On columns the whole day-band lights up instead.
- Thin marks and hairline gridlines; columns are capped at 24px with a 4px
  rounded top and a 2px gap; area fills are a ~10% wash, never a solid block.
- Values are direct-labelled **selectively** — the endpoint and the peak — rather
  than a number on every point.
- Any chart with more than one line carries a **legend**.
- On a phone the axis text scales back up, so labels stay readable at 390px wide.
- **Reach vs reaction** (YouTube, in Account breakdown) is a scatter of views
  against likes with your average like-rate as the reference line — the one view
  that shows every video at once. The newest upload is called out by size *and* a
  written label, not colour alone, because several themes are deliberately
  monochromatic.

**How the projection works**

It doesn't guess, it counts. Curve fitting was tried first and abandoned: a launch is
S-shaped — it crawls while the platform decides whether to surface it, then climbs — and
every growth curve fitted the tail well and the first hours badly, which is the half that
matters. So instead, the launches already recorded say what share of a post's 48-hour
total had usually arrived by hour X. Today's count divided by that share is the estimate.

The margin is measured rather than assumed. Each recorded launch is left out in turn and
predicted from the others, and the worst miss becomes the band — so an account whose posts
behave alike gets a tight range and one whose posts vary gets a wide one, from its own
data. Four rules keep it honest:

- **Nothing under five hours.** At four, one of the three recorded curves still escapes
  its own band. It says so plainly rather than showing a range wide enough to be useless.
- **Nothing when the account is too varied** to call within about half. Same reasoning.
- **Reference curves with a hole where the prediction gets made are thrown away.** A gap
  is judged against the age it ends at: two missing hours at 39h are a missed cron in the
  flat tail, while the same two hours at 5h remove exactly the share being asked for. On
  the recorded curves that separates cleanly — the real artefacts are 21-hour holes ending
  at 27h, left by the Worker's window widening from 6 hours to 48. **Starting late is not
  disqualifying**; a curve first sampled at 4h simply abstains from earlier ages, which is
  what keeps every TikTok curve usable, since the Worker only began recording those posts
  on the day the account was connected.
- **The low end never sits below the count already banked**, and the band is never
  narrower than ±3%.

Measured by running the shipped model over the launches actually recorded, one held out at
a time: worst miss 20% at five hours, 17% at six, 10% at twelve, 3% by eighteen, and every
held-out curve lands inside its own band from five hours on. Past about a day the residual
misses are YouTube revising a count downward after the fact, which nothing predicts.
`node scripts/plateau.test.mjs` lifts the model straight out of the page — so the test
cannot drift from what ships — and pins these properties.

**Compare** (the third page)

Links a YouTube upload to its TikTok counterpart and answers three things. Pairing is
suggested automatically — caption similarity with hashtags and emoji stripped, how close
the two were posted, and whether the TikTok looks like a cut — but **nothing is linked
until you confirm it**, because a wrong pair would poison every number below. There's a
manual picker for anything the suggester misses. Confirmed pairs are stored on the Worker
(owner-locked, same auth as sync) and fall back to the device if there's no Worker.

- **Side by side** — totals and rates for both, plus each post's **percentile within its own
  platform's back catalogue**. That's the honest comparison: TikTok counts a view the moment
  playback starts, YouTube long-form wants a real watch, so the raw counts are two different
  rulers. The page says so, on the page.
- **The launch race** — both curves indexed to each platform's own typical launch (100 =
  normal). Only covers the window both sides recorded; the Worker keeps each post's first 48
  hours, and the page tells you the actual overlap.
- **Time to a thousand** — a clock, so no units problem, with your usual YouTube pace as a
  third bar.

> Neither platform gives you launch history, so curves exist only from when the robots were
> already watching. Anything posted before then has none and can't get one retrospectively.

**YouTube only** (TikTok's API simply doesn't expose these)

Watch time, retention curves, **retention vs other YouTube videos of similar
length** (the one external benchmark the API offers), **saves** to playlists,
**dislikes** (owner-only via the Analytics API), traffic sources, YouTube search
terms, suggested-by videos, countries, devices, subscribers vs new audience,
playback locations, shares by app, info-card clicks, age & gender, Shorts vs
long-form, playlists, benchmark channels, search-rank tracking and Studio CSV
import for impressions/CTR.

> **Why TikTok shows less:** its free Display API returns views, likes, comments
> and shares only. Retention, traffic sources and demographics exist solely in
> TikTok's Research API (academics) or Business API (approval required).

---

## Setup

Each part is independent — the dashboards work on their own, and every extra
piece adds capability without breaking what's already there.

### 1. YouTube sign-in (required for the YouTube dashboard)

In Google Cloud Console:

1. **Enable APIs** — YouTube **Data API v3** and YouTube **Analytics API**.
2. **OAuth consent screen** — External, add every user under **Test users**.
3. **Data access → scopes** — add these three, or non-owner testers are refused:
   `youtube.readonly`, `yt-analytics.readonly`, `youtube.force-ssl`
4. **Credentials** → OAuth client ID → **Web application** → Authorized
   JavaScript origin: `https://reubenrich16.github.io`
5. Open the dashboard once as
   `…/Analytics/?client_id=YOUR_CLIENT_ID` — it's remembered after that.

> ⚠️ **Never add a Google Drive scope.** Supervised and managed Google accounts
> are blocked from Drive, and requesting it makes Google refuse their sign-in
> entirely with "Service unavailable". Cross-device sync runs through the Worker
> instead, precisely so every account can sign in.

### 2. The history robots (optional, ~3 minutes)

They can't use your interactive sign-in, so they run on a plain **API key** and
read public data only. Add these **repository secrets** (Settings → Secrets and
variables → Actions):

| Secret | Purpose |
|---|---|
| `YT_API_KEY` | a Google API key, restricted to YouTube Data API v3 |
| `CHANNEL_ID` | `UCyours,UCpartners` — comma-separated, each fully tracked |
| `BENCH_CHANNELS` | *optional* — 2–3 similar channels to benchmark against |

[`snapshot.yml`](.github/workflows/snapshot.yml) runs every 5 minutes (recording
all videos hourly, and fresh uploads in between) and raises a GitHub issue on
milestones. [`rank.yml`](.github/workflows/rank.yml) checks weekly search ranks
for the phrases in [`data/keywords.json`](data/keywords.json).

### 3. The Cloudflare Worker (optional but recommended)

Unlocks minute-by-minute offline tracking, cross-device sync, shared AI, and all
of TikTok. Free, no card.

1. Create a free Cloudflare account, then an **API token** using the
   *Edit Cloudflare Workers* template, and note your **Account ID**.
2. Add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus
   `GEMINI_KEY` (optional, for AI) and `TIKTOK_CLIENT_SECRET` (optional, for
   TikTok).
3. Run **Deploy per-minute Worker to Cloudflare** from the Actions tab. It
   applies [`worker/schema.sql`](worker/schema.sql) to D1, deploys the code with
   the KV + D1 bindings and the one-minute cron from
   [`worker/wrangler.toml`](worker/wrangler.toml), and uploads the secrets.
4. Open the dashboard once with `?worker=https://…workers.dev` appended.

> Adding a repo secret does **not** re-run the workflow — trigger it manually,
> or the Worker won't have the new value.

**Worker routes**

| Route | Purpose |
|---|---|
| `/` | the recorded YouTube minute bundle |
| `/run` | run both trackers now (handy for testing) |
| `/d1diff` | compares the D1 and KV copies field by field (expect disagreement now: KV is deliberately coarser since the write gate — this was the phase-2 verification tool) |
| `/models` | which Gemini models your key can actually call |
| `/ai`, `/sync` | AI ideas and cross-device sync, locked to your channels |
| `/pairs` | confirmed YouTube↔TikTok video pairings (owner-locked) |
| `/tiktok/login`, `/tiktok/callback` | TikTok sign-in |
| `/tiktok/me`, `/tiktok/videos`, `/tiktok/history`, `/tiktok/sync`, `/tiktok/ai` | TikTok data |

**Where the minute samples live**

They started in a single KV blob, rewritten once a minute while any post was inside its
launch window. Cloudflare's free KV tier allows **1,000 writes a day**, and two or three
uploads across both platforms produce overlapping windows running most of the day — around
**2,000 writes**, so sampling silently stopped once the cap was hit, on exactly the busy
days you most wanted it.

Samples now live in **D1** (`worker/schema.sql`), whose free tier allows **100,000 rows a
day** and 5 GB, kept for 60 days. One row per post per minute instead of one rewrite of
everything — which is what let the launch window go from **6 hours to 48**, still sampled
once a minute the whole way through.

Two things make that affordable. Reads are **incremental**: a poll sends `?since=` and gets
back only the minutes it hasn't seen, because re-shipping a 48-hour window every three
minutes would exhaust D1's 5,000,000 daily row-reads before the day was out. And the KV
mirror is written at most every 15 minutes rather than every minute — a roster change or a
failed D1 write still persists immediately, but ordinary sample growth waits.

Both stores are still written every tick. D1 answers reads; if it fails *or comes back
empty while KV has data*, KV answers instead and the page never notices — the JSON is
identical either way. The `X-CC-Source` response header names whichever one answered.

**Keeping both is the settled decision, not an unfinished migration.** The plan once had a
final step that retired KV after D1 had proved itself; it was dropped on purpose. The
fallback is only real because KV is still being written, retiring it would save around 96
writes a day out of 1,000, and it would turn a one-line rollback into a migration. If you
are reading this and about to "finish the job" — don't.

| Query | Effect |
|---|---|
| *(none)* | D1, falling back to KV |
| `?src=d1` | force D1, and report an error rather than falling back |
| `?src=kv` | force KV |

### 4. TikTok

Full walkthrough in **[`docs/tiktok-setup.md`](docs/tiktok-setup.md)**. Summary:
register a free developer app, add **Login Kit** (there is no separate "Display
API" product — it's granted by scopes), request `user.info.basic`,
`user.info.profile`, `user.info.stats` and `video.list`, set the Login Kit
redirect URI to `https://yt.reubenrichardson37.workers.dev/tiktok/callback`, and
create a **Sandbox** listing each account under **Target users**. Sandbox needs
no app review and keeps the app private.

The client key lives in `wrangler.toml` (it isn't sensitive — the browser sends
it in the OAuth URL). Only `TIKTOK_CLIENT_SECRET` is a secret.

### 5. Optional extras

- **AI Idea Studio** — a free [Gemini API key](https://aistudio.google.com/apikey)
  as `GEMINI_KEY` on the Worker serves everyone with no per-device setup. Or
  paste a personal key under **⚙ AI setup**, stored only on that device. The
  Worker discovers which models your key supports and remembers a working one.
- **Impressions & CTR** — no API provides these. YouTube Studio → Analytics →
  Advanced mode → Export CSV, then **Import Studio CSV** at the bottom of the
  dashboard.
- **Search keywords** — edit [`data/keywords.json`](data/keywords.json)
  (each costs 100 quota units per week).

---

## Security

- **No password ever touches this app.** Google and TikTok handle sign-in; the
  app only receives a short-lived token.
- **Secrets never reach the browser.** The Gemini key and TikTok client secret
  live on the Worker. The page only holds an opaque session id, handed back in
  the URL *fragment* so it stays out of server logs.
- **Everything is owner-locked.** The AI and sync endpoints verify you own one of
  the tracked channels; TikTok Sandbox only admits listed accounts.
- **Read-only.** Nothing can post, edit or delete on either platform.
- The session token is excluded from export/sync, and so is any personal Gemini
  key.

Published policies: [privacy](https://reubenrich16.github.io/Analytics/privacy.html)
· [terms](https://reubenrich16.github.io/Analytics/terms.html)

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| **"Service unavailable"** on Google sign-in | That account is supervised/managed. Use an unrestricted account, or add it as a manager of the Brand Account. |
| **"Access blocked / not verified"** | The account isn't in **Test users**, or scopes aren't registered under Data access. |
| **Sign-in blocked in Messenger/Instagram** | Google blocks in-app browsers — open in Safari or Chrome. |
| **Dislikes column shows `·`** | `·` means no data, `0` means genuinely none. The note under the table says which. |
| **AI says quota exceeded** | The Gemini *API* free tier is separate from a Gemini app subscription. It retries across models and resets daily. |
| **TikTok sign-in fails** | The error page names the cause. Usually the redirect URI is in the Webhooks box instead of **Login Kit → Web**. |
| **Worker says "not configured"** | Its secrets are missing — re-run the deploy workflow after adding them. |

## Repo layout

```
yt-dashboard/   index.html · tiktok.html · compare.html · style.css · privacy.html · terms.html
worker/         worker.js · wrangler.toml
scripts/        snapshot.mjs · rank.mjs
data/           history.json · alerts.json · ranks.json · keywords.json
docs/           tiktok-setup.md · youtube-ideas.md
brand/          icon.svg + PNG renders · PHILOSOPHY.md
```
