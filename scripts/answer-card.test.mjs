// Every chip on the answer card must return a paintable object. paintAnswer reads a.h
// OUTSIDE its try/catch, so a chip that returns null or undefined throws uncaught and
// freezes the whole card rather than just its own chip.
import fs from 'fs';
// resolved from this file, not an absolute path: the suite has to run wherever the repo
// is checked out, and a hard-coded /home/... only existed on one machine
const YT = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');
let pass=0, fail=0;
const check=(n,c,x='')=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗',n,x));};

// the same contract on both pages — the card was YouTube-only until TikTok got its own
function contract(src, page, chips) {
  console.log('\n' + page + ' — answer card contract');
  for (const fn of chips) {
    const i = src.indexOf('function ' + fn + '(');
    check(fn + ' exists', i > 0);
    if (i < 0) continue;
    const body = src.slice(i, src.indexOf('\n  }\n', i));
    const returns = [...body.matchAll(/return\s+([^;]*)/g)].map(m => m[1].trim());
    check(fn + ' returns something from every path', returns.length > 0, returns.length + ' returns');
    const bad = returns.filter(r => r === 'null' || r === 'undefined' || r === '');
    check(fn + ' never returns null or a bare return', bad.length === 0, bad.join(' | '));
    const objs = returns.filter(r => r.startsWith('{'));
    check(fn + ' every return carries h, f and p',
      objs.every(o => /\bh:/.test(o) && /\bf:/.test(o) && /\bp:/.test(o)),
      objs.filter(o => !(/\bh:/.test(o) && /\bf:/.test(o) && /\bp:/.test(o))).map(o=>o.slice(0,40)).join(' | '));
  }
}
contract(YT, 'YouTube', ['answerToday','answerSubs','answerMover','answerNewest','answerHitRate','answerAudience','answerMilestone','answerNext']);
// TikTok's Today chip is gone: the Today so far card (scripts/tt-today.test.mjs) answers it
// on the calendar day instead of a rolling 24 hours
contract(TT, 'TikTok',  ['answerMover','answerNewest','answerHitRate','answerEngagement','answerMilestone','answerNext']);

console.log('\nboth cards are wired the same way');
// the dispatcher array and ANSWER_CHIPS must agree, chip for chip — a mismatch paints
// one chip's answer under another chip's name
const WIRING = {
  YouTube: '[answerToday, answerSubs, answerMover, answerNewest, answerHitRate, answerAudience, answerMilestone, answerNext][answerChip]',
  TikTok:  '[answerMover, answerNewest, answerHitRate, answerEngagement, answerMilestone, answerNext][answerChip]'
};
const CHIP_COUNT = { YouTube: 8, TikTok: 6 };
for (const [page, src] of [['YouTube', YT], ['TikTok', TT]]) {
  check(page + ' has the card markup', /id="answerCard"/.test(src) && /id="answerChips"/.test(src) && /id="answerBody"/.test(src));
  check(page + ' paints through one dispatcher, in chip order', src.includes(WIRING[page]));
  check(page + ' falls back rather than throwing', /catch \(e\) \{ a = \{ h: /.test(src));
  check(page + ' builds its chips once', /chips\.dataset\.built/.test(src));
  check(page + ' names ' + CHIP_COUNT[page] + ' chips',
    (src.match(/const ANSWER_CHIPS = \[[^\]]+\]/) || [''])[0].split(',').length === CHIP_COUNT[page],
    (src.match(/const ANSWER_CHIPS = \[[^\]]+\]/) || [''])[0]);
}

console.log('\nthe TikTok card answers what TikTok can actually answer');
{
  /* YouTube's third chip is Audience, from retention and demographics. TikTok's Display API
     exposes neither, so shipping an "Audience" chip there could only ever be empty. */
  check('it does not pretend to have audience data', !/answerAudience/.test(TT));
  check('it answers like rate instead', /'Like rate'/.test(TT) && /function answerEngagement/.test(TT));
  check('and says why that stands in for it', /no audience or retention data/.test(TT));

  /* The newest chip has to describe the ACTUAL newest post. scored() drops anything with no
     comparable figure — which is what a running launch is — so picking the newest of that
     list silently described the second-newest under a heading that says "Newest". */
  const i = TT.indexOf('function answerNewest(');
  const body = TT.slice(i, TT.indexOf('\n  }\n', i));
  check('the newest post comes from every post, not just the scored ones',
    /const newest = videos\.slice\(\)/.test(body), 'it is picking from a filtered list again');
  check('and an ungradeable newest says so rather than naming another post',
    /if \(mine == null\)/.test(body));
  check('the "too early" reasons are told apart',
    /too soon to grade: not enough of your earlier posts have their first 48 hours fully tracked/.test(body) && /At least 4 are needed before a ranking means anything/.test(body) &&
    /Grades start once a post is/.test(body) && /has no views counted yet/.test(body) && /vary too much at this age/.test(body));
}

console.log('\nboth pages cycle the same number of recent uploads');
{
  const n = s => +((s.match(/const SLOT_MAX = (\d+)/) || [])[1] || 0);
  check('YouTube cycles 10', n(YT) === 10, n(YT));
  check('TikTok cycles 10', n(TT) === 10, n(TT));
  check('neither still hard-codes a smaller slice',
    !/\.slice\(0, 5\);\s*\n\s*\}/.test(YT) && !/create_time \|\| 0\)\)\.slice\(0, 4\)/.test(TT));
}

/* The Today chip now answers two more questions — how today compares with YESTERDAY, and
   where it sits across the WEEK — and both are computed from the same recorded series the
   chip already had. The reason this needs pinning rather than just writing is that the
   series will not support a naive version of either:

     · the windows are elastic. The lookup returns the last sample AT OR BEFORE a mark, and
       on the live YouTube history one "day" measured 28.2 hours next to one that measured
       20.0. Compared as if both were a day, that is a 41% error invented by the sampler.

     · the counter flaps. The same 4,152 views appeared, vanished and reappeared on the
       channel total inside three hours, and 21% of anchor points across the last twelve
       days yield a bucket of zero or less. Dividing by one of those is meaningless.

   So the rule is: normalise every bucket to a 24-hour rate, and refuse to compare a bucket
   whose span is badly off a day or whose gain went backwards. */
