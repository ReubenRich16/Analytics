// What the tracker does when the things it depends on misbehave.
//
// Every fault here is one the code already "handled" by catching the exception and moving
// on. Catching is right — a launch minute is worth more than any single dependency — but
// each of these swallowed something that mattered on the way past, and none of it was
// visible afterwards. That is the shape of the bug this file is about: not a crash, but a
// silence that looks exactly like everything being fine.
//
// Run: node worker/tick-resilience.test.mjs
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { HANDLER, tick, loadState, callGemini, KV_KEY, RUN_COOLDOWN };';
const tmp = HERE + '.worker-resilience.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

const NOW = Date.now();
const PUB = new Date(NOW - 3 * 3600e3).toISOString();
const GOOD_STATE = JSON.stringify({
  updated: NOW - 60 * 60e3, lastScan: NOW,
  videos: { v1: { pub: PUB, title: 'a real upload', chan: 'UC1', s: [[NOW - 120e3, 90, 4, 1]] } }
});

function mockKV(store, faults = {}) {
  const m = new Map(Object.entries(store || {}));
  let puts = 0;
  return {
    m, puts: () => puts,
    async get(k, type) {
      if (faults.get) throw new Error('KV GET failed');
      const v = m.get(k) ?? null;
      return type === 'json' && v != null ? JSON.parse(v) : v;
    },
    async put(k, v) {
      if (faults.put) throw new Error('KV PUT failed: daily write limit exceeded');
      puts++; m.set(k, v);
    }
  };
}
const mockDB = () => ({
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) }),
  async batch() { return []; }
});
// the YouTube API, answering however the test needs it to
function stubFetch(mode) {
  return async (u) => {
    const s = String(u);
    if (mode === 'down') throw new Error('network unreachable');
    if (mode === 'forbidden') return { ok: false, status: 403, text: async () => 'quotaExceeded', json: async () => ({}) };
    if (/search|playlistItems|channels/.test(s)) return { ok: true, status: 200, json: async () => ({ items: [] }) };
    return { ok: true, status: 200, json: async () => ({
      items: [{ id: 'v1', statistics: { viewCount: '120', likeCount: '9', commentCount: '2' } }] }) };
  };
}
const ENV = (MINUTE, DB) => ({ MINUTE, DB, YT_API_KEY: 'k', CHANNEL_ID: 'UC1' });

console.log('\nwhen the dependencies misbehave');

console.log('\n1. a KV read that fails is not an empty database');
{
  /* loadState swallowed the error and returned {} — byte-identical to a first run. The
     tick then WROTE that back, so one transient read failure replaced a real roster with
     whatever that single minute happened to scan, and took s.d1Backfilled with it. D1 is
     the read source, so nothing visible broke; the declared fallback just quietly emptied. */
  const dead = mockKV({ 'minute-v1': GOOD_STATE }, { get: true });
  const s = await W.loadState({ MINUTE: dead });
  check('a failed read is flagged', s.loadFailed === true);
  check('and still returns a usable shape', s && typeof s.videos === 'object');
  check('the flag never reaches the serialised blob',
    !('loadFailed' in JSON.parse(JSON.stringify(s))), JSON.stringify(s).slice(0, 80));

  const ok = await W.loadState({ MINUTE: mockKV({ 'minute-v1': GOOD_STATE }) });
  check('a real read is not flagged', ok.loadFailed === false);
  check('and a genuinely empty store is not flagged either',
    (await W.loadState({ MINUTE: mockKV({}) })).loadFailed === false);
}

