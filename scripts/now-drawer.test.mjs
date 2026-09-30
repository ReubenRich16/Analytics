// The Now room tiles, the away card, the velocity strip, and the per-post drawer's charts —
// the "Accuracy: now-drawer-charts" fixes, run against the page's own code.
//
//   · the away card: its absence is frozen and re-read on resume, yesterday is ranked among
//     whole local days in plain words, the headline names its basis, followers end at the
//     live count, and fmtAgo never rounds an age up;
//   · the stat tiles: a partial list books nothing, deltas come from posts seen twice, the
//     Likes tile is the profile total, and a real loss is shown as one;
//   · the velocity strip: no fake '+0' where recorded bars meet live ones, a long refresh is
//     a background bar that does not set the scale, and a post published mid-session counts;
//   · Avg views/day: no daily figure under a day old, sorted last either way;
//   · the drawer: the 48-hour line reads the hourly record instead of denying it exists,
//     launch curves vote only finished launches and are scaled to this post, the race
//     label counts real rows, the minute chart counts real readings, hashtags compare
//     median to median without the post itself, and count axes have whole-number ticks.
//
// Run: node scripts/now-drawer.test.mjs
import fs from 'fs';
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');
const YT = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const lift = (src, name) => {
  const i = src.indexOf(name);
  if (i < 0) throw new Error('not found: ' + name);
  return src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n';
};
const fn = name => lift(TT, name);
const arrow = (src, name) => {
  const i = src.indexOf(name);
  if (i < 0) throw new Error('not found: ' + name);
  return src.slice(i, src.indexOf('\n  };\n', i)) + '\n  };\n';
};
const line = (src, start) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('not found: ' + start);
  return src.slice(i, src.indexOf('\n', i)) + '\n';
};
const MIN = 60e3, HOUR = 3600e3, DAY = 864e5;
const fmtUS = new Intl.NumberFormat('en-US');

console.log('\nfmtAgo never rounds an age up');
for (const [page, src] of [['tiktok.html', TT], ['index.html', YT]]) {
  const NOW = 1786000000000;
  const f = new Function('NOW', `const Date = { now: () => NOW };\n${arrow(src, '  const fmtAgo = ts =>')}\nreturn fmtAgo;`)(NOW);
  check(page + ': 36 hours is "36h", not "2d"', f(NOW - 36 * HOUR) === '36h ago', f(NOW - 36 * HOUR));
  check(page + ': 59.6 minutes is "59m", not "60m"', f(NOW - 59.6 * MIN) === '59m ago', f(NOW - 59.6 * MIN));
  check(page + ': 2.9 days is "2d"', f(NOW - 2.9 * DAY) === '2d ago', f(NOW - 2.9 * DAY));
  check(page + ': 47.9 hours is still hours', f(NOW - 47.9 * HOUR) === '47h ago', f(NOW - 47.9 * HOUR));
}

