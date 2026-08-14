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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail?1:0);
