// Phase 3 verification: D1 answers by default, and KV takes over when it can't.
//
// This drives the real HTTP handler rather than the bundle builders, because the whole
// point of phase 3 is the *selection* between two stores — which one answers, under
// which conditions, and whether the body stays the shape the dashboards already parse.
// The failure this guards against is not an exception; it is D1 answering "nothing" and
// the page quietly drawing empty charts, so most of the cases below are about emptiness.
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { HANDLER, ttKey };';
const tmp = HERE + '.worker-failover.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

const NOW = Date.now();
const PUB = NOW - 2 * 3600e3;
const samples = n => Array.from({ length: n }, (_, i) => [PUB + i * 60000, 100 + i * 5, i, 0]);

// KV holding one video, exactly as the tracker writes it
const KV_BLOB = JSON.stringify({
  updated: NOW, lastScan: NOW,
  videos: { kvOnly: { pub: new Date(PUB).toISOString(), title: 'from KV', chan: 'UC1', s: samples(30) } }
});

function mockKV(store) {
  const m = new Map(Object.entries(store || {}));
  return { store: m,
    async get(k, type) { const v = m.get(k) ?? null; return type === 'json' && v != null ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); } };
}

// A D1 stand-in whose behaviour is set per test: rows to return, or a thrown fault.
function mockD1(rows, opts = {}) {
  const { throws = false } = opts;
  return {
    prepare: sql => ({
      bind: (...args) => ({
        all: async () => {
          if (throws) throw new Error('D1_ERROR: no such table: videos');
          if (sql.includes('FROM videos')) return { results: rows.videos.filter(v => v.platform === args[0]) };
          return { results: rows.samples.filter(r => r.platform === args[0] && r.ts >= args[1]) };
        },
        run: async () => ({ meta: { changes: 0 } })
      })
    }),
    async batch() { return []; }
  };
}
const D1_ONE = {
  videos: [{ platform: 'yt', video_id: 'd1Only', published_at: PUB, title: 'from D1', channel: 'UC1' }],
  samples: samples(30).map(s => ({ platform: 'yt', video_id: 'd1Only', ts: s[0], views: s[1], likes: s[2], comments: s[3] }))
};
const D1_EMPTY = { videos: [], samples: [] };

const hit = (env, path = '/') => W.HANDLER.fetch(new Request('https://w.dev' + path), env);
const read = async r => ({ src: r.headers.get('X-CC-Source'), body: await r.json(), status: r.status });

console.log('\n1. D1 answers by default');
{
  const { src, body } = await read(await hit({ MINUTE: mockKV({ 'minute-v1': KV_BLOB }), DB: mockD1(D1_ONE) }));
  check('served from D1', src === 'd1', src);
  check('D1 video present', !!body.videos.d1Only, Object.keys(body.videos).join());
  check('KV video not mixed in', !body.videos.kvOnly, Object.keys(body.videos).join());
  check('samples came through', body.videos.d1Only.s.length === 30, body.videos.d1Only.s.length);
}

console.log('\n2. D1 throwing falls back to KV, silently and with the right body');
{
  const { src, body, status } = await read(await hit({ MINUTE: mockKV({ 'minute-v1': KV_BLOB }), DB: mockD1(null, { throws: true }) }));
  check('served from KV', src === 'kv', src);
  check('still a 200 — the page must not see an error', status === 200, status);
  check('KV video present', !!body.videos.kvOnly, Object.keys(body.videos).join());
  check('KV extras preserved (updated, lastScan)', body.updated === NOW && body.lastScan === NOW);
}

console.log('\n3. D1 answering EMPTY while KV has data also falls back');
// The case that motivates the whole helper: no exception is raised, so a naive
// try/catch would serve {} and blank every chart on the page.
{
  const { src, body } = await read(await hit({ MINUTE: mockKV({ 'minute-v1': KV_BLOB }), DB: mockD1(D1_EMPTY) }));
  check('served from KV', src === 'kv', src);
  check('charts still have their data', !!body.videos.kvOnly, JSON.stringify(body.videos));
}

console.log('\n4. Both empty: D1 answers, so a new account is not pinned to KV forever');
{
  const { src, body } = await read(await hit({ MINUTE: mockKV({}), DB: mockD1(D1_EMPTY) }));
  check('served from D1', src === 'd1', src);
  check('empty but well-formed', body && typeof body.videos === 'object' && !Object.keys(body.videos).length);
}

