/**
 * Channel Command — per-minute offline tracker (Cloudflare Worker)
 *
 * Why this exists: YouTube's API has no minute-level history, and the dashboard
 * can only record the minute race while someone has it open. This Worker runs on
 * Cloudflare's cron every minute, so a new upload's first hours are captured
 * minute-by-minute even when nobody is watching. When the dashboard next opens it
 * fetches this Worker and merges the samples into its own race history.
 *
 * Tracking security: the cron uses ONLY the same public YouTube API key the
 * GitHub robot uses — no OAuth, no login token, no account access. Public view
 * counts and nothing else.
 *
 * Optional AI proxy (/ai): if GEMINI_KEY is set, the Worker also answers the
 * dashboard's Idea Studio so the Gemini key lives here as a hidden secret and is
 * never exposed in the public page. It is LOCKED to the channel owners: every
 * /ai request must carry a valid YouTube login token whose channel is in
 * CHANNEL_ID, so only you and your partner can ever spend the Gemini quota. The
 * login token is used once to verify the channel, then discarded — never stored
 * or logged.
 *
 * Cost: $0. It stays inside the Cloudflare Workers free tier by writing at most
 * once per minute and ONLY while a video is inside its "hot" launch window
 * (HOT_HOURS, default 6h) — so a launch costs ~360 KV writes total, well under
 * the 1,000/day free limit. Outside a launch it just does a light scan every few
 * minutes to notice a new upload.
 *
 * Setup lives in ../README.md ("Per-minute offline tracker").
 */

const D1_KEEP_DAYS = 60;    // how long D1 holds launch samples (KV still prunes at KEEP_DAYS)
// Bump to re-run the backfill on every tracked state. Version 1 wrote every published_at
// through `| 0`, which truncates epoch ms to 32 bits and dated them all to 1969; version 2
// repairs them. Version 3 moved TikTok rows under a per-account partition, so any snapshot
// that had already backfilled under the shared 'tt' key gets rewritten under its own.
// Samples are INSERT OR IGNORE, so a re-run only ever fixes metadata.
const D1_BACKFILL_V = 3;
// Record a video minute-by-minute for this long after publish. Was 6 hours while the
// samples lived in a KV blob rewritten once a minute; D1 stores one row per sample
// instead, so the cost of a wider window is rows (of 100,000 a day) rather than KV
// writes (of 1,000 a day). At 3 posts/day/platform this window keeps ~12 videos hot at
// once = ~17,280 samples/day, and each insert costs 2 row-writes (the table plus the
// covering index), so ~35% of the daily budget. Sampling stays flat at one a minute for
// the whole window: a tiered cadence would save rows, but it also makes the gap between
// consecutive samples vary, which silently breaks any chart that plots by array position.
const HOT_HOURS   = 48;
const SCAN_MIN    = 5;      // re-scan the uploads playlist this often to notice new uploads
const KEEP_DAYS   = 3;      // drop samples older than this from the served bundle
// How long the KV mirror may lag. D1 is the record; KV is the read-fallback, and it only
// has to be good enough to keep the page drawing while D1 is unavailable. Writing it
// every minute would cost ~1,800 writes/day against a 1,000/day free tier — which is what
// the setup was already doing, and quietly failing at. See the write gate in tick().
const KV_WRITE_MIN = 15;
const KV_KEY      = 'minute-v1';
const YT          = 'https://www.googleapis.com/youtube/v3/';
// Seed list of text chat models, tried in order. Each has its OWN free-tier daily quota and
// the loop below skips any that fail (wrong id / no quota / incompatible), so the effective
// free budget is the SUM across the models that work, at $0. The "-latest" entries are stable
// aliases Google keeps pointing at a current flash model.
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.0-flash'];
// Models that can't do plain text generateContent (speech / image / audio / specialised) —
// excluded from auto-discovery so a text request never hits a 400 modality error.
const NON_TEXT_MODEL = /tts|image|audio|lyria|nano-banana|robotics|computer-use|deep-research|antigravity|embedding|gemma|vision|omni/i;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  // X-CC-Source names the store that answered a read (see "phase 3" below). A custom
  // response header is invisible to cross-origin fetch() unless it is exposed, and the
  // dashboards are served from github.io while this runs on workers.dev — without this
  // line the header would only ever be visible in devtools, never to the page.
  'Access-Control-Expose-Headers': 'X-CC-Source',
  'Cache-Control': 'no-store',
};
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

