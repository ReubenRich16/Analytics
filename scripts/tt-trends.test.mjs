// Trends — the TikTok page's recorded-trends card (Account room), run against the page's
// own code.
//
// The card was redesigned phone-first and nothing it showed was allowed to go:
//
//   · the last 7 days against the 7 before are two big tiles — the same calendar weeks and
//     the same figures as the old Last 7 / Prior 7 pulse tiles — with the comparison sentence,
//     and, when one post brought in more than half of a week, that post named with its exact
//     share (the week's own hours, split by post, so the parts add up to the tile);
//   · views each day are bars, one per calendar day from the first day this device can speak
//     for to yesterday: a recorded day is a rect (motion.js grows it), a day it can't vouch for
//     is left empty and says "no data", the tallest day carries its exact figure and the newest
//     its own, and every slot has a tip;
//   · "When people watch" keeps the 24 hour bars and their caveat, with the busiest and
//     quietest three hours in a row on top, from those very bars;
//   · "Today so far" is the Now room's own figure, from the same recDayGains call;
//   · the follower history (30 / 90 / All) and the follower tile stay.
//
// Melbourne time throughout, set before anything reads a clock.
//
// Run: node scripts/tt-trends.test.mjs
process.env.TZ = 'Australia/Melbourne';
import fs from 'fs';
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const cut = (start, end) => {
  const i = TT.indexOf(start);
  if (i < 0) throw new Error('not found: ' + start);
  const j = TT.indexOf(end, i);
  if (j < 0) throw new Error('not found after ' + start + ': ' + end);
  return TT.slice(i, j);
};
const fnOf = name => cut('  function ' + name + '(', '\n  }\n') + '\n  }\n';
const arrow = start => cut(start, '\n  };\n') + '\n  };\n';
const line = start => cut(start, '\n') + '\n';
const H = 3600e3, D = 864e5, MIN = 60e3;
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();   // Melbourne wall clock
const f0 = new Intl.NumberFormat('en-AU');

// the page's code: the Trends block and the Today block, and everything they lean on
const TRENDS = cut('  const recDayLabel = ', '  /* ---------- Today so far ----------');
const TODAY = cut('  /* ---------- Today so far ----------', '  /* ---------- hashtags, with the account');
const SRC = `
  const RealDate = globalThis.Date;
  class Date extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
  const fmt = new Intl.NumberFormat('en-AU');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PJ_MIN_AGE = 300, PJ_HORIZON = 2880;
  const scoreOf = v => (scores && scores[v.id] != null) ? scores[v.id] : null;
  const ttdOpen = () => {};
  const els = {};
  const $ = id => els[id] || (els[id] = { id, style: {}, dataset: {}, innerHTML: '', addEventListener() {} });
  ${line('  const capOf = ')}
  ${arrow('  const clip = (s, n) =>')}
  ${arrow('  const shortCap = ')}
  ${line('  const TAG_RE = ')}
  ${arrow('  const noTags = s =>')}
  ${arrow('  const feedCap = ')}
  ${line('  const ageDays = ')}${line('  const paceOf = ')}${line('  const engOf = ')}
  ${arrow('  const typicalLikeRate = ')}
  ${arrow('  const fmtAgo = ts =>')}
  ${arrow('  const newestTs = h =>')}
  ${line('  const mcell = ')}
  ${line('  const chartReg = ')}${line('  let chartCi = ')}${line('  const chartPush = ')}
  ${fnOf('niceScale')}${fnOf('axisNum')}${fnOf('lineChart')}
  ${line('  const foldOpen = ')}${line('  const foldAttr = ')}
  ${line('  const pjMed = ')}${line('  const pjDur = ')}
  ${arrow('  const pjRank = (pool, v) =>')}
  ${line('  const fseries = () =>')}${line('  const fAtOrBefore = ')}${line('  const ATB = ')}
  ${fnOf('dayBuckets')}${fnOf('nextMilestone')}
  ${line('  const milestonePct = ')}
  ${arrow('  const liveFollowers = fh =>')}
  ${fnOf('projectMilestone')}
  ${line('  const ALERT_DAYS = ')}
  ${line('  const TT_GAP = ')}
  ${fnOf('ttGainBuckets')}${fnOf('recDayGains')}
  ${line('  let recTrendsRange = ')}
  ${TRENDS}
  ${fnOf('ttGradeOf')}
  ${TODAY}
  return { renderRecTrends, renderToday, ttTodayModel, recDayGains, recHourBlocks, recHourBlocksHtml, recBlock, recWeekTop,
           recCarryTxt, recDayBarsHtml, chartReg, foldOpen, els };`;
