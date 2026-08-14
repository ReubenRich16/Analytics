// The same-age race on the TikTok page: this post right now against what your other posts
// had when they were exactly this old.
//
// The YouTube page has had this for months, off a recorder that only runs while a browser
// is open. TikTok's version reads the Worker's own recordings instead, which changes three
// things worth pinning:
//
//   · the interpolation is pjAt, already in the page and already unit-tested for units by
//     plateau.test.mjs — the race only adds the "this value is being HELD, not measured"
//     flag on top, and that boundary is exactly where a wrong number would look right;
//   · a rival younger than the post being raced is EXCLUDED. YouTube has no such filter
//     because its rivals are nearly always older. Here the store keeps the twenty newest
//     posts, so without it an older slot would race a wall of current totals labelled
//     "(last known)", which is not a race;
//   · nothing here ever differences an account total, so the 60-post window cannot make a
//     number go backwards.
//
// Run: node scripts/tt-race.test.mjs
import fs from 'fs';
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

// the repo's lift-it-out-of-the-page pattern: slice a function to its first two-space `}`
const fn = name => {
  const i = TT.indexOf(name);
  if (i < 0) throw new Error('not found in tiktok.html: ' + name);
  return TT.slice(i, TT.indexOf('\n  }\n', i)) + '\n  }\n';
};
const arrow = name => {
  const i = TT.indexOf(name);
  if (i < 0) throw new Error('not found in tiktok.html: ' + name);
  return TT.slice(i, TT.indexOf('\n  };\n', i)) + '\n  };\n';
};

const NOW = 1786000000000;
const fmt = new Intl.NumberFormat('en-US');

/* ---------- 1. ttRaceAt — the only new arithmetic ---------- */
console.log('\nreading a rival curve at an age');
const RA = new Function('NOW', `
  const Date = { now: () => NOW };
  ${fn('function pjAt(c, t)')}
  ${fn('function pjCurveOf(id, createTime, rec)')}
  const TT_RACE_STALE = 30;
  ${arrow('const ttRaceAt = (c, t) =>')}
  return { ttRaceAt, pjCurveOf, pjAt };
`)(NOW);
{
  const c = [[0, 0], [60, 600], [120, 900]];
  check('before the curve starts there is no answer', RA.ttRaceAt(c, -1) === null);
  check('a curve that began recording late gets no vote on an earlier age',
    RA.ttRaceAt([[60, 600], [120, 900]], 30) === null,
    'it would otherwise vote with a number it never saw');
  check('between two samples it interpolates', RA.ttRaceAt(c, 90).v === 750, RA.ttRaceAt(c, 90).v);
  check('and rounds, because a view is a whole thing', Number.isInteger(RA.ttRaceAt(c, 95).v));
  check('on the last sample the value is measured', RA.ttRaceAt(c, 120).stale === false);
  /* The boundary. Past the end pjAt holds the last value forever, which is right for the
     projection and a lie in a race — so the race labels it. Thirty minutes is the same
     tolerance index.html uses. */
  check('thirty minutes past the end is still measured', RA.ttRaceAt(c, 150).stale === false);
  check('thirty-one minutes past it is last known', RA.ttRaceAt(c, 151).stale === true);
  check('and the value held is the last one recorded', RA.ttRaceAt(c, 400).v === 900);
  check('no curve at all is no answer', RA.ttRaceAt(null, 10) === null && RA.ttRaceAt([], 10) === null);

  /* The one place a silent 1000x could live: create_time is SECONDS, samples are
     milliseconds, and the model works in minutes since posting. */
  const t0s = 1786000000;
  const cv = RA.pjCurveOf('x', t0s, { s: [[t0s * 1000, 10], [t0s * 1000 + 3600000, 610]] });
  check('seconds, milliseconds and minutes line up', RA.ttRaceAt(cv, 30).v === 310,
    'got ' + JSON.stringify(RA.ttRaceAt(cv, 30)));
}

