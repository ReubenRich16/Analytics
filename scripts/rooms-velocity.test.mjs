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

  for (const [src, page] of [[YT, 'index.html'], [TT, 'tiktok.html']]) {
    check(page + ' hides the per-minute rate until the session is half a minute old',
      /mins >= 0\.5 && pm >= 0\.05/.test(src), 'a 3-second session divides by 1/60 and prints four figures');
  }
  check('a short strip does not render as two slabs', /\.bars \.bar \{[^}]*max-width:16px/.test(CSS));
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

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