async function api(ep, params, key) {
  const u = new URL(YT + ep);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', key);
  const r = await fetch(u);
  if (!r.ok) throw new Error(ep + ' HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function loadState(env) {
  let s = null;
  try { s = await env.MINUTE.get(KV_KEY, 'json'); } catch (e) {}
  if (!s || typeof s !== 'object') s = {};
  s.videos = s.videos || {};   // { vid: { pub, title, chan, s: [[ts,views,likes,comments],...] } }
  s.lastScan = s.lastScan || 0;
  return s;
}

/* ===========================================================================
   The D1 store — the KV→D1 migration.

   Both stores are written on every tick, and as of phase 3 D1 is the one that
   answers reads, with KV as an automatic fallback (see "phase 3" further down).
   Dual-writing continues deliberately: it is what makes the fallback real rather
   than decorative, and what keeps a rollback to KV a one-line change.

   Every entry point here is wrapped and returns instead of throwing. A missing
   binding, a schema problem or a D1 outage must not break the KV path or the cron
   — KV is the safety net, so a fault on this side has to leave it untouched.
   =========================================================================== */

// One row per (platform, video, minute). INSERT OR IGNORE against the composite
// primary key makes a re-run or a double-fired cron a no-op rather than an error.
// NEVER use `| 0` here. Bitwise operators truncate to 32 bits, and an epoch-ms
// timestamp (~1.79e12) wraps to a negative number — which is how the first version of
// this shipped every published_at as a date in 1969. View counts would wrap too, past
// 2.1 billion. Math.round(Number(x)) keeps full precision.
const int = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

// D1 partitions by `platform`. YouTube tracks one fixed set of channels, so 'yt' is the
// whole story. TikTok does not: KV keys each snapshot by the signed-in account's open_id
// ('tt:snap:<openId>'), and D1 has to draw the same line or two connected accounts would
// pool their videos into a single launch curve — the user's posts and their partner's,
// averaged into one meaningless line, with no way to tell them apart after the fact.
//
// The open_id rides inside the partition value rather than in a new column, because the
// primary key is already (platform, video_id, ts): prefixing partitions correctly with no
// schema change at all. Adding a column would mean widening the primary key, and SQLite
// cannot do that in place — it needs a full table rebuild, which is a bad trade for a
// distinction the existing key already expresses.
const ttKey = openId => 'tt:' + openId;
const isTt = platform => platform === 'tt' || platform.startsWith('tt:');

async function d1Write(env, platform, rows, metas) {
  if (!env.DB) return { skipped: 'no binding' };
  if (!rows.length && !metas.length) return { skipped: 'nothing to write' };
  try {
    const sampleStmt = env.DB.prepare(
      'INSERT OR IGNORE INTO samples (platform, video_id, ts, views, likes, comments, shares) VALUES (?,?,?,?,?,?,?)');
    const videoStmt = env.DB.prepare(
      'INSERT INTO videos (platform, video_id, published_at, title, channel, cover, first_seen) VALUES (?,?,?,?,?,?,?) ' +
      'ON CONFLICT(platform, video_id) DO UPDATE SET title=excluded.title, published_at=excluded.published_at, ' +
      'channel=excluded.channel, cover=excluded.cover');
    const stmts = [];
    for (const m of metas) stmts.push(videoStmt.bind(platform, m.id, int(m.pub), m.title || '', m.chan || '', m.cover || '', Date.now()));
    for (const r of rows) stmts.push(sampleStmt.bind(platform, r.id, int(r.ts), int(r.views), int(r.likes), int(r.comments), int(r.shares)));
    // chunked so one enormous backfill can't exceed the per-batch statement limit
    for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
    return { rows: rows.length, metas: metas.length };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Copy whatever KV already holds into D1, once, so the migration doesn't start from
// an empty table and lose the launch curves recorded in the last few days. Idempotent
// via INSERT OR IGNORE; the caller records that it ran so it isn't repeated.
async function d1Backfill(env, platform, videos, shape) {
  const rows = [], metas = [];
  for (const [id, rec] of Object.entries(videos || {})) {
    const meta = shape(id, rec);
    if (meta) metas.push(meta);
    for (const s of (rec.s || [])) {
      rows.push(isTt(platform)
        ? { id, ts: s[0], views: s[1], likes: s[2], comments: s[3], shares: s[4] }
        : { id, ts: s[0], views: s[1], likes: s[2], comments: s[3], shares: 0 });
    }
  }
  return d1Write(env, platform, rows, metas);
}

/* --- phase 2: the read path, rebuilt from D1 ------------------------------
   These reproduce the exact bundle shape the dashboards already consume, so that
   switching over in phase 3 is a change of source and nothing else. Served only
   when ?src=d1 is passed, so the default path stays on KV until the two have been
   proved identical. The marker goes in a response header, never in the payload,
   so the bodies stay byte-comparable.

   The videos table keeps 60 days but KV only ever served KEEP_DAYS, so the window
   is matched here for parity; phase 4 widens it deliberately rather than by
   accident. A video with no samples in the window is dropped, mirroring KV's prune.
--------------------------------------------------------------------------- */
// YouTube publishes at second resolution ("2026-08-04T11:53:04Z") but toISOString()
// always pads the milliseconds ("…04.000Z"). Both parse to the same instant, so nothing
// would have broken — but the phase-2 diff is only worth running if it can be made to
// say "identical", so the padding is stripped when it carries no information. A genuine
// sub-second timestamp keeps its milliseconds.
const isoOf = ms => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

// `since` makes the read incremental. Without it every poll ships the whole retention
// window — with a 48-hour launch window that is ~26,000 rows, and at one poll every three
// minutes across a couple of open dashboards it runs through D1's 5,000,000 rows-read/day
// well before the day is out. The dashboards merge rather than replace, so they only ever
// need what they haven't already got; a video with nothing new simply doesn't appear.
// Metadata always travels with the samples, so a partial response is still self-describing.
async function d1YtBundle(env, days, since) {
  const cutoff = Math.max(Date.now() - (days || KEEP_DAYS) * 864e5, +since || 0);
  const [vres, sres] = await Promise.all([
    env.DB.prepare('SELECT video_id, published_at, title, channel FROM videos WHERE platform = ?').bind('yt').all(),
    env.DB.prepare('SELECT video_id, ts, views, likes, comments FROM samples WHERE platform = ? AND ts >= ? ORDER BY video_id, ts').bind('yt', cutoff).all()
  ]);
  const byId = {};
  for (const r of (sres.results || [])) (byId[r.video_id] = byId[r.video_id] || []).push([r.ts, r.views, r.likes, r.comments]);
  const videos = {};
  for (const v of (vres.results || [])) {
    const s = byId[v.video_id];
    if (!s || !s.length) continue;
    videos[v.video_id] = { pub: isoOf(v.published_at), title: v.title || '', chan: v.channel || '', s };
  }
  return { videos };
}

// Scoped to one account: the caller has already resolved the session, and the bundle it
// returns stands in for that account's KV snapshot, which is account-scoped too.
async function d1TtBundle(env, openId, days, since) {
  const cutoff = Math.max(Date.now() - (days || KEEP_DAYS) * 864e5, +since || 0);
  const part = ttKey(openId);
  const [vres, sres] = await Promise.all([
    env.DB.prepare('SELECT video_id, published_at, title, cover FROM videos WHERE platform = ?').bind(part).all(),
    env.DB.prepare('SELECT video_id, ts, views, likes, comments, shares FROM samples WHERE platform = ? AND ts >= ? ORDER BY video_id, ts').bind(part, cutoff).all()
  ]);
  const byId = {};
  for (const r of (sres.results || [])) (byId[r.video_id] = byId[r.video_id] || []).push([r.ts, r.views, r.likes, r.comments, r.shares]);
  const videos = {};
  for (const v of (vres.results || [])) {
    const s = byId[v.video_id];
    if (!s || !s.length) continue;
    videos[v.video_id] = { create_time: Math.round(v.published_at / 1000), title: v.title || '', cover: v.cover || '', s };
  }
  return { videos };
}

/* --- completed launch curves -----------------------------------------------
   The two bundles above cut samples on an ABSOLUTE timestamp (KEEP_DAYS), because their
   job is "what has happened lately". The plateau projection needs the opposite slice:
   the FIRST 48 HOURS of launches that have already finished. For anything published more
   than KEEP_DAYS ago that sits entirely outside the bundle's window even though D1 still
   holds it for D1_KEEP_DAYS — so the projection could only ever see launches from the
   last three days, and on a channel that posts every few days it saw none and said so.
   That is the bug this route exists to fix; the data was always there, it had no door.

   Three things make it cheap. It is age-indexed, which is the only form the model uses.
   It is downsampled to one point per PJ_STEP minutes: the model interpolates, and 577
   points across 48 hours instead of 2,880 is the difference between a ~90 KB answer and
   a ~450 KB one. And a finished launch never changes again, so the answer is cached and
   the only thing that can invalidate it is another launch finishing — a once-a-day event.

   The ages are emitted per point rather than as a dense array on purpose. A hole in the
   recording has to SURVIVE the downsampling, because the projection discards reference
   curves with a hole where the prediction gets made — the 21-hour gaps left by the hot
   window widening from 6 hours to 48. A dense array would paper over exactly the defect
   the model needs to see.
--------------------------------------------------------------------------- */
const PJ_WINDOW = 48 * 3600e3;   // the launch window the projection models
const PJ_STEP   = 5;             // minutes between emitted points
const PJ_MAX    = 12;            // how many finished launches to ship
const PJ_TTL    = 6 * 3600e3;    // how long a cached answer stands
// Bumped whenever the emitted shape changes. Without it a fix to the query keeps serving
// six hours of the old answer from cache after the deploy — which is exactly what the
// floating-point bucket bug would have done, silently, on the way out.
const PJ_CACHE  = 2;

async function d1Launches(env, platform) {
  const now = Date.now();
  // finished launches only: old enough to have a complete window, recent enough that D1
  // still holds the samples
  const vres = await env.DB.prepare(
    'SELECT video_id, published_at, title, cover FROM videos WHERE platform = ? AND published_at >= ? AND published_at <= ?' +
    ' ORDER BY published_at DESC LIMIT ' + PJ_MAX
  ).bind(platform, now - D1_KEEP_DAYS * 864e5, now - PJ_WINDOW).all();
  const vids = vres.results || [];
  if (!vids.length) return { curves: {} };

  const bucket = PJ_STEP * 60000;
  const marks = vids.map(() => '?').join(',');
  // MAX(views) per bucket keeps the downsampled curve as monotone as the raw one.
  // The seek is (platform, video_id), which is the samples primary key's prefix, so this
  // reads only these twelve videos' rows — about 34,000 — and not the whole partition.
  // CAST(... AS INTEGER) is load-bearing, not decoration. SQLite does integer division
  // between two INTEGERs, but a bound JavaScript number arrives as a REAL, so the divide
  // silently became floating point and every sample landed in a bucket of its own: the
  // first deploy served 3,232 points per video at ages like 2.5025166666666667 instead of
  // 577 points on whole five-minute marks. Nothing failed — the model interpolates, so it
  // simply shipped five times the payload it was designed to. The mock in
  // worker/d1-launches.test.mjs could not catch it, because a mock only ever reproduces
  // the SQL semantics its author believed in; the live peek is what caught it.
  const bucketOf = '(CAST((s.ts - v.published_at) / ? AS INTEGER))';
  const sres = await env.DB.prepare(
    'SELECT s.video_id AS id, ' + bucketOf + ' AS b, MAX(s.views) AS views' +
    ' FROM samples s JOIN videos v ON v.platform = s.platform AND v.video_id = s.video_id' +
    ' WHERE s.platform = ? AND s.video_id IN (' + marks + ')' +
    ' AND s.ts >= v.published_at AND s.ts <= v.published_at + ?' +
    ' GROUP BY s.video_id, ' + bucketOf +
    ' ORDER BY s.video_id, b'
  ).bind(bucket, platform, ...vids.map(v => v.video_id), PJ_WINDOW, bucket).all();

  const byId = {};
  for (const r of (sres.results || [])) (byId[r.id] = byId[r.id] || []).push([r.b * PJ_STEP, r.views]);
  const curves = {};
  for (const v of vids) {
    const s = byId[v.video_id];
    if (!s || s.length < 8) continue;   // too thin to be a reference under any rule
    curves[v.video_id] = isTt(platform)
      ? { create_time: Math.round(v.published_at / 1000), title: v.title || '', cover: v.cover || '', s }
      : { pub: isoOf(v.published_at), title: v.title || '', s };
  }
  return { curves };
}

// The cache is also the abuse guard: however often this is asked for, D1 sees it at most
// once per PJ_TTL. Four KV writes a day for YouTube and four per connected TikTok account,
// against a 1,000/day cap currently running at about 220.
async function launchBody(env, platform) {
  const key = 'launch:' + PJ_CACHE + ':' + platform;
  const now = Date.now();
  let hit = null;
  try { hit = await env.MINUTE.get(key, 'json'); } catch (e) {}
  if (hit && hit.curves && now - (hit.at || 0) < PJ_TTL) return hit;
  const body = { v: 1, at: now, step: PJ_STEP, window: PJ_WINDOW, ...(await d1Launches(env, platform)) };
  try { await env.MINUTE.put(key, JSON.stringify(body)); } catch (e) {}
  return body;
}

/* --- phase 3: which store answers a read ----------------------------------
   D1 is now the default; KV is the automatic fallback. Both are still written every
   tick, so falling back costs nothing but a shorter history.

   Falling back means more than catching a throw. A D1 fault that comes back as an
   empty result set is indistinguishable, at the type level, from "nothing has been
   recorded yet" — and serving that would blank every launch curve on the page without
   raising anything, which is precisely the silent failure this migration exists to end.
   So an empty answer falls back too, but only when KV actually holds something;
   otherwise a genuinely quiet account would be pinned to KV forever and never see its
   own first D1 sample.

   ?src=d1 and ?src=kv still force one store, so either side stays inspectable — and a
   forced read reports its failure rather than quietly answering from the other one,
   which would make the diagnostic lie. X-CC-Source always names whoever answered.
--------------------------------------------------------------------------- */
const hasVideos = o => !!(o && o.videos && Object.keys(o.videos).length);
const hasVideosJson = t => { try { return hasVideos(JSON.parse(t)); } catch (e) { return false; } };
const withSrc = (body, src) => new Response(body, { headers: { 'Content-Type': 'application/json', 'X-CC-Source': src, ...CORS } });

// Compare the two sources field by field, so phase 3 flips on evidence rather than hope.
// Only reports on what the dashboards actually read: the video set, its publish time and
// title, and every sample's timestamp and counts.
function d1Diff(kvVideos, d1Videos) {
  const kvIds = Object.keys(kvVideos || {}).sort(), d1Ids = Object.keys(d1Videos || {}).sort();
  const onlyKv = kvIds.filter(i => !d1Ids.includes(i));
  const onlyD1 = d1Ids.filter(i => !kvIds.includes(i));
  const differing = [];
  for (const id of kvIds.filter(i => d1Ids.includes(i))) {
    const a = kvVideos[id], b = d1Videos[id], why = [];
    if (String(a.pub) !== String(b.pub)) why.push('pub ' + a.pub + ' vs ' + b.pub);
    if ((a.title || '') !== (b.title || '')) why.push('title');
    const as = a.s || [], bs = b.s || [];
    if (as.length !== bs.length) why.push('sample count ' + as.length + ' vs ' + bs.length);
    else for (let i = 0; i < as.length; i++) {
      if (as[i][0] !== bs[i][0] || as[i][1] !== bs[i][1]) { why.push('sample ' + i + ' differs'); break; }
    }
    if (why.length) differing.push({ id, why });
  }
  return {
    match: !onlyKv.length && !onlyD1.length && !differing.length,
    counts: { kv: kvIds.length, d1: d1Ids.length },
    onlyInKv: onlyKv, onlyInD1: onlyD1, differing
  };
}

// Drop samples past the retention window. Deletes count toward D1's daily row-write
// budget, so this runs once a day rather than every tick.
async function d1Prune(env, now) {
  if (!env.DB) return { skipped: 'no binding' };
  const d = new Date(now);
  if (d.getUTCHours() !== 3 || d.getUTCMinutes() !== 7) return { skipped: 'not the daily slot' };
  try {
    const cutoff = now - D1_KEEP_DAYS * 864e5;
    // Delete one platform at a time so the (platform, ts, …) covering index can seek.
    // A bare `WHERE ts < ?` has no platform to seek on and needs a dedicated index on ts
    // — which would cost a third row-write on every sample insert, all day, every day,
    // purely to serve one DELETE a night. Trading that for a handful of extra statements
    // once every 24 hours is the right way round.
    const parts = await env.DB.prepare('SELECT DISTINCT platform FROM videos').all();
    let pruned = 0;
    for (const p of (parts.results || [])) {
      const r = await env.DB.prepare('DELETE FROM samples WHERE platform = ? AND ts < ?').bind(p.platform, cutoff).run();
      pruned += (r && r.meta && r.meta.changes) || 0;
    }
    // Videos age out too, or the table grows forever and every bundle read pays for it
    // (the videos SELECT has no time bound — it can't, the bundle needs each curve's
    // metadata). The extra hotMs of margin matters: a video keeps producing samples until
    // HOT_HOURS after it was published, so pruning strictly at `published_at < cutoff`
    // would delete the row while its last samples were still inside the retention window,
    // orphaning them — present in the table but invisible in the bundle, which walks
    // videos. Outliving the last possible sample is what keeps that from happening.
    const vcut = cutoff - HOT_HOURS * 3600e3;
    const vr = await env.DB.prepare('DELETE FROM videos WHERE published_at < ?').bind(vcut).run();
    return { pruned, videos: (vr && vr.meta && vr.meta.changes) || 0, platforms: (parts.results || []).length };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Find fresh (< HOT_HOURS old) uploads across all tracked channels.
async function scanFresh(channels, key) {
  const hotMs = HOT_HOURS * 3600e3;
  const now = Date.now();
  const fresh = {}; // vid -> { pub, title, chan }
  const chans = [];
  for (const part of chunk(channels, 50)) {
    const d = await api('channels', { part: 'snippet,contentDetails', id: part.join(',') }, key);
    chans.push(...(d.items || []));
  }
  for (const c of chans) {
    const uploads = c.contentDetails.relatedPlaylists.uploads;
    // only the newest page — a hot upload is always among the most recent items
    const d = await api('playlistItems', { part: 'contentDetails,snippet', playlistId: uploads, maxResults: 25 }, key);
    for (const it of (d.items || [])) {
      const vid = it.contentDetails.videoId;
      const pub = it.contentDetails.videoPublishedAt;
      if (!pub) continue;
      if (now - new Date(pub).getTime() < hotMs) {
        fresh[vid] = { pub, title: (it.snippet && it.snippet.title) || '', chan: c.id };
      }
    }
  }
  return fresh;
}

// Everything about the tracked videos except their samples: which videos exist, when they
// went live, what they're called, and what D1 has already been told. Used to decide
// whether a KV write can be deferred — sample growth can wait, the roster cannot.
function rosterOf(videos) {
  return JSON.stringify(Object.keys(videos || {}).sort().map(id => {
    const r = videos[id] || {};
    return [id, r.pub, r.title, r.chan, r.create_time, r.cover, r.d1m];
  }));
}

// The metadata D1 should be holding for a video. Compared against rec.d1m so the
// videos-table upsert only fires when something actually changed: it used to run once per
// sample per video — ~17,280 identical rewrites a day — because the meta was pushed
// alongside every row.
const metaFp = (a, b) => String(a == null ? '' : a) + ' ' + String(b == null ? '' : b);

async function tick(env) {
  const key = env.YT_API_KEY;
  const channels = (env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!key || !channels.length) return { skipped: 'missing YT_API_KEY / CHANNEL_ID' };

  const now = Date.now();
  // The timestamp every sample is filed under. NOT Date.now(): Cloudflare delivers cron
  // events at least once, and the duplicate invocation of a given minute arrives a few
  // milliseconds after the first. The samples primary key is (platform, video_id, ts), so
  // a raw millisecond clock gives those two writes DIFFERENT keys and INSERT OR IGNORE has
  // nothing to ignore. Measured on the live database before this fix: about 60% of minutes
  // carried a second row 1-15ms after the first, with identical counts -- 605 phantom rows
  // on a two-day-old video. Flooring to the minute is what the key always assumed: same
  // minute, same key, the duplicate write dropped. Sampling is per-minute, so no
  // resolution is lost; only the sub-minute cron jitter, which was never information.
  const slot = Math.floor(now / 60000) * 60000;
  const hotMs = HOT_HOURS * 3600e3;
  const s = await loadState(env);
  // exact record of what's stored, so we can avoid writing when nothing actually changed
  const before = JSON.stringify(s.videos);
  // …and the same for everything EXCEPT the sample arrays. Sample growth can wait for the
  // KV_WRITE_MIN gate; a change to the roster itself never can. hotIds below is derived
  // from s.videos, so if a newly discovered video isn't persisted the next tick reloads a
  // state that has never heard of it and doesn't sample it — losing the opening minutes of
  // a launch from D1 as well, since d1rows only covers what's in hotIds.
  const rosterBefore = rosterOf(s.videos);

  // (1) Scan for new uploads on a fixed 5-minute boundary. Deriving the cadence from the
  // clock (rather than a stored lastScan) means quiet minutes need no KV write at all.
  if (new Date(now).getUTCMinutes() % SCAN_MIN === 0 || !Object.keys(s.videos).length) {
    try {
      const fresh = await scanFresh(channels, key);
      for (const [vid, info] of Object.entries(fresh)) {
        if (!s.videos[vid]) s.videos[vid] = { pub: info.pub, title: info.title, chan: info.chan, s: [] };
        else { s.videos[vid].title = info.title || s.videos[vid].title; s.videos[vid].pub = info.pub; }
      }
    } catch (e) { /* transient API hiccup — try again next scan */ }
  }

  // (2) which tracked videos are still inside their hot window?
  const hotIds = Object.keys(s.videos).filter(vid => now - new Date(s.videos[vid].pub).getTime() < hotMs);

  // (3) sample the hot videos' live stats (1 quota unit per 50)
  let sampled = 0;
  const d1rows = [], d1metas = [], metaPending = [];
  if (hotIds.length) {
    for (const part of chunk(hotIds, 50)) {
      try {
        const d = await api('videos', { part: 'statistics', id: part.join(',') }, key);
        for (const it of (d.items || [])) {
          const st = it.statistics;
          const rec = s.videos[it.id];
          if (!rec) continue;
          const row = [slot, +(st.viewCount || 0), +(st.likeCount || 0), +(st.commentCount || 0)];
          // KV has no primary key to lean on, so the same minute is skipped explicitly
          const prev = rec.s[rec.s.length - 1];
          if (!prev || prev[0] !== slot) rec.s.push(row);
          d1rows.push({ id: it.id, ts: slot, views: row[1], likes: row[2], comments: row[3], shares: 0 });
          // only re-state the metadata when it isn't already what D1 holds. The
          // fingerprint is NOT recorded here — only after the write below succeeds.
          // Recording it first would mean one failed write marks the metadata as stated
          // forever: samples retry naturally as new rows on later ticks, the videos row
          // never does, and the bundle walks videos — so the whole curve would sit in
          // the samples table while every dashboard shows nothing.
          const fp = metaFp(rec.pub, rec.title);
          if (rec.d1m !== fp) {
            d1metas.push({ id: it.id, pub: new Date(rec.pub).getTime(), title: rec.title || '', chan: rec.chan || '' });
            metaPending.push([rec, fp]);
          }
          sampled++;
        }
      } catch (e) { /* skip this sample; the curve tolerates a gap */ }
    }
  }

  // (4) prune: drop samples & videos older than KEEP_DAYS
  const cutoff = now - KEEP_DAYS * 864e5;
  for (const vid of Object.keys(s.videos)) {
    const rec = s.videos[vid];
    rec.s = (rec.s || []).filter(x => x[0] >= cutoff);
    // keep a video only while hot OR while it still carries recent samples to serve
    if (now - new Date(rec.pub).getTime() >= hotMs && !rec.s.length) delete s.videos[vid];
  }

  // (5) Has anything changed?
  const changed = JSON.stringify(s.videos) !== before;

  // (6) Record the samples in D1, which is now the source the dashboards read. Runs
  // before the KV write so a D1 fault can't leave KV updated but the mirror behind — and
  // it never throws, so it can't stop the KV write either.
  let d1 = { skipped: 'nothing new' };
  if (s.d1Backfilled !== D1_BACKFILL_V && env.DB) {
    d1 = await d1Backfill(env, 'yt', s.videos, (id, rec) => ({ id, pub: new Date(rec.pub).getTime(), title: rec.title || '', chan: rec.chan || '' }));
    if (!d1.error) {
      s.d1Backfilled = D1_BACKFILL_V;   // persisted with the KV write below
      // a successful backfill states every video's metadata, not just this tick's
      for (const rec of Object.values(s.videos)) rec.d1m = metaFp(rec.pub, rec.title);
    }
    d1.backfill = true;
  } else if (d1rows.length) {
    d1 = await d1Write(env, 'yt', d1rows, d1metas);
  }
  // the fingerprint only becomes true once the write lands; on failure it stays unset,
  // so the next tick states the metadata again instead of believing it already did
  if (!d1.error) for (const [rec, fp] of metaPending) rec.d1m = fp;
  const d1pruned = await d1Prune(env, now);

  // computed here, after the fingerprint commit, so a newly stated metadata row is
  // itself a roster change and persists to KV immediately rather than waiting out the gate
  const rosterChanged = rosterOf(s.videos) !== rosterBefore;

  // (7) Persist. D1 already has this minute; KV is the read-fallback, and writing it every
  // minute costs ~1,800 writes/day against a free tier of 1,000 — which is what this was
  // doing before the window widened, silently failing once the cap was hit. So sample
  // growth waits for the KV_WRITE_MIN gate and KV becomes a coarser copy of the same
  // curves. Three things are never deferred:
  //   rosterChanged — hotIds is derived from what's stored, so an unpersisted discovery is
  //                   a video nothing samples next minute (see rosterBefore above)
  //   d1.backfill   — d1Backfilled lives in this blob; unpersisted, the whole backfill
  //                   re-runs on the following tick, and every tick after that
  //   d1.error      — D1 didn't take this minute, so KV is the only place it can survive
  // NOTE the shape: `mustWrite || (changed && due)`, never `changed && (mustWrite || due)`.
  // s.d1Backfilled is not inside s.videos, so a backfill that changes nothing else leaves
  // `changed` false — and gating on it would drop the flag, re-running the entire backfill
  // on the next tick, and the one after that, forever.
  const due = now - (s.updated || 0) >= KV_WRITE_MIN * 60000;
  const mustWrite = rosterChanged || !!d1.backfill || (!!d1.error && changed);
  const wrote = mustWrite || (changed && due);
  if (wrote) {
    s.updated = now;
    await env.MINUTE.put(KV_KEY, JSON.stringify(s));
  }
  return { hot: hotIds.length, sampled, wrote, deferred: changed && !wrote, d1, d1pruned };
}

/* ---------- AI proxy (Idea Studio), locked to the channel owners ---------- */

// Verify the caller's YouTube login token belongs to one of the tracked channels.
// Returns the channel id on success, or null. The token is used once and discarded.
async function verifyOwner(token, channels) {
  if (!token) return null;
  try {
    const r = await fetch(YT + 'channels?part=id&mine=true', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const d = await r.json();
    const id = d.items && d.items[0] && d.items[0].id;
    return id && channels.includes(id) ? id : null;
  } catch (e) { return null; }
}

// Ask Google which models this key can actually call with generateContent.
async function listGenerateModels(key) {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key));
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace('models/', ''))
      .filter(Boolean);
  } catch (e) { return []; }
}

// Call Gemini, self-healing across models: try the cached/known-good model, then the
// seed list, then whatever the key actually offers (flash first). 404 = wrong id → skip;
// 429 = no free quota on that model → skip. Remembers the winner in KV so later calls are
// a single request.
async function callGemini(env, prompt) {
  const key = env.GEMINI_KEY;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, responseMimeType: 'application/json' } });
  let sawQuota = false, lastErr = 'no response', cached = null;
  try { cached = await env.MINUTE.get('ai-model'); } catch (e) {}

  const seen = new Set();
  const attempt = async (model) => {
    if (!model || seen.has(model)) return undefined;
    seen.add(model);
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    // Skip ANY model that doesn't return OK — wrong id (404), no free quota (429), or an
    // incompatible model that rejects a text request (400) — and try the next one.
    if (!r.ok) {
      if (r.status === 429) sawQuota = true;
      lastErr = model + ' → HTTP ' + r.status;
      return undefined;
    }
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] ? j.candidates[0].content.parts[0].text : '';
    const parsed = JSON.parse(txt);
    if (model !== cached) { try { await env.MINUTE.put('ai-model', model); } catch (e) {} } // remember the winner
    return parsed;
  };

  // 1) cached winner, then the seed list
  for (const m of [cached, ...GEMINI_MODELS]) { const out = await attempt(m); if (out !== undefined) return out; }
  // 2) discover what this key really offers — text models only, flash first (free-tier friendly)
  const discovered = (await listGenerateModels(key)).filter(m => !NON_TEXT_MODEL.test(m));
  const ordered = [...discovered.filter(m => /flash/i.test(m)), ...discovered.filter(m => !/flash/i.test(m))];
  for (const m of ordered) { const out = await attempt(m); if (out !== undefined) return out; }

  if (sawQuota) throw new Error("Gemini's free API quota is used up for now (HTTP 429) — it resets on Google's schedule (per-minute limits clear in ~a minute; the daily cap resets each day). Note: a Gemini app/chat subscription does NOT raise the API limit — the API free tier is separate.");
  throw new Error(lastErr + ' — no usable Gemini model found for this key.');
}

