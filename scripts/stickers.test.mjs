/* stickers.js — the Cinnamoroll theme's stickers.
   node scripts/stickers.test.mjs

   Three promises are pinned here. (1) The rules for what can be a sticker — a strict GIPHY
   id, an image data: URL under 1.5 MB, 24 of them, about 3 MB in all — and the same rules
   the Worker enforces. (2) Nothing depends on GIPHY answering: this sandbox cannot reach it,
   so the browser half is run against a tiny fake DOM whose images FAIL to load, and every
   sticker must be quietly left out while the page's own text stays byte-for-byte the same.
   (3) No Sanrio artwork lives in the repo: real pictures only ever come from GIPHY's CDN
   (credited) or from what you upload. */
import fs from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const S = require('../yt-dashboard/stickers.js');
const ROOT = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(ROOT + f, 'utf8');
const SRC = read('yt-dashboard/stickers.js');
const CSS = read('yt-dashboard/style.css');
const WORKER = read('worker/worker.js');
const PAGES = Object.fromEntries(['index.html', 'tiktok.html', 'compare.html'].map(n => [n, read('yt-dashboard/' + n)]));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

/* ---------- 1. GIPHY links ---------- */
console.log('\nGIPHY links → a media id, strictly');
const ID = 'JQAxGWgPNy5uCzFkHU';
const LINKS = [
  'https://giphy.com/stickers/sanrio-cinnamoroll-' + ID,
  'https://giphy.com/gifs/sanrio-cinnamoroll-' + ID + '?utm_source=share',
  'https://giphy.com/gifs/' + ID,
  'https://giphy.com/clips/some-clip-' + ID,
  'https://giphy.com/embed/' + ID,
  'https://media.giphy.com/media/' + ID + '/giphy.gif',
  'https://media4.giphy.com/media/' + ID + '/200.webp',
  'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExbnRz/' + ID + '/giphy.webp',
  'https://i.giphy.com/' + ID + '.webp',
  'giphy.com/stickers/happy-' + ID,
  '  https://GIPHY.com/stickers/x-' + ID + '  '
];
for (const u of LINKS) check('reads ' + JSON.stringify(u.trim()), S.giphyId(u) === ID, S.giphyId(u));
const NOT = [
  '', '   ', null, 12, ID,                              // a bare id is not a link
  'https://evil.example/media/' + ID + '/giphy.gif',   // another host
  'https://giphy.com.evil.example/gifs/x-' + ID,
  'https://evilgiphy.com/gifs/x-' + ID,
  'https://user:pw@giphy.com/gifs/x-' + ID,
  'https://giphy.com:8443/gifs/x-' + ID,
  'javascript:alert(1)//giphy.com/gifs/x-' + ID,
  'data:text/html,giphy.com/gifs/x-' + ID,
  'https://giphy.com/gifs/x-abc',                    // too short
  'https://giphy.com/gifs/x-' + 'a'.repeat(41),      // too long
  'https://media.giphy.com/media/' + ID + '%2F..%2F/giphy.gif',
  'https://giphy.com/search/cinnamoroll',
  'https://giphy.com/sanrio'
];
for (const u of NOT) check('refuses ' + JSON.stringify(u), S.giphyId(u) === null, S.giphyId(u));
check('the id pattern is exactly [A-Za-z0-9]{8,40}', S.ID_RE.source === '^[A-Za-z0-9]{8,40}$');
check('the Worker uses the same pattern', WORKER.includes('const STICKER_GIPHY = /^[A-Za-z0-9]{8,40}$/;'));
const [webp, gif] = S.giphyUrls(ID);
check('media URL is WebP first, GIF second, both on media.giphy.com',
  webp === 'https://media.giphy.com/media/' + ID + '/giphy.webp' && gif === 'https://media.giphy.com/media/' + ID + '/giphy.gif');

