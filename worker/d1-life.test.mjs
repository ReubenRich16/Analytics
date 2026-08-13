// One video's whole recorded life — the /life and /tiktok/life routes.
//
// What this is for. The tracker records every video for 60 days: minute by minute for the
// first 48 hours, every fifteen minutes to day 14, hourly to day 60. Nothing served more
// than the last three days of that. The bundles cut on an absolute KEEP_DAYS window, the
// YouTube page threw away anything over a week old, and no caller ever passed ?days= — so
// days 3-60 of every video were written, held for two months, pruned, and never read. On
// TikTok that was the whole record, since TikTok publishes no history of its own.
//
// The tests below are mostly about the two things that can quietly go wrong here: bucketing
// arithmetic (which has already shipped broken once — see the CAST section) and the account
// scoping on the TikTok side.
//
// Run: node worker/d1-life.test.mjs
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { HANDLER, d1Life, ttKey, LIFE_STEP, D1_KEEP_DAYS };';
const tmp = HERE + '.worker-life.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

const HOUR = 3600e3, DAY = 864e5;
const NOW = Date.parse('2026-08-12T12:00:00Z');
const PUB = NOW - 60 * DAY;

/* A sample set with the real tapering shape, so the row counts in the comments are the
   row counts the live table actually holds. */
function taperedSamples(platform, id, pub, untilMs) {
  const out = [];
  for (let t = 0; t <= untilMs; t += 60e3) {
    if (t > 48 * HOUR) break;
    out.push({ platform, video_id: id, ts: pub + t, views: 100 + t / 60e3, likes: 1, comments: 0, shares: 0 });
  }
  for (let t = 48 * HOUR; t <= Math.min(untilMs, 14 * DAY); t += 15 * 60e3)
    out.push({ platform, video_id: id, ts: pub + t, views: 3000 + Math.round(t / 60e3), likes: 2, comments: 1, shares: 0 });
  for (let t = 14 * DAY; t <= untilMs; t += HOUR)
    out.push({ platform, video_id: id, ts: pub + t, views: 20000 + Math.round(t / 60e3), likes: 3, comments: 2, shares: 1 });
  return out;
}

function mockD1(vids, rows) {
  let rowsRead = 0;
  const db = {
    lastSql: null, stats: () => ({ rowsRead }),
    _all(sql, args) {
      db.lastSql = sql;
      if (/FROM videos WHERE platform/.test(sql)) {
        const [platform, id] = args;
        const out = vids.filter(v => v.platform === platform && v.video_id === id);
        rowsRead += out.length;
        return { results: out.map(v => ({ ...v })) };
      }
      // the life query: bind order is (pub, step, platform, id, pub, pub, step)
      const [pub, step, platform, id] = args;
      const g = new Map();
      for (const r of rows) {
        if (r.platform !== platform || r.video_id !== id || r.ts < pub) continue;
        rowsRead++;
        // SQLite integer division, which is what the CAST in the query buys
        const b = Math.trunc((r.ts - pub) / step);
        const cur = g.get(b);
        if (!cur || r.views > cur.views) g.set(b, { b, views: r.views, likes: r.likes, comments: r.comments, shares: r.shares });
      }
      return { results: [...g.values()].sort((a, x) => a.b - x.b) };
    }
  };
  db.prepare = sql => ({ bind: (...args) => ({ all: async () => db._all(sql, args) }) });
  return db;
}

console.log('\none video\'s whole recorded life');

console.log('\n1. the full 60 days come back, at an hour\'s resolution');
{
  const vids = [{ platform: 'yt', video_id: 'v1', published_at: PUB, title: 'a real upload', cover: '' }];
  const rows = taperedSamples('yt', 'v1', PUB, 60 * DAY);
  const DB = mockD1(vids, rows);
  const out = await W.d1Life({ DB }, 'yt', 'v1');

  check('the video is found', out.found === true, JSON.stringify(out).slice(0, 100));
  check('and carries its metadata', out.title === 'a real upload' && !!out.pub);
  check('the step is an hour', out.step === W.LIFE_STEP && out.step === HOUR, out.step);
  check('it reaches day 60, not day 3', out.s[out.s.length - 1][0] >= 59 * DAY,
    (out.s[out.s.length - 1][0] / DAY).toFixed(1) + ' days');
  check('and starts at publication', out.s[0][0] === 0, out.s[0][0]);
  check('one point per hour of life, give or take the ends',
    Math.abs(out.s.length - 60 * 24) <= 2, out.s.length + ' points');

  /* The reason this is affordable: the taper already did the work. Raw would be ~5,100
     rows, of which 2,880 sit in the first 48 hours — more than half the payload spent on
     the 3% of the x axis the minute-race chart already covers in full. */
  check('the raw table really is that front-loaded',
    rows.filter(r => r.ts - PUB <= 48 * HOUR).length > rows.length / 2,
    rows.filter(r => r.ts - PUB <= 48 * HOUR).length + ' of ' + rows.length);
  check('reading it costs about 5,000 rows, not 5,000,000',
    DB.stats().rowsRead < 6000, DB.stats().rowsRead + ' rows');
  check('which is a fraction of a percent of the daily read allowance',
    DB.stats().rowsRead / 5e6 < 0.002, (DB.stats().rowsRead / 5e6 * 100).toFixed(3) + '%');
}

