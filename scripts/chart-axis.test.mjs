// The x axis of lineChartHtml must be real time whenever `at` is given — the recorded
// history samples every ~5 min for two days then hourly, and index-spacing stretched
// those two days across most of the plot.
import fs from 'fs';
// resolved from this file, not an absolute path: the suite has to run wherever the repo
// is checked out, and a hard-coded /home/... only existed on one machine
const src = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');
const cut=(a,b)=>{const i=src.indexOf(a);return src.slice(i,src.indexOf(b,i));};
const F = new Function('reducedMotion','fmt',
  'const esc=s=>String(s); let CH=[]; const chartPush=o=>CH.push(o)-1;\n' +
  cut('function niceScale(lo, hi, target)','  // legend keys mirror the mark') +
  cut('const LINE_GEO','  // A column chart.') +
  '\nreturn {lineChartHtml, axisNum, niceScale, chartFrame, CH};')(true, new Intl.NumberFormat('en-US'));
let pass=0,fail=0; const check=(n,c,x='')=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗',n,x));};
const xs = h => [...h.matchAll(/M([\d.]+),|L([\d.]+),/g)].map(m=>+(m[1]||m[2]));

console.log('\nlineChartHtml time axis');
// two days at 5 min, then five days hourly — the real recorded shape
const at=[], pts=[]; let t=Date.parse('2026-08-01T00:00:00Z');
for (let i=0;i<576;i++){ at.push(t); pts.push(10); t+=5*60000; }
for (let i=0;i<120;i++){ at.push(t); pts.push(10); t+=3600e3; }
const withAt = F.lineChartHtml(pts, pts.map(String), 'red', { at });
const noAt   = F.lineChartHtml(pts, pts.map(String), 'red', {});
const a = xs(withAt), b = xs(noAt);
check('index spacing puts the dense two days past the halfway mark',
  b[575] > (66 + 602) / 2, 'x=' + b[575]);
const span = 602 - 66, frac = (a[575] - 66) / span;
check('real time puts them in the first third where they belong', frac < 0.34, frac.toFixed(3));
check('the whole series still spans the plot', Math.abs(a[a.length-1] - 602) < 1, a[a.length-1]);

// a hole must break the path, not draw a straight line across it
const at2=[], pts2=[]; let u=Date.parse('2026-08-01T00:00:00Z');
for (let i=0;i<40;i++){ at2.push(u); pts2.push(5); u+=3600e3; }
u += 5*864e5;                                    // five days with nothing recorded
for (let i=0;i<40;i++){ at2.push(u); pts2.push(5); u+=3600e3; }
const holed = F.lineChartHtml(pts2, pts2.map(String), 'red', { at: at2 });
const dAttr = (holed.match(/class="line[^"]*" pathLength="1" d="([^"]+)"/) || [])[1] || '';
check('a five-day hole breaks the line', (dAttr.match(/M/g)||[]).length === 2, (dAttr.match(/M/g)||[]).length + ' segments');
const fill = (holed.match(/fill="url\(#lg\d+\)"/) ) ? (holed.match(/ d="([^"]+)" fill="url/)||[])[1]||'' : '';
check('and the area fill breaks with it', (fill.match(/M/g)||[]).length === 2, (fill.match(/M/g)||[]).length + ' segments');
check('an evenly spaced series is unchanged by the new code path',
  JSON.stringify(xs(F.lineChartHtml([1,2,3,4],['a','b','c','d'],'red',{}))) ===
  JSON.stringify(xs(F.lineChartHtml([1,2,3,4],['a','b','c','d'],'red',{at:[0,1,2,3].map(i=>i*60000)}))));
// the tooltip has to name the sample the crosshair is standing on, which stopped being
// the arithmetic index the moment the x axis became real time
console.log('\ntooltip index');
{
  const at2 = [], pts2 = []; let t2 = 0;
  for (let i = 0; i < 100; i++) { at2.push(t2); pts2.push(i); t2 += 60000; }      // dense
  for (let i = 0; i < 10; i++)  { at2.push(t2); pts2.push(100 + i); t2 += 3600e3; } // sparse
  F.CH.length = 0;
  F.lineChartHtml(pts2, pts2.map(String), 'red', { at: at2 });
  const d = F.CH[F.CH.length - 1];
  const nearest = xv => { let b = 0, bd = Infinity; for (let i = 0; i < d.xs.length; i++) { const q = Math.abs(d.xs[i] - xv); if (q < bd) { bd = q; b = i; } } return b; };
  const arith = xv => Math.max(0, Math.min(d.tips.length - 1, Math.round((xv - d.L) / Math.max(1, d.w - d.L - d.R) * (d.tips.length - 1))));
  // stand on the very first point: nearest is 0, arithmetic is also 0 — agree
  check('both agree at the left edge', nearest(d.L) === arith(d.L));
  // stand in the middle of the plot: the dense half is long over, arithmetic is far off
  const mid = (d.L + (d.w - d.R)) / 2;
  check('arithmetic indexing names the wrong sample mid-plot', nearest(mid) !== arith(mid),
    'nearest ' + nearest(mid) + ' vs arithmetic ' + arith(mid));
  check('and nearest actually lands on the closest pixel',
    Math.abs(d.xs[nearest(mid)] - mid) <= Math.abs(d.xs[arith(mid)] - mid));
  check('the shipped moveTip uses the nearest-pixel search',
    /for \(let i = 0; i < d\.xs\.length; i\+\+\)[\s\S]{0,160}best = dist/.test(src),
    'moveTip still indexes arithmetically');
}

