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
- **View velocity** — what arrived since the last refresh, as a sixty-slot strip plus a
  running session total. On TikTok this accumulates each post's own movement rather than
  differencing the account total, because the app fetches at most the 60 newest posts and
  that total *falls* when an older one scrolls out of the window. A quick reload **resumes**
  the session (the gap is counted, not dropped); a cold open **backfills** the strip, faded,
  from the recorded minute samples — never smeared from coarser ones, because nothing on
  these pages interpolates
- **Latest-upload card** with ◀ ▶ to cycle the ten most recent posts. Every slot gets the
  full treatment — the same-age race and the launch-curve overlay used to appear only on
  the newest upload, so nine slots out of ten showed nothing where a chart belongs
- **Minute-by-minute launch tracking** — recorded by the Worker even when nobody
  has the site open, because the platforms don't provide it
- **Plateau projection** — "where is this one heading?", on the latest-upload card.
  A progress bar toward the launch's own likely finish, a plain-English sentence with
  the range, and a **Curve** toggle that carries the recorded line forward as a dashed
  projection inside a cone. See *How the projection works* below
- **Report Card** — an A+…F grade versus your own back catalogue, graded on **totals over a
  comparable stretch of each video's life**: the video's own view count once its launch is
  over, and the projected first-48-hour total while one is still running. Says how big the
  comparison pool is, and grades on engagement alone until four other posts can be scored
  that way. See *Why not views per day* below
- **Account breakdown** — lifetime totals and per-post averages
- **Coaching** — best day and best **hour** to post (all 24 hours scored separately, in
  your own local time, each row carrying how many posts it rests on; answered here only —
  the Audience room reports when views *arrive*, which is a different question),
  posting rhythm, strongest tags, and a
  **next-milestone projection** ("at +12 subs/day you'll hit 7,500 around 30 October")
- **Idea Studio** — titles/captions, on-screen text, tags and next-video ideas,
  grounded in your own naming style (free) plus optional AI variations
- **Same-age race** — this upload right now against what your earlier ones had when they
  were exactly this old, plus a **launch-curves overlay** putting every recent opening on
  one chart aligned by age
- **Love per view** — every post on one plot, reach across the bottom and reaction up the
  side, with a **Ranked** alternative that reads as a list
- **Per-post drawer** — the full breakdown for any post in the table, not just the recent
  ones the arrows reach
