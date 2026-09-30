// "While you were away" and the live strip, redesigned — run against the page's own code.
//
// The card now leads with the absence as big numbers and keeps everything it showed before:
//
//   · the big numbers are the headline sentence's own figures — the same views, followers and
//     milestones, left out exactly when the sentence leaves them out — and the sentence stays
//     underneath with its basis ("on your 20 newest posts");
//   · the busiest hour and yesterday share one short paragraph, the hour said as the clock
//     read it ("Wed 9–10 pm"), daylight-saving days included;
//   · milestones passed since you last looked come first, with a dot and a NEW badge; the
//     older ones fold under "Earlier this fortnight · N more", still dimmed — every one of
//     them is still in the card, one tap away, and an open fold survives the next poll;
//   · a post is named by its caption without the hashtags, cut at a whole word, with the
//     full caption in the row's title and aria-label, and it still opens its breakdown;
//   · the explanation sits behind "ⓘ How this works", word for word;
//   · the velocity strip is "Live · this visit", under the away card, its old heading kept
//     as the caption under the bars.
//
// Melbourne time throughout, set before anything reads a clock.
//
// Run: node scripts/tt-away.test.mjs
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
const plain = s => String(s).replace(/ /g, ' ');
const strip = s => plain(s).replace(/<[^>]+>/g, '');

/* The page's code. esc() here does what the page's does — the DOM's textContent→innerHTML,
   which escapes & < > and leaves quotes alone — because escAttr's job is the quotes. */
const SRC = `
  const RealDate = globalThis.Date;
  class Date extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
  const fmt = new Intl.NumberFormat('en-AU');
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const ttdOpen = (id, el) => opened.push(id);
  ${line('  const capOf = ')}
  ${cut('  const clip = (s, n) =>', '\n  const escAttr = ')}
  ${line('  const escAttr = ')}
  ${arrow('  const fmtAgo = ts =>')}
  ${line('  const fseries = () =>')}${line('  const fAtOrBefore = ')}${line('  const ATB = ')}${line('  const ordinal = ')}
  ${fnOf('nextMilestone')}
  ${line('  const ACCEL_MIN = ')}${line('  const ACCEL_RATIO = ')}${line('  const ALERT_DAYS = ')}
  ${line('  const TT_GAP = ')}
  ${fnOf('ttGainBuckets')}
  ${fnOf('ttAlerts')}
  ${line('  const AWAY_MIN = ')}
  ${fnOf('ttAwayLen')}
  ${fnOf('ttAwayHeadHtml')}
  ${arrow('  const hourSpan = at =>')}
  ${fnOf('ttMomentsHtml')}
  ${line('  let alertsHtml = ')}
  ${fnOf('renderAlerts')}
  ${fnOf('recDayGains')}
  return { renderAlerts, ttAlerts, ttAwayHeadHtml, ttMomentsHtml, hourSpan, noTags, feedCap, escAttr, esc };`;

/* A little DOM: #alertsContent keeps its HTML and counts paints; each paint makes a fresh
   #awayOlder (closed unless the markup says open), as a real innerHTML would. */
function make({ hist, videos = [], me = {}, awaySince = null, awayUntil = null, NOW, accel = [] }) {
  const dom = { paints: 0, fold: null, opened: [], els: {} };
  const content = {
    dataset: {}, on: {}, addEventListener(t, f) { this.on[t] = f; }, _h: '',
    get innerHTML() { return this._h; },
    set innerHTML(v) { this._h = v; dom.paints++; dom.fold = /id="awayOlder"/.test(v) ? { open: /id="awayOlder"[^>]*\sopen[\s>]/.test(v) } : null; }
  };
  dom.content = content;
  const $ = id => id === 'alertsContent' ? content : id === 'awayOlder' ? dom.fold : (dom.els[id] || (dom.els[id] = { textContent: '' }));
  const api = new Function('hist', 'videos', 'me', 'awaySince', 'awayUntil', 'NOW', '$', 'opened', 'accelSet', SRC)(
    hist, videos, me, awaySince, awayUntil, NOW, $, dom.opened, new Set(accel));
  return Object.assign(dom, api);
}

