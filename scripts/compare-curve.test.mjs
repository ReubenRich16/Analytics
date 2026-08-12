// Regression guard for compare.html's launch-race maths.
//
// Lifts atHour and typicalCurve straight out of the page (rather than copying them, which
// would let the copy drift from the original) and checks the property that broke when the
// Worker's launch window went from 6 hours to 48: atHour used to hold a curve's final value
// forever, so every older 6-hour curve was counted as flat all the way out to hour 48. That
// dropped the median "typical launch" the indexed line divides by, and a post performing
// exactly normally read as several hundred percent.
//
// Run: node scripts/compare-curve.test.mjs
import fs from 'fs';
const src = fs.readFileSync(new URL('../yt-dashboard/compare.html', import.meta.url), 'utf8');
const grab = (name, end) => { const i = src.indexOf(name); return src.slice(i, src.indexOf(end, i)); };
const atHourSrc = grab('const atHour =', '// the platform');
const typSrc    = grab('function typicalCurve', '\n  }\n') + '\n  }\n';
const fn = new Function(atHourSrc + '\n' + typSrc + '\nreturn {atHour, typicalCurve};')();
const { atHour, typicalCurve } = fn;

let pass=0, fail=0;
const check=(n,c,x='')=>{ if(c){pass++;console.log('  ✓',n);} else {fail++;console.log('  ✗',n,x);} };

// a 6-hour curve (the old HOT_HOURS) and a full 48-hour one
const short = Array.from({length:7},(_,h)=>[h, 1000+h*700]);        // ends at h=6, 5,200 views
const long  = Array.from({length:49},(_,h)=>[h, 1000+h*700]);       // same rate, runs to h=48

console.log('\n1. atHour stops where the recording stops');
check('inside the curve it steps to the last point at or before h', atHour(short, 3) === 3100, atHour(short,3));
check('at the exact last point it still answers', atHour(short, 6) === 5200, atHour(short,6));
check('past the end it returns null, not the last value', atHour(short, 48) === null, atHour(short,48));
check('float drift at the boundary does not drop the last point',
  atHour(short, 6 + 1e-9) === 5200, atHour(short, 6+1e-9));

console.log('\n2. typicalCurve no longer drags short curves along flat');
{
  // the realistic mix right after the window widens: mostly old 6h curves, one full one
  const pool = [short, short, short, long];
  const typ = typicalCurve(pool, 48);
  const near = h => typ.reduce((b,p)=>Math.abs(p[0]-h)<Math.abs(b[0]-h)?p:b);
  const tail = typ[typ.length-1];
  check('the typical line stops instead of flat-lining', tail[1] === null, JSON.stringify(tail));
  const beyond6 = typ.filter(p => p[0] > 6.0001);
  check('everything past the shortest curves is null', beyond6.length > 0 && beyond6.every(p => p[1] === null),
    JSON.stringify(beyond6.slice(0,3)));
  const at3 = near(3);
  check('and is still a real median where the evidence is', at3[1] === 1000 + Math.floor(at3[0])*700, JSON.stringify(at3));

  // the bug this replaces: a post performing EXACTLY typically read as ~400%
  const oldAtHour = (s,h)=>{let v=null;for(const x of s){if(x[0]<=h)v=x[1];else break;}return v;};
  const oldTyp = oldAtHour(short, 48);                    // 5,200 — a 6h total held flat
  const actual = oldAtHour(long, 48);                     // 34,600 — the real 48h total
  check('(old behaviour really did inflate: ' + Math.round(actual/oldTyp*100) + '%)', actual/oldTyp > 3);
  check('new behaviour refuses to divide by a fabricated number', atHour(short, 48) === null);
}

console.log('\n3. A single surviving curve is not a "typical launch"');
{
  const typ = typicalCurve([short, long], 48);
  check('one curve past the cut yields null, not an anecdote', typ[typ.length-1][1] === null, JSON.stringify(typ[typ.length-1]));
}
console.log('\n4. "Time to a thousand" only counts crossings somebody watched');
{
  /* firstAt returned the first sample at or above the target, which for a back-catalogue
     video is not a duration: the robot started 2026-07-08, so a January upload's first
     sample sits at age ~4,344 hours and already past a thousand views. 29 of the 85 videos
     in data/history.json are above 1,000 in their very first sample. That number then set
     the "Your usual" median (181d 0h), the bar scale, and the "2172x faster" multiplier. */
  const firstAtSrc = grab('  function firstAt(series, target)', '\n  const fmtDur');
  const firstAt = new Function(firstAtSrc + '\nreturn firstAt;')();

  const watched = [[0, 100], [2, 600], [5, 1400], [9, 2200]];
  check('a crossing that was observed is reported', firstAt(watched, 1000) === 5, firstAt(watched, 1000));

  // the real shape: recording begins months after publication, already well past target
  const backCatalogue = [[4344, 1107], [4368, 1120], [4392, 1131]];
  check('a video already past the target at first sight reports nothing',
    firstAt(backCatalogue, 1000) === null, firstAt(backCatalogue, 1000));
  check('and specifically not its age when recording began',
    firstAt(backCatalogue, 1000) !== 4344);

  check('a curve that never gets there is still null', firstAt(watched, 99999) === null);
  check('an empty series is null', firstAt([], 1000) === null);
  check('exactly at the target on the first sample still counts as unobserved',
    firstAt([[3, 1000], [4, 1200]], 1000) === null);
  check('but crossing on the second sample is observed',
    firstAt([[3, 999], [4, 1200]], 1000) === 4);

  // the median that drives "Your usual" must not be dragged by the unobserved ones
  const cat = [ [[0,10],[6,1200]], [[0,10],[9,1100]], backCatalogue, [[0,5],[3,1500]] ];
  const vals = cat.map(s => firstAt(s, 1000)).filter(v => v != null).sort((a, b) => a - b);
  check('the back-catalogue video drops out of the median entirely',
    vals.join(',') === '3,6,9', vals.join(','));
  check('so "your usual" stays in hours, not months', vals[vals.length >> 1] === 6, vals[vals.length >> 1]);
}