console.log('\nTikTok — no rolling-24h Today chip; Top mover leads');
{
  const chips = (TT.match(/const ANSWER_CHIPS = \[([^\]]+)\]/) || [])[1] || '';
  check('the chip row starts with Top mover', /^'Top mover'/.test(chips.trim()), chips);
  check('and has no Today chip', !/'Today'/.test(chips), chips);
  check('its builder and the rolling-window helper it alone used are gone', !/function answerToday\(/.test(TT) && !/function weekPlace\(/.test(TT));
  check('no "in 24h" follower headline is left on the page', !/followers in 24h|such 24-hour stretches|Your usual 24 hours lately/.test(TT));
  check('dayBuckets stays: the milestone\'s typical day is built on it', /function dayBuckets\(series, vi, n, allowNeg\)/.test(TT) && /dayBuckets\(series, 1, 14, true\)/.test(TT));
  check('the Today so far card sits in the Now room, above the answer card',
    TT.indexOf('id="todayCard"') > TT.indexOf('data-pane="now"') && TT.indexOf('id="todayCard"') < TT.indexOf('id="answerCard"') &&
    TT.indexOf('id="answerCard"') < TT.indexOf('data-pane="posts"'));
}

console.log('\nToday — yesterday and the week (YouTube; TikTok\'s is the Today so far card)');
for (const [src, page, unit] of [[YT, 'YouTube', 'views']]) {
  const grab = n => { const i = src.indexOf('function ' + n + '('); return i < 0 ? null : src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n'; };
  const db = grab('dayBuckets'), wp = grab('weekPlace');
  check(page + ' carries dayBuckets and weekPlace', !!db && !!wp);
  if (!db || !wp) continue;
  const M = new Function('fmt', 'ATB', 'NOW',
    'const Date = { now: () => NOW };\n' + db +
    "const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th','st','nd','rd'][n % 10] || 'th');\n" +
    wp + '\nreturn { dayBuckets, weekPlace };')(
      new Intl.NumberFormat('en-US'),
      (arr, t) => { let v = null; for (const x of arr) { if (x[0] <= t) v = x; else break; } return v; },
      1786000000000);
  const NOW = 1786000000000, D = 864e5;
  // a clean hourly series: 100 a day for eight days
  const clean = [];
  for (let h = 8 * 24; h >= 0; h--) clean.push([NOW - h * 3600e3, 1000 + (8 * 24 - h) * (100 / 24)]);
  const b = M.dayBuckets(clean, 1, 8);
  check(page + ' — a clean series gives eight usable buckets', b.every(x => x.ok), b.filter(x => !x.ok).length + ' bad');
  check(page + ' — each is about a day wide', b.every(x => Math.abs(x.spanH - 24) < 1.5), b[0].spanH);
  check(page + ' — and about 100 a day', Math.abs(b[0].rate - 100) < 3, b[0].rate);

  // the elastic window: samples 28 hours apart, so the raw gain is not a day's worth
  const elastic = [[NOW - 52 * 3600e3, 0], [NOW - 28 * 3600e3, 100], [NOW - 1000, 240]];
  const eb = M.dayBuckets(elastic, 1, 2);
  check(page + ' — a 28-hour window is still accepted', eb[0].ok, eb[0].spanH);
  check(page + ' — but it is scaled to a day rather than quoted raw',
    Math.abs(eb[0].rate - 140 / 28 * 24) < 1, eb[0].rate + ' from a gain of 140 over ' + eb[0].spanH + 'h');
  const stretched = [[NOW - 90 * 3600e3, 0], [NOW - 1000, 500]];
  check(page + ' — a window nowhere near a day is refused outright',
    !M.dayBuckets(stretched, 1, 1)[0].ok);

  // the flap: a counter that goes backwards must not become a percentage
  const flap = [];
  for (let h = 72; h >= 0; h--) flap.push([NOW - h * 3600e3, h === 24 ? 1200 : 1000]);
  const fb = M.dayBuckets(flap, 1, 3);
  check(page + ' — a bucket whose count went backwards is refused',
    !fb[0].ok && fb[0].gain === -200, JSON.stringify(fb[0]));
  check(page + ' — and the chip refuses to speak from it rather than dividing',
    /if \(!b\[0\] \|\| !b\[0\]\.ok\) \{/.test(src) &&
    (page === 'TikTok'
      ? /No follower count since/.test(src) && /aren’t fully tracked yet/.test(src)
      : /No count from your tracker since/.test(src) && /aren’t fully tracked yet/.test(src)));
  // followers and subscribers really do fall — for those a fall is a result, not a flap
  const fall = M.dayBuckets(flap, 1, 3, true);
  check(page + ' — with allowNeg a real fall is kept and marked ok', fall[0].ok && fall[0].gain === -200, JSON.stringify(fall[0]));
  check(page + ' — a gap and a fall give different reasons',
    fb[0].why === 'fall' && M.dayBuckets([[NOW - 90 * 3600e3, 0], [NOW - 1000, 500]], 1, 1)[0].why === 'gap');

  // the sentences
  const mk = rates => rates.map((r, i) => ({ ok: true, gain: r, spanH: 24, rate: r }));
  M.weekPlace1 = (b, u) => M.weekPlace(b, u, u.replace(/s$/, ''));
  const best = M.weekPlace1(mk([300, 100, 90, 80, 70, 60, 50, 40]), unit);
  check(page + ' — a clear best 24 hours says so', /^Best 24 hours of the week\.$/.test(best.h), best.h);
  check(page + ' — and places itself among the stretches', /Of the last 8 such 24-hour stretches, this one ranks first/.test(best.p), best.p);
  check(page + ' — the figure carries the unit and the window', best.f === '+300 ' + unit + ' in 24h', best.f);
  check(page + ' — never "today" or "yesterday" for a rolling window', !/today|yesterday/i.test(best.h + best.p), best.p);
  check(page + ' — the usual it is judged against is printed first', /^Your usual 24 hours lately: 70 /.test(best.p), best.p);
  const mid = M.weekPlace1(mk([100, 100, 300, 90, 80, 70, 60, 50]), unit);
  check(page + ' — a middling stretch gets an ordinal, and a tie says joint', /this one is joint 2nd/.test(mid.p), mid.p);
  check(page + ' — and quotes the 24 hours before', /24 hours before/.test(mid.p), mid.p);
  const mid2 = M.weekPlace1(mk([95, 100, 300, 90, 80, 70, 60, 50]), unit);
  check(page + ' — an untied middling stretch ranks plainly', /this one ranks 3rd/.test(mid2.p), mid2.p);

  /* A8 — ties, zero and noise. All from the rounded figures the reader sees. */
  const flat = M.weekPlace1(mk([0, 0, 0, 0, 0, 0, 0, 0]), unit);
  check(page + ' — an all-zero week is never "best"', !/best/i.test(flat.h) && /quiet 24 hours — nothing new/.test(flat.h), flat.h);
  const alt = M.weekPlace1(mk([7, 8, 7, 8, 7, 8, 7, 8]), unit);
  check(page + ' — a steady 7.5 a day sampled as 7 and 8 is "About usual"', alt.h === 'About usual.', alt.h);
  check(page + ' — and puts no percentage on rounding', !/%/.test(alt.p), alt.p);
  check(page + ' — within the noise of the 24 hours before it says so', /About the same as the 24 hours before \(8\)/.test(alt.p), alt.p);
  const ones = M.weekPlace1([{ ok: true, rate: 0.998, spanH: 24, gain: 1 }, { ok: true, rate: 1.021, spanH: 23.5, gain: 1 },
    { ok: true, rate: 1.01, spanH: 23.8, gain: 1 }, { ok: true, rate: 1.005, spanH: 23.9, gain: 1 }], unit);
  check(page + ' — four identical +1s are not a "quietest"', !/quietest/i.test(ones.h) && /joint 1st/.test(ones.p), ones.h + ' / ' + ones.p);
  check(page + ' — one of something is singular', ones.f === '+1 ' + unit.replace(/s$/, '') + ' in 24h', ones.f);
  const few = M.weekPlace1(mk([300, 100, 90, 80]), unit);
  check(page + ' — with fewer than five to compare it says "of the last N", not "of the week"', few.h === 'Best 24 hours of the last 4.', few.h);
  const two = M.weekPlace1(mk([300, 100]), unit);
  check(page + ' — one comparison is not enough to call a best', !/Best/.test(two.h), two.h);
  const lose = M.weekPlace1([{ ok: true, rate: -1, spanH: 24, gain: -1 }, ...mk([1, 2, 1, 0, 1, 2, 1])], unit);
  check(page + ' — a real loss prints with a minus and a singular unit', lose.f === '−1 ' + unit.replace(/s$/, '') + ' in 24h', lose.f);
  check(page + ' — and is not called best or busy', /^Down over the last 24 hours\.$/.test(lose.h), lose.h);
  // a loss against a positive usual and a positive 24 hours before: no "130% below"
  const loss = M.weekPlace1(mk([-3, 10, 12, 9, 11, 10, 8, 10]), unit);
  check(page + ' — a loss puts no percentage against the usual or the 24 hours before',
    !/%/.test(loss.p) && /Your usual 24 hours lately: 10 /.test(loss.p) && /The 24 hours before came to 10 /.test(loss.p), loss.p);
  const fellY = M.weekPlace1([{ ok: true, rate: 40, spanH: 24, gain: 40 }, { ok: false, why: 'fall' }], unit);
  check(page + ' — a 24 hours before that went down is not called "not recorded"', /came back lower/.test(fellY.p) && !/recorded/.test(fellY.p.split('.')[1] || ''), fellY.p);

  /* Yesterday at 2 and today at 3 is "+50% versus yesterday" — true, and useless. Below a
     floor the chip prints both numbers instead of a ratio. */
  const tiny = M.weekPlace1([{ ok: true, rate: 3, spanH: 24, gain: 3 }, { ok: true, rate: 2, spanH: 24, gain: 2 }], unit);
  check(page + ' — a tiny yesterday is not turned into a percentage', !/%/.test(tiny.p), tiny.p);
  const gone = M.weekPlace1([{ ok: true, rate: 40, spanH: 24, gain: 40 }, { ok: false }], unit);
  check(page + ' — a missing 24 hours before says so rather than dividing by nothing',
    /weren’t fully recorded, so there is nothing to hold it against/.test(gone.p), gone.p);
  const odd = M.weekPlace1([{ ok: true, rate: 40, spanH: 19, gain: 32 }, { ok: true, rate: 40, spanH: 24, gain: 40 }], unit);
  check(page + ' — a scaled window admits it was scaled', /Based on 19 hours of counts, scaled to 24/.test(odd.p), odd.p);
  check(page + ' — every answer is still a paintable {h,f,p}',
    [best, mid, tiny, gone, odd].every(a => a && a.h && a.f && a.p));
}

/* The four chips added in August 2026: Subs (YT), Mover, Hit rate and Milestone.
   Same contract as everything above, plus the arithmetic that makes each honest. */
console.log('\nMover — the post that did the work in the last 24 hours');
{
  const NOW = 1786000000000, H = 3600e3;
  const atb = (arr, t) => { let v = null; for (const x of arr) { if (x[0] <= t) v = x; else break; } return v; };
  const fmtUS = new Intl.NumberFormat('en-US');
  const grab = (src, n) => { const i = src.indexOf('function ' + n + '('); return src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n'; };
  const helpers = src => src.slice(src.indexOf('  const clip = (s, n) =>'), src.indexOf('\n  };\n', src.indexOf('  const shortCap = ')) + 5) +
    src.slice(src.indexOf('  const fmtAgo = ts =>'), src.indexOf('\n  };\n', src.indexOf('  const fmtAgo = ts =>')) + 5);
  const DateShim = 'const Date = { now: () => NOW, parse: s => globalThis.Date.parse(s) };\n';
  // two samples: one just inside the 24h lookback, one `staleH` hours ago
  const series = (gain, opts = {}) => {
    const last = NOW - (opts.staleH != null ? opts.staleH : 0.5) * H;
    return [[last - (opts.spanH || 24) * H, 1000], [last, 1000 + gain]];
  };
  const old = new globalThis.Date(NOW - 90 * 864e5).toISOString();
  const ytMover = new Function('hist', 'meta', 'videoTitle', 'fmt', 'ATB', 'NOW', 'ownIds',
    DateShim + helpers(YT) + grab(YT, 'answerMover') + '\nreturn answerMover;');
  const meta4 = { a: { publishedAt: old }, b: { publishedAt: old }, c: { publishedAt: old }, d: { publishedAt: old } };
  // own videos = the signed-in channel's upload list; here, whatever meta names
  const run = (hist, meta, own) => ytMover(hist, meta || meta4, id => 'vid ' + id, fmtUS, atb, NOW,
    () => new Set(own || Object.keys(meta || meta4)))();
  const res = run({ videos: { a: series(300), b: series(100), c: series(-50), d: series(500, { staleH: 8 }) } });
  check('the biggest mover wins; the flapping counter and the stale series do not vote', res.f === '+300 views in 24h', res.f);
  check('its share is of the recorded total, so 300 of 400 is 75%', /75%/.test(res.p), res.p);
  check('it names the pool it counted', /across your 2 tracked videos/.test(res.p), res.p);
  check('and says "over the last 24 hours", not "today"', /over the last 24 hours/.test(res.p) && !/today/.test(res.f + res.p), res.p);
  check('nothing recorded still answers with a sentence', !!run(null).h && !!run(null).p && run(null).h === 'A quiet 24 hours.');
  check('a lopsided day is called out', /doing the lifting/.test(res.h), res.h);
  // a video published 20 hours ago has no sample 24 hours back — it starts from zero at birth
  const born = new globalThis.Date(NOW - 20 * H).toISOString();
  const yb = run({ videos: { a: series(300), n: [[NOW - 19 * H, 800], [NOW - 0.5 * H, 5000]] } }, { a: { publishedAt: old }, n: { publishedAt: born } });
  check('YouTube — a video under a day old can be the Mover, from zero at birth', yb.f === '+5,000 views in 24h', yb.f);
  check('YouTube — and says it is since it went up, not a 24-hour rate', /has gained 5,000 views since it went up 20h ago/.test(yb.p), yb.p);

  const ttMover = new Function('hist', 'videos', 'capOf', 'fmt', 'ATB', 'NOW',
    DateShim + helpers(TT) + grab(TT, 'answerMover') + '\nreturn answerMover;');
  const oldS = (NOW - 90 * 864e5) / 1000;
  const tt = ttMover({ videos: { a: { s: series(80) }, b: { s: series(20) }, gone: { s: series(999) } } },
    [{ id: 'a', title: 'post a', create_time: oldS }, { id: 'b', title: 'post b', create_time: oldS }], v => v.title, fmtUS, atb, NOW)();
  check('TikTok — same rules, and a post outside the 60-post window abstains', tt.f === '+80 views in 24h', tt.f);
  check('TikTok — the pool is named: the newest posts being recorded', /80% of the ~100 gained by the 2 newest posts being tracked/.test(tt.p), tt.p);
  const nb = ttMover({ videos: { a: { s: series(300) }, n: { s: [[NOW - 19 * H, 900], [NOW - 0.5 * H, 5000]] } } },
    [{ id: 'a', title: 'Old steady one', create_time: oldS }, { id: 'n', title: 'Brand new', create_time: (NOW - 20 * H) / 1000 }],
    v => v.title, fmtUS, atb, NOW)();
  check('TikTok — a 20-hour-old post with 5,000 views is not left out', nb.f === '+5,000 views in 24h' && /“Brand new” has gained 5,000 views since it went up 20h ago/.test(nb.p), nb.p);
  check('TikTok — and its views count in the total, so the old post is not credited with 100%', /94% of the ~5,300/.test(nb.p), nb.p);
  const longCap = ttMover({ videos: { a: { s: series(80) } } },
    [{ id: 'a', title: 'Brushing the mic, no talking at all tonight #asmr #tingles #nottalking', create_time: oldS }], v => v.title, fmtUS, atb, NOW)();
  check('TikTok — a long caption is cut on a word, with an ellipsis, never mid-hashtag', /“Brushing the mic, no talking at all tonight…”/.test(longCap.p), longCap.p);
}

console.log('\nYouTube Today — built from your videos, not the lumpy channel total');
{
  const NOW = 1786000000000, H = 3600e3;
  const grab = n => { const i = YT.indexOf('function ' + n + '('); return YT.slice(i, YT.indexOf('\n  }\n', i)) + '\n  }\n'; };
  const cst = n => { const i = YT.indexOf('  const ' + n + ' = '); return YT.slice(i, YT.indexOf('\n', i)) + '\n'; };
  const today = new Function('hist', 'chanId', 'meta', 'videoIds', 'lastTotals', 'fmt', 'NOW', `
    const Date = { now: () => NOW, parse: s => globalThis.Date.parse(s) };
    const ATB = (arr, t) => { let v = null; for (const x of arr) { if (x[0] <= t) v = x; else break; } return v; };
    ${cst('ownIds')}${cst('ordinal')}
    ${YT.slice(YT.indexOf('  const fmtAgo = ts =>'), YT.indexOf('\n  };\n', YT.indexOf('  const fmtAgo = ts =>')) + 5)}
    ${grab('dayBuckets')}${grab('weekPlace')}${grab('ownViewSeries')}${grab('answerToday')}
    return answerToday;`);
  const fmtUS = new Intl.NumberFormat('en-US');
  // nine days of hourly robot readings; the channel total sits still for the last two days
  const chn = [], mine = [], alsoMine = [], theirs = [];
  for (let h = 9 * 24; h >= 0; h--) {
    const t = NOW - h * H - 20 * 60e3;
    chn.push([t, 200, h > 48 ? 128000 + (9 * 24 - h) * 5 : 128165]);
    mine.push([t, 5000 + (9 * 24 - h) * 10]);
    // a count that flips to a stale reading every other hour: no extra views
    alsoMine.push([t, 700 + Math.floor((9 * 24 - h) / 2) * 2 - (h % 2 ? 3 : 0)]);
    theirs.push([t, 1e6 + (9 * 24 - h) * 1000]);
  }
  const hist = { channels: { me: chn }, videos: { mine, alsoMine, theirs } };
  const r = today(hist, 'me', {}, ['mine', 'alsoMine'], null, fmtUS, NOW)();
  check('YouTube — a flat channel total does not read "+0 views"', r.f === '+264 views in 24h', r.f);
  check('YouTube — so the 24 hours are not called the quietest', !/Quietest|quiet 24/.test(r.h), r.h);
  check('YouTube — another channel\'s videos are left out', !/24,/.test(r.f), r.f);
  const none = today({ channels: { me: chn }, videos: { theirs } }, 'me', {}, ['mine'], null, fmtUS, NOW)();
  check('YouTube — with none of your videos recorded, it abstains instead of printing +0', /Still counting/.test(none.h) && !/\+0/.test(none.f), none.f);
}

console.log('\nYouTube Audience — the average viewer is weighted by views');
{
  const i = YT.indexOf('function answerAudience(');
  const aud = new Function('chanLifetime', 'videoIds', 'rollupMap', 'lastTotals', 'fmt', 'fmtHours',
    YT.slice(i, YT.indexOf('\n  }\n', i)) + '\n  }\nreturn answerAudience;');
  const r = aud(null, ['a', 'b'], { a: { avgPct: 80, views28: 20 }, b: { avgPct: 40, views28: 1980 } }, null, new Intl.NumberFormat('en-US'), x => x + 'h')();
  check('YouTube — a 20-view video does not count as much as a 1,980-view one', r.f === '40% watched', r.f);
  check('YouTube — and the sentence names its 28-day window', /Over the last 28 days, the average viewer gets through 40% of a video\./.test(r.p), r.p);
  const lt = aud([0, 100, 0, 55], ['a'], {}, null, new Intl.NumberFormat('en-US'), x => x + 'h')();
  check('YouTube — the lifetime figure is still used when YouTube supplies it', lt.f === '55% watched', lt.f);
}

console.log('\ncaptions — whole words, an ellipsis, never a made-up hashtag');
for (const [src, page] of [[TT, 'TikTok'], [YT, 'YouTube']]) {
  const H = new Function(src.slice(src.indexOf('  const clip = (s, n) =>'), src.indexOf('\n  };\n', src.indexOf('  const shortCap = ')) + 5) + '\nreturn { clip, shortCap };')();
  check(page + ' — a short caption is untouched', H.shortCap('Wooden block tapping', 34, 'a post') === 'Wooden block tapping');
  const c = H.shortCap('Wooden block tapping, very slow and quiet for sleep #asmr', 34, 'a post');
  check(page + ' — trailing hashtags go first when words remain', c === 'Wooden block tapping, very slow…', c);
  const d = H.clip('Brushing the mic, no talking #asmr #tingles #nottalking', 46);
  check(page + ' — clip never cuts a hashtag in half', d === 'Brushing the mic, no talking #asmr #tingles…', d);
  check(page + ' — an all-hashtag caption keeps its first whole tag', H.shortCap('#asmr #tingles #nottalking #sleep #relax #calm', 20, 'a post') === '#asmr…');
  check(page + ' — no caption falls back', H.shortCap('', 34, 'a post') === 'a post' && H.shortCap('(no caption)', 34, 'a post') === 'a post');
  check(page + ' — no fixed slices are left at the three feed sites', !/\.slice\(0, (46|34)\)\)/.test(src.replace(/NOT_A_MATCH/, '')));
}

console.log('\nHit rate — run or cold patch');
{
  const fmtUS = new Intl.NumberFormat('en-US');
  const grab = (src, n) => { const i = src.indexOf('function ' + n + '('); return src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n'; };
  const mkRows = scores => scores.map((s, i) => ({ score: s, pub: 100000 - i }));
  const ytHit = new Function('catalogueMetrics', 'fmt', grab(YT, 'answerHitRate') + '\nreturn answerHitRate;');
  // last five: 200/90/300/400/80 · older six: median 95 → three of five beat it
  const res = ytHit(() => mkRows([200, 90, 300, 400, 80, 100, 120, 90, 80, 110, 60]), fmtUS)();
  check('counts the last five against the median of everything before them', res.f === '3 of 5', res.f);
  check('and names that median in the sentence', /95 views/.test(res.p), res.p);
  check('it says what the figure is — a total so far, or a projection — not a "comparable stretch"',
    /each video’s total so far, or its estimated 48-hour total while under 2 days old/.test(res.p) &&
    !/comparable stretch/.test(grab(YT, 'answerHitRate') + grab(TT, 'answerHitRate')), res.p);
  check('and says older ones have had longer', /Older videos have had longer to add views/.test(res.p));
  check('a thin catalogue declines to call a run', /Too early/.test(ytHit(() => mkRows([200, 90, 300]), fmtUS)().h));
  check('TikTok carries the same chip against its posts', /function answerHitRate/.test(TT) && /beat your usual earlier post/.test(TT));
}

console.log('\nMilestone — a typical day, a calendar date, an honest percentage');
for (const [src, page, lbl, one, name] of [[YT, 'YouTube', 'subscribers', 'subscriber', 'liveSubs'], [TT, 'TikTok', 'followers', 'follower', 'liveFollowers']]) {
  const fmtUS = new Intl.NumberFormat('en-US');
  const grab = n => { const i = src.indexOf('function ' + n + '('); return src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n'; };
  const cst = n => { const i = src.indexOf('  const ' + n + ' ='); return src.slice(i, src.indexOf(';\n', src.indexOf('\n  }', i) > 0 && src.indexOf('\n  };\n', i) < src.indexOf('\n  const ', i + 5) ? src.indexOf('\n  };\n', i) + 3 : i) + 2); };
  const pmed = src.slice(src.indexOf('  const pjMed = '), src.indexOf('\n', src.indexOf('  const pjMed = ')));
  const pct = src.slice(src.indexOf('  const milestonePct = '), src.indexOf('\n', src.indexOf('  const milestonePct = ')));
  const live = src.slice(src.indexOf('  const ' + name + ' = '), src.indexOf('\n  };\n', src.indexOf('  const ' + name + ' = ')) + 5);
  const build = NOW => new Function('fmt', 'hist', 'chanId', 'me', 'lastTotals', `
    const RealDate = globalThis.Date;
    class Date extends RealDate { constructor(...a) { super(...(a.length ? a : [${NOW}])); } static now() { return ${NOW}; } }
    const ATB = (arr, t) => { let v = null; for (const x of arr) { if (x[0] <= t) v = x; else break; } return v; };
    ${pmed}\n${pct}\n${live}
    ${grab('nextMilestone')}${grab('dayBuckets')}${src.includes('function dropStaleDips(') ? grab('dropStaleDips') : ''}
    ${src.slice(src.indexOf('  function projectMilestone('), src.indexOf('\n  }\n', src.indexOf('  function projectMilestone(')) + 5)}
    ${grab('answerMilestone')}
    return { projectMilestone, answerMilestone, milestonePct };`);
  // Tue 29 Sep 2026, 20:00 Melbourne (AEST, UTC+10) = 10:00Z
  const NOW = globalThis.Date.UTC(2026, 8, 29, 10, 0);
  const M = build(NOW)(fmtUS, null, 'c', null, null);
  // 7 or 8 a day for two weeks, with one +420 viral day twelve days ago
  const pts = []; let v = 4450;
  for (let d = 15; d >= 0; d--) { pts.push([NOW - d * 864e5, v]); v += (d === 12 ? 420 : d % 2 ? 7 : 8); }
  pts[pts.length - 1][1] = 4870;
  const p = M.projectMilestone(pts, lbl, one);
  check(page + ' — one viral day does not set the pace (typical 7.5, not ~38)', /your typical \+7\.5 /.test(p.text.replace(/<[^>]*>/g, '')), p.text);
  check(page + ' — the basis is named', /\(a typical day of the last 14\)/.test(p.text), p.text);
  check(page + ' — and the date follows the typical pace (about 17 days)', p.daysOut > 16 && p.daysOut < 18.5 && /\(in 1[78] days\)/.test(p.text), p.text);
  check(page + ' — the unit is the full word', new RegExp(lbl + ' a day').test(p.text), p.text);
  // near the milestone late in the evening: the ETA is after midnight, so it is tomorrow
  const late = pts.map(x => x.slice()); late[late.length - 1][1] = 4995;
  const pl = M.projectMilestone(late, lbl, one);
  check(page + ' — an ETA after local midnight is "tomorrow", not "today"', /tomorrow/.test(pl.text) && !/today/.test(pl.text), pl.text);
  const soon = pts.map(x => x.slice()); soon[soon.length - 1][1] = 4999;
  const ps = M.projectMilestone(soon, lbl, one);
  check(page + ' — one short at 8pm lands "later today"', /later today/.test(ps.text), ps.text);
  check(page + ' — 99.5% there is 99%, not 100%', M.milestonePct({ cur: 4980, target: 5000 }) === 99 && M.milestonePct({ cur: 4999, target: 5000 }) === 99);
  check(page + ' — and 100% only when it is really there', M.milestonePct({ cur: 5000, target: 5000 }) === 100);
  // spiky growth: nothing on most days, a burst now and then
  const spk = []; let w = 900;
  for (let d = 15; d >= 0; d--) { spk.push([NOW - d * 864e5, w]); if (d % 5 === 0) w += 30; }
  const pk = M.projectMilestone(spk, lbl, one);
  check(page + ' — bursty growth gets no invented steady date', /comes in bursts/.test(pk.text) && pk.daysOut == null, pk.text);
  // chip: far away is "Next stop", close is "in reach"
  const hist = page === 'YouTube' ? { channels: { c: pts.map(x => [x[0], x[1], 0]) } } : { followers: pts.map(x => [x[0], x[1], 0]) };
  const chip = build(NOW)(fmtUS, hist, 'c', { follower_count: 4870 }, { subs: 4870 }).answerMilestone();
  check(page + ' — 17 days out is still "in reach" (30 days or less)', chip.h === '5,000 ' + lbl + ' is in reach.', chip.h);
  const slow = pts.map((x, i) => [x[0], 4000 + i, 0]);
  const far = build(NOW)(fmtUS, page === 'YouTube' ? { channels: { c: slow } } : { followers: slow }, 'c', null, null).answerMilestone();
  check(page + ' — a milestone months away is "Next milestone", not "in reach"', far.h === 'Next milestone: 5,000 ' + lbl + '.', far.h + ' / ' + far.p);
  check(page + ' — the chip text carries no tags', !/[<>]/.test(chip.p), chip.p);
  check(page + ' — progress is floored', chip.f === '97% of 5,000', chip.f);
  const near = page === 'YouTube' ? { channels: { c: late.map(x => [x[0], x[1], 0]) } } : { followers: late.map(x => [x[0], x[1], 0]) };
  const chip2 = build(NOW)(fmtUS, near, 'c', { follower_count: 4995 }, { subs: 4995 }).answerMilestone();
  check(page + ' — a milestone a day away is "in reach"', chip2.h === '5,000 ' + lbl + ' is in reach.', chip2.h);
  // the live count is newer than the last sample and has crossed: the chip moves on
  const stale = pts.map(x => [x[0] - 3 * 3600e3, x[1], 0]);
  const crossed = build(NOW)(fmtUS, page === 'YouTube' ? { channels: { c: stale } } : { followers: stale }, 'c', { follower_count: 5003 }, { subs: 5003 }).answerMilestone();
  check(page + ' — the live count is used, so a crossed milestone is not still "in reach"', /7,500/.test(crossed.h), crossed.h);
  check(page + ' — no history still answers', !!build(NOW)(fmtUS, null, 'c', null, null).answerMilestone().p);
}

console.log('\nSubs — Today\'s sibling on the other axis');
{
  check('YouTube — it reads column 1 of the channel history, with falls allowed', /dayBuckets\(chn, 1, 8, true\)/.test(YT));
  check('and the views chip reads the own-video series, where a fall is refused', /dayBuckets\(ownViewSeries\(chn\), 2, 8\)/.test(YT));
  check('the false rounding excuse is gone', !/rounded public subscriber counts/.test(YT) && /the public count dipped for a while/.test(YT));
  const i = YT.indexOf('function dropStaleDips(');
  const drop = new Function(YT.slice(i, YT.indexOf('\n  }\n', i)) + '\n  }\nreturn dropStaleDips;')();
  const s = drop([[1, 222], [2, 209], [3, 223], [4, 222]], 1);
  check('a stale dip that comes back is skipped, not a fake -13 then +14', s.map(x => x[1]).join() === '222,223,222', s.map(x => x[1]).join());
  const real = drop([[1, 235], [2, 234], [3, 234]], 1);
  check('a real unsubscribe is kept', real.map(x => x[1]).join() === '235,234,234');
  const gone = drop([[1, 300], [2, 250], [3, 251]], 1);
  check('a big fall that never comes back is kept', gone.map(x => x[1]).join() === '300,250,251');
}

console.log('\nNewest — the real reason a post cannot be graded');
{
  const fmtUS = new Intl.NumberFormat('en-US');
  const NOW = 1786000000000, H = 3600e3;
  const grab = (src, n) => { const i = src.indexOf('function ' + n + '('); return src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n'; };
  const helpers = src => src.slice(src.indexOf('  const clip = (s, n) =>'), src.indexOf('\n  };\n', src.indexOf('  const shortCap = ')) + 5) +
    src.slice(src.indexOf('  const fmtAgo = ts =>'), src.indexOf('\n  };\n', src.indexOf('  const fmtAgo = ts =>')) + 5) +
    src.slice(src.indexOf('  const pjDur = '), src.indexOf('\n', src.indexOf('  const pjDur = '))) + '\n';
  const tt = new Function('videos', 'scores', 'states', 'fmt', 'NOW', `
    const Date = { now: () => NOW };
    const PJ_MIN_AGE = 300, PJ_HORIZON = 2880;
    const capOf = v => (v.title || v.video_description || '').trim() || '(no caption)';
    const scoreOf = v => scores[v.id] == null ? null : scores[v.id];
    const projStateOf = v => states[v.id] || null;
    const pjRank = (pool, v) => { if (!pool.length || v == null) return null; let b = 0, s = 0; for (const x of pool) { if (x < v) b++; else if (x === v) s++; } return { pct: (b + s / 2) / pool.length * 100, n: pool.length }; };
    ${helpers(TT)}${grab(TT, 'answerNewest')}
    return answerNewest();`);
  const old = i => ({ id: 'o' + i, title: 'old ' + i, create_time: (NOW - (10 + i) * 864e5) / 1000, view_count: 1000 });
  const olds = [0, 1, 2, 3, 4].map(old);
  const sc = { o0: 900, o1: 1000, o2: 1100, o3: 1200, o4: 1300 };
  const young = { id: 'n', title: '', video_description: 'Slow tapping on a glass jar', create_time: (NOW - 3 * H) / 1000, view_count: 93 };
  const a = tt([young, ...olds], sc, { n: 'early' }, fmtUS, NOW);
  check('a 3-hour-old post: too early, and the reason is its age', /Grades start once a post is 5 hours old \(about 2 hours to go\)/.test(a.p), a.p);
  check('it quotes the description when the title is empty, not a placeholder', /“Slow tapping on a glass jar” went up 3h ago/.test(a.p), a.p);
  const z = tt([{ ...young, create_time: (NOW - 50 * H) / 1000, view_count: 0 }, ...olds], sc, {}, fmtUS, NOW);
  check('no views is its own reason', /has no views counted yet/.test(z.p), z.p);
  const l = tt([{ ...young, create_time: (NOW - 8 * H) / 1000 }, ...olds], sc, { n: 'loose' }, fmtUS, NOW);
  check('a loose projection says the posts vary too much', /vary too much at this age/.test(l.p), l.p);
  const nm = tt([{ ...young, create_time: (NOW - 8 * H) / 1000 }, ...olds], sc, { n: 'nomodel' }, fmtUS, NOW);
  check('not enough launches keeps its own sentence', /not enough of your earlier posts have their first 48 hours fully tracked/.test(nm.p), nm.p);
  const thin = tt([{ ...young, create_time: (NOW - 8 * H) / 1000 }, ...olds.slice(0, 3)], { ...sc, n: 1000 }, {}, fmtUS, NOW);
  check('the threshold counts OTHER posts, like the report card', /only 3 of your other posts can so far/.test(thin.p), thin.p);
  const ok = tt([{ ...young, create_time: (NOW - 8 * H) / 1000 }, ...olds], { ...sc, n: 1150 }, {}, fmtUS, NOW);
  check('with four others it ranks', ok.f === 'Beats 60%', ok.f);

  const yt = new Function('latestVid', 'meta', 'perVideo', 'rows', 'fmt', 'NOW', `
    const Date = function (s) { return new globalThis.Date(s); }; Date.now = () => NOW;
    const PJ_MIN_AGE = 300;
    const catalogueMetrics = () => rows;
    const videoTitle = id => meta[id].title;
    const pjRank = (pool, v) => { if (!pool.length || v == null) return null; let b = 0, s = 0; for (const x of pool) { if (x < v) b++; else if (x === v) s++; } return { pct: (b + s / 2) / pool.length * 100, n: pool.length }; };
    ${helpers(YT)}${grab(YT, 'answerNewest')}
    return answerNewest();`);
  const pub = new globalThis.Date(NOW - 3 * H).toISOString();
  const rows = [{ id: 'n', score: null, pj: 'early' }, { id: 'a', score: 1 }, { id: 'b', score: 2 }, { id: 'c', score: 3 }, { id: 'd', score: 4 }];
  const y = yt('n', { n: { title: 'My upload', publishedAt: pub } }, { n: { views: 93 } }, rows, fmtUS, NOW);
  check('YouTube — a 3-hour-old upload is not "1 day old"', /went up 3h ago/.test(y.p) && !/1 day/.test(y.p), y.p);
  check('YouTube — and the reason is its age', /Grades start once a video is 5 hours old/.test(y.p), y.p);
  const yl = yt('n', { n: { title: 'My upload', publishedAt: new globalThis.Date(NOW - 9 * H).toISOString() } }, { n: { views: 93 } },
    [{ ...rows[0], pj: 'loose' }, ...rows.slice(1)], fmtUS, NOW);
  check('YouTube — a loose projection gives that reason', /vary too much at this age/.test(yl.p), yl.p);
}

console.log('\nEngagement — one typical like rate');
{
  const fmtUS = new Intl.NumberFormat('en-US');
  const grab = (src, n) => { const i = src.indexOf('function ' + n + '('); return src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n'; };
  const pmed = TT.slice(TT.indexOf('  const pjMed = '), TT.indexOf('\n', TT.indexOf('  const pjMed = ')));
  const tl = TT.slice(TT.indexOf('  const typicalLikeRate = '), TT.indexOf('\n  };\n', TT.indexOf('  const typicalLikeRate = ')) + 5);
  const run = videos => new Function('videos', 'fmt', `
    const engOf = v => (v.view_count ? (v.like_count || 0) / v.view_count * 100 : 0);
    ${pmed}\n${tl}\n${grab(TT, 'answerEngagement')}
    return answerEngagement();`)(videos, fmtUS);
  const vids = [];
  for (let i = 0; i < 30; i++) vids.push({ id: 'p' + i, create_time: 1000 + i, view_count: 1000, like_count: 70 + i * 2 });
  const withNew = [...vids, { id: 'new', create_time: 5000, view_count: 93, like_count: 7 }];
  const a = run(withNew);
  check('the headline is neutral, not a fixed-threshold verdict', a.h === 'Your typical like rate.', a.h);
  check('the figure says it is the typical post', /% typical$/.test(a.f), a.f);
  check('a true median: 30 posts at 7.0…12.8% → 9.9%', a.f === '9.9% typical', a.f);
  check('the newest is the real newest, and 93 views is too few to judge', /too few views to judge yet \(93\)/.test(a.p), a.p);
  const b = run([...vids, { id: 'new', create_time: 5000, view_count: 1000, like_count: 87 }]);
  check('a judged newest quotes its rate and % of typical', /Your newest: 8\.7%, 88% of your usual — within 15% of it\./.test(b.p), b.p);
  const z = run([...vids, { id: 'new', create_time: 5000, view_count: 0, like_count: 0 }]);
  check('a 0-view newest is not swapped for the one before it', /too few views to judge yet \(0\)/.test(z.p), z.p);
  check('fewer than three posts says so plainly', run(vids.slice(0, 2)).h === 'Not enough posts yet.');
  check('the Account tile says it is the pooled figure', /mcell\('Overall like rate'/.test(TT) && /all likes \\u00f7 all views/.test(TT));
  check('the recorded-trends card no longer carries a live like-rate tile', !/'across the listed posts'/.test(TT));
}

console.log('\nNext — hours, then whole days');
for (const [src, page] of [[TT, 'TikTok'], [YT, 'YouTube']]) {
  const grab = n => { const i = src.indexOf('function ' + n + '('); return src.slice(i, src.indexOf('\n  }\n', i)) + '\n  }\n'; };
  const pmed = src.slice(src.indexOf('  const pjMed = '), src.indexOf('\n', src.indexOf('  const pjMed = ')));
  const NOW = 1786000000000, H = 3600e3;
  const run = agesH => {
    const pubs = agesH.map(h => NOW - h * H);
    return new Function('videos', 'videoIds', 'meta', 'NOW', `
      const Date = function (s) { return new globalThis.Date(s); }; Date.now = () => NOW;
      ${pmed}\n${src.includes('function usualGap(') ? grab('usualGap') : ''}\n${grab('answerNext')}
      return answerNext();`)(pubs.map(t => ({ create_time: t / 1000 })), pubs.map((_, i) => 'v' + i),
        Object.fromEntries(pubs.map((t, i) => ['v' + i, { publishedAt: new globalThis.Date(t).toISOString() }])), NOW);
  };
  const a = run([3, 75, 147, 219, 291]);
  check(page + ' — three hours after posting says "3 hours", not "0 days"', a.f === '3 hours', a.f);
  check(page + ' — and is on schedule against a 3-day gap', a.h === 'You’re on schedule.' && /about (every )?3\.0 days/.test(a.p), a.p);
  check(page + ' — 36 hours is "1.5 days", not "2 days"', run([36, 108, 180, 252]).f === '1.5 days', run([36, 108, 180, 252]).f);
  // hrs 40 against a 1.4-day usual: the chip must show what the verdict compares
  const due = run([40, 74, 108, 142, 176]);
  check(page + ' — the time since and the usual gap are in the same form', due.f === '1.7 days' && /about (every )?1\.4 days/.test(due.p), due.f + ' / ' + due.p);
  check(page + ' — a sub-hour usual gap reads "less than an hour"', /about (every )?less than an hour/.test(run([0.5, 0.8, 1.1, 1.4, 1.7]).p), run([0.5, 0.8, 1.1, 1.4, 1.7]).p);
  check(page + ' — the window is named', page === 'TikTok' ? /between posts \(based on your last 5\)/.test(a.p) : /\(last 5 uploads\)/.test(a.p), a.p);
  check(page + ' — a gap under a day is given in hours', /about (every )?12 hours/.test(run([2, 14, 26, 38, 50]).p), run([2, 14, 26, 38, 50]).p);
  check(page + ' — "Just posted" means under two days', run([40, 100]).h === 'Just posted.' && run([60, 100]).h === 'Keep going.');
}

console.log('\nheadlines name the real cause');
{
  check('YouTube — too few uploads is not called "too early"',
    /rows\.length < 4\) return \{ h: 'Not enough uploads to compare yet\.'/.test(YT) && /pool\.length < 4\) return \{ h: 'Not enough uploads to compare yet\.'/.test(YT));
  check('TikTok — the same case, the same shape of words', /pool\.length < 4\) return \{ h: 'Not enough posts to compare yet\.'/.test(TT));
  check('the shared projection renderers take the page\'s own noun', /const PJ_NOUN = 'video';/.test(YT) && /const PJ_NOUN = 'post';/.test(TT) &&
    !/past posts with their first 48 hours/.test(YT));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail?1:0);
