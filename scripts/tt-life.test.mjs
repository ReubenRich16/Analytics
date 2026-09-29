/* The hourly life record in the TikTok per-post drawer and latest card.
   node scripts/tt-life.test.mjs

   Exists because of a bug report that the full breakdown "doesn't show the graphs or
   lifetime results", which reproduced two ways:

     · ttdRepaint's guard was inverted. Every poll rebuilt the drawer body — wiping the
       drawn life chart — and then refetched only if the chart had NOT been drawn. So the
       chart appeared on open, vanished on the first repaint (a poll, or late history
       landing, whichever came first), and never returned.

     · every failure was silent. A post the Worker never recorded, a thin recording, and
       an unreachable Worker all left the section hidden — indistinguishable from the
       feature not existing, while the minute-chart note above promised an hourly record
       "below".

   The rework: lifeCache (paint synchronously on repaint, fetch only when something could
   have changed), honest per-cause notes, and a lifetime-results strip computed from the
   recording. These tests lift that code straight out of the page. */
import fs from 'fs';
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

/* ---------- lift the module out of the page ---------- */
const i0 = TT.indexOf('  let lifeSeq = 0;');
const i1 = TT.indexOf('  /* ---------- the per-post drawer');
const SRC = TT.slice(i0, i1);
check('the life module is where the extraction expects', i0 > 0 && i1 > i0);

const H = 3600e3, D = 864e5;
const fmtUS = new Intl.NumberFormat('en-US');
const fmtAge = m => (m >= 1440 ? Math.round(m / 1440) + 'd' : Math.round(m / 60) + 'h');
const mcell = (l, v, s) => '<cell>' + l + '=' + v + (s ? ' (' + s + ')' : '') + '</cell>';
const lineChart = () => '<svg class="chart"></svg>';
const esc = s => String(s);

const build = api => new Function('api', 'session', 'workerUrl', 'fmt', 'fmtAge', 'lineChart', 'mcell', 'esc',
  SRC + '\nreturn { lifeStripHtml, paintLife, loadLife, lifeCache, LIFE_FRESH, LIFE_RETRY };')(
  api, 'sess', 'https://w.test', fmtUS, fmtAge, lineChart, mcell, esc);

// a fake host: the section wrap with its explain and chart children
const host = () => {
  const el = () => ({ innerHTML: '' });
  const wrap = { isConnected: true, dataset: {}, style: { display: 'none' }, ex: el(), ch: el() };
  wrap.querySelector = s => s.includes('explain') ? wrap.ex : s.includes('chart') ? wrap.ch : null;
  return { wrap, scope: { querySelector: () => wrap } };
};

// an hourly recording from age `fromH` hours to `toH` hours, S-ish growth to `total`
const rec = (total, fromH, toH, create) => {
  const s = [];
  for (let h = fromH; h <= toH; h++) s.push([h * H, Math.round(total * Math.min(1, 0.05 + 0.95 * Math.pow(h / toH, 0.3)))]);
  return { found: true, id: 'x', step: H, title: '', create_time: create || 1700000000, s };
};

console.log('\nthe lifetime-results strip');
{
  const M = build(async () => ({}));
  const full = M.lifeStripHtml(rec(12000, 0, 40 * 24));
  check('a full recording answers the first hour, day and week',
    /First hour=/.test(full) && /First day=/.test(full) && /First week=/.test(full), full.slice(0, 200));
  check('and says how long it recorded, counting hourly points (not "readings")',
    /Recorded=40d \(\d+ hourly points\)/.test(full), full);
  check('a crossing observed inside the recording gets a time-to-1,000',
    /To 1,000 views=≤ /.test(full), full);

  // a recording that started at day 3 — the account was connected late
  const late = M.lifeStripHtml(rec(12000, 3 * 24, 40 * 24));
  check('a late-started recording abstains from the first hour and day',
    !/First hour=/.test(late) && !/First day=/.test(late), late);
  check('but still answers the week it did see', /First week=/.test(late), late);
  check('and does not invent a time-to-1,000 it never observed', !/To 1,000/.test(late), late);

  // a recording still in its first hours
  const young = M.lifeStripHtml(rec(400, 0, 5));
  check('a young recording answers only the marks it has reached',
    /First hour=/.test(young) && !/First day=/.test(young) && /Recorded=6h/.test(young), young);
}