- **While you were away** — the whole absence in one line ("While you were away (2d):
  +1,920 views · +24 subscribers · 2 round numbers crossed"), sized by a per-device stamp of
  when you last had the page open. Round numbers your account and posts crossed (each post
  tappable, wearing its thumbnail, opening its full breakdown), a ⚡ on anything gaining
  faster than it was yesterday, the biggest recorded hour, and yesterday ranked among the
  days behind it. New-since-you-looked items wear a dot; already-seen ones dim. On YouTube
  the headline is **exact** — the robot records the channel's own totals, so it is a
  subtraction, not a sum of samples — and this card replaced the old Recent milestones list
- **Export / import** and **cross-device sync** through your own Worker's storage
- **Rooms** — six on YouTube (Now · Videos · Trends · Audience · Coach · Ideas), five on
  TikTok (Now · Posts · Account · Coach · Ideas). The two TikTok is missing are missing for
  a reason rather than for want of building them: its API exposes no audience data of any
  kind, so an Audience room could only ever be empty, and it publishes no daily series of
  its own, so a Trends room would hold nothing the Now room does not already show.
  **Everything TikTok's API can support is now built on both pages** — what separates them
  is only what TikTok does not publish to any third-party app at all. Both
  pages carry the same **One page** switch that turns the rooms off and stacks every card
  exactly as it was before, so nothing is ever out of reach
- An **answer card** at the top: four chips that say in a sentence how today went — against
  yesterday and against where it places across the week — how the newest upload landed,
  who's watching and when you're next due. Computed from numbers
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
predicted from the others, and the worst miss — padded by a ×1.6 safety factor, because
leave-one-out flatters itself — becomes the band. So an account whose posts
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

**Two horizons, not one.** The card answers 48 hours *and* seven days, and the second one
is a second answer rather than the first one moved. The 48-hour horizon is the only one
this model's error has ever been measured against, and every reference curve on the account
covers exactly that — so retargeting it at a week would have disqualified all of them on
the day of the deploy and left both dashboards saying "0 of 2" for most of a week, in
exchange for a figure the recorded tail says is about 2% different. Instead a reference
that recorded a *full week* gets its seven-day total as its denominator, and the identical
arithmetic runs again on the longer target.

The week figure is held to a stricter admission rule than the launch: three references
rather than two, so the leave-one-out margin can always be measured. With two, the band
would fall back to the floor constants — which were measured at 48 hours — and printing
those under a seven-day claim would look exactly like a measurement and be nothing of the
kind. Until three posts have a full week recorded, the card says how many more it needs.

The card also **stops retiring at 48 hours**. It used to print one grey sentence with no
chart and no tabs the moment the launch window closed, which read as the data having
stopped; now it settles — keeping the recorded curve, on a seven-day axis, with the
week-one projection carried forward — and only retires at day seven, when the lifetime
count is the honest number. Every chart on the curve view answers a pointer with the
reading at that moment.

Measured by running the shipped model over the launches actually recorded, one held out at
a time: the worst miss shrinks from roughly 20% at five hours to 3% by eighteen — the floor
constants shipped in the page (19% at six hours, 11% at twelve, 3% at eighteen) *are* that
measurement — and every held-out curve lands inside its own band from five hours on. Past
about a day the residual misses are YouTube revising a count downward after the fact, which
nothing predicts. `node scripts/plateau.test.mjs` lifts the model straight out of the page —
so the test cannot drift from what ships — and pins the properties (coverage from five hours
on, error shrinking with age) on synthetic curves; the one-off measurement above is not
something the test re-runs.

**Why not views per day**

Because it is a clock wearing a metric's clothes. Views arrive on an S-curve, heavily
front-loaded, so dividing a total by age in days does not remove age from the number — it
inverts it. Measured on this account's own recorded curves, the *same video* reads:

| | at 6h | at 48h | at 60 days |
|---|---|---|---|
| a 914-view launch | 2,407/day | 457/day | 19/day |
| a 2,027-view launch | 4,719/day | 1,014/day | 42/day |

A **127× swing on unchanged performance**. The YouTube page floored age at one day, which
clamped what actually reached the screen to around **40×**; the TikTok page floored it at
one hour and had no engagement component to dilute it, so its grade was worse.

Every ranking on both dashboards now compares **totals over a comparable stretch of each
video's life** instead. Past its launch window that is simply the video's own view count,
which works because the launch *is* almost all of it — on the recorded curves the tail
after hour 48 adds well under half a percent a day. While a launch is still running the
count is not comparable yet, so the projected 48-hour total stands in; and where even that
cannot be made, the answer is **null**, and the video abstains from the ranking rather than
being scored zero for being new.

One residual bias, stated rather than hidden: an older video carries more of that slow
tail, so it scores a little high — roughly a quarter over two months. That runs *opposite*
to the bias it replaces and is two orders of magnitude smaller, and the cold tail will make
it measurable within a few weeks.

That one metric feeds all of it: both Report Cards, best day and best time to post, Top 5,
your hits vs the rest, the "typical upload" bar, the tag and hashtag rankings — and so the
Idea Studio prompt, which was previously handing the AI a recency-sorted tag list.
Percentiles count ties as half, so an account whose posts all sit at the same rate reads as
typical rather than as the bottom of its own catalogue.

**Views/day still exists** on the table column, its sort, and the per-post metric cell. It
is a pace — the right answer to "what is moving right now" and the wrong answer to "which
of these was better" — and nothing labels it as anything else any more.

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
  normal). Only covers the window both sides recorded, and the page tells you the actual
  overlap.
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
   deploys the code with the KV + D1 bindings and the one-minute cron from
   [`worker/wrangler.toml`](worker/wrangler.toml), uploads the secrets, and
   *attempts* to apply [`worker/schema.sql`](worker/schema.sql) to D1 — a step
   that fails unless the API token carries **Account → D1 → Edit** (the live
   schema was applied out-of-band; see the note in the workflow).
