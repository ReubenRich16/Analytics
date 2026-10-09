// The recorded-data export (scripts/d1-export.mjs): the pure parts, driven directly.
//
// The run itself needs wrangler and the Cloudflare credentials, so it is not exercised here;
// what is pinned is everything the files' correctness rests on — the CSV quoting, the
// platform labels that keep the open_id out of a public artifact, the "views at age X"
// rule (the last reading at or before the age, within grace, never interpolated), the
// per-post summary's columns, and the parser for wrangler's --json output.
//
// Run: node scripts/d1-export.test.mjs
process.env.TZ = 'UTC';   // localStamp must not depend on the machine's clock — it names its zone
import { csvCell, csvLine, platformLabel, platformWanted, isoUtc, localStamp, chunks, viewsAt, graceFor,
         postSummary, POST_COLUMNS, parseWranglerJson, readmeText, AGES, main } from './d1-export.mjs';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const H = 3600e3, D = 864e5, MIN = 60e3;

console.log('\ncsv');
{
  check('a plain cell is written bare', csvCell('abc') === 'abc' && csvCell(12) === '12');
  check('null and undefined are empty', csvCell(null) === '' && csvCell(undefined) === '');
  check('a comma forces quotes', csvCell('a, b') === '"a, b"');
  check('a quote is doubled inside quotes', csvCell('she said "hi"') === '"she said ""hi"""');
  check('a newline forces quotes', csvCell('two\nlines') === '"two\nlines"');
  check('a line joins cells and ends with \\n', csvLine(['a', 1, null, 'x,y']) === 'a,1,,"x,y"\n');
}

console.log('\nplatform labels — the open_id never reaches the file whole');
{
  check('yt → youtube', platformLabel('yt') === 'youtube');
  check('tt:<open_id> → tiktok-<first 4>', platformLabel('tt:abcdefghijklmnop') === 'tiktok-abcd');
  check('the rest of the id is gone', !platformLabel('tt:abcdefghijklmnop').includes('efgh'));
  check('two accounts stay distinguishable', platformLabel('tt:abcd1111') !== platformLabel('tt:wxyz2222'));
  check('an unknown partition passes through', platformLabel('other') === 'other');
  check('"all" wants everything', platformWanted('yt', 'all') && platformWanted('tt:x', 'all'));
  check('"tiktok" wants only tt partitions', platformWanted('tt:x', 'tiktok') && !platformWanted('yt', 'tiktok'));
  check('"youtube" wants only yt', platformWanted('yt', 'youtube') && !platformWanted('tt:x', 'youtube'));
}

console.log('\ntimes');
{
  const t = Date.UTC(2026, 8, 30, 10, 0, 0);   // 30 Sep 2026 10:00 UTC = 8 pm AEST (DST starts 4 Oct)
  check('isoUtc drops the milliseconds', isoUtc(t) === '2026-09-30T10:00:00Z', isoUtc(t));
  check('localStamp is the Melbourne clock, 24-hour', localStamp(t) === '2026-09-30 20:00', localStamp(t));
  const dst = Date.UTC(2026, 9, 10, 13, 30, 0);   // 10 Oct 2026 13:30 UTC = 00:30 AEDT (+11)
  check('…and knows daylight saving, with midnight as 00', localStamp(dst) === '2026-10-11 00:30', localStamp(dst));
  check('another zone can be asked for', localStamp(t, 'UTC') === '2026-09-30 10:00', localStamp(t, 'UTC'));
}

console.log('\nchunks');
{
  check('a span splits into steps, the last one short', JSON.stringify(chunks(0, 10, 4)) === '[[0,4],[4,8],[8,10]]');
  check('an exact fit has no empty tail', JSON.stringify(chunks(0, 8, 4)) === '[[0,4],[4,8]]');
  check('an empty span is no chunks', chunks(5, 5, 4).length === 0);
}

console.log('\nviews at an age — the last reading at or before it, within grace, never a guess');
{
  const pub = Date.UTC(2026, 8, 1, 0, 0, 0);
  const s = [];
  for (let m = 0; m <= 48 * 60; m++) s.push({ ts: pub + m * MIN, views: m * 10, likes: 0, comments: 0, shares: 0 });
  check('a minute-by-minute launch answers 1h exactly', viewsAt(s, pub, H, 10 * MIN) === 600);
  check('and 48h', viewsAt(s, pub, 48 * H, 10 * MIN) === 28800);
  check('an age past the recording is null, not the last reading', viewsAt(s, pub, 7 * D, 60 * MIN) === null);
  // a hole: no readings between 5h and 7h
  const holed = s.filter(x => x.ts < pub + 5 * H || x.ts > pub + 7 * H);
  check('an age inside a two-hour hole is null — the reading 60 minutes before does not stand in', viewsAt(holed, pub, 6 * H, 10 * MIN) === null);
  check('a reading 8 minutes before the age stands in (a missed tick or two)', viewsAt([{ ts: pub + 52 * MIN, views: 520 }], pub, H, 10 * MIN) === 520);
  check('a reading 11 minutes before is not within ten minutes of grace', viewsAt([{ ts: pub + 49 * MIN, views: 490 }], pub, H, 10 * MIN) === null);
  check('a reading after the age never counts', viewsAt([{ ts: pub + 61 * MIN, views: 610 }], pub, H, 10 * MIN) === null);
  check('grace is 10 minutes up to 48h and an hour at a week', graceFor(H) === 10 * MIN && graceFor(48 * H) === 10 * MIN && graceFor(7 * D) === 60 * MIN);
  check('an empty recording is null', viewsAt([], pub, H, 10 * MIN) === null);
}

