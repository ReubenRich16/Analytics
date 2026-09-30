// A single post — the Recent posts card and the per-post drawer — after the redesign, run
// against the page's own code.
//
// The top of a post is now a verdict and four numbers, each saying what it is compared with,
// then ONE chart ("First 48 hours vs your usual"); everything the card showed before sits in
// a "More numbers and charts" fold. What this pins:
//
//   · the verdict pill is the report card's own grade (ttVerdictOf over ttGradeOf) and never
//     a letter the report card would not give; a post too young to grade names the exact
//     clock time a grade can start; a record is marked .cc-win only on real counts;
//   · Views is compared with your usual post (the reach median the report card ranks, from 4
//     others), a launching post says where it is heading, and a young one only what it has;
//   · Like rate is judged from 200 views, against the ONE typical like rate, with the report
//     card's bands; Shares are "1 for every N views", never "viewers";
//   · "Views today" is the calendar day by the Today card's rules — for one post on its own
//     it IS the Today card's figure, and "yesterday by this time" is the same hours;
//   · the usual-range band is drawn from the gold line's own voters and breaks at a gap;
//   · nothing the card showed before is gone: every panel is inside the fold, on both hosts;
//   · motion.js draws what a fold reveals when you open it, and never leaves a chart in a
//     closed fold paused on an invisible first frame.
//
// Melbourne time throughout, set before anything reads a clock.
//
// Run: node scripts/tt-post.test.mjs
process.env.TZ = 'Australia/Melbourne';
import fs from 'fs';
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');
const MOTION = fs.readFileSync(new URL('../yt-dashboard/motion.js', import.meta.url), 'utf8');

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
const strip = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const TODAY = cut('  /* ---------- Today so far ----------', '  /* ---------- hashtags, with the account');
const SRC = `
  const RealDate = globalThis.Date;
  class Date extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
  const fmt = new Intl.NumberFormat('en-AU');
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const PJ_MIN_AGE = 300, PJ_HORIZON = 2880;
  const scoreOf = v => (scores && scores[v.id] != null) ? scores[v.id] : null;
  const ttdOpen = () => {};
  const els = {};
  const $ = id => els[id] || (els[id] = { id, style: {}, dataset: {}, innerHTML: '', addEventListener() {} });
  ${line('  const capOf = ')}
  ${arrow('  const clip = (s, n) =>')}
  ${arrow('  const shortCap = ')}
  ${line('  const ageDays = ')}${line('  const paceOf = ')}${line('  const engOf = ')}
  ${arrow('  const typicalLikeRate = ')}
  ${arrow('  const fmtAgo = ts =>')}
  ${arrow('  const fmtAge = m =>')}
  ${arrow('  const newestTs = h =>')}
  ${line('  const pjMed = ')}${line('  const pjDur = ')}
  ${arrow('  const pjRank = (pool, v) =>')}
  ${line('  const fseries = () =>')}${line('  const fAtOrBefore = ')}${line('  const ATB = ')}
  ${fnOf('dayBuckets')}${fnOf('nextMilestone')}
  ${line('  const milestonePct = ')}
  ${arrow('  const liveFollowers = fh =>')}
  ${fnOf('projectMilestone')}
  ${line('  const TT_GAP = ')}${arrow('  const ttStoredBasis = ')}
  ${fnOf('ttGainBuckets')}${fnOf('recDayGains')}
  ${fnOf('ttGradeOf')}${fnOf('ttReportCardHtml')}
  ${TODAY}
  ${fnOf('ttPostTopHtml')}
  return { ttTodayModel, ttTodayWords, ttPostToday, ttVerdictOf, ttPostTopHtml, ttReportCardHtml, recDayGains, clockTxt };`;
const load = (NOW, hist, videos, me, scores) =>
  new Function('NOW', 'hist', 'videos', 'me', 'scores', SRC)(NOW, hist, videos, me || {}, scores || {});

/* One post the way the Worker records it: a reading every 15 minutes from `from`, each
   carrying the views of the quarter hour before it at `rate(dayKey)`. `skip` makes holes. */
const dayKey = t => new Date(t).toLocaleDateString('en-CA');
function rec(NOW, t0, rate, skip, from) {
  const s = []; let v = 1000, pending = 0;
  const start = Math.max(t0, from != null ? from : NOW - 3 * D);
  for (let t = Math.ceil(start / (15 * MIN)) * 15 * MIN; t <= NOW; t += 15 * MIN) {
    pending += rate(dayKey(t - 1));
    if (skip && skip(t)) continue;
    v += pending; pending = 0;
    s.push([t, v, 0, 0, 0]);
  }
  return { create_time: Math.floor(t0 / 1000), title: 'A post', s };
}
const post = (id, t0, views, likes, shares) => ({ id, title: 'A post #asmr', create_time: Math.floor(t0 / 1000), view_count: views, like_count: likes, share_count: shares || 0 });
const tileOf = (html, k) => {
  const m = html.match(new RegExp('<div class="tile"><div class="v([^"]*)">([^<]*)</div><div class="k">' + k + '</div>((?:<div class="c">[^<]*</div>)*)</div>'));
  return m ? { cls: m[1].trim(), v: m[2], c: [...m[3].matchAll(/<div class="c">([^<]*)<\/div>/g)].map(x => x[1].replace(/ /g, ' ')) } : null;
};

