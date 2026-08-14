// Regression guard for the plateau projection.
//
// Lifts the model straight out of index.html rather than copying it, so the test cannot
// drift from what ships. The projection is the one thing on the dashboard that makes a
// claim about the future, so the properties worth pinning are the ones that keep it
// honest: it refuses to speak too early, it never claims a video will end below what it
// already has, it will not show a band tighter than its own measured error, and it throws
// away reference curves with holes in them — the two videos that look flat from 6h to 24h
// and then double are the Worker's old 6-hour window, not behaviour, and taking them as
// real would under-call every launch after them.
//
// The model exists twice — once in each dashboard, because the two are standalone single
// files by design. Section 0 pins them character-for-character, so the copy that is not
// under test cannot drift away from the copy that is.
//
// Run: node scripts/plateau.test.mjs
import fs from 'fs';
const src = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');
const ttSrc = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');
const slice = (from, to) => {
  const i = src.indexOf(from);
  if (i < 0) throw new Error('not found in index.html: ' + from);
  const j = src.indexOf(to, i);
  if (j < 0) throw new Error('end marker not found: ' + to);
  return src.slice(i, j);
};
const model = slice('const PJ_HORIZON', '  function renderProjection()');
const fmt = new Intl.NumberFormat('en-US');
const M = new Function('fmt', 'const esc=String, niceScale=()=>({lo:0,hi:1,ticks:[0,1]}), axisNum=String;\n' + model +
  '\nreturn {PJ_HORIZON,PJ_MIN_AGE,PJ_SAFETY,PJ_WEEK,PJ_WEEK_COVER,pjAt,pjRef,pjWeekRefs,pjWeek,pjMed,pjShares,pjFloorAt,pjError,pjSettle,pjDur,pjProject,pjBarHtml,pjWaitHtml,pjSentenceHtml,pjWeekHtml,pjWeekWaitHtml,pjCurveHtml,pjBodyHtml,pjClean,pjWhen,pjView,PJ_MIN_REFS,pjScore,pjRank,PJ_HORIZON};')(fmt);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

// An S-shaped launch: slow while the platform decides, then steep, then flattening —
// the shape that defeated curve fitting and forced the share-of-final approach.
function scurve(final, k, stepMin = 30, lastH = 48) {
  const f = h => 1 / (1 + Math.exp(-(h - k) / 3));
  const a = f(0), b = f(48);
  const out = [];
  for (let m = 0; m <= lastH * 60; m += stepMin) out.push([m, Math.round(final * (f(m / 60) - a) / (b - a))]);
  return out;
}

console.log('\nplateau projection');

/* 0 — the two copies of the model must be the same model */
{
  const grab = (text, from, to) => {
    const i = text.indexOf(from);
    if (i < 0) return null;
    const j = text.indexOf(to, i);
    return j < 0 ? null : text.slice(i, j);
  };
  const a = grab(src, 'const PJ_HORIZON', '  // Option C');
  const b = grab(ttSrc, 'const PJ_HORIZON', '  // Option C');
  check('the TikTok page carries the model too', !!b);
  // the wording of the surrounding prose differs (videos vs posts); the code must not
  const strip = t => (t || '').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n').replace(/\s+/g, ' ').trim();
  check('both dashboards run the identical model', strip(a) === strip(b),
    strip(a) === strip(b) ? '' : 'index and tiktok have drifted');
  // and the renderers, which is where a copy-paste fix usually gets applied to only one
  for (const fn of ['function pjBarHtml', 'function pjSentenceHtml', 'function pjCurveHtml', 'function pjWaitHtml',
                    'function pjWeekHtml', 'function pjWeekWaitHtml']) {
    const x = grab(src, fn, '\n  }\n'), y = grab(ttSrc, fn, '\n  }\n');
    check(fn.replace('function ', '') + ' is the same in both', !!y && strip(x) === strip(y));
  }
}