async function aiHandler(request, env) {
  const channels = (env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!env.GEMINI_KEY) return json({ error: 'AI is not configured on this Worker (no GEMINI_KEY secret).' }, 501);
  // login token: Authorization header preferred, body fallback
  let payload = {};
  try { payload = await request.json(); } catch (e) {}
  const auth = request.headers.get('Authorization') || '';
  const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '') || payload.token || '';
  const owner = await verifyOwner(token, channels);
  if (!owner) return json({ error: 'Not authorised — sign in with one of the tracked channels.' }, 401);
  const desc = String(payload.desc || '').slice(0, 2000);
  const style = String(payload.style || '').slice(0, 6000);
  if (!desc) return json({ error: 'No description provided.' }, 400);
  const prompt = 'You are a YouTube growth assistant. Using ONLY the channel\'s own style below, write ideas that sound like this creator for the new video described. Match their tone, separators and emoji habits.\n\n' +
    'CHANNEL STYLE:\n' + style + '\n\n' +
    'NEW VIDEO:\n"' + desc + '"\n\n' +
    'Give a large, varied set (the caller has plenty of token budget but few requests, so pack this response fully). Return JSON only, with keys: "titles" (20 title strings in their style), "onscreenText" (20 punchy on-screen text hooks, max 6 words each), "tags" (40 lowercase tag strings), "videoIdeas" (15 objects each {"title","why"} where why is one short reason it should work for this channel).';
  try { return json(await callGemini(env, prompt)); }
  catch (e) { return json({ error: String(e.message || e) }, 502); }
}

