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
  '\nreturn {lineChartHtml, CH};')(true, new Intl.NumberFormat('en-US'));
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
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail?1:0);