/* ---------- 2. renderTtRace, lifted with the page's own helpers ---------- */
console.log('\nrendering the race');
function build(mode) {
  let out = null;
  const $ = () => ({ set innerHTML(h) { out = h; }, get innerHTML() { return out; } });
  const src = `
    const Date = { now: () => NOW };
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    ${fn('function hbarList(rows, opts)')}
    ${fn('function pjAt(c, t)')}
    ${fn('function pjCurveOf(id, createTime, rec)')}
    ${fn('const fmtAge = m =>').replace('const fmtAge = m =>', 'function fmtAge(m) { m = Math.round(m); if (m < 60) return m + " min"; return Math.floor(m / 60) + "h"; ') .slice(0, 0) || ''}
    const fmtAge = m => Math.round(m) + ' min';
    const capOf = v => (v.title || v.video_description || '').trim() || '(no caption)';
    const PJ_WEEK = 7 * 1440;
    const TT_RACE_MAX_AGE = PJ_WEEK;
    const TT_RACE_STALE = 30;
    let ttRaceCur = null;
    const ttRaceMode = MODE;   // plain 'latest' / 'best'
    ${arrow('const ttRaceAt = (c, t) =>')}
    ${arrow('const ttRaceTitle = (id, rec) =>')}
    ${fn('function renderTtRace(v)')}
    renderTtRace(V);
  `;
  return { run: (V, hist, videos, noFilter) => {
    out = null;
    const body = noFilter
      ? src.replace(/\n\s*if \(\(Date\.now\(\) - rec\.create_time \* 1000\) \/ 60000 < t\) continue;/, '\n')
      : src;
    if (noFilter && body === src) throw new Error('the age filter line moved — this test is now vacuous');
    new Function('$', 'fmt', 'NOW', 'MODE', 'V', 'hist', 'videos', body)($, fmt, NOW, mode, V, hist, videos);
    return out;
  } };
}
// four rivals, all older than the target, each with a full minute-by-minute opening
const curve = (t0, final) => {
  const s = [];
  for (let m = 0; m <= 600; m += 5) s.push([t0 + m * 60000, Math.round(final * m / 600)]);
  return s;
};
function world(targetAgeMin) {
  const tgtT0 = NOW - targetAgeMin * 60000;
  const hist = { videos: {} };
  const mk = (id, ageMin, final) => {
    const t0 = NOW - ageMin * 60000;
    hist.videos[id] = { create_time: Math.floor(t0 / 1000), title: 'post ' + id, cover: '', s: curve(t0, final) };
  };
  mk('a', 5000, 2000); mk('b', 6000, 500); mk('c', 7000, 1200); mk('d', 8000, 3000);
  const target = { id: 'tgt', title: 'the one on screen', view_count: 1000,
                   create_time: Math.floor(tgtT0 / 1000) };
  return { target, hist, videos: [target] };
}
{
  const w = world(360);
  const html = build('latest').run(w.target, w.hist, w.videos);
  check('it renders something', !!html && html.length > 100);
  check('one row per rival plus the post itself', (html.match(/class="hbar-row"/g) || []).length === 5,
    (html.match(/class="hbar-row"/g) || []).length + ' rows');
  // hbarList writes the label into a title attribute AND a visible div, so count the div
  check('the post on screen is starred exactly once',
    (html.match(/<div class="hlabel">★/g) || []).length === 1,
    (html.match(/<div class="hlabel">★/g) || []).length + ' starred labels');
  check('and it is ranked among them', /#\d+ of 5/.test(html), (html.match(/#\d+ of \d+/) || [])[0]);
  check('the starred row is bold, not colour alone', /class="hbar-row" style="font-weight:700"/.test(html));
  check('and carries the live hue while the rivals carry the accent',
    /font-weight:700[\s\S]{0,320}background:var\(--live\)/.test(html) && /background:var\(--accent\)/.test(html));
  check('the head line states the count and the age', /views<\/b> at <b[^>]*>360 min<\/b> old/.test(html),
    (html.match(/<b[^>]*>[^<]*<\/b> at <b[^>]*>[^<]*<\/b> old/) || [])[0]);

  /* At 360 minutes every rival is on the flat part of its own curve and the values are
     600/360 of final — so the rank is arithmetic, not a guess. */
  const rank = +((html.match(/#(\d+) of/) || [])[1]);
  check('the rank is the post\'s real place in the field', rank === 3, 'got #' + rank);
}
{
  // modes pick different sets: newest four vs highest four at that age
  const w = world(360);
  w.hist.videos.late = { create_time: Math.floor((NOW - 400 * 60000) / 1000), title: 'newest rival',
                         cover: '', s: curve(NOW - 400 * 60000, 40) };
  const latest = build('latest').run(w.target, w.hist, w.videos);
  const best = build('best').run(w.target, w.hist, w.videos);
  check('latest mode names itself', /most recent recorded posts/.test(latest));
  check('best mode names itself', /best recorded openings/.test(best));
  check('the newest, weakest rival appears in latest mode', /newest rival/.test(latest));
  check('both modes list every rival when there are fewer than ten',
    (latest.match(/class="hbar-row"/g) || []).length === (best.match(/class="hbar-row"/g) || []).length);
}
{
  // the cap
  const w = world(360);
  for (let i = 0; i < 15; i++) {
    const t0 = NOW - (5000 + i * 10) * 60000;
    w.hist.videos['x' + i] = { create_time: Math.floor(t0 / 1000), title: 'extra ' + i, cover: '', s: curve(t0, 100 + i) };
  }
  const html = build('latest').run(w.target, w.hist, w.videos);
  check('never more than ten rivals plus the post', (html.match(/class="hbar-row"/g) || []).length === 11,
    (html.match(/class="hbar-row"/g) || []).length + ' rows');
}
{
  /* The divergence from index.html, and the reason for it. A rival younger than the post
     being raced cannot answer a question about this age; index has no filter and lets it
     answer with its current total tagged "(last known)". */
  const w = world(6000);
  w.hist.videos.baby = { create_time: Math.floor((NOW - 100 * 60000) / 1000), title: 'posted an hour ago',
                         cover: '', s: curve(NOW - 100 * 60000, 90) };
  const html = build('latest').run(w.target, w.hist, w.videos);
  check('a post younger than the one being raced is left out', !/posted an hour ago/.test(html));
  /* Without the filter it would be IN, and labelled "(last known)" — the label being the
     giveaway that it is answering with its current total rather than with this age. Older
     rivals whose recording stopped short are labelled too, and correctly so; what the
     filter removes is the ones that were never alive this long. */
  const unfiltered = build('latest').run(w.target, w.hist, w.videos, true);
  check('and without the filter it would be in, wearing exactly that label',
    /posted an hour ago/.test(unfiltered) && /\(last known\)/.test(unfiltered),
    'the filter is guarding nothing');
}
{
  // a rival whose recording stops short says so
  const w = world(400);
  const t0 = NOW - 9000 * 60000;
  w.hist.videos.stops = { create_time: Math.floor(t0 / 1000), title: 'recording stopped early',
                          cover: '', s: [[t0, 0], [t0 + 60 * 60000, 300]] };
  const html = build('latest').run(w.target, w.hist, w.videos);
  check('a value held past the end of a recording is labelled', /\(last known\)/.test(html));
}
{
  // retirement, empty, and the no-op guards
  const w = world(9 * 1440);
  const retired = build('latest').run(w.target, w.hist, w.videos);
  check('past a week the race retires', /minute race has retired/.test(retired));
  check('and still says where the post got to', /views<\/b> at/.test(retired));
  check('with no bars under it', !/hbar-row/.test(retired));

  const alone = build('latest').run(world(360).target, { videos: {} }, []);
  check('with nothing to race it says so', /Nothing to race against yet/.test(alone));
  check('and still shows the head line', /views<\/b> at/.test(alone));

  check('no post means no render at all', build('latest').run(null, { videos: {} }, []) === null);
  check('a post with no publish time means no render either',
    build('latest').run({ id: 'x', view_count: 1 }, { videos: {} }, []) === null);
}
{
  // captions are arbitrary text from the internet
  const w = world(360);
  const t0 = NOW - 7000 * 60000;
  w.hist.videos.evil = { create_time: Math.floor(t0 / 1000), title: '<img src=x onerror=alert(1)>',
                         cover: '', s: curve(t0, 700) };
  const html = build('latest').run(w.target, w.hist, w.videos);
  check('a caption cannot inject markup', !/<img src=x/.test(html) && /&lt;img src=x/.test(html));
}

/* ---------- 3. how it is wired into the page ---------- */
console.log('\nwired into the card without disturbing it');
{
  check('the race mounts into a runtime id, not static markup',
    /id="ttRaceContent"/.test(TT) && !/<div class="card[^"]*" id="ttRace/.test(TT));
  check('it is rendered after the card is in the DOM',
    TT.indexOf('renderTtRace(v);') > TT.indexOf("$('latestContent').innerHTML = html"),
    'rendering before the mount exists would silently do nothing');
  check('the mode toggle is delegated, so a poll re-render cannot orphan it',
    /document\.addEventListener\('click', e => \{\s*\n\s*const b = e\.target && e\.target\.closest \? e\.target\.closest\('button\[data-ttrace\]'\)/.test(TT));
  check('and it guards a text-node target the way the other delegated handlers do',
    /e\.target && e\.target\.closest \? e\.target\.closest\('button\[data-ttrace\]'\) : null/.test(TT));
  check('a late launch merge repaints it rather than waiting a whole poll',
    /mergeHist\(conv\); if \(ttRaceCur\) renderTtRace\(\);/.test(TT));
  check('it never emits a card the rooms test would call homeless',
    !/html \+= '<div class="(card|grid)/.test(TT));
  check('it adds no network call of its own',
    (TT.match(/api\('\/tiktok\//g) || []).length === (TT.match(/api\('\/tiktok\//g) || []).length);

  // hbarList still behaves for the callers that predate the race
  const HB = new Function('esc', 'fmt', fn('function hbarList(rows, opts)') + '\nreturn hbarList;')(
    s => String(s), fmt);
  const plain = HB([{ label: 'a', val: 10 }, { label: 'b', val: 5 }], { color: 'var(--accent)' });
  check('a row with no colour of its own still takes the list colour',
    (plain.match(/background:var\(--accent\)/g) || []).length === 2);
  check('and nothing is bolded unless it asks to be', !/font-weight:700/.test(plain));
  const mixed = HB([{ label: 'a', val: 10, color: 'var(--live)', strong: true }, { label: 'b', val: 5 }],
    { color: 'var(--accent)' });
  check('a row can override the colour', /background:var\(--live\)/.test(mixed) && /background:var\(--accent\)/.test(mixed));
  check('and ask to be weighted', (mixed.match(/font-weight:700/g) || []).length === 1);
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