/* ---------- 2. uploads ---------- */
console.log('\nuploads — shrink, check, keep');
check('a 4000×3000 photo is drawn at 320×240', JSON.stringify(S.fitSize(4000, 3000)) === '{"w":320,"h":240}');
check('a tall one keeps its shape', JSON.stringify(S.fitSize(600, 1800)) === '{"w":107,"h":320}');
check('a small one is never enlarged', JSON.stringify(S.fitSize(120, 80)) === '{"w":120,"h":80}');
check('nonsense sizes are refused', S.fitSize(0, 10) === null && S.fitSize(NaN, 5) === null && S.fitSize(Infinity, 4) === null);
check('base64 size is measured, padding and all', S.dataUrlBytes('data:image/png;base64,AAAA') === 3 &&
  S.dataUrlBytes('data:image/png;base64,AAA=') === 2 && S.dataUrlBytes('data:image/png;base64,AA==') === 1);
const b64 = n => 'A'.repeat(Math.ceil(n / 3) * 4);
for (const t of ['webp', 'png', 'jpeg', 'gif']) check('accepts a ' + t + ' upload', S.checkUpload('data:image/' + t + ';base64,' + b64(3000)).ok);
check('accepts exactly 1.5 MB', S.checkUpload('data:image/webp;base64,' + b64(1.5 * 1024 * 1024)).ok);
const big = S.checkUpload('data:image/png;base64,' + b64(1.5 * 1024 * 1024 + 3));
check('refuses over 1.5 MB, and says so in plain words', !big.ok && /1\.5 MB/.test(big.why), big.why);
for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,rawtext', 'https://x.example/a.png',
                   'data:image/png;base64,AAAA"><script>', 'data:text/html;base64,AAAA', '', null])
  check('refuses ' + JSON.stringify(bad).slice(0, 44), !S.checkUpload(bad).ok);
check('the page encodes WebP at 0.85, falling back to PNG', /toDataURL\('image\/webp', 0\.85\)/.test(SRC) && /toDataURL\('image\/png'\)/.test(SRC));
check('it resizes with a canvas to 320px and keeps transparency (clears, never fills)',
  /fitSize\(im\.naturalWidth \|\| im\.width, im\.naturalHeight \|\| im\.height, MAX_SIDE\)/.test(SRC) &&
  /clearRect\(0, 0, sz\.w, sz\.h\)/.test(SRC) && !/fillRect/.test(SRC) && S.MAX_SIDE === 320);
check('the file picker takes images, several at once', /accept="image\/\*" multiple/.test(SRC));

/* ---------- 3. the list ---------- */
console.log('\nthe list — 24 stickers, about 3 MB');
const g = (i, src) => ({ id: 'g' + i, kind: 'giphy', src: src || ('Abcdefgh' + String(i).padStart(4, '0')), name: 'n' + i, added: i });
const pack = S.starterPack(5);
check('the starter pack is the seven official stickers', pack.length === 7 &&
  ['JQAxGWgPNy5uCzFkHU', 'lTY8pVIs76YOMDaDjY', 'JmOCq0T5qEJyZ3oQj8', 'S9dN0rKztj3YyKxpr8', 'mA0UevUzTy75oXQpA8', 'f940860erOHsGoaNlb', 'cImNa6mdCJ0vUTil84']
    .every(id => pack.some(p => p.src === id && p.kind === 'giphy')));
check('every starter sticker passes the checks', pack.every(S.validItem) && S.cleanList(pack).length === 7);
check('the Worker would take the starter pack', WORKER.includes('STICKER_MAX = 24') && JSON.stringify(pack).length < 3.5 * 1024 * 1024);
check('cleanList drops junk, duplicates and unknown fields',
  JSON.stringify(S.cleanList([g(1), g(1), null, { id: 'x', kind: 'url', src: 'https://a' }, { ...g(2), html: '<b>' }]).map(x => x.id)) === '["g1","g2"]' &&
  !('html' in S.cleanList([{ ...g(2), html: '<b>' }])[0]));