/* ---------- cross-device sync store (owner-locked), replaces Google Drive ---------- */
// Stores each channel's device-local bundle (keyword research, Studio CTR, minute-race
// history) in KV keyed by the channel id, and only serves it back to a signed-in owner of
// that channel. Uses the YouTube login only — no Drive scope — so restricted accounts work.
// Which YouTube video is the same post as which TikTok. Owner-locked exactly like
// /sync, and stored per channel so both devices see the same confirmed pairs.
// Written only when someone confirms or unlinks a pair, so it costs almost no KV budget.
async function pairsHandler(request, env) {
  const channels = (env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const auth = request.headers.get('Authorization') || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let body = null;
  if (request.method === 'POST') { try { body = await request.json(); } catch (e) {} if (!token && body) token = body.token || ''; }
  const owner = await verifyOwner(token, channels);
  if (!owner) return json({ error: 'Not authorised — sign in with one of the tracked channels.' }, 401);
  const key = 'pairs:' + owner;
  if (request.method === 'POST') {
    if (!body || !Array.isArray(body.pairs)) return json({ error: 'no pairs array' }, 400);
    try { await env.MINUTE.put(key, JSON.stringify(body.pairs.slice(0, 400))); }
    catch (e) { return json({ error: 'store failed' }, 502); }
    return json({ ok: true, n: Math.min(400, body.pairs.length) });
  }
  let stored = '[]';
  try { stored = (await env.MINUTE.get(key)) || '[]'; } catch (e) {}
  return new Response(stored, { headers: { 'Content-Type': 'application/json', ...CORS } });
}

async function syncHandler(request, env) {
  const channels = (env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const auth = request.headers.get('Authorization') || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let body = null;
  if (request.method === 'POST') { try { body = await request.json(); } catch (e) {} if (!token && body) token = body.token || ''; }
  const owner = await verifyOwner(token, channels);
  if (!owner) return json({ error: 'Not authorised — sign in with one of the tracked channels.' }, 401);
  const key = 'sync:' + owner;
  if (request.method === 'POST') {
    if (!body || body.bundle === undefined) return json({ error: 'no bundle' }, 400);
    try { await env.MINUTE.put(key, JSON.stringify(body.bundle)); } catch (e) { return json({ error: 'store failed' }, 502); }
    return json({ ok: true });
  }
  let stored = '{}';
  try { stored = (await env.MINUTE.get(key)) || '{}'; } catch (e) {}
  return new Response(stored, { headers: { 'Content-Type': 'application/json', ...CORS } });
}

/* ================= TikTok =================
 * OAuth (Login Kit) + Display API. The client secret lives here as a Worker secret and
 * never reaches the browser: the page only ever holds an opaque session id we mint.
 * TikTok access tokens last ~24h and refresh tokens ~1 year, so the cron below can keep
 * sampling a new post's views minute-by-minute with no browser open.
 */
const TT_AUTH  = 'https://www.tiktok.com/v2/auth/authorize/';
const TT_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const TT_API   = 'https://open.tiktokapis.com/v2/';
const TT_SCOPES = 'user.info.basic,user.info.profile,user.info.stats,video.list';
const TT_VIDEO_FIELDS = 'id,title,video_description,duration,cover_image_url,share_url,create_time,like_count,comment_count,share_count,view_count';
const TT_USER_FIELDS = 'open_id,avatar_url,display_name,username,profile_deep_link,follower_count,following_count,likes_count,video_count';

const rand = n => { const a = new Uint8Array(n || 24); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); };
const ttRedirect = url => new URL(url).origin + '/tiktok/callback';

// A readable page instead of a bare Cloudflare error, with the usual culprit spelled out.
const ttErrorPage = (msg, redirect) => new Response(
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>TikTok sign-in failed</title>' +
  '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#141019;color:#f0e8f4;margin:0;padding:40px 22px;line-height:1.6}' +
  'main{max-width:640px;margin:0 auto}h1{font-size:20px;margin:0 0 14px}code{background:#241d2e;padding:2px 6px;border-radius:5px;font-size:13px;word-break:break-all}' +
  '.box{background:#1d1724;border:1px solid #362c40;border-radius:10px;padding:14px 16px;margin:16px 0}a{color:#e77aa6}</style>' +
  '<main><h1>TikTok sign-in didn\'t complete</h1>' +
  '<div class="box"><b>What TikTok said:</b><br>' + escHtml(msg) + '</div>' +
  '<p><b>Most likely fix:</b> in the TikTok developer portal, the <b>Login Kit → Redirect URI (Web)</b> must be exactly:</p>' +
  '<p><code>' + escHtml(redirect) + '</code></p>' +
  '<p>It must be in the Login Kit box — not the Webhooks “Callback URL” field — with no trailing slash and no query parameters. ' +
  'Also confirm the signing-in account is listed under <b>Sandbox → Target users</b>.</p>' +
  '<p><a href="https://reubenrich16.github.io/Analytics/tiktok.html">← Back to the dashboard</a></p></main>',
  { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function ttTokenCall(env, params) {
  const body = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY || '', client_secret: env.TIKTOK_CLIENT_SECRET || '', ...params });
  const r = await fetch(TT_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const raw = await r.text();
  let j = {}; try { j = JSON.parse(raw); } catch (e) {}
  // TikTok can answer 200 with an error payload, and uses empty strings for "no error"
  const errCode = j.error && String(j.error).trim();
  if (!r.ok || errCode) throw new Error('TikTok rejected the sign-in: ' + (j.error_description || errCode || ('HTTP ' + r.status)));
  // Missing fields would otherwise blow up further down with an unhelpful 1101
  if (!j.access_token || !j.open_id) {
    throw new Error('TikTok returned an unexpected token response (no ' + (!j.access_token ? 'access_token' : 'open_id') + '). ' + raw.slice(0, 200));
  }
  return j;
}

// Persist tokens for an account and keep it in the polled-accounts list.
async function ttSaveTokens(env, t) {
  const now = Date.now();
  const rec = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: now + (t.expires_in || 86400) * 1000,
    refresh_expires_at: now + (t.refresh_expires_in || 31536000) * 1000
  };
  await env.MINUTE.put('tt:tok:' + t.open_id, JSON.stringify(rec));
  let list = [];
  try { list = JSON.parse(await env.MINUTE.get('tt:accounts') || '[]'); } catch (e) {}
  if (!list.includes(t.open_id)) { list.push(t.open_id); await env.MINUTE.put('tt:accounts', JSON.stringify(list)); }
  return rec;
}

// Returns a usable access token, refreshing it first if it's within 2 minutes of expiry.
async function ttAccessToken(env, openId) {
  let rec = null;
  try { rec = JSON.parse(await env.MINUTE.get('tt:tok:' + openId) || 'null'); } catch (e) {}
  if (!rec) return null;
  if (rec.expires_at - Date.now() > 120000) return rec.access_token;
  try {
    const t = await ttTokenCall(env, { grant_type: 'refresh_token', refresh_token: rec.refresh_token });
    const saved = await ttSaveTokens(env, { ...t, open_id: openId, refresh_token: t.refresh_token || rec.refresh_token });
    return saved.access_token;
  } catch (e) { return null; }
}

const ttGet = async (path, token) => {
  const r = await fetch(TT_API + path, { headers: { Authorization: 'Bearer ' + token } });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};
const ttPost = async (path, token, payload) => {
  const r = await fetch(TT_API + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}) });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};

