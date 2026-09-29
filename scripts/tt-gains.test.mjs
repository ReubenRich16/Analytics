// The recording layer: what the page counts as views gained, and what it keeps.
//
// Every "views recorded" number on the TikTok page (the away headline, Biggest hour, the
// Yesterday rank, Today so far, Last 7 / Prior 7, Views per day and the hour clock) comes
// out of ttGainBuckets reading hist.videos. These tests run the page's own code, lifted
// out of tiktok.html, against stores shaped the way the Worker really fills them:
//
//   · launch points from /tiktok/launches merged beside the raw minute samples. They used
//     to be stamped at the start of each five-minute bucket while carrying its max, so the
//     store zigzagged and every climb back was counted again (about 1.8x a launch);
//   · a count that TikTok revises down and back up, which is not new views;
//   · a hole in the recording, whose jump must not land in one hour or one day;
//   · the milestone feed, the velocity strip and the accelerating mark, which had the same
//     dip-and-recover and uneven-window faults;
//   · a failed follower read, which must not wipe the stored follower history;
//   · buildScores, which let a 44-48h post vote on its own projection.
//
// Run: node scripts/tt-gains.test.mjs
import fs from 'fs';
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');
const YT = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

// the repo's lift-it-out-of-the-page pattern: slice a function to its first two-space `}`
const lift = (src, name) => {
  const i = src.indexOf(name);
  if (i < 0) throw new Error('not found: ' + name);
  return src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n';
};
const fn = name => lift(TT, name);

const MIN = 60e3, HOUR = 3600e3, DAY = 864e5;
// a whole local hour, well in the past, so no test depends on the time it runs
const base = new Date(); base.setDate(base.getDate() - 5); base.setHours(10, 0, 0, 0);
const T0 = base.getTime();
const NOW = T0 + 4 * DAY;

/* The store and the gain buckets, run together: mergeHist is how both /history and
   /launches reach the store, and ttGainBuckets is what every total reads. */
const mk = () => new Function('NOW', `
  const Date = globalThis.Date; const realNow = Date.now;
  let hist = { videos: {} }, histOwner = '', histSince = 0;
  const newestTs = h => { let m = 0; for (const r of Object.values((h && h.videos) || {})) for (const s of (r.s || [])) if (s[0] > m) m = s[0]; return m; };
  const localStorage = { setItem() {} };
  ${fn('function dropEarlyLaunchPts(arr)')}
  ${fn('function mergeHist(b)')}
  ${(TT.match(/  const TT_GAP = [^\n]*\n/) || [''])[0]}
  ${fn('function ttGainBuckets(from)')}
  return {
    get hist() { return hist; }, set hist(h) { hist = h; },
    mergeHist, dropEarlyLaunchPts,
    gains: from => { Date.now = () => NOW; try { return ttGainBuckets(from); } finally { Date.now = realNow; } }
  };
`)(NOW);

// An S-shaped launch recorded every minute by the Worker, as raw 5-element samples on the
// minute grid, and what /tiktok/launches makes of it: MAX(views) per five-minute bucket.
const CT = Math.floor((T0 + 17e3) / 1000);   // create_time: whole seconds, off the minute grid
const t0 = CT * 1000;
const views = m => Math.round(5000 / (1 + Math.exp(-(m / 60 - 6) / 2)) - 5000 / (1 + Math.exp(3)));
const raw = [];
for (let slot = Math.ceil(t0 / MIN) * MIN; slot <= t0 + 48 * HOUR; slot += MIN) raw.push([slot, views((slot - t0) / MIN), 1, 0, 0]);
const TRUE = raw[raw.length - 1][1] - raw[0][1];
const buckets = new Map();
for (const r of raw) {
  const b = Math.floor((r[0] - t0) / (5 * MIN)), cur = buckets.get(b);
  if (!cur || r[1] > cur.v) buckets.set(b, { b, v: r[1], t: r[0] });
}
const oldPts = [...buckets.values()].map(x => [t0 + x.b * 5 * MIN, x.v]);              // bucket start
const exactPts = [...buckets.values()].map(x => [Math.round(t0 + ((x.t - t0) / MIN) * MIN), x.v]);   // the reading's own time

