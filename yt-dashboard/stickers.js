/* Channel Command — stickers.js
 *
 * Cinnamoroll being cute on the page. Only ever active in the ☁️ Cinnamoroll theme
 * (body[data-theme="cloud"]); in every other theme it adds nothing at all.
 *
 * Where the pictures come from — and where they never come from
 *   No Sanrio artwork is drawn, traced or stored in this repo. Real Cinnamoroll pictures come
 *   from exactly two places: official Sanrio stickers hotlinked from GIPHY's CDN (the starter
 *   pack below, credited "Stickers via GIPHY · © Sanrio"), and pictures you upload yourself.
 *   A GIPHY sticker is stored as its media id only; the URL is always built here, so nothing
 *   else can ever be loaded through it. If GIPHY cannot be reached, a sticker is quietly left
 *   out — nothing on the page waits on one, and the page works exactly the same without them.
 *
 * What it does
 *   • A sticker peeks over the top edge of the answer card and gently bobs; switching room
 *     brings a different one in with a pop and a wave. Every 20–40 s it wiggles; tap it for a
 *     happy jump and a few tiny hearts.
 *   • When a live total goes up (motion.js fires 'cc:increase' as it shows the ▲ chip) a
 *     sticker hops beside that tile. When a chart finishes drawing ('cc:drawn') a small one
 *     pops at its end point — once per draw-in, not once per chart.
 *   • At a milestone (#party.on) three to five float up with the confetti.
 *   • The ☁ button (bottom-right) opens your sticker drawer: upload from your phone, paste a
 *     GIPHY link, reorder, remove, restore the starter pack.
 *
 * Saved to your account. The page sets window.ccStickerStore = { load, save, who } (see
 * tiktok.html / index.html / compare.html): load() → the account's list, or null when not
 * signed in; save(list) → stores it; who → a label when signed in, '' when not. The list is
 * also cached in localStorage ('cc_stickers') so it paints instantly and works offline; when
 * the account answers, the account wins.
 *
 * Safety: decoration only. It never changes a number or a word on the page, never blocks a
 * tap on data (everything is pointer-events:none except the peeking sticker itself), keeps
 * at most 6 stickers on screen, and under prefers-reduced-motion it only places stickers —
 * nothing moves. A failure anywhere in here never reaches the page.
 *
 * The list rules at the top are pure and exported for Node (scripts/stickers.test.mjs). */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------------
     The rules — pure, shared with the tests, mirrored by the Worker's checkStickers()
     --------------------------------------------------------------------------------- */
  const ID_RE = /^[A-Za-z0-9]{8,40}$/;
  const UPLOAD_RE = /^data:image\/(?:webp|png|jpeg|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const MAX_N = 24;                        // stickers in the list
  const MAX_TOTAL = 3 * 1024 * 1024;       // the whole list as JSON (the Worker allows 3.5 MB)
  const MAX_UPLOAD = 1.5 * 1024 * 1024;    // one upload, after it has been shrunk
  const MAX_SIDE = 320;                    // longest side of an upload, in pixels
  const KEEP_GIF = 700 * 1024;             // a small GIF is kept as it is, so it stays animated
  const CREDIT = 'Stickers via GIPHY · © Sanrio';
  // official stickers: Sanrio (@sanrioinc) and Sanrio Korea, on GIPHY
  const STARTER = [
    ['JmOCq0T5qEJyZ3oQj8', 'Happy Cinnamon'],
    ['JQAxGWgPNy5uCzFkHU', 'Cinnamoroll'],
    ['S9dN0rKztj3YyKxpr8', 'Dance Cinnamon'],
    ['lTY8pVIs76YOMDaDjY', 'Cinnamoroll'],
    ['mA0UevUzTy75oXQpA8', 'Cinnamoroll'],
    ['f940860erOHsGoaNlb', 'Cinnamoroll'],
    ['cImNa6mdCJ0vUTil84', 'Cinnamoroll']
  ];

  // A GIPHY page or media link → its media id, or null. Only giphy.com hosts, and the id has
  // to pass the strict [A-Za-z0-9]{8,40} test, so nothing else can ride along.
  function giphyId(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    if (!s || s.length > 400) return null;
    let u;
    try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.port) return null;
    const h = u.hostname.toLowerCase();
    if (h !== 'giphy.com' && !/^[a-z0-9-]+\.giphy\.com$/.test(h)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    let cand = null;
    const mi = parts.indexOf('media');
    if (mi >= 0) {                                   // media.giphy.com/media/<id>/giphy.gif, …/media/v1.<hash>/<id>/…
      cand = parts[mi + 1] || '';
      if (/^v1\./.test(cand)) cand = parts[mi + 2] || '';
    } else if (h === 'i.giphy.com') {                // i.giphy.com/<id>.webp
      cand = (parts[0] || '').replace(/\.(?:gif|webp|mp4)$/i, '');
    } else if (parts[0] === 'embed') {               // giphy.com/embed/<id>
      cand = parts[1] || '';
    } else if (parts[0] === 'gifs' || parts[0] === 'stickers' || parts[0] === 'clips') {
      const last = parts[parts.length - 1] || '';    // giphy.com/stickers/sanrio-cinnamoroll-<id>
      cand = last.slice(last.lastIndexOf('-') + 1);
    }
    return cand && ID_RE.test(cand) ? cand : null;
  }
  const giphyUrls = id => ['https://media.giphy.com/media/' + id + '/giphy.webp',
                           'https://media.giphy.com/media/' + id + '/giphy.gif'];

  // the size an image is drawn at: longest side at most `max`, never enlarged
  function fitSize(w, h, max) {
    max = max || MAX_SIDE;
    if (!(w > 0 && h > 0) || !isFinite(w) || !isFinite(h)) return null;
    const k = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  // decoded size of a base64 data: URL
  function dataUrlBytes(s) {
    if (typeof s !== 'string') return 0;
    const b = s.slice(s.indexOf(',') + 1);
    const pad = b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(b.length * 3 / 4) - pad);
  }
  // is this finished upload one we can keep? → { ok } or { ok:false, why } in plain words
  function checkUpload(dataUrl) {
    if (typeof dataUrl !== 'string' || !UPLOAD_RE.test(dataUrl))
      return { ok: false, why: 'That picture couldn’t be turned into a sticker (use a PNG, JPEG, WebP or GIF).' };
    if (dataUrlBytes(dataUrl) > MAX_UPLOAD)
      return { ok: false, why: 'That picture is still over 1.5 MB after shrinking it — try a smaller one.' };
    return { ok: true };
  }
  function validItem(it) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return false;
    if (typeof it.id !== 'string' || !ITEM_ID_RE.test(it.id)) return false;
    if (it.kind === 'giphy') return typeof it.src === 'string' && ID_RE.test(it.src);
    if (it.kind === 'upload') return typeof it.src === 'string' && UPLOAD_RE.test(it.src) && dataUrlBytes(it.src) <= MAX_UPLOAD * 1.34;
    return false;
  }
  const listBytes = list => JSON.stringify(list).length;
  const cleanName = n => String(n == null ? '' : n).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
  // anything from storage or the network → a list the Worker would accept
  function cleanList(list) {
    if (!Array.isArray(list)) return [];
    const out = [], ids = new Set();
    for (const it of list) {
      if (!validItem(it) || ids.has(it.id)) continue;
      ids.add(it.id);
      out.push({ id: it.id, kind: it.kind, src: it.src, name: cleanName(it.name), added: +it.added || 0 });
      if (out.length >= MAX_N) break;
    }
    while (out.length && listBytes(out) > MAX_TOTAL) out.pop();
    return out;
  }
  // can `item` join `list`? → { ok } or { ok:false, why }
  function canAdd(list, item) {
    if (!validItem(item)) return { ok: false, why: 'That isn’t a sticker I can keep.' };
    if (list.length >= MAX_N) return { ok: false, why: 'You have 24 stickers — that’s the most. Remove one to add another.' };
    if (listBytes(list.concat([item])) > MAX_TOTAL)
      return { ok: false, why: 'Your stickers would be over 3 MB altogether — remove a big one first.' };
    if (item.kind === 'giphy' && list.some(x => x.kind === 'giphy' && x.src === item.src))
      return { ok: false, why: 'That GIPHY sticker is already in your drawer.' };
    return { ok: true };
  }
  const starterPack = now => STARTER.map(([id, name]) => ({ id: 'st-' + id, kind: 'giphy', src: id, name, added: now || 0 }));
  // puts back whichever starter stickers are missing, at the end, as far as the limits allow
  function restoreStarter(list, now) {
    const out = list.slice();
    for (const it of starterPack(now)) {
      if (out.some(x => x.id === it.id || (x.kind === 'giphy' && x.src === it.src))) continue;
      if (!canAdd(out, it).ok) break;
      out.push(it);
    }
    return out;
  }
  function move(list, i, d) {
    const j = i + d;
    if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list.slice();
    const out = list.slice();
    const [x] = out.splice(i, 1);
    out.splice(j, 0, x);
    return out;
  }

  const api = { ID_RE, UPLOAD_RE, MAX_N, MAX_TOTAL, MAX_UPLOAD, MAX_SIDE, CREDIT, STARTER,
    giphyId, giphyUrls, fitSize, dataUrlBytes, checkUpload, validItem, cleanList, canAdd,
    starterPack, restoreStarter, move, listBytes };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  try { boot(); } catch (e) { /* decoration only: a failure here must never reach the page */ }

  function boot() {
    const doc = document, body = doc.body, win = window;
    if (!body || typeof MutationObserver !== 'function') return;
    const guard = fn => function () { try { return fn.apply(this, arguments); } catch (e) { /* never the page's problem */ } };
    const mq = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const calm = () => !!(mq && mq.matches);
    const on = () => body.getAttribute('data-theme') === 'cloud';
    const LS = 'cc_stickers';
    const el = (tag, cls, attrs) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };

    /* ---------------- the list, and where it is kept ---------------- */
    let list = null, hadLocal = false, edited = false, saveT = 0;
    function readLocal() {
      try { const raw = localStorage.getItem(LS); if (raw == null) return null; return cleanList(JSON.parse(raw)); }
      catch (e) { return null; }
    }
    function writeLocal() {
      try { localStorage.setItem(LS, JSON.stringify(list)); return true; } catch (e) { return false; }
    }
    const store = () => { const s = win.ccStickerStore; return s && typeof s.load === 'function' && typeof s.save === 'function' ? s : null; };
    const who = () => { try { const s = store(); return s ? String(s.who || '') : ''; } catch (e) { return ''; } };
    let syncText = '', syncBad = false;
    function setSync(t, bad) { syncText = t; syncBad = !!bad; paintSync(); }

    function loadLocal() {
      const l = readLocal();
      hadLocal = l !== null;
      list = l || starterPack(Date.now());
      setSync(who() ? 'Loading from your account…' : 'Saved on this device only');
    }
    // the account wins when it answers. An account with no list yet takes this device's
    // list (so stickers added before signing in are kept), or the starter pack on a new device.
    let pulling = false;
    async function pull() {
      const s = store();
      if (!s || pulling) { if (!s) setSync('Saved on this device only'); return; }
      pulling = true;
      let r;
      try { r = await s.load(); }
      catch (e) { pulling = false; setSync('Couldn’t reach your account — saved on this device for now', true); return; }
      pulling = false;
      if (!Array.isArray(r)) { setSync('Saved on this device only'); return; }
      const remote = cleanList(r);
      if (remote.length && !edited) {
        list = remote; writeLocal(); refresh();
        setSync('Saved to your account' + (who() ? ' (' + who() + ')' : ''));
      } else {
        if (!remote.length && !hadLocal && !edited) { list = starterPack(Date.now()); writeLocal(); refresh(); }
        saveNow();
      }
    }
    function changed() {
      edited = true; hadLocal = true;
      if (!writeLocal()) setSync('This device’s storage is full — your stickers may not be kept here', true);
      clearTimeout(saveT);
      saveT = setTimeout(guard(saveNow), 1200);
      refresh();
    }
    async function saveNow() {
      clearTimeout(saveT);
      const s = store();
      if (!s || !who()) { setSync('Saved on this device only'); return; }
      setSync('Saving…');
      try { await s.save(list.slice()); setSync('Saved to your account' + ' (' + who() + ')'); }
      catch (e) { setSync('Couldn’t reach your account — saved on this device for now', true); }
    }

    /* ---------------- sticker pictures ---------------- */
    const dead = new Set();          // stickers that could not load this visit
    const keyOf = it => it.kind + ':' + (it.kind === 'giphy' ? it.src : it.id);
    const alive = () => (list || []).filter(it => !dead.has(keyOf(it)));
    // an <img> for a sticker; GIPHY tries WebP then GIF, and if both fail the sticker is
    // marked dead and `onDead` runs — the caller simply leaves it out
    // `eager` for a sticker that is on screen the moment it is made (a lazy image in a
    // fixed layer can wait for ever); the drawer's grid stays lazy
    function stickerImg(it, px, onDead, eager) {
      const img = el('img', 'cc-stk-img', { alt: '', width: String(px), height: String(px), draggable: 'false',
        loading: eager ? 'eager' : 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      const fail = () => { img.onerror = null; dead.add(keyOf(it)); if (onDead) guard(onDead)(); };
      if (it.kind === 'giphy') {
        const urls = giphyUrls(it.src);
        let n = 0;
        img.onerror = () => { if (++n < urls.length) img.src = urls[n]; else fail(); };
        img.src = urls[0];
      } else {
        img.onerror = fail;
        img.src = it.src;
      }
      return img;
    }

    /* ---------------- on screen: at most 6 stickers ---------------- */
    const MAX_ON_SCREEN = 6;
    const flying = new Set();        // transient stickers (hops, pops, party floats)
    const room = () => MAX_ON_SCREEN - (peek && peek.isConnected ? 1 : 0) - flying.size;
    let layer = null;                // fixed, pointer-events:none layer for hops and pops
    function getLayer() {
      if (!layer || !layer.isConnected) { layer = el('div', 'cc-stk-layer', { 'aria-hidden': 'true' }); body.appendChild(layer); }
      return layer;
    }
    let pickAt = 0;
    function pick(avoid) {
      const a = alive();
      if (!a.length) return null;
      for (let i = 0; i < a.length; i++) {
        const it = a[(pickAt++) % a.length];
        if (!avoid || it.id !== avoid || a.length === 1) return it;
      }
      return a[0];
    }
    function fly(cls, it, px, x, y, ms, parent) {
      if (room() <= 0 || !it) return null;
      const w = el('span', 'cc-fly ' + cls);
      w.style.left = Math.round(x) + 'px'; w.style.top = Math.round(y) + 'px';
      w.style.width = px + 'px'; w.style.height = px + 'px';
      w.appendChild(stickerImg(it, px, () => { done(); }, true));
      (parent || getLayer()).appendChild(w);
      flying.add(w);
      let t = 0;
      function done() { clearTimeout(t); flying.delete(w); w.remove(); }
      t = setTimeout(guard(done), ms);
      return w;
    }
    const clampX = (x, px) => Math.max(6, Math.min((win.innerWidth || 390) - px - 6, x));
    const inView = r => r.bottom > 0 && r.top < (win.innerHeight || 800) && r.width > 0;

    /* ---------------- (a) the peeking sticker ---------------- */
    let peek = null, peekItem = null, peekHost = null, idleT = 0;
    function hostEl() {
      const shown = n => n && n.getClientRects().length > 0 && getComputedStyle(n).display !== 'none';
      const a = doc.getElementById('answerCard');
      if (shown(a)) return a;
      const cards = doc.querySelectorAll('.wrap .card');
      for (const c of cards) if (shown(c) && !c.closest('.drawer')) return c;
      return null;
    }
    // `fresh`: a different sticker than the one showing (a room change); otherwise the same
    // one stays and is only moved if its card changed
    function placePeek(animate, fresh) {
      const host = hostEl();
      if (!host) { removePeek(); return; }
      const cur = peekItem && alive().find(x => x.id === peekItem.id);
      const it = !fresh && cur ? cur : pick(peekItem && peekItem.id);
      if (!it) { removePeek(); return; }
      if (peekHost && peekHost !== host) peekHost.classList.remove('cc-peek-host');
      peekHost = host;
      host.classList.add('cc-peek-host');
      if (!peek) {
        peek = el('span', 'cc-peek', { 'aria-hidden': 'true' });
        peek.appendChild(el('i', 'cc-bob'));
        peek.addEventListener('click', guard(happyJump));
      }
      if (peek.parentNode !== host) host.appendChild(peek);
      fitSoon();
      const bob = peek.firstChild;
      if (it === peekItem && bob.firstChild) { idleSoon(); return; }   // nothing to change
      bob.textContent = '';
      peekItem = it;
      if (it.kind === 'giphy') peek.title = CREDIT; else peek.removeAttribute('title');
      bob.appendChild(stickerImg(it, 64, () => { if (peekItem === it) placePeek(false, true); }, true));
      if (animate && !calm()) replay(peek, 'cc-in', 900);
      idleSoon();
    }
    /* The sticker rises above its card only as far as the space there allows: if a control
       (a select, a button, a tab) sits just above the card, the sticker comes in smaller and
       lower, so it never lies over anything you might tap. It always overlaps the card's own
       top padding by the same 16px, never its text. */
    let fitRaf = 0;
    function fitSoon() {
      if (fitRaf) return;
      fitRaf = requestAnimationFrame(guard(() => { fitRaf = 0; fitPeek(); }));
    }
    function fitPeek() {
      if (!peek || !peekHost || !peek.isConnected) return;
      const hr = peekHost.getBoundingClientRect();
      const L = hr.right - 18 - 64 - 8, R = hr.right - 18 + 8;   // the widest the sticker can be, plus a margin
      let clear = 48;
      for (const n of doc.querySelectorAll('button, a[href], select, input, textarea, summary, label, [role="tab"], [role="button"]')) {
        if (peekHost.contains(n) || n.closest('.cc-stk-sheet, .drawer, #party')) continue;
        const r = n.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom > hr.top + 1 || r.bottom < hr.top - 80 || r.right < L || r.left > R) continue;
        clear = Math.min(clear, Math.floor(hr.top - r.bottom - 4));
      }
      const rise = Math.max(10, Math.min(48, clear));
      peek.style.setProperty('--cc-rise', rise + 'px');
      peek.style.setProperty('--cc-size', Math.max(34, Math.min(64, rise + 16)) + 'px');
    }
    function removePeek() {
      if (peek) peek.remove();
      if (peekHost) peekHost.classList.remove('cc-peek-host');
      peekHost = null;
      clearTimeout(idleT);
    }
    function replay(n, cls, ms) {
      n.classList.remove('cc-in', 'cc-jump', 'cc-wiggle');
      void n.offsetWidth;
      n.classList.add(cls);
      setTimeout(guard(() => n.classList.remove(cls)), ms);
    }
    // (e) an idle wiggle every 20–40 s, only while you can see it
    function idleSoon() {
      clearTimeout(idleT);
      if (calm()) return;
      idleT = setTimeout(guard(() => {
        if (peek && peek.isConnected && !doc.hidden && inView(peek.getBoundingClientRect())) replay(peek, 'cc-wiggle', 1100);
        idleSoon();
      }), 20000 + Math.random() * 20000);
    }
    function happyJump() {
      if (calm() || !peek) return;
      replay(peek, 'cc-jump', 800);
      for (let i = 0; i < 3; i++) {
        const h = el('i', 'cc-heart');
        h.textContent = '♥';
        h.style.setProperty('--hx', (i - 1) * 16 + 'px');
        h.style.setProperty('--hd', i * 90 + 'ms');
        peek.appendChild(h);
        setTimeout(guard(() => h.remove()), 1300);
      }
    }

    /* ---------------- (b) a hop by a tile that went up ---------------- */
    let hopAt = 0;
    function onIncrease(e) {
      if (!on() || calm()) return;
      const tile = e.detail && e.detail.el;
      if (!tile || !tile.getBoundingClientRect) return;
      const t = Date.now();
      if (t - hopAt < 2500) return;
      const r = tile.getBoundingClientRect();
      if (!inView(r)) return;
      hopAt = t;
      // inside the tile, at the right, just under the ▲ chip: the number is on the left and a
      // sparkline, if any, lower down — so it covers nothing, not even the controls above
      const x = clampX(r.right - 52, 40);
      let y = r.top + 34;
      const nr = tile.querySelector('.stat-num') ? tile.querySelector('.stat-num').getBoundingClientRect() : null;
      if (nr && nr.width && nr.right > x - 4) y = Math.min(r.bottom - 44, nr.bottom + 4);   // a long number: sit below it
      fly('cc-hop', pick(peekItem && peekItem.id), 40, x, y, 1500);
    }

    /* ---------------- (c) a pop where a chart ends ---------------- */
    const popped = new Set();
    function onDrawn(e) {
      if (!on() || calm()) return;
      const d = e.detail || {}, svg = d.el;
      if (!svg || !svg.getBoundingClientRect) return;
      const ep = d.epoch == null ? 'x' : d.epoch;
      if (popped.has(ep)) return;
      const r = svg.getBoundingClientRect();
      if (!inView(r) || r.top < 0) return;
      popped.add(ep);
      if (popped.size > 200) popped.clear();
      // the end point: the chart's last marker if it has one, else its top-right corner
      const dots = svg.querySelectorAll('circle.end-dot, circle.cc-end');
      const end = dots.length ? dots[dots.length - 1].getBoundingClientRect() : null;
      const x = end && end.width ? end.left + end.width / 2 : r.right - 20;
      const y = end && end.width ? end.top : r.top + 18;
      fly('cc-pop', pick(peekItem && peekItem.id), 40, clampX(x - 20, 40), Math.max(4, y - 44), 1800);
    }

    /* ---------------- (d) the milestone party ---------------- */
    let partyLayer = null, partyOn = false;
    function onParty(isOn) {
      if (isOn === partyOn) return;     // only the moment it opens or closes
      partyOn = isOn;
      if (partyLayer) { partyLayer.remove(); partyLayer = null; }
      flying.forEach(w => { if (!w.isConnected) flying.delete(w); });
      if (!isOn || !on()) return;
      const party = doc.getElementById('party');
      if (!party) return;
      partyLayer = el('div', 'cc-party-stk', { 'aria-hidden': 'true' });
      const scrim = party.querySelector('.scrim');
      if (scrim && scrim.nextSibling) party.insertBefore(partyLayer, scrim.nextSibling); else party.appendChild(partyLayer);
      // the hops and pops are hidden under the party anyway: make room for the floaters
      flying.forEach(w => { if (w.parentNode === layer) { flying.delete(w); w.remove(); } });
      const n = Math.max(0, Math.min(3 + Math.floor(Math.random() * 3), room()));
      const a = alive();
      let giphy = false;
      const W = win.innerWidth || 390, H = win.innerHeight || 800;
      for (let i = 0; i < n && a.length; i++) {
        const it = a[(pickAt++) % a.length];
        const px = W < 500 ? 56 : 76;
        const slot = (i + 0.5) / n;                      // spread across the width
        const x = Math.round(slot * (W - px) + (Math.random() - 0.5) * 12);
        const w = calm()
          ? fly('cc-rise cc-still', it, px, Math.max(6, x), i % 2 ? H * 0.72 : H * 0.12, 60000, partyLayer)
          : fly('cc-rise', it, px, Math.max(6, x), H + 10, 5200 + i * 260, partyLayer);
        if (!w) break;
        w.style.setProperty('--rd', (i * 260) + 'ms');
        w.style.setProperty('--rs', (i % 2 ? -1 : 1) * (14 + Math.random() * 16) + 'px');
        if (it.kind === 'giphy') giphy = true;
      }
      if (giphy) {
        const c = el('span', 'cc-stk-credit cc-party-credit');
        c.textContent = CREDIT;
        partyLayer.appendChild(c);
      }
    }

    /* ---------------- the drawer ---------------- */
    let fab = null, sheet = null, lastFocus = null, msgT = 0;
    const $s = sel => sheet && sheet.querySelector(sel);
    function buildFab() {
      fab = el('button', 'cc-stk-fab', { type: 'button', 'aria-label': 'Stickers', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Stickers' });
      fab.textContent = '☁';
      fab.addEventListener('click', guard(() => (sheet && !sheet.hidden ? closeSheet() : openSheet())));
      body.appendChild(fab);
    }
    function buildSheet() {
      sheet = el('div', 'cc-stk-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ccStkTitle' });
      sheet.hidden = true;
      sheet.innerHTML =
        '<div class="cc-stk-scrim"></div>' +
        '<div class="cc-stk-panel">' +
          '<div class="cc-stk-head"><h2 id="ccStkTitle">☁ Your stickers</h2>' +
            '<button type="button" class="cc-stk-x" aria-label="Close stickers">×</button></div>' +
          '<p class="cc-stk-note">They peek over your cards, hop when a number goes up and float up at milestones. Tap one to see it bounce.</p>' +
          '<ul class="cc-stk-grid" aria-label="Your stickers"></ul>' +
          '<p class="cc-stk-msg" role="status" aria-live="polite"></p>' +
          '<div class="cc-stk-add">' +
            '<button type="button" class="primary cc-stk-up">📷 Upload from phone</button>' +
            '<input type="file" class="cc-stk-file" accept="image/*" multiple hidden>' +
            '<form class="cc-stk-giphy" novalidate>' +
              '<label for="ccStkLink">Add from a GIPHY link</label>' +
              '<div class="cc-stk-row"><input id="ccStkLink" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://giphy.com/stickers/…">' +
              '<button type="submit" class="ghost">Add</button></div>' +
            '</form>' +
            '<button type="button" class="ghost cc-stk-starter">Restore starter pack</button>' +
          '</div>' +
          '<p class="cc-stk-limits">Up to 24 stickers and about 3 MB altogether. Photos are shrunk to 320 px so they load fast (big animated GIFs become still pictures). Pictures with see-through backgrounds look best.</p>' +
          '<p class="cc-stk-sync"></p>' +
          '<p class="cc-stk-credit">' + CREDIT + '</p>' +
        '</div>';
      body.appendChild(sheet);
      $s('.cc-stk-scrim').addEventListener('click', guard(closeSheet));
      $s('.cc-stk-x').addEventListener('click', guard(closeSheet));
      $s('.cc-stk-up').addEventListener('click', guard(() => $s('.cc-stk-file').click()));
      $s('.cc-stk-file').addEventListener('change', guard(e => { const f = Array.from(e.target.files || []); e.target.value = ''; addFiles(f); }));
      $s('.cc-stk-giphy').addEventListener('submit', guard(e => { e.preventDefault(); addLink(); }));
      $s('.cc-stk-starter').addEventListener('click', guard(() => {
        const before = list.length;
        list = restoreStarter(list, Date.now());
        const n = list.length - before;
        say(n ? 'Added ' + n + ' starter sticker' + (n === 1 ? '' : 's') + ' back.' :
          (list.length >= MAX_N ? 'Your drawer is full (24) — remove one first.' : 'The starter pack is all here already.'));
        if (n) changed();
      }));
      sheet.addEventListener('keydown', guard(onSheetKey));
      const grid = $s('.cc-stk-grid');
      grid.addEventListener('click', guard(onGridClick));
      // drag to reorder (mouse / desktop); on phones the ◀ ▶ buttons do the same
      let dragId = null;
      grid.addEventListener('dragstart', guard(e => {
        const li = e.target.closest && e.target.closest('.cc-stk-item');
        if (!li) return;
        dragId = li.dataset.id;
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } catch (x) {}
      }));
      grid.addEventListener('dragover', guard(e => { if (dragId) e.preventDefault(); }));
      grid.addEventListener('drop', guard(e => {
        const li = e.target.closest && e.target.closest('.cc-stk-item');
        if (!dragId || !li) return;
        e.preventDefault();
        const i = list.findIndex(x => x.id === dragId), j = list.findIndex(x => x.id === li.dataset.id);
        dragId = null;
        if (i < 0 || j < 0 || i === j) return;
        list = move(list, i, j - i);
        changed();
      }));
      grid.addEventListener('dragend', () => { dragId = null; });
    }
    function focusables() {
      return Array.from(sheet.querySelectorAll('button, input:not([type="file"]), [tabindex]:not([tabindex="-1"])'))
        .filter(n => !n.disabled && n.getClientRects().length);
    }
    function onSheetKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeSheet(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function openSheet() {
      if (!sheet) buildSheet();
      lastFocus = doc.activeElement;
      sheet.hidden = false;
      body.classList.add('cc-stk-open');
      fab.setAttribute('aria-expanded', 'true');
      renderGrid(); paintSync();
      say('');
      const x = $s('.cc-stk-x');
      if (x) x.focus();
    }
    function closeSheet() {
      if (!sheet || sheet.hidden) return;
      sheet.hidden = true;
      body.classList.remove('cc-stk-open');
      if (fab) fab.setAttribute('aria-expanded', 'false');
      if (lastFocus && lastFocus.focus && lastFocus.isConnected) lastFocus.focus(); else if (fab) fab.focus();
    }
    function say(t, bad) {
      const m = $s('.cc-stk-msg');
      if (!m) return;
      m.textContent = t || '';
      m.classList.toggle('bad', !!bad);
      clearTimeout(msgT);
      if (t) msgT = setTimeout(guard(() => { if (m.textContent === t) m.textContent = ''; }), 7000);
    }
    function paintSync() {
      const s = $s('.cc-stk-sync');
      if (!s) return;
      s.textContent = syncText;
      s.classList.toggle('bad', syncBad);
    }
    function renderGrid() {
      const grid = $s('.cc-stk-grid');
      if (!grid || sheet.hidden) return;
      grid.textContent = '';
      list.forEach((it, i) => {
        const nm = it.name || (it.kind === 'giphy' ? 'GIPHY sticker' : 'your picture');
        const li = el('li', 'cc-stk-item', { draggable: 'true' });
        li.dataset.id = it.id;
        const pv = el('button', 'cc-stk-prev', { type: 'button', 'aria-label': 'Preview ' + nm + ' (sticker ' + (i + 1) + ' of ' + list.length + ')' });
        const cloud = el('span', 'cc-stk-miss', { 'aria-hidden': 'true' });
        cloud.textContent = '☁';
        const img = stickerImg(it, 64, () => { img.remove(); pv.classList.add('missing'); });
        pv.appendChild(cloud); pv.appendChild(img);
        if (dead.has(keyOf(it))) { img.remove(); pv.classList.add('missing'); }
        const rm = el('button', 'cc-stk-rm', { type: 'button', 'aria-label': 'Remove ' + nm, 'data-act': 'rm' });
        rm.textContent = '×';
        const mv = el('span', 'cc-stk-mv');
        const l = el('button', '', { type: 'button', 'aria-label': 'Move ' + nm + ' earlier', 'data-act': 'left' });
        l.textContent = '◀'; l.disabled = i === 0;
        const r = el('button', '', { type: 'button', 'aria-label': 'Move ' + nm + ' later', 'data-act': 'right' });
        r.textContent = '▶'; r.disabled = i === list.length - 1;
        mv.appendChild(l); mv.appendChild(r);
        li.appendChild(pv); li.appendChild(rm); li.appendChild(mv);
        grid.appendChild(li);
      });
      if (!list.length) {
        const li = el('li', 'cc-stk-empty');
        li.textContent = 'No stickers yet — upload one, paste a GIPHY link, or restore the starter pack.';
        grid.appendChild(li);
      }
      const bytes = listBytes(list);
      const lim = $s('.cc-stk-limits');
      if (lim) lim.dataset.used = list.length + ' of 24 · ' + (bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB') + ' of 3 MB';
    }
    function onGridClick(e) {
      const b = e.target.closest && e.target.closest('button');
      const li = b && b.closest('.cc-stk-item');
      if (!li) return;
      const i = list.findIndex(x => x.id === li.dataset.id);
      if (i < 0) return;
      const act = b.getAttribute('data-act');
      if (b.classList.contains('cc-stk-prev')) {
        if (!calm()) replay(b, 'cc-jump', 800);
        return;
      }
      const focusAfter = (id, which) => {
        const n = sheet.querySelector('.cc-stk-item[data-id="' + id + '"] [data-act="' + which + '"]');
        if (n && !n.disabled) n.focus(); else { const p = sheet.querySelector('.cc-stk-item[data-id="' + id + '"] .cc-stk-prev'); if (p) p.focus(); }
      };
      if (act === 'rm') {
        const gone = list[i];
        list = list.filter(x => x.id !== gone.id);
        say('Removed ' + (gone.name || 'that sticker') + '.');
        changed();
        const next = list[Math.min(i, list.length - 1)];
        if (next) focusAfter(next.id, 'rm'); else { const u = $s('.cc-stk-up'); if (u) u.focus(); }
        if (peekItem && peekItem.id === gone.id) placePeek(true, true);
      } else if (act === 'left' || act === 'right') {
        const id = list[i].id;
        list = move(list, i, act === 'left' ? -1 : 1);
        changed();
        focusAfter(id, act);
      }
    }
    function addLink() {
      const inp = $s('#ccStkLink');
      const id = giphyId(inp.value);
      if (!id) { say('That doesn’t look like a GIPHY link. Open the sticker on giphy.com, copy its link, and paste it here.', true); return; }
      const it = { id: 'g' + id.slice(0, 20) + Date.now().toString(36), kind: 'giphy', src: id, name: 'GIPHY sticker', added: Date.now() };
      const ok = canAdd(list, it);
      if (!ok.ok) { say(ok.why, true); return; }
      list = list.concat([it]);
      inp.value = '';
      say('Added! It’s at the end of your drawer.');
      changed();
    }

    /* ---------------- uploads: shrink on the phone, keep see-through edges ---------------- */
    let seq = 0;
    const newId = () => 'u' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);
    const readAsDataUrl = f => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || '')); r.onerror = () => rej(new Error('read'));
      r.readAsDataURL(f);
    });
    function loadImage(f) {
      return new Promise((res, rej) => {
        const url = URL.createObjectURL(f);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(url); res(im); };
        im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
        im.src = url;
      });
    }
    async function fileToSticker(f) {
      if (!f || !/^image\//.test(f.type || '')) throw new Error('That file isn’t a picture.');
      if (f.size > 25 * 1024 * 1024) throw new Error('That picture is too big to open (over 25 MB).');
      const name = cleanName((f.name || 'my sticker').replace(/\.[a-z0-9]+$/i, '')) || 'my sticker';
      let src = '';
      if (f.type === 'image/gif' && f.size <= KEEP_GIF) src = await readAsDataUrl(f);   // stays animated
      else {
        let im;
        try { im = await loadImage(f); } catch (e) { throw new Error('Couldn’t open that picture — try a PNG or JPEG.'); }
        const sz = fitSize(im.naturalWidth || im.width, im.naturalHeight || im.height, MAX_SIDE);
        if (!sz) throw new Error('Couldn’t open that picture — try a PNG or JPEG.');
        const cv = doc.createElement('canvas');
        cv.width = sz.w; cv.height = sz.h;
        const cx = cv.getContext('2d');
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
        cx.clearRect(0, 0, sz.w, sz.h);     // transparent, never a white box
        cx.drawImage(im, 0, 0, sz.w, sz.h);
        src = cv.toDataURL('image/webp', 0.85);
        if (!/^data:image\/webp;/.test(src)) src = cv.toDataURL('image/png');
      }
      const ok = checkUpload(src);
      if (!ok.ok) throw new Error(ok.why);
      return { id: newId(), kind: 'upload', src, name, added: Date.now() };
    }
    async function addFiles(files) {
      if (!files.length) return;
      say('Adding ' + files.length + ' picture' + (files.length === 1 ? '' : 's') + '…');
      let added = 0, why = '';
      for (const f of files) {
        try {
          const it = await fileToSticker(f);
          const ok = canAdd(list, it);
          if (!ok.ok) { why = ok.why; break; }
          list = list.concat([it]);
          added++;
        } catch (e) { why = (e && e.message) || 'Couldn’t add that picture.'; }
      }
      if (added) changed();
      if (added && !why) say('Added ' + added + ' sticker' + (added === 1 ? '' : 's') + '!');
      else if (added) say('Added ' + added + '. ' + why, true);
      else say(why || 'Nothing was added.', true);
    }

    /* ---------------- mount / unmount with the theme ---------------- */
    let mounted = false;
    function refresh() {
      if (!mounted) return;
      renderGrid();
      placePeek(false);
    }
    function mount() {
      if (mounted) return;
      mounted = true;
      if (!list) loadLocal();
      buildFab();
      placePeek(true);
    }
    function unmount() {
      if (!mounted) return;
      mounted = false;
      closeSheet();
      removePeek();
      if (fab) { fab.remove(); fab = null; }
      if (sheet) { sheet.remove(); sheet = null; }
      if (layer) { layer.remove(); layer = null; }
      if (partyLayer) { partyLayer.remove(); partyLayer = null; }
      partyOn = false;
      flying.clear();
    }

    /* What it watches. The theme, the room tabs, the answer card appearing, and the party. */
    let hostRaf = 0;
    let reFresh = false, reAnim = false;
    const rehost = (animate, fresh) => {
      reFresh = reFresh || !!fresh; reAnim = reAnim || !!animate;
      if (hostRaf) return;
      hostRaf = requestAnimationFrame(guard(() => {
        hostRaf = 0;
        const a = reAnim, f = reFresh; reAnim = reFresh = false;
        if (mounted) placePeek(a, f);
      }));
    };
    const mo = new MutationObserver(guard(recs => {
      let theme = false, roomed = false, host = false, party = null;
      for (const r of recs) {
        const t = r.target;
        if (r.attributeName === 'data-theme' && t === body) theme = true;
        else if (r.attributeName === 'aria-selected') { if (t.getAttribute('aria-selected') === 'true' && t.matches('[role="tab"][data-room]')) roomed = true; }
        else if (r.attributeName === 'class') {
          if (t.id === 'party') party = t.classList.contains('on');
          else if (t === body && /\bsigned-in\b/.test((t.className || '') + ' ' + (r.oldValue || ''))) host = true;
        } else if (r.attributeName === 'style') { if (t.id === 'answerCard' || t === peekHost) host = true; }
      }
      if (theme) { if (on()) mount(); else unmount(); }
      if (!mounted) return;
      if (roomed) rehost(true, true);
      else if (host) rehost(false);
      if (party !== null) guard(onParty)(party);
    }));
    mo.observe(body, { attributes: true, subtree: true, attributeOldValue: true,
                       attributeFilter: ['data-theme', 'aria-selected', 'class', 'style'] });
    win.addEventListener('resize', guard(() => { if (mounted) fitSoon(); }));
    doc.addEventListener('cc:increase', guard(onIncrease));
    doc.addEventListener('cc:drawn', guard(onDrawn));
    doc.addEventListener('cc:stickerstore', guard(() => { if (list) pull(); }));
    if (mq) {
      const chg = guard(() => { if (mounted) { if (calm()) clearTimeout(idleT); else idleSoon(); } });
      if (mq.addEventListener) mq.addEventListener('change', chg); else if (mq.addListener) mq.addListener(chg);
    }

    loadLocal();
    if (on()) mount();
    pull();
  }
})();