// Returns { videos, error }, NOT a bare array.
//
// This used to `break` on any non-ok page and return whatever had been collected, which
// meant an expired token, a revoked video.list scope, a TikTok outage and an account that
// genuinely has no posts all came back as the same empty list. Nothing threw, so the
// caller's try/catch never fired and the tracker recorded "nothing to sample" in every
// one of those cases. That is how the TikTok side could sit at zero rows in D1 looking
// perfectly healthy from the outside.
//
// Partial pages are still returned — half a list beats none — with the fault alongside,
// so a caller can report which of the two it got.
// Remember how the last sign-in attempt ended, so "it won't let her in" becomes a fact
// instead of a screenshot. One key, overwritten each attempt, and sign-ins are rare, so
// the KV cost is nil. Deliberately records NOTHING identifying: no open_id, no code, no
// token — only when it happened, whether it worked, and TikTok's own error text.
//
// The absence of a record is itself the diagnosis. TikTok shows its own error page for
// problems it detects before redirecting (a non-target account, a sandbox misconfigured
// for the app), and in those cases the callback never runs. So a failed attempt that
// leaves no entry here means TikTok refused it upstream, which points at the developer
// portal rather than at anything this Worker does.
async function noteAuth(env, ok, error) {
  try {
    await env.MINUTE.put('tt:lastauth', JSON.stringify({
      at: Date.now(), ok: !!ok, error: String(error || '').slice(0, 200)
    }), { expirationTtl: 60 * 60 * 24 * 30 });
  } catch (e) { /* diagnostics must never break a sign-in */ }
}

