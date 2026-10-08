// Baseline — the TikTok page's "is your typical post getting bigger?" card (Account room),
// run against the page's own code.
//
//   · the measure is each post's views in its FIRST 48 HOURS, read off the recorded launch
//     through pjRef — the projection's own admission rule — never the lifetime count;
//   · the answer is a median: the middle of the newest N against the middle of the N before
//     (N = 5 from ten launches, 4 from eight, 3 from six; under six it says what it needs);
//   · the chart is one slot per post, oldest to newest, with the trailing median as a line,
//     a launching post hollow at its estimate and not counted, and a hit far above the
//     baseline drawn at the top edge as ▲ with its figure, so it cannot flatten the rest;
//   · what is left out is said: launching posts, holed or unrecorded launches, the device's
//     20-post bound.
//
// Melbourne time throughout, set before anything reads a clock.
//
// Run: node scripts/tt-baseline.test.mjs
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
const H = 3600e3, D = 864e5, MIN = 60e3;
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();   // Melbourne wall clock
const f0 = new Intl.NumberFormat('en-AU');

// the page's code: the Baseline block, and everything it leans on
const BASE = cut('  /* ---------- Baseline: is your typical post getting bigger?', '  const recDayLabel = ');
const SRC = `
  const RealDate = globalThis.Date;
  class Date extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
  const fmt = new Intl.NumberFormat('en-AU');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const scoreOf = v => (scores && scores[v.id] != null) ? scores[v.id] : null;
  const els = {};
  const $ = id => els[id] || (els[id] = { id, style: {}, innerHTML: '' });
  ${arrow('  const clip = (s, n) =>')}
  ${arrow('  const shortCap = ')}
  ${line('  const TAG_RE = ')}
  ${arrow('  const noTags = s =>')}
  ${arrow('  const feedCap = ')}
  ${line('  const chartReg = ')}${line('  let chartCi = ')}${line('  const chartPush = ')}
  ${fnOf('niceScale')}${fnOf('axisNum')}
  ${cut('  const legendHtml = ', "</div>';\n")}</div>';
  ${line('  const foldOpen = ')}${line('  const foldAttr = ')}
  ${line('  const PJ_HORIZON = ')}${line('  const PJ_COVER = ')}${line('  const PJ_GAP = ')}
  ${fnOf('pjAt')}${fnOf('pjClean')}${fnOf('pjRef')}${fnOf('pjCurveOf')}
  ${line('  const pjMed = ')}
  ${BASE}
  return { blModel, blChartHtml, renderBaseline, BL_WINDOW, BL_NEED, chartReg, els };`;
const load = (NOW, hist, videos, scores) => new Function('NOW', 'hist', 'videos', 'scores', SRC)(NOW, hist, videos, scores || {});

/* A recorded launch the way the Worker's launch curve arrives: a reading every five minutes
   from publish to `reachH` hours, climbing to `final` by hour 48 and flat after. `hole` leaves
   a stretch of minutes out, which is what disqualifies a reference. */
const launch = (t0, final, reachH = 50, hole) => {
  const s = [];
  for (let m = 0; m <= reachH * 60; m += 5) {
    if (hole && m >= hole[0] && m <= hole[1]) continue;
    s.push([t0 * 1000 + m * MIN, Math.round(final * Math.min(1, m / 2880)), 0, 0, 0]);
  }
  return s;
};
// finished posts a day apart, oldest first, the newest of them three days old
const mk = (NOW, finals, extra = {}) => {
  const vids = {}, videos = [];
  finals.forEach((f, i) => {
    const t0 = Math.floor((NOW - (finals.length - i + 2) * D) / 1000), id = 'p' + (i + 1);
    const title = 'Post number ' + (i + 1) + ' #asmr #tingles';
    vids[id] = { create_time: t0, title, s: launch(t0, f) };
    videos.push({ id, title, create_time: t0, view_count: f + 40 });
  });
  Object.assign(vids, extra.vids || {});
  videos.push(...(extra.videos || []));
  return load(NOW, { videos: vids }, videos, extra.scores);
};
const text = h => h.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/[ \t\n\r]+/g, ' ').trim();
const render = P => { P.renderBaseline(); return P.els.baselineContent.innerHTML; };
const svgOf = h => (h.match(/<svg class="chart" data-ci="(\d+)"[\s\S]*?<\/svg>/) || [''])[0];
const regOf = (P, h) => P.chartReg.get(+(svgOf(h).match(/data-ci="(\d+)"/) || [])[1]);
const tiles = h => [...h.matchAll(/<div class="tile"><div class="v( none)?">([^<]*)<\/div><div class="k">([^<]*)<\/div><div class="c">([^<]*)<\/div><div class="c">([^<]*)<\/div><\/div>/g)].map(m => ({ none: !!m[1], v: m[2], k: m[3], c1: m[4], c2: m[5] }));
const day = (NOW, n) => new Date(NOW - n * D).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

