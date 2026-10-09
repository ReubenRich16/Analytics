// Export the Worker's recordings as CSV — everything D1 holds for the last N days, plus the
// TikTok follower log from KV — so the full record can be analysed outside the dashboard.
//
//   node scripts/d1-export.mjs --out export [--days 60] [--chunk-days 3] [--platform all|tiktok|youtube]
//
// Run by .github/workflows/d1-export.yml, which uploads the folder as a workflow artifact.
// Needs CLOUDFLARE_API_TOKEN (with Account → D1 → Edit, the permission the deploy already
// uses) and CLOUDFLARE_ACCOUNT_ID in the environment; wrangler is run from worker/ so it
// picks up wrangler.toml the way every other workflow does.
//
// Why this exists: the dashboard's own "Export saved data" is the BROWSER's copy — the first
// 48 hours of each post's launch, plus whatever three-day windows that device happened to
// pull. Days 3 to 60 of every post are written to D1, kept for two months, and were never
// readable as a file. The questions that need them (how long a post keeps earning, whether
// it gets a second push, whether a new upload lifts the old ones) are answerable only from
// here.
//
// Every query is a read, seeks on the covering index (platform, ts, …), and reads only the
// rows it returns — a 60-day export of ~300,000 samples costs about that many of D1's
// 5,000,000 daily row reads. Chunked by time because one SELECT over the whole table is a
// single response wrangler has to hold in memory; a chunk that fails is retried in halves.
//
// Nothing here is interpolated. A post with a hole in its recording at an age reports no
// figure for that age rather than a guess, exactly as the dashboard's charts leave a gap.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

export const DB_NAME = 'channel-command';
export const KV_NAMESPACE = '24a3e8ab02904af499a07b6928687b48';   // the Worker's MINUTE namespace (wrangler.toml)
export const TZ = 'Australia/Melbourne';
const H = 3600e3, D = 864e5;
// the ages posts.csv reports views at: the launch marks the dashboard grades on, plus a week
export const AGES = [['1h', H], ['6h', 6 * H], ['24h', 24 * H], ['48h', 48 * H], ['7d', 7 * D]];

/* ---------- pure helpers (tested by scripts/d1-export.test.mjs) ---------- */

