// The Posts grid — thumbnails three to a row, as on a TikTok profile — run against the
// page's own code.
//
//   · one tile per post, in the order renderTable sorted, each a button that opens the drawer;
//   · the views bottom-left (TikTok's play count), the sorted-by figure bottom-right when it
//     isn't views, a green +N for views gained since the last refresh, NEW or ⚡ top-left;
//   · a post without a cover still gets a tile, wearing its caption;
//   · the List button brings the table back, the sort control drives both, and the choice is
//     remembered under one key.
//
// Run: node scripts/tt-grid.test.mjs
process.env.TZ = 'Australia/Melbourne';
import fs from 'fs';
const TT = fs.readFileSync(new URL('../yt-dashboard/tiktok.html', import.meta.url), 'utf8');

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
const H = 3600e3, D = 864e5;

const GRID = cut('  const TT_VIEW_KEY = ', '  function applyPostsView() {');
const SRC = `
  const RealDate = globalThis.Date;
  class Date extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
  const fmt = new Intl.NumberFormat('en-AU');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const escAttr = s => esc(s).replace(/"/g, '&quot;');
  const els = {};
  const $ = id => els[id] || (els[id] = { id, innerHTML: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {} });
  const PJ_HORIZON = 48 * 60;
  const ACCEL_RATIO = 1.5;
  let tableSort = { key: sortKey, dir: -1 };
  const localStorage = { getItem: () => stored, setItem() {} };
  ${line('  const capOf = ')}
  ${arrow('  const clip = (s, n) =>')}${arrow('  const shortCap = ')}${line('  const TAG_RE = ')}${arrow('  const noTags = s =>')}${arrow('  const feedCap = ')}
  ${line('  const ageDays = ')}${line('  const paceOf = ')}${line('  const engOf = ')}
  ${fnOf('axisNum')}
  ${GRID}
  return { tileHtml, renderGrid, TILE_KEY, TT_VIEW_KEY, postsView, els };`;
const load = (NOW, posts, perPost, accel, sortKey = 'newest', stored = null) =>
  new Function('NOW', 'videos', 'perPost', 'accelSet', 'sortKey', 'stored', SRC)(NOW, posts, perPost || {}, new Set(accel || []), sortKey, stored);

const NOW = new Date(2026, 9, 9, 21, 30).getTime();   // Fri 9 Oct, 9:30 pm
const post = (id, daysAgo, views, extra = {}) => ({ id, title: 'Post ' + id + ' #asmr #tingles', create_time: Math.round((NOW - daysAgo * D) / 1000),
  cover_image_url: 'https://c/' + id + '.jpg', view_count: views, like_count: Math.round(views / 10), comment_count: 7, share_count: 3, ...extra });