async function ttFetchVideos(token, max) {
  const out = []; let cursor = null, error = null;
  while (out.length < (max || 60)) {
    const payload = { max_count: 20, ...(cursor ? { cursor } : {}) };
    const { ok, body } = await ttPost('video/list/?fields=' + encodeURIComponent(TT_VIDEO_FIELDS), token, payload);
    const d = body && body.data;
    if (!ok || !d || !Array.isArray(d.videos)) {
      // TikTok answers success as error.code === 'ok', so only another code is a fault
      const e = body && body.error;
      if (e && e.code && e.code !== 'ok') error = e.code + (e.message ? ': ' + e.message : '');
      else if (!ok) error = 'http error from TikTok';
      else error = 'unexpected response shape';
      break;
    }
    out.push(...d.videos);
    if (!d.has_more || !d.cursor) break;
    cursor = d.cursor;
  }
  return { videos: out, error };
}

// session id -> open_id (the browser never sees a TikTok token)
const ttSession = async (env, request) => {
  const auth = request.headers.get('Authorization') || '';
  const sid = auth.startsWith('Bearer ') ? auth.slice(7) : (new URL(request.url).searchParams.get('s') || '');
  if (!sid) return null;
  try { return await env.MINUTE.get('tt:sess:' + sid); } catch (e) { return null; }
};