/* 0b — TikTok's own conversion step, which index.html does not have: the Worker stores
   absolute milliseconds and create_time is in SECONDS, so this is the one place a units
   error could quietly halve or thousand-fold every age in the model. */
{
  const cv = new Function(
    (ttSrc.slice(ttSrc.indexOf('function pjCurveOf'), ttSrc.indexOf('\n  }\n', ttSrc.indexOf('function pjCurveOf'))) + '\n  }\n') +
    '\nreturn pjCurveOf;')();
  const createSec = 1786000000;           // seconds, as TikTok reports it
  const t0 = createSec * 1000;
  const rec = { s: [[t0, 10], [t0 + 60000, 20], [t0 + 3600000, 300]] };
  const c = cv('id', createSec, rec);
  check('minute zero is age zero', c[0][0] === 0, JSON.stringify(c[0]));
  check('one minute later is age 1', c[1][0] === 1, JSON.stringify(c[1]));
  check('one hour later is age 60', c[2][0] === 60, JSON.stringify(c[2]));
  check('views come through untouched', c.map(p => p[1]).join() === '10,20,300');
  check('samples from before the post existed are dropped',
    cv('id', createSec, { s: [[t0 - 600000, 5], [t0, 10], [t0 + 60000, 20]] }).length === 2);
  check('no create_time means no curve', cv('id', 0, rec) === null);
  check('no samples means no curve', cv('id', createSec, { s: [] }) === null);
  check('out-of-order samples are sorted',
    cv('id', createSec, { s: [[t0 + 60000, 20], [t0, 10]] }).map(p => p[0]).join() === '0,1');
}

/* 1 — interpolation between recorded minutes */
{
  const c = [[0, 0], [60, 100], [120, 300]];
  check('pjAt interpolates inside the curve', M.pjAt(c, 90) === 200, M.pjAt(c, 90));
  check('pjAt is null before the curve starts', M.pjAt([[60, 10]], 30) === null);
  check('pjAt holds the last value past the end', M.pjAt(c, 999) === 300);
}

/* 2 — which curves are allowed to be references */
{
  const good = scurve(2000, 8);
  check('a complete 48h curve is a reference', !!M.pjRef(good));

  // the real artefact: samples for the first 6 hours, then nothing until the Worker's
  // window widened. The values either side are fine; the hole is what disqualifies it.
  const holed = good.filter(p => p[0] <= 360 || p[0] >= 1440);
  check('a curve with a >2h hole is rejected', M.pjRef(holed) === null);

  // starting late is not disqualifying — the curve simply abstains from the ages it
  // never saw, which is what kept every TikTok curve on the account usable
  const late = M.pjRef(good.filter(p => p[0] >= 4 * 60));
  check('a curve that starts at four hours is still a reference', !!late);
  check('and it abstains from the ages it never saw',
    M.pjShares([late], 2 * 60).length === 0 && M.pjShares([late], 6 * 60).length === 1);
  check('a late starter cannot be projected from at all on its own',
    M.pjProject([late, M.pjRef(scurve(1400, 8.2))], 2 * 60, 50).state === 'early');

  // the two real failure modes, measured off the recorded curves: a 21-hour hole ending
  // at 27h is the Worker's old window and must go; a 2-hour hole ending at 39h is a
  // missed cron in the flat tail and three of the four usable curves have one
  const artefact = good.filter(p => p[0] <= 359 || p[0] >= 1609);
  check('a 21h hole ending at 27h is rejected', M.pjRef(artefact) === null);
  const hiccup = good.filter(p => p[0] <= 2229 || p[0] >= 2359);
  check('a 2h hole ending at 39h is kept', !!M.pjRef(hiccup));
  const earlyHole = good.filter(p => p[0] <= 210 || p[0] >= 300);
  check('the same 90m hole in the fifth hour is rejected', M.pjRef(earlyHole) === null);
  check('a curve that stops at 24h is rejected',
    M.pjRef(good.filter(p => p[0] <= 1440)) === null);
  check('a curve too small for a ratio is rejected', M.pjRef(scurve(10, 8)) === null);
  check('a curve with too few samples is rejected',
    M.pjRef([[0, 0], [1440, 500], [2880, 1000]]) === null);
}

