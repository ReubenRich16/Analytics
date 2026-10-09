// The export route — /tiktok/export — and the two D1 reads behind it.
//
// What this is for. The record the tracker writes (every reading, 60 days) could only ever
// leave the database through a GitHub workflow that dumped the whole thing: every connected
// account in one artifact, on a public repo. This route serves the record to the account it
// belongs to, and nothing else: the session names the open_id, the open_id names the
// partition, and there is no parameter that reaches another one.
//
// The tests are about the three things that matter here: scoping (the other account's rows
// never come back), shape (raw rows, in order, every metric), and the route's manners (401
// without a session, works without a TikTok token, 503 with no database, 502 on a fault).
//
// Run: node worker/d1-export.test.mjs
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { HANDLER, d1ExportRoster, d1ExportPost, ttKey, D1_KEEP_DAYS };';
const tmp = HERE + '.worker-export.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

const HOUR = 3600e3, DAY = 864e5;
const NOW = Date.parse('2026-10-09T09:00:00Z');
const PUB = NOW - 20 * DAY;

function tapered(platform, id, pub, untilMs) {
  const out = [];
  for (let t = 0; t <= Math.min(untilMs, 48 * HOUR); t += 60e3)
    out.push({ platform, video_id: id, ts: pub + t, views: 100 + t / 60e3, likes: 1, comments: 0, shares: 2 });
  for (let t = 48 * HOUR + 15 * 60e3; t <= Math.min(untilMs, 14 * DAY); t += 15 * 60e3)
    out.push({ platform, video_id: id, ts: pub + t, views: 3000 + Math.round(t / 60e3), likes: 2, comments: 1, shares: 3 });
  for (let t = 14 * DAY + HOUR; t <= untilMs; t += HOUR)
    out.push({ platform, video_id: id, ts: pub + t, views: 20000 + Math.round(t / 60e3), likes: 3, comments: 2, shares: 4 });
  return out;
}
function mockD1(vids, rows) {
  let rowsRead = 0;
  const db = {
    sqls: [], stats: () => ({ rowsRead }),
    _all(sql, args) {
      db.sqls.push(sql);
      if (/FROM videos WHERE platform = \? ORDER BY published_at/.test(sql)) {
        const out = vids.filter(v => v.platform === args[0]).sort((a, b) => a.published_at - b.published_at);
        rowsRead += out.length;
        return { results: out.map(v => ({ ...v })) };
      }
      if (/FROM samples WHERE platform = \? AND video_id = \? ORDER BY ts/.test(sql)) {
        const out = rows.filter(r => r.platform === args[0] && r.video_id === args[1]).sort((a, b) => a.ts - b.ts);
        rowsRead += out.length;
        return { results: out.map(r => ({ ts: r.ts, views: r.views, likes: r.likes, comments: r.comments, shares: r.shares })) };
      }
      throw new Error('unexpected SQL in this test: ' + sql);
    }
  };
  db.prepare = sql => ({ bind: (...args) => ({ all: async () => db._all(sql, args) }) });
  return db;
}
const mockKV = init => {
  const store = new Map(Object.entries(init || {}));
  return { store, async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); } };
};
const A = W.ttKey('open-me'), B = W.ttKey('open-other');
const vids = [
  { platform: A, video_id: 'p2', published_at: PUB + 5 * DAY, title: 'Newer one #asmr', cover: 'https://c/2.jpg', first_seen: PUB + 5 * DAY + 60e3 },
  { platform: A, video_id: 'p1', published_at: PUB, title: 'Older one', cover: '', first_seen: PUB + 60e3 },
  { platform: B, video_id: 'p1', published_at: PUB, title: 'hers, same id', cover: '', first_seen: PUB }
];
const rows = [
  ...tapered(A, 'p1', PUB, 20 * DAY),
  ...tapered(A, 'p2', PUB + 5 * DAY, 15 * DAY),
  ...tapered(B, 'p1', PUB, 20 * DAY).map(r => ({ ...r, views: r.views * 99 }))
];

console.log('\n1. the roster: this partition\'s posts, oldest first, in the page\'s shape');
{
  const out = await W.d1ExportRoster({ DB: mockD1(vids, rows) }, A);
  check('two posts, oldest first', out.length === 2 && out[0].id === 'p1' && out[1].id === 'p2', JSON.stringify(out.map(v => v.id)));
  check('create_time in seconds, as the page keeps it', out[0].create_time === Math.round(PUB / 1000));
  check('caption, cover and first_seen carried', out[1].title === 'Newer one #asmr' && out[1].cover === 'https://c/2.jpg' && out[1].first_seen === PUB + 5 * DAY + 60e3);
  check('the other account\'s post is not in it', !out.some(v => v.title === 'hers, same id'));
  check('no open_id or platform string in the answer', !JSON.stringify(out).includes('open-'));
}

