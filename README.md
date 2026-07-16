# Analytics

Live YouTube channel dashboard ("Channel Command") hosted on GitHub Pages.

## Dashboard

- **Dashboard URL:** https://reubenrich16.github.io/Analytics/
- **OAuth origin (for Google Cloud Console):** `https://reubenrich16.github.io`

The page in [`yt-dashboard/index.html`](yt-dashboard/index.html) is deployed
automatically by the [`deploy-dashboard.yml`](.github/workflows/deploy-dashboard.yml)
workflow whenever it changes. No build step — it's a single static HTML file
that talks directly to the YouTube Data + Analytics APIs from your browser.

**What it shows:** live view/like/comment counters and per-video movement;
channel trends (daily subscriber gains/losses, channel views & watch time,
top videos by watch time, Shorts vs regular split, playlist performance);
and a per-video deep-dive (daily views, retention curve, traffic sources,
YouTube search terms, suggested-by videos, external websites, countries,
devices & systems, subscribers vs new audience, playback locations, shares
by app, info-card clicks, age & gender). Everything is labelled in plain
language.

**Cost: $0.** GitHub Pages is free, the YouTube Analytics API is free, and
the YouTube Data API has a free 10,000-unit daily quota. At the default 60s
refresh the live counters use well under that even if left open all day,
and polling pauses automatically when the tab is hidden. There is no
billing account attached anywhere, so nothing can ever be charged — worst
case the counters pause until the quota resets at midnight Pacific.

## One-time Google Cloud Console setup (~3 minutes)

Done in the same Google Cloud project you already use (e.g. "Shinny YT"):

1. **Enable APIs** — API Library → enable **YouTube Analytics API** and
   **YouTube Data API v3**.
2. **OAuth consent screen** — External → app name `yt-dashboard`, your email
   in both email fields → Save through the screens → under **Test users**,
   add your own Gmail.
3. **Credentials** → + Create Credentials → **OAuth client ID** → type
   **Web application** → under **Authorized JavaScript origins** add:
   `https://reubenrich16.github.io` → Create → copy the **Client ID**.

## Daily use

Open (and bookmark on every device):

```
https://reubenrich16.github.io/Analytics/?client_id=YOUR_CLIENT_ID_HERE
```

The `?client_id=` parameter prefills the Client ID forever — just tap
**Sign in with Google**.

## Phase 2 — the history robot (one-time setup, ~3 minutes)

Two GitHub Actions live in this repo: an **hourly snapshot** of public stats
(`snapshot.yml` → `data/history.json`, plus milestone alerts as GitHub
issues) and a **weekly search-rank check** (`rank.yml` → `data/ranks.json`).
They can't use your dashboard sign-in (that's interactive-only), so they run
on a plain **API key** — public data only. To switch them on:

1. **Create an API key**: Google Cloud Console → same project → APIs &
   Services → Credentials → **+ Create Credentials → API key**. (Optional
   hardening: restrict it to the YouTube Data API v3.)
