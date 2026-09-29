/* motion.js and the Cinnamoroll theme.
   node scripts/motion.test.mjs

   motion.js counts numbers up from 0 and draws charts in. The one promise it makes is that
   this is decoration and never data: every count ends on the page's own text, byte for
   byte, and nothing it touches can be left showing a number that is not real. That rests
   on the parser below accepting ONLY strings it can reproduce exactly, so this suite pins
   the parser over the formats the pages really print, and pins the refusals — dates,
   times, ranges, two numbers in one string — that keep it away from anything else.

   It also pins the wiring: every page loads motion.js and offers the theme, the stylesheet
   gates the chart draw-in behind .cc-draw (so a poll repaint no longer redraws every line
   once a minute), and prefers-reduced-motion switches all of it off. */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const M = require('../yt-dashboard/motion.js');
const read = f => fs.readFileSync(new URL('../yt-dashboard/' + f, import.meta.url), 'utf8');
const CSS = read('style.css');
const MOTION = read('motion.js');
const PAGES = { 'index.html': read('index.html'), 'tiktok.html': read('tiktok.html'), 'compare.html': read('compare.html') };

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

/* ---------- 1. round trips over formats the pages actually print ---------- */
console.log('\ncount-up parser — accepts, and always lands on the original');
check('the helpers are exported for Node', typeof M.parseCount === 'function' && typeof M.formatCount === 'function' && typeof M.countFrame === 'function');
const GOOD = [
  '152,014', '+7', '−13', '8.6%', '0.25%', '4.2', '35,436 views', '+9,200', '1,000',
  '+1,234 today', '4,870 followers', '12.5k', '8.6% like rate', '61% there', '-5', '999',
  '1,000,000', '12 posts', '3.25', '+12', '7', '100%', '2,410 views', '+1 subs', '0.05%'
];
for (const s of GOOD) {
  const p = M.parseCount(s);
  if (!p) { check('parses ' + JSON.stringify(s), false, 'rejected'); continue; }
  check('parses and re-formats ' + JSON.stringify(s) + ' exactly', M.formatCount(p, p.value) === s, M.formatCount(p, p.value));
  check('  and its final frame IS the original', M.countFrame(p, 1) === s && M.countFrame(p, 1.5) === s);
  // every intermediate frame wears the same clothes: sign, suffix, decimals, grouping
  let ok = true, why = '', prev = -1;
  for (let i = 0; i <= 40; i++) {
    const f = M.countFrame(p, i / 40);
    const q = M.parseCount(f);
    if (!q) { ok = false; why = 'frame ' + JSON.stringify(f) + ' is not in the same format'; break; }
    if (q.sign !== p.sign || q.suffix !== p.suffix || q.decimals !== p.decimals) { ok = false; why = 'frame ' + JSON.stringify(f) + ' changed sign/suffix/decimals'; break; }
    if (q.value > p.value + 1e-9) { ok = false; why = 'frame ' + JSON.stringify(f) + ' overshoots the real value'; break; }
    if (q.value < prev - 1e-9) { ok = false; why = 'frame ' + JSON.stringify(f) + ' went backwards'; break; }
    if (q.value >= 1000 && p.grouped !== f.includes(',')) { ok = false; why = 'frame ' + JSON.stringify(f) + ' grouped differently'; break; }
    prev = q.value;
  }
  check('  and every frame from 0 keeps its format, never overshoots, never goes backwards', ok, why);
}
check('a count starts at zero', M.countFrame(M.parseCount('35,436 views'), 0) === '0 views');
check('a signed count keeps its sign from the first frame', M.countFrame(M.parseCount('+9,200'), 0) === '+0');
check('the U+2212 minus the pages print survives', M.countFrame(M.parseCount('−13'), 0.999).startsWith('−'));
check('decimals are kept on the way up', /^\d\.\d%$/.test(M.countFrame(M.parseCount('8.6%'), 0.5)));
check('a frame never rounds up past the real value', M.countFrame(M.parseCount('0.25%'), 0.9999) !== '0.26%' &&
  M.parseCount(M.countFrame(M.parseCount('0.25%'), 0.9999)).value <= 0.25);

