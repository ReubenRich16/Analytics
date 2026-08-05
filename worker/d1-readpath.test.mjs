// Phase 2 verification: prove the D1 read path reproduces the KV bundle exactly.
//
// The sandbox's network policy blocks workers.dev, so the live diff can't be run from
// here. Instead this feeds ONE state through both paths — KV's stored blob and a D1
// mock loaded from the same numbers — and asserts the two bundles agree on every field
// the dashboards actually read (pub, title, and each sample's ts and views).
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { tick, d1Write, d1YtBundle, d1TtBundle, d1Diff };';
const tmp = HERE + '.worker-readpath.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

const NOW = Date.now();
// a realistic state: two videos, one still inside the window, one with samples that
// straddle the KEEP_DAYS boundary so the prune rule gets exercised
const PUB_A = NOW - 5 * 3600e3, PUB_B = NOW - 40 * 3600e3;
const mk = (pub, n, base) => Array.from({ length: n }, (_, i) => [pub + i * 60000, base + i * 3, 10 + i, i]);
const kvState = { updated: NOW, lastScan: NOW, videos: {
  vidA: { pub: new Date(PUB_A).toISOString(), title: 'HEAD SCRATCH ASMR', chan: 'UC1', s: mk(PUB_A, 90, 400) },
  vidB: { pub: new Date(PUB_B).toISOString(), title: 'TAPPING · no talking', chan: 'UC1', s: mk(PUB_B, 60, 120) }
} };

// load the same numbers into a D1 mock through the real d1Write, so any coercion bug
// in the write path shows up here too
function mockD1() {
  const samples = [], videos = new Map();
  return { samples, videos,
    prepare(sql) { return { sql, bind: (...a) => ({ sql, args: a }) }; },
    async batch(list) {
      for (const s of list) {
        if (s.sql.includes('INTO samples')) {
          const [platform, video_id, ts, views, likes, comments, shares] = s.args;
          if (!samples.some(r => r.platform === platform && r.video_id === video_id && r.ts === ts))
            samples.push({ platform, video_id, ts, views, likes, comments, shares });
        } else {
          const [platform, video_id, published_at, title, channel, cover] = s.args;
          videos.set(platform + '|' + video_id, { platform, video_id, published_at, title, channel, cover });
        }
      }
      return [];
    },
    // enough of .all() to serve the two SELECTs the bundle builders issue
    _all(sql, args) {
      if (sql.includes('FROM videos')) {
        return { results: [...videos.values()].filter(v => v.platform === args[0]) };
      }
      const [platform, cutoff] = args;
      return { results: samples.filter(r => r.platform === platform && r.ts >= cutoff)
        .sort((a, b) => a.video_id.localeCompare(b.video_id) || a.ts - b.ts) };
    } };
}
// wire prepare(...).bind(...).all() onto the mock. Defined in one place rather than
// spread over the base prepare — the first version spread the base afterwards and
// silently replaced .bind with one that had no .all.
function withAll(db) {
  db.prepare = sql => ({
    sql,
    bind: (...args) => ({
      sql, args,
      all: async () => db._all(sql, args),
      run: async () => ({ meta: { changes: 0 } })
    })
  });
  return db;
}

console.log('\n1. D1 bundle reproduces the KV bundle');
const DB = withAll(mockD1());
{
  const rows = [], metas = [];
  for (const [id, rec] of Object.entries(kvState.videos)) {
    metas.push({ id, pub: new Date(rec.pub).getTime(), title: rec.title, chan: rec.chan });
    for (const s of rec.s) rows.push({ id, ts: s[0], views: s[1], likes: s[2], comments: s[3], shares: 0 });
  }
  const w = await W.d1Write({ DB }, 'yt', rows, metas);
  check('write reported no error', !w.error, JSON.stringify(w));

  const d1 = await W.d1YtBundle({ DB });
  const diff = W.d1Diff(kvState.videos, d1.videos);
  check('bundles match', diff.match, JSON.stringify(diff, null, 1));
  check('same video count', diff.counts.kv === diff.counts.d1, JSON.stringify(diff.counts));

  // and byte-equality on the fields the dashboards read
  const slim = v => Object.fromEntries(Object.entries(v).map(([id, r]) =>
    [id, { pub: r.pub, title: r.title, s: r.s.map(x => [x[0], x[1]]) }]));
  check('byte-identical on the consumed fields',
    JSON.stringify(slim(kvState.videos)) === JSON.stringify(slim(d1.videos)));
}

console.log('\n2. The diff actually catches a mismatch');
{
  const broken = JSON.parse(JSON.stringify(kvState.videos));
  broken.vidA.s[3][1] += 1;
  const d1 = await W.d1YtBundle({ DB });
  const diff = W.d1Diff(broken, d1.videos);
  check('reports not-matching', diff.match === false);
  check('names the video', diff.differing.length === 1 && diff.differing[0].id === 'vidA', JSON.stringify(diff.differing));
}
{
  const missing = JSON.parse(JSON.stringify(kvState.videos)); delete missing.vidB;
  const d1 = await W.d1YtBundle({ DB });
  const diff = W.d1Diff(missing, d1.videos);
  check('spots a video only in D1', diff.onlyInD1.length === 1 && diff.onlyInD1[0] === 'vidB', JSON.stringify(diff));
}

console.log('\n3. Retention window matches KV, so the diff is like-for-like');
{
  const d1 = await W.d1YtBundle({ DB }, 1);            // 1-day window
  const inWindow = kvState.videos.vidA.s.filter(s => s[0] >= NOW - 864e5).length;
  check('older video drops out', !d1.videos.vidB, Object.keys(d1.videos).join(','));
  check('recent video keeps its in-window samples', d1.videos.vidA.s.length === inWindow,
    d1.videos.vidA.s.length + ' vs ' + inWindow);
}

console.log('\n4. TikTok bundle keeps create_time in seconds, as the page expects');
{
  const TT = withAll(mockD1());
  const pub = NOW - 3 * 3600e3;
  await W.d1Write({ DB: TT }, 'tt', [{ id: 't1', ts: pub, views: 900, likes: 80, comments: 4, shares: 12 }],
                                    [{ id: 't1', pub, title: 'soft brushing', cover: 'c.jpg' }]);
  const b = await W.d1TtBundle({ DB: TT });
  check('create_time is seconds', b.videos.t1.create_time === Math.round(pub / 1000), b.videos.t1.create_time);
  check('shares survive to the 5th column', b.videos.t1.s[0][4] === 12, JSON.stringify(b.videos.t1.s[0]));
  check('cover preserved', b.videos.t1.cover === 'c.jpg');
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
