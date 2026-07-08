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

## Alternative: standalone repo via CLI

`yt-dashboard/publish.sh` is the original one-shot publisher. If you'd rather
host the dashboard in its own `yt-dashboard` repo, run it locally from a
machine with the authenticated `gh` CLI:

```bash
cd yt-dashboard && bash publish.sh
```