/* 3 — the states it refuses to project in */
{
  const refs = [scurve(2000, 8), scurve(1400, 8.4), scurve(3100, 7.7)].map(M.pjRef);
  check('silent under five hours', M.pjProject(refs, 4 * 60, 400).state === 'early');
  check('speaks at five hours', M.pjProject(refs, 5 * 60, 400).state === 'ok');
  /* Two days is no longer the end of the card. The launch IS over at 48 hours — that part
     never changed — but the state it lands in used to print a single grey sentence with no
     chart and no tabs, which is what a user reported as "the data stops at 48 hours". Now
     it settles rather than dies, and only retires at a week. */
  check('the launch window closes into a settled state, not a dead one',
    M.pjProject(refs, 48 * 60, 4000).state === 'settled', M.pjProject(refs, 48 * 60, 4000).state);
  check('and one minute earlier it is still projecting', M.pjProject(refs, 48 * 60 - 1, 4000).state === 'ok');
  check('it retires at a week', M.pjProject(refs, M.PJ_WEEK, 4000).state === 'done');
  check('and stays retired past it', M.pjProject(refs, 30 * 1440, 4000).state === 'done');
  check('silent with only one reference', M.pjProject(refs.slice(0, 1), 6 * 60, 400).state === 'nomodel');
  check('silent with no views yet', M.pjProject(refs, 6 * 60, 0).state === 'early');
}

/* 3b — the seven-day answer.

   Deliberately a SECOND target rather than the first one moved. Moving PJ_HORIZON to a
   week would have disqualified every reference the account already has — a curve that
   recorded 48 hours cannot cover a seven-day window — so both dashboards would have
   dropped to "0 of 2" on the day of the deploy, in exchange for a figure the recorded
   tail says is about 2% different. What is pinned here is that the two answers coexist,
   that the week one is measured off curves which actually recorded a week, and above all
   that it REFUSES to speak when its band would have to be assumed instead of measured. */
function weekCurve(final, k, tailPerDay) {
  // the launch, then the slow tail the cold sampler records: every 15 minutes out to day 7
  const out = scurve(final, k, 30);
  const at48 = out[out.length - 1][1];
  for (let m = 48 * 60 + 15; m <= 7 * 1440; m += 15) {
    out.push([m, Math.round(at48 * (1 + tailPerDay * (m - 48 * 60) / 1440))]);
  }
  return out;
}
{
  const all = [weekCurve(2000, 8, .005), weekCurve(1400, 8.15, .006),
               weekCurve(3100, 7.85, .004), weekCurve(900, 8.05, .005)];
  const refs = all.map(M.pjRef);
  check('a curve that recorded a week is still an ordinary 48-hour reference', refs.every(Boolean));
  check('its 48-hour total is unchanged by the tail behind it',
    refs[0].final === M.pjAt(scurve(2000, 8, 30), 48 * 60), refs[0].final);

  const wr = M.pjWeekRefs(refs);
  check('all four qualify for the week as well', wr.length === 4, wr.length);
  check('and the week target is larger than the 48-hour one',
    wr.every((r, i) => r.final > refs[i].final));
  check('a curve that stops at 48 hours is not a week reference',
    M.pjWeekRefs([M.pjRef(scurve(2000, 8))]).length === 0);
  check('nor is one that stops at five days',
    M.pjWeekRefs([M.pjRef(weekCurve(2000, 8, .005).filter(p => p[0] <= 5 * 1440))]).length === 0);

  // leave the first curve out and predict it, which is the claim the card makes
  const others = all.slice(1).map(M.pjRef);
  const truth48 = M.pjAt(all[0], 48 * 60), truth7 = M.pjAt(all[0], 7 * 1440);
  const p6 = M.pjProject(others, 6 * 60, M.pjAt(all[0], 6 * 60));
  check('at six hours the card answers both horizons at once', p6.state === 'ok' && !!p6.week);
  check('the week figure is the larger of the two', p6.week.mid > p6.mid);
  check('and the 48-hour one is untouched by its existence',
    p6.mid === M.pjProject(all.slice(1).map(c => ({ c: c.filter(x => x[0] <= 48 * 60), final: M.pjAt(c, 48 * 60), reach: 48 * 60 })), 6 * 60, M.pjAt(all[0], 6 * 60)).mid);
  check('the held-out curve lands inside its own 48-hour band',
    truth48 >= p6.lo && truth48 <= p6.hi, [p6.lo, truth48, p6.hi].join(' '));
  check('and inside its own seven-day band',
    truth7 >= p6.week.lo && truth7 <= p6.week.hi, [p6.week.lo, truth7, p6.week.hi].join(' '));
  check('the week band says how many posts it rests on', p6.week.n === 3, p6.week.n);

  // and past 48 hours, where the whole feature used to stop
  const p3d = M.pjProject(others, 3 * 1440, M.pjAt(all[0], 3 * 1440));
  check('three days in it is settled, and still answering', p3d.state === 'settled' && !!p3d.week);
  check('the seven-day figure still covers the truth at three days',
    truth7 >= p3d.week.lo && truth7 <= p3d.week.hi, [p3d.week.lo, truth7, p3d.week.hi].join(' '));
  check('and the band has tightened since six hours',
    (p3d.week.hi - p3d.week.lo) < (p6.week.hi - p6.week.lo),
    (p6.week.hi - p6.week.lo) + ' → ' + (p3d.week.hi - p3d.week.lo));

  /* The honesty gate, and the reason the week is held to a stricter rule than the launch:
     with only two references pjError cannot leave one out, so the band would fall back to
     PJ_FLOOR — a margin measured against a 48-hour target. Printed under a seven-day claim
     that would look exactly like a measurement and be nothing of the kind. */
  const two = M.pjWeekRefs(all.slice(1, 3).map(M.pjRef));
  check('two week references are refused rather than banded from an assumption',
    two.length === 2 && M.pjWeek(two, 6 * 60, 500) === null);
  const pTwo = M.pjProject(all.slice(1, 3).map(M.pjRef), 3 * 1440, 500);
  check('so the card settles with no week figure at all', pTwo.state === 'settled' && pTwo.week == null);
  check('and says how many more posts would turn it on', pTwo.weekHave === 2, pTwo.weekHave);
  check('in words, with the number in them',
    /2 have one so far/.test(M.pjWeekWaitHtml(pTwo.weekHave)), M.pjWeekWaitHtml(pTwo.weekHave));
  check('never claiming less than what is already counted',
    M.pjWeek(wr, 6 * 60, 99999) === null || M.pjWeek(wr, 6 * 60, 99999).lo >= 99999);
}