async function ttHandler(request, env, url) {
  const p = url.pathname;
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    return json({ error: 'TikTok is not configured on this Worker (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET missing).' }, 501);
  }

  // 1) start auth — remembers where to send the browser back to
  if (p === '/tiktok/login') {
    const state = rand(16);
    const ret = url.searchParams.get('return') || '';
    await env.MINUTE.put('tt:state:' + state, ret, { expirationTtl: 900 });
    // Record that an attempt STARTED, separately from how it ended. Paired with
    // tt:lastauth this is what makes an upstream refusal visible: TikTok renders its own
    // error page for a rejection it makes before redirecting, so the callback never runs
    // and nothing else would show the attempt happened at all. A start with no matching
    // finish is therefore the signature of "TikTok said no on its own page" — as opposed
    // to no start at all, which just means nobody pressed the button.
    try {
      await env.MINUTE.put('tt:laststart', JSON.stringify({ at: Date.now(), reauth: !!url.searchParams.get('reauth') }),
        { expirationTtl: 60 * 60 * 24 * 30 });
    } catch (e) { /* diagnostics must never block a sign-in */ }
    const a = new URL(TT_AUTH);
    a.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
    a.searchParams.set('scope', TT_SCOPES);
    a.searchParams.set('response_type', 'code');
    a.searchParams.set('redirect_uri', ttRedirect(url));
    a.searchParams.set('state', state);
    // ?reauth=1 asks TikTok to show the consent screen instead of silently replaying the
    // grant it already holds. Without it, signing out of this dashboard and back in
    // reconnects the SAME account with the SAME permissions and no prompt — which makes
    // it impossible to switch accounts or to re-grant a permission that was declined,
    // and makes "sign out" look broken because you land straight back where you were.
    // disable_auto_auth is a Login Kit parameter; if TikTok ever ignores it the flow is
    // unchanged, so this is safe to send.
    if (url.searchParams.get('reauth')) a.searchParams.set('disable_auto_auth', '1');
    return Response.redirect(a.toString(), 302);
  }

  // 2) TikTok sends the user back here with a code
  if (p === '/tiktok/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state') || '';
    const err = url.searchParams.get('error');
    const ret = (await env.MINUTE.get('tt:state:' + state)) ;
    if (ret === null) return new Response('Sign-in expired or invalid. Please try again.', { status: 400, headers: CORS });
    await env.MINUTE.delete('tt:state:' + state);
    if (err || !code) {
      const detail = url.searchParams.get('error_description') || err || 'no code';
      await noteAuth(env, false, detail);
      // non_sandbox_target is the one people will actually hit, and TikTok's own wording
      // ("This may be due to specific app settings") gives no clue what to do. It means
      // the account signing in is not a registered Sandbox target user — nothing to do
      // with scopes, the token, or this Worker.
      const hint = /non_sandbox_target/i.test(detail)
        ? ' — this account is not a Sandbox target user. In the TikTok developer portal open your app,'
          + ' go to Sandbox → Target users → Add account, and sign in AS this account to accept the'
          + ' invitation. Being added is not enough on its own; the invitation has to be accepted from'
          + ' that account. Then try connecting again.'
        : '';
      return ttErrorPage('TikTok sign-in failed: ' + detail + hint, ttRedirect(url));
    }
    let t;
    try { t = await ttTokenCall(env, { grant_type: 'authorization_code', code, redirect_uri: ttRedirect(url) }); }
    catch (e) { await noteAuth(env, false, 'token exchange: ' + e.message); return ttErrorPage(e.message, ttRedirect(url)); }
    await ttSaveTokens(env, t);
    await noteAuth(env, true, '');
    const sid = rand(24);
    await env.MINUTE.put('tt:sess:' + sid, t.open_id, { expirationTtl: 60 * 60 * 24 * 300 });
    // NOTE: there used to be a `tt:meta:<openId>` profile cache written here and again on
    // every /tiktok/me. It was written in two places and read in none — the cron labels
    // videos from the live ttFetchVideos call, not from this key. Removed rather than
    // kept "in case": the /tiktok/me copy fired on every 60-second dashboard poll, about
    // 480 writes a day per open tab, which on its own would have consumed the 1,000/day
    // KV budget that the tracker's write gate exists to stay inside.
    const dest = /^https:\/\/[a-z0-9.-]*github\.io\//i.test(ret) ? ret : 'https://reubenrich16.github.io/Analytics/tiktok.html';
    return Response.redirect(dest + (dest.includes('#') ? '' : '#') + 'tt=' + sid, 302);
  }

  // everything below needs a session
  const openId = await ttSession(env, request);
  if (!openId) return json({ error: 'Not signed in to TikTok.' }, 401);

  // Genuinely disconnect the account, as opposed to the page forgetting its session id.
  // Clearing localStorage left the stored refresh token and the tt:accounts entry in
  // place, so the cron kept polling an account the user believed they had removed, and a
  // fresh sign-in silently reattached the same one. Placed before the token fetch so a
  // dead or unrefreshable token can still be disconnected.
  if (p === '/tiktok/disconnect') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const sid = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    let list = [];
    try { list = JSON.parse(await env.MINUTE.get('tt:accounts') || '[]'); } catch (e) {}
    const kept = list.filter(id => id !== openId);
    try {
      if (sid) await env.MINUTE.delete('tt:sess:' + sid);
      await env.MINUTE.delete('tt:tok:' + openId);
      if (kept.length !== list.length) await env.MINUTE.put('tt:accounts', JSON.stringify(kept));
    } catch (e) { return json({ error: 'Could not fully disconnect: ' + String((e && e.message) || e) }, 502); }
    // the recorded snapshot is deliberately kept — it is measurement history, not
    // credentials, and reconnecting the same account should resume rather than restart
    return json({ ok: true, remaining: kept.length });
  }

  const token = await ttAccessToken(env, openId);
  if (!token) return json({ error: 'TikTok session expired — please sign in again.', reauth: true }, 401);

  if (p === '/tiktok/me') {
    const { ok, body } = await ttGet('user/info/?fields=' + encodeURIComponent(TT_USER_FIELDS), token);
    if (!ok || !body.data) return json({ error: (body.error && body.error.message) || 'user info failed' }, 502);
    // deliberately no KV write here — see the note in the callback above
    return json(body.data.user);
  }
  if (p === '/tiktok/videos') {
    // surface the fault rather than presenting an empty list as an empty account
    try {
      const { videos, error } = await ttFetchVideos(token, 60);
      if (error && !videos.length) return json({ error: 'TikTok refused the video list — ' + error }, 502);
      return json({ videos, ...(error ? { partial: error } : {}) });
    }
    catch (e) { return json({ error: String(e.message || e) }, 502); }
  }
  if (p === '/tiktok/history') {
    let snap = {}, followers = [];
    try { snap = JSON.parse(await env.MINUTE.get('tt:snap:' + openId) || '{}'); } catch (e) {}
    try { followers = JSON.parse(await env.MINUTE.get('tt:followers:' + openId) || '[]'); } catch (e) {}
    // phase 3: D1 answers by default, KV falls back. followers stays on KV either way —
    // it's eight writes a day, so there is nothing to gain by migrating it.
    const src = url.searchParams.get('src');
    if (src !== 'kv' && env.DB) {
      try {
        const since = +url.searchParams.get('since') || 0;
        const b = await d1TtBundle(env, openId, +url.searchParams.get('days') || 0, since);
        // see the note on the YouTube route: an empty incremental read is a normal answer
        if (since || hasVideos(b) || src === 'd1' || !hasVideos(snap))
          return json({ ...snap, videos: b.videos, followers }, 200, { 'X-CC-Source': 'd1' });
      } catch (e) {
        if (src === 'd1') return json({ error: 'D1 read failed: ' + String((e && e.message) || e) }, 502);
      }
    }
    return json({ ...snap, followers }, 200, { 'X-CC-Source': 'kv' });
  }
  // same slice as /launches, scoped to this account's partition
  if (p === '/tiktok/launches') {
    if (!env.DB) return json({ curves: {} });
    const part = ttKey(openId);
    try { return json(await launchBody(env, part)); }
    catch (e) { return json({ error: 'D1 read failed: ' + String((e && e.message) || e) }, 502); }
  }
  if (p === '/tiktok/sync') {
    const key = 'tt:sync:' + openId;
    if (request.method === 'POST') {
      let b = null; try { b = await request.json(); } catch (e) {}
      if (!b || b.bundle === undefined) return json({ error: 'no bundle' }, 400);
      await env.MINUTE.put(key, JSON.stringify(b.bundle));
      return json({ ok: true });
    }
    let stored = '{}';
    try { stored = (await env.MINUTE.get(key)) || '{}'; } catch (e) {}
    return new Response(stored, { headers: { 'Content-Type': 'application/json', ...CORS } });
  }
  if (p === '/tiktok/ai') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (!env.GEMINI_KEY) return json({ error: 'AI is not configured on this Worker.' }, 501);
    let b = {}; try { b = await request.json(); } catch (e) {}
    const desc = String(b.desc || '').slice(0, 2000), style = String(b.style || '').slice(0, 6000);
    if (!desc) return json({ error: 'No description provided.' }, 400);
    const prompt = 'You are a TikTok growth assistant. Using ONLY the account\'s own style below, write ideas that sound like this creator for the new video described. Match their caption tone, hashtag habits and emoji use.\n\n' +
      'ACCOUNT STYLE:\n' + style + '\n\nNEW VIDEO:\n"' + desc + '"\n\n' +
      'Give a large, varied set. Return JSON only, with keys: "titles" (20 caption strings in their style), "onscreenText" (20 punchy on-screen text hooks, max 6 words each), "tags" (40 lowercase hashtags without the # symbol), "videoIdeas" (15 objects each {"title","why"} where why is one short reason it should work for this account).';
    try { return json(await callGemini(env, prompt)); }
    catch (e) { return json({ error: String(e.message || e) }, 502); }
  }
  return json({ error: 'unknown tiktok endpoint' }, 404);
}