check('cleanList caps at 24', S.cleanList(Array.from({ length: 30 }, (_, i) => g(i))).length === 24);
check('cleanList of anything else is []', S.cleanList('x').length === 0 && S.cleanList(null).length === 0);
const full = Array.from({ length: 24 }, (_, i) => g(i));
check('a 25th sticker is refused, kindly', !S.canAdd(full, g(99)).ok && /24/.test(S.canAdd(full, g(99)).why));
const heavy = Array.from({ length: 2 }, (_, i) => ({ id: 'u' + i, kind: 'upload', src: 'data:image/png;base64,' + b64(1.4 * 1024 * 1024), name: '', added: 0 }));
const third = { id: 'u9', kind: 'upload', src: 'data:image/png;base64,' + b64(1.4 * 1024 * 1024), name: '', added: 0 };
check('going over about 3 MB altogether is refused, kindly', !S.canAdd(heavy.slice(0, 1).concat(heavy.slice(1)), third).ok &&
  /3 MB/.test(S.canAdd(heavy, third).why));
check('the same GIPHY sticker twice is refused', !S.canAdd([g(1, ID)], g(2, ID)).ok);
check('restore puts back only what is missing', S.restoreStarter(pack.slice(2), 1).length === 7 &&
  S.restoreStarter(pack, 1).length === 7);
check('restore respects the cap', S.restoreStarter(full, 1).length === 24);
check('move swaps neighbours and ignores the edges',
  S.move([g(1), g(2), g(3)], 0, 1).map(x => x.id).join() === 'g2,g1,g3' &&
  S.move([g(1), g(2)], 0, -1).map(x => x.id).join() === 'g1,g2' && S.move([g(1), g(2)], 1, 1).map(x => x.id).join() === 'g1,g2');
check('the limits are the ones the drawer explains', S.MAX_N === 24 && S.MAX_TOTAL === 3 * 1024 * 1024 && S.MAX_UPLOAD === 1.5 * 1024 * 1024 &&
  /Up to 24 stickers and about 3 MB altogether/.test(SRC));