4. Open the dashboard once with `?worker=https://…workers.dev` appended.

> Adding a repo secret does **not** re-run the workflow — trigger it manually,
> or the Worker won't have the new value.

**Worker routes**

| Route | Purpose |
|---|---|
| `/` | the recorded YouTube minute bundle |
| `/run` | run both trackers now (handy for testing). Rate limited to once a minute — it is unauthenticated and each call runs the trackers (API calls, D1 writes, and sometimes a KV write), so a crawler hitting it in a loop would spend real allowances for nothing. A 429 is not a fault: the cron runs every minute anyway |
| `/d1diff` | compares the D1 and KV copies field by field (expect disagreement now: KV is deliberately coarser since the write gate — this was the phase-2 verification tool) |
| `/models` | which Gemini models your key can actually call |
| `/ai`, `/sync` | AI ideas and cross-device sync, locked to your channels |
| `/pairs` | confirmed YouTube↔TikTok video pairings (owner-locked) |
| `/tiktok/login`, `/tiktok/callback` | TikTok sign-in |
| `/launches`, `/tiktok/launches` | the first **week** of finished launches (48 hours is what makes one *finished*), age-indexed — the projection's reference curves |
| `/life?id=`, `/tiktok/life?id=` | **one video's whole recorded life**, publication to day 60, one point an hour — see below |
| `/tiktok/disconnect` | sign a TikTok account out and stop the cron polling it |
| `/tiktok/me`, `/tiktok/videos`, `/tiktok/history`, `/tiktok/sync`, `/tiktok/ai` | TikTok data |

**The long tail, and how to see it**

The tracker records every video for 60 days — minute by minute for the first 48 hours,
every fifteen minutes to day 14, hourly to day 60. For a long time nothing *served* more
than the last three days of that: both bundles cut on an absolute `KEEP_DAYS` window, the
YouTube page discarded any video over a week old, and no caller ever passed `?days=`. Days
3–60 were written, held for two months, pruned, and never read. On TikTok that was the
entire record, because TikTok publishes no history of its own.

`/life` and `/tiktok/life` are what spend it. One video, publication to now, bucketed to an
hour — finer than anything else that exists for that stretch, since YouTube's own analytics
stop at a day. It appears as **"Every hour since it went up"** in the YouTube drawer and on
the TikTok post card and per-post drawer, topped by a results strip (first hour / first day
/ first week / time to 1,000, each mark abstaining when the recording never reached or
never saw it). About 5,100 rows per open against a 5,000,000/day read allowance, so it is
fetched when a card opens and **cached** — the TikTok page's poll repaints redraw from
memory rather than re-asking D1.

Every point on it is measured. Nothing is interpolated between samples and nothing is
extended past the last one — a gap in the recording is drawn as a gap in the line. And a
missing recording says so on the page — a post that predates the account being connected
has no history to draw, which is different from the feature not working.

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

**And it no longer stops there.** Recording used to end at hour 48 while retention ran to
60 days, so "kept for two months" was true of the storage and false of the recording — the
dashboard knew everything about a video's first two days and nothing about its next two
months. A tapering cadence now carries it the whole way:

| age | cadence | why |
|---|---|---|
| 0–48h | every minute | a launch moves by the minute |
| 2–14 days | every 15 min | it still moves, but not that fast |
| 14–60 days | hourly | a month out, minute sampling would record that nothing happened |

Measured against this account's real publish rate — 2.2 uploads a day on YouTube, ~2.5
posts a day on TikTok — that is about **19,200 samples a day**. D1 bills a row-write for
the table row *and* one for every index on it, and `samples` keeps one, so that is
**~38,000 of the 100,000/day allowance**. Flat minute sampling across the full 60 days
would be **over 400,000 samples a day** — more than 800,000 row-writes, eight times the
entire allowance — which is why the cadence tapers rather than staying flat. TikTok costs
nothing extra at all: the cron already fetched the post list on every pass and was
discarding every row outside the launch window.