/* ---------- 1. views today, by the Today card's own rules ---------- */
console.log('\nviews today — one post, by the Today card’s rules (Wed 30 Sep, 8:23 am)');
{
  const NOW = at(2026, 9, 30, 8, 23);
  const today = dayKey(NOW);
  const t0 = NOW - 40 * D;
  const hist = { videos: { p: rec(NOW, t0, k => k === today ? 12 : 10) }, followers: [] };
  const v = post('p', t0, 90000, 7000, 12);
  const P = load(NOW, hist, [v]);
  const m = P.ttTodayModel(), d = P.ttPostToday(v);
  check('a lone post’s views today ARE the Today card’s views today', d.state === 'ok' && d.gain === m.views && d.gain === 33 * 12, d.gain + ' vs ' + m.views);
  check('and its "yesterday by this time" is the Today card’s, the same hours of each day',
    d.n === m.cmp.n && d.today === m.cmp.today && d.yday === m.cmp.yday && d.n === 8, JSON.stringify([d.n, d.today, d.yday, m.cmp.n, m.cmp.today, m.cmp.yday]));
  check('nothing is partial when the recording is whole', d.partial === false);
  const t = tileOf(P.ttPostTopHtml(v), 'views today');
  check('the tile: +396 since midnight, and the comparison with both of its own figures (by 8 am: 384 today, 320 yesterday)',
    t && t.v === '+396' && t.cls === 'up' && t.c[0] === 'since midnight' && t.c[1] === 'by 8 am: 384 today, 320 yesterday', JSON.stringify(t));
  check('the tile never sets yesterday’s whole-hour figure beside the live-to-now one alone', !/^yesterday by/.test(t.c[1]), JSON.stringify(t));

  // two posts: each is its own share of the day, and together they are the day
  const hist2 = { videos: { p: rec(NOW, t0, k => k === today ? 12 : 10), q: rec(NOW, NOW - 20 * D, () => 3) }, followers: [] };
  const P2 = load(NOW, hist2, [v, post('q', NOW - 20 * D, 500, 40)]);
  const a = P2.ttPostToday(v).gain, b = P2.ttPostToday(post('q', NOW - 20 * D, 500, 40)).gain;
  check('two posts’ views today add up to the Today card’s', a + b === P2.ttTodayModel().views && a === 396 && b === 99, a + ' + ' + b + ' vs ' + P2.ttTodayModel().views);

  // a hole this morning: part of today was not seen
  const holed = { videos: { p: rec(NOW, t0, k => k === today ? 12 : 10, t => t > at(2026, 9, 30, 3) && t < at(2026, 9, 30, 5, 30)) }, followers: [] };
  const P3 = load(NOW, holed, [v]);
  const d3 = P3.ttPostToday(v), t3 = tileOf(P3.ttPostTopHtml(v), 'views today');
  check('a hole in today’s recording marks the day partial and drops the comparison', d3.partial && d3.cmpWhy === 'today' && d3.today == null, JSON.stringify(d3));
  check('and the tile says so rather than comparing a short day', t3.c[0] === 'part of today wasn’t recorded' && t3.c.length === 1, JSON.stringify(t3));
  check('the rise across the hole is filed in no hour, as on the Today card', d3.gain === P3.ttTodayModel().views, d3.gain + ' vs ' + P3.ttTodayModel().views);

  // a hole yesterday morning: there is nothing fair to compare with
  const yh = { videos: { p: rec(NOW, t0, () => 10, t => t > at(2026, 9, 29, 2) && t < at(2026, 9, 29, 4)) }, followers: [] };
  const P4 = load(NOW, yh, [v]);
  check('a hole in yesterday’s compared hours abstains', P4.ttPostToday(v).cmpWhy === 'yesterday' && tileOf(P4.ttPostTopHtml(v), 'views today').c[1] === 'yesterday wasn’t fully tracked');

  // the newest reading is 38 minutes old: the tile says where the count stops
  const late = { videos: { p: rec(NOW, t0, () => 10, t => t > at(2026, 9, 30, 7, 45)) }, followers: [] };
  const P5 = load(NOW, late, [v]);
  const d5 = P5.ttPostToday(v), t5 = tileOf(P5.ttPostTopHtml(v), 'views today');
  check('a count that stops at the last reading says so: since midnight, to 7:45 am', t5.c[0] === 'since midnight, to 7:45 am', JSON.stringify(t5));
  check('and the comparison runs only to the whole hours it has (7 am)', d5.n === 7 && t5.c[1] === 'by 7 am: 280 today, 280 yesterday', JSON.stringify([d5.n, t5.c]));

  // no reading at all since midnight
  const stale = { videos: { p: rec(NOW, t0, () => 10, t => t > at(2026, 9, 29, 23)) }, followers: [] };
  const P6 = load(NOW, stale, [v]);
  const t6 = tileOf(P6.ttPostTopHtml(v), 'views today');
  check('no reading since midnight: —, and why', P6.ttPostToday(v).state === 'stale' && t6.v === '—' && t6.cls === 'none' && t6.c[0] === 'no reading since midnight yet', JSON.stringify(t6));
}
console.log('\nviews today — the edges');
{
  const NOW = at(2026, 9, 30, 8, 23);
  // up today: every view it has is today's, so the live count is the answer
  const nv = post('n', at(2026, 9, 30, 2, 10), 431, 30);
  const P = load(NOW, { videos: {}, followers: [] }, [nv]);
  const t = tileOf(P.ttPostTopHtml(nv), 'views today');
  check('a post that went up after midnight: its whole live count, and when it went up',
    P.ttPostToday(nv).state === 'new' && t.v === '+431' && t.c[0] === 'it went up today at 2:10 am', JSON.stringify(t));
  // up yesterday afternoon: yesterday's early hours it did not exist, so no comparison
  const yv = post('y', at(2026, 9, 29, 16), 900, 70);
  const Py = load(NOW, { videos: { y: rec(NOW, at(2026, 9, 29, 16), () => 10) }, followers: [] }, [yv]);
  const ty = tileOf(Py.ttPostTopHtml(yv), 'views today');
  check('a post that went up yesterday is not compared with a yesterday it was only partly up for',
    Py.ttPostToday(yv).cmpWhy === 'posted' && ty.c[1] === 'it went up yesterday at 4 pm', JSON.stringify(ty));
  // just after midnight
  const E = at(2026, 9, 30, 0, 30);
  const ev = post('e', E - 40 * D, 9000, 700);
  const Pe = load(E, { videos: { e: rec(E, E - 40 * D, () => 10) }, followers: [] }, [ev]);
  check('before 1 am it says the comparison starts at 1 am', tileOf(Pe.ttPostTopHtml(ev), 'views today').c[1] === 'compared with yesterday from 1 am');
  // not recorded on this page at all
  const old = post('o', NOW - 90 * D, 1687, 93);
  check('a post with no recording here: —, no readings of it yet',
    tileOf(load(NOW, { videos: {}, followers: [] }, [old]).ttPostTopHtml(old), 'views today').c[0] === 'no readings of it yet');
  const newer = []; for (let i = 0; i < 20; i++) newer.push(post('x' + i, NOW - (i + 1) * D, 100, 5));
  check('and one outside the 20 newest says that is why',
    tileOf(load(NOW, { videos: {}, followers: [] }, [...newer, old]).ttPostTopHtml(old), 'views today').c[0] === 'counted for your 20 newest posts only');
  // the morning after the clocks go forward: yesterday was 23 hours long
  const DST = at(2026, 10, 5, 8, 23);
  const dv = post('d', DST - 40 * D, 9000, 700);
  const Pd = load(DST, { videos: { d: rec(DST, DST - 40 * D, () => 10) }, followers: [] }, [dv]);
  const dd = Pd.ttPostToday(dv), mm = Pd.ttTodayModel();
  const td = tileOf(Pd.ttPostTopHtml(dv), 'views today');
  check('the day after the clocks go forward it compares hours with hours, as the Today card does',
    dd.n === mm.cmp.n && dd.today === mm.cmp.today && dd.yday === mm.cmp.yday && td.c[1] === 'first 8 hours: ' + mm.cmp.today + ' today, ' + mm.cmp.yday + ' yesterday', JSON.stringify([dd.n, dd.yday, mm.cmp.yday, td.c]));
  const body = fnOf('ttPostToday');
  check('no day boundary here is made by adding or taking 24 hours', !/864e5 \*|24 \* H|86400/.test(body.replace('now - 16 * 864e5', '')), body.match(/.*(24 \* H|86400).*/)?.[0]);
}