console.log('\nthe per-post summary');
{
  const pub = Date.UTC(2026, 8, 1, 0, 0, 0), now = pub + 10 * D;
  const s = [];
  for (let m = 0; m <= 48 * 60; m++) s.push({ ts: pub + m * MIN, views: m * 10, likes: m, comments: 1, shares: 2 });
  for (let q = 48 * 4 + 1; q <= 14 * 96; q++) s.push({ ts: pub + q * 15 * MIN, views: 28800 + q, likes: 3000, comments: 1, shares: 2 });
  const v = { platform: 'tt:abcdefgh', video_id: '7001', published_at: pub, title: 'Tapping on glass, no talking #asmr', cover: '' };
  const row = postSummary(v, s, now);
  check('every column the header names is on the row', POST_COLUMNS.every(k => k in row), POST_COLUMNS.filter(k => !(k in row)).join(','));
  check('the platform is the label, not the partition', row.platform === 'tiktok-abcd');
  check('publish time in UTC and on the Melbourne clock', row.published_utc === '2026-09-01T00:00:00Z' && row.published_local === '2026-09-01 10:00', row.published_local);
  check('age in hours to one decimal', row.age_hours === 240);
  check('the launch marks: 1h, 6h, 24h, 48h', row.views_1h === 600 && row.views_6h === 3600 && row.views_24h === 14400 && row.views_48h === 28800, [row.views_1h, row.views_6h, row.views_24h, row.views_48h].join('/'));
  check('the week mark comes from the 15-minute tier', row.views_7d === 28800 + 7 * 96, row.views_7d);
  check('latest counts are the last reading', row.views_latest === 28800 + 14 * 96 && row.likes_latest === 3000 && row.comments_latest === 1 && row.shares_latest === 2);
  check('samples and the first/last sample times', row.samples === s.length && row.first_sample_utc === '2026-09-01T00:00:00Z' && row.last_sample_utc === isoUtc(s[s.length - 1].ts));
  // a post whose launch was never recorded (connected later) — the age columns say so
  const late = postSummary(v, s.filter(x => x.ts >= pub + 3 * D), now);
  check('a launch the Worker missed has blank launch marks, not zeros', late.views_1h === '' && late.views_48h === '' && late.views_7d > 0, JSON.stringify([late.views_1h, late.views_48h, late.views_7d]));
  check('a post with no readings at all still has a row', postSummary(v, [], now).samples === 0 && postSummary(v, [], now).views_latest === '');
  check('AGES is the five marks in order', AGES.map(a => a[0]).join(',') === '1h,6h,24h,48h,7d');
}

console.log('\nwrangler --json');
{
  check('the usual shape: an array of statement results', JSON.stringify(parseWranglerJson('[{"results":[{"a":1},{"a":2}],"success":true,"meta":{}}]')) === '[{"a":1},{"a":2}]');
  check('a banner ahead of the JSON is skipped', parseWranglerJson(' ⛅️ wrangler 4.0.0\n-------------------\n[{"results":[{"a":1}]}]').length === 1);
  check('a bare object is accepted too', parseWranglerJson('{"results":[{"a":1}]}').length === 1);
  check('no results is an empty list, not a crash', parseWranglerJson('[{"success":true}]').length === 0);
  let threw = false; try { parseWranglerJson('nothing here'); } catch (e) { threw = true; }
  check('no JSON at all throws, naming the output', threw);
}

console.log('\nthe README in the folder');
{
  const r = readmeText(60, Date.UTC(2026, 8, 30, 10, 0, 0));
  check('names every file', ['samples.csv', 'videos.csv', 'posts.csv', 'followers.csv'].every(f => r.includes(f)));
  check('lists every posts.csv column', POST_COLUMNS.every(k => r.includes(k)));
  check('says when it was taken, in both clocks', r.includes('2026-09-30T10:00:00Z') && r.includes('2026-09-30 20:00 Melbourne'));
  check('explains the sampler\'s tiers and that gaps are gaps', /Every minute .* first 48 hours, every 15 minutes to day 14, hourly to day 60/.test(r) && /Gaps are gaps/.test(r));
  check('says the open_id is cut, never written whole', /first four characters/.test(r) && /never written here/.test(r));
  check('main is exported without running (importing this module ran nothing)', typeof main === 'function');
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' + pass + ' passed' : pass + ' passed, 0 failed'));
process.exit(fail ? 1 : 0);
