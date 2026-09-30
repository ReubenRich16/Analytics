// "Today so far" — the TikTok page's first card, run against the page's own code.
//
// It replaced a rolling-24-hour Today chip (at 2 am those 24 hours were mostly yesterday)
// with the calendar day on the viewer's own clock, and every figure on it has a rule:
//
//   · views today are Trends' "Today so far", from the very same recDayGains call;
//   · followers and likes run from the snapshot that starts the day — one within 15 minutes
//     after midnight is midnight's, else the last check before midnight within 3½ hours,
//     named by its real time, else nothing;
//   · "yesterday by this time" compares the same whole hours of each day, counted from each
//     local midnight — so the 23-hour day when daylight saving starts is hours against hours;
//   · the verdict needs 20 views AND more than 10% to be anything but Level, and abstains
//     before 1 am or when yesterday's hours were not tracked;
//   · a typical day of followers is the milestone's own pace, so the two always agree;
//   · a record is marked .cc-win only when it is exactly one.
//
// Melbourne time throughout, set before anything reads a clock.
//
// Run: node scripts/tt-today.test.mjs
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

// the page's code: the whole Today block, and everything it leans on
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
  ${line('  const ageDays = ')}${line('  const paceOf = ')}${line('  const engOf = ')}
  ${arrow('  const typicalLikeRate = ')}
  ${arrow('  const fmtAgo = ts =>')}
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
  ${fnOf('ttGradeOf')}
  ${TODAY}
  return { ttTodayModel, ttTodayWords, ttTodayMoreHtml, renderToday, recDayGains, ttPostToday, projectMilestone, liveFollowers,
           localMidnight, clockTxt, ttDayBase, milestonePct, els };`;
const load = (NOW, hist, videos, me, scores) =>
  new Function('NOW', 'hist', 'videos', 'me', 'scores', SRC)(NOW, hist, videos, me, scores);

/* A store the way the Worker fills it: one post read every 15 minutes (well inside the
   75-minute hole rule), gaining `rate(dayKey)` views per reading. A reading carries the
   views of the quarter hour BEFORE it, so its rate is that of the day holding (t − 1 ms) —
   the same filing rule the page uses. `skip` leaves readings out, which makes a hole. */
const dayKey = t => new Date(t).toLocaleDateString('en-CA');
function viewsStore(NOW, rate, skip) {
  const s = []; let v = 1000;
  const t0 = Math.floor((NOW - 18 * D) / (15 * MIN)) * 15 * MIN;
  let pending = 0;
  for (let t = t0; t <= NOW; t += 15 * MIN) {
    pending += rate(dayKey(t - 1));
    if (skip && skip(t)) continue;
    v += pending; pending = 0;
    s.push([t, v, 0, 0, 0]);
  }
  return { p: { create_time: Math.floor((NOW - 40 * D) / 1000), title: 'An older post', s } };
}
// followers and likes grow steadily; the log is checked every 3h at :40, and optionally just
// after each midnight (as the Worker now does)
const T0 = at(2026, 8, 1);
const fol = t => 4000 + Math.round((t - T0) / D * 8);
const lik = t => 50000 + Math.round((t - T0) / D * 90);
function followerLog(NOW, opts = {}) {
  const out = [];
  for (let t = at(2026, 8, 20, 1, 40); t <= NOW; t += 3 * H) out.push(t);
  if (opts.midnight) for (let k = 0; k < 25; k++) { const m = new Date(NOW); m.setHours(0, 0, 0, 0); m.setDate(m.getDate() - k); m.setHours(0, 4, 0, 0); if (m.getTime() <= NOW) out.push(m.getTime()); }
  const drop = opts.drop || (() => false);
  return out.filter(t => !drop(t)).sort((a, b) => a - b).map(t => [t, fol(t), lik(t), 30]);
}
const oldPost = NOW => ({ id: 'p', title: 'An older post', create_time: Math.floor((NOW - 40 * D) / 1000), view_count: 90000, like_count: 7000 });
const mk = (NOW, { rate, skip, flog, videos, me, scores } = {}) => {
  const hist = { videos: viewsStore(NOW, rate || (() => 10), skip), followers: flog || followerLog(NOW, { midnight: true }) };
  const vids = videos || [oldPost(NOW)];
  return load(NOW, hist, vids, me || { follower_count: fol(NOW), likes_count: lik(NOW) }, scores || {});
};

console.log('\nlocal midnight is calendar arithmetic, never now − 24h');
{
  const P = load(at(2026, 10, 5, 8, 23), { videos: {} }, [], null, {});
  check('Mon 5 Oct: today starts at 00:00 AEDT', new Date(P.localMidnight(at(2026, 10, 5, 8, 23))).toString().startsWith('Mon Oct 05 2026 00:00:00 GMT+1100'));
  check('and yesterday (the DST day) at 00:00 AEST, 23 hours earlier',
    new Date(P.localMidnight(at(2026, 10, 5, 8, 23), 1)).toString().startsWith('Sun Oct 04 2026 00:00:00 GMT+1000') &&
    P.localMidnight(at(2026, 10, 5, 8, 23)) - P.localMidnight(at(2026, 10, 5, 8, 23), 1) === 23 * H);
  check('tomorrow is back = −1', P.localMidnight(at(2026, 10, 3, 12), -1) === at(2026, 10, 4));
  check('the clock reads like a person: 8 am, 10:40 pm, 12:04 am, 12 pm',
    [at(2026, 9, 30, 8), at(2026, 9, 30, 22, 40), at(2026, 9, 30, 0, 4), at(2026, 9, 30, 12)].map(P.clockTxt).join('|') === '8 am|10:40 pm|12:04 am|12 pm');
  const body = TODAY.slice(TODAY.indexOf('function ttTodayModel('), TODAY.indexOf('function ttTodayWords('));
  check('no day boundary in the model is made by adding or taking 24 hours', !/864e5|24 \* H|86400/.test(body), body.match(/.*(864e5|24 \* H).*/)?.[0]);
}

console.log('\na normal day (Wed 30 Sep, 8:23 am)');
{
  const NOW = at(2026, 9, 30, 8, 23);
  const today = dayKey(NOW), yday = dayKey(at(2026, 9, 29, 12));
  const P = mk(NOW, { rate: k => k === today ? 12 : 10 });
  const m = P.ttTodayModel(), w = P.ttTodayWords(m);
  const trends = P.recDayGains(16).get(today);
  check('views today are Trends’ “Today so far”, from the same call', m.views === trends && /const day = recDayGains\(16\);[^\n]*Trends/.test(TODAY) &&
    /mcell\('Today so far', day\.has\(tk\)/.test(TT) && /const day = recDayGains\(16\);/.test(cut('  function renderRecTrends(', '\n  }\n')), m.views + ' vs ' + trends);
  check('and are the readings since midnight: 00:15 to 8:15 is 33 of them', m.views === 33 * 12, m.views);
  check('yesterday, the whole day, is 96 readings', m.yViews === 96 * 10, m.yViews);
  check('the comparison runs to the last whole hour the page has readings past (8 am)', m.cmp.n === 8 && P.clockTxt(m.cmp.tB) === '8 am' && P.clockTxt(m.cmp.yB) === '8 am');
  check('and counts the same hours of each day: 32 readings each', m.cmp.today === 384 && m.cmp.yday === 320, m.cmp.today + ' / ' + m.cmp.yday);
  check('64 more and 20% up is “Ahead of yesterday”', m.cmp.verdict === 'ahead' && w.pill[0] === 'Ahead of yesterday', w.pill);
  check('the sentence says what is compared, with both numbers', w.say.replace(/<[^>]*>/g, '') === 'By 8 am: 384 views today, 320 yesterday — 20% more.', w.say);
  check('the tiles carry no half of the comparison: it lives in the sentence, both figures together', w.cmpTile === undefined, w.cmpTile);
  check('followers run from the 12:04 am check to the live count', m.base.exact && m.followers === fol(NOW) - fol(at(2026, 9, 30, 0, 4)), m.followers);
  check('a check four minutes after midnight is named, not called midnight', w.since === 'since 12:04 am', w.since);
  const onTheDot = mk(NOW, { flog: followerLog(NOW).concat([[at(2026, 9, 30) + 20e3, fol(at(2026, 9, 30)), lik(at(2026, 9, 30)), 30]]).sort((a, b) => a[0] - b[0]) });
  check('a check within the minute after midnight is “since midnight”', onTheDot.ttTodayWords(onTheDot.ttTodayModel()).since === 'since midnight');
  check('likes use the same check', m.likes === lik(NOW) - lik(at(2026, 9, 30, 0, 4)), m.likes);
  check('yesterday’s followers run midnight to midnight', m.yFollowers === fol(at(2026, 9, 30, 0, 4)) - fol(at(2026, 9, 29, 0, 4)), m.yFollowers);
  const p = P.projectMilestone(P.liveFollowers(followerLog(NOW, { midnight: true })), 'followers', 'follower');
  check('a typical day of followers IS the milestone’s pace', p.typical && m.typFollowers === p.perDay && m.typBasis === p.basis, m.typFollowers + ' vs ' + p.perDay);
  const more = P.ttTodayMoreHtml(m, w).replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  check('and the fold quotes it in the milestone’s own rounding', new RegExp('A typical day brings about \\+' + p.rate.replace('.', '\\.') + ' ').test(more) &&
    new RegExp('\\+' + p.rate.replace('.', '\\.') + ' followers a day').test(p.text.replace(/<[^>]*>/g, '')), more);
  check('the fold says the views figure is Trends’', /the same figure as “Today so far” in Trends/.test(more), more);
  check('it gives yesterday’s whole day', / Yesterday, the whole day: \+960\. /.test(more), more);
  check('it ranks today so far among the full days behind it (a floor: today only adds)',
    /Not ahead of any of the last 14 full days tracked yet — the day isn’t over\./.test(more), more);
  check('no record is claimed', w.record === null && !/cc-win/.test(P.ttTodayMoreHtml(m, w)));
  check('followers are ranked only against days with a midnight check at both ends, and only “so far”',
    m.fDays === 14 && /So far, fewer followers than on any of the last 14 days with a midnight check at both ends\./.test(more) && !/no more/.test(more), more);
  const nomid = mk(NOW, { flog: followerLog(NOW) }).ttTodayModel();
  check('with no midnight checks there is no follower ranking at all', nomid.fAhead === null && nomid.fDays === 0);
  const lvl = P.ttTodayWords(mk(NOW, { rate: k => k === today ? 10.5 : 10 }).ttTodayModel());
  check('16 views apart is level, whatever the percentage', lvl.pill[0] === 'Level with yesterday' && /only 16 apart, so level\./.test(lvl.say), lvl.say);
  const close = mk(NOW, { rate: k => k === today ? 100 : 95 }).ttTodayModel();
  check('160 apart but 5% is level too', close.cmp.verdict === 'level' && /within 10%, so level\./.test(P.ttTodayWords(close).say), P.ttTodayWords(close).say);
  const edge = P.ttTodayWords(mk(NOW, { rate: k => k === today ? 110.3 : 100 }).ttTodayModel());
  check('10.3% over is ahead, and is not printed as a round “10%”', edge.pill[0] === 'Ahead of yesterday' && /just over 10% more\./.test(edge.say), edge.say);
  const back = mk(NOW, { rate: k => k === today ? 5 : 10 }).ttTodayModel();
  check('half of yesterday is behind, in plain words', back.cmp.verdict === 'behind' && /— 50% fewer\./.test(P.ttTodayWords(back).say), P.ttTodayWords(back).say);
  const zero = mk(NOW, { rate: k => k === today ? 5 : 0 }).ttTodayModel();
  check('a yesterday of nothing gives no percentage', /yesterday had none by then\./.test(P.ttTodayWords(zero).say) && !/%/.test(P.ttTodayWords(zero).say), P.ttTodayWords(zero).say);
}

/* Probe P1 from the review: a post went up at 7:00, was first read at 7:03 with 400 views, and
   then gained 10 every 15 minutes. At 9 am the Today card said +70 while the post's own
   "views today" tile said 470. The moment it went up is its reading before the first (0
   views, a fact), so its first 400 count, in the hour they came in. */
console.log('\na post that went up today counts from 0 (probe P1)');
{
  const NOW = at(2026, 9, 30, 9, 0);
  const born = at(2026, 9, 30, 7, 0);
  const s = [];
  for (let t = born + 3 * MIN, v = 400; t <= NOW; t += 15 * MIN, v += 10) s.push([t, v, 0, 0, 0]);
  const hist = { videos: { ...viewsStore(NOW, () => 10), n: { create_time: born / 1000, title: 'New one', s } }, followers: followerLog(NOW, { midnight: true }) };
  const newPost = { id: 'n', title: 'New one', create_time: born / 1000, view_count: s[s.length - 1][1], like_count: 3 };
  const P = load(NOW, hist, [newPost, oldPost(NOW)], { follower_count: fol(NOW), likes_count: lik(NOW) }, {});
  const m = P.ttTodayModel();
  const tn = P.ttPostToday(newPost), tp = P.ttPostToday(oldPost(NOW));
  check('(the fixture: first read at 7:03 with 400, 470 by 8:48)', s[0][1] === 400 && newPost.view_count === 470 && tn.state === 'new' && tn.gain === 470);
  check('the Today card counts all 470 of the new post’s views', m.views === 36 * 10 + 470, m.views);
  check('so the Today card is the sum of the post tiles', m.views === tn.gain + tp.gain, m.views + ' vs ' + tn.gain + ' + ' + tp.gain);
  check('the first 400 are filed in the hour they came in (7–8 am), not lost', [...P.recDayGains(16).hours].some(([k, b]) => k === at(2026, 9, 30, 7) && b.gain === 400 + 3 * 10 + 4 * 10), JSON.stringify([...P.recDayGains(16).hours].filter(([k]) => k >= at(2026, 9, 30, 7)).map(([k, b]) => [new Date(k).getHours(), b.gain])));
  // first read more than 75 minutes after it went up: those views came in across a hole
  const late = s.filter(x => x[0] >= at(2026, 9, 30, 8, 30));
  const P2 = load(NOW, { ...hist, videos: { ...hist.videos, n: { create_time: born / 1000, s: late } } }, [newPost, oldPost(NOW)], { follower_count: fol(NOW), likes_count: lik(NOW) }, {});
  const m2 = P2.ttTodayModel();
  check('first read 93 minutes after it went up: counted in the total, in no hour, and today says part wasn’t recorded',
    m2.viewsPartial && P2.recDayGains(16).gaps.has(dayKey(NOW)), JSON.stringify([m2.views, m2.viewsPartial]));
  // a post that went up before the window still counts from its first reading inside it
  const P3 = load(NOW, { ...hist, videos: { ...hist.videos, n: { create_time: (at(2026, 9, 29, 7)) / 1000, s } } }, [oldPost(NOW)], { follower_count: fol(NOW), likes_count: lik(NOW) }, {});
  check('a post that went up yesterday but was first read today is not counted from 0', P3.ttTodayModel().views === 36 * 10 + 70, P3.ttTodayModel().views);
}

console.log('\na profile older than the start-of-day check is not measured against it');
{
  const NOW = at(2026, 9, 30, 8, 23);
  const P = mk(NOW, { me: { follower_count: fol(at(2026, 9, 29, 23)), likes_count: lik(at(2026, 9, 29, 23)), _at: at(2026, 9, 29, 23) } });
  const m = P.ttTodayModel(), w = P.ttTodayWords(m);
  check('followers and likes wait for a fresh count instead of printing a fall', m.meStale && m.followers === null && m.likes === null && w.noBase === 'waiting for a fresh count', JSON.stringify([m.followers, w.noBase]));
  check('the fold says why', /Waiting for a fresh follower count/.test(P.ttTodayMoreHtml(m, w)));
  const fresh = mk(NOW, { me: { follower_count: fol(NOW), likes_count: lik(NOW), _at: NOW - MIN } }).ttTodayModel();
  check('a profile fetched after the check is used', !fresh.meStale && fresh.followers === fol(NOW) - fol(at(2026, 9, 30, 0, 4)));
}

console.log('\none follower is “follower”');
{
  const NOW = at(2026, 9, 30, 8, 23);
  const P = mk(NOW, { me: { follower_count: fol(at(2026, 9, 30, 0, 4)) + 1, likes_count: lik(at(2026, 9, 30, 0, 4)) + 1 } });
  P.renderToday();
  const txt = P.els.todayMain.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  check('+1 follower, +1 like', /\+1 follower since/.test(txt) && /\+1 like since/.test(txt), txt);
}

console.log('\nfewer posts kept than listed: the basis is named');
{
  const NOW = at(2026, 9, 30, 8, 23);
  const P = mk(NOW, { videos: [oldPost(NOW), { id: 'q', create_time: Math.floor((NOW - 60 * D) / 1000), view_count: 1 }] });
  const m = P.ttTodayModel();
  check('the sentence says which posts', /Views are counted on your 1 newest posts\./.test(P.ttTodayWords(m).say), P.ttTodayWords(m).say);
  check('and so does the fold', /on your 1 newest posts/.test(P.ttTodayMoreHtml(m, P.ttTodayWords(m))));
}

console.log('\nthe start of the day, when the midnight check is missing');
{
  const NOW = at(2026, 9, 30, 8, 23);
  // the old ~3h cadence only: :40 past every third hour, so the last check before midnight is 10:40 pm
  const P = mk(NOW, { flog: followerLog(NOW) });
  const m = P.ttTodayModel(), w = P.ttTodayWords(m);
  check('the last check before midnight is used when it is within 3½ hours', m.base && !m.base.exact && P.clockTxt(m.base.s[0]) === '10:40 pm', m.base && P.clockTxt(m.base.s[0]));
  check('and named by its real time, short enough for the tile', w.since === 'since 10:40 pm', w.since);
  check('with the whole story said once under the tiles', w.sinceNote === 'Followers and likes are counted from your tracker’s 10:40 pm check last night, its last before midnight.', w.sinceNote);
  P.renderToday();
  check('(and painted there)', /<p class="today-note today-since">Followers and likes are counted from your tracker’s 10:40\u00a0pm check last night/.test(P.els.todayMain.innerHTML));
  const paint = cut('  function paintToday(', '\n  }\n');
  check('a tile says “yesterday: ±N” only when both days ran midnight to midnight (10:40 pm to 10:40 pm is the fold’s to name)',
    /const dayExact = m\.base && m\.yBase && m\.base\.exact && m\.yBase\.exact;/.test(paint) &&
    (paint.match(/m\.y(Followers|Likes) != null && dayExact \? 'yesterday: '/g) || []).length === 2 &&
    (paint.match(/'yesterday: '/g) || []).length === 2, paint.match(/.*yesterday: .*/g));
  check('followers are live minus that check', m.followers === fol(NOW) - fol(at(2026, 9, 29, 22, 40)), m.followers);
  const more = P.ttTodayMoreHtml(m, w).replace(/<[^>]*>/g, '');
  check('two 10:40 pm checks are told apart by their day', /counted from 10:40 pm Monday to 10:40 pm Tuesday\./.test(more), more);
  // a check at 12:30 am is past the 15-minute window, and the one before midnight is 4 hours back
  const far = followerLog(NOW, { drop: t => t > at(2026, 9, 29, 20, 0) && t < at(2026, 9, 30, 0, 30) }).concat([[at(2026, 9, 30, 0, 30), 5000, 60000, 30]]).sort((a, b) => a[0] - b[0]);
  const Q = mk(NOW, { flog: far }), mq = Q.ttTodayModel(), wq = Q.ttTodayWords(mq);
  check('with nothing close enough, followers abstain instead of reaching further', mq.base === null && mq.followers === null && mq.likes === null);
  check('and say why, plainly', wq.noBase === 'no check near midnight' && /no follower check between 8:30 pm and 12:15 am/.test(Q.ttTodayMoreHtml(mq, wq)), Q.ttTodayMoreHtml(mq, wq));
  check('views are unaffected', mq.views === 33 * 10);
  const exact = mk(NOW, { flog: followerLog(NOW).concat([[at(2026, 9, 30, 0, 15), 4999, 1, 30]]).sort((a, b) => a[0] - b[0]) }).ttTodayModel();
  check('a check exactly 15 minutes after midnight still counts as midnight', exact.base && exact.base.exact);
  const P2 = load(NOW, { videos: {}, followers: [] }, [oldPost(NOW)], { follower_count: 10 }, {});
  const e = P2.ttTodayModel();
  check('no follower log at all says so', e.followers === null && P2.ttTodayWords(e).noBase === 'no follower checks yet');
}

console.log('\nabstaining');
{
  const NOW = at(2026, 9, 30, 0, 40);
  const P = mk(NOW);
  const m = P.ttTodayModel(), w = P.ttTodayWords(m);
  check('before 1 am there is no comparison: “Still early”', m.cmp.why === 'early' && w.pill[0] === 'Still early' && /compared with yesterday from 1 am/.test(w.say), w.say);
  check('but the counts since midnight still show', m.views === 2 * 10, m.views);
  // yesterday had a two-hour hole in the morning
  const N2 = at(2026, 9, 30, 8, 23);
  const hole = mk(N2, { skip: t => t > at(2026, 9, 29, 3, 0) && t < at(2026, 9, 29, 5, 0) }).ttTodayModel();
  const hw = load(N2, { videos: {} }, [], null, {}).ttTodayWords(hole);
  check('a hole in yesterday’s compared hours is no comparison', hole.cmp.why === 'yesterday' && hw.pill[0] === 'No comparison yet' &&
    /Yesterday wasn’t fully tracked up to 8 am, so there’s nothing fair to compare today with\./.test(hw.say), hw.say);
  check('and yesterday’s whole day is left out, not shown short', hole.yViews === null);
  // a hole yesterday afternoon: the whole day is incomplete, but the morning is not
  const pm = mk(N2, { skip: t => t > at(2026, 9, 29, 15, 0) && t < at(2026, 9, 29, 17, 0) }).ttTodayModel();
  check('a hole after the compared hours leaves the comparison standing (hours, not days)', pm.cmp.verdict === 'level' && pm.cmp.yday === 320, JSON.stringify(pm.cmp));
  check('while the whole-day total abstains', pm.yViews === null);
  const MM = mk(N2, { skip: t => t > at(2026, 9, 29, 15, 0) && t < at(2026, 9, 29, 17, 0) });
  check('and the fold says so', /Yesterday wasn’t fully recorded, so its whole-day total is left out\./.test(MM.ttTodayMoreHtml(pm, MM.ttTodayWords(pm))));
  // a hole this morning: today's count up to the hour is short
  const th = mk(N2, { skip: t => t > at(2026, 9, 30, 2, 0) && t < at(2026, 9, 30, 4, 0) }).ttTodayModel();
  check('a hole in today’s compared hours is no comparison either', th.cmp.why === 'today' && th.viewsPartial, JSON.stringify(th.cmp));
  // the page's newest reading is from 7:55: it compares to 7 am, not 8
  const stale = mk(N2, { skip: t => t > at(2026, 9, 30, 7, 55) }).ttTodayModel();
  check('the hour boundary follows the newest reading the page holds, not the clock', stale.cmp.n === 7 && stale.cmp.today === 28 * 10, JSON.stringify(stale.cmp));
  const quiet = mk(N2, { skip: t => t > at(2026, 9, 29, 23, 50) }).ttTodayModel();
  check('no reading since midnight at all is not a quiet day', quiet.cmp.why === 'stale' && quiet.views === null, JSON.stringify(quiet.cmp));
}

console.log('\ndaylight saving: Sun 4 Oct 2026 is 23 hours long');
{
  const NOW = at(2026, 10, 4, 8, 23);
  const P = mk(NOW);
  const m = P.ttTodayModel(), w = P.ttTodayWords(m);
  check('today is 23 hours', m.todayH === 23 && m.yH === 24);
  check('7h 23m have passed, so the first 7 hours of each day are compared', m.cmp.n === 7 && m.cmp.today === 28 * 10 && m.cmp.yday === 28 * 10, JSON.stringify(m.cmp));
  check('which ends at 8 am today and 7 am yesterday', P.clockTxt(m.cmp.tB) === '8 am' && P.clockTxt(m.cmp.yB) === '7 am');
  check('and the sentence says so, and why', w.say.replace(/<[^>]*>/g, '') ===
    'In the first 7 hours of each day: 280 views today (to 8 am), 280 yesterday (to 7 am) — exactly level. Hours are compared with hours because the clocks went forward an hour today.', w.say);
  check('the tiles carry no half of the comparison on a short day either', w.cmpTile === undefined);
  check('views since midnight are 29 readings, not 33', m.views === 29 * 10, m.views);
  check('the midnight check on the DST morning counts', m.base && m.base.exact && m.followers === fol(NOW) - fol(at(2026, 10, 4, 0, 4)));

  const N2 = at(2026, 10, 5, 8, 23);
  const Q = mk(N2), q = Q.ttTodayModel(), qw = Q.ttTodayWords(q);
  check('the day after: yesterday was 23 hours', q.yH === 23 && q.todayH === 24);
  check('the first 8 hours of each: to 8 am today and 9 am yesterday', q.cmp.n === 8 && Q.clockTxt(q.cmp.tB) === '8 am' && Q.clockTxt(q.cmp.yB) === '9 am' &&
    q.cmp.today === 320 && q.cmp.yday === 320, JSON.stringify(q.cmp));
  check('said plainly', /because the clocks went forward an hour yesterday\./.test(qw.say), qw.say);
  check('yesterday’s whole day is its 92 readings, and admits it was short', q.yViews === 92 * 10 &&
    /Yesterday, the whole day: \+920 \(a 23-hour day: the clocks went forward\)\./.test(Q.ttTodayMoreHtml(q, qw).replace(/<[^>]*>/g, '')), q.yViews);
  check('yesterday’s followers still run midnight to midnight', q.yFollowers === fol(at(2026, 10, 5, 0, 4)) - fol(at(2026, 10, 4, 0, 4)));
}

console.log('\ndaylight saving ends: Sun 4 Apr 2027 is 25 hours long, and 2 am happens twice');
{
  const second2am = at(2027, 4, 4, 2, 30) + H;          // 2:30 am the second time (AEST)
  check('the fixture really is the repeated hour', new Date(second2am).toString().includes('GMT+1000') && new Date(second2am).getHours() === 2);
  const P = mk(second2am);
  const m = P.ttTodayModel(), w = P.ttTodayWords(m);
  check('today is 25 hours', m.todayH === 25);
  check('3½ hours in: the first 3 hours of each day, not 4 of today', m.cmp.n === 3 && m.cmp.today === 12 * 10 && m.cmp.yday === 12 * 10, JSON.stringify(m.cmp));
  check('ending at the second 2 am today and 3 am yesterday', P.clockTxt(m.cmp.tB) === '2 am' && P.clockTxt(m.cmp.yB) === '3 am' &&
    /because the clocks went back an hour today\./.test(w.say), w.say);
  const hrs = [...P.recDayGains(16).hours.keys()].filter(k => k >= m.tMid);
  check('the two 2 am hours are two hours, not one hour holding both', new Set(hrs).size === hrs.length && hrs.length === 4, hrs.map(k => new Date(k).toString().slice(16, 33)));
  const N2 = at(2027, 4, 5, 3, 30);
  const Q = mk(N2), q = Q.ttTodayModel();
  check('the day after: yesterday’s first 3 hours end at its second 2 am, and hold 3 hours of views', q.yH === 25 && q.cmp.n === 3 &&
    Q.clockTxt(q.cmp.yB) === '2 am' && q.cmp.yday === 12 * 10 && q.cmp.today === 12 * 10, JSON.stringify(q.cmp));
  check('its whole day is 100 readings, and says it was long', q.yViews === 100 * 10 &&
    /\(a 25-hour day: the clocks went back\)/.test(Q.ttTodayMoreHtml(q, Q.ttTodayWords(q))), q.yViews);
}

console.log('\nrecords are exactly records');
{
  const NOW = at(2026, 9, 30, 20, 0);
  const today = dayKey(NOW);
  const P = mk(NOW, { rate: k => k === today ? 30 : 10 });
  const m = P.ttTodayModel(), w = P.ttTodayWords(m);
  check('today so far above every full day is “your best”', w.record === 'Already your best day of the last 14 full days tracked.', w.record);
  check('and is marked for a sparkle', /<span class="cc-win">Already your best day/.test(P.ttTodayMoreHtml(m, w)));
  // tie today with one earlier full day: 20:00 has 80 readings since midnight, so 80 × 12 = 960 = 96 × 10
  const tie = mk(NOW, { rate: k => k === today ? 12 : 10 }).ttTodayModel();
  const tw = P.ttTodayWords(tie);
  check('level with a full day is not a record', tie.views === 960 && tw.record === null && /Not ahead of any/.test(tw.rank), tw.rank);
  const mid = mk(NOW, { rate: k => k === today ? 12 : k === dayKey(at(2026, 9, 25, 12)) ? 5 : 10 }).ttTodayModel();
  check('a middling day counts only the days it has already passed', P.ttTodayWords(mid).rank === 'Already ahead of 1 of the last 14 full days tracked.', P.ttTodayWords(mid).rank);
}

console.log('\nthe card itself');
{
  const NOW = at(2026, 9, 30, 8, 23);
  const today = dayKey(NOW);
  const young = { id: 'n', title: 'Slow tapping on a glass jar #asmr #tingles', create_time: Math.floor((NOW - 3 * H) / 1000), view_count: 93, like_count: 7, cover_image_url: 'x.png' };
  const others = [0, 1, 2, 3, 4].map(i => ({ id: 'o' + i, title: 'old ' + i, create_time: Math.floor((NOW - (10 + i) * D) / 1000), view_count: 1000 + i, like_count: 80 }));
  const scores = { o0: 900, o1: 1000, o2: 1100, o3: 1200, o4: 1300 };
  const P = mk(NOW, { rate: k => k === today ? 12 : 10, videos: [young, ...others, oldPost(NOW)], scores });
  P.renderToday();
  const main = P.els.todayMain.innerHTML, more = P.els.todayMoreBody.innerHTML;
  const txt = main.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  check('the card is revealed', P.els.todayCard.style.display === 'block');
  check('three tiles, as the motion layer counts them (.tile .v)', (main.match(/<div class="tile">/g) || []).length === 3 && (main.match(/<div class="v[ "]/g) || []).length === 3);
  check('views, followers and likes, each saying what it counts from', /\+396 views since midnight \+3 followers since 12:04 am a typical day: \+8\.0/.test(txt) &&
    /likes since 12:04 am a typical day: \+90/.test(txt), txt);
  check('the views tile never sets yesterday’s whole-hour figure beside its own live one', !/views since midnight yesterday/.test(txt) && !/yesterday by/.test(txt) &&
    /By 8 am: 384 views today, 320 yesterday — 20% more\./.test(txt), txt);
  check('the verdict leads', /Today so far/.test(txt) && /Ahead of yesterday/.test(txt));
  check('the newest post: caption without hashtags, its age, views and likes', /Slow tapping on a glass jar Posted 3h ago · 93 views · 7 likes/.test(txt) && !/#asmr/.test(txt), txt);
  check('it is “Too early”, for the report card’s reason', /Too early/.test(txt) && /Averaging 31 views an hour since it went up\. It gets a grade at 5 hours old \(about 2 hours to go\)\./.test(txt), txt);
  check('and opens its full breakdown', /class="today-post" role="button" tabindex="0" data-vid="n"/.test(main));
  const p = P.projectMilestone(P.liveFollowers(followerLog(NOW, { midnight: true })), 'followers', 'follower');
  const f0 = new Intl.NumberFormat('en-AU');
  check('the next milestone is the Milestone chip’s projection: its target, its date, its floored %',
    txt.includes('Next milestone ' + f0.format(p.target - p.cur) + ' to go ' + f0.format(p.target) + ' followers ' + p.when + ' ' + f0.format(p.cur) + ' ' + P.milestonePct(p) + '%') &&
    /around \d+ December \(in \d+ days\)/.test(p.when), txt);
  const P2 = mk(NOW, { videos: [{ ...young, create_time: Math.floor((NOW - 30 * H) / 1000), view_count: 1150 }, ...others, oldPost(NOW)], scores: { ...scores, n: 1150 } });
  P2.renderToday();
  const t2 = P2.els.todayMain.innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  check('a graded newest post wears the report card’s letter and reach wording', /Grade B\+/.test(t2) && /Beats 60% of your 5 other posts on reach, going by its estimated first 48 hours\./.test(t2), t2);
  check('the fold holds the working', /<h4>Views<\/h4>/.test(more) && /<h4>Followers<\/h4>/.test(more) && /<h4>Likes on your account<\/h4>/.test(more));
  check('the markup keeps the fold native and in place across repaints',
    /<details class="cc-more" id="todayMore">\s*<summary>More about today<\/summary>\s*<div class="cc-more-body" id="todayMoreBody"><\/div>/.test(TT));
}

console.log('\nwiring');
{
  check('it renders on every poll, before the table', /buildAccel\(\);\s*\n\s*renderToday\(\);\s*\n\s*renderTable\(\); showSlot\(slotIdx\);/.test(TT));
  check('and is revealed at sign-in', /\['answerCard', 'todayCard', 'profileBanner'/.test(TT));
  check('the fold styles are shared (style.css), not page-local',
    /details\.cc-more > summary \{/.test(fs.readFileSync(new URL('../yt-dashboard/style.css', import.meta.url), 'utf8')));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
