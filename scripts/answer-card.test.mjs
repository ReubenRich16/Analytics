// Every chip on the answer card must return a paintable object. paintAnswer reads a.h
// OUTSIDE its try/catch, so a chip that returns null or undefined throws uncaught and
// freezes the whole card rather than just its own chip.
import fs from 'fs';
// resolved from this file, not an absolute path: the suite has to run wherever the repo
// is checked out, and a hard-coded /home/... only existed on one machine
const src = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');
let pass=0, fail=0;
const check=(n,c,x='')=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗',n,x));};
console.log('\nanswer card contract');
// every `return` inside the four chip functions must be an object literal with h, f and p
for (const fn of ['answerToday','answerNewest','answerAudience','answerNext']) {
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
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail?1:0);