console.log('\nlaunch points merged beside the raw samples');
{
  const S = mk();
  S.mergeHist({ videos: { p: { create_time: CT, s: raw.map(r => r.slice()) } } });
  S.mergeHist({ videos: { p: { create_time: CT, s: exactPts } } });
  const g = S.gains(T0 - DAY);
  check('exact-age launch points coincide with the raw samples, so nothing is added',
    S.hist.videos.p.s.length === raw.length, S.hist.videos.p.s.length + ' vs ' + raw.length);
  check('and a launch point never replaces the full raw reading it came from',
    S.hist.videos.p.s.every(s => s.length === 5));
  check('the gain is the true gain', g.total === TRUE, g.total + ' vs ' + TRUE);

  // the old Worker's start-stamped points, saved into a store before this fix
  const O = mk();
  O.hist = { videos: { p: { create_time: CT, s: [...raw.map(r => r.slice()), ...oldPts].sort((a, b) => a[0] - b[0]) } } };
  // what the old rule (every rise over the previous reading) made of that store
  const zz = O.hist.videos.p.s;
  let pairwise = 0;
  for (let i = 1; i < zz.length; i++) if (zz[i][1] > zz[i - 1][1]) pairwise += zz[i][1] - zz[i - 1][1];
  check('the fixture reproduces the old double count (' + (pairwise / TRUE).toFixed(2) + 'x under the old rule)', pairwise > TRUE * 1.5);
  const before = O.gains(T0 - DAY).total;
  check('the high-water rule alone already counts that store within 1%', Math.abs(before - TRUE) <= TRUE * 0.01, before + ' vs ' + TRUE);
  O.hist.videos.p.s = O.dropEarlyLaunchPts(O.hist.videos.p.s);
  const after = O.gains(T0 - DAY).total;
  check('cleaning a saved store drops the early copies that sit among raw readings',
    O.hist.videos.p.s.length === raw.length, O.hist.videos.p.s.length + ' vs ' + raw.length);
  check('regression: raw minute samples plus bucket-max launch points count the true gain within 1%',
    Math.abs(after - TRUE) <= TRUE * 0.01, after + ' vs ' + TRUE);

  // and merging old points through mergeHist cleans them on the way in
  const M = mk();
  M.mergeHist({ videos: { p: { create_time: CT, s: raw.map(r => r.slice()) } } });
  M.mergeHist({ videos: { p: { create_time: CT, s: oldPts } } });
  const gm = M.gains(T0 - DAY).total;
  check('merging start-stamped points never inflates the total', Math.abs(gm - TRUE) <= TRUE * 0.01, gm + ' vs ' + TRUE);

  // a launch point with no raw reading nearby is the only record of that stretch, and stays
  const H = mk();
  H.mergeHist({ videos: { p: { create_time: CT, s: raw.filter(r => r[0] < t0 + 2 * HOUR || r[0] > t0 + 20 * HOUR).map(r => r.slice()) } } });
  H.mergeHist({ videos: { p: { create_time: CT, s: oldPts } } });
  const inHole = H.hist.videos.p.s.filter(s => s.length === 2 && s[0] > t0 + 2 * HOUR + 10 * MIN && s[0] < t0 + 20 * HOUR - 10 * MIN);
  check('launch points inside a hole in the raw recording are kept', inHole.length > 150, inHole.length);

  check('the page reads the Worker\'s exact ages, and corrects an older Worker\'s start stamps',
    /const lag = b\.ages === 'exact' \? 0 : \(b\.step \|\| 5\) \* 60000 - 30000;/.test(TT) &&
    /s: rec\.s\.map\(p => \[Math\.round\(t0 \+ p\[0\] \* 60000\) \+ lag, p\[1\]\]\)/.test(TT));
  check('a saved store is cleaned when it loads', /r\.s = dropEarlyLaunchPts\(r\.s\)/.test(fn('function loadHist(openId)')));
  check('the old claim that a launch has no live samples to collide with is gone',
    !/has no live samples left inside its window to collide with/.test(TT));
  check('YouTube rounds an exact age onto the recorder\'s whole-minute age',
    /const age = Math\.round\(smp\[0\]\) \+ lag;/.test(YT) && /b\.ages === 'exact' \? 0 : \(b\.step \|\| 5\) - 1/.test(YT));
}