console.log('\n2. every metric is carried, not just views');
{
  const vids = [{ platform: 'tt:acct-a', video_id: 'p1', published_at: PUB, title: 'hers', cover: 'https://c/a.jpg' }];
  const out = await W.d1Life({ DB: mockD1(vids, taperedSamples('tt:acct-a', 'p1', PUB, 60 * DAY)) }, 'tt:acct-a', 'p1');
  const last = out.s[out.s.length - 1];
  check('a point is [age, views, likes, comments, shares]', last.length === 5, JSON.stringify(last));
  check('shares survive the round trip', last[4] === 1, last[4]);
  check('comments too', last[3] === 2, last[3]);
  check('the TikTok shape uses create_time in seconds',
    out.create_time === Math.round(PUB / 1000) && out.pub === undefined);
  check('and carries the cover', out.cover === 'https://c/a.jpg');
}

console.log('\n3. the CAST, which has shipped broken before');
{
  /* d1Launches once served 3,232 points per video at ages like 2.5025166666666667: SQLite
     divides two INTEGERs as integers, but a bound JavaScript number arrives as a REAL, so
     without the cast every sample lands in its own bucket. Nothing failed — the payload was
     five times its intended size and the model interpolated over it. A mock cannot catch
     that, because a mock reproduces the semantics its author believed in, so this asserts
     on the SQL text itself. */
  const vids = [{ platform: 'yt', video_id: 'v1', published_at: PUB, title: '', cover: '' }];
  const DB = mockD1(vids, taperedSamples('yt', 'v1', PUB, 3 * DAY));
  await W.d1Life({ DB }, 'yt', 'v1');
  check('the bucket expression casts to INTEGER',
    /CAST\(\(ts - \?\) \/ \? AS INTEGER\)/.test(DB.lastSql), DB.lastSql);
  check('and the GROUP BY casts identically, or the grouping splits',
    (DB.lastSql.match(/CAST\(\(ts - \?\) \/ \? AS INTEGER\)/g) || []).length === 2,
    (DB.lastSql.match(/CAST/g) || []).length + ' casts');

  const out = await W.d1Life({ DB }, 'yt', 'v1');
  check('every age is a whole number of hours',
    out.s.every(p => p[0] % HOUR === 0), JSON.stringify(out.s.slice(0, 3)));
  check('and no two points share a bucket',
    new Set(out.s.map(p => p[0])).size === out.s.length, out.s.length);
}

console.log('\n4. views only ever go up');
{
  // MAX(views) per bucket, so the downsample is as monotone as the raw curve
  const vids = [{ platform: 'yt', video_id: 'v1', published_at: PUB, title: '', cover: '' }];
  const out = await W.d1Life({ DB: mockD1(vids, taperedSamples('yt', 'v1', PUB, 20 * DAY)) }, 'yt', 'v1');
  let ok = true;
  for (let i = 1; i < out.s.length; i++) if (out.s[i][1] < out.s[i - 1][1]) ok = false;
  check('the hourly curve never dips', ok);
  check('and ages are strictly increasing',
    out.s.every((p, i) => i === 0 || p[0] > out.s[i - 1][0]));
}

console.log('\n5. the answers that are not answers');
{
  const vids = [{ platform: 'yt', video_id: 'v1', published_at: PUB, title: '', cover: '' }];
  const rows = taperedSamples('yt', 'v1', PUB, 60 * DAY);
  check('an unknown id says so rather than returning an empty curve',
    (await W.d1Life({ DB: mockD1(vids, rows) }, 'yt', 'nope')).found === false);
  check('a known video with no samples yet returns an empty curve, still found',
    (await W.d1Life({ DB: mockD1(vids, []) }, 'yt', 'v1')).s.length === 0);
  // scoping: one account's partition must never answer for another's
  const two = [
    { platform: W.ttKey('openA'), video_id: 'p1', published_at: PUB, title: 'hers', cover: '' },
    { platform: W.ttKey('openB'), video_id: 'p1', published_at: PUB, title: 'his', cover: '' }
  ];
  const rowsA = taperedSamples(W.ttKey('openA'), 'p1', PUB, 5 * DAY);
  const rowsB = taperedSamples(W.ttKey('openB'), 'p1', PUB, 5 * DAY).map(r => ({ ...r, views: r.views * 99 }));
  const a = await W.d1Life({ DB: mockD1(two, [...rowsA, ...rowsB]) }, W.ttKey('openA'), 'p1');
  check('the same post id on two accounts does not bleed', a.title === 'hers', a.title);
  check('and neither do the other account\'s numbers',
    a.s[a.s.length - 1][1] < 1e6, a.s[a.s.length - 1][1]);
}

console.log('\n6. the routes');
{
  const vids = [{ platform: 'yt', video_id: 'v1', published_at: PUB, title: 't', cover: '' }];
  const DB = mockD1(vids, taperedSamples('yt', 'v1', PUB, 10 * DAY));
  const hit = (u, env) => W.HANDLER.fetch(new Request(u), env || { DB });

  const r = await hit('https://w.example/life?id=v1');
  check('/life answers 200', r.status === 200, r.status);
  const b = await r.json();
  check('with the curve', b.found && b.s.length > 200, b.s && b.s.length);
  check('and CORS, since the page is on another origin',
    r.headers.get('Access-Control-Allow-Origin') === '*', r.headers.get('Access-Control-Allow-Origin'));

  check('a missing id is a 400, not an empty answer',
    (await hit('https://w.example/life')).status === 400);
  check('an unknown id is a clean "not found" body',
    (await hit('https://w.example/life?id=zzz')).status === 200 &&
    !(await (await hit('https://w.example/life?id=zzz')).json()).found);
  check('no D1 binding is a 501, not a crash',
    (await hit('https://w.example/life?id=v1', {})).status === 501);

  // the D1 read throwing must surface as 502, not as Cloudflare's opaque 1101
  const boom = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: no such table'); } }) }) };
  const e = await hit('https://w.example/life?id=v1', { DB: boom });
  check('a D1 fault is a 502 with a readable reason', e.status === 502, e.status);
  check('and names the cause', /no such table/.test((await e.json()).error || ''));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