console.log('\n5. Placing best on the channel is not "Top 0%"');
{
  const pctSrc = grab('  const perDay = v =>', '\n  /* ---------- render');
  const percentile = new Function(pctSrc + '\nreturn percentile;')();
  const DAY = 864e5, now = Date.now();
  const mk = (id, perDay) => ({ id, views: perDay * 10, pub: now - 10 * DAY });

  const five = [mk('a', 1), mk('b', 2), mk('c', 3), mk('d', 4), mk('e', 5)];
  const best = percentile(five, five[4]);
  check('the best post beats everything', best.beat === 100, best.beat);
  check('but it is labelled top 20%, not top 0%', best.top === 20, best.top);

  const many = Array.from({ length: 84 }, (_, i) => mk('v' + i, i + 1));
  const second = percentile(many, many[82]);
  check('the runner-up of 84 beats all but one', second.beat === 99, second.beat);
  check('and places second, not zeroth', second.top === 2, second.top);
  const top1 = percentile(many, many[83]);
  check('the actual best places first', top1.top === 1, top1.top);

  /* Rounding is what made this more than one edge case: beat is Math.round-ed, so it
     reaches 100 for any ratio at or above 0.995 — from ~200 posts up, the runner-up
     printed "Top 0%" as well. */
  const big = Array.from({ length: 250 }, (_, i) => mk('b' + i, i + 1));
  check('past ~200 posts even the runner-up rounds to beating 100%',
    percentile(big, big[248]).beat === 100, percentile(big, big[248]).beat);
  check('and it is still given a real placing', percentile(big, big[248]).top === 1, percentile(big, big[248]).top);

  const worst = percentile(five, five[0]);
  check('the worst post beats nothing', worst.beat === 0);
  check('and is in the top 100%, which is at least true', worst.top === 100, worst.top);
  check('no rank can ever be 0%', [...many.keys()].every(i => percentile(many, many[i]).top >= 1));
  check('too few posts still declines to rank', percentile(five.slice(0, 3), five[0]) === null);

  // and the page must consume the two fields for what they are
  check('the bar is filled from the beaten share', /width:' \+ pct\.beat \+ '%/.test(src));
  check('while the headline prints the placing', /Top ' \+ pct\.top \+ '%/.test(src));
  check('nothing still computes 100 - a percentile', !/100 - [ty]p\b/.test(src));
}

console.log('\n6. One recorded side is not an overlap');
{
  /* `Math.min(yEnd, tEnd) || 6` — a missing side contributes 0, Math.min(48, 0) is 0, and
     `0 || 6` is 6. So a 48-hour YouTube curve whose TikTok partner predates the Worker was
     plotted for six hours, dropping seven eighths of it, under "This pair overlaps for
     6 hours" — an overlap with nothing. */
  const spanOf = (yEnd, tEnd) => {
    const bothSides = yEnd > 0 && tEnd > 0;
    return { bothSides, span: Math.max(1, bothSides ? Math.min(yEnd, tEnd) : (yEnd || tEnd)) };
  };
  check('two real curves still clip to the shorter one', spanOf(48, 9).span === 9);
  check('a missing TikTok side shows YouTube in full', spanOf(48, 0).span === 48);
  check('a missing YouTube side shows TikTok in full', spanOf(0, 48).span === 48);
  check('and neither is called an overlap', !spanOf(48, 0).bothSides && !spanOf(0, 48).bothSides);
  check('while two curves are', spanOf(48, 9).bothSides);
  check('nothing recorded at all still floors at 1', spanOf(0, 0).span === 1);
  check('the six-hour invention is gone from the page',
    /const span = Math\.max\(1, bothSides \?/.test(src) &&
    !/const span = Math\.max\(1, Math\.min\(/.test(src));
  check('and the page only claims an overlap when both sides exist',
    /bothSides[\s\S]{0,120}This pair overlaps for/.test(src));
}

console.log('\n' + (fail?'✗ '+fail+' FAILED, ':'') + pass + ' passed');
process.exit(fail?1:0);