// Background sampling: records view/like counts for recent posts so a launch is captured
// minute-by-minute even with no browser open. Gated the same way as the YouTube tracker
// so KV writes stay well inside the free tier.
async function ttTick(env) {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) return { skipped: 'not configured' };
  let list = [];
  try { list = JSON.parse(await env.MINUTE.get('tt:accounts') || '[]'); } catch (e) {}
  if (!list.length) return { accounts: 0 };
  // `slot` rather than `now` for the same reason as the YouTube tick: an at-least-once
  // cron delivery must land on the same primary key, not a key a few milliseconds along.
  const now = Date.now(), slot = Math.floor(now / 60000) * 60000;
  const hotMs = HOT_HOURS * 3600e3, cutoff = now - KEEP_DAYS * 864e5;
  let sampled = 0, wrote = 0, d1 = { skipped: 'nothing new' };
  for (const openId of list) {
    const token = await ttAccessToken(env, openId);
    if (!token) continue;
    let snap = { videos: {} };
    try { snap = JSON.parse(await env.MINUTE.get('tt:snap:' + openId) || 'null') || snap; } catch (e) {}
    snap.videos = snap.videos || {};
    const before = JSON.stringify(snap.videos);
    const rosterBefore = rosterOf(snap.videos);
    const hot = Object.keys(snap.videos).filter(id => now - (snap.videos[id].create_time * 1000) < hotMs);
    // sample every minute while a post is hot; otherwise only look for new posts on the
    // 5-minute boundary (clock-derived, so quiet minutes need no KV write)
    if (!hot.length && new Date(now).getUTCMinutes() % SCAN_MIN !== 0) continue;
    // Follower history, for the milestone projection. TikTok exposes no history of its own,
    // so we sample every ~3h — 8 writes a day per account, negligible against the KV budget.
    try {
      let fh = [];
      try { fh = JSON.parse(await env.MINUTE.get('tt:followers:' + openId) || '[]'); } catch (e) {}
      const lastAt = fh.length ? fh[fh.length - 1][0] : 0;
      if (now - lastAt > 3 * 3600e3) {
        const { ok, body } = await ttGet('user/info/?fields=follower_count,likes_count,video_count', token);
        const u = ok && body && body.data && body.data.user;
        if (u) {
          fh.push([now, u.follower_count || 0, u.likes_count || 0, u.video_count || 0]);
          fh = fh.filter(x => now - x[0] < 400 * 864e5);        // keep ~13 months
          await env.MINUTE.put('tt:followers:' + openId, JSON.stringify(fh));
          // Remember what the PROFILE claims, because it settles the question the video
          // list on its own cannot: an empty list from an account whose profile reports
          // zero posts is an account with nothing to track, while an empty list from a
          // profile reporting dozens means TikTok is withholding them — a scope, sandbox
          // authorisation or visibility problem, and a completely different fix.
          // NOTE: deliberately NOT stashed on the snapshot. An earlier version set
          // snap.ttProfileVideos here, which could never persist: the snapshot is only
          // written when the health string, the roster or the samples change, and on a
          // quiet account none of them do — so the value was rewritten in memory and
          // discarded every five minutes, and the peek reported "not sampled yet" four
          // days running. The count is already the 4th column of the follower history
          // being written on the line above, so read it from there instead of keeping a
          // second copy that depends on an unrelated write actually happening.
        }
      }
    } catch (e) { /* never let the follower sample break the video sampling */ }

    let vids = [], fetchErr = null;
    try {
      const r = await ttFetchVideos(token, 20);
      vids = r.videos;
      if (r.error) fetchErr = r.error.slice(0, 160);
    } catch (e) { fetchErr = String((e && e.message) || e).slice(0, 160); }
    // A failed list call used to `continue` silently, which looks exactly like "this
    // account has no recent posts": both leave the snapshot empty and write nothing, so
    // from the outside a broken integration and a quiet week are the same picture — and
    // that is precisely the question that could not be answered when D1 turned out to
    // hold no TikTok rows at all. Record the outcome, and persist it when it CHANGES, so
    // the two can be told apart without costing a write every minute.
    const health = fetchErr ? 'error: ' + fetchErr : 'ok: listed ' + vids.length;
    const healthChanged = snap.ttHealth !== health;
    if (healthChanged) { snap.ttHealth = health; snap.ttHealthAt = now; }
    if (fetchErr) {
      if (healthChanged) {
        snap.updated = now;
        await env.MINUTE.put('tt:snap:' + openId, JSON.stringify(snap));
        wrote++;
      }
      continue;
    }
    const d1rows = [], d1metas = [], metaPending = [];
    for (const v of vids) {
      const ct = (v.create_time || 0) * 1000;
      if (!ct || now - ct > hotMs) continue;             // only the launch window
      const rec = snap.videos[v.id] || (snap.videos[v.id] = { create_time: v.create_time, title: v.title || v.video_description || '', cover: v.cover_image_url || '', s: [] });
      const prev = rec.s[rec.s.length - 1];
      if (!prev || prev[0] !== slot) rec.s.push([slot, v.view_count || 0, v.like_count || 0, v.comment_count || 0, v.share_count || 0]);
      d1rows.push({ id: v.id, ts: slot, views: v.view_count || 0, likes: v.like_count || 0, comments: v.comment_count || 0, shares: v.share_count || 0 });
      // only re-state the metadata when it isn't already what D1 holds (see metaFp).
      // Like the YouTube side, the fingerprint commits only after the write succeeds.
      const fp = metaFp(ct, rec.title);
      if (rec.d1m !== fp) { d1metas.push({ id: v.id, pub: ct, title: rec.title || '', cover: rec.cover || '' }); metaPending.push([rec, fp]); }
      sampled++;
    }
    for (const id of Object.keys(snap.videos)) {
      snap.videos[id].s = (snap.videos[id].s || []).filter(x => x[0] >= cutoff);
      if (now - snap.videos[id].create_time * 1000 >= hotMs && !snap.videos[id].s.length) delete snap.videos[id];
    }
    // record into D1 — same contract as the YouTube side: never throws, KV unaffected.
    // `acct` is per-account on purpose: a single `d1` shared across the loop let one
    // account's backfill flag decide whether the NEXT account's snapshot was written.
    let acct = { skipped: 'nothing new' };
    if (snap.d1Backfilled !== D1_BACKFILL_V && env.DB) {
      const r = await d1Backfill(env, ttKey(openId), snap.videos, (id, rec) => ({ id, pub: (rec.create_time || 0) * 1000, title: rec.title || '', cover: rec.cover || '' }));
      if (!r.error) {
        snap.d1Backfilled = D1_BACKFILL_V;
        for (const rec of Object.values(snap.videos)) rec.d1m = metaFp((rec.create_time || 0) * 1000, rec.title);
      }
      acct = r; acct.backfill = true;
    } else if (d1rows.length) {
      acct = await d1Write(env, ttKey(openId), d1rows, d1metas);
    }
    if (!acct.error) for (const [rec, fp] of metaPending) rec.d1m = fp;
    d1 = acct;

    // same gate as tick(): the roster and the backfill flag persist immediately, sample
    // growth waits for KV_WRITE_MIN. See the long note there for why the shape matters.
    const changed = JSON.stringify(snap.videos) !== before;
    const rosterChanged = rosterOf(snap.videos) !== rosterBefore;
    const due = now - (snap.updated || 0) >= KV_WRITE_MIN * 60000;
    if (healthChanged || rosterChanged || acct.backfill || (acct.error && changed) || (changed && due)) {
      snap.updated = now;
      await env.MINUTE.put('tt:snap:' + openId, JSON.stringify(snap));
      wrote++;
    }
  }
  return { accounts: list.length, sampled, wrote, d1 };
}

export default {
  async scheduled(event, env, ctx) {
    // both trackers share the one-minute cron; each gates its own sampling
    ctx.waitUntil(Promise.allSettled([tick(env), ttTick(env)]));
  },
  // Any unexpected throw would otherwise surface as Cloudflare's opaque "Error 1101".
  // Wrapping the router means the caller always gets something they can act on.
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (e) {
      const msg = 'Worker error: ' + (e && e.message ? e.message : String(e));
      if (new URL(request.url).pathname === '/tiktok/callback') return ttErrorPage(msg, ttRedirect(request.url));
      return json({ error: msg }, 500);
    }
  }
};

async function route(request, env) {
  {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    // TikTok: OAuth + Display API (secret stays server-side)
    if (url.pathname.startsWith('/tiktok/')) return ttHandler(request, env, url);
    // AI proxy for the Idea Studio (owner-locked)
    if (url.pathname === '/ai') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      return aiHandler(request, env);
    }
    // cross-device sync store (owner-locked): GET pulls the bundle, POST saves it
    if (url.pathname === '/sync') {
      if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'GET/POST only' }, 405);
      return syncHandler(request, env);
    }
    // confirmed YouTube↔TikTok video pairings (owner-locked, same auth as /sync)
    if (url.pathname === '/pairs') {
      if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'GET/POST only' }, 405);
      return pairsHandler(request, env);
    }
    // the projection's reference curves — see d1Launches. Public for the same reason the
    // bundle at / is: everything in it is already-public video ids, titles and view counts.
    if (url.pathname === '/launches') {
      if (!env.DB) return json({ error: 'no D1 binding' }, 501);
      try { return json(await launchBody(env, 'yt')); }
      catch (e) { return json({ error: 'D1 read failed: ' + String((e && e.message) || e) }, 502); }
    }
    // manual trigger for testing: /run does one tick immediately
    if (url.pathname === '/run') {
      const [yt, tt] = await Promise.all([tick(env), ttTick(env).catch(e => ({ error: String(e.message || e) }))]);
      return json({ youtube: yt, tiktok: tt });
    }
    // diagnostic: which Gemini models this key can call, plus the remembered winner
    if (url.pathname === '/models') {
      if (!env.GEMINI_KEY) return json({ error: 'no GEMINI_KEY set' }, 501);
      let picked = null; try { picked = await env.MINUTE.get('ai-model'); } catch (e) {}
      return json({ picked, generateContentModels: await listGenerateModels(env.GEMINI_KEY) });
    }
    // phase 2 verification: build both bundles and report whether they agree.
    // The bundle at / is already public, so a comparison of it discloses nothing new.
    if (url.pathname === '/d1diff') {
      if (!env.DB) return json({ error: 'no D1 binding' }, 501);
      try {
        let kv = {};
        try { kv = (await env.MINUTE.get(KV_KEY, 'json')) || {}; } catch (e) {}
        const d1 = await d1YtBundle(env);
        return json({ youtube: d1Diff(kv.videos || {}, d1.videos) });
      } catch (e) { return json({ error: String((e && e.message) || e) }, 500); }
    }

    // default: serve the recorded minute bundle for the dashboard to merge. Phase 3
    // rebuilds it from D1 unless that comes back empty or broken, in which case the KV
    // blob answers instead — same bytes either way, so nothing downstream can tell.
    const src = url.searchParams.get('src');
    let kvBody = null;                                     // read at most once, and only if needed
    const kvText = async () => {
      if (kvBody === null) { try { kvBody = (await env.MINUTE.get(KV_KEY)) || '{}'; } catch (e) { kvBody = '{}'; } }
      return kvBody;
    };
    if (src !== 'kv' && env.DB) {
      try {
        const since = +url.searchParams.get('since') || 0;
        const b = await d1YtBundle(env, +url.searchParams.get('days') || 0, since);
        // An incremental read legitimately comes back empty — it means "nothing new since
        // you last asked", which is the common case. Falling back to KV there would ship
        // the whole blob on every quiet poll and undo the point of asking incrementally.
        if (since || hasVideos(b) || src === 'd1' || !hasVideosJson(await kvText()))
          return withSrc(JSON.stringify(b), 'd1');
      } catch (e) {
        if (src === 'd1') return json({ error: 'D1 read failed: ' + String((e && e.message) || e) }, 502);
      }
    }
    return withSrc(await kvText(), 'kv');
  }
}