// a tick label must never repeat on consecutive gridlines
console.log('\naxis labels');
{
  const sc = F.niceScale(10480, 10560, 4);
  const labels = sc.ticks.map(t => F.axisNum(t, '', sc.step));
  check('a zoomed axis above 10k gives every gridline its own label',
    new Set(labels).size === labels.length, labels.join(' '));
  check('and a coarse axis still abbreviates', F.axisNum(120000, '', 20000) === '120k',
    F.axisNum(120000, '', 20000));
  check('millions still abbreviate when the step allows', F.axisNum(2000000, '', 500000) === '2M');
  check('but not when the step is finer than the abbreviation',
    F.axisNum(1000500, '', 100) !== '1M', F.axisNum(1000500, '', 100));
}

// A bar too short to clear a pixel is still not a zero
console.log('\nsmall bars');
{
  /* The guard was `Math.abs(y1 - zero) < 0.6`, whose comment said "nothing to draw for a
     zero day". It did more than that: it dropped any value too small to clear 0.6px on the
     current scale. One 20,000-view upload in a month and every 40-view day disappeared,
     drawn exactly like a day with no views at all — while the tooltip still reported the
     real number for a bar that was not on screen. Distinguishing "a little" from "none" is
     most of the job of a sparse daily chart. */
  const B = new Function('fmt',
    'const esc=s=>String(s); let CH=[]; const chartPush=o=>CH.push(o)-1;\n' +
    cut('function niceScale(lo, hi, target)','  // legend keys mirror the mark') +
    cut('const LINE_GEO','  // several lines on one chart') +
    '\nreturn {barChartHtml, CH};')(new Intl.NumberFormat('en-US'));
  const bars = h => (h.match(/<path d="M/g) || []).length;

  const spiky = [20000, 40, 0, 12, 0, 3, 18000];
  const h = B.barChartHtml(spiky, spiky.map(String), 'daily views', {});
  check('every non-zero day draws a bar, however small',
    bars(h) === spiky.filter(v => v).length, bars(h) + ' bars for ' + spiky.filter(v => v).length + ' non-zero days');
  check('and the zero days draw nothing', bars(h) === 5, bars(h));

  /* Recover each bar's signed height from its path. The V target is not the data end —
     barPath rounds the corner, so it stops at y1 ± r and then arcs the last r across. The
     arc's own dy carries that r back with the right sign, so y1 = Vtarget + dy holds for
     both directions, and a sliver (where r is clamped to the whole height) measures right
     instead of measuring zero. Positive = above the baseline. */
  const heights = html => [...html.matchAll(/<path d="M[\d.]+,([\d.]+)V([\d.-]+)a[\d.]+,[\d.]+ 0 0 \d ([\d.-]+),([\d.-]+)/g)]
    .map(m => +m[1] - (+m[2] + +m[4]));
  const hx = heights(h);
  check('the measurement found every bar', hx.length === 5, hx.length);
  check('every bar rises above the baseline', hx.every(v => v > 0), hx.map(v => +v.toFixed(1)).join(','));
  check('the tiny ones are slivers, not full bars',
    hx.filter(v => v <= 1.6).length === 3, hx.map(v => +v.toFixed(1)).join(','));
  check('and the big ones are not', hx.filter(v => v > 20).length === 2, hx.map(v => +v.toFixed(1)).join(','));

  // negatives keep their direction — the same guard sat on the diff chart too
  const mixed = [5000, -3, 2, -4000];
  const m = B.barChartHtml(mixed, mixed.map(String), 'change', {});
  check('a tiny negative still draws', bars(m) === 4, bars(m));
  const mx = heights(m);
  check('the positives draw upwards', mx[0] > 0 && mx[2] > 0, mx.map(v => +v.toFixed(1)).join(','));
  check('and the negatives downwards', mx[1] < 0 && mx[3] < 0, mx.map(v => +v.toFixed(1)).join(','));
  check('the tiny negative is a sliver, on the correct side of zero',
    mx[1] < 0 && Math.abs(mx[1]) <= 1.6, mx[1]);
  check('the tiny positive is one too', mx[2] > 0 && mx[2] <= 1.6, mx[2]);

  check('an all-zero series is still empty', bars(B.barChartHtml([0,0,0], ['a','b','c'], 'x', {})) === 0);
}

// percentages in a ranked list must be shares of the whole, not of the visible slice
console.log('\nhbarList denominators');
{
  const H = new Function('fmt', 'esc',
    cut('  function hbarList(rows, opts)', '  const section = (title') +
    '\nreturn hbarList;')(new Intl.NumberFormat('en-US'), s => String(s));
  // read the displayed value only — the same text is repeated in the row's title
  // attribute, and the bar's own `width:NN%` is not a percentage of anything reported
  const hvals = h => [...h.matchAll(/<div class="hval">([^<]*)<\/div>/g)].map(m => m[1]);
  const pcts = h => hvals(h).map(v => +((v.match(/· (\d+)%/) || [])[1] || NaN));

  const all = [50, 25, 15, 6, 3, 1].map((v, i) => ({ label: 's' + i, val: v }));
  check('a complete list sums to 100%',
    pcts(H(all)).reduce((a, b) => a + b, 0) === 100, pcts(H(all)).join('+'));

  /* The bug: the caller shows the top 5 of a longer list, and the percentages were
     computed from those 5. "YouTube search — 42%" read as 42% of the video's traffic when
     it was 42% of the top five sources. */
  const top = all.slice(0, 3);                       // 90 of 100
  const naive = pcts(H(top));
  const honest = pcts(H(top, { total: 100 }));
  check('without a total, a truncated list still claims to sum to 100%',
    Math.abs(naive.reduce((a, b) => a + b, 0) - 100) <= 1, naive.join('+'));
  check('with the real total, the shares are the real shares',
    honest.join(',') === '50,25,15', honest.join(','));
  check('so a truncated list no longer overstates its biggest row',
    honest[0] < naive[0], honest[0] + ' vs ' + naive[0]);

  check('bar widths are still shares of the largest row, not of the total',
    /width:100.0%/.test(H(top, { total: 100 })), 'top row should still be full width');
  check('a zero or missing total falls back to the rows',
    pcts(H(top, { total: 0 })).join(',') === pcts(H(top)).join(','));
  check('and valText still wins over the computed percentage',
    hvals(H([{ label: 'a', val: 5, valText: '5 things' }])).join('') === '5 things',
    hvals(H([{ label: 'a', val: 5, valText: '5 things' }])).join(''));

  // the two call sites that slice must hand over the untruncated total
  check('the video traffic breakdown passes its full total',
    /traffic\.rows\.slice\(0, 5\)[\s\S]{0,200}total: traffic\.rows\.reduce/.test(src));
  check('and the report card one does too',
    /r\.traffic\.rows\.slice\(0, 8\)[\s\S]{0,220}total: r\.traffic\.rows\.reduce/.test(src));
  check('search terms are measured against all search traffic',
    (src.match(/YT_SEARCH'\)/g) || []).length >= 2, 'both search lists need the YT_SEARCH total');
}

// the scatter's hover ring must find the point by data index, not DOM position
console.log('\nscatter hover');
{
  /* ratePlotHtml emits the plain dots first, skipping the newest and best-loved points,
     then appends those two as callouts. So DOM index and data index diverge from the first
     callout onwards, and `forEach((c, i) => toggle('near', i === best))` rang a circle
     several videos away from the one the tooltip named. */
  check('every dot carries its data index', /dots \+= '<circle class="pt" data-i="/.test(src));
  check('and so does every callout', /'<circle class="pt ' \+ cls \+ '" data-i="'/.test(src));
  check('the hover ring matches on that index, not on DOM order',
    /querySelectorAll\('circle\.pt'\)\.forEach\(c => c\.classList\.toggle\('near', \+c\.dataset\.i === best\)\)/.test(src),
    'moveTip still rings by DOM position');

  // and prove the two orders really do differ, so the fix is not academic
  const R = new Function('fmt', 'esc', 'axisNum', 'niceScale',
    'let CH=[]; const chartPush=o=>CH.push(o)-1;\n' +
    cut('  function ratePlotHtml(points, tips, opts)', '  // 12-point trend line') +
    '\nreturn {ratePlotHtml, CH};')(new Intl.NumberFormat('en-US'), s => String(s), F.axisNum, F.niceScale);
  const pts3 = Array.from({ length: 10 }, (_, i) => ({ x: 100 + i * 50, rate: 1 + i * 0.2 }));
  pts3[2].best = true; pts3[7].hot = true;           // callouts at data indices 2 and 7
  const svg = R.ratePlotHtml(pts3, pts3.map((_, i) => 'v' + i), {});
  const order = [...svg.matchAll(/circle class="pt[^"]*" data-i="(\d+)"/g)].map(m => +m[1]);
  check('DOM order is not data order once callouts exist',
    order.join(',') !== [...order].sort((a, b) => a - b).join(','), order.join(','));
  check('but every point is present exactly once',
    new Set(order).size === 10 && order.length === 10, order.join(','));
  check('and data index 9 is not at DOM position 9',
    order[9] !== 9, 'DOM 9 holds point ' + order[9]);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail?1:0);