console.log('\n5. No D1 binding at all (rollback, or an older deploy)');
{
  const { src, body } = await read(await hit({ MINUTE: mockKV({ 'minute-v1': KV_BLOB }) }));
  check('served from KV', src === 'kv', src);
  check('KV video present', !!body.videos.kvOnly);
}

console.log('\n6. ?src= forces one store and tells the truth about it');
{
  const env = { MINUTE: mockKV({ 'minute-v1': KV_BLOB }), DB: mockD1(D1_ONE) };
  const kv = await read(await hit(env, '/?src=kv'));
  check('?src=kv serves KV even though D1 is healthy', kv.src === 'kv' && !!kv.body.videos.kvOnly, kv.src);

  const envEmpty = { MINUTE: mockKV({ 'minute-v1': KV_BLOB }), DB: mockD1(D1_EMPTY) };
  const d1 = await read(await hit(envEmpty, '/?src=d1'));
  check('?src=d1 serves D1 even when empty (no silent fallback)', d1.src === 'd1' && !Object.keys(d1.body.videos).length, d1.src);

  const broken = { MINUTE: mockKV({ 'minute-v1': KV_BLOB }), DB: mockD1(null, { throws: true }) };
  const err = await read(await hit(broken, '/?src=d1'));
  check('?src=d1 reports a D1 failure instead of hiding it', err.status === 502 && /D1 read failed/.test(err.body.error), JSON.stringify(err));
}

console.log('\n7. The served body is byte-identical in shape to what KV served before');
// Phase 3 is a change of source and nothing else — no dashboard edit should be needed.
{
  const { body } = await read(await hit({ MINUTE: mockKV({}), DB: mockD1(D1_ONE) }));
  const v = body.videos.d1Only;
  check('video keys unchanged', JSON.stringify(Object.keys(v).sort()) === JSON.stringify(['chan', 'pub', 's', 'title']), Object.keys(v).join());
  check('sample rows are [ts, views, likes, comments]', v.s[0].length === 4 && v.s[0][0] === PUB && v.s[0][1] === 100, JSON.stringify(v.s[0]));
  check('pub is an ISO string', typeof v.pub === 'string' && !isNaN(Date.parse(v.pub)), v.pub);
  check('no marker leaked into the payload', !('src' in body) && !('_source' in body), Object.keys(body).join());
}

console.log('\n8. X-CC-Source is readable by the dashboard cross-origin');
// A custom response header is invisible to fetch() from github.io unless it is exposed.
{
  const r = await hit({ MINUTE: mockKV({}), DB: mockD1(D1_ONE) });
  check('exposed via CORS', (r.headers.get('Access-Control-Expose-Headers') || '').includes('X-CC-Source'),
    r.headers.get('Access-Control-Expose-Headers'));
}

console.log('\n9. ?since= is never mistaken for an empty D1');
{
  // An incremental read comes back empty whenever nothing new has happened, which is the
  // common case. If that were treated as "D1 has nothing" the fallback would ship the whole
  // KV blob on every quiet poll — the exact traffic ?since= exists to avoid.
  const env = { MINUTE: mockKV({ 'minute-v1': KV_BLOB }), DB: mockD1(D1_EMPTY) };
  const { src, body, status } = await read(await hit(env, '/?since=' + (NOW - 1000)));
  check('empty incremental answer still comes from D1', src === 'd1', src);
  check('and is an empty bundle, not the KV blob', !Object.keys(body.videos).length, Object.keys(body.videos).join());
  check('still a 200', status === 200, status);

  // but a genuine D1 fault with ?since= must STILL fall back, or a fault during a launch
  // would look exactly like "nothing new" forever
  const broken = { MINUTE: mockKV({ 'minute-v1': KV_BLOB }), DB: mockD1(null, { throws: true }) };
  const f = await read(await hit(broken, '/?since=' + (NOW - 1000)));
  check('a throwing D1 still falls back to KV', f.src === 'kv', f.src);
  check('and the KV data is there', !!f.body.videos.kvOnly, Object.keys(f.body.videos).join());
}