/* 4 — leave-one-out: predict each recorded curve from the others, which is the claim
   the card makes about itself. The absolute error depends on the account, so what is
   pinned here is the shape of it: high coverage on an account whose launches resemble
   each other, and a band that keeps widening until it either covers or gives up. */
function loo(all, h) {
  let worst = 0, covered = 0, band = 0, spoke = 0;
  all.forEach((truthCurve, i) => {
    const refs = all.filter((_, j) => j !== i).map(M.pjRef);
    const truth = M.pjAt(truthCurve, 48 * 60);
    const p = M.pjProject(refs, h * 60, M.pjAt(truthCurve, h * 60));
    if (p.state !== 'ok') return;
    spoke++;
    worst = Math.max(worst, Math.abs(p.mid / truth - 1));
    band = Math.max(band, (p.hi - p.lo) / p.mid);
    if (truth >= p.lo && truth <= p.hi) covered++;
  });
  return { worst, covered, band, spoke, n: all.length };
}
{
  // one creator's launches: the same shape, differing in size and in how quickly the
  // platform picked each one up. A real channel is not four unrelated curves.
  const all = [scurve(2000, 8), scurve(1400, 8.15), scurve(3100, 7.85), scurve(900, 8.05)];
  const at6 = loo(all, 6), at12 = loo(all, 12), at18 = loo(all, 18);
  check('it speaks about every video from six hours on', at6.spoke === at6.n, at6.spoke + '/' + at6.n);
  check('every unseen curve lands inside its own band at 6h', at6.covered === at6.n, at6.covered + '/' + at6.n);
  check('and at 12h', at12.covered === at12.n, at12.covered + '/' + at12.n);
  check('and at 18h', at18.covered === at18.n, at18.covered + '/' + at18.n);
  check('the midpoint sharpens with age', at18.worst <= at12.worst && at12.worst <= at6.worst,
    [at6, at12, at18].map(v => v.worst.toFixed(3)).join(' → '));
  check('and so does the band', at18.band < at12.band && at12.band < at6.band,
    [at6, at12, at18].map(v => v.band.toFixed(3)).join(' → '));
}

