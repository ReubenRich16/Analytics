# Channel Command — Build Instructions for Claude Code

Drop this into the repo (as its own file, or append to `CLAUDE.md`). It describes changes to the existing single-file dashboard (`channel-command.html` / `index.html`). Implement against whatever the current file looks like — verify each feature exists, add the missing ones. Do not rewrite working code you don't need to touch.

## Context & hard constraints

- The app is a **single static HTML file** served from GitHub Pages. No backend, no build step. Keep it that way.
- Auth is already handled: Google OAuth token grants `youtube.readonly` + `yt-analytics.readonly`. Reuse the existing `accessToken` and the `dataApi()` / `analyticsApi()` helpers. Do not add new scopes.
- Two endpoints only:
  - Data API — `https://www.googleapis.com/youtube/v3/` — **1 quota unit/call** (except `search.list`).
  - Analytics API — `https://youtubeanalytics.googleapis.com/v2/reports` — **1 unit/call**, always `ids=channel==MINE`.
- **`search.list` costs 100 units/call.** This is the whole reason for the caching rules below. Free tier = 10,000 units/day, shared with the live pollers.
- **Do not break** the live loop: it must stay `videos.list?part=statistics` (1 unit, batched 50 IDs/call) and keep the visibility auto-pause. Nothing in this brief should run on the polling interval.
- Analytics data lags 24–48h and excludes today — label anything analytics-derived accordingly. It will not match the live counters.

## Global rules for everything below

1. **Persist, don't re-fetch.** All analytics reports and (especially) keyword research are cached in `localStorage`. Read cache first; only hit the API on a cache miss or an explicit user "refresh".
2. **Lazy-load.** Per-video deep data (retention, search terms, geo, keyword research) loads only when the user opens that video's drawer — never for all videos at once.
3. **Quota budget guard.** Maintain a daily counter (see schema). Before any `search.list`, check the budget; if exceeded, block and show "keyword searches used up for today — resets midnight Pacific". Default cap: **20 search.list calls/day** (2,000 units), leaving headroom for the pollers.
4. Keep the existing dark theme / fonts / CSS-variable palette. Match existing component styling.

---

## Features 1–8 — per-video analytics (in the detail drawer)

Most of these may already exist in the drawer. Verify each renders; add what's missing. All use `analyticsApi(params)` with `filters` including `video==VIDEO_ID` and the drawer's current date range. Cache each report under `cc:analytics:v1:<videoId>:<rangeKey>`.

**1. Retention curve** — % still watching across the video.
```
dimensions=elapsedVideoTimeRatio  metrics=audienceWatchRatio
filters=video==VIDEO_ID
```
Render as a line chart (0→100% of video on x, watch ratio on y). Call out the midpoint % and the largest drop-off point in text.

**2. Avg % viewed + avg view duration** — already in the summary metric grid. Confirm both `averageViewPercentage` and `averageViewDuration` are shown. Also surface these as sortable columns on the main video table (see the batch query note under "Channel-level rollups").

**3. Real search terms** — the actual queries that drove views to this video. NEW — add it.
```
dimensions=insightTrafficSourceDetail  metrics=views
filters=video==VIDEO_ID;insightTrafficSourceType==YT_SEARCH
sort=-views  maxResults=25
```
`sort` is required and `maxResults` must be ≤25 for this report. Render as a ranked list (term + views). Low-view terms are hidden by YouTube's privacy threshold and rolled into an unnamed bucket — note that. These terms are also the preferred query source for Feature 9.

**4. Traffic sources** — already present as horizontal bars.
```
dimensions=insightTrafficSourceType  metrics=views,estimatedMinutesWatched  sort=-views
```
Keep the human-readable label map (RELATED_VIDEO → "Suggested videos", YT_SEARCH → "YouTube search", etc.).

**5. Subscribers gained per video** — `subscribersGained` / `subscribersLost` are already in the drawer summary. Also add a **per-video subs column** to the main table via the batch rollup query below.

**6. Daily-views trend** — already present.
```
dimensions=day  metrics=views,estimatedMinutesWatched  sort=day
```
Keep the sparkline + date span + peak/day label.

**7. Demographics + geography** — age/gender likely exists; ADD geography.
```
# age/gender (existing)
dimensions=ageGroup,gender  metrics=viewerPercentage  sort=gender,ageGroup
# geography (new)
dimensions=country  metrics=views,estimatedMinutesWatched  sort=-views  maxResults=15
```
Country returns ISO-3166 codes — map the top ~10 to names and show as bars. This drives upload-timing decisions, so show it near the age/gender block.

**8. Shares** — `shares` is already in the summary grid. Also expose it in the main-table rollup so share-magnets are visible at a glance.

### Channel-level rollups (one cheap call powers table columns for 2, 5, 8)

Instead of one call per video, fetch per-video comparison metrics in a **single** analytics call using the `video` dimension with a multi-video filter (≤500 IDs), driven by the current range:
```
dimensions=video
metrics=views,averageViewPercentage,subscribersGained,shares
filters=video==ID1,ID2,ID3,...
sort=-views  maxResults=200
```
Cost: 1 unit. Cache under `cc:rollup:v1:<rangeKey>`. Use it to add Avg %, Subs, Shares columns to the main table. Reminder: this is lagged data, not live — the live table columns (views/likes/comments) stay from the pollers; these three are clearly marked as "analytics (to <date>)". Respect the report limit: videos × days in range must stay under 50,000 (split into batches if needed).

