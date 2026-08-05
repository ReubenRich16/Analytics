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
console.log('\n' + (fail?'✗ '+fail+' FAILED, ':'') + pass + ' passed');
process.exit(fail?1:0);