console.log('\na revision and its rebound do not vote');
{
  const S = mk();
  const s = [[T0, 1000, 0, 0, 0], [T0 + MIN, 1010, 0, 0, 0], [T0 + 2 * MIN, 1000, 0, 0, 0],
             [T0 + 3 * MIN, 1010, 0, 0, 0], [T0 + 4 * MIN, 1012, 0, 0, 0]];
  S.hist = { videos: { p: { create_time: CT, s } } };
  check('a dip and a recovery add nothing: 1,000 → 1,010 → 1,000 → 1,010 → 1,012 is +12',
    S.gains(T0 - 1).total === 12, S.gains(T0 - 1).total);
  // the same readings asked about from two windows give the same per-hour answer
  const a = S.gains(T0 + 2 * MIN + 1), b = S.gains(T0 - DAY);
  check('the high-water mark is seeded from before the window, so the rebound still does not count',
    a.total === 2, a.total);
  check('a pair straddling the window start is not counted (the first reading inside counts from itself)',
    S.gains(T0 + 30e3).total === 2, S.gains(T0 + 30e3).total);
  check('and the whole-window answer is unchanged', b.total === 12, b.total);
}

console.log('\na hole in the recording');
{
  const S = mk();
  const s = [];
  for (let m = 0; m <= 60; m += 15) s.push([T0 + m * MIN, 100 + m, 0, 0, 0]);
  const after = T0 + 60 * MIN + 2 * DAY;               // two days with nothing recorded
  s.push([after, 2100, 0, 0, 0], [after + 15 * MIN, 2110, 0, 0, 0]);
  S.hist = { videos: { p: { create_time: CT, s } } };
  const g = S.gains(T0 - DAY);
  const inHours = [...g.hours.values()].reduce((a, b) => a + b.gain, 0);
  const biggest = Math.max(...[...g.hours.values()].map(b => b.gain));
  check('the views across a two-day hole stay in the total', g.total === 60 + 1940 + 10, g.total);
  check('but go into no hour', inHours === 70 && biggest < 100, inHours + ' in hours, biggest ' + biggest);
  const dk = t => new Date(t).toLocaleDateString('en-CA');
  check('every day the hole touches is marked incomplete',
    [T0, T0 + DAY, after].every(t => g.incomplete.has(dk(t))) && g.incomplete.size === 3, [...g.incomplete].join(','));
  // a reading at 11:00 carries the views that came in before 11:00
  const H = mk();
  H.hist = { videos: { p: { create_time: CT, s: [[T0 + 45 * MIN, 10, 0, 0, 0], [T0 + HOUR, 40, 0, 0, 0]] } } };
  const hk = [...H.gains(T0 - DAY).hours.keys()];
  check('a gain read at the top of the hour is filed under the hour before it',
    hk.length === 1 && hk[0] === T0, hk.map(k => new Date(k).toTimeString().slice(0, 5)).join(','));

  // the readers treat an incomplete day as missing
  const rd = fn('function recDayGains(days)');
  check('Views per day and the weeks drop a past day with a hole', /for \(const k of g\.incomplete\) if \(k !== tk\) out\.delete\(k\);/.test(rd));
  const mom = fn('function ttMomentsHtml(');
  check('and Yesterday is not ranked when it has one, nor ranked against one', /for \(const k of gd\.incomplete\) day\.delete\(k\);/.test(mom));
  check('Today so far says when part of today was missed', /part of today wasn’t recorded/.test(TT));
  check('the Trends card says a gap is left out, not guessed',
    /A gap in the recording is left out, not guessed\./.test(TT) && !/a gap in the recording stays a gap/.test(TT));
  check('the away card says how far back it reaches',
    /so it covers the time nobody had this page open, up to the last two weeks\./.test(TT));

  // the hole is backfilled when it can be
  const ph = fn('async function pullHistory()');
  const calls = [];
  const run = since => new Function('api', 'mergeHist', 'histSince', 'NOW', `
    const Date = { now: () => NOW };
    ${ph}
    return pullHistory();`)(async u => { calls.push(u); return null; }, () => {}, since, NOW);
  await run(NOW - HOUR);
  await run(NOW - 5.2 * DAY);
  await run(NOW - 40 * DAY);
  await run(0);
  check('a recent store asks only for what is new', calls[0] === '/tiktok/history?since=' + (NOW - HOUR), calls[0]);
  check('after days away it asks for enough days to reach back to the last sample',
    calls[1] === '/tiktok/history?since=' + (NOW - 5.2 * DAY) + '&days=7', calls[1]);
  check('capped at two weeks', /&days=14$/.test(calls[2]), calls[2]);
  check('and a new browser still asks for the default window', calls[3] === '/tiktok/history', calls[3]);
}