const text = h => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('\nthe markup: three to a row, inside the Posts card, with the toggle and the sort control');
{
  check('the grid is three columns on a phone', /\.ttgrid \{ display:grid; grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/.test(TT));
  check('and fits more across on a wider screen', /@media \(min-width:641px\) \{ \.ttgrid \{ grid-template-columns:repeat\(auto-fill, minmax\(150px, 1fr\)\)/.test(TT));
  check('tiles keep a portrait shape with the cover filling it', /\.ttile \{[^}]*aspect-ratio:3 \/ 4/.test(TT) && /\.ttile img \{[^}]*object-fit:cover/.test(TT));
  check('the grid sits in the Posts card, above the table, after the toggle and sort', (() => {
    const card = cut('<div class="card tablecard" id="tableCard"', '<div class="room-pane" data-pane="account"');
    return card.indexOf('id="viewGrid"') < card.indexOf('id="sortMode"') && card.indexOf('id="sortMode"') < card.indexOf('id="ttGrid"') && card.indexOf('id="ttGrid"') < card.indexOf('<table>');
  })());
  check('the toggle is a labelled group of two pressed-state buttons', /role="group" aria-label="How to show your posts"/.test(TT) && /id="viewGrid" aria-pressed="true"/.test(TT) && /id="viewList" aria-pressed="false"/.test(TT));
  check('the sort control is unchanged — the same options as before', /<option value="newest" selected>Sort: newest<\/option>/.test(TT) && /<option value="eng">Sort: like rate<\/option>/.test(TT) && /<option value="title">Sort: caption A–Z<\/option>/.test(TT));
  check('grid mode hides the table and its note; list mode hides the grid and its note', /\.tablecard\.grid-on \.tscroll, \.tablecard\.grid-on \.listnote \{ display:none; \}/.test(TT) && /\.tablecard:not\(\.grid-on\) \.ttgrid, \.tablecard:not\(\.grid-on\) \.gridnote \{ display:none; \}/.test(TT));
  check('the grid’s note says what the marks mean', /class="dnote gridnote">Tap a post for its full breakdown\. The number is its views; a green \+N is views gained since the last refresh; ⚡ means speeding up; NEW is a post still in its first 48 hours\./.test(TT));
}

console.log('\nthe tiles');
{
  const posts = [post('a', 30, 12345), post('b', 1, 950, { title: 'Fresh one #asmr' }), post('c', 5, 1000000)];
  const P = load(NOW, posts, { b: { tickV: 12, sessV: 40 } }, []);
  const h = P.tileHtml(posts[0]);
  check('a tile is a button carrying the post id', /^<button type="button" class="ttile" data-id="a" /.test(h), h.slice(0, 80));
  check('its label is the caption without tags and the exact views', /aria-label="Post a — 12,345 views"/.test(h), h.match(/aria-label="[^"]*"/)[0]);
  check('the cover fills it', /<img alt="" loading="lazy" src="https:\/\/c\/a\.jpg">/.test(h));
  check('the views sit bottom-left, compacted like an axis (12.3k)', /<span class="tv">12\.3k<\/span>/.test(h));
  check('a 30-day-old post is neither NEW nor ⚡', !/tnew/.test(h));
  check('sorted by newest, no second figure is written', !/class="tk"/.test(h));
  const hb = P.tileHtml(posts[1]);
  check('a post in its first 48 hours says NEW', /<span class="tnew">NEW<\/span>/.test(hb));
  check('a post gaining since the last refresh wears a green +N and the mover class', /class="ttile mover"/.test(hb) && /<span class="tgain">\+12<\/span>/.test(hb));
  check('and its label says so', /aria-label="Fresh one — 950 views, \+12 since the last refresh"/.test(hb), hb.match(/aria-label="[^"]*"/)[0]);
  check('a million reads as 1M', /<span class="tv">1M<\/span>/.test(P.tileHtml(posts[2])));
  const Q = load(NOW, posts, {}, ['a']);
  const ha = Q.tileHtml(posts[0]);
  check('a speeding-up post wears ⚡ instead of NEW, and its label says so', /<span class="tnew" title="Speeding up[^"]*">⚡<\/span>/.test(ha) && /, speeding up"/.test(ha));
  const bare = P.tileHtml({ id: 'z', title: '', create_time: Math.round((NOW - 3 * D) / 1000), view_count: 5 });
  check('no cover: a placeholder saying what it is, and the label says the post has no caption', /<span class="noimg">No cover yet<\/span>/.test(bare) && /aria-label="a post with no caption — 5 views"/.test(bare), bare);
  const capd = P.tileHtml({ id: 'y', title: 'Rain on a tin roof #sleep', create_time: Math.round((NOW - 3 * D) / 1000), view_count: 5 });
  check('no cover but a caption: the caption, without its tags', /<span class="noimg">Rain on a tin roof<\/span>/.test(capd), capd);
  check('a caption cannot inject markup', !/<b>/.test(P.tileHtml({ id: 'x', title: '<b>hi</b>', create_time: 1, view_count: 1, cover_image_url: 'https://c/x.jpg"onload="x' })) &&
    /src="https:\/\/c\/x\.jpg&quot;onload=&quot;x"/.test(P.tileHtml({ id: 'x', title: '<b>hi</b>', create_time: 1, view_count: 1, cover_image_url: 'https://c/x.jpg"onload="x' })));
}

console.log('\nthe sorted-by figure, bottom-right');
{
  const posts = [post('a', 30, 12345)];
  const key = (sortKey, perPost) => (load(NOW, posts, perPost, [], sortKey).tileHtml(posts[0]).match(/<span class="tk">([^<]*)<\/span>/) || [])[1];
  check('likes', key('likes') === '♥ 1,235', key('likes'));
  check('comments', key('comments') === '💬 7', key('comments'));
  check('shares', key('shares') === '↗ 3', key('shares'));
  check('like rate', key('eng') === '10.0%', key('eng'));
  check('average a day', key('pace') === '412/day', key('pace'));
  check('since refresh, only when it moved', key('tickV', { a: { tickV: 55 } }) === '+55' && key('tickV', {}) === undefined);
  check('this visit, likewise', key('sessV', { a: { sessV: 300 } }) === '+300' && key('sessV', {}) === undefined);
  check('views and caption sorts write nothing extra', key('views') === undefined && key('title') === undefined);
  check('a post too young for a daily figure writes nothing for pace', (() => {
    const young = [post('q', 0.5, 90)];
    return !/class="tk"/.test(load(NOW, young, {}, [], 'pace').tileHtml(young[0]));
  })());
}

console.log('\nthe grid follows the table’s order, and the view is remembered');
{
  const posts = [post('a', 30, 100), post('b', 1, 200), post('c', 5, 300)];
  const P = load(NOW, posts, {}, []);
  P.renderGrid([posts[2], posts[0], posts[1]]);
  const ids = [...P.els.ttGrid.innerHTML.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]);
  check('renderGrid draws the rows it is given, in that order', ids.join(',') === 'c,a,b', ids.join(','));
  check('renderTable hands the grid its sorted rows', /renderGrid\(rows\);\n    const tb = \$\('tbody'\)/.test(TT));
  check('the label says what to tap in each view', /tap a post for details/.test(TT) && /tap a row for details, \\u2197 opens it on TikTok/.test(TT));
  check('grid is the default, and a remembered “list” is honoured', load(NOW, posts, {}, []).postsView === 'grid' && load(NOW, posts, {}, [], 'newest', 'list').postsView === 'list' && load(NOW, posts, {}, [], 'newest', 'junk').postsView === 'grid');
  check('the choice is kept under its own key', P.TT_VIEW_KEY === 'tt_posts_view' && /localStorage\.setItem\(TT_VIEW_KEY, postsView\)/.test(TT));
  check('one listener on the grid opens the drawer for the tapped tile', /\$\('ttGrid'\)\.addEventListener\('click', e => \{\n    const t = e\.target\.closest \? e\.target\.closest\('\.ttile'\) : null;\n    if \(t\) ttdOpen\(t\.dataset\.id, t\);/.test(TT));
  check('switching view re-renders so the label and the view agree', /function setPostsView\(v\) \{[\s\S]*?applyPostsView\(\);\n    if \(videos\.length\) renderTable\(\);/.test(TT));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' + pass + ' passed' : pass + ' passed, 0 failed'));
process.exit(fail ? 1 : 0);