/* ---------- 2. the verdict ---------- */
console.log('\nthe verdict is the report card’s own grade');
{
  const NOW = at(2026, 9, 30, 8, 23);
  const others = [], sc = {};
  for (let i = 0; i < 28; i++) { others.push(post('o' + i, NOW - (10 + i) * D, 1000 + i * 100, 80 + i, 3)); sc['o' + i] = 1000 + i * 100; }
  const letterOf = html => (html.match(/class="grade-badge"[^>]*>([^<]*)</) || [])[1];
  const cases = [
    ['a 3-hour-old post', post('n', NOW - 3 * H, 93, 7), {}, others],
    ['an 8-hour-old post not yet estimable', post('n', NOW - 8 * H, 700, 50), {}, others],
    ['a launching post ranked on its estimate', post('n', NOW - 10 * H, 2725, 260), { n: 5393 }, others],
    ['an old hit', post('n', NOW - 12 * D, 35436, 3073, 89), { n: 35436 }, others],
    ['an old quiet post', post('n', NOW - 30 * D, 900, 40), { n: 900 }, others],
    ['a small account, graded on like rate', post('n', NOW - 9 * H, 300, 24), {}, others.slice(0, 3)],
    ['a small account, too few views', post('n', NOW - 9 * H, 93, 7), {}, others.slice(0, 3)],
    ['a 0-view post', post('n', NOW - 60 * D, 0, 0), { n: null }, others],
    ['a brand-new account', post('n', NOW - 60 * D, 500, 40), { n: 500 }, others.slice(0, 1)]
  ];
  for (const [name, v, s, pool] of cases) {
    const P = load(NOW, { videos: {}, followers: [] }, [v, ...pool], {}, { ...sc, ...s });
    const vd = P.ttVerdictOf(v), card = P.ttReportCardHtml(v), letter = letterOf(card);
    const ok = letter && letter !== '—' ? vd.pill === 'Grade ' + letter : ['Too early', 'Not graded yet'].includes(vd.pill);
    check(name + ': the pill (' + vd.pill + ') matches the report card (' + (letter || 'no card') + ')', ok, vd.pill + ' / ' + letter);
  }
  {
    const z = post('z', NOW - 60 * D, 0, 0);
    const vz = load(NOW, { videos: {}, followers: [] }, [z, ...others], {}, sc).ttVerdictOf(z);
    check('a two-month-old post with no views is “Not graded yet”, not “Too early”', vz.pill === 'Not graded yet' && vz.why === 'It gets a grade once it has views counted.', JSON.stringify(vz.pill));
    const y = post('y', NOW - 20 * MIN, 0, 0);
    check('a 20-minute-old one with none is still “Too early”', load(NOW, { videos: {}, followers: [] }, [y, ...others], {}, sc).ttVerdictOf(y).pill === 'Too early');
  }

  // the exact clock time a grade can start
  const eve = post('e', at(2026, 9, 30, 20, 40) / 1 , 93, 7);
  const EV = at(2026, 9, 30, 23, 40);
  const Pe = load(EV, { videos: {}, followers: [] }, [eve, ...others], {}, sc);
  const te = strip(Pe.ttPostTopHtml(eve));
  check('too young: “Too early”, and the exact time — crossing midnight says tomorrow',
    /^Too early It can get a grade from 1:40 am tomorrow \(5 hours old\), once its first 48 hours can be estimated\./.test(te), te.slice(0, 140));
  const morn = post('m', at(2026, 9, 30, 9, 10), 93, 7);
  const Pm = load(at(2026, 9, 30, 11, 0), { videos: {}, followers: [] }, [morn, ...others], {}, sc);
  check('and the same day needs no day named', /It can get a grade from 2:10 pm \(5 hours old\)/.test(strip(Pm.ttPostTopHtml(morn))), strip(Pm.ttPostTopHtml(morn)).slice(0, 120));
  check('the time is creation plus the projection’s own switch-on age, not a guess',
    /r\.start = \(v\.create_time \|\| 0\) \* 1000 \+ PJ_MIN_AGE \* 60e3;/.test(TODAY));

  // a record is a record only on real counts
  const hit = post('h', NOW - 12 * D, 35436, 3073, 89);
  const Ph = load(NOW, { videos: {}, followers: [] }, [hit, ...others], {}, { ...sc, h: 35436 });
  const hh = Ph.ttPostTopHtml(hit);
  check('an old post ahead of all 28 others: ★ Grade A+, marked .cc-win for the sparkle',
    /<span class="today-pill up cc-win">★ Grade A\+<\/span> Beats all 28 of your other posts on reach\./.test(hh), hh.slice(0, 200));
  const hot = post('t', NOW - 10 * H, 9000, 700, 20);
  const Pt = load(NOW, { videos: {}, followers: [] }, [hot, ...others], {}, { ...sc, t: 50000 });
  const ht = Pt.ttPostTopHtml(hot);
  check('an estimate that beats all of them is graded, but is not a record yet',
    /Grade A\+/.test(ht) && !/cc-win/.test(ht) && !/★/.test(ht) && /going by its estimated first 48 hours/.test(ht), ht.slice(0, 200));
  // a tie at the top of a big pool rounds to 100% — it is not ahead of all of them
  const big = [], bsc = {};
  for (let i = 0; i < 120; i++) { big.push(post('b' + i, NOW - (10 + i) * D, 1000 + i, 80)); bsc['b' + i] = 1000 + i; }
  const tieTop = post('h', NOW - 12 * D, 1119, 90);
  const Pb = load(NOW, { videos: {}, followers: [] }, [tieTop, ...big], {}, { ...bsc, h: 1119 });
  const vb = Pb.ttVerdictOf(tieTop);
  check('level with the best of 120 others is not “beats all”, and not a record, though it rounds to 100%',
    vb.g.beats === 100 && !vb.win && /^Beats 99% of your 120 other posts on reach\.$/.test(vb.why), vb.why);
  // ahead of every post, but one of them is still estimated: no star yet, and it says why
  const est = post('y', NOW - 10 * H, 3000, 200);
  const Py = load(NOW, { videos: {}, followers: [] }, [hit, est, ...others], {}, { ...sc, h: 35436, y: 20000 });
  const vy = Py.ttVerdictOf(hit);
  check('ahead of all, one of them an estimate: not a record yet, and said', !vy.win &&
    /^Beats all 29 of your other posts on reach \(some of them are under 2 days old, so they count by their estimated first 48 hours\)\.$/.test(vy.why), vy.why);
  check('the Today card’s newest-post row reads the same verdict', /const \{ pill, pc, why \} = ttVerdictOf\(nv\);/.test(TODAY));
}