/* ---------- 2. refusals: anything that is not ONE plain number stays untouched ---------- */
console.log('\ncount-up parser — refuses everything else');
const BAD = [
  '3 of 5', 'Beats 72%', 'Top 12%', '12 Sep', 'Sep 12', '2:14', '12:30 pm', '3h ago', '5m ago', '12m ago',
  '12–15', '1,000–2,000', '5 days', '1 day', '3 weeks', '2 hours', '2026-09-29', '12/09',
  '≈ 12 views/min', '12 views/min', '12 views/day', '~1.2k', '1.5×', '—', '–', '', '1,23', '01',
  '1.2.3', '3d 4h', '+12 −3', '1e5', 'NaN', 'Infinity', '12 ', ' 12', '12  views', '±0', '$5',
  '5m', '3h', '10d', '4 wk', 'Posted 3 Sep', '12 posts, 4 hits', '6pm', '1,000,00', 'live · 12:04:33',
  '2025', '1900', '2100'
];
for (const s of BAD) check('refuses ' + JSON.stringify(s), M.parseCount(s) === null);
check('a count that merely looks year-sized with a unit or separators still counts',
  M.parseCount('2,025') !== null && M.parseCount('2025 views') !== null && M.parseCount('2101') !== null && M.parseCount('+2025') !== null);
check('refuses non-strings', M.parseCount(null) === null && M.parseCount(12) === null && M.parseCount(undefined) === null);

/* ---------- 3. the animator's safety rules, read from the source ---------- */
console.log('\nmotion.js — safety rules');
check('does nothing at all under prefers-reduced-motion', /if \(calm\(\)\) return;/.test(MOTION) && /prefers-reduced-motion: reduce/.test(MOTION));
check('a failure while booting never reaches the page', /try \{ boot\(\); \} catch \(e\)/.test(MOTION));
check('a count stops the moment the page writes (node identity + our last write)',
  /job\.el\.firstChild === job\.tn && job\.el\.childNodes\.length === 1 && job\.tn\.data === job\.last/.test(MOTION) &&
  /if \(!intact\(job\)\) \{ endCount\(job\); continue; \}/.test(MOTION));
check('the write-back only needs OUR node attached and unchanged (a sibling badge does not block it)',
  /if \(job\.tn\.parentNode === job\.el && job\.tn\.data === job\.last && job\.tn\.data !== job\.original\) job\.tn\.data = job\.original;/.test(MOTION));
check('only a real control opens a press reset, and it is single-use',
  /const ctl = tg\.closest\(CTL_SEL\);\s*if \(!ctl\) return;/.test(MOTION) && /reset\(card, 8000, true\)/.test(MOTION) &&
  /r\.once && [^\n]*r\.until = Math\.min\(r\.until, t \+ 400\)/.test(MOTION));
check('live stat tiles count only on first sight or a forced reset',
  /if \(!o\.force && el\.matches\('\.stat-num'\) && seen\.has\(key\)\) return;/.test(MOTION));
check('the page’s own odometer clean-up is not read as a fresh number', /classList\.contains\('odo'\)\) odoDone = true/.test(MOTION));
check('nothing waits on a shrunken viewport (no negative bottom rootMargin)', /rootMargin: '0px 0px 40px 0px'/.test(MOTION) && !/rootMargin: '[^']*-/.test(MOTION));
check('an armed, never-seen unit stays armed through a repaint', /if \(waiting\.has\(el\) && el\.classList\.contains\('cc-draw'\)\)/.test(MOTION));
check('the last frame writes the original string back', /if \(k >= 1\) \{ write\(job, job\.original\); endCount\(job\); continue; \}/.test(MOTION));
check('a hidden tab finishes counts rather than freezing mid-way', /visibilitychange[\s\S]{0,80}finishAll\(\)/.test(MOTION));
check('the +N chip copies the page’s own delta text and checks its shape',
  /const txt = \(de\.textContent \|\| ''\)\.trim\(\);/.test(MOTION) && /chip\.textContent = '▲ ' \+ txt;/.test(MOTION));
check('it reads no page internals (no chartReg / videos / window globals from the pages)',
  !/chartReg|\bvideos\b|\bperVideo\b|\bprevTotals\b|\bapplyTheme\b/.test(MOTION));