console.log('\nthe YouTube gain buckets follow the same rules');
{
  const G = new Function('hist', 'NOW', 'OWN', `
    const Date = globalThis.Date; const realNow = Date.now;
    const ownIds = () => new Set(OWN || Object.keys(hist.videos || {}));
    ${lift(YT, 'function ytGainBuckets(from)')}
    return from => { Date.now = () => NOW; try { return ytGainBuckets(from); } finally { Date.now = realNow; } };`);
  const arr = [[T0, 998], [T0 + 10 * MIN, 1002], [T0 + 20 * MIN, 998], [T0 + 30 * MIN, 1002], [T0 + 40 * MIN, 1010],
               [T0 + 40 * MIN + DAY, 1500]];
  const g = G({ videos: { v: arr } }, NOW)(T0 - HOUR);
  const inHours = [...g.hours.values()].reduce((a, b) => a + b.gain, 0);
  check('a count flipping between a fresh and a stale reading is counted once', inHours === 12, inHours);
  check('a jump across a day-long gap goes in no hour, only the total', g.total === 502, g.total);
  const old = G({ videos: { v: [[NOW - 20 * DAY, 10], [NOW - 20 * DAY + 10 * MIN, 50]] } }, NOW)(NOW - 30 * DAY);
  check('nothing older than 14 days is read as an hour', old.hours.size === 0 && old.total === 0, old.total);
  // the robot's file holds every tracked channel's videos in one map
  const two = G({ videos: { v: arr, other: [[T0, 100], [T0 + 10 * MIN, 900]] } }, NOW, ['v'])(T0 - HOUR);
  check('another channel\'s video is not counted as yours', two.total === 502 && ![...two.hours.values()].some(b => b.byPost.has('other')), two.total);
}