2. **Find your channel ID**: hover your channel name in the dashboard after
   signing in (it's in the tooltip), or youtube.com/account_advanced.
3. **Add repo secrets**: GitHub → this repo → Settings → Secrets and
   variables → Actions → New repository secret:
   - `YT_API_KEY` — the API key
   - `CHANNEL_ID` — your channel ID (starts with `UC`). To fully track more
     than one channel (e.g. yours and a partner's), list them
     comma-separated: `UCyours,UCpartners`. Each gets its own subscriber
     history, per-video hourly stats, milestones and acceleration; the
     dashboard shows whichever one is signed in.
   - `BENCH_CHANNELS` *(optional)* — comma-separated channel IDs of 2–3
     similar channels to benchmark against (growth comparison only, not full
     per-video history)
4. **Pick search keywords** *(optional)*: edit `data/keywords.json` and list
   up to 10 search phrases to track weekly (each costs 100 units/week).
5. Run the "Hourly stats snapshot" workflow once manually from the Actions
   tab to confirm it goes green.

The dashboard picks the data up automatically: exact subscriber history,
views-per-hour on every video, ⚡ acceleration badges, benchmark growth
comparison, milestones, and search ranks all appear once history exists.

**Studio CSV (CTR & impressions):** no API provides these. In YouTube
Studio → Analytics → Advanced mode → Export current view → CSV (with
Content, Impressions and click-through-rate columns), then use **Import
Studio CSV** at the bottom of the dashboard. Impressions & CTR then show in
each video's Scorecard.

## Idea Studio — title, on-screen text, tag & next-video ideas

The **Idea Studio** card turns a one-line description of a video into ideas that
match your *own* channel. Two tiers:

- **Free, no setup:** it reads your titles, tags and view counts and suggests
  title templates in your naming style, tags your best videos use, on-screen
  text starters, and next-video ideas from gaps in your best-performing themes.
- **Optional AI:** creative variations from Google Gemini. Two ways to enable it:
  - **Provided for you both (recommended):** set a `GEMINI_KEY` secret on the
    Cloudflare Worker (see below). The key stays server-side and the Worker
    answers only for a signed-in account listed in `CHANNEL_ID`, so **neither of
    you pastes anything** and only the two of you can use it.
  - **Per device:** paste your own free
    [Gemini API key](https://aistudio.google.com/apikey) under **⚙ AI setup**.
    It's stored **only on that device** — never synced or exported.

  Either way the request sends only your public video info and your own stats,
  never anything about your account beyond the channel-ownership check.

## Cross-device sync (optional) — same Google account, same data everywhere

The dashboard can sync its device-local data (paid keyword research, the
Studio CTR import, and the minute-race recordings) through a **sandboxed
hidden folder in your Google Drive** — so every device signed into the same
Google account shares it automatically. It's free and needs no backend. The
`☁ synced` badge at the bottom of the page shows when it's active.

One-time setup:
1. **Enable the Drive API**: Google Cloud Console → same project → APIs &
   Services → Library → **Google Drive API** → **Enable**.
2. **Re-consent**: sign out of the dashboard and sign back in. Google will
   ask to approve one new item — access to its own hidden app-data folder.
   Approve it. (This scope is *sandboxed*: the app can only see the single
   JSON file it writes, never your real Drive files.)

If you skip this, nothing breaks — the dashboard just stays local-only and
the manual **Export / Import** buttons still work.

## Per-minute offline tracker (optional) — catch a launch minute-by-minute

The GitHub robot snapshots every 5 minutes, and the dashboard records its own
minute-by-minute race only while it's open. If you want a **brand-new upload
tracked every single minute even when nobody has the dashboard open**, deploy
the tiny Cloudflare Worker in [`worker/`](worker/). It runs on Cloudflare's
free cron, records the launch, and the dashboard merges those minutes into the
race the next time it opens.

It's **free and safe**: it uses the *same public API key* as the robot — no
sign-in, no OAuth, no account access, just public view counts. It only writes
while a video is inside its first few hours (`HOT_HOURS`, default 6), so it
stays well inside the free tier.

One-time setup (~5 minutes, needs [Node.js](https://nodejs.org)):

1. **Make a free Cloudflare account** at dash.cloudflare.com (no card needed).
2. In a terminal, from the `worker/` folder:
   ```bash
   cd worker
   npx wrangler login                       # opens the browser to authorise
   npx wrangler kv namespace create MINUTE  # prints an id="..."
   ```
   Paste the printed `id` into `wrangler.toml` (replace
   `PUT_YOUR_KV_NAMESPACE_ID_HERE`).
3. **Set the secrets** (they never touch git):
   ```bash
   npx wrangler secret put YT_API_KEY     # paste the same API key as the robot
   npx wrangler secret put CHANNEL_ID     # UCyours  (or UCyours,UCpartners)
   npx wrangler secret put GEMINI_KEY     # OPTIONAL — turns on the owner-locked AI ideas
   ```
   `GEMINI_KEY` is only needed if you want the Worker to power the Idea Studio AI
   for both of you. When set, the Worker answers the dashboard's `/ai` request
   only when it carries a login token for a channel listed in `CHANNEL_ID` — so
   the key stays secret and only you and your partner can spend the quota.
4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
   Wrangler prints the Worker URL, e.g.
   `https://yt-minute-tracker.<you>.workers.dev`.
5. **Point the dashboard at it** — open it once with the URL appended (it's
   remembered forever on that device, so re-bookmark it):
   ```
   https://reubenrich16.github.io/Analytics/?worker=https://yt-minute-tracker.<you>.workers.dev
   ```

To check it's alive, visit `https://…workers.dev/run` — it does one recording
pass immediately and shows how many videos it's tracking. If you skip all this,
nothing breaks; the 5-minute robot still captures every upload.

## Alternative: standalone repo via CLI

`yt-dashboard/publish.sh` is the original one-shot publisher. If you'd rather
host the dashboard in its own `yt-dashboard` repo, run it locally from a
machine with the authenticated `gh` CLI:

```bash
cd yt-dashboard && bash publish.sh
```