const load = (NOW, hist, videos, me, scores) =>
  new Function('NOW', 'hist', 'videos', 'me', 'scores', SRC)(NOW, hist, videos, me, scores || {});

/* A store the way the Worker fills it: each post read every 15 minutes (well inside the
   75-minute hole rule), gaining `rate(id, dayKey)` views per reading. A reading carries the
   views of the quarter hour BEFORE it, so its rate is that of the day holding (t − 1 ms) —
   the page's own filing rule. `skip(t)` leaves readings out, which makes a hole. */
const dayKey = t => new Date(t).toLocaleDateString('en-CA');
function store(NOW, ids, rate, skip) {
  const videos = {};
  for (const id of ids) {
    const s = []; let v = 1000, pending = 0;
    const t0 = Math.floor((NOW - 18 * D) / (15 * MIN)) * 15 * MIN;
    for (let t = t0; t <= NOW; t += 15 * MIN) {
      pending += rate(id, dayKey(t - 1), t);
      if (skip && skip(t)) continue;
      v += pending; pending = 0;
      s.push([t, v, 0, 0, 0]);
    }
    videos[id] = { create_time: Math.floor((NOW - 40 * D) / 1000), title: TITLES[id] || id, s };
  }
  return videos;
}
const TITLES = { a: 'Rain on a tin roof for sleep #sleep #rain', b: 'Brushing the mic, no talking #asmr #tingles #nottalking' };
const followerLog = NOW => { const out = []; for (let t = NOW - 30 * D; t <= NOW; t += 3 * H) out.push([t, 4000 + Math.round((t - NOW + 30 * D) / D * 8), 50000, 30]); return out; };
const post = (NOW, id) => ({ id, title: TITLES[id] || id, create_time: Math.floor((NOW - 40 * D) / 1000), view_count: 90000, like_count: 7000 });
const mk = (NOW, { ids = ['a'], rate = () => 10, skip } = {}) => {
  const hist = { videos: store(NOW, ids, rate, skip), followers: followerLog(NOW) };
  return load(NOW, hist, ids.map(id => post(NOW, id)), { follower_count: 4000 + 240, likes_count: 50000 });
};
// nbsp survives: '6–9\u00a0am' is how the page keeps a time on one line
const text = h => h.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/[ \t\n\r]+/g, ' ').trim();
const dk = (NOW, n) => { const d = new Date(NOW); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };
const render = P => { P.renderRecTrends(); return P.els.recTrendsContent.innerHTML; };

const NOW = at(2026, 9, 30, 20, 0);   // Wed 30 Sep, 8 pm: every day of both weeks is whole
const inPrev = k => k >= dk(NOW, 14) && k <= dk(NOW, 8), inLast = k => k >= dk(NOW, 7) && k <= dk(NOW, 1);