console.log('\nround numbers are news only the first time');
{
  const feed = fn('function ttAlerts()');
  const run = (f, vids) => new Function('hist', 'videos', 'NOW', `
    const Date = globalThis.Date; const realNow = Date.now;
    const ALERT_DAYS = 14;
    const fmt = new Intl.NumberFormat('en-US');
    const esc = s => String(s);
    const capOf = v => v.title || '';
    ${TT.slice(TT.indexOf('  const clip = (s, n) =>'), TT.indexOf('\n  };\n', TT.indexOf('  const shortCap = ')) + 5)}
    const fseries = () => (hist && Array.isArray(hist.followers) ? hist.followers : []);
    ${fn('function nextMilestone(cur)')}
    ${feed}
    Date.now = () => NOW; try { return ttAlerts(); } finally { Date.now = realNow; }`)({ followers: f, videos: vids }, [], NOW);
  const post = { title: 'Brushing the mic', s: [[NOW - 12 * DAY, 24990], [NOW - 12 * DAY + HOUR, 25004],
    [NOW - 3 * HOUR, 25004], [NOW - 2 * HOUR, 24997], [NOW - HOUR, 25004]] };
  const out = run([], { p: post });
  const hit = out.find(a => a.k === 'v:p');
  check('25,004 → 24,997 → 25,004 does not cross 25,000 again', !!hit && hit.at === NOW - 12 * DAY + HOUR,
    hit ? new Date(hit.at).toISOString() : 'no entry');
  const fo = run([[NOW - 20 * DAY, 240], [NOW - 10 * DAY, 251], [NOW - 2 * DAY, 248], [NOW - DAY, 252]], {});
  const fh = fo.find(a => a.k === 'followers');
  check('a follower count that dips under 250 and back is not a new crossing',
    !!fh && fh.at === NOW - 10 * DAY, JSON.stringify(fo));
  const real = run([[NOW - 20 * DAY, 240], [NOW - 2 * DAY, 248], [NOW - DAY, 255]], {});
  check('a first crossing is still reported', real.some(a => a.k === 'followers' && a.at === NOW - DAY && /250 followers/.test(a.t)),
    JSON.stringify(real));
  const pre = run([[NOW - 20 * DAY, 240], [NOW - 16 * DAY, 251], [NOW - 15 * DAY, 245], [NOW - DAY, 252]], {});
  check('a crossing before the window, recovered inside it, is not news', !pre.some(a => a.k === 'followers'), JSON.stringify(pre));
}

console.log('\nthe velocity strip and +session');
{
  const body = fn('function renderVelocity()');
  const run = new Function('$', 'fmt', 'document', 'videos', 'state', `
    let { perPost, velHistory, velSession, velStart } = state;
    const MAX_BARS = 60;
    let velBackfilled = 0;
    let velBg = state.velBg || [], velLastAt = state.velLastAt || 0;
    const intervalMs = state.intervalMs || 60000, backBin = () => Math.max(intervalMs, 60e3);
    const saveVel = () => {};
    ${body}
    const step = renderVelocity();
    return { perPost, velHistory, velSession, velStart, velBg, velLastAt, step };`);
  const els = {};
  const $ = id => (els[id] = els[id] || { style: {}, children: [], innerHTML: '', textContent: '', appendChild(c) { this.children.push(c); } });
  const document = { createElement: () => ({ style: {}, className: '', title: '' }) };
  const f = new Intl.NumberFormat('en-US');
  const post = v => [{ id: 'p', view_count: v, like_count: 3, comment_count: 1, share_count: 1 }];
  let st = { perPost: {}, velHistory: [], velSession: null, velStart: 0 };
  for (const v of [25004, 24997, 25004]) st = run($, f, document, post(v), st);
  check('25,004 → 24,997 → 25,004 is +0 for the session', st.velSession.views === 0, st.velSession.views);
  check('and +0 on the post\'s own +session', st.perPost.p.sessV === 0, JSON.stringify(st.perPost.p));
  st = run($, f, document, post(25010), st);
  check('a real rise past the old count still counts from that count', st.velSession.views === 6 && st.perPost.p.tickV === 6,
    st.velSession.views + ' / ' + st.perPost.p.tickV);

  const bf = new Function('hist', 'NOW', `
    const MAX_BARS = 60; const Date = { now: () => NOW }; const backBin = () => 60e3;
    ${fn('function backfillBars()')}
    return backfillBars();`);
  const bars = bf({ videos: { p: { s: [[NOW - 5 * MIN, 100], [NOW - 4 * MIN, 110], [NOW - 3 * MIN, 100], [NOW - 2 * MIN, 110], [NOW - MIN, 111]] } } }, NOW);
  check('the backfilled bars do not count a rebound either', bars.reduce((a, b) => a + b, 0) === 11, bars.join(','));
}

