// Run every test suite in the repo.
//
//   node scripts/test-all.mjs
//
// There are ten of them across two directories and no package.json to hang an `npm test`
// off, so before this they were run by pasting a shell loop — which meant they were run
// when someone remembered the loop. Discovery is by filename (*.test.mjs under worker/ and
// scripts/) so a new suite is picked up by existing, not by being added to a list here.
//
// Each suite is its own process on purpose: they patch globals — Date.now, globalThis.fetch
// — and several write and delete a temporary module beside worker.js. Sharing one process
// would have them stepping on each other in ways that look like flakiness.
//
// Exit code is 0 only if every suite exits 0, so this is usable as a pre-push check.
import fs from 'fs';
import { spawnSync } from 'child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const dirs = ['worker', 'scripts'];
const suites = dirs.flatMap(d => fs.readdirSync(ROOT + d)
  .filter(f => f.endsWith('.test.mjs'))
  .sort()
  .map(f => d + '/' + f));

if (!suites.length) {
  console.error('no *.test.mjs found — has the layout changed?');
  process.exit(1);
}

const pad = Math.max(...suites.map(s => s.length)) + 2;
let failed = [], total = 0;

for (const s of suites) {
  process.stdout.write(s.padEnd(pad));
  const r = spawnSync(process.execPath, [ROOT + s], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  // every suite ends with a line like "94 passed, 0 failed" or "✗ 1 FAILED, 53 passed"
  const last = out.trimEnd().split('\n').pop() || '';
  const n = +(last.match(/(\d+) passed/) || [])[1] || 0;
  total += n;
  if (r.status === 0) {
    console.log('\x1b[32m✓\x1b[0m ' + last.trim());
  } else {
    console.log('\x1b[31m✗\x1b[0m ' + (last.trim() || 'exited ' + r.status));
    failed.push([s, out]);
  }
}

console.log('');
if (!failed.length) {
  console.log('\x1b[32m' + total + ' assertions passed across ' + suites.length + ' suites\x1b[0m');
  process.exit(0);
}

/* Print enough from each broken suite that the runner is enough on its own.

   Failing assertions print as ✗ lines. A suite that CRASHES prints none of those — it dies
   with a stack trace — and the first version only looked for ✗, so a crash showed as a bare
   "─── suite" header with nothing under it. That is exactly what the first CI run produced
   for two suites that had hard-coded an absolute path, and it made a one-line fix look like
   a mystery. When there are no ✗ lines, show the tail instead. */
for (const [s, out] of failed) {
  console.log('\x1b[31m─── ' + s + '\x1b[0m');
  const marks = out.split('\n').filter(l => l.includes('✗'));
  if (marks.length) { for (const line of marks) console.log(line); continue; }
  const tail = out.trimEnd().split('\n').slice(-14);
  console.log(tail.length ? tail.join('\n') : '(no output — the suite produced nothing at all)');
}
console.log('\n\x1b[31m' + failed.length + ' of ' + suites.length + ' suites failed\x1b[0m');
process.exit(1);
