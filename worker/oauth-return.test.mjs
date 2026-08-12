// The sign-in return allow-list.
//
// Why this has its own suite. The TikTok callback finishes by redirecting the browser to
// wherever the flow started, with the freshly minted session id in the URL fragment. So
// whatever `returnOk` says yes to can read the session — the allow-list IS the auth
// boundary, and it is one line of code with no visible consequences when it is wrong.
//
// It has already been wrong once. The original test was
//     /^https:\/\/[a-z0-9.-]*github\.io\//i
// which reads as "any github.io subdomain" and is not: `[a-z0-9.-]*` matches "evil" as
// happily as "reubenrich16.", so https://evilgithub.io/ passed. Adding the dot fixes that
// spelling but not the shape of the mistake — *.github.io is a namespace anyone can join
// by creating a repo. The list is exact hosts now, and these tests are here to keep it
// that way, because nothing else in the repo would notice if it loosened again.
//
// Run: node worker/oauth-return.test.mjs
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') +
  '\nexport { returnOk, RETURN_HOSTS };';
const tmp = HERE + '.worker-oauth.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

console.log('\nthe sign-in return allow-list');

console.log('\n1. the real destinations still work');
{
  const ok = [
    'https://reubenrich16.github.io/Analytics/tiktok.html',
    'https://reubenrich16.github.io/Analytics/tiktok.html?tab=posts',
    'https://reubenrich16.github.io/Analytics/index.html#anchor',
    'https://reubenrich16.github.io/',
    'http://localhost:8788/tiktok.html',
    'http://127.0.0.1:5500/yt-dashboard/tiktok.html',
  ];
  for (const u of ok) check('accepts ' + u, W.returnOk(u) === true);
}

console.log('\n2. the regex hole, and every neighbour of it');
{
  // each of these passed the old /^https:\/\/[a-z0-9.-]*github\.io\//i
  const holes = [
    'https://evilgithub.io/steal',                    // the original: no dot required
    'https://notgithub.io/',
    'https://xgithub.io/Analytics/tiktok.html',
    'https://reubenrich16github.io/Analytics/',       // the dot dropped from the real host
  ];
  for (const u of holes) check('rejects ' + u, W.returnOk(u) === false);

  // and these pass a dot-requiring version, which is why the list is exact hosts
  const subdomains = [
    'https://attacker.github.io/',
    'https://attacker.github.io/Analytics/tiktok.html',
    'https://reubenrich16.attacker.github.io/',
    'https://sub.reubenrich16.github.io/',
  ];
  for (const u of subdomains) check('rejects ' + u, W.returnOk(u) === false,
    '*.github.io is a namespace anyone can join');
}

console.log('\n3. the other ways a URL can lie');
{
  const bad = [
    ['http://reubenrich16.github.io/x', 'plain http to the real host'],
    ['javascript:alert(document.cookie)', 'a javascript: URL'],
    ['data:text/html,<script>fetch(location.hash)</script>', 'a data: URL'],
    ['//reubenrich16.github.io/x', 'a protocol-relative URL, which does not parse'],
    ['https://reubenrich16.github.io@evil.example/x', 'userinfo pointing at another host'],
    ['https://evil.example/?r=https://reubenrich16.github.io/', 'the real host in a query string'],
    ['https://evil.example/#https://reubenrich16.github.io/', 'the real host in a fragment'],
    ['https://evil.example/https://reubenrich16.github.io/', 'the real host in a path'],
    ['ftp://reubenrich16.github.io/x', 'a scheme that is not http at all'],
    ['https://xn--reubenrich16-github.io/', 'a punycode lookalike'],
  ];
  for (const [u, why] of bad) check('rejects ' + why, W.returnOk(u) === false, u);
}

console.log('\n4. nothing is not a destination');
{
  for (const v of [undefined, null, '', ' ', 0, NaN, {}, [], 'tiktok.html', '/Analytics/tiktok.html'])
    check('rejects ' + JSON.stringify(v === undefined ? 'undefined' : v), W.returnOk(v) === false);
  // String(x) is called on the input, so an object with a hostile toString must not slip by
  check('rejects an object that stringifies to a good URL',
    W.returnOk({ toString: () => 'https://evil.example/' }) === false);
  check('and accepts one that stringifies to a real destination',
    W.returnOk({ toString: () => 'https://reubenrich16.github.io/Analytics/tiktok.html' }) === true);
}

console.log('\n5. the fallback the callback uses when the check says no');
{
  // if this ever stops being an allowed destination, a rejected return sends the browser
  // somewhere the allow-list itself would refuse — worth failing the suite over
  check('the hard-coded fallback passes its own allow-list',
    W.returnOk('https://reubenrich16.github.io/Analytics/tiktok.html') === true);
  check('the list has not quietly grown', W.RETURN_HOSTS.length === 3, W.RETURN_HOSTS.join(','));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