---

## Feature 9 — Keyword & hashtag review vs similar videos

Goal: for a given video, compare its own tags/hashtags against the videos that rank for how it's actually discovered, and surface which tags/hashtags the competition shares that this video is missing.

### Hard rule: one `search.list` per video, ever

- Run `search.list` **at most once per video**, then persist the full result set. Never call it again for that video unless the user clicks an explicit **"Re-run research (100 units)"** button.
- Enforce via cache: if `cc:kwcache:v1:<videoId>` exists, load from it and make zero API calls. Cache miss → run the pipeline once, write cache.
- Gate every `search.list` behind the daily budget guard (rule 3).

### Pipeline (runs once per video, on a "Research keywords" button in the drawer)

1. **Pick the query.** Prefer the video's top real search term from Feature 3 (most representative of how it's found). If no term clears the threshold, fall back to the cleaned video title (strip emoji/hashtags, trim to ~6 words).
2. **Find similar videos** — the only `search.list` call:
   ```
   search.list  part=snippet  type=video  q=<query>  maxResults=25  order=relevance
   ```
   (100 units.) Collect the returned videoIds, excluding the user's own.
3. **Hydrate them** — batched, 1 unit:
   ```
   videos.list  part=snippet,statistics  id=<up to 50 comma-separated IDs>
   ```
   From each: `snippet.tags[]` (the uploader's tags — the API returns these for public videos), `snippet.title`, `snippet.description`, `statistics.viewCount`, `snippet.publishedAt`.
4. **Extract hashtags** — parse `#\w+` from every title + description (both the similar videos' and this video's own).
5. **Aggregate:**
   - Count tag frequency and hashtag frequency across the similar set.
   - Compute the similar set's **median views** (and this video's views for comparison).
   - Compute **gap lists**: tags/hashtags that appear in ≥2 similar videos but are absent from this video's own tags/hashtags → "consider adding".
6. **Persist everything** to `cc:kwcache:v1:<videoId>` (schema below) and render.

### Render (new drawer section, "Keyword & Tag Lab")

- The query used + when it was fetched + a "cached — no quota used" badge, or the "Re-run (100 units)" button.
- This video's own tags & hashtags.
- Ranked shared tags and shared hashtags across similar videos (chip + count), with the "missing from this video" ones highlighted.
- Similar-video list: title, channel, views, with this video's views and the set median for context.

---

## localStorage schema

```json
// keyword research — one per video, written once
"cc:kwcache:v1:<videoId>": {
  "fetchedAt": "2026-07-06T09:00:00Z",
  "query": "soft tapping asmr",
  "ownTags": ["asmr","tapping"],
  "ownHashtags": ["#asmr","#tingles"],
  "similar": [
    { "videoId": "abc", "title": "...", "channelTitle": "...",
      "views": 12345, "publishedAt": "2026-05-01T...",
      "tags": ["..."], "hashtags": ["#..."] }
  ],
  "aggregate": {
    "tagCounts": { "asmr": 18, "tingles": 9 },
    "hashtagCounts": { "#asmr": 14 },
    "medianViews": 8400,
    "missingTags": ["no talking","fast tapping"],
    "missingHashtags": ["#notalking"]
  }
}

// analytics report cache — per video per range
"cc:analytics:v1:<videoId>:<rangeKey>": { "fetchedAt": "...", "reports": { "retention": {...}, "searchTerms": {...}, "geo": {...} } }

// channel rollup cache — per range
"cc:rollup:v1:<rangeKey>": { "fetchedAt": "...", "rows": [ ["videoId", views, avgPct, subsGained, shares], ... ] }

// daily quota budget for search.list
"cc:kwbudget:v1": { "date": "2026-07-06", "searchListCalls": 3 }
```
Reset `searchListCalls` to 0 whenever `date` != today (Pacific). `rangeKey` = the range button value (e.g. `28`, `90`, `lifetime`).

### Cross-device note (important)

`localStorage` is per-browser/per-device, so the "once per video" cache is per device — each of your 2–3 devices would seed its own copy. To keep it truly once and share it:

- Add **Export cache** (download all `cc:*` keys as one JSON) and **Import cache** (merge an uploaded JSON back into localStorage) buttons.
- Seed research on one device, export, import on the others (or commit the JSON to the repo and auto-load it on start if present). This is the pragmatic substitute for a shared backend. Implement export/import; wire repo auto-load only if trivial.

---

## Acceptance criteria

- [ ] Live loop unchanged: `videos.list?part=statistics`, batched, visibility auto-pause intact. No new per-tick calls.
- [ ] Drawer shows all of: retention (1), avg %/duration (2), real search terms (3), traffic sources (4), subs gained/lost (5), daily trend (6), age+gender+geo (7), shares (8).
- [ ] Main table gains analytics columns for avg %, subs gained, shares from ONE rollup call, clearly labelled as lagged.
- [ ] "Research keywords" runs exactly one `search.list` per video, then serves from cache forever unless "Re-run (100 units)" is clicked.
- [ ] Daily budget guard blocks `search.list` past the cap and shows remaining count.
- [ ] Keyword Lab shows own vs shared tags/hashtags, the missing-tag gap list, and similar-video views vs this video + median.
- [ ] Export/Import cache buttons work; all state is JSON-portable.
- [ ] Every analytics-derived number carries a "to <date>" / lagged label.
- [ ] Still a single static file; opens from the GitHub Pages URL with no console errors.
