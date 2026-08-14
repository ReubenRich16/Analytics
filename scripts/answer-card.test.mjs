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
contract(YT, 'YouTube', ['answerToday','answerNewest','answerAudience','answerNext']);
contract(TT, 'TikTok',  ['answerToday','answerNewest','answerEngagement','answerNext']);

console.log('\nboth cards are wired the same way');
for (const [page, src] of [['YouTube', YT], ['TikTok', TT]]) {
  check(page + ' has the card markup', /id="answerCard"/.test(src) && /id="answerChips"/.test(src) && /id="answerBody"/.test(src));
  check(page + ' paints through one dispatcher', /\[answerToday, answerNewest, answer(Audience|Engagement), answerNext\]\[answerChip\]/.test(src));
  check(page + ' falls back rather than throwing', /catch \(e\) \{ a = \{ h: /.test(src));
  check(page + ' builds its chips once', /chips\.dataset\.built/.test(src));
  check(page + ' names four chips', (src.match(/const ANSWER_CHIPS = \[[^\]]+\]/) || [''])[0].split(',').length === 4,
    (src.match(/const ANSWER_CHIPS = \[[^\]]+\]/) || [''])[0]);
}

console.log('\nthe TikTok card answers what TikTok can actually answer');
{
  /* YouTube's third chip is Audience, from retention and demographics. TikTok's Display API
     exposes neither, so shipping an "Audience" chip there could only ever be empty. */
  check('it does not pretend to have audience data', !/answerAudience/.test(TT));
  check('it answers Engagement instead', /'Engagement'/.test(TT) && /function answerEngagement/.test(TT));
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
  check('the two "too early" reasons are told apart',
    /launch window is still running/.test(body) && /Four comparable posts are needed/.test(body));
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
console.log('\nToday — yesterday and the week');
for (const [src, page, unit] of [[YT, 'YouTube', 'views'], [TT, 'TikTok', 'followers']]) {
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
    /if \(!b\[0\] \|\| !b\[0\]\.ok\) return \{/.test(src) &&
    /(came back lower than it was)/.test(src));

  // the sentences
  const mk = rates => rates.map((r, i) => ({ ok: true, gain: r, spanH: 24, rate: r }));
  const best = M.weekPlace(mk([300, 100, 90, 80, 70, 60, 50, 40]), unit);
  check(page + ' — a clear best day says so', /best day/i.test(best.h), best.h);
  check(page + ' — and places itself in the week', /places first/.test(best.p), best.p);
  check(page + ' — the figure carries the unit', best.f === '+300 ' + unit, best.f);
  const mid = M.weekPlace(mk([100, 100, 300, 90, 80, 70, 60, 50]), unit);
  check(page + ' — a middling day gets an ordinal', /places \d+(st|nd|rd|th)/.test(mid.p), mid.p);
  check(page + ' — and quotes yesterday', /yesterday/.test(mid.p), mid.p);

  /* Yesterday at 2 and today at 3 is "+50% versus yesterday" — true, and useless. Below a
     floor the chip prints both numbers instead of a ratio. */
  const tiny = M.weekPlace([{ ok: true, rate: 3, spanH: 24, gain: 3 }, { ok: true, rate: 2, spanH: 24, gain: 2 }], unit);
  check(page + ' — a tiny yesterday is not turned into a percentage', !/%/.test(tiny.p), tiny.p);
  const gone = M.weekPlace([{ ok: true, rate: 40, spanH: 24, gain: 40 }, { ok: false }], unit);
  check(page + ' — a missing yesterday says so rather than dividing by nothing',
    /nothing to hold it against/.test(gone.p), gone.p);
  const odd = M.weekPlace([{ ok: true, rate: 40, spanH: 19, gain: 32 }, { ok: true, rate: 40, spanH: 24, gain: 40 }], unit);
  check(page + ' — a scaled window admits it was scaled', /scaled to a day/.test(odd.p), odd.p);
  check(page + ' — every answer is still a paintable {h,f,p}',
    [best, mid, tiny, gone, odd].every(a => a && a.h && a.f && a.p));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail?1:0);