/* ---------- 3. the four numbers ---------- */
console.log('\nthe four numbers, each against something');
{
  const NOW = at(2026, 9, 30, 8, 23);
  const others = [], sc = {};
  // 28 others scoring 1,000 … 3,700: the usual post is the median, 2,350
  for (let i = 0; i < 28; i++) { others.push(post('o' + i, NOW - (10 + i) * D, 1000 + i * 100, Math.round((1000 + i * 100) * 0.08), 3)); sc['o' + i] = 1000 + i * 100; }
  const top = (v, s, pool) => load(NOW, { videos: {}, followers: [] }, [v, ...(pool || others)], {}, { ...sc, ...s }).ttPostTopHtml(v);
  const vt = (views, s) => tileOf(top(post('p', NOW - 12 * D, views, Math.round(views * .08), 5), { p: views, ...s }), 'views');
  check('a post 15× the usual: “15× your usual post”, and the usual’s own figure', JSON.stringify(vt(35436).c) === JSON.stringify(['15× your usual post', 'your usual: 2,350 views']), JSON.stringify(vt(35436)));
  check('under 10× it keeps one decimal (5.6×)', vt(13160).c[0] === '5.6× your usual post', vt(13160).c[0]);
  check('exactly double is 2×', vt(4700).c[0] === '2× your usual post', vt(4700).c[0]);
  check('under double it is a percentage (43%, not 0.4×)', vt(1000).c[0] === '43% of your usual post', vt(1000).c[0]);
  check('the value is the post’s real count, for the count-up to land on', vt(35436).v === '35,436');
  check('the usual leaves this post out, and counts finished posts only (48 hours or older)',
    /videos\.filter\(x => x\.id !== v\.id && \(now - \(x\.create_time \|\| 0\) \* 1000\) \/ 60000 >= PJ_HORIZON\)\.map\(scoreOf\)/.test(fnOf('ttPostTopHtml')));
  // a launching post's estimate is not a view count, so it never moves "your usual: N views"
  const est = tileOf(top(post('p', NOW - 12 * D, 35436, 2835, 5), { p: 35436, e1: 90000, e2: 90000, e3: 90000 },
    others.concat([1, 2, 3].map(i => post('e' + i, NOW - 10 * H, 3000, 200)))), 'views');
  check('three launching posts estimated at 90,000 leave the usual at 2,350 views', est.c[1] === 'your usual: 2,350 views', JSON.stringify(est));
  const few = tileOf(top(post('p', NOW - 12 * D, 5000, 400), { p: 5000 }, others.slice(0, 3)), 'views');
  check('with fewer than 4 others there is no usual to compare with', few.c[0] === 'too few posts to compare with yet', JSON.stringify(few));
  const launching = tileOf(top(post('p', NOW - 10 * H, 2725, 260), { p: 5393 }), 'views');
  check('a launching post says where it is heading, not a ratio against finished totals',
    JSON.stringify(launching.c) === JSON.stringify(['heading for ~5,393 by 48 hours', 'your usual post: 2,350']), JSON.stringify(launching));
  const young = tileOf(top(post('p', NOW - (3 * H + 20 * MIN), 93, 7), {}), 'views');
  check('a young post not yet estimable: its age and average per hour, nothing projected',
    JSON.stringify(young.c) === JSON.stringify(['in its first 3h 20m', 'averaging 28 an hour']), JSON.stringify(young));
  const baby = tileOf(top(post('p', NOW - 40 * MIN, 12, 1), {}), 'views');
  check('under an hour, no hourly average is invented', JSON.stringify(baby.c) === JSON.stringify(['in its first 40 min']), JSON.stringify(baby));
  const three = tileOf(top(post('p', NOW - 3 * H, 93, 7), {}), 'views');
  check('a whole number of hours reads “3h”, not “3h 0m”', three.c[0] === 'in its first 3h', three.c[0]);

  const lr = (views, likes) => tileOf(top(post('p', NOW - 12 * D, views, likes, 5), { p: views }), 'like rate');
  const thin = lr(150, 7);
  check('under 200 views: no like rate, the reason, and the likes it has', thin.v === '—' && thin.cls === 'none' && JSON.stringify(thin.c) === JSON.stringify(['needs 200 views to judge', '7 likes']), JSON.stringify(thin));
  check('over 115% of the usual rate is above it', lr(1000, 100).c[0] === 'above your usual 8.0%' && lr(1000, 100).v === '10.0%', JSON.stringify(lr(1000, 100)));
  check('under 85% is below it', lr(1000, 60).c[0] === 'below your usual 8.0%', JSON.stringify(lr(1000, 60)));
  check('in between is close to it', lr(1000, 85).c[0] === 'close to your usual 8.0%', JSON.stringify(lr(1000, 85)));
  check('one like is “1 like”', lr(300, 1).c[1] === '1 like');
  check('the bands are the report card’s (above 115, below 85)', /idx > 115 \? 'above' : idx < 85 \? 'below' : 'close to'/.test(fnOf('ttPostTopHtml')) &&
    /idx > 115 \? 'above your usual' : idx < 85 \? 'below your usual'/.test(fnOf('ttReportCardHtml')));
  check('and the usual rate is the shared one', /const medEng = typicalLikeRate\(v\.id\);/.test(fnOf('ttPostTopHtml')));

  const sh = (views, shares) => tileOf(top(post('p', NOW - 12 * D, views, 80, shares), { p: views }), shares === 1 ? 'share' : 'shares');
  check('shares per view: 89 of 35,436 is 1 for every 398 views', JSON.stringify(sh(35436, 89).c) === JSON.stringify(['1 for every 398 views']), JSON.stringify(sh(35436, 89)));
  check('none yet says so', sh(500, 0).v === '0' && sh(500, 0).c[0] === 'none yet');
  check('one share is “share”', sh(500, 1).v === '1');
  check('never “viewers” — a view is not a person', !/viewer/i.test(fnOf('ttPostTopHtml').replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')));
  const all = top(post('p', NOW - 12 * D, 35436, 3073, 89), { p: 35436 });
  check('four tiles the motion layer counts (.tile .v), in the mockup’s order',
    (all.match(/<div class="tile">/g) || []).length === 4 && /class="today-tiles post-tiles"/.test(all) &&
    all.indexOf('>views</div>') < all.indexOf('>like rate</div>') && all.indexOf('>like rate</div>') < all.indexOf('>views today</div>') && all.indexOf('>views today</div>') < all.indexOf('>shares</div>'));
}

/* ---------- 4. the chart's usual range, drawn ---------- */
console.log('\nthe usual range, drawn');
{
  const ML = new Function('esc', 'fmt', 'chartPush', `
    ${fnOf('niceScale')}
    const axisNum = n => String(Math.round(n));
    const legendHtml = items => '<div class="legend">' + items.map(i => '<span class="lg-item' + (i.bar ? ' bar' : '') + '">' + esc(i.name) + '</span>').join('') + '</div>';
    ${fnOf('multiLineHtml')}
    return multiLineHtml;`)(s => String(s), new Intl.NumberFormat('en-AU'), () => 3);
  const n = 97;
  const band = [...Array(n)].map((_, i) => (i > 40 && i < 50) || i === 0 ? null : [i * 8, i * 12]);
  const html = ML([
    { band, color: 'var(--uband, var(--gold))', opacity: 'var(--uband-op, .2)', name: 'Your usual range' },
    { pts: [...Array(n)].map((_, i) => i * 10), color: 'var(--gold)', name: 'Your usual post' },
    { pts: [...Array(n)].map((_, i) => i * 20), color: 'var(--live)', dot: true, name: 'This post', end: '1,920 at 48h' }
  ], [], { label: 'x', yMax: 2000, legend: [{ name: 'This post' }, { name: 'Your usual post' }, { name: 'Your usual range', bar: true }] });
  const d = (html.match(/<path class="uband" d="([^"]+)"/) || [])[1] || '';
  check('the band is a filled shape, drawn under the lines', /<path class="uband"/.test(html) && html.indexOf('class="uband"') < html.indexOf('class="line"'));
  check('a gap in the band breaks it in two rather than bridging it', (d.match(/M/g) || []).length === 2 && (d.match(/Z/g) || []).length === 2, (d.match(/M/g) || []).length);
  check('no NaN reaches it', !/NaN/.test(html));
  check('it is clipped to the plot like the lines', /<path class="uband"[^>]*clip-path="url\(#ttclip3\)"/.test(html));
  check('the theme can set its colour and strength', /style="fill:var\(--uband, var\(--gold\)\);opacity:var\(--uband-op, \.2\);stroke:none"/.test(html));
  check('a band is not counted as a line for the draw-in', (html.match(/class="line"/g) || []).length === 2);
  check('the legend takes the caller’s order', /This post.*Your usual post.*Your usual range/.test(strip(html)) && /lg-item bar">Your usual range/.test(html));
  check('this post’s line carries its end label', /<text class="val"[^>]*>1,920 at 48h<\/text>/.test(html));
  check('the range is gold like the usual line, and Cinnamoroll sets its own',
    /color: 'var\(--uband, var\(--gold\)\)'/.test(TT) && /body\[data-theme="cloud"\] \{ --uband:#[0-9a-f]{6}; --uband-op:[.\d]+; \}/.test(TT));
  check('it needs 4 finished launches at an age, from the gold line’s own voters',
    /const TTC_BAND_MIN = 4;/.test(TT) && /const vAtB = voters\.map\(c => grid\.map\(t => ttcAtB\(c, t\)\)\);\s*\n\s*const band = grid\.map\(\(t, i\) => ttcBand\(vAtB\.map\(a => a\[i\]\)\)\);/.test(TT));
}

/* ---------- 5. nothing lost: every panel is in the fold, on both hosts ---------- */
console.log('\nnothing that was shown is gone');
{
  const rl = fnOf('renderLatest');
  const fold = rl.indexOf('<details class="cc-more post-more"'), shut = rl.indexOf("'</div></details>'");
  const inFold = s => { const i = rl.indexOf(s); return i > fold && i < shut; };
  check('the card: verdict and four numbers first, then the one chart, then the fold',
    rl.indexOf('let html = ttPostTopHtml(v);') >= 0 && rl.indexOf('ttPostTopHtml') < rl.indexOf('id="ttLaunchWrap"') && rl.indexOf('id="ttLaunchWrap"') < fold, [rl.indexOf('id="ttLaunchWrap"'), fold]);
  check('the fold is called “More numbers and charts” and keeps its state over a repaint', /foldAttr\('card-more'\) \+ '><summary>More numbers and charts<\/summary>/.test(rl));
  for (const [what, s] of [['the estimate', 'id="pjWrap"'], ['the eight numbers', 'html += ttMetricGridHtml(v);'], ['the live race', 'id="ttRaceContent"'],
    ['the minute chart', 'html += ttMinuteChartHtml(v);'], ['the report card', 'html += ttReportCardHtml(v);'], ['the hourly record and lifetime strip', 'id="lifeSection" data-life="section"']]) {
    check('the card keeps ' + what + ', inside the fold', inFold(s), s);
  }
  const fill = fnOf('ttdFill');
  const dfold = fill.indexOf('<details class="cc-more post-more"'), dshut = fill.indexOf("'</div></details>'");
  const dIn = s => { const i = fill.indexOf(s); return i > dfold && i < dshut; };
  check('the drawer: the same top, then its chart, then the fold',
    fill.indexOf('ttPostTopHtml(v)') >= 0 && fill.indexOf('ttPostTopHtml(v)') < fill.indexOf('data-ttd="launch"') && fill.indexOf('data-ttd="launch"') < dfold);
  check('its fold keeps its own state', /foldAttr\('drawer-more'\)/.test(fill));
  for (const [what, s] of [['the estimate', 'data-ttd="pj"'], ['the eight numbers', 'ttMetricGridHtml(v)'], ['the hashtag figures', 'ttdHashtagsHtml(v)'],
    ['the same-age race', 'data-ttd="race"'], ['the minute chart', 'ttMinuteChartHtml(v)'], ['the report card', 'ttReportCardHtml(v)'], ['the hourly record', 'data-life="section"']]) {
    check('the drawer keeps ' + what + ', inside the fold', dIn(s), s);
  }
  const grid = fnOf('ttMetricGridHtml');
  check('all eight numbers are still in the grid',
    ['Views', 'Likes', 'Comments', 'Shares', 'Like rate', 'Avg views/day', 'Length', 'Age'].every(l => grid.includes("mcell('" + l + "'")));
  const lc = fnOf('ttLaunchCurves');
  check('the chart’s explainer is kept word for word, behind “How to read this”',
    /Grey lines are up to ' \+ TTC_MAX \+ ' of your newest other posts, each lined up from when it went up\. Gold is your usual post \(the middle of those tracked without gaps\)/.test(lc) &&
    /The gold line stops where fewer than ' \+ TTC_MIN_VOTES \+[\s\S]*A break in a line is a gap in tracking, not a pause in views\./.test(lc) && /How to read this<\/summary>/.test(lc));
  check('and the notes that explain an empty or clipped chart stay on show', /offTop \+ tiny \+ thin \+/.test(lc) && /No gold line yet/.test(lc));
  check('a post too small for the scale says so with its own recorded count, instead of a silent rescale',
    /const tiny = fLast && isFinite\(scTop\) && peak\(fPts\) < scTop \* 0\.1/.test(lc) && /too few to show on this scale yet, so its line runs along the bottom/.test(lc) &&
    /const fLast = hasFocus \? focus\.filter\(p => p\[0\] <= TTC_SPAN\)\.pop\(\) : null;/.test(lc));
  check('the card’s ids are all still there', ['latestCard', 'latestPrev', 'latestNext', 'latestPos', 'latestCover', 'latestTitle', 'latestMetaLine', 'latestContent']
    .every(id => TT.includes('id="' + id + '"')));
  check('the caption is shown whole, its hashtags only set quieter', /const capHtml = v => esc\(capOf\(v\)\)\.replace\(TAG_RE, m => '<span class="ptag">' \+ m \+ '<\/span>'\);/.test(TT) &&
    /\$\('latestTitle'\)\.innerHTML = capHtml\(v\);/.test(TT) && /\$\('ttdTitle'\)\.innerHTML = capHtml\(v\);/.test(TT));
  check('the folds remember being open across a repaint', /document\.addEventListener\('toggle', e => \{[\s\S]{0,160}foldOpen\[d\.dataset\.fold\] = d\.open;/.test(TT) &&
    /const foldAttr = k => ' data-fold="' \+ k \+ '"' \+ \(foldOpen\[k\] \? ' open' : ''\);/.test(TT));
  check('and a post opened afresh in the drawer starts folded', /foldOpen\['drawer-more'\] = false; foldOpen\['drawer-how'\] = false;/.test(fnOf('ttdOpen')));
}

/* ---------- 6. motion: a fold you open draws what it reveals ---------- */
console.log('\nmotion.js and the folds');
{
  check('it listens for toggle in the capture phase (toggle does not bubble)', /doc\.addEventListener\('toggle', guard\(e => \{[\s\S]*?\}\), true\);/.test(MOTION));
  const h = MOTION.slice(MOTION.indexOf("doc.addEventListener('toggle'"), MOTION.indexOf('}), true);', MOTION.indexOf("doc.addEventListener('toggle'")));
  check('only for a cc-more fold', /d\.matches\('details\.cc-more'\)/.test(h));
  check('only one YOU opened — a fold rebuilt open on a poll stays still', /if \(!p \|\| p\.el !== d \|\| now\(\) - p\.t > 1500\) return;/.test(h) &&
    /if \(fold\) \{ foldPress = \{ el: fold, t: now\(\) \}; return; \}/.test(MOTION));
  check('and then it opens a reset over the fold and scans it, forced', /reset\(d, 1500\);\s*foldScans\.push\(d\);\s*schedule\(\);/.test(h) &&
    /if \(foldScans\.length\) foldScans\.splice\(0\)\.forEach\(d => \{ if \(d\.isConnected && d\.open\) scan\(d, true, 60\); \}\);/.test(MOTION));
  check('a chart inside a closed fold counts as not shown, so it is left still (drawn), never armed and paused',
    /const shown = el => el\.isConnected && el\.getClientRects\(\)\.length > 0 && !inClosedFold\(el\);/.test(MOTION) &&
    /if \(!shown\(el\)\) \{ stills\.push\(el\); return; \}/.test(MOTION));
  check('a summary is still a control (it can be pressed)', /const CTL_SEL = '[^']*summary/.test(MOTION));
  check('the fold’s own press opens no card-wide reset (a poll would replay the whole card)',
    MOTION.indexOf('if (fold) { foldPress') < MOTION.indexOf("const drawer = tg.closest('.drawer');"));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