console.log('\nthe away card');
{
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const NOW = noon.getTime();
  const make = (hist, videos, me, awaySince, awayUntil) => new Function('hist', 'videos', 'me', 'awaySince', 'awayUntil', 'NOW', `
    const RealDate = globalThis.Date;
    class Date extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
    const fmt = new Intl.NumberFormat('en-US'), esc = s => String(s);
    const ALERT_DAYS = 14, AWAY_MIN = 30 * 60e3;
    const capOf = v => v.title || '';
    ${TT.slice(TT.indexOf('  const clip = (s, n) =>'), TT.indexOf('\n', TT.indexOf('  const escAttr = ')) + 1)}
    ${arrow(TT, '  const fmtAgo = ts =>')}
    ${arrow(TT, '  const hourSpan = at =>')}
    ${line(TT, '  const fseries = () =>')}${line(TT, '  const fAtOrBefore = ')}${line(TT, '  const ATB = ')}${line(TT, '  const ordinal = ')}${line(TT, '  const TT_GAP = ')}
    ${fn('function ttGainBuckets(from)')}
    ${fn('function recDayGains(days)')}
    ${fn('function ttAwayLen()')}
    ${fn('function ttAwayHeadHtml(list)')}
    ${fn('function ttMomentsHtml()')}
    return { ttAwayHeadHtml, ttMomentsHtml };`)(hist, videos, me, awaySince, awayUntil, NOW);

  // one post, recorded every 30 minutes for the last 16 days; day k back gains g(k) views
  const dayStart = k => { const d = new Date(NOW); d.setDate(d.getDate() - k); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const build = gain => {
    const s = []; let v = 1000;
    for (let t = dayStart(16); t <= NOW; t += 30 * MIN) {
      const d = new Date(t); d.setHours(0, 0, 0, 0);
      const k = Math.round((dayStart(0) - d.getTime()) / DAY);
      v += gain(k) / 48;
      s.push([t, Math.round(v), 0, 0, 0]);
    }
    return { videos: { p: { create_time: Math.floor(dayStart(20) / 1000), title: 'a post', s } }, followers: [] };
  };
  const yline = html => (html.replace(/<\/?span[^>]*>/g, '').match(/Yesterday: [^<]*<b>[^<]*<\/b> — [^<]*/) || [''])[0];

  const best = make(build(k => k === 1 ? 4800 : 480), [{ id: 'p' }], {}, null, null).ttMomentsHtml();
  check('a best yesterday says what it is best of', /— your best of the last 14 full days tracked$/.test(yline(best)) && /<span class="cc-win">your best of the last 14 full days tracked<\/span>/.test(best), yline(best));
  const tied = make(build(k => k === 1 || k === 4 ? 4800 : 480), [{ id: 'p' }], {}, null, null).ttMomentsHtml();
  check('a yesterday tied for best says "joint best", and is not celebrated as a record',
    /— joint best of the last 14 full days tracked$/.test(yline(tied)) && !/cc-win/.test(tied), yline(tied));
  const level = make(build(() => 480), [{ id: 'p' }], {}, null, null).ttMomentsHtml();
  check('a yesterday level with every other day says so, not "your best"',
    /— level with every other day of the last 14 full days tracked$/.test(yline(level)) && !/cc-win/.test(level), yline(level));
  const midTie = make(build(k => k === 1 || k === 6 ? 2400 : k >= 10 ? 4800 : 480), [{ id: 'p' }], {}, null, null).ttMomentsHtml();
  check('a tie in the middle says "joint", not a sole place', /— joint 6th best of the last 14 full days tracked$/.test(yline(midTie)), yline(midTie));
  const quiet = make(build(k => k === 1 ? 48 : 480 + k * 48), [{ id: 'p' }], {}, null, null).ttMomentsHtml();
  check('the quietest day is called that, not "14th best"', /— your quietest of the last 14 full days tracked$/.test(yline(quiet)) && !/cc-win/.test(quiet), yline(quiet));
  const second = make(build(k => k === 1 ? 96 : k === 5 ? 48 : 480 + k * 48), [{ id: 'p' }], {}, null, null).ttMomentsHtml();
  check('second from the bottom is "2nd quietest"', /— 2nd quietest of the last 14 full days tracked$/.test(yline(second)), yline(second));
  const mid = make(build(k => k === 1 ? 480 + 12 * 48 + 24 : 480 + k * 48), [{ id: 'p' }], {}, null, null).ttMomentsHtml();
  check('the upper half reads as "Nth best"', /— 3rd best of the last 14 full days tracked$/.test(yline(mid)) && !/cc-win/.test(mid), yline(mid));
  check('and the days are the Trends card\'s days, on its coverage rules, so the two agree',
    /const day = recDayGains\(ALERT_DAYS \+ 1\);/.test(fn('function ttMomentsHtml()')));

  // the headline: frozen absence, its basis, and followers from the live count
  const hist = build(() => 480);
  hist.followers = [[NOW - 20 * HOUR, 200, 1, 1], [NOW - 12 * HOUR, 203, 1, 1], [NOW - 2 * HOUR, 205, 1, 1]];
  const away = NOW - 19 * HOUR;
  const vids = [{ id: 'p' }, { id: 'q' }, { id: 'r' }];
  const head = make(hist, vids, { follower_count: 207 }, away, away + 19 * HOUR - 0).ttAwayHeadHtml([]);
  check('the headline says which posts its views cover when the store holds fewer',
    /views<\/b> on your 1 newest posts/.test(head), head);
  check('followers run to the live count in the header (207 − 200)', /\+7 followers<\/b>/.test(head), head);
  const later = make(hist, vids, { follower_count: 207 }, away, NOW - 2 * HOUR).ttAwayHeadHtml([]);
  check('the absence is measured to when she came back, not to now', /In the <b>17h<\/b> since you last looked: /.test(later), later);
  const stale = { ...hist, followers: [[NOW - 30 * HOUR, 190, 1, 1], [NOW - 2 * HOUR, 205, 1, 1]] };
  const nofol = make(stale, vids, { follower_count: 207 }, away, NOW).ttAwayHeadHtml([]);
  check('followers are left out when the nearest snapshot is over 3h before she left', !/follower/.test(nofol), nofol);
  const all = make(hist, [{ id: 'p' }], { follower_count: 207 }, away, NOW).ttAwayHeadHtml([]);
  check('and says just "your posts" when it holds every listed post', /views<\/b> on your posts/.test(all), all);

  const vis = TT.slice(TT.indexOf('function resumeSeen()'), TT.indexOf("window.addEventListener('pageshow'"));
  check('a resumed tab re-reads the away stamp, but only after a real absence',
    /if \(v && Date\.now\(\) - v >= AWAY_MIN\) loadSeen\(\);/.test(vis) && /resumeSeen\(\); poll\(\);/.test(vis));
  check('and a page restored from the back-forward cache does too', /addEventListener\('pageshow', e => \{\s*\n\s*if \(e\.persisted/.test(TT));
  check('loadSeen freezes when she came back', /awayUntil = Date\.now\(\);\s*\n\s*touchSeen\(\);/.test(fn('function loadSeen()')));
}

console.log('\nthe stat tiles');
{
  const p = fn('async function poll(force)');
  check('a partial list keeps the last full reading and books nothing',
    /if \(v\.partial && videos\.length && got\.length < videos\.length\) \{\s*\n\s*setStatus\('TikTok sent only part of the list — showing the last full reading'\);\s*\n\s*return;/.test(p));
  check('with no earlier list the table label says so', /' \\u00b7 TikTok sent only part of the list'/.test(TT));
  check('velocity runs before the tiles, and its per-post step is their delta',
    p.indexOf('const step = renderVelocity();') > 0 && p.indexOf('const step = renderVelocity();') < p.indexOf("animateNum(el"));
  check('the Likes tile is the profile total the header shows', /likes: me\.likes_count \|\| 0/.test(p));
  check('a real loss prints as one, never "±0"', /else if \(d < 0\) \{ de\.textContent = '−' \+ fmt\.format\(-d\); de\.className = 'delta down'; \}/.test(p));
  check('a moved sum with no per-post gain prints nothing', /step\[k\] > 0 \? step\[k\] : \(totals\[k\] === prevTotals\[k\] \? 0 : null\)/.test(p));
  check('the Views and Comments labels name the newest N when the account has more',
    /'Views · newest ' \+ videos\.length/.test(p) && /'Comments · newest ' \+ videos\.length/.test(p));
  check('the tiles say what their small figure measures',
    (TT.match(/title="Change since the last refresh, counting only posts seen both times"/g) || []).length === 2);
  check('a loss has its own colour', /\.stat \.delta\.down \{ color:var\(--down\); \}/.test(fs.readFileSync(new URL('../yt-dashboard/style.css', import.meta.url), 'utf8')));
}

console.log('\nthe velocity strip');
{
  const body = fn('function renderVelocity()');
  const run = new Function('$', 'fmt', 'document', 'videos', 'state', 'NOW', `
    const Date = { now: () => NOW };
    let { perPost, velHistory, velSession, velStart, velBg, velLastAt, velBackfilled } = state;
    const MAX_BARS = 60, intervalMs = 60000, backBin = () => 60e3;
    const saveVel = () => {};
    ${body}
    const step = renderVelocity();
    return { perPost, velHistory, velSession, velStart, velBg, velLastAt, velBackfilled, step };`);
  const els = {};
  const $ = id => (els[id] = els[id] || { style: {}, children: [], textContent: '', set innerHTML(v) { this.children = []; }, get innerHTML() { return ''; }, appendChild(c) { this.children.push(c); } });
  const document = { createElement: () => ({ style: {}, className: '', title: '' }) };
  const post = (id, v, ct) => ({ id, view_count: v, like_count: 1, comment_count: 1, share_count: 1, create_time: ct || 1 });
  const T = 1786000000000;
  // a cold open after backfill: a session exists, the per-post baseline does not
  let st = { perPost: {}, velHistory: [5, 9], velSession: { views: 0, likes: 0, comments: 0, shares: 0 }, velStart: T, velBg: [0, 0], velLastAt: 0, velBackfilled: 2 };
  st = run($, fmtUS, document, [post('a', 100)], st, T + MIN);
  check('the first reading after backfill only sets the baseline — no fake +0 bar',
    st.velHistory.length === 2 && st.step === null, st.velHistory.join(','));
  check('and the faded bars get a caption', /Faded: recorded before you opened the page \(posts under 2 days old\)\./.test(els.barsNote.textContent), els.barsNote.textContent);
  st = run($, fmtUS, document, [post('a', 110)], st, T + 2 * MIN);
  check('the next reading books a real bar and returns its step', st.velHistory.join(',') === '5,9,10' && st.step.views === 10, st.velHistory.join(','));
  // twelve minutes with the phone locked
  st = run($, fmtUS, document, [post('a', 1310)], st, T + 14 * MIN);
  check('a refresh that covered a long stretch is marked as background time',
    st.velBg[st.velBg.length - 1] === 12 && st.velSession.views === 1210, JSON.stringify(st.velBg));
  const bars = els.bars.children;
  const last = bars[bars.length - 1];
  check('its bar says so, and is faded', /\+1,200 views while the page was in the background \(12 min\)/.test(last.title) && /back/.test(last.className), last.title);
  check('and does not set the scale: the ordinary 10 is still the tallest', bars[2].style.height === '100%', bars[2].style.height);
  check('a faded backfilled bar says it covers one minute', /\+5 views in that minute — recorded before this tab opened/.test(bars[0].title), bars[0].title);
  check('the rate says it is an average since the page opened', /views\/min since opening/.test(fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8')));
  // a post published after the page opened starts from zero
  st = run($, fmtUS, document, [post('a', 1310), post('new', 40, Math.floor((T + 5 * MIN) / 1000))], st, T + 15 * MIN);
  check('a post published mid-session counts its first views', st.perPost.new.sessV === 40 && st.velSession.views === 1250,
    JSON.stringify(st.perPost.new));
  // an older post returning to the window is still a first sighting
  st = run($, fmtUS, document, [post('a', 1310), post('new', 40, Math.floor((T + 5 * MIN) / 1000)), post('old', 9000, 1)], st, T + 16 * MIN);
  check('an old post coming back into the window adds nothing', st.perPost.old.sessV === 0 && st.velSession.views === 1250);

  const p = fn('async function poll(force)');
  check('a live tab left for over half an hour starts a fresh session, like a reload',
    /if \(velSession && velLastAt && Date\.now\(\) - velLastAt > VEL_RESUME\) \{/.test(p) && /velHistory = backfillBars\(\);/.test(p));
  check('the backfill bins by the refresh interval, never under a minute', /Math\.max\(intervalMs \|\| 60e3, 60e3\)/.test(TT) &&
    /Math\.floor\(\(now - arr\[i\]\[0\]\) \/ bin\)/.test(fn('function backfillBars()')));
}

console.log('\nAvg views/day');
{
  const NOW = 1786000000000;
  const P = new Function('NOW', `
    const Date = { now: () => NOW };
    const fmt = new Intl.NumberFormat('en-US');
    ${line(TT, '  const ageDays = ')}
    ${line(TT, '  const paceOf = ')}
    ${arrow(TT, '  const youngCount = v =>')}
    return { paceOf, youngCount };`)(NOW);
  const young = { view_count: 93, create_time: (NOW - 3 * HOUR) / 1000 };
  const older = { view_count: 900, create_time: (NOW - 3 * DAY) / 1000 };
  check('under a day old there is no daily figure', P.paceOf(young) === null);
  check('a post past a day gets its lifetime average', Math.round(P.paceOf(older)) === 300, P.paceOf(older));
  check('the young post shows its real count and age instead', P.youngCount(young) === '93 in 3h', P.youngCount(young));

  // the table comparator: no-figure posts last in BOTH directions
  const cmp = (TT.match(/const rows = videos\.slice\(\)\.sort\(\(a, b\) => \{[\s\S]*?\n    \}\);/) || [''])[0];
  const sortBy = dir => new Function('videos', 'get', 'dir', cmp + '\nreturn rows.map(r => r.id);')(
    [{ id: 'y', p: null, create_time: 3 }, { id: 'a', p: 10, view_count: 1 }, { id: 'b', p: 50, view_count: 1 }], v => v.p, dir);
  check('sorted high to low, the under-a-day post is last', sortBy(-1).join('') === 'bay', sortBy(-1).join(''));
  check('and sorted low to high it is still last', sortBy(1).join('') === 'aby', sortBy(1).join(''));
  check('the column is named as the average it is',
    /title="Average views per day since posting \(total ÷ age\) — not today's speed\. Click to sort">Avg\/day</.test(TT) &&
    /data-label="Avg views\/day"/.test(TT) && /Sort: average views\/day/.test(TT));
  check('the drawer cell says why it has no daily rate', /mcell\('Avg views\/day', youngCount\(v\), 'too new for a daily rate'\)/.test(TT));
}

console.log('\nwhere this one is heading, for an old post');
{
  const body = fn('function pjBodyHtml(p, views, curve, refs, age, life48)');
  const B = new Function(`
    const fmt = new Intl.NumberFormat('en-US');
    const PJ_HORIZON = 2880, PJ_WEEK = 10080, PJ_MIN_AGE = 300;
    let pjView = 'bar';
    const pjAt = () => null, pjWaitHtml = () => '', pjDur = () => '', pjCurveHtml = () => '<svg/>', pjBarHtml = () => '', pjWeekHtml = () => '', pjWeekWaitHtml = () => '';
    ${body}
    return pjBodyHtml;`)();
  const withLife = B({ state: 'settled' }, 5000, null, [], 4 * 1440, 3100);
  check('the hourly record gives the 48-hour figure when the launch is not loaded',
    /About <b>3,100 views<\/b> by the end of its first 48 hours \(from the hourly chart\), and it has added 1,900 since\./.test(withLife), withLife);
  const none = B({ state: 'settled' }, 5000, null, [], 4 * 1440, null);
  check('without it, nothing is asserted about whether it was recorded',
    /Its close-up counts aren’t kept on this page \(only your newest posts’ are\)/.test(none) && !/none of the launch was recorded/.test(none), none);
  const done = B({ state: 'done' }, 5000, null, [], 20 * 1440, null);
  check('past a week it says there is nothing left to estimate and points below',
    /Its first week is over, so there is nothing left to estimate — its total views are the number to go by\. The hourly chart below shows how it got there\./.test(done), done);
  const doneLife = B({ state: 'done' }, 5000, null, [], 20 * 1440, 3100);
  check('and past a week with the record, it gives the figure and retires', /About <b>3,100 views<\/b>/.test(doneLife) && /nothing left to estimate/.test(doneLife), doneLife);
}

console.log('\nlaunch curves');
{
  let got = null;
  const L = new Function('hist', 'NOW', 'capture', `
    const Date = { now: () => NOW };
    const fmt = new Intl.NumberFormat('en-US'), esc = s => String(s);
    const fmtAge = m => Math.round(m) + 'm';
    const PJ_HORIZON = 2880, PJ_COVER = 44 * 60, PJ_GAP = 60;
    ${fn('function niceScale(lo, hi, target, int)')}
    ${line(TT, '  const pjMed = ')}
    ${fn('function pjAt(c, t)')}
    ${fn('function pjClean(c)')}
    ${fn('function pjCurveOf(id, createTime, rec)')}
    ${line(TT, '  const TTC_SPAN = ')}${line(TT, '  const TTC_STEP = ')}${line(TT, '  const TTC_MAX = ')}${line(TT, '  const TTC_MIN_VOTES = ')}
    ${fn('function ttcAt(c, t)')}
    ${line(TT, '  const ttLaunchGrid = ')}
    const multiLineHtml = (series, tips, opts) => { capture(series, opts); return '<svg/>'; };
    const holder = { innerHTML: '' };
    const $ = () => holder;
    let ttRaceCur = null;
    ${fn('function ttLaunchCurves(v, mount)')}
    return v => { ttLaunchCurves(v, holder); return holder.innerHTML; };`);
  const NOW = 1786000000000;
  const mk = (ageMin, final, upTo) => {
    const t0 = NOW - ageMin * MIN, s = [];
    for (let m = 0; m <= Math.min(upTo, ageMin); m += 10) s.push([t0 + m * MIN, Math.round(final * Math.min(1, m / 1200))]);
    return { create_time: t0 / 1000, s };
  };
  const hist = { videos: {
    f1: mk(5000, 1000, 2880), f2: mk(6000, 1200, 2880),
    viral: mk(7000, 90000, 2880),
    running: mk(600, 50, 2880)          // 10 hours old: unfinished, must not vote
  } };
  const target = { id: 'me', create_time: (NOW - 300 * MIN) / 1000 };
  hist.videos.me = mk(300, 800, 2880);
  const html = L(hist, NOW, (series, opts) => { got = { series, opts }; })(target);
  const gold = got.series.find(s => s.name === 'Your usual post').pts;
  // at 5 hours: finished 250, 300, 22,500 → median 300; the 10-hour-old post (12.5) would pull it to 275
  check('an unfinished launch does not vote on the typical line', gold[10] === 300, gold[10]);
  check('the scale follows this post and the typical line, not the viral one', got.opts.yMax > 0 && got.opts.yMax < 10000, got.opts.yMax);
  check('and the viral line is counted as running off the top', /1 other post runs off the top\./.test(html), html);
  check('the title and explainer say what the grey lines are', /First 48 hours — this post vs your others/.test(html) &&
    /Grey lines are up to 8 of your newest other posts/.test(html), html);
  const noFocus = L({ videos: { f1: hist.videos.f1, f2: hist.videos.f2 } }, NOW, (series, opts) => { got = { series, opts }; })({ id: 'gone', create_time: (NOW - 9000 * MIN) / 1000 });
  check('with no line for this post it says so instead of pointing at one', /this post’s own first 48 hours aren’t loaded here/.test(noFocus) && !/bright line/.test(noFocus), noFocus);
  const thin = L({ videos: { running: hist.videos.running } }, NOW, () => {})(target);
  check('the thin note counts finished launches on this page', /tracked without gaps through their first 48 hours, and this page has 0 so far/.test(thin), thin);
}

console.log('\nthe minute chart');
{
  const M = new Function('hist', 'videos', 'NOW', 'capture', `
    const Date = { now: () => NOW };
    const fmt = new Intl.NumberFormat('en-US');
    const PJ_HORIZON = 2880;
    const fmtAgo = ts => Math.round((NOW - ts) / 60000) + 'm ago';
    const lineChart = (pts, c, l, o) => { capture(o); return '<svg/>'; };
    ${fn('function ttMinuteChartHtml(v)')}
    return ttMinuteChartHtml;`);
  const NOW = 1786000000000;
  let opts = null;
  const t0 = NOW - 4 * DAY;
  // 3 raw readings and 2 launch points (bare [ts, views])
  const rec = { create_time: t0 / 1000, s: [[t0 + MIN, 5, 0, 0, 0], [t0 + 5 * MIN, 9], [t0 + 6 * MIN, 12, 1, 0, 0], [t0 + 10 * MIN, 15], [t0 + 3 * DAY, 400, 9, 1, 0]] };
  const v = { id: 'p', create_time: t0 / 1000 };
  const html = M({ videos: { p: rec } }, [v], NOW, o => { opts = o; })(v);
  check('past 48 hours it is plainly titled, with the cadence', /<h4>Views since it went live<\/h4>/.test(html) && !/as recorded/.test(html) &&
    /Every minute for the first 48 hours, then every 15 minutes or hourly\./.test(html), html);
  check('only real readings are counted, not launch-curve points', /3 counts · first /.test(html), html);
  check('its axis ticks are whole numbers', opts.int === true);
  const vids = []; for (let i = 0; i < 25; i++) vids.push({ id: 'n' + i, create_time: (NOW - i * HOUR) / 1000 });
  const oldV = { id: 'old', create_time: (NOW - 30 * DAY) / 1000 };
  const out = M({ videos: {} }, [...vids, oldV], NOW, () => {})(oldV);
  check('a post outside the 20 newest is told it dropped out of this chart', /This chart keeps your 20 newest posts, so this one has dropped out of it\./.test(out), out);
  const fresh = { id: 'fresh', create_time: (NOW - 2 * HOUR) / 1000 };
  const nw = M({ videos: {} }, [fresh], NOW, () => {})(fresh);
  check('a new post is told it will be picked up within minutes', /new posts are picked up within about five minutes and tracked automatically from then on/.test(nw), nw);
}

console.log('\nhashtags in the drawer');
{
  const H = new Function('videos', 'scores', `
    const esc = s => String(s);
    const section = (t, e, b) => t + '|' + e + '|' + b;
    ${line(TT, '  const pjMed = ')}
    ${line(TT, '  const hashtagsOf = ')}
    const scoreOf = v => scores[v.id] == null ? null : scores[v.id];
    const scored = () => videos.filter(v => scoreOf(v) != null);
    ${fn('function ttdHashtagsHtml(v)')}
    return ttdHashtagsHtml;`);
  const vids = [
    { id: 'me', title: '#dance' }, { id: 'a', title: '#dance' }, { id: 'b', title: '#dance' }, { id: 'c', title: '#dance' },
    { id: 'd', title: 'x' }, { id: 'e', title: 'y' }
  ];
  // one viral #dance post: a mean would read 400%; the median of the others is 100
  const scores = { me: 50000, a: 100, b: 100, c: 1000, d: 100, e: 100 };
  const out = H(vids, scores)(vids[0]);
  check('the tag figure is median against median, without the post itself', /#dance <b>100%<\/b>/.test(out), out);
  check('the explainer says so', /How your other posts with each tag do, next to your usual post: 100% is usual/.test(out) && /typical \(middle\) views/.test(out));
  const once = H([{ id: 'me', title: '#rare' }, { id: 'a', title: '#rare' }, { id: 'b', title: 'x' }], { me: 5, a: 5, b: 5 })({ id: 'me', title: '#rare' });
  check('a tag on only one other post gets no figure', !/%/.test(once.split('|')[2]), once);
}

console.log('\nthe race label counts its rows');
{
  const r = fn('function renderTtRace(v, mount)');
  check('the label uses the real number of rivals, singular when one',
    /const n = rivals\.length, pl = n === 1 \? '' : 's';/.test(r) && /' newest other post' \+ pl/.test(r) && /' other post' \+ pl \+ ' with the most views/.test(r));
}

console.log('\ncount axes have whole-number ticks');
for (const [page, src] of [['tiktok.html', TT], ['index.html', YT]]) {
  const ns = new Function(lift(src, 'function niceScale(lo, hi, target, int)') + '\nreturn niceScale;')();
  const frac = ns(0, 2, 4), whole = ns(0, 2, 4, true);
  check(page + ': without int a tiny range still steps in fractions', frac.ticks.some(t => t % 1));
  check(page + ': with int every tick is a whole number', whole.ticks.every(t => t % 1 === 0), whole.ticks.join(','));
  check(page + ': and a 2.5 step becomes 2', !ns(0, 9, 4, true).ticks.some(t => t % 1), ns(0, 9, 4, true).ticks.join(','));
}
check('every TikTok count chart asks for whole ticks',
  /'Views per day', \{ at, tips, int: true/.test(TT) && /'Follower history', \{ at, tips, int: true/.test(TT) &&
  /at, tips, int: true, x0: lifeAgeTxt/.test(TT) && /int: true, yMax/.test(TT) && /at: rec\.s\.map\(s => s\[0\]\), int: true/.test(TT) &&
  /niceScale\(0, ceil, 4, true\)/.test(TT));

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
