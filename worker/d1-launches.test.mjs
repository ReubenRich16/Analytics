// Regression guard for /launches — the route that fixes the projection showing nothing.
//
// The bug it exists to prevent: the served bundle cuts samples on an ABSOLUTE timestamp
// (KEEP_DAYS = 3 days), so a launch that finished a week ago is invisible to the browser
// even though D1 still holds every minute of it for 60 days. The plateau projection needs
// exactly those finished launches as its references, so it had none and said so — while
// the data sat in the database the whole time.
//
// The last section is the one that matters most: it takes what this route ACTUALLY emits
// and feeds it through the real pjRef/pjProject lifted out of index.html. Downsampling a
// curve is only safe if the model still accepts it and still throws away the broken ones,
// and nothing short of running both halves together proves that.
//
// Run: node worker/d1-launches.test.mjs
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { d1Launches, d1Finished, launchBody, ttKey, PJ_STEP, PJ_MAX, PJ_WINDOW, PJ_SPAN, PJ_CACHE, PJ_STALE, PJ_MEMO, pjMemo };';
const tmp = HERE + '.worker-launches.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

// the projection model, lifted from the page exactly as scripts/plateau.test.mjs does it
const page = fs.readFileSync(HERE + '../yt-dashboard/index.html', 'utf8');
const cut = (a, b) => { const i = page.indexOf(a); return page.slice(i, page.indexOf(b, i)); };
const M = new Function('fmt', cut('const PJ_HORIZON', '  // Option C') +
  '\nreturn {pjAt,pjRef,pjProject};')(new Intl.NumberFormat('en-US'));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

const NOW = Date.now();
const HOUR = 3600e3;

/* A mock that actually interprets the two statements d1Launches issues, rather than
   pattern-matching them — a mock that returns whatever the test wants proves nothing
   about the SQL.

   It models CAST(x / n AS INTEGER), which truncates, and for the non-negative ages this
   query can produce that is Math.floor. The cast is not optional: a bound JavaScript
   number reaches SQLite as a REAL, so without it the divide is floating point and every
   sample lands in its own bucket. This mock cannot catch that on its own — it only ever
   reproduces whatever semantics its author believed in, and the first version of it
   happily agreed with a query that was doing no bucketing at all in production. Hence
   the separate assertion on the SQL text below: it pins the one property the behavioural
   tests are structurally unable to check. */