// one post's recording: every 30 minutes from `from` to NOW, `perHour` views an hour, and
// exactly `mile` views at `crossAt` — so the milestone is crossed at that reading
const series = (from, NOW, mile, crossAt, perHour) => {
  const s = [];
  for (let t = from; t <= NOW; t += 30 * MIN) s.push([t, Math.floor(mile + (t - crossAt) / H * perHour), 0, 0, 0]);
  return s;
};

const NOW = at(2026, 9, 30, 12);           // Wed 30 Sept, noon
const START = NOW - 16 * D;
const CAPS = {
  a: 'Rain on a tin roof for sleep #sleep #rain',
  b: 'Crinkly "paper" <sounds> & more #asmr #crinkle',
  c: 'Whispered makeup routine #asmr #whisper',
  d: '#asmr #tingles',
  e: 'Brushing the mic, no talking #asmr #tingles #nottalking'
};
const rec = (id, mile, crossAt, perHour) => ({ create_time: Math.floor((START - 2 * D) / 1000), title: CAPS[id], cover: 'cover-' + id,
  s: series(START, NOW, mile, crossAt, perHour) });
const hist = {
  videos: {
    a: rec('a', 1000, NOW - 10 * H, 1),        // new since a 19-hour absence
    b: rec('b', 2500, NOW - 5 * D, 1),
    c: rec('c', 1000, NOW - 8 * D, 1),
    d: rec('d', 5000, NOW - 3 * D, 2),
    e: rec('e', 25000, NOW - 11 * D, 1),       // no longer in TikTok's list
    // busy, and between rungs the whole time (100,500 → 115,860): an hour to call busiest
    f: { create_time: Math.floor((START - 2 * D) / 1000), title: 'Ocean waves at night #sleep', cover: 'cover-f', s: series(START, NOW, 100500, START, 40) }
  },
  followers: [[NOW - 20 * D, 240, 49000, 1], [NOW - 12 * D, 248, 49900, 1], [NOW - 11 * D, 252, 50100, 1],
              [NOW - 20 * H, 260, 50500, 1], [NOW - 2 * H, 263, 50600, 1]]
};
const live = ['a', 'b', 'c', 'd', 'f'].map(id => ({ id, title: CAPS[id], cover_image_url: 'live-' + id }));
const me = { follower_count: 267 };
const AWAY = NOW - 19 * H;

