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
// Run: node scripts/plateau.test.mjs
import fs from 'fs';
const src = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');
const slice = (from, to) => {
  const i = src.indexOf(from);
  if (i < 0) throw new Error('not found in index.html: ' + from);
  const j = src.indexOf(to, i);
  if (j < 0) throw new Error('end marker not found: ' + to);
  return src.slice(i, j);
};
const model = slice('const PJ_HORIZON', '  // Option C');
const bar = slice('function pjBarHtml', '\n  }\n') + '\n  }\n';
const fmt = new Intl.NumberFormat('en-US');
const M = new Function('fmt', model + '\n' + bar +
  '\nreturn {PJ_HORIZON,PJ_MIN_AGE,PJ_SAFETY,pjAt,pjRef,pjMed,pjShares,pjFloorAt,pjError,pjSettle,pjDur,pjProject,pjBarHtml};')(fmt);

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
  check('retires at the 48h horizon', M.pjProject(refs, 48 * 60, 4000).state === 'done');
  check('silent with only one reference', M.pjProject(refs.slice(0, 1), 6 * 60, 400).state === 'nomodel');
  check('silent with no views yet', M.pjProject(refs, 6 * 60, 0).state === 'early');
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