function mockD1(vids, rows) {
  let rowsRead = 0;
  const db = {
    lastSql: null,
    stats: () => ({ rowsRead }),
    _all(sql, args) {
      db.lastSql = sql;
      if (/FROM videos WHERE platform/.test(sql)) {
        const [platform, lo, hi] = args;
        const lim = +(sql.match(/LIMIT (\d+)/) || [])[1] || 1e9;
        const out = vids
          .filter(v => v.platform === platform && v.published_at >= lo && v.published_at <= hi)
          .sort((a, b) => b.published_at - a.published_at).slice(0, lim);
        rowsRead += out.length;
        return { results: out.map(v => ({ ...v })) };
      }
      const bucket = args[0], platform = args[1];
      const nIds = ((sql.match(/IN \(([?,]*)\)/) || ['', ''])[1].match(/\?/g) || []).length;
      const ids = new Set(args.slice(2, 2 + nIds));
      const win = args[2 + nIds];
      const pub = new Map(vids.filter(v => v.platform === platform).map(v => [v.video_id, v.published_at]));
      const g = new Map();
      for (const r of rows) {
        if (r.platform !== platform || !ids.has(r.video_id)) continue;
        const p = pub.get(r.video_id);
        if (p == null || r.ts < p || r.ts > p + win) continue;
        rowsRead++;
        const b = Math.floor((r.ts - p) / bucket), k = r.video_id + '|' + b;
        const cur = g.get(k);
        if (!cur || r.views > cur.views) g.set(k, { id: r.video_id, b, views: r.views });
      }
      return { results: [...g.values()].sort((a, b2) => a.id.localeCompare(b2.id) || a.b - b2.b) };
    }
  };
  db.prepare = sql => ({ sql, bind: (...args) => ({ sql, args, all: async () => db._all(sql, args) }) });
  return db;
}
function mockKV() {
  const m = new Map();
  let puts = 0;
  return { m, puts: () => puts,
    async get(k, t) { const v = m.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { puts++; m.set(k, v); } };
}

// an S-shaped launch sampled every minute; `from`/`to` in minutes let a test punch a hole
function launch(platform, id, pubMs, final, k, holes) {
  const rows = [], f = h => 1 / (1 + Math.exp(-(h - k) / 3)), a = f(0), z = f(48);
  for (let m = 0; m <= 48 * 60; m++) {
    if ((holes || []).some(([lo, hi]) => m > lo && m < hi)) continue;
    rows.push({ platform, video_id: id, ts: pubMs + m * 60000, views: Math.round(final * (f(m / 60) - a) / (z - a)) });
  }
  return rows;
}

console.log('\n/launches');

/* 1 — the regression itself */
console.log('\n1. it reaches past the bundle window');
{
  const vids = [
    // the shape of the real account: launches finished days ago, plus one still running
    { platform: 'yt', video_id: 'old6d', published_at: NOW - 155 * HOUR, title: 'six days ago', cover: '' },
    { platform: 'yt', video_id: 'old8d', published_at: NOW - 185 * HOUR, title: 'eight days ago', cover: '' },
    { platform: 'yt', video_id: 'live', published_at: NOW - 7 * HOUR, title: 'still running', cover: '' },
    { platform: 'yt', video_id: 'ancient', published_at: NOW - 70 * 864e5, title: 'past retention', cover: '' }
  ];
  const rows = [
    ...launch('yt', 'old6d', NOW - 155 * HOUR, 2027, 8),
    ...launch('yt', 'old8d', NOW - 185 * HOUR, 1400, 8.2),
    ...launch('yt', 'live', NOW - 7 * HOUR, 620, 8).filter(r => r.ts <= NOW),
    ...launch('yt', 'ancient', NOW - 70 * 864e5, 900, 8)
  ];
  const out = await W.d1Launches({ DB: mockD1(vids, rows) }, 'yt');
  const ids = Object.keys(out.curves).sort();
  check('a launch that finished six days ago is served', ids.includes('old6d'), ids.join(','));
  check('and one from eight days ago', ids.includes('old8d'), ids.join(','));
  check('a launch still inside its 48h window is NOT served', !ids.includes('live'), ids.join(','));
  check('nothing past D1 retention is served', !ids.includes('ancient'), ids.join(','));
  check('the shape is age-indexed pairs', Array.isArray(out.curves.old6d.s[0]) && out.curves.old6d.s[0].length === 2);
  check('it carries the publish time as an ISO instant', !isNaN(Date.parse(out.curves.old6d.pub)));
}

/* 2 — the downsampling */
console.log('\n2. downsampling keeps what the model needs');
{
  const pub = NOW - 100 * HOUR;
  const vids = [{ platform: 'yt', video_id: 'v', published_at: pub, title: 't', cover: '' }];
  const raw = launch('yt', 'v', pub, 2000, 8);
  const DB = mockD1(vids, raw);
  const out = await W.d1Launches({ DB }, 'yt');
  const s = out.curves.v.s;
  // See the note on the mock: this is the assertion the behavioural ones cannot make.
  // Without the cast the divide is floating point in real SQLite, every sample becomes
  // its own bucket, and the route ships five times the payload at fractional ages —
  // which is exactly what the first deploy did while these tests were green.
  const casts = (DB.lastSql.match(/CAST\(\(s\.ts - v\.published_at\) \/ \? AS INTEGER\)/g) || []).length;
  check('the bucket is an explicit integer cast, in both SELECT and GROUP BY', casts === 2, casts);
  check('one point per step, not one per minute',
    s.length === Math.floor(48 * 60 / W.PJ_STEP) + 1, s.length + ' points');
  check('every age is a whole number of steps', s.every(p => p[0] % W.PJ_STEP === 0));
  check('ages run from 0 to the full window',
    s[0][0] === 0 && s[s.length - 1][0] === 48 * 60, s[0][0] + '..' + s[s.length - 1][0]);
  check('the curve stays monotone', s.every((p, i) => i === 0 || p[1] >= s[i - 1][1]));
  const rawFinal = raw[raw.length - 1].views;
  check('the 48h total survives exactly', s[s.length - 1][1] === rawFinal, s[s.length - 1][1] + ' vs ' + rawFinal);
  // MAX per bucket, so the downsampled point is the highest count seen in those minutes
  const inBucket = raw.filter(r => r.ts - pub >= 10 * 60000 && r.ts - pub < 15 * 60000);
  const want = Math.max(...inBucket.map(r => r.views));
  check('each point is the highest count in its bucket', s.find(p => p[0] === 10)[1] === want);
}

/* 3 — the load-bearing property: holes must survive */
console.log('\n3. a hole in the recording survives the downsampling');
{
  const pub = NOW - 100 * HOUR;
  const vids = [{ platform: 'yt', video_id: 'holed', published_at: pub, title: 't', cover: '' }];
  // the real artefact: nothing recorded between 6h and 27h, left by the hot window
  // widening from 6 hours to 48
  const rows = launch('yt', 'holed', pub, 2000, 8, [[360, 1609]]);
  const out = await W.d1Launches({ DB: mockD1(vids, rows) }, 'yt');
  const s = out.curves.holed.s;
  let biggest = 0;
  for (let i = 1; i < s.length; i++) biggest = Math.max(biggest, s[i][0] - s[i - 1][0]);
  check('the gap is still visible in the emitted ages', biggest > 1200, biggest + ' minutes');
  check('and the model still rejects the curve', M.pjRef(s) === null);

  // while a two-hour hiccup in the flat tail must still come through as usable
  const hic = launch('yt', 'hiccup', pub, 2000, 8, [[2229, 2359]]);
  const out2 = await W.d1Launches({ DB: mockD1(
    [{ platform: 'yt', video_id: 'hiccup', published_at: pub, title: 't', cover: '' }], hic) }, 'yt');
  check('a 2h hole at 39h still yields a usable reference', !!M.pjRef(out2.curves.hiccup.s));
}

/* 4 — bounds */
console.log('\n4. bounds');
{
  const vids = [], rows = [];
  for (let i = 0; i < 20; i++) {
    const pub = NOW - (100 + i * 24) * HOUR;
    vids.push({ platform: 'yt', video_id: 'v' + i, published_at: pub, title: 'v' + i, cover: '' });
    rows.push(...launch('yt', 'v' + i, pub, 1000 + i, 8));
  }
  const out = await W.d1Launches({ DB: mockD1(vids, rows) }, 'yt');
  const ids = Object.keys(out.curves);
  check('never more than PJ_MAX launches', ids.length === W.PJ_MAX, ids.length);
  check('and they are the newest ones', ids.includes('v0') && !ids.includes('v19'), ids.join(','));

  /* How much of a reference's life travels with it.

     These were one constant. PJ_WINDOW decides when a launch has FINISHED and may be a
     reference at all; PJ_SPAN decides how much of its recording ships. Splitting them is
     what makes a seven-day projection possible without invalidating every reference the
     account already has — raise the eligibility bar instead and nothing qualifies for a
     week, so both dashboards would say "0 of 2" until the data caught up.

     So: a sample from day three now belongs to the curve, and a sample from day eight
     still does not. */
  const pub = NOW - 10 * 864e5;
  const late = launch('yt', 'w', pub, 900, 8).concat([
    { platform: 'yt', video_id: 'w', ts: pub + 60 * HOUR, views: 950 },      // day 2.5 — inside the span
    { platform: 'yt', video_id: 'w', ts: pub + 8 * 864e5, views: 99999 }     // day 8 — past it
  ]);
  const o2 = await W.d1Launches({ DB: mockD1([{ platform: 'yt', video_id: 'w', published_at: pub, title: '', cover: '' }], late) }, 'yt');
  const s2 = o2.curves.w.s, lastPt = s2[s2.length - 1];
  check('the span is a week, not the launch window', W.PJ_SPAN === 7 * 864e5, W.PJ_SPAN);
  check('but eligibility still turns on the 48-hour window', W.PJ_WINDOW === 48 * 3600e3, W.PJ_WINDOW);
  check('a sample from day three is carried now', s2.some(p => p[0] === 60 * 60 && p[1] === 950),
    s2.filter(p => p[0] >= 48 * 60).map(p => p.join('@')).join(' '));
  check('nothing past the seven-day span is', lastPt[1] !== 99999, lastPt.join('@'));
  check('and the last age is inside the span', lastPt[0] <= W.PJ_SPAN / 60000, lastPt[0]);

  // a curve with almost nothing in it is not worth shipping
  const thin = [{ platform: 'yt', video_id: 'thin', published_at: pub, title: '', cover: '' }];
  const thinRows = [0, 5, 10].map(m => ({ platform: 'yt', video_id: 'thin', ts: pub + m * 60000, views: m }));
  const o3 = await W.d1Launches({ DB: mockD1(thin, thinRows) }, 'yt');
  check('a curve of three points is dropped', !o3.curves.thin);
}

/* 5 — TikTok partitioning */
console.log('\n5. TikTok accounts stay separate');
{
  const A = W.ttKey('openA'), B = W.ttKey('openB');
  const pub = NOW - 100 * HOUR;
  const vids = [
    { platform: A, video_id: 'a1', published_at: pub, title: 'hers', cover: 'https://c/a.jpg' },
    { platform: B, video_id: 'b1', published_at: pub, title: 'his', cover: '' }
  ];
  const rows = [...launch(A, 'a1', pub, 2000, 8), ...launch(B, 'b1', pub, 9999, 8)];
  const out = await W.d1Launches({ DB: mockD1(vids, rows) }, A);
  check('only this account\'s posts come back', Object.keys(out.curves).join(',') === 'a1');
  check('the TikTok shape uses create_time in seconds',
    out.curves.a1.create_time === Math.round(pub / 1000));
  check('and carries the cover', out.curves.a1.cover === 'https://c/a.jpg');
  check('it does not carry a YouTube-style pub', out.curves.a1.pub === undefined);
}

/* 6 — the cache tracks what it depends on, not a clock */
console.log('\n6. the answer is cached on the roster, not on a timer');
{
  const pub = NOW - 100 * HOUR;
  const vids = [{ platform: 'yt', video_id: 'v', published_at: pub, title: '', cover: '' }];
  const rows = launch('yt', 'v', pub, 2000, 8);
  const DB = mockD1(vids, rows);
  const MINUTE = mockKV();
  const env = { DB, MINUTE };
  W.pjMemo.clear();

  const first = await W.launchBody(env, 'yt');
  const built = DB.stats().rowsRead;
  check('the cache key is versioned', [...MINUTE.m.keys()][0] === 'launch:' + W.PJ_CACHE + ':yt', [...MINUTE.m.keys()][0]);
  check('the first call reads the samples', built > 1000, built);
  check('and writes the cache once', MINUTE.puts() === 1, MINUTE.puts());
  check('the roster it built from is remembered', first.ids === 'v', first.ids);

  // within the isolate memo, nothing is asked of anything
  const memoed = await W.launchBody(env, 'yt');
  check('a burst inside the memo window touches neither D1 nor KV',
    DB.stats().rowsRead === built && MINUTE.puts() === 1);
  check('and still returns the same answer', memoed.ids === first.ids);

  // past the memo, the roster is re-checked but the curves are not rebuilt
  W.pjMemo.clear();
  await W.launchBody(env, 'yt');
  const afterCheck = DB.stats().rowsRead - built;
  check('an unchanged roster costs only the cheap query', afterCheck > 0 && afterCheck < 50, afterCheck + ' rows');
  check('and writes nothing', MINUTE.puts() === 1, MINUTE.puts());

  // a launch finishing changes the roster, and that is what triggers the rebuild
  const pub2 = NOW - 60 * HOUR;
  vids.unshift({ platform: 'yt', video_id: 'w', published_at: pub2, title: '', cover: '' });
  rows.push(...launch('yt', 'w', pub2, 800, 8));
  W.pjMemo.clear();
  const before = DB.stats().rowsRead;
  const grown = await W.launchBody(env, 'yt');
  check('a newly finished launch rebuilds immediately', DB.stats().rowsRead - before > 1000, DB.stats().rowsRead - before);
  check('and appears in the answer', !!grown.curves.w && !!grown.curves.v, Object.keys(grown.curves).join(','));
  check('and is written back', MINUTE.puts() === 2, MINUTE.puts());
  check('with the new roster recorded', grown.ids === 'w,v', grown.ids);

  // and a rebuild happens once a day regardless, for changes the roster cannot see
  const stale = JSON.parse(MINUTE.m.get('launch:' + W.PJ_CACHE + ':yt'));
  stale.at = Date.now() - W.PJ_STALE - 1;
  MINUTE.m.set('launch:' + W.PJ_CACHE + ':yt', JSON.stringify(stale));
  W.pjMemo.clear();
  const b2 = DB.stats().rowsRead;
  await W.launchBody(env, 'yt');
  check('a day-old answer is rebuilt even with an unchanged roster', DB.stats().rowsRead - b2 > 1000);

  // KV falling over must not take the route with it
  W.pjMemo.clear();
  const dead = { async get() { throw new Error('kv down'); }, async put() { throw new Error('kv down'); } };
  const out = await W.launchBody({ DB, MINUTE: dead }, 'yt');
  check('a broken KV still serves fresh curves', !!out.curves.v);
}

/* 6b — the empty roster, which is the state every new account starts in */
console.log('\n6b. an account with nothing to serve still gets to use the cache');
{
  /* The freshness test was `hit.ids && ...`. An account with no finished launches has an
     empty roster, and an empty roster joins to '' — falsy — so the cache never hit, and
     the one account with nothing worth caching was the one that went to D1 on every single
     request. Invisible in the output: the answer is correct either way, it is just paid
     for over and over. This is also the state her account was in for the first two days,
     and the state any new platform starts in. */
  const vids = [], rows = [];
  const DB = mockD1(vids, rows);
  const MINUTE = mockKV();
  const env = { DB, MINUTE };
  W.pjMemo.clear();

  const first = await W.launchBody(env, 'yt');
  check('an empty roster still produces an answer', !!first && !!first.curves, JSON.stringify(first));
  check('with no curves in it', Object.keys(first.curves).length === 0);
  check('and its empty roster recorded as a string, not as nothing', first.ids === '', JSON.stringify(first.ids));
  check('it is written to the cache like any other answer', MINUTE.puts() === 1, MINUTE.puts());

  W.pjMemo.clear();
  const before = DB.stats().rowsRead;
  const second = await W.launchBody(env, 'yt');
  check('the second call hits that cache', DB.stats().rowsRead - before < 50, DB.stats().rowsRead - before + ' rows');
  check('and does not rewrite it', MINUTE.puts() === 1, MINUTE.puts());
  check('serving the same empty answer', second.ids === '' && Object.keys(second.curves).length === 0);

  // and the first real launch still breaks the cache, empty-to-nonempty like any other change
  const pub = NOW - 100 * HOUR;
  vids.push({ platform: 'yt', video_id: 'first', published_at: pub, title: '', cover: '' });
  rows.push(...launch('yt', 'first', pub, 900, 8));
  W.pjMemo.clear();
  const grown = await W.launchBody(env, 'yt');
  check('the first finished launch rebuilds immediately', grown.ids === 'first', grown.ids);
  check('and is there to project from', !!grown.curves.first);
}

/* 7 — what the route emits is what the model can use */
console.log('\n7. end to end: emitted curves drive a real projection');
{
  const vids = [], rows = [];
  const spec = [['r1', 155, 2027, 8], ['r2', 185, 1400, 8.15], ['r3', 208, 3100, 7.85]];
  for (const [id, hrs, final, k] of spec) {
    const pub = NOW - hrs * HOUR;
    vids.push({ platform: 'yt', video_id: id, published_at: pub, title: id, cover: '' });
    rows.push(...launch('yt', id, pub, final, k));
  }
  const out = await W.d1Launches({ DB: mockD1(vids, rows) }, 'yt');
  const refs = Object.values(out.curves).map(c => M.pjRef(c.s)).filter(Boolean);
  check('every emitted curve is accepted as a reference', refs.length === spec.length, refs.length + '/' + spec.length);

  const p = M.pjProject(refs, 6 * 60, 600);
  check('and six hours into a new launch it projects', p.state === 'ok', p.state);
  check('with a sane band', p.state === 'ok' && p.lo >= 600 && p.hi > p.mid && p.mid > p.lo,
    p.state === 'ok' ? p.lo + '..' + p.mid + '..' + p.hi : p.state);

  // the same three curves at full minute resolution must give the same answer, or the
  // downsampling is throwing away something the model was using
  const fullRefs = spec.map(([id, hrs, final, k]) =>
    M.pjRef(launch('yt', id, NOW - hrs * HOUR, final, k).map((r, i) => [i, r.views]))).filter(Boolean);
  const q = M.pjProject(fullRefs, 6 * 60, 600);
  check('downsampling does not move the projection',
    Math.abs(p.mid / q.mid - 1) < 0.02, p.mid + ' vs ' + q.mid);
}

/* 8 — the TikTok round trip, which has one more step than YouTube's */
{
  // tiktok.html cannot merge age-indexed points directly: its store is keyed by absolute
  // timestamp, so it converts back before handing them to mergeHist, and pjCurveOf then
  // converts forward again. Two conversions in opposite directions is exactly where an
  // age silently shifts, so the round trip is pinned here rather than assumed.
  const ttPage = fs.readFileSync(HERE + '../yt-dashboard/tiktok.html', 'utf8');
  const at = ttPage.indexOf('function pjCurveOf');
  const pjCurveOf = new Function(ttPage.slice(at, ttPage.indexOf('\n  }\n', at)) + '\n  }\n\nreturn pjCurveOf;')();

  const part = W.ttKey('openA');
  // 37 seconds past a whole minute — the ordinary case, since nobody posts on the minute.
  // Pinning it makes the flooring check below deterministic instead of depending on where
  // in the minute this test happens to run.
  const pub = Math.floor((NOW - 100 * HOUR) / 60000) * 60000 + 37000;
  const createTime = Math.round(pub / 1000);
  const vids = [{ platform: part, video_id: 'a1', published_at: pub, title: '', cover: '' }];
  const out = await W.d1Launches({ DB: mockD1(vids, launch(part, 'a1', pub, 2000, 8)) }, part);
  const served = out.curves.a1;

  // the exact conversion tiktok.html's pullLaunches does
  const t0 = served.create_time * 1000;
  const asStore = served.s.map(p => [t0 + p[0] * 60000, p[1]]);
  const back = pjCurveOf('a1', served.create_time, { s: asStore });

  check('every age survives the round trip',
    JSON.stringify(back) === JSON.stringify(served.s),
    back ? 'first ' + JSON.stringify(back.slice(0, 2)) + ' vs ' + JSON.stringify(served.s.slice(0, 2)) : 'null');
  check('and the rebuilt curve is still a reference', !!M.pjRef(back));
  check('projecting from it agrees with projecting from the raw served curve',
    M.pjProject([M.pjRef(back), M.pjRef(served.s)], 6 * 60, 500).state === 'ok');

  // the tempting "tidy up onto whole minutes" step is what broke this: create_time is a
  // whole second, not a whole minute, so flooring drags every point back below its own
  // age and the first one out of the curve entirely
  const floored = served.s.map(p => [Math.floor((t0 + p[0] * 60000) / 60000) * 60000, p[1]]);
  const wrong = pjCurveOf('a1', served.create_time, { s: floored });
  check('flooring onto whole minutes would corrupt the ages — the guard is real',
    JSON.stringify(wrong) !== JSON.stringify(served.s));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