/* ---------- 4. the browser half, with GIPHY unreachable ---------- */
console.log('\nin a page — GIPHY unreachable, nothing depends on it');
{
  // A small fake DOM: enough for stickers.js to mount, build its button, drawer and peeking
  // sticker. Every <img> fails to load (as GIPHY does from here), asynchronously.
  const listeners = {};
  let timers = [];
  class ClassList {
    constructor(n) { this.n = n; }
    _l() { return (this.n.className || '').split(/\s+/).filter(Boolean); }
    add(...c) { const l = this._l(); c.forEach(x => { if (!l.includes(x)) l.push(x); }); this.n.className = l.join(' '); }
    remove(...c) { this.n.className = this._l().filter(x => !c.includes(x)).join(' '); }
    contains(c) { return this._l().includes(c); }
    toggle(c, f) { const has = this.contains(c); const want = f === undefined ? !has : !!f; if (want) this.add(c); else this.remove(c); return want; }
  }
  const imgs = [];
  class Node {
    constructor(tag) { this.tagName = (tag || '').toUpperCase(); this.children = []; this.attrs = {}; this.style = { setProperty() {}, removeProperty() {} };
      this.className = ''; this.classList = new ClassList(this); this.dataset = {}; this.parentNode = null; this._text = ''; this.hidden = false;
      if (this.tagName === 'IMG') { imgs.push(this); } }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; if (k === 'id') this.id = v; }
    getAttribute(k) { return k === 'class' ? this.className : (k in this.attrs ? this.attrs[k] : null); }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return k in this.attrs; }
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.remove(); c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    remove() { if (this.parentNode) { const p = this.parentNode; p.children = p.children.filter(x => x !== this); this.parentNode = null; } }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.documentElement; }
    set textContent(t) { this.children = []; this._text = String(t); }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set innerHTML(h) { this.children = []; this._html = h; }
    addEventListener(t, f) { (this['on_' + t] = this['on_' + t] || []).push(f); }
    dispatchEvent() {}
    getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [1]; }
    getBoundingClientRect() { return { left: 10, top: 100, right: 380, bottom: 300, width: 370, height: 200 }; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
      const out = [], walk = n => { for (const c of n.children) { if (match(c, sel)) out.push(c); walk(c); } };
      walk(this); return out;
    }
    matches(sel) { return match(this, sel); }
    closest(sel) { let n = this; while (n && n.tagName) { if (match(n, sel)) return n; n = n.parentNode; } return null; }
    focus() {}
    get offsetWidth() { return 10; }
  }
  // selectors the script uses on this fake page: "#id", ".a .b" (descendant), ".cls", "tag.cls"
  function match(n, sel) {
    return sel.split(',').some(s => {
      const parts = s.trim().split(/\s+/);
      const one = (m, p) => {
        if (!m || !m.tagName) return false;
        if (p.startsWith('#')) return m.id === p.slice(1);
        const [tag, ...cls] = p.split('.');
        if (tag && !/^\[/.test(tag) && m.tagName !== tag.toUpperCase()) return false;
        return cls.every(c => m.classList.contains(c));
      };
      if (!one(n, parts[parts.length - 1])) return false;
      let a = n.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) { while (a && !one(a, parts[i])) a = a.parentNode; if (!a) return false; a = a.parentNode; }
      return true;
    });
  }
  const doc = {
    documentElement: new Node('html'), hidden: false, activeElement: null,
    createElement: t => new Node(t),
    getElementById: id => doc.documentElement.querySelectorAll('#' + id)[0] || null,
    querySelectorAll: sel => doc.documentElement.querySelectorAll(sel),
    querySelector: sel => doc.documentElement.querySelector(sel),
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }
  };
  const body = new Node('body');
  doc.documentElement.appendChild(body);
  doc.body = body;
  body.setAttribute('data-theme', 'cloud');
  const wrap = body.appendChild(new Node('div')); wrap.className = 'wrap';
  const card = wrap.appendChild(new Node('div')); card.className = 'card answer-card'; card.setAttribute('id', 'answerCard');
  const num = card.appendChild(new Node('div')); num.className = 'abody'; num.textContent = '35,436 views';
  const party = body.appendChild(new Node('div')); party.setAttribute('id', 'party');
  party.appendChild(new Node('div')).className = 'scrim';
  const store = { data: [], saves: 0 };   // a signed-in account with no stickers yet
  const G = {
    window: { innerWidth: 390, innerHeight: 844, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
      ccStickerStore: { get who() { return 'test'; }, load: async () => store.data, save: async l => { store.saves++; store.data = JSON.parse(JSON.stringify(l)); } } },
    document: doc,
    localStorage: { m: {}, getItem(k) { return k in this.m ? this.m[k] : null; }, setItem(k, v) { this.m[k] = String(v); } },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: f => setTimeout(f, 0),
    getComputedStyle: n => ({ display: n.style.display || 'block' }),
    setTimeout: (f, ms) => { timers.push([f, ms]); return timers.length; },
    clearTimeout() {},
    Image: class {}, URL, FileReader: class {}
  };
  G.window.document = doc;
  const run = new Function(...Object.keys(G), 'module', SRC);
  run(...Object.values(G), undefined);
  const flushTimers = () => { for (let k = 0; k < 5; k++) { const t = timers; timers = []; t.forEach(([f, ms]) => { if (ms < 5000) try { f(); } catch (e) {} }); } };
  await new Promise(r => setImmediate(r));
  const fab = body.querySelector('.cc-stk-fab');
  check('in the cloud theme the ☁ button is there, labelled', !!fab && fab.getAttribute('aria-label') === 'Stickers');
  const peek = doc.getElementById('answerCard').querySelector('.cc-peek');
  check('a sticker peeks over the answer card', !!peek && peek.getAttribute('aria-hidden') === 'true');
  const img = peek && peek.querySelector('img');
  check('its picture is hotlinked from GIPHY as WebP, with no referrer and a fixed size',
    !!img && /^https:\/\/media\.giphy\.com\/media\/[A-Za-z0-9]{8,40}\/giphy\.webp$/.test(img.src) &&
    img.getAttribute('referrerpolicy') === 'no-referrer' && img.getAttribute('decoding') === 'async' &&
    img.getAttribute('width') === '64' && img.getAttribute('height') === '64', img && img.src);
  check('grid pictures load lazily (loading="lazy")', /loading: eager \? 'eager' : 'lazy'/.test(SRC));
  // GIPHY is unreachable: every picture fails, WebP then GIF, and each sticker is skipped in turn
  let rounds = 0;
  while (rounds++ < 40) {
    const live = imgs.filter(i => i.onerror);
    if (!live.length) break;
    live.forEach(i => { const src = i.src; i.onerror(); if (i.src !== src) check.gifTried = true; });
    flushTimers();
  }
  check('a failed WebP falls back to the GIF', check.gifTried === true);
  check('when both fail, every sticker is quietly left out (no broken image on the page)',
    !doc.getElementById('answerCard').querySelector('.cc-peek'), rounds + ' rounds');
  check('and the page’s own text is untouched', num.textContent === '35,436 views');
  check('the list was seeded with the starter pack and saved to the account', store.saves >= 1 && Array.isArray(store.data) && store.data.length === 7);
  check('and cached on the device for an instant next paint', JSON.parse(G.localStorage.getItem('cc_stickers')).length === 7);
  body.setAttribute('data-theme', 'rose');
}