console.log('\n⚡ compares a day with a day');
{
  const run = arr => new Function('hist', 'NOW', `
    const Date = globalThis.Date; const realNow = Date.now;
    let accelSet;
    const ACCEL_MIN = 50, ACCEL_RATIO = 1.5;
    const ATB = (arr, t) => { let v = null; for (const s of arr) { if (s[0] <= t) v = s; else break; } return v; };
    ${fn('function buildAccel()')}
    Date.now = () => NOW; try { buildAccel(); return accelSet; } finally { Date.now = realNow; }`)({ videos: { p: { s: arr } } }, NOW);
  // a steady 60 views a day, with nothing recorded from 40h ago to 20h ago
  const steady = [];
  for (let h = 72; h >= 0; h--) if (h <= 20 || h >= 40) steady.push([NOW - h * HOUR, 1000 + Math.round((72 - h) * 60 / 24)]);
  check('a steady post with a gap across the 24h mark is not accelerating', !run(steady).has('p'));
  const quick = [];
  for (let h = 72; h >= 0; h--) quick.push([NOW - h * HOUR, 1000 + (h > 24 ? (72 - h) * 2 : 96 + (24 - h) * 8)]);
  check('a post that really sped up still is', run(quick).has('p'));
  const revised = [[NOW - 49 * HOUR, 2000], [NOW - 48 * HOUR, 2000], [NOW - 24 * HOUR, 1700], [NOW, 1800]];
  check('a day before that went DOWN (a revision) is no baseline to beat', !run(revised).has('p'));
}

console.log('\nfollower history survives a failed read');
{
  const S = mk();
  const f = [[NOW - 300 * DAY, 10], [NOW - 3 * HOUR, 300]];
  S.hist = { videos: {}, followers: f };
  S.mergeHist({ videos: {}, followers: [] });
  check('an empty follower list does not replace a stored history', S.hist.followers === f);
  S.mergeHist({ videos: {} });
  check('nor does an answer that leaves followers out', S.hist.followers === f);
  S.mergeHist({ videos: {}, followers: [[NOW - 5 * HOUR, 290]] });
  check('nor one that ends earlier than what is stored', S.hist.followers === f);
  const newer = [[NOW - 300 * DAY, 10], [NOW - 3 * HOUR, 300], [NOW, 305]];
  S.mergeHist({ videos: {}, followers: newer, updated: 5 });
  check('a history that reaches further replaces it', S.hist.followers === newer && S.hist.updated === 5);
}

console.log('\nbuildScores never lets a post vote on itself');
{
  const model = TT.slice(TT.indexOf('const PJ_HORIZON'), TT.indexOf('  // Option C'));
  const run = (vids, videos) => new Function('hist', 'videos', 'NOW', `
    const Date = globalThis.Date; const realNow = Date.now;
    const fmt = new Intl.NumberFormat('en-US');
    ${model}
    ${fn('function pjCurveOf(id, createTime, rec)')}
    let scoreCache = null;
    ${fn('function buildScores()')}
    Date.now = () => NOW; try { buildScores(); return scoreCache; } finally { Date.now = realNow; }`)({ videos: vids }, videos, NOW);
  const curve = (ageH, final) => {
    const ct = Math.floor((NOW - ageH * HOUR) / 1000), s = [];
    for (let m = 0; m <= Math.min(ageH, 48) * 60; m += 15)
      s.push([ct * 1000 + m * MIN, Math.round(final / (1 + Math.exp(-(m / 60 - 8) / 3)))]);
    return { create_time: ct, s };
  };
  const vids = { old: curve(100, 2000), mine: curve(46, 1200) };
  const scores = run(vids, [{ id: 'mine', create_time: vids.mine.create_time, view_count: 1180 }]);
  check('with one finished launch, a 46h post has no score (it is not its own second reference)',
    scores.get('mine') == null, String(scores.get('mine')));
  const vids2 = { old: curve(100, 2000), old2: curve(120, 1500), mine: curve(46, 1200) };
  const s2 = run(vids2, [{ id: 'mine', create_time: vids2.mine.create_time, view_count: 1180 }]);
  check('with two other finished launches it is scored', s2.get('mine') != null, String(s2.get('mine')));
}

