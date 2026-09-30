// The follower sampler's midnight snapshot.
//
// The TikTok page's "Today so far" measures followers and likes from the snapshot that
// marks the start of the owner's day. The sampler used to write one every ~3 hours and
// nothing else, so "the start of today" was whichever check happened to fall nearest
// midnight — often hours away. It now also takes one on the first tick after LOCAL
// midnight in Australia/Melbourne, found by comparing calendar days (Intl), never by
// adding 24 hours — so the 23-hour day when daylight saving starts (Sun 4 Oct 2026) and
// the 25-hour day when it ends land on the right midnight too.
//
// Run: node worker/tt-midnight.test.mjs
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { ttTick, ttLocalDay, ttFollowerDue, TT_TZ };';
const tmp = HERE + '.worker-midnight.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const H = 3600e3, MIN = 60e3;
// a Melbourne wall-clock time as a UTC instant, via the offset Intl reports for it
const mel = (y, mo, d, h, mi) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  for (const off of [10, 11]) {
    const t = guess - off * H;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
    if (+p.day === d && +p.hour === h && +p.minute === mi) return t;
  }
  throw new Error('no such local time');
};

console.log('\nthe calendar day is Melbourne\'s');
{
  check('the zone is named once', W.TT_TZ === 'Australia/Melbourne');
  check('11:55 pm and 12:05 am are different days', W.ttLocalDay(mel(2026, 9, 29, 23, 55)) !== W.ttLocalDay(mel(2026, 9, 30, 0, 5)));
  check('and the day is the local one, not UTC\'s (12:05 am in Melbourne is still the day before in UTC)',
    W.ttLocalDay(mel(2026, 9, 30, 0, 5)) === '2026-09-30' && new Date(mel(2026, 9, 30, 0, 5)).toISOString().slice(0, 10) === '2026-09-29');
  const sun = mel(2026, 10, 4, 0, 0), mon = mel(2026, 10, 5, 0, 0);
  check('Sun 4 Oct 2026 is a 23-hour day (clocks go forward at 2 am)', (mon - sun) / H === 23, (mon - sun) / H);
  check('its midnight and the next are told apart', W.ttLocalDay(mon - MIN) === '2026-10-04' && W.ttLocalDay(mon + 5 * MIN) === '2026-10-05');
  const aprS = mel(2027, 4, 4, 0, 0), aprM = mel(2027, 4, 5, 0, 0);
  check('Sun 4 Apr 2027 is a 25-hour day, and its end is still found', (aprM - aprS) / H === 25 && W.ttLocalDay(aprM + 3 * MIN) === '2027-04-05');
}

console.log('\nwhen a snapshot is due');
{
  const due = W.ttFollowerDue;
  const at = (h, mi, d = 30) => mel(2026, 9, d, h, mi);
  check('no history yet: take one', due(at(10, 0), 0));
  check('the ~3h cadence is unchanged', due(at(13, 1), at(10, 0)) && !due(at(12, 59), at(10, 0)));
  check('the first tick after midnight takes one, even 1h 25m after the last', due(at(0, 5), at(22, 40, 29)));
  check('the next tick does not take another', !due(at(0, 10), at(0, 5)));
  check('a tick just before midnight does not', !due(at(23, 55, 29), at(22, 40, 29)));
  check('the DST day: 12:05 am Sun 4 Oct is a new day', due(mel(2026, 10, 4, 0, 5), mel(2026, 10, 3, 22, 0)));
  check('and so is 12:05 am the day after it, 23 hours later', due(mel(2026, 10, 5, 0, 5), mel(2026, 10, 4, 22, 30)));
  check('3 am on the DST day is the same day as 1:59 am (no false midnight at the jump)',
    !due(mel(2026, 10, 4, 3, 0), mel(2026, 10, 4, 1, 50)));
}

console.log('\nthe sampler itself');
{
  const store = (fh) => {
    const m = new Map([['tt:accounts', JSON.stringify(['A'])],
      ['tt:tok:A', JSON.stringify({ access_token: 'x', expires_at: Date.now() + 9e9, refresh_token: 'r' })]]);
    if (fh) m.set('tt:followers:A', JSON.stringify(fh));
    return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, v); } };
  };
  const mockDB = () => ({
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }) }),
    async batch() { return []; }
  });
  const realFetch = globalThis.fetch, realNow = Date.now;
  let userCalls = 0;
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (/oauth\/token/.test(s)) return { ok: true, status: 200, json: async () => ({ access_token: 'x', expires_in: 8000 }) };
    if (/user\/info/.test(s)) { userCalls++; return { ok: true, status: 200, json: async () => ({ data: { user: { follower_count: 4870, likes_count: 55031, video_count: 30 } } }) }; }
    return { ok: true, status: 200, json: async () => ({ data: { videos: [], has_more: false } }) };
  };
  const TT = { TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' };
  const run = async (t, fh) => {
    Date.now = () => t;
    const kv = store(fh);
    userCalls = 0;
    await W.ttTick({ ...TT, MINUTE: kv, DB: mockDB() });
    return { fh: JSON.parse(kv.m.get('tt:followers:A') || '[]'), calls: userCalls };
  };
  try {
    // 12:05 am on the scan boundary; the last check was at 10:40 pm
    const t = mel(2026, 9, 30, 0, 5);
    const prev = [[mel(2026, 9, 29, 22, 40), 4862, 54950, 30]];
    const a = await run(t, prev);
    check('the first scan tick after midnight writes a snapshot', a.fh.length === 2 && a.fh[1][0] === t, JSON.stringify(a.fh));
    check('with the profile\'s counts in the usual columns', JSON.stringify(a.fh[1]) === JSON.stringify([t, 4870, 55031, 30]), JSON.stringify(a.fh[1]));
    const b = await run(mel(2026, 9, 30, 0, 10), a.fh);
    check('five minutes later it does not write another', b.fh.length === 2 && b.calls === 0, JSON.stringify(b.fh));
    const c = await run(mel(2026, 9, 29, 23, 55), prev);
    check('11:55 pm, 1h 15m after the last check, writes nothing', c.fh.length === 1 && c.calls === 0);
    const d = await run(mel(2026, 10, 4, 0, 5), [[mel(2026, 10, 3, 22, 40), 4900, 56000, 31]]);
    check('the DST morning gets its midnight snapshot too', d.fh.length === 2);
    const e = await run(mel(2026, 9, 30, 13, 45), [[mel(2026, 9, 30, 10, 40), 4870, 55031, 30]]);
    check('the daytime cadence is still ~3h', e.fh.length === 2);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