console.log('\n10. A dashboard poll must not cost a KV write');
{
  // /tiktok/me is called once every 60 seconds by the TikTok dashboard's poll loop. It used
  // to cache the profile under tt:meta:<openId> on every one of those calls -- roughly 480
  // writes a day per open tab, against a 1,000/day free tier -- to populate a key that
  // nothing in the codebase ever read. Two open tabs would have consumed the entire budget
  // the tracker's own write gate was built to stay inside.
  const KV = mockKV({ 'tt:sess:S': 'open-1', 'tt:tok:open-1': JSON.stringify({ access_token: 'A', expires_at: NOW + 36e5 }) });
  let puts = 0;
  const wrapped = { ...KV, async get(k, t) { return KV.get(k, t); }, async put(k, v, o) { puts++; return KV.put(k, v, o); } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { user: { open_id: 'open-1', display_name: 'X', follower_count: 5 } } }), { status: 200 });
  const r = await W.HANDLER.fetch(
    new Request('https://w.dev/tiktok/me', { headers: { Authorization: 'Bearer S' } }),
    { MINUTE: wrapped, DB: mockD1(D1_EMPTY), TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' });
  globalThis.fetch = realFetch;
  const body = await r.json().catch(() => ({}));
  check('the profile still comes back', r.status === 200 && body.display_name === 'X', r.status + ' ' + JSON.stringify(body));
  check('and it cost zero KV writes', puts === 0, puts + ' write(s)');
}

console.log('\n11. Disconnect actually revokes, and login can force the consent screen');
{
  // "Sign out" used to only forget the session id in the browser. The refresh token and
  // the tt:accounts entry survived, so the cron kept polling an account the user believed
  // was removed -- and because TikTok replays a grant it already holds, signing back in
  // silently reattached the same account. That combination makes it impossible to switch
  // to a different account at all, which is what this pair of changes exists to fix.
  const KV = mockKV({
    'tt:accounts': JSON.stringify(['open-me', 'open-other']),
    'tt:sess:SID': 'open-me',
    'tt:tok:open-me': JSON.stringify({ access_token: 'A', expires_at: NOW + 36e5 }),
    'tt:tok:open-other': JSON.stringify({ access_token: 'B', expires_at: NOW + 36e5 })
  });
  KV.delete = async k => { KV.store.delete(k); };
  const env = { MINUTE: KV, DB: mockD1(D1_EMPTY), TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' };

  const r = await W.HANDLER.fetch(new Request('https://w.dev/tiktok/disconnect', {
    method: 'POST', headers: { Authorization: 'Bearer SID' } }), env);
  const body = await r.json().catch(() => ({}));
  check('disconnect succeeds', r.status === 200 && body.ok === true, r.status + ' ' + JSON.stringify(body));
  check('the session is revoked server-side', !KV.store.has('tt:sess:SID'));
  check('the refresh token is deleted', !KV.store.has('tt:tok:open-me'));
  check('the account is removed from the polling list',
    JSON.parse(KV.store.get('tt:accounts')).join() === 'open-other', KV.store.get('tt:accounts'));
  check('the OTHER account is left alone', KV.store.has('tt:tok:open-other'));

  // GET must not revoke anything. Needs a live session: the POST above revoked SID, so
  // reusing it would 401 on authentication before the method check is ever reached.
  KV.store.set('tt:sess:SID2', 'open-other');
  const g = await W.HANDLER.fetch(new Request('https://w.dev/tiktok/disconnect', {
    headers: { Authorization: 'Bearer SID2' } }), env);
  check('GET is rejected', g.status === 405, g.status);
  check('and revoked nothing', KV.store.has('tt:tok:open-other') && KV.store.has('tt:sess:SID2'));
}

console.log('\n12. ?reauth=1 asks TikTok not to auto-authorise');
{
  const env = { MINUTE: mockKV({}), DB: mockD1(D1_EMPTY), TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 's' };
  const plain = await W.HANDLER.fetch(new Request('https://w.dev/tiktok/login'), env);
  const forced = await W.HANDLER.fetch(new Request('https://w.dev/tiktok/login?reauth=1'), env);
  const loc = r => new URL(r.headers.get('Location'));
  check('a normal login does not force the prompt', !loc(plain).searchParams.get('disable_auto_auth'));
  check('reauth does', loc(forced).searchParams.get('disable_auto_auth') === '1');
  check('and the rest of the flow is unchanged',
    loc(forced).searchParams.get('client_key') === 'ck' && !!loc(forced).searchParams.get('state'));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