console.log('\nthe two weeks: big tiles, the same figures, the same calendar weeks');
{
  const P = mk(NOW, { rate: (id, k) => inLast(k) ? 12 : 10 });
  const h = render(P), t = text(h);
  const tiles = [...h.matchAll(/<div class="tile"><div class="v[^"]*">([^<]*)<\/div><div class="k">([^<]*)<\/div><div class="c">([^<]*)<\/div><div class="c">([^<]*)<\/div><\/div>/g)];
  check('two tiles, as the motion layer counts them (.tile .v)', tiles.length === 2 && /class="today-tiles tr-tiles"/.test(h), tiles.length);
  check('the last 7 days: every reading of 23–29 Sept, 7 × 96 × 12', tiles[0][1] === '+' + f0.format(7 * 96 * 12) && tiles[0][2] === 'views, last 7 days' &&
    tiles[0][3] === '23–29 Sept' && tiles[0][4] === 'all 7 days recorded', tiles[0].slice(1).join(' | '));
  check('the 7 before: 16–22 Sept, 7 × 96 × 10', tiles[1][1] === '+' + f0.format(7 * 96 * 10) && tiles[1][2] === 'views, the 7 before' &&
    tiles[1][3] === '16–22 Sept' && tiles[1][4] === 'all 7 days recorded', tiles[1].slice(1).join(' | '));
  check('the comparison sentence is the old one, word for word', /Your last 7 days gained 20% more views than the 7 before\./.test(t), t);
  check('with no post carrying either week, nothing is said about one', !/came from/.test(t), t);
  check('the section is named for what it compares', /Last 7 days vs the 7 before/.test(t));
  // a week across a month end says both months
  const P2 = mk(at(2026, 10, 3, 20));
  const t2 = text(render(P2));
  check('a week across a month end names both months', /26 Sept – 2 Oct/.test(t2) && /19–25 Sept/.test(t2), t2.slice(0, 200));
  // a short week says how many days it rests on, and is compared per recorded day
  const Q = mk(NOW, { skip: t => t > at(2026, 9, 26, 3) && t < at(2026, 9, 26, 5) });
  const tq = text(render(Q));
  check('a week with a hole says how many days it rests on', /\+5,760 views, last 7 days 23–29 Sept 6 of 7 days recorded/.test(tq), tq.slice(0, 300));
  check('and the sentence compares per recorded day, and says so',
    /Per recorded day \(6 of the last 7, 7 of the 7 before\), your last 7 days gained about the same views as the 7 before\./.test(tq), tq);
}

console.log('\none post carrying a week is named, exactly');
{
  // b gains 40 a reading through the 7 before only; a gains 10 a reading every day
  const P = mk(NOW, { ids: ['a', 'b'], rate: (id, k) => id === 'a' ? 10 : inPrev(k) ? 40 : 0 });
  const h = render(P), t = text(h);
  const prev = 7 * 96 * 50, bShare = 7 * 96 * 40;
  check('the 7 before is both posts: 7 × 96 × 50', /\+33,600 views, the 7 before/.test(t), t.slice(0, 300));
  check('and the post that brought in most of it is named, without its hashtags, with its exact share',
    t.includes('Most of the views in the 7 days before came from “Brushing the mic, no talking”: ' + f0.format(bShare) + ' of ' + f0.format(prev) + '.'), t);
  check('the share’s total is the tile’s own figure', t.includes('+' + f0.format(prev) + ' views, the 7 before') && t.includes('of ' + f0.format(prev) + '.'));
  check('the last 7 days, all from one post, say “all”', t.includes('All of the views in your last 7 days came from “Rain on a tin roof for sleep”.'), t);
  // the split is exact: the week's hours by post add up to the tile
  const day = P.recDayGains(16), keys = [...day.keys()].filter(inPrev);
  const top = P.recWeekTop(day, keys);
  check('recWeekTop’s total is exactly the sum of the week’s days', top && top.total === keys.reduce((a, k) => a + day.get(k), 0) && top.v === bShare, JSON.stringify(top));
  // exactly half is not "most"
  const E = mk(NOW, { ids: ['a', 'b'], rate: (id, k) => id === 'a' ? 10 : inPrev(k) ? 10 : 0 });
  const te = text(render(E));
  check('exactly half is not “most”', !/Most of the views in the 7 days before/.test(te), te);
  // one post over half of both weeks: said once
  const B = mk(NOW, { ids: ['a', 'b'], rate: id => id === 'a' ? 10 : 30 });
  const tb = text(render(B));
  check('the same post carrying both weeks is said once, with both shares',
    tb.includes('Most of the views in both weeks came from “Brushing the mic, no talking”: 20,160 of 26,880 in the last 7 days, and 20,160 of 26,880 in the 7 before.'), tb);
  // a post with no caption at all is still named for what it is, never as empty quotes
  const two = store(NOW, ['x', 'a'], id => id === 'x' ? 30 : 10);
  two.x.title = '';
  const bare = load(NOW, { videos: two, followers: followerLog(NOW) }, [], null);
  check('a post with no caption is “a post with no caption”, never empty quotes',
    /Most of the views in both weeks came from a post with no caption: 20,160 of 26,880 in the last 7 days/.test(text(render(bare))), text(render(bare)));
  // with one post recorded, every view is that post's: saying so says nothing
  check('with a single post recorded, no post is named', !/came from/.test(text(render(mk(NOW))))) ;
}

console.log('\nviews each day: bars, gaps left as gaps, the peak labelled');
{
  const peakDay = dk(NOW, 10);
  const P = mk(NOW, { rate: (id, k) => k === peakDay ? 50 : 10 });
  const h = render(P);
  const svg = (h.match(/<svg class="chart" data-ci="(\d+)"[^>]*aria-label="Views each day[\s\S]*?<\/svg>/) || [''])[0];
  const ci = +(svg.match(/data-ci="(\d+)"/) || [])[1];
  const reg = P.chartReg.get(ci);
  const rects = [...svg.matchAll(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="([^"]+)" rx="3"/g)];
  check('one rect per recorded day, 14 days, inside svg.chart', !!svg && rects.length === 14, rects.length);
  check('no line and no path draws the days', !/<path/.test(svg));
  check('the tooltip engine gets one tip per slot, on its bar arithmetic', reg && reg.bars === true && reg.tips.length === 14 && reg.slot > 0, reg && reg.tips.length);
  const long = k => new Date(k + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  check('each tip is that day and its exact views', reg.tips[0] === long(dk(NOW, 14)) + ': +960 views' && reg.tips[4] === long(peakDay) + ': +4,800 views', reg.tips.slice(0, 5).join(' / '));
  check('the tips of the last seven add up to the last-7-days tile', reg.tips.slice(7).reduce((a, s) => a + +s.split('+')[1].replace(/\D/g, ''), 0) === 7 * 960);
  check('the first and last day are labelled', />16 Sept<\/text>/.test(svg) && />29 Sept<\/text>/.test(svg));
  check('the tallest day carries its exact figure', /<text class="val" [^>]*>4,800<\/text>/.test(svg), svg.match(/<text class="val[^>]*>[^<]*<\/text>/g));
  check('and the newest day its own, as a line’s endpoint would', /<text class="val dim" [^>]*text-anchor="end">960<\/text>/.test(svg));
  check('a dashed line splits the two weeks, named on both sides', /class="refline"/.test(svg) && />the 7 before<\/text>/.test(svg) && />last 7 days<\/text>/.test(svg));
  check('the chart counts whole views on its axis', /niceScale\(0, Math\.max\(1, max\), 4, true\)/.test(TRENDS));
  check('it says whose views it counts', /On your posts, one bar for each full day\. Tap a bar to see that day\./.test(text(h)), text(h).slice(0, 400));
  check('its aria-label names the span and the most', /aria-label="Views each day, 16 Sept to 29 Sept; the most was 4,800 on /.test(svg));

  // a hole in one day: that day is empty, says "no data", and its tip says why
  const holeDay = dk(NOW, 4);
  const Q = mk(NOW, { skip: t => t > at(2026, 9, 26, 3) && t < at(2026, 9, 26, 5) });
  const hq = render(Q);
  const sq = (hq.match(/<svg class="chart"[^>]*aria-label="Views each day[\s\S]*?<\/svg>/) || [''])[0];
  const rq = Q.chartReg.get(+(sq.match(/data-ci="(\d+)"/) || [])[1]);
  check('the fixture’s hole is on 26 Sept', holeDay === '2026-09-26');
  check('a day with a hole draws no bar: 13 rects, one “no data”', [...sq.matchAll(/ rx="3"/g)].length === 13 && (sq.match(/>no data<\/text>/g) || []).length === 1);
  check('the mark sits in that day’s slot', (() => {
    const m = sq.match(/<text class="ax nodata" transform="translate\(([\d.]+),/); if (!m) return false;
    const x = +m[1]; return Math.floor((x - rq.L) / rq.slot) === 10;
  })());
  check('and its tip says there is no data, and why', rq.tips[10] === long(holeDay) + ': no data — part of the day wasn’t recorded, so it isn’t shown short', rq.tips[10]);
  check('the fold explains the mark', /“No data” marks a day this device can’t fully account for/.test(hq));
  check('a quiet recorded day is +0, not “no data”', (() => {
    const Z = mk(NOW, { rate: (id, k) => k === dk(NOW, 3) ? 0 : 10 });
    const hz = render(Z), sz = (hz.match(/<svg class="chart"[^>]*aria-label="Views each day[\s\S]*?<\/svg>/) || [''])[0];
    const rz = Z.chartReg.get(+(sz.match(/data-ci="(\d+)"/) || [])[1]);
    return rz.tips[11] === long(dk(NOW, 3)) + ': +0 views' && !/no data/.test(sz) && [...sz.matchAll(/ rx="3"/g)].length === 13;
  })());
  // the day the clocks go forward is 23 hours of views, and its tip says so
  const N2 = at(2026, 10, 10, 20);
  const S = mk(N2), hs = render(S);
  const ss = (hs.match(/<svg class="chart"[^>]*aria-label="Views each day[\s\S]*?<\/svg>/) || [''])[0];
  const rs = S.chartReg.get(+(ss.match(/data-ci="(\d+)"/) || [])[1]);
  const i4 = rs.tips.findIndex(x => x.startsWith(long('2026-10-04')));
  check('the 23-hour day (Sun 4 Oct) is 92 readings, and its tip says why', rs.tips[i4] === long('2026-10-04') + ': +920 views (a 23-hour day: the clocks went forward)' &&
    rs.tips.filter(x => /hour day/.test(x)).length === 1, rs.tips[i4]);
  // a device that only kept the last 5 days: the chart starts where its recording does
  const young = load(NOW, { videos: (() => { const v = store(NOW, ['a'], () => 10); v.a.create_time = Math.floor((NOW - 7 * D) / 1000); v.a.s = v.a.s.filter(s => s[0] >= NOW - 7 * D); return v; })(), followers: followerLog(NOW) }, [post(NOW, 'a')], null);
  const hy = render(young);
  const sy = (hy.match(/<svg class="chart"[^>]*aria-label="Views each day[\s\S]*?<\/svg>/) || [''])[0];
  check('days from before what this device keeps are left off the front, not marked', !!sy && !/no data/.test(sy) && /aria-label="Views each day, 26 Sept to 29 Sept/.test(sy), sy.slice(0, 200));
  check('and the week before says why it is empty', /— views, the 7 before 16–22 Sept older days aren’t kept on this device/.test(text(hy)), text(hy).slice(0, 300));
  const two = load(NOW, { videos: (() => { const v = store(NOW, ['a'], () => 10); v.a.create_time = Math.floor((NOW - 4 * D) / 1000); v.a.s = v.a.s.filter(s => s[0] >= NOW - 4 * D); return v; })(), followers: followerLog(NOW) }, [post(NOW, 'a')], null);
  check('under 3 full days there is no chart, and it says when there will be', /The views-each-day chart appears after 3 full days of tracking/.test(render(two)));
  // yesterday ahead of every other day is a record, marked for motion.js
  const R = mk(NOW, { rate: (id, k) => k === dk(NOW, 1) ? 20 : 10 });
  check('yesterday ahead of every other day on the chart is a record (.cc-win)', /<span class="cc-win">Yesterday was your best day of the 14 on this chart\.<\/span>/.test(render(R)));
  check('level with another day is not', !/cc-win/.test(render(mk(NOW, { rate: (id, k) => k === dk(NOW, 1) || k === dk(NOW, 5) ? 20 : 10 }))));
}

console.log('\nwhen people watch: the busiest and quietest three hours, from the bars themselves');
{
  const P = mk(NOW);
  const hb = new Array(24).fill(100);
  hb[6] = 900; hb[7] = 1200; hb[8] = 800; hb[2] = 10; hb[3] = 5; hb[4] = 20;
  const b = P.recHourBlocks(hb);
  check('busiest: 6–9 am, the sum of its three bars', b.busy.at.join() === '6' && b.busy.v === 2900, JSON.stringify(b.busy));
  check('quietest: 2–5 am', b.quiet.at.join() === '2' && b.quiet.v === 35 && !b.quiet.none, JSON.stringify(b.quiet));
  const html = text(P.recHourBlocksHtml(hb));
  check('said as two pills and one plain sentence',
    html === 'Busiest: 6–9 am Quietest: 2–5 am In the last 14 days, 2,900 views came in between 6 and 9 am, and 35 between 2 and 5 am — out of ' + f0.format(hb.reduce((a, x) => a + x, 0)) + ' on the bars below.', html);
  const wrap = new Array(24).fill(100); wrap[23] = 700; wrap[0] = 700; wrap[1] = 700;
  check('the clock wraps: 11 pm to 2 am is three hours in a row', P.recHourBlocks(wrap).busy.at.join() === '23' && /Busiest: 11 pm–2 am/.test(text(P.recHourBlocksHtml(wrap))));
  check('clock words: 9 am–12 pm, 12–3 am, 9 pm–12 am, 1–4 pm, 11 am–12 pm',
    [P.recBlock(9, 3), P.recBlock(0, 3), P.recBlock(21, 3), P.recBlock(13, 3), P.recBlock(11, 1)].join('|').replace(/ /g, ' ') === '9 am–12 pm|12–3 am|9 pm–12 am|1–4 pm|11 am–12 pm');
  const zero = new Array(24).fill(50); for (const h of [1, 2, 3, 4, 5]) zero[h] = 0; zero[14] = 0; zero[15] = 0; zero[16] = 0;
  const bz = P.recHourBlocks(zero);
  check('three hours with no views at all: the whole stretch is named, the longest one', bz.quiet.none && bz.quiet.at.join() === '1' && bz.quiet.n === 5, JSON.stringify(bz.quiet));
  check('and said as “No views”', /No views: 1–6 am/.test(text(P.recHourBlocksHtml(zero))) && /and none between 1 and 6 am —/.test(text(P.recHourBlocksHtml(zero))), text(P.recHourBlocksHtml(zero)));
  const tie = new Array(24).fill(100); tie[6] = 500; tie[7] = 500; tie[8] = 500; tie[18] = 500; tie[19] = 500; tie[20] = 500;
  const tt = text(P.recHourBlocksHtml(tie));
  check('a tie is said, never broken silently', /Busiest: 6–9 am \(tied\)/.test(tt) && /\(as many as between 6 and 9 pm\)/.test(tt), tt);
  check('under 50 views counted by hour, it waits rather than calling anything busiest',
    /show once 50 views have been counted by hour/.test(P.recHourBlocksHtml([10, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
  // in the card: the pills read the very buckets the bars are drawn from
  const R = mk(NOW, { rate: (id, k, t) => { const hr = new Date(t - 1).getHours(); return hr >= 18 && hr < 21 ? 40 : hr < 3 ? 1 : 10; } });
  const h = render(R), t = text(h);
  const bars = [...h.matchAll(/<div class="bar[^"]*" style="height:\d+%" title="\+([\d,]+) views — ([^"]+)"><\/div>/g)].map(m => +m[1].replace(/,/g, ''));
  check('24 hour bars, each titled with its hour', bars.length === 24 && /title="\+[\d,]+ views — 6–7 pm"/.test(h));
  check('busiest: 6–9 pm, and its figure is the sum of those three bars', /Busiest: 6–9 pm/.test(t) && t.includes(f0.format(bars[18] + bars[19] + bars[20]) + ' views came in between 6 and 9 pm'), t);
  check('quietest: 12–3 am, the sum of those three', /Quietest: 12–3 am/.test(t) && t.includes(', and ' + f0.format(bars[0] + bars[1] + bars[2]) + ' between 12 and 3 am'), t);
  check('the whole is the bars’ own total', t.includes('— out of ' + f0.format(bars.reduce((a, x) => a + x, 0)) + ' on the bars below.'));
  check('the clock is named: Melbourne time', /When people watch · Melbourne time/.test(t));
  check('the caveat stays, whole', /Views gained by hour of the day over the last 14 days, in your own local time\. A new post’s first hours land wherever it was published, so your posting times shape this as much as your audience’s habits\./.test(t));
}

console.log('\n“Today so far” is the Now room’s figure');
for (const [label, opts] of [['a normal evening', {}], ['a hole this morning', { skip: t => t > at(2026, 9, 30, 2) && t < at(2026, 9, 30, 4) }],
                             ['just after midnight', { now: at(2026, 9, 30, 0, 40) }]]) {
  const N = opts.now || NOW;
  const P = mk(N, { rate: (id, k) => k === dayKey(N) ? 13 : 10, skip: opts.skip });
  P.renderToday();
  const now = (P.els.todayMain.innerHTML.match(/<div class="tile"><div class="v[^"]*">([^<]*)<\/div><div class="k">views<\/div>/) || [])[1];
  const tr = (render(P).match(/<div class="label">Today so far<\/div><div class="val">([^<]*)<\/div><div class="sub">([^<]*)</) || []);
  check(label + ': the two show the same figure (' + now + ')', !!now && now === tr[1] && P.ttTodayModel().views === P.recDayGains(16).get(dayKey(N)), now + ' vs ' + tr[1]);
  check(label + ': and the tile says what it counts', opts.skip ? tr[2] === 'part of today wasn’t recorded' : tr[2] === 'views since midnight', tr[2]);
}

console.log('\nnothing that was on the card is gone');
{
  const P = mk(NOW, { ids: ['a', 'b'], rate: (id, k) => id === 'a' ? 10 : inPrev(k) ? 40 : 0 });
  const h = render(P), t = text(h);
  for (const [what, re] of [
    ['Today so far', /Today so far \+[\d,]+ views since midnight/],
    ['the follower tile, over its span', /Followers, 7 days \+56 from your follower count/],
    ['Last 7 / Prior 7, as the big tiles', /views, last 7 days/],
    ['whose views the day chart counts, and where they are kept', /Views your posts gained each full day, from the counts kept on this device\. Today joins once it’s over\. A missing day is a gap in the recording, not a zero\./],
    ['follower history, 30 / 90 / All', /Follower history — checked every few hours 30 days 90 days All/],
  ]) check(what, re.test(t), t.slice(0, 200));
  check('the day chart’s working is a native fold that keeps its state across repaints',
    /<details class="cc-more chart-how" data-fold="trends-days-how"><summary><span aria-hidden="true">ⓘ<\/span> How this is counted<\/summary><div class="cc-more-body">/.test(h));
  P.foldOpen['trends-days-how'] = true;
  check('and is rebuilt open when it was open', /data-fold="trends-days-how" open>/.test(render(P)));
  check('where the numbers come from is one tap away, in a static fold under the charts',
    /<div id="recTrendsContent"><p class="dnote">compiling…<\/p><\/div>\s*<details class="cc-more" id="recTrendsHow">\s*<summary><span aria-hidden="true">&#9432;<\/span> Where these numbers come from<\/summary>\s*<div class="cc-more-body"><p class="explain">TikTok keeps no history, so these charts come from your dashboard’s own tracker, as kept on this device\. A gap in the recording is left out, not guessed\.<\/p><\/div>\s*<\/details>/.test(TT));
  check('with every fold shut, the answers are still on show: tiles, bars, pills, follower chart',
    (() => { const shut = h.replace(/<details[\s\S]*?<\/details>/g, ''); return /tr-tiles/.test(shut) && /aria-label="Views each day/.test(shut) && /Busiest:/.test(shut) && /aria-label="Follower history"/.test(shut); })());
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