const NOW = at(2026, 9, 30, 20, 0);   // Wed 30 Sep, 8 pm

console.log('\nthe window: five from ten launches, four from eight, three from six, nothing under six');
{
  const P = mk(NOW, [1000]);
  check('BL_WINDOW', [0, 5, 6, 7, 8, 9, 10, 20].map(P.BL_WINDOW).join(',') === '0,0,3,3,4,4,5,5');
  check('six is what comparing needs', P.BL_NEED === 6);
}

console.log('\nten launches: the middle of the newest five against the middle of the five before');
{
  const finals = [1000, 1200, 900, 1100, 1000, 2000, 2400, 1800, 2200, 2000];
  const P = mk(NOW, finals);
  const m = P.blModel();
  check('every launch qualifies, in upload order', m.done.length === 10 && m.done.map(p => p.v).join(',') === finals.join(','), m.done.map(p => p.v).join(','));
  check('the measure is the 48-hour reading, not the lifetime count', m.done.every((p, i) => p.v === finals[i]) && m.done[0].v !== finals[0] + 40);
  check('N is 5, now 2,000, before 1,000, up 100%', m.n === 5 && m.now === 2000 && m.before === 1000 && m.delta === 100, JSON.stringify([m.n, m.now, m.before, m.delta]));
  check('the trailing median starts at the fifth post and ends on the newest', m.med.slice(0, 4).every(v => v == null) && m.med[4] === 1000 && m.med[9] === 2000, JSON.stringify(m.med));
  const h = render(P), t = text(h), tl = tiles(h);
  check('two tiles, as the motion layer counts them', tl.length === 2 && /class="today-tiles tr-tiles"/.test(h), tl.length);
  check('newest five: 2,000, named for what it is, with its dates and its basis',
    tl[0].v === '2,000' && tl[0].k === 'views in its first 48 hours, newest 5 posts' && tl[0].c1 === day(NOW, 7) + ' – ' + day(NOW, 3) && tl[0].c2 === 'the middle of 5', JSON.stringify(tl[0]));
  check('the five before: 1,000, with their dates', tl[1].v === '1,000' && tl[1].k === 'views in its first 48 hours, the 5 before' && tl[1].c1 === day(NOW, 12) + ' – ' + day(NOW, 8), JSON.stringify(tl[1]));
  check('the sentence: 100% more, and the baseline is rising',
    h.includes('Your typical post now gets <b>100% more views</b> in its first 48 hours than the 5 before did — <span class="cc-win">your baseline is rising</span>.'), t.slice(0, 300));
  check('"rising" wears the win colour', /<span class="cc-win">your baseline is rising<\/span>/.test(h));
  check('the section is named for the question', /Baseline: is your typical post getting bigger/.test(BASE) && /Your typical post — newest vs the ones before/.test(t));
  // the chart
  const svg = svgOf(h), reg = regOf(P, h);
  const dots = [...svg.matchAll(/<circle class="pt(?: est)?" data-i="(\d+)"[^>]*r="([\d.]+)" style="([^"]*)"/g)];
  check('one dot per post, ten, inside svg.chart', !!svg && dots.length === 10, dots.length);
  check('no dot is hollow — nothing is launching', dots.every(d => !/est/.test(d[0])));
  check('the newest finished post is the accent, larger, the rest muted', dots[9][2] === '5.5' && /fill:var\(--accent\)/.test(dots[9][3]) && dots.slice(0, 9).every(d => d[2] === '4.5' && /fill:var\(--muted\)/.test(d[3])));
  check('and it carries its figure, as a line’s endpoint would', /<text class="val" [^>]*>2,000<\/text>/.test(svg), svg.match(/<text class="val[^>]*>[^<]*<\/text>/g));
  const path = (svg.match(/<path class="line anim" pathLength="1" d="([^"]+)"/) || [])[1];
  check('the median line runs through the six posts that have one, in the accent', !!path && path.split(' L').length === 6 && /stroke:var\(--accent\)/.test(svg), path);
  check('the line is drawn by motion.js (pathLength) like every other line here', /pathLength="1"/.test(svg));
  check('the first and last upload dates label the axis', svg.includes('>' + day(NOW, 12) + '</text>') && svg.includes('>' + day(NOW, 3) + '</text>'));
  check('the axis counts whole views on human ticks', /niceScale\(0, top, 4, true\)/.test(BASE) && />500<\/text>/.test(svg) === false || />1k<\/text>|>1,000<\/text>/.test(svg));
  check('the tooltip engine gets one tip per post on the nearest-x branch, ringed by the accent',
    reg && reg.xs.length === 10 && reg.ys.length === 10 && reg.tips.length === 10 && reg.color === 'var(--accent)' && !reg.bars && !reg.scatter, reg && reg.tips.length);
  check('a tip is the date, the caption without its tags, and the figure',
    reg.tips[9] === day(NOW, 3) + ' — “Post number 10”: 2,000 views in its first 48 hours', reg.tips[9]);
  check('x runs oldest to newest', reg.xs[0] < reg.xs[9] && reg.tips[0].startsWith(day(NOW, 12)));
  check('a crosshair and a following dot are in the markup', /class="cline"/.test(svg) && /class="cdot"/.test(svg));
  check('the aria-label says what the chart is', /aria-label="Each post’s first 48 hours, oldest to newest, with the middle of the last 5 as a line"/.test(svg));
  // legend and fold
  check('a legend names the dots and the line', /lg-key dot"[^>]*>[^<]*<\/span>a post’s first 48 hours/.test(h) && /middle of the last 5 — your baseline/.test(h));
  check('no launching entry in the legend when nothing is launching', !/still launching/.test(h));
  check('the fold explains the measure, the median, and the device’s bound', /the same stretch of every post’s life/.test(h) && /middle \(median\) of the last 5 posts/.test(h) && /up to 20/.test(h));
  check('nothing is said about left-out posts when none are', !/can’t be compared/.test(h) && !/drawn hollow/.test(h) && !/above the top of the chart/.test(h));
  check('the fold is a remembered fold', /data-fold="baseline-how"/.test(h));
}

console.log('\nthe other two sentences: fewer, and about the same');
{
  const down = mk(NOW, [2000, 2400, 1800, 2200, 2000, 1000, 1200, 900, 1100, 1000]);
  const td = text(render(down));
  check('down 50% says fewer, and nothing about rising', td.includes('Your typical post now gets 50% fewer views in its first 48 hours than the 5 before did.') && !/rising/.test(td), td.slice(0, 300));
  const same = mk(NOW, [1000, 1000, 1000, 1000, 1000, 1050, 1050, 1050, 1050, 1050]);
  const ts = text(render(same));
  check('within 8% is about the same (5% here)', ts.includes('Your typical post gets about the same views in its first 48 hours as the 5 before did.'), ts.slice(0, 300));
  check('a median: one hit among the newest five does not move the tile', (() => {
    const P = mk(NOW, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 90000]);
    const m = P.blModel(); return m.now === 1000 && m.delta === 0;
  })());
}

console.log('\nunder six launches: one tile, and what it needs');
{
  const P = mk(NOW, [1000, 1100, 1200, 1300]);
  const m = P.blModel();
  check('no window', m.n === 0 && m.now == null && m.delta == null);
  check('the line still runs, as the middle of three', m.w === 3 && m.med.join(',') === ',,1100,1200', m.med.join(','));
  const h = render(P), t = text(h), tl = tiles(h);
  check('one tile with the middle of the four, the other empty and saying what it needs',
    tl.length === 2 && tl[0].v === '1,150' && tl[0].k === 'views in its first 48 hours, your 4 recorded posts' && tl[0].c2 === 'the middle of 4' &&
    tl[1].none && tl[1].v === '—' && tl[1].c2 === 'needs 2 more finished launches', JSON.stringify(tl));
  check('and the sentence', t.includes('Comparing newest against earlier needs 6 finished launches — 4 recorded so far. It fills in by itself.'), t.slice(0, 300));
  check('the chart still draws its four dots', [...svgOf(h).matchAll(/<circle class="pt"/g)].length === 4);
  const one = render(mk(NOW, [800]));
  const t1 = tiles(one);
  check('a single launch is “your one recorded post”, “one post”, needing 5 more', t1[0].k === 'views in its first 48 hours, your one recorded post' && t1[0].c2 === 'one post' && t1[1].c2 === 'needs 5 more finished launches', JSON.stringify(t1));
}

console.log('\na launching post: hollow at its estimate, not counted');
{
  const t0 = Math.floor((NOW - 10 * H) / 1000);
  const extra = { vids: { q: { create_time: t0, title: 'Fresh one #asmr', s: launch(t0, 1500, 10) } },
                  videos: [{ id: 'q', title: 'Fresh one #asmr', create_time: t0, view_count: 700 }], scores: { q: 1500 } };
  const P = mk(NOW, [1000, 1100, 1200, 1300], extra);
  const m = P.blModel();
  check('it is in the posts, last, not done, at the projection’s mid', m.posts.length === 5 && !m.posts[4].done && m.posts[4].v === 1500 && m.done.length === 4 && m.launching === 1);
  const h = render(P), t = text(h), svg = svgOf(h), reg = regOf(P, h);
  check('drawn as a hollow dashed dot in the accent', /<circle class="pt est" data-i="4"[^>]*style="fill:var\(--ink\);stroke:var\(--accent\)/.test(svg));
  check('its tip says it is an estimate and not counted', reg.tips[4] === day(NOW, 0) + ' — “Fresh one”: heading for ~1,500 (estimate — not counted yet)', reg.tips[4]);
  check('the legend gains the launching entry', /still launching — estimate, not counted/.test(h));
  check('the fold says so too', /drawn hollow at its estimate and not counted yet\./.test(h));
  check('the median line stops at the last finished post', (svg.match(/<path class="line anim" pathLength="1" d="([^"]+)"/) || [])[1].split(' L').length === 2);
  check('the sentence counts it as still running', t.includes('4 recorded so far, 1 still running.'), t.slice(0, 300));
  // too new to estimate: not drawn, but said
  const Q = mk(NOW, [1000, 1100, 1200, 1300], { ...extra, scores: {} });
  const hq = render(Q);
  check('with no estimate it is not drawn, and the fold says one is too new', ![...svgOf(hq).matchAll(/class="pt est"/g)].length && /one too new to estimate is not drawn/.test(hq));
  // the hollow dot never styles the dashes itself — the page's CSS does, by class
  check('the dashes come from CSS by class', /svg\.chart circle\.pt\.est \{ stroke-dasharray/.test(TT));
}

console.log('\na hit far above the baseline: at the top edge as ▲ with its figure, the scale kept for the rest');
{
  const P = mk(NOW, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 50000]);
  const h = render(P), svg = svgOf(h), reg = regOf(P, h), t = text(h);
  check('the axis stops at three times the highest median: 3,000, not 50,000', />3k<\/text>|>3,000<\/text>/.test(svg) && !/50k<\/text>.*class="ax"/.test(svg), svg.match(/<text class="ax"[^>]*>[^<]*<\/text>/g));
  check('the hit is a ▲ at the top, with its figure beside it', /<polygon class="clip" data-i="9"/.test(svg) && /<text class="val" [^>]*>50k<\/text>/.test(svg));
  check('and not a dot, so nine dots remain', [...svg.matchAll(/<circle class="pt"/g)].length === 9);
  check('the crosshair dot for it sits on the top edge', reg.ys[9] === 24 && reg.ys[8] > 24, reg.ys[9]);
  check('its tip is still the real figure', reg.tips[9].endsWith('50,000 views in its first 48 hours'));
  check('the note under the chart explains the ▲', /▲ a post above the top of the chart/.test(h) && /set for your baseline, not the hit/.test(h));
  check('the tiles are the median: about the same, not up 4,900%', t.includes('about the same views'), t.slice(0, 300));
  check('with the hit in view range the note is absent', !/above the top of the chart/.test(render(mk(NOW, [1000, 1200, 900, 1100, 1000, 2000, 2400, 1800, 2200, 2000]))));
  check('with no median yet, nothing is clipped', (() => {
    const Q = mk(NOW, [50000]); const hq = render(Q);
    return !/polygon class="clip"/.test(hq) && [...svgOf(hq).matchAll(/<circle class="pt"/g)].length === 1;
  })());
}

console.log('\nleft out, and said: a holed launch, an unrecorded one, an empty store');
{
  const t0 = Math.floor((NOW - 20 * D) / 1000);
  const t1 = t0 - D / 1000, t2 = t0 - 2 * D / 1000;
  const P = mk(NOW, [1000, 1100, 1200], { vids: { holed: { create_time: t0, title: 'Holed', s: launch(t0, 2000, 50, [60, 300]) },
                                                  short: { create_time: t1, title: 'Stopped early', s: launch(t1, 2000, 40) },
                                                  late: { create_time: t2, title: 'Started late', s: launch(t2, 2000, 50).filter(x => x[0] > t2 * 1000 + 30 * H) } } });
  const m = P.blModel();
  check('a launch with a four-hour hole at hour one, and one that stopped at 40h, are not references', m.skipped === 2 && !m.done.some(p => p.id === 'holed' || p.id === 'short'));
  check('but one first sampled at 30h still has its 48-hour reading, and counts — the projection’s own rule', m.done.length === 4 && m.done.some(p => p.id === 'late' && p.v === 2000), m.done.map(p => p.id + ':' + p.v).join(','));
  check('the fold says two finished posts can’t be compared', /2 finished posts can’t be compared — launched before the tracker was watching, or with a hole in the recording — and are left out\./.test(render(P)));
  const one = mk(NOW, [1000, 1100, 1200], { vids: { holed: { create_time: t0, title: 'Holed', s: launch(t0, 2000, 50, [60, 300]) } } });
  check('…singular for one', /One finished post can’t be compared .* and is left out\./.test(render(one)));
  const empty = load(NOW, { videos: {} }, [], {});
  check('no finished launch yet: a sentence, no tiles, no chart', (() => { const h = render(empty); return /fills in by itself as your tracker records whole launches/.test(h) && !/class="tile"/.test(h) && !/<svg/.test(h); })());
  const q0 = Math.floor((NOW - 5 * H) / 1000);
  const onlyNew = load(NOW, { videos: { q: { create_time: q0, title: 'New', s: launch(q0, 500, 5) } } }, [], {});
  check('only a launching post: says so, and when to look', /still inside its first 48 hours\. .*appears here in a day or two\./.test(render(onlyNew)));
  const none = load(NOW, null, [], {});
  none.renderBaseline();
  check('no recordings at all: the card is hidden', none.els.baselineCard.style.display === 'none');
  check('with recordings the card is shown', (() => { const P2 = mk(NOW, [1000]); P2.renderBaseline(); return P2.els.baselineCard.style.display === 'block'; })());
}

console.log('\nordering and naming');
{
  // keys newest-first in the store; the chart still runs oldest to newest
  const a = Math.floor((NOW - 9 * D) / 1000), b = Math.floor((NOW - 4 * D) / 1000);
  const P = load(NOW, { videos: { newer: { create_time: b, title: '', s: launch(b, 900) }, older: { create_time: a, title: 'Old one #x', s: launch(a, 300) } } }, [], {});
  const m = P.blModel();
  check('posts are sorted by upload time, whatever the store’s key order', m.posts.map(p => p.id).join(',') === 'older,newer');
  const reg = regOf(P, render(P));
  check('a post with no caption is “a post with no caption” in its tip, never empty quotes', reg.tips[1].includes('a post with no caption') && !reg.tips[1].includes('“”'), reg.tips[1]);
  check('a caption keeps its words and loses its tags', reg.tips[0].includes('“Old one”'), reg.tips[0]);
}

console.log('\nwired into the page');
{
  check('the card is in the Account room, before the breakdown', TT.indexOf('id="baselineCard"') > TT.indexOf('data-pane="account"') && TT.indexOf('id="baselineCard"') < TT.indexOf('id="breakdownCard"'));
  check('revealed at sign-in', /'tableCard', 'baselineCard', 'breakdownCard'/.test(TT));
  check('rendered on the poll chain, after the scores are built', /renderBaseline\(\); renderBreakdown\(\);/.test(TT) && TT.indexOf('buildScores();') < TT.indexOf('renderBaseline(); renderBreakdown();'));
  check('the card’s explainer says what it compares', /This compares what your <b>typical<\/b> post gets in its first 48 hours/.test(TT));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' + pass + ' passed' : pass + ' passed, 0 failed'));
process.exit(fail ? 1 : 0);