console.log('\na post\'s name without its hashtags');
{
  const { noTags, feedCap } = make({ hist, NOW });
  const eq = (inp, want, n = 40) => { const got = feedCap(inp, n, 'a post'); check(JSON.stringify(inp) + ' → ' + JSON.stringify(want), got === want, JSON.stringify(got)); };
  eq('Rain on a tin roof for sleep #sleep #rain', 'Rain on a tin roof for sleep');
  eq('Thunderstorm ambience 😴 #sleep #rain', 'Thunderstorm ambience 😴');
  eq('#fyp #asmr Morning tapping', 'Morning tapping');
  eq('Best of #asmr, #tapping', 'Best of');
  // a tag inside a sentence is a word of it: it keeps the word and loses the '#'
  eq('My #morning routine, slowly', 'My morning routine, slowly');
  eq('My #1 fan', 'My #1 fan');                        // "#1" is not a hashtag
  // nothing left: the full caption, not an empty name
  eq('#asmr #tingles', '#asmr #tingles');
  eq('', 'a post');
  eq('(no caption)', 'a post');
  const long = feedCap('Tapping on every single glass jar in my kitchen cupboard tonight #asmr', 40);
  check('a long name is cut at a whole word, with "…"', long === 'Tapping on every single glass jar in my…', long);
  check('and never keeps a hashtag the caption had after words',
    Object.values(CAPS).filter(c => c !== '#asmr #tingles').every(c => !/#/.test(noTags(c))),
    Object.values(CAPS).map(noTags).join(' | '));
}

console.log('\nquotes in a caption cannot break out of an attribute');
{
  const { escAttr } = make({ hist, NOW });
  check('escAttr escapes " as well as & < >', escAttr('a "b" <c> & d') === 'a &quot;b&quot; &lt;c&gt; &amp; d', escAttr('a "b" <c> & d'));
}

console.log('\nthe busiest hour, as the clock read it');
{
  const { hourSpan } = make({ hist, NOW });
  const eq = (t, want, now) => {
    const h = now ? make({ hist, NOW: now }).hourSpan : hourSpan;
    const got = h(t);
    check(new Date(t).toString().slice(0, 21) + ' → ' + want, plain(got) === want && !/ /.test(got), JSON.stringify(got));
  };
  eq(at(2026, 9, 30, 9), 'Wed 9–10 am');
  eq(at(2026, 9, 29, 21), 'Tue 9–10 pm');
  eq(at(2026, 9, 30, 11), 'Wed 11 am–12 pm');
  eq(at(2026, 9, 29, 23), 'Tue 11 pm–12 am');
  eq(at(2026, 9, 30, 0), 'Wed 12–1 am');
  // daylight saving starts Sun 4 Oct 2026: 2 am never happens, so the 1 am hour ends at 3
  eq(at(2026, 10, 4, 1), 'Sun 1–3 am', at(2026, 10, 4, 12));
  // and ends Sun 5 Apr 2026: 2 am happens twice, and each of those hours reads 2–3 am
  const first2 = at(2026, 4, 5, 2);
  eq(first2, 'Sun 2–3 am', at(2026, 4, 5, 12));
  eq(first2 + H, 'Sun 2–3 am', at(2026, 4, 5, 12));
  check('(those really are two different hours)', new Date(first2).getHours() === 2 && new Date(first2 + H).getHours() === 2);
  // more than six days back a weekday alone would repeat, so the date comes too
  eq(at(2026, 9, 22, 21), 'Tue 22 Sept, 9–10 pm');
}

console.log('\nthe big numbers are the sentence\'s numbers');
{
  const x = make({ hist, videos: live, me, awaySince: AWAY, awayUntil: NOW, NOW });
  const list = x.ttAlerts();
  const head = x.ttAwayHeadHtml(list);
  const nums = [...head.matchAll(/<b class="v( up| down)?" data-count>([^<]+)<\/b><span class="k">([^<]+)<\/span>/g)].map(m => [m[2], m[3], (m[1] || '').trim()]);
  const sentence = strip((head.match(/<p class="explain awayhead">[\s\S]*?<\/p>/) || [''])[0]);
  const sv = (sentence.match(/\+([\d,]+) views on your/) || [])[1];
  const fresh = list.filter(a => a.at >= AWAY).length;
  check('three big numbers: views, followers, milestones', nums.map(n => n[1]).join(',') === 'views,followers,milestone', JSON.stringify(nums));
  check('views: the same figure as the sentence', nums[0] && nums[0][0] === '+' + sv && nums[0][2] === 'up', nums[0] + ' vs ' + sentence);
  check('followers: the live count less the snapshot she left on (267 − 260)', nums[1] && nums[1][0] === '+7' && /\+7 followers/.test(sentence), JSON.stringify(nums[1]));
  check('milestones: the feed\'s NEW lines, as the sentence counts them', fresh === 1 && nums[2] && nums[2][0] === '1' && /1 milestone passed/.test(sentence), fresh + ' / ' + JSON.stringify(nums[2]));
  check('the numbers are for the eye; the sentence under them reads them out, once',
    /<div class="away-nums" aria-hidden="true">/.test(head));
  check('the sentence stays underneath, with its basis', head.indexOf('away-nums') < head.indexOf('awayhead') &&
    /^In the 19h since you last looked: \+[\d,]+ views on your posts · \+7 followers · 1 milestone passed\.$/.test(sentence), sentence);
  check('every big number is one motion.js counts up', nums.length === (head.match(/data-count/g) || []).length &&
    /\[data-count\]/.test(fs.readFileSync(new URL('../yt-dashboard/motion.js', import.meta.url), 'utf8')));
  // a loss shows as one
  const drop = make({ hist, videos: live, me: { follower_count: 257 }, awaySince: AWAY, awayUntil: NOW, NOW }).ttAwayHeadHtml(list);
  check('a follower loss is a big "−3", in the loss colour', /<b class="v down" data-count>−3<\/b><span class="k">followers<\/span>/.test(drop) && /−3 followers/.test(strip(drop)), drop);
  // no snapshot near her leaving: no follower number anywhere
  const far = { ...hist, followers: [[NOW - 30 * H, 255, 1, 1], [NOW - 2 * H, 263, 1, 1]] };
  const nof = make({ hist: far, videos: live, me, awaySince: AWAY, awayUntil: NOW, NOW }).ttAwayHeadHtml(list);
  check('no follower figure the sentence would not give', !/follower/.test(nof), nof);
  // nothing new: no milestone number, as the sentence has none
  const none = x.ttAwayHeadHtml(list.filter(a => a.at < AWAY));
  check('no milestone number when nothing was passed', !/milestone/.test(none) && /<span class="k">views<\/span>/.test(none), none);
  check('a short absence has no headline at all', make({ hist, videos: live, me, awaySince: NOW - 20 * MIN, awayUntil: NOW, NOW }).ttAwayHeadHtml(list) === '');
}

console.log('\nthe card');
{
  const x = make({ hist, videos: live, me, awaySince: AWAY, awayUntil: NOW, NOW, accel: ['a'] });
  const list = x.ttAlerts();
  x.renderAlerts();
  const html = x.content.innerHTML;
  check('the label carries the absence: "While you were away · 19 hours"', x.els.awayFor.textContent === ' · 19 hours', x.els.awayFor.textContent);
  const pos = ['class="away-nums"', 'class="explain awayhead"', 'class="away-moments"', 'class="chip chipv"', 'class="alert open fresh"', 'id="awayOlder"'].map(k => html.indexOf(k));
  check('in order: numbers, sentence, busiest hour and yesterday, speeding up, new, the fold', pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), pos.join(' < '));
  // the moments share one paragraph
  const mom = (html.match(/<p class="away-moments">([\s\S]*?)<\/p>/) || [])[1] || '';
  check('the busiest hour and yesterday are one paragraph', /^<span class="amom">Busiest hour since you last looked: <b>\+[\d,]+ views<\/b>, [A-Z][a-z]{2} \d+/.test(mom) &&
    /<span class="amom">Yesterday: <b>\+[\d,]+ views<\/b> — /.test(mom), strip(mom));
  check('the post that carried the hour is named without hashtags, full caption as its title',
    /, mostly “<span title="Ocean waves at night #sleep">Ocean waves at night<\/span>”<\/span>/.test(mom), mom);
  // new first, with dot and badge
  const freshRows = [...html.matchAll(/<div class="alert[^"]* fresh"[\s\S]*?<\/div><\/div>/g)].map(m => m[0]);
  check('the new milestone comes first, with a dot, a NEW badge and a sparkle', freshRows.length === 1 &&
    /<span class="dot" title="New since you last looked"><\/span>/.test(freshRows[0]) && /<span class="anew">NEW<\/span>/.test(freshRows[0]) &&
    /<span class="cc-win"><b>Rain on a tin roof for sleep<\/b> passed 1,000 views<\/span>/.test(freshRows[0]), freshRows[0]);
  // the older ones, folded
  const fold = (html.match(/<details class="cc-more" id="awayOlder"><summary>([^<]*)<\/summary><div class="cc-more-body">([\s\S]*)<\/div><\/details>/) || []);
  const older = list.filter(a => a.at < AWAY);
  check('older milestones fold under "Earlier this fortnight · N more"', fold[1] === 'Earlier this fortnight · ' + older.length + ' more', fold[1]);
  check('and stay dimmed in there', (fold[2] || '').split('class="alert').length - 1 === older.length &&
    !/ fresh"/.test(fold[2] || '') && ((fold[2] || '').match(/ seen"/g) || []).length === older.length);
  check('the fold is the card\'s kind: a native <details class="cc-more">', /details\.cc-more > summary \{/.test(fs.readFileSync(new URL('../yt-dashboard/style.css', import.meta.url), 'utf8')));
  // nothing lost: every feed line is still in the card, once
  const all = list.map(a => strip(a.t));
  check('every milestone in the feed is still in the card, exactly once', list.length >= 5 &&
    all.every(t => strip(html).split(t).length - 1 === 1), all.join(' | '));
  // names, titles, aria-labels
  const rowOf = id => (html.match(new RegExp('<div class="alert[^"]*"[^>]*title="[^"]*"[^>]*' + (id ? 'data-vid="' + id + '"' : '') + '[^>]*>')) || [''])[0];
  const b = (html.match(/<div class="alert[^"]*" role="button" tabindex="0" data-vid="b"[^>]*>/) || [''])[0];
  check('a post row names the post without hashtags', /<b>Crinkly "paper" &lt;sounds&gt; &amp; more<\/b> passed 2,500 views/.test(html), strip(html).slice(0, 300));
  check('its title is the full caption, quotes and all, safely escaped',
    b.includes(' title="Crinkly &quot;paper&quot; &lt;sounds&gt; &amp; more #asmr #crinkle"'), b);
  check('its aria-label is the full caption and the whole line',
    b.includes(' aria-label="Crinkly &quot;paper&quot; &lt;sounds&gt; &amp; more #asmr #crinkle passed 2,500 views, 5d ago"'), b);
  const a = (html.match(/<div class="alert open fresh" role="button" tabindex="0" data-vid="a"[^>]*>/) || [''])[0];
  check('a new row says so in its aria-label', / aria-label="Rain on a tin roof for sleep #sleep #rain passed 1,000 views, 10h ago, new since you last looked"/.test(a), a);
  const d = (html.match(/<div class="alert[^"]*" role="button" tabindex="0" data-vid="d"[^>]*>/) || [''])[0];
  check('an all-hashtag caption keeps its name', /<b>#asmr #tingles<\/b> passed 5,000 views/.test(html) && d.includes('title="#asmr #tingles"'), d);
  const e = (html.match(/<div class="alert seen" role="group"[^>]*>/) || [''])[0];
  check('a post no longer in the list is not a button, but still carries its caption',
    e.includes('title="Brushing the mic, no talking #asmr #tingles #nottalking"') && !/data-vid="e"/.test(html) && /<b>Brushing the mic, no talking<\/b>/.test(html), e);
  check('account lines carry no post caption', /<div class="alert seen"><div class="txt">Your account passed <b>50,000 likes<\/b>/.test(html) || /<div class="alert seen"><div class="txt">You passed <b>250 followers<\/b>/.test(html), strip(html));
  check('covers still show', /<img class="acover" alt="" loading="lazy" src="cover-a">/.test(html));
  check('the speeding-up chip names the post without hashtags, full caption as its title',
    /<button type="button" class="chip chipv" data-vid="a" title="Rain on a tin roof for sleep #sleep #rain"><img alt="" loading="lazy" src="live-a">Rain on a tin roof for sleep<\/button>/.test(html), (html.match(/<button[^]*?<\/button>/) || [''])[0]);
  // tap and keyboard still open the breakdown
  const target = vid => ({ closest: () => ({ dataset: { vid } }) });
  x.content.on.click({ target: target('b') });
  let prevented = false;
  x.content.on.keydown({ key: 'Enter', target: target('a'), preventDefault() { prevented = true; } });
  check('a tap or Enter on a row opens its full breakdown', x.opened.join(',') === 'b,a' && prevented, x.opened.join(','));
}

console.log('\nthe fold survives the poll');
{
  const x = make({ hist, videos: live, me, awaySince: AWAY, awayUntil: NOW, NOW });
  x.renderAlerts();
  const p0 = x.paints;
  x.fold.open = true;
  x.renderAlerts();
  check('a poll that changes nothing leaves the card alone (fold still open)', x.paints === p0 && x.fold.open === true, x.paints + ' paints');
  // something changes: the feed gets a new line — the card repaints and the fold reopens
  hist.videos.c.title = 'Whispered makeup routine, part two #asmr';
  x.renderAlerts();
  check('a real change repaints, and the open fold is reopened', x.paints === p0 + 1 && x.fold && x.fold.open === true, x.paints + ' paints, open ' + (x.fold && x.fold.open));
  hist.videos.c.title = CAPS.c;
  x.fold.open = false;
  x.renderAlerts();
  check('a closed fold stays closed', x.fold && x.fold.open === false);
}

console.log('\nwithout a stamp, and with nothing new');
{
  const x = make({ hist, videos: live, me, awaySince: null, NOW });
  const list = x.ttAlerts();
  x.renderAlerts();
  const html = x.content.innerHTML;
  const shown = html.slice(0, html.indexOf('id="awayOlder"'));
  check('no stamp: nothing is called new or dimmed', !/ fresh"| seen"|class="dot"|class="anew"/.test(html));
  check('the three newest show, the rest fold', (shown.match(/class="alert/g) || []).length === 3 &&
    new RegExp('<summary>Earlier this fortnight · ' + (list.length - 3) + ' more</summary>').test(html), strip(html));
  check('no absence in the label', x.els.awayFor.textContent === '');
  check('and the busiest hour says its window', /Busiest hour in the last 24 hours: /.test(html));

  const q = make({ hist, videos: live, me, awaySince: NOW - 5 * H, awayUntil: NOW, NOW });
  q.renderAlerts();
  const qh = q.content.innerHTML;
  check('nothing new since she looked: it says so, and everything is in the fold',
    /<p class="dnote away-quiet">No new milestones since you last looked\.<\/p>/.test(qh) &&
    new RegExp('<summary>Earlier this fortnight · ' + q.ttAlerts().length + ' milestones</summary>').test(qh) &&
    qh.indexOf('away-quiet') < qh.indexOf('id="awayOlder"'), strip(qh));
  check('the label says "5 hours"', q.els.awayFor.textContent === ' · 5 hours', q.els.awayFor.textContent);
  const one = make({ hist, videos: live, me, awaySince: NOW - 70 * MIN, awayUntil: NOW, NOW });
  one.renderAlerts();
  check('"1 hour", not "1 hours"', one.els.awayFor.textContent === ' · 1 hour', one.els.awayFor.textContent);
  const mins = make({ hist, videos: live, me, awaySince: NOW - 45 * MIN, awayUntil: NOW, NOW });
  mins.renderAlerts();
  check('and minutes in words', mins.els.awayFor.textContent === ' · 45 minutes', mins.els.awayFor.textContent);

  const empty = make({ hist: { videos: {}, followers: [] }, videos: [], me, awaySince: AWAY, awayUntil: NOW, NOW });
  empty.renderAlerts();
  check('an empty fortnight still says so', /No milestones passed in the last 14 days\. This updates by itself, even while the page is closed\./.test(empty.content.innerHTML));
}

console.log('\nthe markup');
{
  const pane = cut('data-pane="now"', 'data-pane="posts"');
  const ix = k => pane.indexOf('id="' + k + '"');
  check('the live strip sits under the away card, above the latest post', ix('alertsCard') > 0 && ix('alertsCard') < ix('velocityPanel') && ix('velocityPanel') < ix('latestCard'),
    ['alertsCard', 'velocityPanel', 'latestCard'].map(ix).join(' < '));
  const vel = cut('<div class="card velocity" id="velocityPanel">', '\n  </div>\n');
  check('its heading is plain: "Live · this visit"', /<div class="label">Live · this visit<\/div>/.test(vel) && !/Views gained each refresh/.test(TT));
  check('and what a bar is stays said, under the bars', /Each bar is the views gained in one refresh\. <span id="barsNote"><\/span>/.test(vel));
  check('every part of it is still there', ['rateText', 'bars', 'barsNote', 'sessionText'].every(k => vel.includes('id="' + k + '"')));
  const card = cut('<div class="card" id="alertsCard"', '\n  </div>\n\n');
  check('the absence goes in the label', /While you were away<span id="awayFor"><\/span><\/div>/.test(card));
  const how = (card.match(/<details class="cc-more away-how" id="awayHow">[\s\S]*?<\/details>/) || [''])[0];
  check('the explanation is behind "ⓘ How this works", word for word',
    /<summary><span aria-hidden="true">ⓘ<\/span> How this works<\/summary>/.test(how) &&
    how.includes('Milestones your account and posts passed in the last 14 days, and any post that is speeding up — tracked even while this page was closed. <b>Tap any post to open its full breakdown.</b>'));
  check('and nowhere else', TT.split('Milestones your account and posts passed in the last 14 days').length === 2);
  check('the NEW badge has a style', /#alertsContent \.alert \.anew \{/.test(TT));
  check('seen rows still dim', /#alertsContent \.alert\.seen \{ opacity:\.55; \}/.test(TT));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' + pass + ' passed' : pass + ' passed'));
process.exit(fail ? 1 : 0);
