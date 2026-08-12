// Regression guard for the cold tail — the tapering cadence that keeps recording a video
// after its 48-hour launch window closes.
//
// What it exists to protect. The hot loop is the part that cannot be redone: a launch
// minute missed today is gone for good. The cold tail is the opposite — a cold sample
// missed now can be taken again in fifteen minutes. So the tests here are mostly about
// the cold path staying out of the hot path's way, and about the budget arithmetic in the
// header comment being true rather than aspirational.
//
// Run: node worker/cold-tail.test.mjs
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { coldDue, coldTick, HOT_HOURS, D1_KEEP_DAYS, COLD_WARM_DAYS, COLD_WARM_MIN, COLD_COOL_MIN };';
const tmp = HERE + '.worker-cold.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };
const H = 3600e3, D = 864e5;

console.log('\nthe cold tail');

/* 1 — who is due, and when */
console.log('\n1. the cadence');
{
  check('nothing inside the launch window is ever cold-sampled',
    [0, 15, 30, 45].every(m => !W.coldDue(20 * H, m) && !W.coldDue(47.9 * H, m)));
  check('the boundary belongs to the hot loop, not both', !W.coldDue(W.HOT_HOURS * H, 0));

  const warm = 5 * D;
  check('a five-day-old video is due every 15 minutes',
    [0, 15, 30, 45].every(m => W.coldDue(warm, m)));
  check('and not in between', [1, 7, 14, 16, 44].every(m => !W.coldDue(warm, m)));

  const cool = 30 * D;
  check('a thirty-day-old video is due once an hour', W.coldDue(cool, 0));
  check('and not at the quarter hours', [15, 30, 45].every(m => !W.coldDue(cool, m)));

  check('the warm/cool boundary is where the constant says',
    W.coldDue((W.COLD_WARM_DAYS - 0.01) * D, 15) && !W.coldDue((W.COLD_WARM_DAYS + 0.01) * D, 15));
  check('nothing past retention is sampled — the row would only be pruned',
    [0, 15].every(m => !W.coldDue((W.D1_KEEP_DAYS + 1) * D, m)));
  check('right up to retention it still is', W.coldDue((W.D1_KEEP_DAYS - 0.5) * D, 0));
}

/* 2 — the budget claimed in the header comment */
console.log('\n2. the arithmetic the comment promises');
{
  // this account: 2.2 uploads/day on YouTube, measured from its own publish times
  const perDay = 2.2, mins = 1440;
  const hot = perDay * (W.HOT_HOURS / 24) * mins;
  const warm = perDay * (W.COLD_WARM_DAYS - W.HOT_HOURS / 24) * (mins / W.COLD_WARM_MIN);
  const cool = perDay * (W.D1_KEEP_DAYS - W.COLD_WARM_DAYS) * (mins / W.COLD_COOL_MIN);
  const rowWrites = (hot + warm + cool) * 2;              // table + covering index
  check('YouTube hot is about 6,300 samples a day', Math.abs(hot - 6336) < 300, Math.round(hot));
  check('the tail adds a few thousand, not tens of thousands', warm + cool < 8000, Math.round(warm + cool));
  check('the total fits the 100,000/day row-write allowance with room to spare',
    rowWrites < 60000, Math.round(rowWrites) + ' row-writes/day');
  // and the thing that would NOT fit, which is why the cadence tapers at all
  const flat = perDay * W.D1_KEEP_DAYS * mins * 2;
  check('minute-by-minute for the whole retention would not fit', flat > 100000,
    Math.round(flat) + ' row-writes/day');
  check('the taper is at least ten times cheaper than that', flat / rowWrites > 10,
    (flat / rowWrites).toFixed(1) + 'x');
}

/* 3 — coldTick itself */
console.log('\n3. coldTick');
const NOW = Date.now();
function mockD1(vids) {
  let rowsRead = 0;
  const written = [];
  const db = {
    stats: () => ({ rowsRead, written }),
    _all(sql, args) {
      if (/FROM videos WHERE platform/.test(sql)) {
        const [platform, lo, hi] = args;
        const out = vids.filter(v => v.platform === platform && v.published_at >= lo && v.published_at < hi);
        rowsRead += out.length;
        return { results: out.map(v => ({ ...v })) };
      }
      return { results: [] };
    },
    async batch(list) { for (const st of list) written.push(st.args); return []; }
  };
  db.prepare = sql => ({ sql, bind: (...args) => ({ sql, args, all: async () => db._all(sql, args), run: async () => ({ meta: { changes: 0 } }) }) });
  return db;
}
// stand in for the YouTube API, and count the calls so the quota claim is checked
function stubApi(calls) {
  return async (ep, params) => {
    calls.push(ep);
    const ids = String(params.id || '').split(',').filter(Boolean);
    return { items: ids.map(id => ({ id, statistics: { viewCount: '100', likeCount: '10', commentCount: '1' } })) };
  };
}

{
  // a realistic 60-day roster: 2.2 a day
  const vids = [];
  for (let i = 0; i < 132; i++) vids.push({ platform: 'yt', video_id: 'v' + i, published_at: NOW - (i / 2.2) * D, title: '', channel: 'UC1' });
  // plus one still hot, and one past retention — neither should be touched
  vids.push({ platform: 'yt', video_id: 'hot', published_at: NOW - 10 * H, title: '', channel: 'UC1' });
  vids.push({ platform: 'yt', video_id: 'ancient', published_at: NOW - 70 * D, title: '', channel: 'UC1' });

  const DB = mockD1(vids);
  const realFetch = globalThis.fetch, realNow = Date.now;
  const onTheHour = new Date(NOW); onTheHour.setUTCMinutes(0, 0, 0);
  Date.now = () => onTheHour.getTime();
  const calls = [];
  // coldTick calls the module-level api(); intercept at fetch so the real code path runs
  globalThis.fetch = async (u) => {
    calls.push(String(u));
    const ids = new URL(String(u)).searchParams.get('id').split(',');
    return { ok: true, status: 200, json: async () => ({ items: ids.map(id => ({ id, statistics: { viewCount: '100', likeCount: '10', commentCount: '1' } })) }) };
  };
  try {
    // on the hour: everything cold is due
    const onHour = await W.coldTick({ DB }, 'KEY', onTheHour.getTime());
    check('on the hour the whole cold roster is due', onHour.due > 100, onHour.due);
    check('and it never includes a hot video',
      !calls.some(u => u.includes('hot')), 'hot was sampled');
    check('nor one past retention', !calls.some(u => u.includes('ancient')));
    check('it batches fifty at a time', calls.length === Math.ceil(onHour.due / 50), calls.length + ' calls for ' + onHour.due);
    check('reading the roster is cheap', DB.stats().rowsRead < 200, DB.stats().rowsRead + ' rows');
    check('and it wrote a sample for each', onHour.wrote === onHour.due, onHour.wrote + '/' + onHour.due);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
}

{
  // off the cadence entirely: not a single query
  const DB = mockD1([{ platform: 'yt', video_id: 'v', published_at: NOW - 5 * D, title: '', channel: 'UC1' }]);
  const off = new Date(NOW); off.setUTCMinutes(7);
  const orig = Date.now;
  Date.now = () => off.getTime();
  try {
    const r = await W.coldTick({ DB }, 'KEY', off.getTime());
    check('at minute 7 nothing runs at all', r.due === 0 && DB.stats().rowsRead === 0, JSON.stringify(r));
  } finally { Date.now = orig; }
}

{
  check('with no D1 binding it declines rather than throwing',
    (await W.coldTick({}, 'KEY', NOW)).skipped === 'no D1');
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