export const csvCell = v => {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const csvLine = cells => cells.map(csvCell).join(',') + '\n';

/* The platform column as D1 stores it is 'yt', or 'tt:<open_id>' — TikTok's pseudonymous
   account id, one partition per connected account. The id is not for publishing (this repo
   is public, and so are its workflow artifacts to anyone signed in to GitHub), so it is cut
   to the same four characters the peek workflow prints: enough to tell two accounts apart
   and match them to the peek, and nothing more. */
export function platformLabel(p) {
  if (p === 'yt') return 'youtube';
  if (typeof p === 'string' && p.startsWith('tt:')) return 'tiktok-' + p.slice(3, 7);
  return String(p || '');
}
export const platformWanted = (p, want) =>
  want === 'tiktok' ? String(p).startsWith('tt:') : want === 'youtube' ? p === 'yt' : true;

export const isoUtc = ts => new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
// 'YYYY-MM-DD HH:mm' on the Melbourne clock — the clock the dashboard's days are cut on
export function localStamp(ts, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
  const g = t => (parts.find(p => p.type === t) || {}).value || '';
  return g('year') + '-' + g('month') + '-' + g('day') + ' ' + g('hour') + ':' + g('minute');
}

export function chunks(from, to, step) {
  const out = [];
  for (let a = from; a < to; a += step) out.push([a, Math.min(to, a + step)]);
  return out;
}

/* The reading that stands for "views at age X": the last sample at or before that age,
   provided it is no more than `grace` before it. The hot window samples every minute, so ten
   minutes of grace covers a missed tick or two without letting a reading from hours earlier
   pass as the 48-hour figure; past two days the sampler steps down to every 15 minutes, so
   the week mark allows an hour. `samples` must be sorted by ts. */
export function viewsAt(samples, pubMs, ageMs, graceMs) {
  const t = pubMs + ageMs;
  let best = null;
  for (const s of samples) { if (s.ts <= t) best = s; else break; }
  return best && best.ts >= t - graceMs ? best.views : null;
}
export const graceFor = ageMs => ageMs > 48 * H ? 60 * 60e3 : 10 * 60e3;

export const POST_COLUMNS = ['platform', 'video_id', 'published_utc', 'published_local', 'age_hours', 'title', 'samples',
  'first_sample_utc', 'last_sample_utc', ...AGES.map(([k]) => 'views_' + k),
  'views_latest', 'likes_latest', 'comments_latest', 'shares_latest'];

export function postSummary(v, samples, now) {
  const first = samples[0], last = samples[samples.length - 1];
  const row = {
    platform: platformLabel(v.platform), video_id: v.video_id,
    published_utc: isoUtc(v.published_at), published_local: localStamp(v.published_at),
    age_hours: Math.round((now - v.published_at) / H * 10) / 10,
    title: v.title || '', samples: samples.length,
    first_sample_utc: first ? isoUtc(first.ts) : '', last_sample_utc: last ? isoUtc(last.ts) : ''
  };
  for (const [k, ms] of AGES) { const x = viewsAt(samples, v.published_at, ms, graceFor(ms)); row['views_' + k] = x == null ? '' : x; }
  row.views_latest = last ? last.views : '';
  row.likes_latest = last ? last.likes : '';
  row.comments_latest = last ? last.comments : '';
  row.shares_latest = last ? last.shares : '';
  return row;
}

// `wrangler --json` answers [{ results, success, meta }] (one entry per statement); anything
// printed ahead of the JSON — a version banner, an update nag — is skipped, not parsed
export function parseWranglerJson(stdout) {
  const i = String(stdout).search(/[[{]/);
  if (i < 0) throw new Error('no JSON in wrangler output: ' + String(stdout).slice(0, 200));
  const j = JSON.parse(String(stdout).slice(i));
  const arr = Array.isArray(j) ? j : [j];
  return arr.flatMap(r => (r && r.results) || []);
}

export function readmeText(days, now) {
  return [
    'Channel Command — recorded data export',
    'Taken ' + isoUtc(now) + ' (' + localStamp(now) + ' Melbourne), covering the last ' + days + ' days.',
    '',
    'FILES',
    '  samples.csv    every reading the Worker recorded: one row per (platform, post, minute).',
    '                 columns: platform, video_id, ts (epoch ms), time_utc, time_local (Melbourne),',
    '                 views, likes, comments, shares (shares is TikTok only; always 0 on YouTube).',
    '  videos.csv     the posts those readings belong to: platform, video_id, published_utc,',
    '                 published_local, title (TikTok: the caption), first_seen_utc.',
    '  posts.csv      one row per post with its views at fixed ages — the comparable figures:',
    '                 ' + POST_COLUMNS.join(', ') + '.',
    '                 views_48h is the number the dashboard grades every post on (the same stretch of',
    '                 every post\'s life). An age is blank when no reading sits close enough to it:',
    '                 within 10 minutes up to 48h, within an hour at 7d. Nothing is interpolated.',
    '  followers.csv  the TikTok follower log (checked every ~3 hours; up to 400 days):',
    '                 platform, ts, time_utc, time_local, followers, total_likes, posts.',
    '',
    'HOW THE SAMPLER RUNS',
    '  Every minute for a post\'s first 48 hours, every 15 minutes to day 14, hourly to day 60,',
    '  then the rows are pruned. A launch is recorded only from the moment the Worker was',
    '  watching: a post published before the account was connected has no early readings.',
    '  Gaps are gaps — a missed cron tick or an outage leaves no row rather than a repeated one.',
    '',
    'PLATFORM LABELS',
    '  youtube        the YouTube channel the Worker tracks.',
    '  tiktok-xxxx    one connected TikTok account; xxxx is the first four characters of its',
    '                 pseudonymous open_id, the same four the "Peek at the live data" workflow',
    '                 prints, so the two can be matched. The full id is never written here.',
    '',
    'TIMES',
    '  ts is milliseconds since 1970 UTC. *_utc columns are ISO 8601. *_local columns are the',
    '  Melbourne clock (' + TZ + '), which is what the dashboard cuts its days on.',
    ''
  ].join('\n');
}

/* ---------- the run ---------- */

const sqlStr = s => "'" + String(s).replace(/'/g, "''") + "'";
const WORKER_DIR = fileURLToPath(new URL('../worker/', import.meta.url));

function wrangler(args, label) {
  const r = spawnSync('npx', ['wrangler@latest', ...args], {
    cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' }
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(label + ' failed (exit ' + r.status + '): ' + ((r.stderr || '') + (r.stdout || '')).slice(-800));
  return r.stdout || '';
}
const d1 = sql => parseWranglerJson(wrangler(['d1', 'execute', DB_NAME, '--remote', '--json', '--command', sql], 'd1 execute'));
// a key that does not exist is an answer, not a failure — wrangler exits non-zero for it
function kvGet(key) {
  const r = spawnSync('npx', ['wrangler@latest', 'kv', 'key', 'get', key, '--namespace-id', KV_NAMESPACE, '--remote'],
    { cwd: WORKER_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
  return r.status === 0 ? (r.stdout || '') : '';
}

function fetchSamples(platform, from, to, depth) {
  const sql = 'SELECT video_id, ts, views, likes, comments, shares FROM samples' +
    ' WHERE platform = ' + sqlStr(platform) + ' AND ts >= ' + from + ' AND ts < ' + to + ' ORDER BY ts, video_id';
  try { return d1(sql); }
  catch (e) {
    if (to - from <= 6 * H || (depth || 0) >= 6) throw e;
    console.log('    chunk failed, retrying in two halves: ' + String(e.message || e).split('\n')[0].slice(0, 160));
    const mid = from + Math.floor((to - from) / 2);
    return fetchSamples(platform, from, mid, (depth || 0) + 1).concat(fetchSamples(platform, mid, to, (depth || 0) + 1));
  }
}

function args(argv) {
  const o = { out: 'export', days: 60, chunkDays: 3, platform: 'all' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--out') { o.out = v; i++; }
    else if (k === '--days') { o.days = Math.max(1, Math.min(400, +v || 60)); i++; }
    else if (k === '--chunk-days') { o.chunkDays = Math.max(0.25, Math.min(30, +v || 3)); i++; }
    else if (k === '--platform') { o.platform = ['all', 'tiktok', 'youtube'].includes(v) ? v : 'all'; i++; }
  }
  return o;
}

export function main(argv) {
  const o = args(argv);
  const now = Date.now(), from = now - o.days * D;
  const outDir = path.resolve(process.cwd(), o.out);
  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, text) => fs.writeFileSync(path.join(outDir, name), text);

  console.log('reading the post list…');
  const videos = d1('SELECT platform, video_id, published_at, title, cover, first_seen FROM videos ORDER BY platform, published_at')
    .filter(v => platformWanted(v.platform, o.platform));
  const platforms = [...new Set(videos.map(v => v.platform))];
  console.log('  ' + videos.length + ' posts across ' + platforms.length + ' platform partition' + (platforms.length === 1 ? '' : 's'));

  const byVideo = new Map();   // platform + '|' + video_id → sorted samples
  let samplesCsv = csvLine(['platform', 'video_id', 'ts', 'time_utc', 'time_local', 'views', 'likes', 'comments', 'shares']);
  const totals = {};
  for (const p of platforms) {
    const label = platformLabel(p);
    const windows = chunks(from, now, o.chunkDays * D);
    console.log('reading ' + label + ': ' + windows.length + ' window' + (windows.length === 1 ? '' : 's') + ' of ' + o.chunkDays + ' day' + (o.chunkDays === 1 ? '' : 's'));
    let n = 0, oldest = Infinity, newest = 0;
    for (const [a, b] of windows) {
      const rows = fetchSamples(p, a, b);
      for (const r of rows) {
        const key = p + '|' + r.video_id;
        if (!byVideo.has(key)) byVideo.set(key, []);
        byVideo.get(key).push(r);
        samplesCsv += csvLine([label, r.video_id, r.ts, isoUtc(r.ts), localStamp(r.ts), r.views, r.likes, r.comments, r.shares]);
        n++; if (r.ts < oldest) oldest = r.ts; if (r.ts > newest) newest = r.ts;
      }
      process.stdout.write('    ' + isoUtc(a).slice(0, 10) + ' → ' + isoUtc(b).slice(0, 10) + ': ' + rows.length + ' rows\n');
    }
    totals[label] = { samples: n, oldest: n ? isoUtc(oldest) : '—', newest: n ? isoUtc(newest) : '—' };
  }
  write('samples.csv', samplesCsv);

  let videosCsv = csvLine(['platform', 'video_id', 'published_utc', 'published_local', 'title', 'first_seen_utc']);
  let postsCsv = csvLine(POST_COLUMNS);
  let with48 = 0;
  for (const v of videos) {
    videosCsv += csvLine([platformLabel(v.platform), v.video_id, isoUtc(v.published_at), localStamp(v.published_at), v.title || '', v.first_seen ? isoUtc(v.first_seen) : '']);
    const s = (byVideo.get(v.platform + '|' + v.video_id) || []).sort((x, y) => x.ts - y.ts);
    const row = postSummary(v, s, now);
    if (row.views_48h !== '') with48++;
    postsCsv += csvLine(POST_COLUMNS.map(k => row[k]));
  }
  write('videos.csv', videosCsv);
  write('posts.csv', postsCsv);

  // the follower log lives in KV, one key per account, under the open_id the partition names
  let followersCsv = csvLine(['platform', 'ts', 'time_utc', 'time_local', 'followers', 'total_likes', 'posts']);
  let fRows = 0;
  for (const p of platforms.filter(x => String(x).startsWith('tt:'))) {
    let fh = [];
    try { fh = JSON.parse(kvGet('tt:followers:' + p.slice(3)) || '[]'); } catch (e) { fh = []; }
    for (const x of (Array.isArray(fh) ? fh : [])) {
      if (!Array.isArray(x) || !(x[0] > 0)) continue;
      followersCsv += csvLine([platformLabel(p), x[0], isoUtc(x[0]), localStamp(x[0]), x[1] || 0, x[2] || 0, x[3] || 0]);
      fRows++;
    }
  }
  write('followers.csv', followersCsv);
  write('README.txt', readmeText(o.days, now));

  console.log('');
  console.log('written to ' + outDir);
  for (const [label, t] of Object.entries(totals)) console.log('  ' + label + ': ' + t.samples + ' samples, ' + t.oldest + ' → ' + t.newest);
  console.log('  posts: ' + videos.length + ', with a first-48-hour figure: ' + with48);
  console.log('  follower readings: ' + fRows);
  return { videos: videos.length, with48, followers: fRows, totals };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error('export failed: ' + (e && e.stack || e)); process.exit(1); }
}