/* ---------- 4. every page is wired ---------- */
console.log('\npages — motion.js and the theme');
for (const [name, src] of Object.entries(PAGES)) {
  const tag = src.indexOf('<script src="./motion.js" defer></script>');
  const inline = src.indexOf('\n<script>\n');
  check(name + ' loads motion.js, deferred', tag > 0);
  check(name + ' puts it just before the page’s inline script', tag > 0 && inline > tag && inline - tag < 60);
  check(name + ' loads stickers.js, deferred, right beside it', src.includes('<script src="./stickers.js" defer></script>\n<script src="./motion.js" defer></script>'));
  check(name + ' offers ☁️ Cinnamoroll in a Cute group (value still "cloud", so saved choices keep working)',
    /<optgroup label="Cute ☁️">\s*<option value="cloud">☁️ Cinnamoroll<\/option>\s*<\/optgroup>/.test(src));
  check(name + ' keeps every original theme', ['rose', 'sakura', 'pearl', 'mauve', 'twilight', 'berry', 'rosenight', 'dusk',
    'midnight', 'noir', 'ocean', 'blush', 'lavender', 'honey'].every(t => src.includes('<option value="' + t + '">')));
  check(name + ' loads Fredoka in its existing fonts request', /fonts\.googleapis\.com\/css2\?[^"]*family=Fredoka:wght@[^"]*&display=swap/.test(src));
}
for (const name of ['index.html', 'tiktok.html']) {
  const src = PAGES[name];
  const i0 = src.indexOf('  const CONFETTI_COLOURS'), i1 = src.indexOf('  let confRaf');
  check(name + ': confetti palette code is where the extraction expects', i0 > 0 && i1 > i0);
  const body = src.slice(i0, i1);
  const run = cssVar => new Function('getComputedStyle', 'document', body + '\nreturn [confettiColours(), CONFETTI_COLOURS];')(
    () => ({ getPropertyValue: () => cssVar }), { body: {} });
  const [plain, classic] = run('');
  check(name + ': a theme without --confetti keeps the classic colours exactly', plain === classic && classic.length === 7);
  const [cloud] = run(' #ffb3cf, #9fd3ff, #ffffff');
  check(name + ': --confetti is read as a comma list', cloud.join('|') === '#ffb3cf|#9fd3ff|#ffffff');
  check(name + ': the confetti uses that palette', /const pal = confettiColours\(\);/.test(src) && /c: pal\[i % pal\.length\]/.test(src));
}

/* ---------- 5. the stylesheet ---------- */
console.log('\nstyle.css — gating and reduced motion');
// innermost { … } blocks with their selectors — enough to reason about rules
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
// rules that RUN an animation (an `animation:none` switch-off is not one)
const runs = r => /animation\s*:(?!\s*none)/.test(r.body);
const animated = sel => rules.filter(r => r.sel.includes(sel) && runs(r));
const gated = (sel, gate) => animated(sel).length > 0 && animated(sel).every(r =>
  r.sel.split(',').filter(s => s.includes(sel)).every(s => s.includes(gate)));