console.log('\n2. …so the tick refuses to overwrite what it could not read');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch('ok');
  try {
    const dead = mockKV({ 'minute-v1': GOOD_STATE }, { get: true });
    const r = await W.tick(ENV(dead, mockDB()));
    check('the tick still completes', !r.error, JSON.stringify(r).slice(0, 120));
    check('it does not write', r.wrote === false, JSON.stringify(r));
    check('nothing was put', dead.puts() === 0, dead.puts());
    check('the good state is still in KV', dead.m.get('minute-v1') === GOOD_STATE);
    check('and the tick says why', r.kvLoadFailed === true, JSON.stringify(r));
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n3. a KV write that fails must not take the cold tail with it');
{
  /* The put was the last unwrapped await before coldTick. Its realistic failure is the
     1,000-writes-a-day cap, which arrives once and then holds for the rest of the day — so
     the day KV filled up was also the day the cold tail silently stopped, for a reason
     with nothing to do with it. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch('ok');
  try {
    const full = mockKV({ 'minute-v1': GOOD_STATE }, { put: true });
    const r = await W.tick(ENV(full, mockDB()));
    check('the tick does not throw', !!r && !r.error, JSON.stringify(r).slice(0, 120));
    check('the failure is reported', /write limit/.test(r.kvError || ''), r.kvError);
    check('and not reported as a successful write', r.wrote === false, JSON.stringify(r.wrote));
    check('the cold tail still ran', r.cold && !('error' in r.cold), JSON.stringify(r.cold));
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n4. a YouTube API that is failing says so');
{
  /* Both catch blocks discarded the error. An expired key, a disabled Data API and a quiet
     channel all produced the same `sampled: 0` with no reason — and the TikTok side has
     reported its health all along, so this was YouTube-only blindness. */
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = stubFetch('down');
    const r = await W.tick(ENV(mockKV({ 'minute-v1': GOOD_STATE }), mockDB()));
    check('a total outage is recorded', (r.ytErrors || []).length > 0, JSON.stringify(r.ytErrors));
    check('and names where it happened',
      (r.ytErrors || []).some(e => /^sample:|^scan:/.test(e)), JSON.stringify(r.ytErrors));
    check('sampling still reports zero, as before', r.sampled === 0, r.sampled);

    globalThis.fetch = stubFetch('forbidden');
    const q = await W.tick(ENV(mockKV({ 'minute-v1': GOOD_STATE }), mockDB()));
    check('a quota rejection is recorded too', (q.ytErrors || []).length > 0, JSON.stringify(q.ytErrors));

    globalThis.fetch = stubFetch('ok');
    const good = await W.tick(ENV(mockKV({ 'minute-v1': GOOD_STATE }), mockDB()));
    check('a healthy tick carries no error field', good.ytErrors === undefined, JSON.stringify(good.ytErrors));
    check('and does sample', good.sampled === 1, good.sampled);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n5. Gemini answering with prose does not abandon the fallback chain');
{
  /* attempt() ended in a bare JSON.parse. A model that returns 200 with a ```json fence —
     or with an apology — threw straight out of callGemini, so every model after it in the
     chain went untried and the user got a JSON syntax error instead of ideas. */
  const realFetch = globalThis.fetch;
  const IDEAS = { titles: ['one'], onscreenText: [], tags: [], videoIdeas: [] };
  try {
    const tried = [];
    const reply = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
    globalThis.fetch = async (u) => {
      const m = (String(u).match(/models\/([^:?]+)/) || [])[1] || '';
      if (String(u).includes('pageSize')) return { ok: true, status: 200, json: async () => ({ models: [] }) };
      tried.push(m);
      if (tried.length === 1) return reply('Sure! Here are some ideas:');       // prose
      return reply(JSON.stringify(IDEAS));                                       // the next model behaves
    };
    const KV = mockKV({});
    // the regression this guards is a THROW out of callGemini, so catch rather than let it
    // abort the file — a broken fallback chain should read as a failing check, not a crash
    let out = null, threw = null;
    try { out = await W.callGemini({ GEMINI_KEY: 'k', MINUTE: KV }, 'p'); }
    catch (e) { threw = String((e && e.message) || e); }
    check('a chatty model does not throw out of the chain', threw === null, threw);
    check('the chatty model does not end the run', tried.length > 1, tried.join(','));
    check('and the next model\'s answer comes back', !!out && out.titles && out.titles[0] === 'one', JSON.stringify(out));
    check('the winner is remembered, and it is not the chatty one',
      KV.m.get('ai-model') === tried[1], KV.m.get('ai-model') + ' vs ' + tried[1]);
  } finally { globalThis.fetch = realFetch; }

  // the single most common shape: correct JSON wrapped in a markdown fence
  try {
    globalThis.fetch = async (u) => {
      if (String(u).includes('pageSize')) return { ok: true, status: 200, json: async () => ({ models: [] }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{
        text: '```json\n' + JSON.stringify(IDEAS) + '\n```' }] } }] }) };
    };
    let out = null, threw = null;
    try { out = await W.callGemini({ GEMINI_KEY: 'k', MINUTE: mockKV({}) }, 'p'); }
    catch (e) { threw = String((e && e.message) || e); }
    check('a fenced answer is unwrapped rather than rejected',
      !!out && out.titles && out.titles[0] === 'one', threw || JSON.stringify(out));
  } finally { globalThis.fetch = realFetch; }

  // and when nothing works, the error names the cause instead of a parse position
  try {
    globalThis.fetch = async (u) => {
      if (String(u).includes('pageSize')) return { ok: true, status: 200, json: async () => ({ models: [] }) };
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'nope' }] } }] }) };
    };
    let msg = '';
    try { await W.callGemini({ GEMINI_KEY: 'k', MINUTE: mockKV({}) }, 'p'); }
    catch (e) { msg = String(e.message || e); }
    check('every model refusing JSON is a readable error', /returned text, not JSON/.test(msg), msg);
    check('and not a JSON.parse message', !/Unexpected token/.test(msg), msg);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n6. /run is rate limited');
{
  /* Unauthenticated, and the Worker URL is in the dashboard's public source. Each call
     spends a KV write against a free tier of 1,000 a day, so a few hundred requests — a
     rounding error for a crawler — would stop sampling until midnight UTC. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch('ok');
  const hit = () => W.HANDLER.fetch(new Request('https://w.example/run'),
    ENV(mockKV({ 'minute-v1': GOOD_STATE }), mockDB()));
  try {
    const first = await hit();
    check('the first call runs', first.status === 200, first.status);

    const second = await hit();
    check('an immediate second call is refused', second.status === 429, second.status);
    const b = await second.json();
    check('with a retry time the caller can use', b.retryInSeconds > 0 && b.retryInSeconds <= W.RUN_COOLDOWN / 1000, b.retryInSeconds);
    check('and says the data is being collected anyway', /cron/i.test(b.note || ''), b.note);

    let refused = 0;
    for (let i = 0; i < 50; i++) if ((await hit()).status === 429) refused++;
    check('a burst is refused throughout', refused === 50, refused + '/50');

    // the cooldown is a window, not a one-shot lock
    const other = await W.HANDLER.fetch(new Request('https://w.example/health'),
      ENV(mockKV({ 'minute-v1': GOOD_STATE }), mockDB()));
    check('and it does not affect any other route', other.status !== 429, other.status);
  } finally { globalThis.fetch = realFetch; }
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