console.log('\npaintLife — every outcome is visible');
{
  const M = build(async () => ({}));
  const ok = host();
  M.paintLife(ok.wrap, { d: rec(5000, 0, 48), at: Date.now() });
  check('success paints the strip and the chart', /<cell>/.test(ok.wrap.ch.innerHTML) && /<svg/.test(ok.wrap.ch.innerHTML));
  check('and the explain says what the recording is', /Recorded by your own Worker/.test(ok.wrap.ex.innerHTML));
  check('and the section is shown', ok.wrap.style.display === 'block');

  const nf = host();
  M.paintLife(nf.wrap, { why: 'notfound', at: Date.now() });
  check('a post the Worker never recorded says so instead of hiding',
    /No recording of this post yet/.test(nf.wrap.ex.innerHTML) && /within about five minutes/.test(nf.wrap.ex.innerHTML) &&
    /60 days old or drops out of your 60 newest/.test(nf.wrap.ex.innerHTML) && nf.wrap.style.display === 'block');
  check('and draws no chart', nf.wrap.ch.innerHTML === '');

  const th = host();
  M.paintLife(th.wrap, { why: 'thin', n: 2, at: Date.now() });
  check('a thin recording says it is still growing', /Less than 3 hours recorded so far — it adds a point each hour\./.test(th.wrap.ex.innerHTML), th.wrap.ex.innerHTML);
  const tho = host();
  M.paintLife(tho.wrap, { why: 'thin', n: 1, old: true, at: Date.now() });
  check('but a post past 60 days is not promised another point', /Only 1 hourly point recorded/.test(tho.wrap.ex.innerHTML) &&
    !/each hour/.test(tho.wrap.ex.innerHTML), tho.wrap.ex.innerHTML);

  const un = host();
  M.paintLife(un.wrap, { why: 'unreachable', detail: 'HTTP 502', at: Date.now() });
  check('an unreachable Worker names the error and promises the retry',
    /Couldn’t reach your Worker/.test(un.wrap.ex.innerHTML) && /HTTP 502/.test(un.wrap.ex.innerHTML) && /retries/.test(un.wrap.ex.innerHTML));
}

console.log('\nloadLife — the cache does the work');
{
  let calls = 0;
  const M = build(async () => { calls++; return rec(5000, 0, 48); });
  const h1 = host();
  await M.loadLife('a', h1.scope);
  check('the first ask fetches and draws', calls === 1 && /<svg/.test(h1.wrap.ch.innerHTML));
  const h2 = host();
  await M.loadLife('a', h2.scope);
  check('a repaint inside the fresh window paints from cache without fetching',
    calls === 1 && /<svg/.test(h2.wrap.ch.innerHTML), calls + ' calls');

  // stale beats gone: a later failure keeps the recording already fetched
  let failNow = false;
  const M2 = build(async () => { if (failNow) throw new Error('HTTP 502'); return rec(5000, 0, 48); });
  const g1 = host();
  await M2.loadLife('a', g1.scope);
  M2.lifeCache.a.at = 0;                              // age the cache past LIFE_FRESH
  failNow = true;
  const g2 = host();
  await M2.loadLife('a', g2.scope);
  check('a failure after a success keeps showing the recording it has',
    !!M2.lifeCache.a.d && /<svg/.test(g2.wrap.ch.innerHTML));

  const M3 = build(async () => ({ found: false }));
  const n1 = host();
  await M3.loadLife('a', n1.scope);
  check('found:false is classified and painted as notfound',
    M3.lifeCache.a.why === 'notfound' && /No recording/.test(n1.wrap.ex.innerHTML));

  const M4 = build(async () => { throw new Error('boom'); });
  const e1 = host();
  await M4.loadLife('a', e1.scope);
  check('a failure with nothing cached is painted as unreachable',
    M4.lifeCache.a.why === 'unreachable' && /boom/.test(M4.lifeCache.a.detail));

  const M5 = build(async () => rec(5000, 0, 48));
  check('a recording refreshes more patiently than a failure retries', M5.LIFE_FRESH > M5.LIFE_RETRY);
}

