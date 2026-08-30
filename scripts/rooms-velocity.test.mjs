// Four things this batch added or fixed, pinned so they cannot quietly come undone.
//
//   1. THE ROOM SYSTEM. Adding a room is a three-place edit — a tab button, a pane, and an
//      entry in ROOM_ORDER — and there are no runtime guards worth relying on for two of
//      the three mismatches: a ROOM_ORDER name with no pane blanks the page, and a tab
//      whose data-room is missing from ROOM_ORDER silently lands you back on Now. Both
//      pages just went from 4→6 and 3→5 rooms, so this checks all three lists agree and
//      that no card ended up outside every pane.
//
//   2. THE GAP FLOOR. A ten-minute break threshold against a sampler that deliberately
//      drops to fifteen-minute and then hourly cadence turned every post-48h sample into
//      an unstroked single-moveto subpath. A whole day of real data drew as nothing, with
//      a hard vertical edge on the fill and the end dot floating detached at the right —
//      the "data stopped at 48 hours" report. The floor has to clear COLD_COOL_MIN.
//
//   3. TIKTOK'S VELOCITY CARD, which cannot difference account totals the way YouTube's
//      does: TikTok returns at most 60 posts, so the summed view total FALLS when an old
//      post scrolls out, and a difference would render "+-1,234 views".
//
//   4. THE LENGTH FORMATTER on the compare page.
//
// Run: node scripts/rooms-velocity.test.mjs
import fs from 'fs';
const YT = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');
const CMP = fs.readFileSync(new URL('../yt-dashboard/compare.html', import.meta.url), 'utf8');
const CSS = fs.readFileSync(new URL('../yt-dashboard/style.css', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

/* ---------- 1. rooms ---------- */
function rooms(src, page, expect) {
  console.log('\n' + page + ' — rooms');
  const order = JSON.parse(((src.match(/const ROOM_ORDER = (\[[^\]]+\]);/) || [])[1] || '[]').replace(/'/g, '"'));
  const tabs = [...src.matchAll(/<button role="tab"[^>]*data-room="([^"]+)"/g)].map(m => m[1]);
  const panes = [...src.matchAll(/class="room-pane[^"]*" data-pane="([^"]+)"/g)].map(m => m[1]);
  check('ROOM_ORDER has the expected rooms', order.join(',') === expect.join(','), order.join(','));
  check('every tab button is in ROOM_ORDER', tabs.every(t => order.includes(t)),
    tabs.filter(t => !order.includes(t)).join(',') || tabs.join(','));
  check('every room in ROOM_ORDER has a tab button', order.every(k => tabs.includes(k)),
    order.filter(k => !tabs.includes(k)).join(','));
  // the one that blanks the page rather than failing loudly
  check('every room in ROOM_ORDER has a pane', order.every(k => panes.includes(k)),
    order.filter(k => !panes.includes(k)).join(','));
  check('and no pane is orphaned from the tab bar', panes.every(k => order.includes(k)),
    panes.filter(k => !order.includes(k)).join(','));
  check('each tab points at its own pane id',
    order.every(k => src.includes('aria-controls="pane-' + k + '"') && src.includes('id="pane-' + k + '"')));
  check('each pane is labelled by its own tab',
    order.every(k => src.includes('aria-labelledby="tab-' + k + '"')));
  check('exactly one pane starts open',
    (src.match(/class="room-pane on"/g) || []).length === 1);
  check('every room carries a divider for One page mode',
    (src.match(/class="room-divider"/g) || []).length === order.length,
    (src.match(/class="room-divider"/g) || []).length + ' of ' + order.length);
  // the guards, both of which used to be a thrown TypeError or a blank page
  check('a missing pane falls back instead of blanking',
    /if \(!pane && k !== 'now'\) \{ showRoom\('now', remember\); return; \}/.test(src));
  check('a missing tab button does not throw on an arrow key',
    /const nextBtn = document\.querySelector[\s\S]{0,90}if \(nextBtn\) nextBtn\.focus\(\);/.test(src));
  return { order, panes };
}
const ytR = rooms(YT, 'YouTube', ['now', 'videos', 'trends', 'audience', 'coach', 'ideas']);
const ttR = rooms(TT, 'TikTok', ['now', 'posts', 'account', 'coach', 'ideas']);

/* Nothing may end up in no room at all. Chrome — the header, the answer card, the room bar
   itself, the footer, the drawer, the party overlay — sits outside every pane on purpose,
   so this walks the body and checks that each CONTENT card is inside exactly one pane. */
function homeless(src, page, chrome) {
  console.log('\n' + page + ' — every card has a room');
  const spans = [];
  const re = /<div class="room-pane[^"]*" data-pane="([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) spans.push({ k: m[1], from: m.index });
  for (let i = 0; i < spans.length; i++) spans[i].to = i + 1 < spans.length ? spans[i + 1].from : src.length;
  const cards = [...src.matchAll(/<div class="(?:card|grid)[^"]*" id="([A-Za-z]+)"/g)]
    .map(x => ({ id: x[1], at: x.index }))
    .filter(x => !chrome.includes(x.id));
  for (const c of cards) {
    const home = spans.filter(s => c.at > s.from && c.at < s.to);
    check(c.id + ' lives in exactly one room', home.length === 1,
      home.length ? home.map(h => h.k).join('+') : 'NO ROOM');
  }
  check('at least one card per room',
    spans.every(s => cards.some(c => c.at > s.from && c.at < s.to)),
    spans.filter(s => !cards.some(c => c.at > s.from && c.at < s.to)).map(s => s.k).join(',') || '');
}
homeless(YT, 'YouTube', ['setupPanel', 'channelBanner', 'answerCard', 'drawer']);
homeless(TT, 'TikTok', ['setupPanel', 'profileBanner', 'answerCard']);

console.log('\nthe tab bar copes with six of them');
{
  check('tabs scroll sideways rather than crushing', /\.tabs \{[^}]*overflow-x:auto/.test(CSS));
  check('and a button never shrinks below its own label',
    /\.tabs button \{[^}]*flex:1 0 auto[^}]*white-space:nowrap/.test(CSS));
}

/* ---------- 2. the gap floor ---------- */
console.log('\nthe break threshold clears the sampler\'s slowest cadence');
{
  // COLD_COOL_MIN — the hourly tier from day 14 to day 60 — is the number to clear
  const worker = fs.readFileSync(new URL('../worker/worker.js', import.meta.url), 'latin1');
  const cool = +(worker.match(/COLD_COOL_MIN\s*=\s*(\d+)/) || [])[1];
  const warm = +(worker.match(/COLD_WARM_MIN\s*=\s*(\d+)/) || [])[1];
  check('the worker still steps down to a 15-minute then hourly cadence', warm === 15 && cool === 60,
    warm + '/' + cool);
  for (const [src, page] of [[YT, 'index.html'], [TT, 'tiktok.html']]) {
    const floors = [...src.matchAll(/maxGap = Math\.max\(4 \* dts\[dts\.length >> 1\], ([^)]+)\)/g)].map(m => m[1].trim());
    check(page + ' sets a floor at all', floors.length === 1, floors.join(' | '));
    const ms = floors.length ? Function('return ' + floors[0])() : 0;
    check(page + ' clears the hourly tier with slack', ms > cool * 60e3, ms + 'ms vs ' + cool * 60e3);
    check(page + ' no longer uses the ten-minute floor that hid a day of samples', !floors.includes('6e5'));
    // and the belt-and-braces half: an isolated sample must still leave a mark
    check(page + ' draws a lone sample as a zero-length subpath, not a bare moveto',
      /(\w+)\.length > 1 \? 'M' \+ \1\.map\(pt\)\.join\(' L'\) : 'M' \+ pt\(\1\[0\]\) \+ ' L' \+ pt\(\1\[0\]\)/.test(src),
      'a single-moveto subpath is never stroked');
  }
  check('the round linecap that paints those zero-length subpaths is still set',
    /path\.line \{[^}]*stroke-linecap:round/.test(CSS));
}

/* ---------- 2b. one tooltip engine, two pages ---------- */
/* TikTok used to carry its own cut-down tooltip that resolved an index exactly one way:
   nearest point along x. That is right for a line and wrong for everything else — a ranked
   list needs the row under the pointer, a scatter needs the nearest point in BOTH axes, a
   bar chart needs arithmetic against fixed slots, and a chart with tips but no xs needs
   even spacing. Five charts that need those branches are being ported onto that page, so
   the engine is now index.html's, verbatim, and this keeps it that way. */
console.log('\nthe tooltip engine is the same on both pages');
{
  const strip = t => (t || '').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n').replace(/\s+/g, ' ').trim();
  const grab = (src, from, to) => {
    const i = src.indexOf(from);
    if (i < 0) return null;
    const j = src.indexOf(to, i);
    return j < 0 ? null : src.slice(i, j + to.length);
  };
  for (const fn of ['function moveTip(e) {', 'const hideChartCursors = () => {']) {
    const a = grab(YT, '  ' + fn, '\n  }'), b2 = grab(TT, '  ' + fn, '\n  }');
    check(fn.replace(/[({].*/, '').trim() + ' exists on the TikTok page', !!b2);
    check(fn.replace(/[({].*/, '').trim() + ' is identical on both', !!b2 && strip(a) === strip(b2),
      'the two have drifted');
  }
  for (const decl of ['const chartReg = new Map();', 'let chartCi = 0;',
                      'const chartPush = data => { const ci = chartCi++; chartReg.set(ci, data); chartReg.delete(ci - 400); return ci; };']) {
    check('both declare: ' + decl.slice(0, 34) + '…', YT.includes(decl) && TT.includes(decl),
      (YT.includes(decl) ? '' : 'missing on index ') + (TT.includes(decl) ? '' : 'missing on tiktok'));
  }
  // the name survives only in the comment that explains why it went
  const code = TT.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('the old single-branch engine is gone', !/ttMoveTip|ttReg\b|let ttTip/.test(code),
    (code.match(/ttMoveTip|ttReg\b|let ttTip/g) || []).join(','));
  // every branch the ported charts will rely on
  const mt = grab(TT, '  function moveTip(e) {', '\n  }') || '';
  for (const [name, probe] of [['ranked rows', /if \(d\.rows\)/], ['scatter', /if \(d\.scatter\)/],
                               ['bars', /if \(d\.bars\)/], ['nearest-x for lines', /d\.xs && d\.xs\.length/],
                               ['even spacing fallback', /d\.tips\.length - 1/],
                               ['an index clamp', /Math\.min\(d\.tips\.length - 1, idx\)/],
                               ['a guard on a tipless entry', /!d\.tips \|\| !d\.tips\.length/]]) {
    check('TikTok now handles ' + name, probe.test(mt), 'branch missing');
  }
  /* The raw ttReg.set in lineChart never pruned, so entries holding whole sample arrays
     accumulated for as long as the tab stayed open. */
  check('every chart on the TikTok page registers through chartPush, so the registry prunes',
    !/chartReg\.set\(/.test(TT.slice(TT.indexOf('function lineChart'))), 'a raw set is back');
}

/* ---------- 2c. love per view, on both pages ---------- */
/* The two renderers are shared verbatim; only the prose around them differs (videos vs
   posts). Pinning the renderers rather than re-testing their geometry is the point — the
   geometry is already covered on the YouTube side, and what actually breaks is one copy
   being fixed and the other not. */
console.log('\nlove per view is the same chart on both pages');
{
  const strip = t => (t || '').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n').replace(/\s+/g, ' ').trim();
  const grab = (src, from) => {
    const i = src.indexOf(from);
    return i < 0 ? null : src.slice(i, src.indexOf('\n  }\n', i));
  };
  for (const f of ['function ratePlotHtml(points, tips, opts) {', 'function rankListHtml(points, tips, opts) {']) {
    const a = grab(YT, '  ' + f), b2 = grab(TT, '  ' + f);
    check(f.slice(9, f.indexOf('(')) + ' is on the TikTok page', !!b2);
    check(f.slice(9, f.indexOf('(')) + ' is identical on both', !!b2 && strip(a) === strip(b2), 'they have drifted');
  }
  check('both pages default to the scatter and do not persist the choice',
    /let rateView = 'scatter', rateState = null;/.test(YT) && /let rateView = 'scatter', rateState = null;/.test(TT));
  check('and both switch views through the same delegated key',
    (YT.match(/data-rv/g) || []).length >= 3 && (TT.match(/data-rv/g) || []).length >= 3);

  /* Two gates on the TikTok side that the YouTube side does not need. A young TikTok
     account can have real views and zero likes on every post; the like-rate axis is a log
     ladder, so it would collapse to one decade and put every dot flat on the baseline —
     a chart that looks like it said something and did not. And a zero-view post makes the
     rate infinite, which reaches the path as NaN and silently blanks the whole SVG. */
  const mount = TT.slice(TT.indexOf('const pts = videos.filter'), TT.indexOf("id=\"rateWrap\""));
  check('a zero-view post never reaches the geometry',
    /videos\.filter\(v => \(v\.view_count \|\| 0\) > 0\)/.test(mount), 'an infinite rate becomes NaN');
  check('and an account with no likes at all draws nothing rather than a flat line',
    /pts\.length >= 5 && pts\.some\(p => p\.rate > 0\)/.test(mount));
  check('the tooltip carries shares per thousand, which only TikTok has', /shares\/1k/.test(mount));
  check('and never carries a post id', !/p\.id/.test(TT.slice(TT.indexOf('const sTips = pts.map'), TT.indexOf('rateState = {'))));
  check('the chart lives inside an already-revealed card, not the reveal array',
    /html \+= '<div class="dsection" id="rateWrap">'/.test(TT) && !/'rateWrap'/.test(TT.slice(TT.indexOf("['answerCard'"), TT.indexOf("].forEach(id =>"))));
}

/* ---------- 2d. tile sparklines, and the two that must stay empty ---------- */
console.log('\ntile sparklines');
{
  check('sparkHtml is the same on both pages', (() => {
    const strip = t => (t || '').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\s+/g, ' ').trim();
    const g = src => { const i = src.indexOf('  function sparkHtml(pts, color) {'); return i < 0 ? null : src.slice(i, src.indexOf('\n  }\n', i)); };
    return g(TT) && strip(g(YT)) === strip(g(TT));
  })());
  check('all four TikTok tiles carry a slot', (TT.match(/class="sparkslot"/g) || []).length === 4,
    (TT.match(/class="sparkslot"/g) || []).length + ' slots');

  const body = TT.slice(TT.indexOf('function renderTtSparks()'), TT.indexOf('\n  }\n', TT.indexOf('function renderTtSparks()')));
  check('followers is drawn from the recorded account series', /put\('ttFollowersSpark', series\(1\)/.test(body));
  check('and account likes, which only ever climbs', /put\('ttLikesSpark', series\(2\)/.test(body));
  /* The two that stay empty, and why an empty slot is the honest answer rather than a
     missing feature: TikTok publishes no lifetime view total, so the views tile sums the
     at-most-sixty posts the API returns and FALLS when one scrolls out; a line through it
     would show dips that are the list changing size. Comments has no account series at
     all, and summing the twenty recorded posts steps every time that set changes. */
  check('views is deliberately empty, not merely unimplemented', /put\('ttViewsSpark', \[\]/.test(body),
    'if this ever gets a series, the falling-window problem has to be solved first');
  check('and comments likewise', /put\('ttCommentsSpark', \[\]/.test(body));
  check('a flat series draws nothing either', /Math\.max\(\.\.\.pts\) > Math\.min\(\.\.\.pts\)/.test(body));
  check('and too few points draws nothing', /pts\.length >= 4/.test(body));
  check('it repaints on the poll that refreshes the history', /renderAnswer\(\); renderTtSparks\(\);/.test(TT));
}

/* ---------- 2e. the sound toggle ---------- */
console.log('\nthe sound toggle TikTok never had');
{
  check('the button is in the TikTok header', /id="soundBtn"/.test(TT));
  check('and it starts with an aria state, not just a glyph', /id="soundBtn"[^>]*aria-pressed/.test(TT));
  check('it writes the preference the YouTube page reads',
    /localStorage\.setItem\('cc_sound', soundOn \? 'on' : 'off'\)/.test(TT));
  check('both pages use the same key, so the choice follows the person',
    /'cc_sound'/.test(YT) && /'cc_sound'/.test(TT));
  check('the state is painted, not assumed', /function paintSound\(\)/.test(TT));
  check('and the glyph changes as well as the class', /b\.textContent = soundOn \? /.test(TT));
  /* No per-event chimes on this page, deliberately: the YouTube page rings on new likes
     and subscribers, but TikTok polls every 30-120s and cannot tell one like from five,
     so the only thing that makes a sound here is the milestone party. */
  check('turning it on previews the one sound this page actually makes',
    /if \(soundOn\) \{ unlockAudio\(\); partySound\(\); \}/.test(TT));
}

/* ---------- 3. TikTok velocity ---------- */
console.log('\nTikTok view velocity');
{
  check('the card is on the page', /id="velocityPanel"/.test(TT) && /id="rateText"/.test(TT) &&
    /id="bars"/.test(TT) && /id="sessionText"/.test(TT));
  check('and it is revealed at sign-in', /'statsGrid', 'velocityPanel'/.test(TT));

  const i = TT.indexOf('function renderVelocity()');
  check('renderVelocity exists', i > 0);
  const body = TT.slice(i, TT.indexOf('\n  }\n', i)) + '\n  }\n';
  check('it never differences account totals', !/prevTotals/.test(body));
  check('it accumulates per post', /perPost\[x\.id\]|const was = perPost\[x\.id\]/.test(body));
  check('a post seen for the first time contributes nothing', /if \(!was\) continue;/.test(body));
  check('every term is clamped at zero, so a departure cannot go negative',
    (body.match(/Math\.max\(0, cur/g) || []).length >= 2);

  // run it: the eviction case that would have printed "+-1,234"
  const fn = new Function('$', 'fmt', 'document', 'videos', 'state', `
    let { perPost, velHistory, velSession, velStart } = state;
    const MAX_BARS = 60;
    let velBackfilled = 0;              // the reload-resume additions ride the same render
    const saveVel = () => {};
    ${body}
    renderVelocity();
    return { perPost, velHistory, velSession, velStart };
  `);
  const out = {}, els = {};
  const $ = id => (els[id] = els[id] || {
    style: {}, classList: { add() {}, remove() {} }, children: [],
    set innerHTML(v) { out[id] = v; }, get innerHTML() { return out[id] || ''; },
    set textContent(v) { out[id] = v; }, get textContent() { return out[id] || ''; },
    appendChild(c) { this.children.push(c); }
  });
  const document = { createElement: () => ({ style: {}, className: '', title: '' }) };
  const fmtN = new Intl.NumberFormat('en-US');
  const post = (id, v) => ({ id, view_count: v, like_count: 1, comment_count: 1, share_count: 1 });
  let st = { perPost: {}, velHistory: [], velSession: null, velStart: 0 };
  st = fn($, fmtN, document, [post('a', 100), post('b', 200), post('old', 5000)], st);
  check('the first reading only records the roster', st.velSession && st.velHistory.length === 0);
  // 'old' scrolls out of the 60-post window and 'a' gains 10
  st = fn($, fmtN, document, [post('a', 110), post('b', 200)], st);
  check('a post falling out of the window does not subtract its views',
    st.velSession.views === 10, st.velSession.views);
  check('and the session line never prints "+-"', !/\+-/.test(out.sessionText || ''), out.sessionText);
  check('the tick recorded is the real gain', st.velHistory.join(',') === '10', st.velHistory.join(','));
  // and it keeps counting after the eviction, rather than pinning at zero
  st = fn($, fmtN, document, [post('a', 115), post('b', 207)], st);
  check('it keeps counting afterwards', st.velSession.views === 22, st.velSession.views);
  check('shares are counted too, which YouTube has no field for', /shares/.test(out.sessionText || ''));

  /* The table's movement columns ride on this same record rather than accumulating a
     second time — two accumulators over one poll would eventually disagree, and the one
     that disagreed would be the one nobody was testing. */
  check('the per-post record carries this tick\'s gain', st.perPost.a.tickV === 5, JSON.stringify(st.perPost.a));
  check('and the running session gain', st.perPost.a.sessV === 15, JSON.stringify(st.perPost.a));
  check('a post that never moved carries zero, not undefined',
    st.perPost.b.tickV === 7 && typeof st.perPost.b.sessV === 'number', JSON.stringify(st.perPost.b));
  check('a post that fell out of the window leaves no record behind', !st.perPost.old);
  /* and if it comes back it is a first sighting again — zero, rather than a spike made of
     everything it gained while nobody could see it */
  const back = fn($, fmtN, document, [post('a', 200), post('b', 220), post('old', 9999)], st);
  check('a returning post starts from zero rather than spiking',
    back.perPost.old.tickV === 0 && back.perPost.old.sessV === 0, JSON.stringify(back.perPost.old));
  check('and the account total does not jump with it', back.velSession.views - st.velSession.views < 200,
    back.velSession.views + ' vs ' + st.velSession.views);

  check('the table reads that record instead of deriving its own',
    /tickV: v => \(perPost\[v\.id\] && perPost\[v\.id\]\.tickV\) \|\| 0/.test(TT) &&
    /sessV: v => \(perPost\[v\.id\] && perPost\[v\.id\]\.sessV\) \|\| 0/.test(TT));
  check('and velocity is computed before the table draws, every poll',
    TT.indexOf('renderVelocity();') < TT.indexOf('renderTable(); showSlot(slotIdx);'),
    'the columns would show the previous tick otherwise');
  check('both new columns have a header that sorts', /data-sort="tickV"/.test(TT) && /data-sort="sessV"/.test(TT));
  check('and a dropdown option, without which a header click blanks the dropdown',
    /<option value="tickV">/.test(TT) && /<option value="sessV">/.test(TT));
  check('the table still opens on newest, not on a delta that is zero on the first poll',
    /let tableSort = \{ key: 'newest'/.test(TT),
    'a delta default reshuffles the whole table on the second poll');
  check('and the footnote says the counters resume and never go backwards',
    /survive a quick reload/.test(TT) && /stops being counted rather than counting backwards/.test(TT));

  for (const [src, page] of [[YT, 'index.html'], [TT, 'tiktok.html']]) {
    check(page + ' hides the per-minute rate until the session is half a minute old',
      /mins >= 0\.5 && pm >= 0\.05/.test(src), 'a 3-second session divides by 1/60 and prints four figures');
  }
  check('a short strip does not render as two slabs', /\.bars \.bar \{[^}]*max-width:16px/.test(CSS));
}

/* ---------- 3b. export / import, and the two things that must never leave ---------- */
/* This is the one add-on where a mistake is a privacy bug rather than a broken chart, so
   it is tested by RUNNING the collector against a seeded store rather than by reading it.

   Two identifiers live in this browser. tt_sess is a live Bearer token for the account.
   And the history store's KEY is named after the account — tt_hist:<open_id> — so a
   filename, not a value, is the leak. Hence an allow-list rather than the deny-list the
   YouTube page can afford: its keys are a fixed set, this one has a key family. */
/* ---------- 3a. cross-device sync, and the payload that must never travel ---------- */
/* The Worker route for this has existed since the page was built and had never been
   called. Most of the work was deciding what must NOT go through it — an adversarial pass
   over the original plan found that syncing the recorded curves would have caused
   cross-device DATA LOSS, so these checks are the fence around that. */
/* ---------- 2f. the hashtag card ---------- */
/* ---------- 2g. alerts and the acceleration badge ---------- */
/* The YouTube page gets these from a robot that commits a file to the repo. That robot has
   no TikTok credentials and cannot get any — the API only ever speaks to the signed-in
   account — so this is computed in the browser from the Worker's own recordings. Zero KV
   writes, zero D1 reads, nothing to schedule. */
console.log('\nwhile you were away');
{
  const accel = TT.slice(TT.indexOf('function buildAccel()'), TT.indexOf('\n  }\n', TT.indexOf('function buildAccel()')));
  const feed = TT.slice(TT.indexOf('function ttAlerts()'), TT.indexOf('\n  }\n', TT.indexOf('function ttAlerts()')));
  check('the card exists and is revealed', /id="alertsCard"/.test(TT) && /'velocityPanel', 'alertsCard'/.test(TT));
  check('it costs nothing — no request of its own',
    !/api\(|fetch\(/.test(accel + feed), 'the whole point is that the recordings are already here');

  /* The floor matters more than the ratio: three views yesterday and five today is a 67%
     rise and means nothing, and a small account produces a great many of those. */
  check('acceleration needs an absolute floor as well as a ratio',
    /today >= ACCEL_MIN && today >= before \* ACCEL_RATIO/.test(accel));
  check('and it compares a post against its own previous day, not against other posts',
    /ATB\(arr, now - 864e5\), d2 = ATB\(arr, now - 2 \* 864e5\)/.test(accel));
  check('a curve too short to have two days behind it is skipped', /arr\.length < 3/.test(accel));
  check('the badge is on the table row, with a title that explains it',
    /accelSet\.has\(v\.id\)/.test(TT) && /title="Accelerating/.test(TT));
  check('and it is rebuilt before anything renders from it',
    TT.indexOf('buildAccel();') < TT.indexOf('renderTable(); showSlot(slotIdx);'));

  /* Only crossings that actually happened between two recorded samples. No "you are close
     to", no rounding up to the nearest nice number — both would be the page inventing an
     event that did not occur. */
  check('the feed reports crossings between two real samples', /ladder\(f\[i - 1\]\[1\] \|\| 0, f\[i\]\[1\] \|\| 0\)/.test(feed));
  check('it uses the same milestone ladder as the projection card', /nextMilestone\(/.test(feed));
  check('the first hundred views on a post is not treated as news', /if \(m < 100\) continue;/.test(feed));
  check('the feed is bounded in time and in length',
    /ALERT_DAYS = 14/.test(TT) && /\.slice\(0, 8\)/.test(feed));
  check('and a caption cannot inject markup into it', /esc\(cap\.slice\(0, 46\)/.test(feed));
  /* One line per subject. A post that climbed three rungs inside the window reported all
     three and pushed everything else off the list — and "passed 100 views" is not news
     once "passed 500 views" is sitting above it. */
  check('one line per subject, not one per milestone crossed',
    /const best = new Map\(\);[\s\S]{0,200}if \(!best\.has\(a\.k\)\) best\.set\(a\.k, a\);/.test(feed));
  check('every entry carries the subject it is about', (feed.match(/out\.push\(\{ k: /g) || []).length === 3,
    (feed.match(/out\.push\(\{ k: /g) || []).length + ' of 3');

  /* A post in the feed is a thing you can LOOK AT, not just a caption: it wears its cover
     and opens the same per-post drawer a table row does. Only a post still in TikTok's
     60-post window is clickable — the drawer needs the live post, and a row that does
     nothing when tapped is worse than a plain one. Account-level rows have no post. */
  const ra = TT.slice(TT.indexOf('function renderAlerts()'), TT.indexOf('\n  }\n', TT.indexOf('function renderAlerts()')));
  check('a post entry carries its id and cover for the feed',
    /out\.push\(\{ k: 'v:' \+ id, id, cover,/.test(feed));
  check('the cover comes from the recording, with the live list as fallback',
    /\(rec && rec\.cover\) \|\| \(live && live\.cover_image_url\)/.test(feed));
  check('a row is clickable only while the post is still in the 60-post window',
    /videos\.some\(x => x\.id === a\.id\)/.test(ra));
  check('a clickable row is a real button to the keyboard',
    /role="button" tabindex="0" data-vid="/.test(ra) && /e\.key !== 'Enter' && e\.key !== ' '/.test(ra));
  check('clicking opens the same drawer as a table row', /ttdOpen\(b\.dataset\.vid, b\)/.test(ra));
  check('the handler is delegated and wired once', /el\.dataset\.wired/.test(ra));
  check('the accelerating chips open the drawer too, wearing a thumbnail',
    /class="chip chipv" data-vid="/.test(ra) && /<img alt="" loading="lazy" src="' \+ esc\(v\.cover_image_url\)/.test(ra));
  check('ids and covers are escaped on the way into markup',
    /data-vid="' \+ esc\(a\.id\)/.test(ra) && /src="' \+ esc\(a\.cover\)/.test(ra));
  check('the card copy says rows are tappable', /Tap any post to open its full breakdown/.test(TT));

  /* "While you were away" now means it: a per-device, per-account stamp of the last time
     the page was open sizes the headline, puts a dot on the new, and dims the seen. */
  check('the away stamp is read at boot and touched on every poll',
    /loadSeen\(\);/.test(TT) && /pollCount\+\+;\s*\n\s*touchSeen\(\);/.test(TT));
  check('the stamp is per-account and deliberately not synced or exported',
    /'tt_seen:' \+ \(\(me && me\.open_id\) \|\| ''\)/.test(TT) &&
    !/TT_PREFS = \[[^\]]*tt_seen/.test(TT));
  check('a stamp from the future is refused rather than trusted',
    /v > 0 && v < Date\.now\(\) \? v : null/.test(TT));
  const gb = TT.slice(TT.indexOf('function ttGainBuckets('), TT.indexOf('\n  }\n', TT.indexOf('function ttGainBuckets(')));
  check('a count that went backwards does not vote in the gain buckets', /if \(d <= 0\) continue;/.test(gb));
  const head = TT.slice(TT.indexOf('function ttAwayHeadHtml('), TT.indexOf('\n  }\n', TT.indexOf('function ttAwayHeadHtml(')));
  check('the headline only appears for a real absence, and says nothing over guessing',
    /AWAY_MIN/.test(head) && /if \(!bits\.length\) return '';/.test(head));
  check('a follower drop is shown signed, not clamped', /df > 0 \? '\+' : '−'/.test(head));
  const mom = TT.slice(TT.indexOf('function ttMomentsHtml('), TT.indexOf('\n  }\n', TT.indexOf('function ttMomentsHtml(')));
  check('the biggest hour needs a real gain behind it', /best\.gain >= 30/.test(mom));
  check('and only names a carrier post that actually carried it', /top\[1\] >= best\.gain \* 0\.6/.test(mom));
  check('today never ranks — it is not finished being a day', /\.filter\(\(\[k\]\) => k !== tk\)/.test(mom));
  check('the yesterday rank abstains below three full days', /done\.length >= 3/.test(mom));
  check('new items wear a dot and seen ones dim, only when this device knows',
    /const mark = awaySince != null;/.test(ra) && /fresh \? ' fresh' : ' seen'/.test(ra) &&
    /title="New since you last looked"/.test(ra));
}

/* The YouTube page carries the same card, on richer recordings — and it REPLACED the old
   "Recent milestones" list (alerts.json re-printed: not clickable, not sized to an
   absence, blind to anything the alert job missed). */
console.log('\nwhile you were away — the YouTube mirror');
{
  check('the card exists in the Now room', /id="awayCard"/.test(YT) && /id="awayContent"/.test(YT));
  check('it only shows once the robot\'s history exists',
    /if \(!hist\) \{ card\.style\.display = 'none'; return; \}/.test(YT));
  check('the old Recent milestones list is gone, and alerts.json is no longer fetched',
    !/section\('Recent milestones'/.test(YT) && !/histAlerts/.test(YT));

  /* The stamp. Same semantics as TikTok's — and the read must come BEFORE the boot's
     first poll, because the poll touches the stamp on every tick. The first draft read
     it after (in loadHistory), so the boot's own poll stamped "now" first and every
     absence measured ~30 seconds; the browser harness caught it. */
  check('the away stamp is per-channel and refused when from the future',
    /'yt_seen:' \+ \(chanId \|\| ''\)/.test(YT) && /v > 0 && v < Date\.now\(\) \? v : null/.test(YT));
  check('the stamp is read before the boot\'s first poll can touch it',
    YT.indexOf('loadSeen();') > 0 && YT.indexOf('loadSeen();') < YT.indexOf('await poll();'));
  check('and touched on every poll thereafter', /polling = true;\s*\n\s*touchSeen\(\);/.test(YT));

  /* The feed: crossings between two recorded samples only, same ladder as the milestone
     party, one line per subject, video rows tappable with their thumbnails. */
  const feed = YT.slice(YT.indexOf('function ytAway()'), YT.indexOf('\n  }\n', YT.indexOf('function ytAway()')));
  check('crossings come from consecutive recorded samples', /ladder\(chn\[i - 1\]\[1\] \|\| 0, chn\[i\]\[1\] \|\| 0\)/.test(feed));
  check('small rungs are not news — 100 for a video, 1,000 for channel views',
    /if \(m < 100\) continue;/.test(feed) && /if \(m < 1000\) continue;/.test(feed));
  check('one line per subject, capped at eight',
    /if \(!best\.has\(a\.k\)\) best\.set\(a\.k, a\);/.test(feed) && /\.slice\(0, 8\)/.test(feed));
  const rw = YT.slice(YT.indexOf('function renderAway()'), YT.indexOf('\n  }\n', YT.indexOf('function renderAway()')));
  check('a video row is clickable only when the drawer can actually open it',
    /const live = a\.id && meta\[a\.id\];/.test(rw));
  check('rows and chips open the same full-breakdown drawer', /openDrawer\(b\.dataset\.vid, b\)/.test(rw));
  check('rows are real keyboard buttons and the handler is wired once',
    /role="button" tabindex="0" data-vid="/.test(rw) && /el\.dataset\.wired/.test(rw));

  /* The richer half: the headline is EXACT (the robot records the channel's own totals),
     and yesterday is ranked on the channel's real daily views. */
  const head = YT.slice(YT.indexOf('function ytAwayHeadHtml('), YT.indexOf('\n  }\n', YT.indexOf('function ytAwayHeadHtml(')));
  check('the headline subtracts two real channel readings',
    /\(b\[2\] \|\| 0\) - \(a\[2\] \|\| 0\)/.test(head) && /histAtOrBefore\(chn, awaySince\)/.test(head));
  check('a subscriber drop shows signed, not clamped', /ds > 0 \? '\+' : '−'/.test(head));
  check('and it stays silent for a short absence or an empty one',
    /AWAY_MIN/.test(head) && /if \(!bits\.length\) return '';/.test(head));
  const mom = YT.slice(YT.indexOf('function ytMomentsHtml('), YT.indexOf('\n  }\n', YT.indexOf('function ytMomentsHtml(')));
  check('the biggest hour needs a real gain and a genuine carrier',
    /best\.gain >= 30/.test(mom) && /top\[1\] >= best\.gain \* 0\.6/.test(mom));
  check('yesterday ranks on channel days, today never ranks, and thin data abstains',
    /\.filter\(\(\[k\]\) => k !== tk\)/.test(mom) && /done\.length >= 3/.test(mom));
  check('a count that went backwards does not vote',
    /if \(d <= 0\) continue;/.test(YT.slice(YT.indexOf('function ytGainBuckets('), YT.indexOf('\n  }\n', YT.indexOf('function ytGainBuckets(')))));
  check('the feed styles exist in the shared stylesheet, with landscape thumbs',
    /#awayContent \.alert \.acover \{ width:44px; height:25px;/.test(CSS));
}

/* The velocity card across a browser reload: a quick reload RESUMES (strip, session,
   and the diffing baseline, so the gap is counted rather than dropped), a longer gap
   backfills the strip, faded, from minute-resolution recordings only. */
console.log('\nvelocity survives a reload');
{
  for (const [page, src, key] of [['YouTube', YT, 'yt_vel'], ['TikTok', TT, 'tt_vel']]) {
    check(page + ' — saved per account under its own key', new RegExp("'" + key + ":' \\+").test(src));
    check(page + ' — a quick reload resumes; a long gap does not', /VEL_RESUME = 30 \* 60e3/.test(src) &&
      /Date\.now\(\) - saved\.at <= VEL_RESUME/.test(src));
    check(page + ' — backfill only trusts minute-resolution samples',
      page === 'YouTube' ? /arr\[i\]\[0\] - arr\[i - 1\]\[0\] > 2\) continue;/.test(src)
                         : /arr\[i\]\[0\] - arr\[i - 1\]\[0\] > 2 \* 60e3\) continue;/.test(src));
    check(page + ' — the silent lead-in is trimmed, not shown as a wall of zeros',
      /while \(s < bars\.length && bars\[s\] === 0\) s\+\+;/.test(src));
    check(page + ' — backfilled bars are faded and say what they are',
      /\(back \? ' back' : ''\)/.test(src) && /recorded before this tab opened/.test(src));
    check(page + ' — faded bars age out of the left edge',
      /if \(velBackfilled > 0\) velBackfilled--;/.test(src));
  }
  /* The bug the harness caught: restoring the session baseline WITHOUT the per-video
     baseline made every video read as "first seen mid-session" on the first post-reload
     tick, and the newly-seen compensation added the whole catalogue's lifetime counts to
     the session baseline — the session line showed minus-everything. */
  check('YouTube — the per-video baseline is saved and restored with the session',
    /perVideo: Object\.fromEntries/.test(YT) && /for \(const \[id, p\] of Object\.entries\(saved\.perVideo \|\| \{\}\)\) perVideo\[id\] = \{ \.\.\.p, tickV: 0 \};/.test(YT));
  check('TikTok — likewise for its per-post baseline',
    /perPost: Object\.fromEntries/.test(TT) && /for \(const \[id, p\] of Object\.entries\(saved\.perPost \|\| \{\}\)\) perPost\[id\] = \{ \.\.\.p, tickV: 0 \};/.test(TT));
  check('YouTube — the save happens after the baseline advances',
    /prevTotals = totals;\s*\n\s*saveVel\(\);/.test(YT));
  check('YouTube — a poll before the video list exists refuses to tick',
    /if \(!videoIds\.length\) return;/.test(YT));
  check('YouTube — the strip paints backfill even before a first diff exists',
    /if \(history\.length\) \{\s*\n\s*const wrap = \$\('bars'\)/.test(YT));
  check('TikTok — a cold-open backfill starts the session at zero, honestly',
    /velSession = \{ views: 0, likes: 0, comments: 0, shares: 0 \};\s*\/\/ nothing watched yet/.test(TT));
  check('the faded-bar style exists once, in the shared stylesheet',
    /\.bars \.bar\.back \{ opacity:\.38; \}/.test(CSS));
  check('TikTok — the footnote no longer claims a reload resets the counts',
    !/reset when you reload/.test(TT) && /survive a quick reload/.test(TT));
}

/* Recorded trends — the daily series, follower history and arrival clock TikTok never
   provides, built entirely from the Worker's recordings. The old rationale for having
   no Trends room ("it publishes no daily series of its own") stopped being a rationale
   the day the recordings outgrew the three-day window. */
console.log('\nrecorded trends — the charts TikTok never provides');
{
  check('the card lives in the Account room, revealed at sign-in',
    /id="recTrendsCard"/.test(TT) && /'breakdownCard', 'recTrendsCard'/.test(TT));
  const rt = TT.slice(TT.indexOf('function renderRecTrends('), TT.indexOf('\n  }\n', TT.indexOf('const rr = $(\'recRange\')')));
  check('it only shows once the recordings exist',
    /if \(!hist\) \{ card\.style\.display = 'none'; return; \}/.test(rt));
  check('today never joins a week — it is not finished being a day',
    /\.filter\(k => k !== tk\)/.test(rt));
  check('weeks say how many recorded days they rest on', /recorded day/.test(rt));
  check('week-vs-week only speaks with five recorded days on each side',
    /last7\.length >= 5 && prev7\.length >= 5/.test(rt));
  check('the follower delta is exact between snapshots, over its stated span',
    /exact, between two snapshots/.test(rt) && /'Followers, ' \+ fSpanD/.test(rt));
  check('a recording younger than a week answers over its own span instead of abstaining',
    /\|\| \(f\.length > 1 \? f\[0\] : null\)/.test(rt));
  check('the views-per-day chart admits a missing day is a gap, not a zero',
    /A missing day is a gap in the recording, not a zero/.test(rt));
  check('the arrival clock is the viewer\'s own, and says so',
    /getHours\(\)/.test(rt) && /your own local time/.test(rt));
  check('and points at the Coach for the when-to-post question, not itself',
    /the Coach room answers when to post/.test(rt));
  check('follower history offers 30 / 90 / All', /\[30, 90, 0\]\.map/.test(rt));
  check('the card renders on the poll chain', /renderBreakdown\(\); renderRecTrends\(\);/.test(TT));
}

console.log('\nhashtags ranked by what they returned');
{
  const body = TT.slice(TT.indexOf('function renderTags()'), TT.indexOf('\n  }\n', TT.indexOf('function renderTags()')));
  check('the card exists and has a room', /id="tagsCard"/.test(TT) && /id="tagsContent"/.test(TT));
  check('and is revealed at sign-in', /'recTrendsCard', 'tagsCard', 'coachCard'/.test(TT));
  /* Frequency ranks your habits; reach ranks your results. A tag on two hits should beat
     a tag spread across ten quiet ones, which is the whole reason this is not a chip row
     sorted by count. */
  check('tags are ranked by average reach, not by how often they were used',
    /avg: e\.s \/ e\.n/.test(body) && /sort\(\(a, b\) => b\.avg - a\.avg\)/.test(body));
  check('and reach is the same figure the report card and Top 5 use', /scoreOf\(v\)/.test(body),
    'a tag must not look good here and bad three cards away');
  check('a tag used once is listed as untested rather than ranked', /e\.n >= TAG_MIN/.test(body),
    'one lucky post would otherwise top the list with a meaningless average');
  check('the bar carries how many posts the average rests on', /t\.n \+ ' posts'/.test(body));
  check('and the typical post is stated so a bar reads as better or worse than usual',
    /typical post reaches/.test(body));
  check('truncation is admitted rather than silent', /rated\.length > 10/.test(body));
  check('the thinner unranked copy in Coach is gone, not left above it',
    !/Hashtags to lean into/.test(TT), 'saying it twice let the weaker half win by being higher up');
  check('it repaints on the poll', /renderRecTrends\(\); renderTags\(\);/.test(TT));
  check('and a caption cannot inject markup through a tag', /esc\(t\)/.test(body));
}

console.log('\ncross-device sync');
{
  const pull = TT.slice(TT.indexOf('async function ttSyncPull()'), TT.indexOf('\n  }\n', TT.indexOf('async function ttSyncPull()')));
  const bundle = TT.slice(TT.indexOf('function ttSyncBundle()'), TT.indexOf('\n  }\n', TT.indexOf('function ttSyncBundle()')));
  check('the route is finally called', /api\('\/tiktok\/sync'\)/.test(TT));
  check('and there is a status pill for it', /id="syncStatus"/.test(TT));

  /* Four independent reasons, any one of which is sufficient: the Worker already serves
     the recordings to every device from D1; mergeHist prunes the local store to twenty
     posts so no browser holds an archive to contribute; the route is a bare whole-value
     KV put with no server-side merge, so the second writer erases the first; and curves
     re-timestamped from ages would not coincide with the live minute samples, so
     mergeHist's union-by-timestamp would interleave them and the series would stop being
     monotonic — which the projection, the race and the launch curves all read. */
  check('the bundle carries no recorded samples', !/hist/.test(bundle), bundle.slice(0, 200));
  check('nor does the pull path write any', !/hist\.videos/.test(pull));
  check('the bundle is only the ledger and the preferences',
    /return \{ v: 1, at: ttSyncLocalAt\(\), cele: ttSyncCele\(\), prefs \};/.test(bundle), bundle.slice(-160));

  // and only this account's rows out of a ledger shared with the YouTube page
  const cele = TT.slice(TT.indexOf('function ttSyncCele()'), TT.indexOf('\n  }\n', TT.indexOf('function ttSyncCele()')));
  check('only this account\'s celebration rows are sent', /const pre = 'tt:' \+ id \+ ':';/.test(cele));
  check('and nothing at all before an account is known', /if \(!id\) return out;/.test(cele));

  /* The ledger merges by taking the LARGER value per row. Every value in it is a count
     that only ever climbs, so "larger" means "more recent" without the two devices having
     to agree on a clock. */
  check('the ledger merges rather than being replaced', /if \(!\(k in c\) \|\| v > c\[k\]\)/.test(pull));
  check('preferences follow the device that changed one most recently',
    /\(\+d\.at \|\| 0\) > ttSyncLocalAt\(\)/.test(pull),
    'otherwise a second tab silently undoes a theme picked ten seconds ago');

  // KV budget: 1,000 writes/day, currently running around 220
  check('a write only happens when something actually changed',
    /if \(body === ttSyncKnown\) return;/.test(TT));
  check('and a burst of clicks collapses into one write',
    /if \(ttSyncTimer\) clearTimeout\(ttSyncTimer\);/.test(TT) && /\}, 60000\);/.test(TT));
  check('nothing is pushed before the first pull, so an empty device cannot erase the store',
    /!ttSyncPulled\) return;/.test(TT));
  check('a celebration schedules a push', /if \(typeof ttSyncSoon === 'function'\) ttSyncSoon\(false\);/.test(TT));
  check('and every synced preference does too',
    (TT.match(/ttSyncSoon\(true\)/g) || []).length === 4,
    (TT.match(/ttSyncSoon\(true\)/g) || []).length + ' of 4 preferences');
  check('the pull runs before the first history pull, so a preference lands before paint',
    TT.indexOf('await ttSyncPull();') < TT.indexOf('    await pullHistory();'));
}

console.log('\nexport and import');
{
  const i = TT.indexOf('  function ttCollect() {');
  check('ttCollect exists', i > 0);
  const body = TT.slice(i, TT.indexOf('\n  }\n', i)) + '\n  }\n';

  const store = {
    tt_sess: 'SECRET-BEARER-TOKEN',
    'tt_hist:aBcOpEnId12345': JSON.stringify({ videos: { p1: { s: [[1, 2]] } } }),
    tt_worker: 'https://mine.workers.dev',
    cc_theme: 'midnight', cc_room_tt: 'posts', cc_onepage: '1', cc_sound: 'off',
    cc_celebrated: JSON.stringify({ 'tt:aBcOpEnId12345:follower_count:seen': 300,
                                    'yt:UC123:subs:seen': 4900 }),
    'cc:launch:v1:xyz': 'a youtube cache entry',
    tt_hist: 'the legacy device-wide store'
  };
  const keys = Object.keys(store);
  const localStorage = {
    get length() { return keys.length; },
    key: n => keys[n],
    getItem: k => (k in store ? store[k] : null)
  };
  const mk = (ls, dflt) => new Function('localStorage', 'CELEB_KEY', 'DEFAULT_WORKER', 'TT_PREFS', 'TT_STAGE', '$',
    body + '\nreturn ttCollect;')(ls, 'cc_celebrated', dflt,
      ['cc_theme', 'cc_room_tt', 'cc_onepage', 'cc_sound'], 'tt_hist:@import', () => null);
  const collect = mk(localStorage, 'https://default.workers.dev');
  const out = collect();
  const json = JSON.stringify(out);

  check('the session token is not in the file', !/SECRET-BEARER-TOKEN/.test(json), json.slice(0, 200));
  check('and tt_sess is not even a key in it', !('tt_sess' in out), Object.keys(out).join(','));
  /* The subtle one: the value is fine to carry, the KEY names the account. */
  check('the account id is nowhere in the file, not even in a key name',
    !/aBcOpEnId12345/.test(json), (json.match(/.{0,40}aBcOpEnId12345.{0,20}/) || [''])[0]);
  check('the recorded samples still travel, under a placeholder name',
    out['tt_hist:@import'] && /"p1"/.test(out['tt_hist:@import']), Object.keys(out).join(','));
  check('the four shared preferences travel', ['cc_theme', 'cc_room_tt', 'cc_onepage', 'cc_sound'].every(k => out[k]));
  check('the YouTube page\'s celebration rows survive a whole-browser migration',
    /yt:UC123/.test(out.cc_celebrated || ''), out.cc_celebrated);
  check('but the TikTok ones, which are named after the account, do not',
    !/tt:aBcOpEnId12345/.test(out.cc_celebrated || ''), out.cc_celebrated);
  check('the legacy device-wide store is not resurrected', !('tt_hist' in out));
  check('and the YouTube page\'s own caches are left to the YouTube page\'s export',
    !Object.keys(out).some(k => k.startsWith('cc:')), Object.keys(out).join(','));

  // a Worker URL is carried only when it is not the one already in the page
  const dflt = mk({ length: 1, key: () => 'tt_worker',
                    getItem: k => (k === 'tt_worker' ? 'https://default.workers.dev' : null) },
                  'https://default.workers.dev');
  check('a default Worker URL is not written into the file', !dflt().tt_worker,
    'it is already hardcoded in a public repo; a custom one names the user\'s deployment');
  check('a custom one is', out.tt_worker === 'https://mine.workers.dev', String(out.tt_worker));

  // and the import side refuses a token even if a hand-edited file carries one
  const imp = TT.slice(TT.indexOf("$('ttImportFile').addEventListener"), TT.indexOf('rd.readAsText(f);'));
  check('the importer refuses a session token outright', /if \(k === 'tt_sess'\) continue;/.test(imp),
    'a hostile or hand-edited file must not be able to inject a session');
  check('and only accepts keys it recognises', /const ok = TT_PREFS\.includes\(k\)/.test(imp));
  check('an imported store is staged, not written straight onto an account',
    /localStorage\.setItem\(k\.startsWith\('tt_hist:'\) \? TT_STAGE : k, v\)/.test(imp),
    'import can run before sign-in, so the account is not known yet');
  check('and is adopted only into an account with nothing recorded',
    /if \(!hist\.videos \|\| !Object\.keys\(hist\.videos\)\.length\) \{[\s\S]{0,400}TT_STAGE/.test(TT),
    'an import must never overwrite history genuinely recorded on this device');
  check('the placeholder cannot collide with a real account key',
    /TT_STAGE = 'tt_hist:@import'/.test(TT), 'an open_id cannot contain @');

  // the bar itself is chrome
  check('the preference list the test injects is the page\'s own',
    /const TT_PREFS = \['cc_theme', 'cc_room_tt', 'cc_onepage', 'cc_sound'\];/.test(TT),
    'if the page adds a key here, this test stops covering it');
  check('the footer bar belongs to no room', /<div class="footer-tools">/.test(TT) &&
    !/<div class="(card|grid)[^"]*" id="tt(Export|Import|Data)/.test(TT));
  check('and works before sign-in, so a fresh device can import first',
    !/'ttExportBtn'|'ttImportBtn'/.test(TT.slice(TT.indexOf("['answerCard'"), TT.indexOf("].forEach(id =>"))));
}

/* ---------- 4. compare: length ---------- */
console.log('\ncompare page — video length');
{
  const i = CMP.indexOf('function durText(sec)');
  check('durText exists', i > 0);
  const durText = new Function(CMP.slice(i, CMP.indexOf('\n  }\n', i)) + '\n  }\nreturn durText;')();
  check('seconds under a minute', durText(47) === '0:47', durText(47));
  check('minutes and seconds', durText(8 * 60 + 42) === '8:42', durText(8 * 60 + 42));
  check('a leading zero on the seconds', durText(605) === '10:05', durText(605));
  check('hours when it runs long', durText(3 * 3600 + 4 * 60 + 5) === '3:04:05', durText(3 * 3600 + 4 * 60 + 5));
  check('exactly an hour', durText(3600) === '1:00:00', durText(3600));
  /* Zero means "not reported" — TikTok returns it for some posts and the ISO parser
     returns it for a live stream — so it must not print as a duration of no time. */
  check('nothing reported prints nothing rather than 0:00', durText(0) === '' && durText(null) === '' && durText(undefined) === '');
  check('and a negative is refused too', durText(-5) === '');

  check('both sides already carry a duration, so nothing new is fetched',
    /dur: isoDur\(it\.contentDetails/.test(CMP) && /dur: x\.duration \|\| 0/.test(CMP));
  check('the pair rows wear it over the frame', /class="plen"/.test(CMP));
  check('and the side-by-side lists it as a row', /\['Length', durText\(v\.dur\) \|\| 'not reported'\]/.test(CMP));
  check('YouTube frames are big enough to recognise', /\.pthumb\.y \{ width:124px; height:70px; \}/.test(CMP));
  check('and so are TikTok covers', /\.pthumb\.t \{ width:62px; height:110px; \}/.test(CMP));
}

/* Dates a person reads must be THEIR day, not UTC's.

   From Australia the two disagree every morning: at 8am in Melbourne it is still the
   previous day in UTC, so anything stamped from toISOString() claimed yesterday until
   10am. The request dates going to YouTube are the deliberate exception — the Analytics
   API reckons days in Pacific time, which UTC tracks far more closely than an Australian
   clock does — so `iso` stays UTC and `localDay` exists for everything shown. */
console.log('\ndates a human reads are the viewer\'s own day');
{
  check('there is a local-day helper, and it is not toISOString',
    /const localDay = d => new Date\(d\)\.toLocaleDateString\('en-CA'\)/.test(YT));
  check('the "fetched" stamp under the table uses it',
    /const d = c\.fetchedAt \? localDay\(c\.fetchedAt\) : ''/.test(YT));
  check('and no chart axis is still labelled from a UTC slice',
    !/shortDate\(new Date\([^)]*\)\.toISOString\(\)/.test(YT));

  // the exception, stated so nobody "fixes" it into a bug
  check('request dates to YouTube stay UTC on purpose',
    /const iso = d => d\.toISOString\(\)\.slice\(0, 10\)/.test(YT) &&
    /Don't "fix" this to local time/.test(YT));
  check('and the daily keyword budget still resets on Pacific, which is YouTube\'s clock',
    /timeZone: 'America\/Los_Angeles'/.test(YT));

  // a date or time shown to a human should not fall back to the device's locale
  for (const [page, src] of [['YouTube', YT], ['TikTok', TT], ['Compare', CMP]])
    check(page + ' — no toLocale*String(undefined, …) left', !/toLocale\w*String\(undefined/.test(src), page);
}

/* One question, one answer. The Audience room used to carry a second "best time to post"
   ranked on views-per-day, with different day-part boundaries from the Coach room's — so
   the two cards could name different slots, and the extra one used the age-inverted metric
   every other ranking dropped. */
console.log('\nbest time to post is answered in exactly one place');
{
  for (const [page, src] of [['YouTube', YT], ['TikTok', TT]]) {
    const n = (src.match(/section\('Best time to post/g) || []).length;
    check(page + ' — exactly one "Best time to post" card', n === 1, 'found ' + n);
    const d = (src.match(/section\('Best day to post/g) || []).length;
    check(page + ' — exactly one "Best day to post" card', d === 1, 'found ' + d);
  }
  check('YouTube — it says which clock the hours are in', /in <b>your own local time<\/b>/.test(YT));
  check('TikTok — likewise', /in <b>your own local time<\/b>/.test(TT));
  check('the hour it buckets by is the viewer\'s, not UTC\'s',
    /hour: d\.getHours\(\)/.test(YT) && !/getUTCHours/.test(YT));
  // "when views arrive" asks a different question and stays
  check('the arrival-by-hour chart is still there', /When views actually arrive/.test(YT));

  /* Hour by hour, not day-part bands. The 3–4 hour bands ("Afternoon (3pm–7pm)")
     averaged away the answer; the card now scores each of the 24 hours separately,
     says how many posts each hour rests on, and names the hours never posted in
     rather than dropping them silently. */
  for (const [page, src] of [['YouTube', YT], ['TikTok', TT]]) {
    check(page + ' — the day-part bands are gone', !/Midday \(11am–3pm\)/.test(src) && !/HOUR_BANDS|const BANDS/.test(src));
    check(page + ' — it buckets all 24 hours', /for \(let h = 0; h < 24; h\+\+\)/.test(src));
    check(page + ' — every row carries its evidence count', /' avg · ' \+ a\.length/.test(src));
    check(page + ' — a single-' + (page === 'YouTube' ? 'video' : 'post') + ' hour is called an anecdote', /is an anecdote/.test(src));
    check(page + ' — hours never posted in are stated, not dropped', /Never posted at/.test(src));
    const hourLabel = new Function(src.slice(src.indexOf('const hName'), src.indexOf('\n', src.indexOf('const hourLabel'))) + '\nreturn hourLabel;')();
    check(page + ' — hour labels read as a clock', hourLabel(0) === '12am–1am' && hourLabel(15) === '3pm–4pm' && hourLabel(23) === '11pm–12am',
      [hourLabel(0), hourLabel(15), hourLabel(23)].join(' / '));
  }
}

/* Two grids of the same cells, over different stretches of a video's life. */
console.log('\nthe two metric grids say which stretch they cover');
{
  check('the latest-upload card says since publication', /Official stats <b>since this went up<\/b>/.test(YT));
  check('the drawer names its selected range',
    /Official stats for <b>' \+\s*\(currentDays === 0 \? 'this video’s whole life' : 'the last ' \+ currentDays \+ ' days'\)/.test(YT));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