console.log('\n2. one post\'s raw readings: every row, every metric, in order, nothing bucketed');
{
  const DB = mockD1(vids, rows);
  const s = await W.d1ExportPost({ DB }, A, 'p1');
  const raw = rows.filter(r => r.platform === A && r.video_id === 'p1');
  check('every reading comes back — the raw count, not an hourly curve', s.length === raw.length && s.length > 2880, s.length);
  check('a reading is [ts, views, likes, comments, shares]', s[0].length === 5 && s[0][0] === PUB && s[0][1] === 100 && s[0][2] === 1 && s[0][3] === 0 && s[0][4] === 2, JSON.stringify(s[0]));
  check('in time order', s.every((r, i) => i === 0 || r[0] > s[i - 1][0]));
  check('the taper is intact: minutes, then quarter hours, then hours', s[1][0] - s[0][0] === 60e3 && s[s.length - 1][0] - s[s.length - 2][0] === HOUR);
  check('reading it costs exactly the rows returned — a primary-key seek', DB.stats().rowsRead === s.length, DB.stats().rowsRead);
  check('the SQL seeks on (platform, video_id) and orders by ts', /WHERE platform = \? AND video_id = \? ORDER BY ts/.test(DB.sqls[0]));
  const other = await W.d1ExportPost({ DB }, A, 'p1');
  const hers = await W.d1ExportPost({ DB }, B, 'p1');
  check('the same post id on two accounts does not bleed', other[other.length - 1][1] < 1e6 && hers[hers.length - 1][1] > 1e6);
  check('an unknown id is an empty list, not an error', (await W.d1ExportPost({ DB }, A, 'nope')).length === 0);
}

console.log('\n3. the route');
{
  const KV = mockKV({ 'tt:sess:S': 'open-me', 'tt:sess:T': 'open-other',
    'tt:followers:open-me': JSON.stringify([[NOW - DAY, 4000, 50000, 2], [NOW, 4100, 51000, 2]]) });
  const env = { MINUTE: KV, DB: mockD1(vids, rows), TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' };
  const hit = (path, sid, e) => W.HANDLER.fetch(new Request('https://w.dev' + path, sid ? { headers: { Authorization: 'Bearer ' + sid } } : undefined), e || env);

  check('no session → 401', (await hit('/tiktok/export')).status === 401);
  const r = await hit('/tiktok/export', 'S');
  const b = await r.json();
  check('the roster answer: videos, followers, keepDays', r.status === 200 && b.videos.length === 2 && b.followers.length === 2 && b.keepDays === W.D1_KEEP_DAYS, r.status + ' ' + JSON.stringify(b).slice(0, 120));
  check('with CORS, since the page is on another origin', r.headers.get('Access-Control-Allow-Origin') === '*');
  check('it works with NO TikTok token stored — the route sits before the token fetch', !KV.store.has('tt:tok:open-me') && r.status === 200);
  const one = await (await hit('/tiktok/export?id=p1', 'S')).json();
  check('?id= answers that post\'s raw readings', one.id === 'p1' && one.s.length > 2880 && one.s[0].length === 5, JSON.stringify(one).slice(0, 80));
  const theirs = await (await hit('/tiktok/export?id=p1', 'T')).json();
  check('the other session gets ITS account\'s p1, not this one\'s', theirs.s[theirs.s.length - 1][1] > 1e6 && one.s[one.s.length - 1][1] < 1e6);
  const mine = await (await hit('/tiktok/export', 'S')).json();
  check('and no parameter reaches another partition: the roster is always the session\'s own', mine.videos.every(v => v.title !== 'hers, same id'));
  check('no open_id in either answer', !JSON.stringify(b).includes('open-') && !JSON.stringify(one).includes('open-'));
  // followers that cannot be read are an empty list, not a failure
  const bad = { ...env, MINUTE: { ...KV, async get(k) { if (k.startsWith('tt:followers:')) throw new Error('kv down'); return KV.get(k); } } };
  const nf = await (await hit('/tiktok/export', 'S', bad)).json();
  check('a failed follower read leaves followers empty and the roster intact', nf.videos.length === 2 && nf.followers.length === 0);
  check('no D1 binding is a 503 with a readable reason', (await hit('/tiktok/export', 'S', { ...env, DB: undefined })).status === 503);
  const boom = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: no such table'); } }) }) };
  const e = await hit('/tiktok/export?id=p1', 'S', { ...env, DB: boom });
  check('a D1 fault is a 502 that names the cause', e.status === 502 && /no such table/.test((await e.json()).error || ''), e.status);
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