console.log('\nhourly points sit at the end of their hour, and say what they are');
{
  // the tips need the lineChart opts, so capture them
  let opts = null;
  const M = new Function('api', 'session', 'workerUrl', 'fmt', 'fmtAge', 'lineChart', 'mcell', 'esc',
    SRC + '\nreturn { lifeStripHtml, paintLife, lifeCache, lifeAt48 };')(
    async () => ({}), 'sess', 'https://w.test', fmtUS, m => {
      m = Math.round(m); return m < 60 ? m + ' min' : m < 2880 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : Math.floor(m / 1440) + 'd ' + Math.floor((m % 1440) / 60) + 'h';
    }, (pts, c, l, o) => { opts = o; return '<svg class="chart"></svg>'; }, mcell, esc);
  const ct = 1700000000;
  // an older Worker: hour STARTS, a two-hour hole after 2h, and a revision at the end
  const old = { found: true, step: H, create_time: ct, s: [[0, 359], [H, 500], [2 * H, 600], [5 * H, 900], [6 * H, 880]] };
  const h1 = host();
  M.paintLife(h1.wrap, { d: old, at: Date.now() });
  check('the first hour reads "by 1h old", not "0 min old"', /^359 views by 1h old · \+359 that hour$/.test(opts.tips[0]), opts.tips[0]);
  check('a rise across a hole says how many hours it covers', /\+300 over 3 hours/.test(opts.tips[3]), opts.tips[3]);
  check('a fall is named as a revision, not a negative gain', /count revised down by 20/.test(opts.tips[4]) && !/\+-/.test(opts.tips[4]), opts.tips[4]);
  check('the explain runs from posting to the last point\'s real age', /from posting to <b>7h old<\/b>/.test(h1.wrap.ex.innerHTML), h1.wrap.ex.innerHTML);
  check('the axis starts at the first point, not at a "posted" it does not show', opts.x0 === '1h old', opts.x0);

  // a current Worker: real ages of each hour's last reading, starting at day 20
  const late = { found: true, step: H, age: 'reading', create_time: ct, s: [] };
  for (let h = 20 * 24; h <= 60 * 24; h++) late.s.push([h * H + 59 * 60e3, 5000 + h]);
  const h2 = host();
  M.paintLife(h2.wrap, { d: late, at: Date.now() });
  check('a late-started recording says where it starts, not "from posting"',
    /from <b>20d old<\/b> to <b>60d old<\/b> — your Worker keeps each reading for 60 days/.test(h2.wrap.ex.innerHTML), h2.wrap.ex.innerHTML);
  check('and its Recorded cell is the span it covers', /Recorded=40d \(961 hourly points\)/.test(h2.wrap.ch.innerHTML), h2.wrap.ch.innerHTML);
  check('with no first hour or day it never saw', !/First hour=|First day=/.test(h2.wrap.ch.innerHTML));

  // a hole right at a mark: the cell abstains rather than carrying an earlier count across
  const holed = { found: true, step: H, create_time: ct, s: [[0, 10], [20 * H, 400], [30 * H, 600]] };
  check('a First day cell needs the hour that ends at 24h', !/First day=/.test(M.lifeStripHtml(holed)), M.lifeStripHtml(holed));

  // the 48-hour figure for the projection block: hour 47 or nothing
  M.lifeCache.a = { d: { step: H, s: [[46 * H, 900], [47 * H, 950], [48 * H, 990]] }, at: Date.now() };
  M.lifeCache.b = { d: { step: H, age: 'reading', s: [[46 * H + 59 * 60e3, 900], [47 * H + 59 * 60e3, 955]] }, at: Date.now() };
  M.lifeCache.c = { d: { step: H, s: [[40 * H, 900], [50 * H, 990]] }, at: Date.now() };
  check('the hourly record gives the count at the end of hour 48', M.lifeAt48('a') === 950 && M.lifeAt48('b') === 955,
    M.lifeAt48('a') + ' / ' + M.lifeAt48('b'));
  check('and nothing when that hour was not recorded', M.lifeAt48('c') === null && M.lifeAt48('zz') === null);
}

console.log('\nthe drawer wiring that let the chart vanish');
{
  const i = TT.indexOf('function ttdRepaint(');
  const body = TT.slice(i, TT.indexOf('\n  }\n', i));
  check('ttdRepaint always follows its rebuild with loadLife', /loadLife\(ttdId/.test(body));
  check('the inverted svg.chart guard is gone', !/svg\.chart/.test(body) && !/const had/.test(body));
  check('both hosts carry a life section', (TT.match(/data-life="section"/g) || []).length >= 2);
  check('the drawer opens with a life fetch', /loadLife\(id, \$\('ttdBody'\)\)/.test(TT));
  check('a fresh hourly record redraws the projection block', /if \(lifeHook\) lifeHook\(id\);/.test(TT) &&
    /lifeHook = id => \{/.test(TT) && /pjBodyHtml\(p, v\.view_count \|\| 0, curve, refs, age, lifeAt48\(v\.id\)\)/.test(TT));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
