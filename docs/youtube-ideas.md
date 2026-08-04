# What else the YouTube dashboard could do

A survey of what's available but not yet used — split into **new data** (metrics
the YouTube API offers that we don't currently request) and **new features**
(things we can build from data we already have, at no extra API cost).

Current metrics in use: `views`, `estimatedMinutesWatched`, `averageViewDuration`,
`averageViewPercentage`, `likes`, `dislikes`, `comments`, `shares`,
`subscribersGained`, `subscribersLost`, `audienceWatchRatio`, `viewerPercentage`,
`cardImpressions`, `cardClicks`, `cardClickRate`, `playlistStarts`.

---

## ✅ Built

- **A1 relativeRetentionPerformance** — shipped, in each video's deep-dive.
- **A2 saves (videosAddedToPlaylists)** — shipped: table column, drawer tile, account total.
- **B2 milestone projections** — shipped on both dashboards (subscribers / followers).
- **Chart overhaul** — human-number axes with every gridline labelled, crosshair
  hover, selective direct labels, legends, thinner marks, phone-legible axis text.
- **Reach vs reaction scatter** — views against likes for every video, with the
  average like-rate as a reference line (Account breakdown).
- **Stat-tile sparklines** — a 12-point trend under Views / Likes / Subscribers /
  Comments, drawn from the snapshot robot's recorded history.

## A. New data we're not pulling yet

### A1. `relativeRetentionPerformance` — the standout ⭐
How well a video holds viewers **compared with other YouTube videos of a similar
length**, across all of YouTube. 0.5 = average; above = better than typical.

Why it matters: every retention number we show today is only relative to *her own*
catalogue. This is the one metric that answers "is this actually good?" in absolute
terms — a genuine outside benchmark, and it feeds the Report Card grade nicely.

### A2. `videosAddedToPlaylists` / `videosRemovedFromPlaylists` — the save signal ⭐
How often people save a video to a playlist (incl. Watch Later). Saves are a strong
quality signal and a good early indicator, especially for sleep/ASMR content that
people deliberately come back to. Not visible anywhere in the dashboard today.

### A3. End-screen metrics
`endScreenElementImpressions`, `endScreenElementClicks`, `endScreenElementClickRate`
(added to the API in January 2026). We already show info-card performance; this is
the equivalent for end screens, i.e. how well one video hands off to the next.

### A4. `redViews` / `estimatedRedMinutesWatched`
Views and watch time from YouTube Premium members. Interesting because Premium
watch time is paid differently and often skews to longer, sleep-style viewing.

### A5. Playlist depth: `viewsPerPlaylistStart`, `averageTimeInPlaylist`
We show `playlistStarts` but not how far people get once they start. Useful for
sleep playlists where the whole point is a long unattended session.

### A6. Sub vs non-sub trend over time
We already show `subscribedStatus` for a single video. Running it by `day` at the
channel level shows whether growth is coming from existing fans or new audience.

---

## B. New features from data we already have (no extra quota)

### B1. Two-channel comparison ⭐
The history robot already records **both** channels, but the dashboard only ever
shows whichever one is signed in. A comparison view (growth curves side by side,
who's gaining faster, whose videos land better) is free — the data is already in
`history.json`.

### B2. Milestone projections / ETA ⭐
"At the current pace you'll hit 10,000 subscribers around 15 September."
Straightforward from the recorded subscriber history, and much more motivating
than a raw count.

### B3. Evergreen vs spike analysis
Which videos keep earning views weeks later versus those that spike and die.
Computable from the robot's long-run history, and it directly informs what's worth
making more of.

### B4. Upload consistency / streak tracker
Posting cadence over time, gaps, and whether consistency correlates with growth.
The Coaching card already computes posting rhythm — this visualises it.

### B5. Weekly digest
The robot already opens GitHub issues for milestones; it could post a weekly
summary (best video, growth, what changed) so you get a recap without opening the
dashboard.

### B6. Thumbnail / title change tracking
Record when a video's title or thumbnail changes and compare performance before
and after. The robot polls titles already, so detecting changes is nearly free.

### B7. Printable / exportable report
A clean one-page summary for a given month — useful for sponsors or just
record-keeping.

---

## Suggested order

1. **A1 relativeRetentionPerformance** — biggest insight per unit of work, and
   plugs straight into the existing Report Card.
2. **A2 saves** — a genuinely new and meaningful signal for this niche.
3. **B1 two-channel comparison** — free, uses data already recorded, and it's the
   thing two creators in one household actually want.
4. **B2 milestone projections** — small, motivating, cheap.
5. Everything else as appetite allows.