/* 4b — the margin is measured from the account's own curves, not assumed */
{
  const steady  = [scurve(2000, 8), scurve(1400, 8.15), scurve(3100, 7.85), scurve(900, 8.05)];
  const varied  = [scurve(2000, 8), scurve(1400, 8.8), scurve(3100, 7.4), scurve(900, 8.3)];
  const erratic = [scurve(2000, 5), scurve(1400, 11), scurve(3100, 7), scurve(900, 13)];
  const b = set => { const p = M.pjProject(set.map(M.pjRef), 6 * 60, 500); return p.state === 'ok' ? (p.hi - p.lo) / p.mid : Infinity; };
  check('a consistent account gets a tight band', b(steady) < 0.2, b(steady).toFixed(3));
  check('a varied one gets a visibly wider band', b(varied) > b(steady) * 2, b(varied).toFixed(3));
  check('an erratic one is refused outright', b(erratic) === Infinity &&
    M.pjProject(erratic.map(M.pjRef), 6 * 60, 500).state === 'loose');
  // even where the model is wrong, being wrong and narrow is the failure that matters
  const mv = loo(varied, 6);
  check('a varied account is still covered 3 times in 4', mv.covered >= 3, mv.covered + '/' + mv.n);

  const refs = steady.map(M.pjRef);
  check('the measured error shrinks as the launch ages',
    M.pjError(refs, 18 * 60) < M.pjError(refs, 6 * 60),
    M.pjError(refs, 6 * 60).toFixed(3) + ' → ' + M.pjError(refs, 18 * 60).toFixed(3));
  check('two references cannot be left one out', M.pjError(refs.slice(0, 2), 6 * 60) === null);
}

/* 5 — the band cannot lie in either direction */
{
  // two references that agree perfectly: the spread is zero and there are too few to
  // leave one out, so only PJ_FLOOR stands between the reader and a fabricated ±0% band
  const twins = [M.pjRef(scurve(2000, 8)), M.pjRef(scurve(4000, 8))];
  const p = M.pjProject(twins, 6 * 60, 500);
  check('two identical references fall back to the 6h floor',
    (p.hi - p.lo) / 2 / p.mid >= 0.18, ((p.hi - p.lo) / 2 / p.mid).toFixed(3));

  const refs = [scurve(2000, 8), scurve(1400, 8.4), scurve(3100, 7.7)].map(M.pjRef);
  // a video already far past what the references suggest: the low end must not sit
  // below a count that has already happened
  const q = M.pjProject(refs, 6 * 60, 9000);
  check('the low end never falls below the current count', q.lo >= 9000, q.lo);
  check('the high end stays above the low end', q.hi > q.lo);
  check('progress never exceeds 100%', M.pjProject(refs, 6 * 60, 9e6).pct <= 1);

  // doubling the count doubles the projection — the model is a ratio and nothing else
  const a = M.pjProject(refs, 6 * 60, 500), b2 = M.pjProject(refs, 6 * 60, 1000);
  check('projection scales with the count', Math.abs(b2.mid / a.mid - 2) < 0.01, b2.mid / a.mid);
}

/* 6 — the countdown */
{
  const refs = [scurve(2000, 8), scurve(1400, 8.4), scurve(3100, 7.7)].map(M.pjRef);
  const t90 = M.pjSettle(refs);
  const share = M.pjMed(M.pjShares(refs, t90));
  check('pjSettle lands on the 90% point', share >= 0.9 && share < 0.96, share.toFixed(3));
  check('the countdown shrinks as the video ages',
    M.pjProject(refs, 12 * 60, 900).rest < M.pjProject(refs, 6 * 60, 500).rest);
  check('the countdown is gone once it has settled', M.pjProject(refs, 40 * 60, 1900).rest === 0);
}