/* ---------- 5. wiring, credit, accessibility, safety ---------- */
console.log('\npages, Worker and the rules');
for (const [name, src] of Object.entries(PAGES)) {
  check(name + ' loads stickers.js (deferred, beside motion.js)', src.includes('<script src="./stickers.js" defer></script>'));
  check(name + ' labels the theme ☁️ Cinnamoroll', src.includes('<option value="cloud">☁️ Cinnamoroll</option>'));
  check(name + ' tells stickers.js how to reach the account', /window\.ccStickerStore = \{/.test(src) && /get who\(\)/.test(src) &&
    /async load\(\)/.test(src) && /async save\(list\)/.test(src));
}
check('tiktok.html saves to /tiktok/stickers with the session header', /workerUrl \+ '\/tiktok\/stickers'[\s\S]{0,200}Authorization: 'Bearer ' \+ session/.test(PAGES['tiktok.html']));
check('index.html saves to /stickers with the same token as /sync', /workerUrl \+ '\/stickers'[\s\S]{0,120}Authorization: 'Bearer ' \+ accessToken/.test(PAGES['index.html']));
check('the Worker has both routes, owner-locked', /if \(p === '\/tiktok\/stickers'\) return stickersRoute\(request, env, 'tt:stickers:' \+ openId\);/.test(WORKER) &&
  /url\.pathname === '\/stickers'/.test(WORKER) && /verifyOwner\(auth\.startsWith\('Bearer '\)/.test(WORKER) && /'stickers:' \+ owner/.test(WORKER));
check('the TikTok route sits after the session check', WORKER.indexOf("if (p === '/tiktok/stickers')") > WORKER.indexOf("if (!openId) return json({ error: 'Not signed in to TikTok.' }, 401);"));
check('the credit is shown in the drawer and on the party', SRC.includes("const CREDIT = 'Stickers via GIPHY · © Sanrio';") &&
  /<p class="cc-stk-credit">' \+ CREDIT \+ '<\/p>/.test(SRC) && /cc-party-credit/.test(SRC) && /if \(giphy\) \{/.test(SRC));
check('only active in the cloud theme', /const on = \(\) => body\.getAttribute\('data-theme'\) === 'cloud';/.test(SRC) && /if \(on\(\)\) mount\(\); else unmount\(\);/.test(SRC));
check('a failure never reaches the page', /try \{ boot\(\); \} catch \(e\)/.test(SRC));
check('at most 6 stickers on screen', /const MAX_ON_SCREEN = 6;/.test(SRC) && /if \(room\(\) <= 0 \|\| !it\) return null;/.test(SRC));
check('reduced motion: placed, never moving (no hops, pops or idle wiggles)',
  /if \(!on\(\) \|\| calm\(\)\) return;[\s\S]{0,200}cc:increase|function onIncrease\(e\) \{\s*if \(!on\(\) \|\| calm\(\)\) return;/.test(SRC) &&
  /function onDrawn\(e\) \{\s*if \(!on\(\) \|\| calm\(\)\) return;/.test(SRC) && /function idleSoon\(\) \{\s*clearTimeout\(idleT\);\s*if \(calm\(\)\) return;/.test(SRC));
const rm = [...CSS.matchAll(/@media \(prefers-reduced-motion:reduce\) \{\n    \.cc-peek[\s\S]*?\n  \}/g)].join('');
check('and the stylesheet stops every sticker animation under reduced motion', /\.cc-peek \.cc-bob/.test(rm) && /\.cc-fly\.cc-rise/.test(rm) && /animation:none !important/.test(rm));
check('stickers never catch a tap on data (layers are pointer-events:none; only the peeking picture takes one)',
  /\.cc-stk-layer \{[^}]*pointer-events:none/.test(CSS) && /\.cc-party-stk \{[^}]*pointer-events:none/.test(CSS) &&
  /\.cc-peek \{[^}]*pointer-events:none/.test(CSS) && /\.cc-peek img \{[^}]*pointer-events:auto/.test(CSS));
check('the drawer is a labelled dialog that Esc closes, with a Tab loop', /role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ccStkTitle'/.test(SRC) &&
  /e\.key === 'Escape'/.test(SRC) && /e\.key !== 'Tab'/.test(SRC) && /aria-label="Close stickers"/.test(SRC));
check('every drawer button has a label', /'aria-label': 'Remove ' \+ nm/.test(SRC) && /'aria-label': 'Move ' \+ nm \+ ' earlier'/.test(SRC) &&
  /'aria-label': 'Preview ' \+ nm/.test(SRC));
check('a hidden drawer really is hidden', /\.cc-stk-sheet\[hidden\] \{ display:none; \}/.test(CSS));
check('it writes no page text (no textContent/innerHTML on anything it did not create)',
  !/(?:getElementById|querySelector)\([^)]*\)\.(?:textContent|innerHTML)\s*=/.test(SRC));
check('the privacy page mentions stickers and GIPHY', /Stickers[\s\S]{0,300}private storage[\s\S]{0,200}GIPHY/.test(read('yt-dashboard/privacy.html')));
check('the README explains them', /\*\*Stickers\*\*/.test(read('README.md')));

/* ---------- 6. the palette asks ---------- */
const block = (CSS.match(/body\[data-theme="cloud"\] \{([^}]*)\}/) || [])[1] || '';
const tok = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
check('the baby-blue accent reads on a panel (≥4.5:1)', ratio(tok.accent, tok.panel) >= 4.5, ratio(tok.accent, tok.panel).toFixed(2));
check('the cheek-pink --live reads on a panel (≥4.5:1)', ratio(tok.live, tok.panel) >= 4.5, ratio(tok.live, tok.panel).toFixed(2));

/* ---------- 7. no Sanrio artwork in the repo ---------- */
console.log('\nno character artwork committed');
let tracked = [];
try { tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) {}
const images = tracked.filter(f => /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|apng|heic)$/i.test(f));
const KNOWN = ['brand/icon-1024.png', 'brand/icon-128.png', 'brand/icon-256.png', 'brand/icon-48.png', 'brand/icon-512.png',
  'brand/icon-64.png', 'brand/icon.svg', 'brand/preview-sizes.png'];
check('git is readable here', tracked.length > 10);
check('no new image files (only the app’s own icons)', images.every(f => KNOWN.includes(f)), images.filter(f => !KNOWN.includes(f)).join(', '));
check('no image data embedded in stickers.js (pictures come from GIPHY or your uploads)', !/data:image\/[a-z+]+;base64,[A-Za-z0-9+/]{40}/.test(SRC) && !/<svg/i.test(SRC));
check('GIPHY is the only outside host stickers.js loads from', [...SRC.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].every(m => /(^|\.)giphy\.com$/.test(m[1])));

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
