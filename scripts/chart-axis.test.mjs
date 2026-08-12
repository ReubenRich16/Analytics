// The x axis of lineChartHtml must be real time whenever `at` is given — the recorded
// history samples every ~5 min for two days then hourly, and index-spacing stretched
// those two days across most of the plot.
import fs from 'fs';
const src = fs.readFileSync('/home/user/Analytics/yt-dashboard/index.html','utf8');
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail?1:0);