/* 7 — the bar geometry stays inside the track */
{
  const refs = [scurve(2000, 8), scurve(1400, 8.4), scurve(3100, 7.7)].map(M.pjRef);
  const p = M.pjProject(refs, 6 * 60, 500);
  check('the bar is only asked to draw a real projection', p.state === 'ok', p.state);
  const html = M.pjBarHtml(p, 500);
  const nums = [...html.matchAll(/(?:left|width):([\d.]+)%/g)].map(m => +m[1]);
  check('every bar offset is a real percentage', nums.length >= 4 && nums.every(n => n >= 0 && n <= 100), nums.join(','));
  const m = html.match(/pjband" style="left:([\d.]+)%;width:([\d.]+)%/);
  check('the likely-end block reaches the right edge', Math.abs(+m[1] + +m[2] - 100) < 0.2, +m[1] + +m[2]);
  const fill = +html.match(/pjfill" style="width:([\d.]+)%/)[1];
  check('the filled part stops short of the likely-end block', fill < +m[1], fill + ' vs ' + m[1]);
}

/* 8 — durations read as English */
{
  check('minutes stay minutes', M.pjDur(35) === '35 minutes', M.pjDur(35));
  check('an hour is "hour"', M.pjDur(50) === 'hour', M.pjDur(50));
  check('two hours is "2 hours"', M.pjDur(100) === '2 hours', M.pjDur(100));
  check('eleven hours rounds cleanly', M.pjDur(11 * 60) === '11 hours', M.pjDur(11 * 60));
}

/* 9 — the waiting state, which is what the user actually saw */
{
  const from = (startMin, toMin) => scurve(1000, 8).filter(p => p[0] >= startMin && p[0] <= toMin);
  const cand = (startMin, age) => ({ curve: from(startMin, age), age });
  const holed = { curve: scurve(1000, 8).filter(p => p[0] <= 359 || p[0] >= 1609), age: 40 * 60 };

  // nothing finished, one launch still recording: not enough to promise a pair
  const one = M.pjProject([], 6 * 60, 400, [cand(0, 20 * 60)]);
  check('with nothing finished it waits', one.state === 'nomodel');
  check('and counts what it has', one.have === 0, one.have);
  check('one on the way is not a pair, so no time is promised', one.when === null, one.when);
  check('but it says something IS coming', one.onTrack === 1, one.onTrack);

  // two recording: the countdown is the SECOND one, not the first
  const two = M.pjProject([], 6 * 60, 400, [cand(0, 30 * 60), cand(0, 10 * 60), holed]);
  check('two on the way gives a time', two.when !== null);
  check('and it is when the second lands', two.when === 44 * 60 - 10 * 60, two.when);
  check('a holed curve is never counted as on the way', two.onTrack === 2, two.onTrack);

  // THE ONE THAT MATTERS: a finished reference the target has not yet aged into.
  // Recording started 29h in, the target is 19h old — the wait is the target growing,
  // not the reference finishing, and a countdown that ignores that is a false promise.
  const late = [cand(29 * 60, 50 * 60), cand(29 * 60, 50 * 60)].map(c => ({ ...c, curve: from(29 * 60, 48 * 60) }));
  check('a late-recorded reference is complete', !!M.pjRef(late[0].curve));
  const gap = M.pjProject([], 19 * 60, 400, late);
  check('and the wait is the target reaching its start age, not zero',
    gap.when === 29 * 60 - 19 * 60, gap.when + ' vs ' + (29 * 60 - 19 * 60));

  // whereas an older target is served immediately by the same curves
  const older = M.pjWhen(late, 2, 30 * 60);
  check('the same references are ready now for an older target', older.when === 0, older.when);

  // a curve whose window closed short is never promised
  check('a curve past 48h that never covered enough is not promised',
    M.pjProject([], 6 * 60, 400, [{ curve: from(0, 1440), age: 60 * 60 }]).when === null);

  // pjClean separates "still going" from "broken"
  check('pjClean reports how far a curve is cleanly recorded', M.pjClean(from(0, 1200)) === 1200);
  check('and -1 for one with a hole where it matters', M.pjClean(holed.curve) === -1);
}

/* 10 — the block can never render nothing */
{
  const refs = [scurve(2000, 8), scurve(1400, 8.4), scurve(3100, 7.7)].map(M.pjRef);
  const own = scurve(2400, 8.1);
  const states = [
    ['projecting', M.pjProject(refs, 6 * 60, 600, [])],
    ['too early', M.pjProject(refs, 2 * 60, 40, [])],
    ['no references', M.pjProject([], 6 * 60, 600, [])],
    ['past the window', M.pjProject(refs, 60 * 60, 2400, [])],
    ['too varied', M.pjProject([scurve(2000, 2), scurve(1400, 20), scurve(900, 6)].map(M.pjRef), 6 * 60, 300, [])],
  ];
  for (const [name, p] of states) {
    const html = M.pjBodyHtml(p, 600, own, p.refs || refs, 6 * 60);
    check(name + ' still renders something', !!html && html.replace(/<[^>]*>/g, '').trim().length > 20,
      name + ' -> ' + JSON.stringify(html).slice(0, 60));
  }
}