console.log('\nsync status and import');
{
  const push = fn('async function ttSyncPush()');
  check('a refused save is not shown as synced, and is retried on the next change',
    /if \(!r\.ok\) \{ ttSyncKnown = ''; setSyncStatus\(''\); return; \}/.test(push));
  check('a failed request is retried too', /catch \(e\) \{ ttSyncKnown = ''; setSyncStatus\(''\); \}/.test(push));
  check('and the sync path never signs anyone out', !/signOut/.test(push));
  const imp = TT.slice(TT.indexOf("$('ttImportFile').addEventListener"), TT.indexOf('rd.readAsText(f);'));
  check('imported settings are stamped as this device\'s newest', /localStorage\.setItem\(TT_SYNC_AT, String\(Date\.now\(\)\)\)/.test(imp));
  check('and the message counts settings apart from the recording, saying when that one is used',
    /'Imported ' \+ n \+ ' setting' \+ \(n === 1 \? '' : 's'\) \+ \(hadHist \? ' and a recording' : ''\)/.test(imp) &&
    /\(used only if this browser has none of its own\)/.test(imp));
}

/* Recorded trends' days: a watched day with no rise is a real +0, and a day this device
   cannot vouch for (before the oldest kept post's first two days, or before the latest
   resume after a hole of more than six hours) is dropped rather than shown short. */
console.log('\nrecorded days — coverage');
{
  const R = hist => new Function('hist', `
    ${(TT.match(/  const TT_GAP = [^\n]*\n/) || [''])[0]}
    ${fn('function ttGainBuckets(from)')}
    ${fn('function recDayGains(days)')}
    return recDayGains(16);`)(hist);
  const now = Date.now();
  const kOf = t => new Date(t).toLocaleDateString('en-CA');
  const quiet = new Date(now); quiet.setDate(quiet.getDate() - 3); quiet.setHours(0, 0, 0, 0);
  const qs = quiet.getTime(), qe = qs + DAY;
  const series = (from, step, gap) => {
    const s = []; let v = 100;
    for (let t = from; t <= now; t += step) {
      if (gap && t > gap[0] && t < gap[1]) continue;
      if (!(t >= qs && t < qe)) v += 5;
      s.push([t, v, 0, 0, 0]);
    }
    return s;
  };
  const a = R({ videos: { p: { create_time: Math.floor((now - 30 * DAY) / 1000), s: series(now - 16 * DAY, 15 * MIN) } } });
  check('a watched day with no rise is recorded as +0, not missing', a.has(kOf(qs + HOUR * 12)) && a.get(kOf(qs + HOUR * 12)) === 0,
    String(a.get(kOf(qs + HOUR * 12))));
  check('with an old post kept and no hole, the fortnight is covered', a.has(kOf(now - 13 * DAY)));
  const b = R({ videos: { p: { create_time: Math.floor((now - 6 * DAY) / 1000), s: series(now - 6 * DAY, 15 * MIN) } } });
  const cut = now - 4 * DAY;
  check('days before the oldest kept post\'s first two days are dropped',
    [...b.keys()].every(k => new Date(k + 'T00:00:00').getTime() >= cut) && b.notKept === true, [...b.keys()].join(','));
  const hole = [now - 5 * DAY, now - 5 * DAY + 8 * HOUR];
  const c = R({ videos: { p: { create_time: Math.floor((now - 30 * DAY) / 1000), s: series(now - 16 * DAY, 15 * MIN, hole) } } });
  check('nothing before the latest resume after a >6h hole is kept',
    [...c.keys()].every(k => new Date(k + 'T00:00:00').getTime() >= hole[1]) && c.coverFrom >= hole[1] && c.notKept === false,
    [...c.keys()].join(','));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
