// Export recordings — the TikTok page's "everything the Worker recorded for this account"
// file, assembled by the page from the Worker's /tiktok/export answers, run against the
// page's own code.
//
//   · one entry per post, oldest first, with the views at 1h / 6h / 24h / 48h / 7d read the
//     dashboard's way — the last reading at or before the age, within grace, never a guess;
//   · every reading as [ts, views, likes, comments, shares], in time order;
//   · the follower log normalised; an `about` block that explains the fields;
//   · whose it is by display name, and never an account id.
//
// Melbourne time throughout, set before anything reads a clock.
//
// Run: node scripts/tt-export.test.mjs
process.env.TZ = 'Australia/Melbourne';
import fs from 'fs';
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');
const WK = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const cut = (start, end) => {
  const i = TT.indexOf(start);
  if (i < 0) throw new Error('not found: ' + start);
  const j = TT.indexOf(end, i);
  if (j < 0) throw new Error('not found after ' + start + ': ' + end);
  return TT.slice(i, j);
};
const fnOf = name => cut('  function ' + name + '(', '\n  }\n') + '\n  }\n';
const arrow = start => cut(start, '\n  };\n') + '\n  };\n';
const line = start => cut(start, '\n') + '\n';
const H = 3600e3, D = 864e5, MIN = 60e3;

const SRC = `
  ${line('  const TTX_AGES = ')}${arrow('  const ttxViewsAt = ')}${line('  const ttxIso = ')}${line('  const ttxLocal = ')}
  ${fnOf('ttxFile')}
  return { TTX_AGES, ttxViewsAt, ttxFile };`;
const P = new Function(SRC)();

const NOW = Date.UTC(2026, 9, 9, 9, 0, 0);          // 9 Oct 2026 09:00 UTC = 8 pm AEDT
const PUB = NOW - 10 * D;
const reading = (t, v) => [t, v, Math.floor(v / 10), 1, 2];
const launch = (t0, final, hours = 48, step = MIN) => { const s = []; for (let t = 0; t <= hours * H; t += step) s.push(reading(t0 + t, Math.round(final * Math.min(1, t / (48 * H))))); return s; };

console.log('\nviews at an age — the last reading at or before it, within grace');
{
  const s = launch(PUB, 2880);
  check('a minute-by-minute launch answers 1h and 48h exactly', P.ttxViewsAt(s, PUB, H) === 60 && P.ttxViewsAt(s, PUB, 48 * H) === 2880);
  check('an age past the recording is null, not the last reading', P.ttxViewsAt(s, PUB, 7 * D) === null);
  const holed = s.filter(r => r[0] < PUB + 5 * H || r[0] > PUB + 7 * H);
  check('an age inside a two-hour hole is null', P.ttxViewsAt(holed, PUB, 6 * H) === null);
  check('a reading 8 minutes before the age stands in', P.ttxViewsAt([reading(PUB + 52 * MIN, 520)], PUB, H) === 520);
  check('eleven minutes before does not', P.ttxViewsAt([reading(PUB + 49 * MIN, 490)], PUB, H) === null);
  check('at a week the grace is an hour (the 15-minute tier)', P.ttxViewsAt([reading(PUB + 7 * D - 50 * MIN, 9000)], PUB, 7 * D) === 9000 && P.ttxViewsAt([reading(PUB + 7 * D - 70 * MIN, 9000)], PUB, 7 * D) === null);
  check('a reading after the age never counts', P.ttxViewsAt([reading(PUB + 61 * MIN, 610)], PUB, H) === null);
  check('the five ages in order', P.TTX_AGES.map(a => a[0]).join(',') === '1h,6h,24h,48h,7d');
}