check('path.line.anim draws only under .cc-draw', gated('path.line.anim', '.cc-draw'), animated('path.line.anim').map(r => r.sel).join(' | '));
check('and the old always-on rule is gone', !/svg\.chart path\.line\.anim \{ stroke-dasharray:1; stroke-dashoffset:1; animation/.test(CSS));
check('the end dot pops only under .cc-draw', gated('.end-dot', '.cc-draw'));
check('the area wipe runs only under .cc-draw', gated('rect.wipe', '.cc-draw'));
check('a finished line keeps no dasharray (dash values live in the keyframes)',
  /@keyframes drawLine \{ from \{ stroke-dasharray:var\(--cc-len, 1\); stroke-dashoffset:var\(--cc-len, 1\); \}/.test(CSS));
check('draw-ins end on the element’s own styles (fill-mode backwards, never forwards/both)',
  rules.filter(r => /\.cc-draw/.test(r.sel) && runs(r)).every(r => /backwards/.test(r.body) && !/\b(forwards|both)\b/.test(r.body)));
check('still-to-scroll charts are held, not hidden', /\.cc-draw\.cc-wait, \.cc-draw\.cc-wait \* \{ animation-play-state:paused !important; \}/.test(CSS));
check('the glider only takes over the selected pill once placed (.cc-glide)',
  /\.tabs\.cc-glide button\[aria-selected="true"\] \{ background:transparent;/.test(CSS) &&
  /\.tabs button\[aria-selected="true"\] \{ background:var\(--accent\); color:var\(--ink\); \}/.test(CSS));
// every @media (prefers-reduced-motion:reduce) block, brace-matched
const rmBlocks = [];
for (const m of CSS.matchAll(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{/g)) {
  let d = 1, i = m.index + m[0].length;
  while (d && i < CSS.length) { if (CSS[i] === '{') d++; else if (CSS[i] === '}') d--; i++; }
  rmBlocks.push(CSS.slice(m.index, i));
}
const RM = rmBlocks.join('\n');
for (const s of ['.cc-draw', '.cc-draw *', '.cc-roomin', '.cc-glider', '.cc-chip', '.cc-glow', '.cc-sparks', '.cc-win.cc-win-go',
                 'body.cc-intro header', 'body[data-theme="cloud"]::before']) {
  check('reduced motion switches off ' + s, RM.includes(s));
}
check('reduced motion still pins every line fully drawn', /svg\.chart path\.line \{ stroke-dashoffset:0 !important; animation:none !important; \}/.test(RM));
check('printing never catches a chart mid-draw', /@media print \{ \.cc-draw, \.cc-draw \* \{ animation:none !important; \} \}/.test(CSS));

/* ---------- 6. the Cinnamoroll palette ---------- */
console.log('\nCinnamoroll — tokens and contrast');
const block = (CSS.match(/body\[data-theme="cloud"\] \{([^}]*)\}/) || [])[1] || '';
const tok = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
for (const k of ['ink', 'panel', 'panel-2', 'line', 'text', 'muted', 'live', 'up', 'down', 'accent', 'purple', 'gold'])
  check('defines --' + k, /^#[0-9a-f]{6}$/i.test(tok[k] || ''), tok[k]);
const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const need = (a, b, min, what) => { const r = ratio(tok[a], tok[b]); check(what + ' ' + r.toFixed(2) + ':1 ≥ ' + min, r >= min); };
need('text', 'panel', 7, '--text on --panel');
need('text', 'ink', 7, '--text on --ink');
need('muted', 'panel', 4.5, '--muted on --panel');
need('muted', 'ink', 4.5, '--muted on --ink');
need('up', 'panel', 4.5, '--up on --panel');
need('down', 'panel', 4.5, '--down on --panel');
need('ink', 'accent', 3, 'a selected tab (--ink on --accent)');
check('confetti gets a pastel list', /--confetti:\s*#[0-9a-f]{6}(,\s*#[0-9a-f]{6}){3,}/i.test(block));
check('headings and numbers get the rounded face', /--f-num:'Fredoka','Sora',system-ui,sans-serif/.test(block));
check('it joins the light themes’ soft error banner', /body\[data-theme="cloud"\] \.error \{/.test(CSS));
check('the floating thumbnails give way to the clouds', /body\[data-theme="cloud"\] #bgBalls \{ display:none; \}/.test(CSS));
check('the clouds are one drifting layer under the page that never catches a tap',
  /body\[data-theme="cloud"\]::before \{[^}]*position:fixed;[^}]*z-index:0; pointer-events:none;[^}]*animation:ccDrift/.test(CSS) &&
  /\.wrap \{[^}]*z-index:1;/.test(CSS));
check('decorative glyphs carry empty alt text', (CSS.match(/content:"[^"]*" \/ "";/g) || []).length >= 3);
// The character is named now (the owner asked for Cinnamoroll by name), but still never
// drawn: the stylesheet and motion.js carry no picture of it, and the only places the name
// appears in the pages are the theme's label and the sticker comments/credit.
check('no character art in the stylesheet or motion.js (no embedded images beyond the clouds and stars)',
  (CSS.match(/url\("data:image\/svg\+xml/g) || []).length === 2 && !/data:image\/(?:png|webp|gif|jpeg)/.test(CSS + MOTION));
check('motion.js stays about motion (no character names in it)', !/cinnamoroll|sanrio/i.test(MOTION));
check('the palette follows the character: blush-pink live, baby-blue accent, cinnamon-brown text',
  lum(tok.live) < lum(tok.blush) && parseInt(tok.accent.slice(5, 7), 16) > parseInt(tok.accent.slice(1, 3), 16) &&
  parseInt(tok.text.slice(1, 3), 16) > parseInt(tok.text.slice(5, 7), 16));
check('motion.js tells other decoration when a total rises and a chart has drawn',
  /signal\('cc:increase', tile\)/.test(MOTION) && /signal\('cc:drawn', el, \{ epoch: ep \}\)/.test(MOTION));

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