One caveat on that figure: the live database still carries a second, redundant index on
`samples`, which makes the real bill ~58,000 until it goes. `schema.sql` drops it, but the
deploy's schema step has never succeeded — the API token has never carried **Account → D1 →
Edit** — so the drop is queued rather than applied. Both numbers fit the allowance.

Two things make that affordable. Reads are **incremental**: a poll sends `?since=` and gets
back only the minutes it hasn't seen, because re-shipping a 48-hour window every three
minutes would exhaust D1's 5,000,000 daily row-reads before the day was out. And the KV
mirror is written at most every 15 minutes rather than every minute — a roster change or a
failed D1 write still persists immediately, but ordinary sample growth waits.

**Two different slices, two different routes.** That incremental bundle cuts on an
*absolute* timestamp — the last three days — because its job is "what has happened lately".
The plateau projection needs the opposite slice: the **first week** of launches that
already finished, which for anything published more than three days ago sits entirely
outside that window even though D1 still holds every minute of it. That mismatch is why the
projection first shipped saying it had no reference curves while the data sat in the
database. `/launches` and `/tiktok/launches` serve that slice, age-indexed and downsampled
to one point per five minutes, capped at the twelve newest finished launches.

Eligibility and span are two separate constants there, and keeping them separate is what
made the seven-day horizon possible without breaking the two-day one. `PJ_WINDOW` (48h)
decides when a launch has *finished* and may be a reference; `PJ_SPAN` (7d) decides how
much of its recording travels with it. Widening the span costs about 480 extra points per
curve — ~165 KB instead of ~90 KB, and 40,332 rows read per rebuild instead of 34,572.
Raising the eligibility bar instead would have cost every reference on the account.

They are cached on **what the answer depends on, not on a clock**. A finished launch never
changes again — that is the point of only serving finished ones — so the only thing that
can move is *which* launches have finished, which happens once or twice a day when a video
crosses 48 hours old. So every request runs a cheap roster query (**22 rows**, measured)
and the curves are rebuilt only when the roster differs (the ~40,000-row rebuild above,
once or twice a day), plus one forced rebuild every 24 hours for anything the roster cannot
see. That comes to under **100,000 rows a day** — less than a six-hour timer would have
cost, while a finished launch now appears the moment it is asked for instead of up to six
hours later. An hourly timer, for comparison, would have burned nearly a million rows a day
on YouTube alone to notice a once-a-day change.

The ages are emitted per point rather than as a dense array, deliberately: a hole in the
recording has to survive the downsampling, because the model throws away reference curves
with a hole where the prediction gets made.

D1 is written every tick; the KV mirror follows on the 15-minute gate above. D1 answers
reads; if it fails *or comes back empty while KV has data*, KV answers instead and the page
never notices — the JSON has the same shape either way, though the mirror is deliberately
coarser (that is what `/d1diff` shows). The `X-CC-Source` response header names whichever
one answered.

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
- **Search keywords** — edit [`data/keywords.json`](data/keywords.json). Each search page
  costs 100 quota units and a keyword can page up to 8 deep, so the weekly run works from a
  shared page budget and rotates keywords when it can't cover them all (see `rank.mjs`).

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
yt-dashboard/   index.html · tiktok.html · compare.html · style.css · privacy.html · terms.html · publish.sh
worker/         worker.js · wrangler.toml · schema.sql · *.test.mjs
scripts/        snapshot.mjs · rank.mjs · test-all.mjs · *.test.mjs
data/           history.json · alerts.json · ranks.json · keywords.json
docs/           tiktok-setup.md · youtube-ideas.md
brand/          icon.svg + PNG renders · PHILOSOPHY.md
```

Run the tests with `node scripts/test-all.mjs` — they lift code straight out of the pages
and the Worker, so they cannot drift from what ships.