console.log('\nthe file');
{
  const roster = [
    { id: 'p2', create_time: Math.round((PUB + 5 * D) / 1000), title: 'Newer one #asmr', cover: '' },
    { id: 'p1', create_time: Math.round(PUB / 1000), title: 'Older one', cover: '' },
    { id: 'p0', create_time: Math.round((PUB - 40 * D) / 1000), title: 'Pruned away', cover: '' }
  ];
  // p1: a full launch, then quarter-hours to day 7; p2: shuffled, with a junk row the Worker would never send
  const p1 = [...launch(PUB, 2880), ...Array.from({ length: 5 * 96 }, (_, i) => reading(PUB + 48 * H + (i + 1) * 15 * MIN, 2880 + i + 1))];
  const p2 = launch(PUB + 5 * D, 900, 10).reverse().concat([[0, 1, 1, 1, 1], 'junk']);
  const followers = [[NOW - D, 4000, 50000, 2], [NOW, 4100, 51000, 3], ['bad'], null];
  const f = P.ttxFile(roster, { p1, p2 }, followers, 'Reuben', 60, NOW);
  check('format, account by display name, kept days, both clocks', f.format === 'channel-command/tiktok-recordings/1' && f.account === 'Reuben' && f.kept_days === 60 && f.exported_utc === '2026-10-09T09:00:00Z' && /9 Oct 2026, 8:00 pm/.test(f.exported_local), f.exported_local);
  check('the timezone is named', f.timezone === 'Australia/Melbourne', f.timezone);
  check('posts oldest first, every roster entry present', f.posts.map(p => p.id).join(',') === 'p0,p1,p2', f.posts.map(p => p.id).join(','));
  const a = f.posts[1], b = f.posts[2], z = f.posts[0];
  check('caption, publish time in both clocks, age in hours', a.caption === 'Older one' && a.published_utc === '2026-09-29T09:00:00Z' && /29 Sept 2026, 7:00 pm/.test(a.published_local) && a.age_hours === 240, a.published_local + ' ' + a.age_hours);
  check('the launch marks: 1h, 6h, 24h, 48h, 7d', a.views_1h === 60 && a.views_6h === 360 && a.views_24h === 1440 && a.views_48h === 2880 && a.views_7d === 2880 + 5 * 96, [a.views_1h, a.views_6h, a.views_24h, a.views_48h, a.views_7d].join('/'));
  check('the latest counts are the last reading', a.views_latest === 2880 + 480 && a.likes_latest === Math.floor((2880 + 480) / 10) && a.comments_latest === 1 && a.shares_latest === 2);
  check('samples and first/last sample times', a.samples === p1.length && a.first_sample_utc === '2026-09-29T09:00:00Z' && a.last_sample_utc === new Date(PUB + 48 * H + 480 * 15 * MIN).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  check('readings are every reading, in time order, junk dropped', b.readings.length === 10 * 60 + 1 && b.readings.every((r, i) => i === 0 || r[0] > b.readings[i - 1][0]) && !b.readings.some(r => r[0] === 0));
  check('a post still inside its recording has null for the ages it has not reached', b.views_1h === Math.round(900 / 48) && b.views_6h === Math.round(900 * 6 / 48) && b.views_24h === null && b.views_48h === null && b.views_7d === null);
  check('a post with no readings kept still has its entry, with nulls, not zeros', z.samples === 0 && z.readings.length === 0 && z.views_48h === null && z.views_latest === null && z.first_sample_utc === null);
  check('the follower log is normalised and junk dropped', JSON.stringify(f.followers) === JSON.stringify([[NOW - D, 4000, 50000, 2], [NOW, 4100, 51000, 3]]));
  check('the about block explains the fields, the sampler, the grace and the scope',
    /views_1h/.test(f.about.posts) && /within 10 minutes/.test(f.about.posts) && /never a guess/.test(f.about.posts) &&
    /every minute for a post’s first 48 hours, every 15 minutes to day 14, every 30 minutes to day 60/.test(f.about.readings) &&
    /Gaps are gaps/.test(f.about.readings) && /\[ts, followers, total_likes, post_count\]/.test(f.about.followers) &&
    /Australia\/Melbourne/.test(f.about.times) && /only the account named/.test(f.about.scope) && /id is not written/.test(f.about.scope));
  check('no account id anywhere in the file', !JSON.stringify(f).includes('open-') && !JSON.stringify(f).includes('tt:'));
  check('an empty account is an empty file, not a crash', (() => { const e = P.ttxFile([], {}, null, '', 60, NOW); return e.posts.length === 0 && e.followers.length === 0; })());
}

console.log('\nwired into the page and the Worker');
{
  check('the button sits in the footer beside Export saved data', /id="ttExportBtn"[\s\S]{0,200}id="ttExportRecBtn"/.test(TT));
  check('it is wired', /\$\('ttExportRecBtn'\)\.addEventListener\('click', ttxExport\)/.test(TT));
  const body = cut('  async function ttxExport() {', '\n  }\n');
  check('it refuses without a session, naming why', /if \(!session\)/.test(body) && /belong to the account that is signed in/.test(body));
  check('it asks the Worker for the roster, then each post', /api\('\/tiktok\/export'\)/.test(body) && /'\/tiktok\/export\?id=' \+ encodeURIComponent\(v\.id\)/.test(body));
  check('four posts at a time, with progress', /i \+= 4/.test(body) && /collecting ' \+ Math\.min\(i \+ 4, roster\.length\)/.test(body));
  check('one retry per post, then the error surfaces', /catch \(e\) \{ r = await api\(q\); \}/.test(body));
  check('the file is named for the day', /'tiktok-recordings-' \+ new Date\(now\)\.toLocaleDateString\('en-CA'\) \+ '\.json'/.test(body));
  check('the button is disabled while it runs and re-enabled after', /btn\.disabled = true/.test(body) && /finally \{ btn\.disabled = false; \}/.test(body));
  check('the Worker has the route, session-locked, before the token fetch',
    /if \(p === '\/tiktok\/export'\)/.test(WK) && WK.indexOf("p === '/tiktok/export'") > WK.indexOf('const openId = await ttSession(env, request);') && WK.indexOf("p === '/tiktok/export'") < WK.indexOf('const token = await ttAccessToken(env, openId);'));
  check('the Worker scopes both reads to the session\'s own partition', /d1ExportPost\(env, ttKey\(openId\), id\)/.test(WK) && /d1ExportRoster\(env, ttKey\(openId\)\)/.test(WK));
  check('the GitHub export is gone', !fs.existsSync(new URL('../.github/workflows/d1-export.yml', import.meta.url)) && !fs.existsSync(new URL('./d1-export.mjs', import.meta.url)));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' + pass + ' passed' : pass + ' passed, 0 failed'));
process.exit(fail ? 1 : 0);