/* 11 — the comparable score that replaces views-per-day */
{
  const full = scurve(2000, 8);                                 // a finished launch
  const part = scurve(2000, 8).filter(p => p[0] <= 6 * 60);     // one six hours in
  const refs = [scurve(1900, 8.1), scurve(2100, 7.9), scurve(1500, 8)].map(M.pjRef);
  const cands = [];
  const H = M.PJ_HORIZON;

  check('past the launch window the score is the lifetime count',
    M.pjScore(full, 60 * 1440, 2270, refs, cands) === 2270);
  check('and it does not quietly substitute the recorded 48h total instead',
    M.pjScore(full, 60 * 1440, 2270, refs, cands) !== M.pjAt(full, H));
  check('a video with no views scores nothing rather than zero',
    M.pjScore(null, 60 * 1440, 0, refs, cands) === null);

  const live = M.pjScore(part, 6 * 60, M.pjAt(part, 6 * 60), refs, cands);
  check('inside the window it is the projection', live > 1500 && live < 2600, live);
  check('and null when the projection cannot be made',
    M.pjScore(null, 6 * 60, 500, [], cands) === null);
  check('null too soon after publishing, rather than a raw count nobody can compare',
    M.pjScore(null, 60, 40, refs, cands) === null);

  /* THE PROPERTY THE OLD METRIC FAILED. Follow one launch across its life and the score
     must barely move; views-per-day moved by more than an order of magnitude on the same
     three readings, which is what made the ranking a clock. */
  const at6 = M.pjScore(part, 6 * 60, M.pjAt(part, 6 * 60), refs, cands);
  const at48 = M.pjScore(full, H + 1, M.pjAt(full, H), refs, cands);
  const at60d = M.pjScore(full, 60 * 1440, Math.round(M.pjAt(full, H) * 1.12), refs, cands);
  const newSwing = Math.max(at6, at48, at60d) / Math.min(at6, at48, at60d);
  check('the same launch scores within a quarter of itself at 6h, 48h and 60 days',
    newSwing < 1.25, [at6, at48, at60d].map(Math.round).join(' / '));
  // the residual is the slow tail, and it runs the OTHER way: older scores slightly higher
  check('and what residual there is favours the older reading, not the newer one',
    at60d >= at48, at60d + ' vs ' + at48);

  const vpd = (v, ageD) => v / Math.max(1, ageD);   // with the page's own day-one floor
  const oldSwing = vpd(M.pjAt(part, 6 * 60), 0.25) / vpd(Math.round(M.pjAt(full, H) * 1.12), 60);
  check('views-per-day swings many times more on the identical launch',
    oldSwing / newSwing > 5, oldSwing.toFixed(1) + 'x vs ' + newSwing.toFixed(2) + 'x');

  const pool = [100, 200, 300, 400];
  check('pjRank reports the percentile and the pool size',
    M.pjRank(pool, 350).pct === 75 && M.pjRank(pool, 350).n === 4);
  // a tie belongs in the middle of its group. Strictly-less-than graded an account whose
  // posts all sit at the same rate as F, for being exactly typical.
  check('an exact tie with the whole pool is the middle, not the bottom',
    M.pjRank([5, 5, 5, 5], 5).pct === 50, M.pjRank([5, 5, 5, 5], 5).pct);
  check('and a tie inside a spread splits its own group',
    M.pjRank([1, 5, 5, 9], 5).pct === 50, M.pjRank([1, 5, 5, 9], 5).pct);
  check('the best in the pool still tops it', M.pjRank([1, 2, 3, 9], 9).pct === 87.5);
  check('and refuses a null value rather than ranking it as zero', M.pjRank(pool, null) === null);
  check('and an empty pool', M.pjRank([], 5) === null);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
