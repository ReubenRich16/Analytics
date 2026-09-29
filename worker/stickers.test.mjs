// The sticker drawer's store — /stickers (YouTube) and /tiktok/stickers (TikTok).
//
// Stickers are the one thing in the Worker that stores something a person drew or chose
// rather than a number the platforms published, so the route is strict about shape: a
// GIPHY sticker is only ever a media id (the page builds the media.giphy.com URL itself),
// an upload is only ever a base64 image data: URL, and the whole list is capped. Nothing
// else — no other URL, no markup — can be stored and later handed back to the page.
//
// Both routes are owner-locked exactly like the sync store beside them: the TikTok one by
// the session id, the YouTube one by the same Google ownership check /sync uses.
//
// Run: node worker/stickers.test.mjs
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { HANDLER, checkStickers, STICKER_MAX, STICKER_BYTES };';
const tmp = HERE + '.worker-stickers.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

function mockKV(store) {
  const m = new Map(Object.entries(store || {}));
  let puts = 0;
  return { store: m, puts: () => puts,
    async get(k) { return m.get(k) ?? null; },
    async put(k, v) { puts++; m.set(k, v); },
    async delete(k) { m.delete(k); } };
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const good = () => [
  { id: 'g1', kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU', name: 'Happy', added: 1 },
  { id: 'u-1', kind: 'upload', src: PNG, name: 'mine.png', added: 2 }
];

console.log('\nstickers — the shape check');
{
  const ok = W.checkStickers(good());
  check('a GIPHY id and a PNG upload are accepted', ok.list && ok.list.length === 2, JSON.stringify(ok).slice(0, 120));
  check('an empty list is a valid list', W.checkStickers([]).list?.length === 0);
  for (const t of ['webp', 'jpeg', 'gif'])
    check('accepts a ' + t + ' upload', !!W.checkStickers([{ id: 'a', kind: 'upload', src: 'data:image/' + t + ';base64,AAAA' }]).list);
  const bad = [
    ['not an array', { list: 1 }],
    ['25 stickers', Array.from({ length: 25 }, (_, i) => ({ id: 's' + i, kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU' }))],
    ['a null item', [null]],
    ['an array item', [[1]]],
    ['a missing id', [{ kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU' }]],
    ['an id with markup', [{ id: '<b>', kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU' }]],
    ['a duplicate id', [{ id: 'a', kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU' }, { id: 'a', kind: 'giphy', src: 'lTY8pVIs76YOMDaDjY' }]],
    ['another kind', [{ id: 'a', kind: 'url', src: 'https://evil.example/x.png' }]],
    ['a GIPHY src that is a URL', [{ id: 'a', kind: 'giphy', src: 'https://media.giphy.com/media/JQAxGWgPNy5uCzFkHU/giphy.gif' }]],
    ['a GIPHY id too short', [{ id: 'a', kind: 'giphy', src: 'abc123' }]],
    ['a GIPHY id with a slash', [{ id: 'a', kind: 'giphy', src: 'JQAxGWgP/../x' }]],
    ['a GIPHY id of 41 chars', [{ id: 'a', kind: 'giphy', src: 'a'.repeat(41) }]],
    ['an upload that is a URL', [{ id: 'a', kind: 'upload', src: 'https://evil.example/x.png' }]],
    ['an SVG upload (can carry script)', [{ id: 'a', kind: 'upload', src: 'data:image/svg+xml;base64,PHN2Zz4=' }]],
    ['an upload that is not base64', [{ id: 'a', kind: 'upload', src: 'data:image/png,<svg onload=1>' }]],
    ['an upload with junk after the data', [{ id: 'a', kind: 'upload', src: 'data:image/png;base64,AAAA"><script>' }]],
    ['a numeric src', [{ id: 'a', kind: 'giphy', src: 12345678 }]],
    ['a name that is not text', [{ id: 'a', kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU', name: {} }]],
    ['a name of 81 chars', [{ id: 'a', kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU', name: 'x'.repeat(81) }]],
    ['a date that is text', [{ id: 'a', kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU', added: 'today' }]],
  ];
  for (const [what, list] of bad) {
    const r = W.checkStickers(list);
    check('refuses ' + what + ' (400)', !r.list && r.status === 400, JSON.stringify(r).slice(0, 100));
  }
  const big = [{ id: 'a', kind: 'upload', src: 'data:image/png;base64,' + 'A'.repeat(W.STICKER_BYTES) }];
  check('a list over 3.5 MB is 413, not 400', W.checkStickers(big).status === 413);
  const extra = W.checkStickers([{ id: 'a', kind: 'giphy', src: 'JQAxGWgPNy5uCzFkHU', html: '<img onerror=x>' }]);
  check('unknown fields are dropped, not stored', extra.list && !('html' in extra.list[0]));
}

const TT = (path, env, init) => W.HANDLER.fetch(new Request('https://w.dev' + path, init), env);
const ttEnv = KV => ({ MINUTE: KV, TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' });

console.log('\n/tiktok/stickers — session-locked, round trip');
{
  const KV = mockKV({ 'tt:sess:S1': 'open-me', 'tt:sess:S2': 'open-other' });
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = async () => { outbound++; return new Response('{}', { status: 500 }); };

  let r = await TT('/tiktok/stickers', ttEnv(KV));
  check('no session → 401', r.status === 401);
  r = await TT('/tiktok/stickers', ttEnv(KV), { headers: { Authorization: 'Bearer nope' } });
  check('an unknown session → 401', r.status === 401);
  r = await TT('/tiktok/stickers', ttEnv(KV), { method: 'POST', body: JSON.stringify({ list: good() }) });
  check('a POST without a session → 401, and nothing stored', r.status === 401 && KV.puts() === 0);

  r = await TT('/tiktok/stickers', ttEnv(KV), { headers: { Authorization: 'Bearer S1' } });
  check('a fresh account reads []', r.status === 200 && JSON.stringify(await r.json()) === '[]');
  check('with CORS like the others', r.headers.get('Access-Control-Allow-Origin') === '*');

  r = await TT('/tiktok/stickers', ttEnv(KV), { method: 'POST', headers: { Authorization: 'Bearer S1', 'Content-Type': 'application/json' }, body: JSON.stringify({ list: good() }) });
  const pj = await r.json();
  check('POST stores the list', r.status === 200 && pj.ok === true && pj.n === 2, JSON.stringify(pj));
  check('under tt:stickers:<openId>', KV.store.has('tt:stickers:open-me'));
  r = await TT('/tiktok/stickers', ttEnv(KV), { headers: { Authorization: 'Bearer S1' } });
  const back = await r.json();
  check('and GET hands the same list back', JSON.stringify(back) === JSON.stringify(good()), JSON.stringify(back).slice(0, 120));
  r = await TT('/tiktok/stickers', ttEnv(KV), { headers: { Authorization: 'Bearer S2' } });
  check('another account does not see it', JSON.stringify(await r.json()) === '[]');

  const before = KV.store.get('tt:stickers:open-me');
  r = await TT('/tiktok/stickers', ttEnv(KV), { method: 'POST', headers: { Authorization: 'Bearer S1' }, body: JSON.stringify({ list: [{ id: 'x', kind: 'url', src: 'https://evil.example' }] }) });
  check('a bad shape is 400 and leaves the stored list alone', r.status === 400 && KV.store.get('tt:stickers:open-me') === before);
  r = await TT('/tiktok/stickers', ttEnv(KV), { method: 'POST', headers: { Authorization: 'Bearer S1' }, body: 'not json' });
  check('a body that is not JSON is 400', r.status === 400);
  r = await TT('/tiktok/stickers', ttEnv(KV), { method: 'POST', headers: { Authorization: 'Bearer S1' }, body: JSON.stringify({}) });
  check('a body with no list is 400', r.status === 400);
  const huge = JSON.stringify({ list: [{ id: 'a', kind: 'upload', src: 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024) }] });
  r = await TT('/tiktok/stickers', ttEnv(KV), { method: 'POST', headers: { Authorization: 'Bearer S1' }, body: huge });
  check('a body over the cap is 413', r.status === 413);
  r = await TT('/tiktok/stickers', ttEnv(KV), { method: 'PUT', headers: { Authorization: 'Bearer S1' }, body: '{}' });
  check('another method is 405', r.status === 405);
  check('none of it asked TikTok for anything (no token fetch needed)', outbound === 0, outbound + ' outbound');
  globalThis.fetch = realFetch;
}

console.log('\n/stickers — the YouTube side, locked like /sync');
{
  const KV = mockKV({});
  const env = { MINUTE: KV, CHANNEL_ID: 'UC_mine,UC_family' };
  const realFetch = globalThis.fetch;
  // verifyOwner asks Google whose token this is
  globalThis.fetch = async (u, init) => {
    const a = (init && init.headers && init.headers.Authorization) || '';
    const who = a === 'Bearer good' ? 'UC_mine' : a === 'Bearer stranger' ? 'UC_someone_else' : null;
    if (!who) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ items: [{ id: who }] }), { status: 200 });
  };
  let r = await TT('/stickers', env);
  check('no token → 401', r.status === 401);
  r = await TT('/stickers', env, { headers: { Authorization: 'Bearer stranger' } });
  check('a channel that is not tracked → 401', r.status === 401);
  r = await TT('/stickers', env, { method: 'POST', headers: { Authorization: 'Bearer stranger' }, body: JSON.stringify({ list: good() }) });
  check('and it cannot write', r.status === 401 && KV.puts() === 0);
  r = await TT('/stickers', env, { headers: { Authorization: 'Bearer good' } });
  check('the owner reads [] at first', r.status === 200 && JSON.stringify(await r.json()) === '[]');
  r = await TT('/stickers', env, { method: 'POST', headers: { Authorization: 'Bearer good' }, body: JSON.stringify({ list: good() }) });
  check('the owner can save', r.status === 200 && KV.store.has('stickers:UC_mine'));
  r = await TT('/stickers', env, { headers: { Authorization: 'Bearer good' } });
  check('and read it back', JSON.stringify(await r.json()) === JSON.stringify(good()));
  r = await TT('/stickers', env, { method: 'POST', headers: { Authorization: 'Bearer good' }, body: JSON.stringify({ list: 'x' }) });
  check('a bad shape is 400', r.status === 400);
  r = await TT('/stickers', env, { method: 'DELETE', headers: { Authorization: 'Bearer good' } });
  check('another method is 405', r.status === 405);
  r = await TT('/stickers', env, { method: 'OPTIONS' });
  check('preflight answers with CORS', r.status === 200 && /POST/.test(r.headers.get('Access-Control-Allow-Methods') || ''));
  globalThis.fetch = realFetch;
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
