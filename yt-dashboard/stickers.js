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
 * Saved to your account. The page sets window.ccStickerStore = { load, save, who, key } (see
 * tiktok.html / index.html / compare.html): load() → { list, saved } from the account, or null
 * when not signed in; save(list) → stores it (and throws unless the Worker said ok); who → a
 * label when signed in, '' when not; key → 'tt' or 'yt'. A copy is cached in localStorage per
 * account ('cc_stickers:tt', 'cc_stickers:yt'; 'cc_stickers' when signed out) so it paints
 * instantly and works offline. The account wins when it answers, and nothing is saved to it
 * until it has answered at least once this visit (see makeSync).
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

  /* Two lists → one, for when you changed stickers before your account answered. The
     account's order comes first, then anything only this device has (matched by id and by
     GIPHY id), as far as the limits allow. Stickers removed here this visit (`gone`) are not
     brought back from the account. */
  function mergeLists(remote, local, gone) {
    const drop = gone instanceof Set ? gone : new Set(gone || []);
    const out = [];
    for (const it of cleanList(remote)) if (!drop.has(it.id)) out.push(it);
    for (const it of cleanList(local)) {
      if (out.some(x => x.id === it.id || (x.kind === 'giphy' && it.kind === 'giphy' && x.src === it.src))) continue;
      if (canAdd(out, it).ok) out.push(it);
    }
    return cleanList(out);
  }
  /* What this device keeps in localStorage. It shares the page's ~5 MB with the dashboard's
     own caches (history, snapshots, keywords), so it holds every GIPHY sticker (a few bytes
     each) but only as many uploads as fit in about 512 KB. Your account keeps them all. */
  const CACHE_CAP = 512 * 1024;
  function cacheList(list, cap) {
    cap = cap || CACHE_CAP;
    const out = [];
    let n = 2, trimmed = false;
    for (const it of cleanList(list)) {
      const b = JSON.stringify(it).length + 1;
      if (it.kind === 'upload' && n + b > cap) { trimmed = true; continue; }
      out.push(it); n += b;
    }
    return { list: out, trimmed };
  }
  /* What the account store's load() answered → { list, saved } or null (not signed in).
     A plain array is a list whose "ever saved" is unknown (saved: null). Anything else means
     the Worker has no sticker route yet (an older Worker answers 200 with something else). */
  function readReply(r) {
    if (r == null) return null;
    if (Array.isArray(r)) return { list: cleanList(r), saved: null };
    if (typeof r === 'object' && Array.isArray(r.list)) return { list: cleanList(r.list), saved: r.saved === true ? true : r.saved === false ? false : null };
    const e = new Error('old-worker'); e.code = 'old-worker'; throw e;
  }
  // an error from the account store: the route is missing (an older Worker) or it could not be reached
  const routeMissing = e => !!e && (e.code === 'old-worker' || e.status === 404 || e.status === 405);

  /* ---------------------------------------------------------------------------------
     Where the list is kept — the sync engine. No DOM here, so Node can drive it with a fake
     account store and fake timers (scripts/stickers.test.mjs).

     The account is the source of truth. Until it has answered this visit (pulledOk), your
     changes are kept on this device and nothing is sent — so a flaky network or a page that
     is still signing in can never save this device's list over the account's. When it
     answers: no changes here → the account's list; changes here → the two merged. Each
     account has its own copy on this device ('cc_stickers:tt' / 'cc_stickers:yt'), and
     'cc_stickers' is the signed-out list, so one account never seeds another.
     --------------------------------------------------------------------------------- */
  const LS = 'cc_stickers';
  const OLD_WORKER = 'Saved on this device only — your Worker doesn’t have sticker saving yet (update it to keep them in your account)';
  function makeSync(o) {
    // o: { store() → the page's ccStickerStore or null, ls (localStorage-like), setTimeout,
    //      clearTimeout, now(), active() → still mounted, onList() → repaint, onStatus(text, bad) }
    const T = o.setTimeout, C = o.clearTimeout, now = o.now || (() => Date.now());
    const guard = fn => function () { try { return fn.apply(this, arguments); } catch (e) {} };
    let list = null, localSrc = null, edited = false, saveT = 0, retryT = 0, tries = 0;
    let pulledKey = null, oldWorker = false, cacheTrimmed = false, pulling = false;
    const gone = new Set();          // stickers removed this visit: a merge must not bring them back
    const store = () => { const s = o.store(); return s && typeof s.load === 'function' && typeof s.save === 'function' ? s : null; };
    const who = () => { try { const s = store(); return s ? String(s.who || '') : ''; } catch (e) { return ''; } };
    // which account this device is talking to right now ('' when signed out)
    const acct = () => { try { const s = store(); return s && who() ? String(s.key || 'acct').replace(/[^a-z0-9_-]/gi, '').slice(0, 16) || 'acct' : ''; } catch (e) { return ''; } };
    const lsKey = k => (k ? LS + ':' + k : LS);
    const pulledOk = () => !!pulledKey && pulledKey === acct();
    const setSync = (t, bad) => { try { o.onStatus(t, !!bad); } catch (e) {} };
    const repaint = () => { try { o.onList(); } catch (e) {} };
    function readLocal(k) {
      try { const raw = o.ls.getItem(lsKey(k)); if (raw == null) return null; return cleanList(JSON.parse(raw)); }
      catch (e) { return null; }
    }
    function writeLocal() {
      const c = cacheList(list);
      cacheTrimmed = c.trimmed;
      try { o.ls.setItem(lsKey(acct()), JSON.stringify(c.list)); return true; } catch (e) { return false; }
    }
    const savedTo = () => 'Saved to your account' + (who() ? ' (' + who() + ')' : '');
    function deviceOnly() {
      setSync(cacheTrimmed ? 'Saved on this device only — sign in to keep your bigger pictures after you close the page'
                           : 'Saved on this device only');
    }
    function loadLocal() {
      const k = acct();
      let l = k ? readLocal(k) : null;
      localSrc = l ? 'account' : null;
      if (!l) { l = readLocal(''); if (l) localSrc = 'device'; }
      list = l || starterPack(now());
      if (who()) setSync('Loading from your account…'); else deviceOnly();
    }
    function retrySoon() {
      C(retryT);
      if (tries > 6) return;
      retryT = T(guard(() => { if (o.active()) { if (pulledOk()) saveNow(); else pull(); } }), Math.min(120000, 5000 * Math.pow(2, tries - 1)));
    }
    function failed(e) {
      if (routeMissing(e)) { oldWorker = true; C(retryT); setSync(OLD_WORKER); return; }
      tries++;
      setSync('Couldn’t reach your account — your stickers are kept on this device and will be saved when it answers', true);
      retrySoon();
    }
    async function pull() {
      const s = store();
      if (!s || !who()) { deviceOnly(); return; }
      if (oldWorker) { setSync(OLD_WORKER); return; }
      if (pulling) return;
      const k = acct();
      // a different account from the one this list came from, and nothing changed here: start from its own copy
      if (pulledKey !== k && !edited && localSrc !== 'account') loadLocal();
      pulling = true;
      let rep;
      try { rep = readReply(await s.load()); }
      catch (e) { pulling = false; failed(e); return; }
      pulling = false;
      if (!rep) { deviceOnly(); return; }
      if (acct() !== k) return;       // signed out or switched account while it was loading
      tries = 0; C(retryT);
      pulledKey = k;
      const remote = rep.list;
      let push = false;
      if (remote.length) {
        if (edited) { list = mergeLists(remote, list, gone); push = true; }
        else list = remote;
      } else if (rep.saved === true) {
        // you emptied this account's drawer on purpose: keep it empty unless you changed something here
        if (edited) push = true; else list = [];
      } else {
        // an account that has never saved: it takes what you have here (added before signing
        // in, or this account's own copy), or the starter pack on a new device
        if (!edited && !localSrc) list = starterPack(now());
        push = true;
      }
      writeLocal(); repaint();
      if (push) await saveNow(); else setSync(savedTo());
    }
    // the list was changed here (upload, remove, reorder…)
    function changed(next) {
      if (next) list = next;
      edited = true;
      for (const it of list) gone.delete(it.id);     // put back (undo, restore): not gone any more
      if (!writeLocal()) setSync('This device’s storage is full — your stickers may not be kept here', true);
      C(saveT);
      if (store() && who() && !pulledOk() && !oldWorker) {
        setSync('Kept on this device — it will be saved to your account once it answers');
        pull();
      } else saveT = T(guard(saveNow), 1200);
      repaint();
    }
    async function saveNow() {
      C(saveT);
      const s = store();
      if (!s || !who()) { deviceOnly(); return; }
      if (oldWorker) { setSync(OLD_WORKER); return; }
      if (!pulledOk()) { await pull(); return; }      // never save before the account has answered
      const k = acct();
      setSync('Saving…');
      try { await s.save(list.slice()); if (acct() === k) setSync(savedTo()); }
      catch (e) { failed(e); }
    }
    return {
      get list() { return list; },
      set list(v) { list = v; },
      get pulledOk() { return pulledOk(); },
      gone, loadLocal, pull, changed, saveNow,
      stop() { C(retryT); }
    };
  }

  const api = { ID_RE, UPLOAD_RE, MAX_N, MAX_TOTAL, MAX_UPLOAD, MAX_SIDE, CREDIT, STARTER,
    giphyId, giphyUrls, fitSize, dataUrlBytes, checkUpload, validItem, cleanList, canAdd,
    starterPack, restoreStarter, move, listBytes, mergeLists, cacheList, CACHE_CAP, readReply, routeMissing, makeSync, LS, OLD_WORKER };
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
    const el = (tag, cls, attrs) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };

    /* ---------------- the list: the sync engine above, wired to this page ---------------- */
    let syncText = '', syncBad = false;
    const sync = makeSync({ store: () => win.ccStickerStore, ls: (() => { try { return localStorage; } catch (e) { return null; } })() || { getItem: () => null, setItem() { throw new Error('no storage'); } },
      setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t), now: () => Date.now(),
      active: () => mounted, onList: () => refresh(), onStatus: (t, bad) => { syncText = t; syncBad = bad; paintSync(); } });
    const gone = sync.gone;
    const changed = next => sync.changed(next);
    const pull = () => sync.pull();

    /* ---------------- sticker pictures ---------------- */
    const dead = new Set();          // stickers that could not load this visit
    const keyOf = it => it.kind + ':' + (it.kind === 'giphy' ? it.src : it.id);
    const alive = () => (sync.list || []).filter(it => !dead.has(keyOf(it)));
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
    // re-fit whenever the page or the card changes size (fonts landing, a setup card moving)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(guard(() => { if (mounted) fitSoon(); })) : null;
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
      if (peekHost && peekHost !== host) { peekHost.classList.remove('cc-peek-host'); if (ro) ro.unobserve(peekHost); }
      if (ro && peekHost !== host) ro.observe(host);
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
       lower, so it never lies over anything you might tap. Below the card's top edge it dips
       into the card's own top padding — 16px at most, and less if a control inside the card
       (a tab row, a button) starts nearer the top than that. Measured again whenever the
       layout settles (ResizeObserver, fonts, load, resize), not only on the first frame. */
    let fitRaf = 0;
    function fitSoon() {
      if (fitRaf) return;
      fitRaf = requestAnimationFrame(guard(() => { fitRaf = 0; fitPeek(); }));
    }
    const CONTROLS = 'button, a[href], select, input, textarea, summary, label, [role="tab"], [role="button"]';
    function fitPeek() {
      if (!peek || !peekHost || !peek.isConnected) return;
      const hr = peekHost.getBoundingClientRect();
      const L = hr.right - 18 - 64 - 8, R = hr.right - 18 + 8;   // the widest the sticker can be, plus a margin
      let clear = 48, dip = 16;
      for (const n of doc.querySelectorAll(CONTROLS)) {
        if (peek.contains(n) || n.closest('.cc-stk-sheet, .drawer, #party')) continue;
        const r = n.getBoundingClientRect();
        if (!r.width || !r.height || r.right < L || r.left > R) continue;
        if (peekHost.contains(n)) {
          if (r.top >= hr.top - 1 && r.top < hr.top + 24) dip = Math.min(dip, Math.floor(r.top - hr.top - 4));
          continue;
        }
        if (r.bottom > hr.top + 1 || r.bottom < hr.top - 80) continue;
        clear = Math.min(clear, Math.floor(hr.top - r.bottom - 4));
      }
      dip = Math.max(0, dip);
      const size = Math.max(34, Math.min(64, Math.max(10, clear) + dip));
      peek.style.setProperty('--cc-rise', (size - dip) + 'px');
      peek.style.setProperty('--cc-size', size + 'px');
    }
    function removePeek() {
      if (peek) peek.remove();
      if (peekHost) { peekHost.classList.remove('cc-peek-host'); if (ro) ro.unobserve(peekHost); }
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
      // the GIPHY credit appears only once a GIPHY sticker has actually loaded — offline, or
      // with GIPHY blocked, nothing is shown and so nothing is credited
      const credit = () => {
        if (!partyLayer || partyLayer.querySelector('.cc-party-credit')) return;
        const c = el('span', 'cc-stk-credit cc-party-credit');
        c.textContent = CREDIT;
        partyLayer.appendChild(c);
      };
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
        const im = it.kind === 'giphy' && w.querySelector('img');
        if (im) { if (im.complete && im.naturalWidth) credit(); else im.addEventListener('load', guard(credit)); }
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
          // adding and the save status first, so on a phone they are in reach and in view;
          // the grid (which can be long) comes after
          '<div class="cc-stk-add">' +
            '<button type="button" class="primary cc-stk-up">📷 Upload from phone</button>' +
            '<input type="file" class="cc-stk-file" accept="image/*" multiple hidden>' +
            '<form class="cc-stk-giphy" novalidate>' +
              '<label for="ccStkLink">Add from a GIPHY link</label>' +
              '<div class="cc-stk-row"><input id="ccStkLink" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://giphy.com/stickers/…">' +
              '<button type="submit" class="ghost">Add</button></div>' +
            '</form>' +
          '</div>' +
          '<p class="cc-stk-msg" role="status" aria-live="polite"></p>' +
          '<p class="cc-stk-sync"></p>' +
          '<ul class="cc-stk-grid" aria-label="Your stickers"></ul>' +
          '<button type="button" class="ghost cc-stk-starter">Restore starter pack</button>' +
          '<p class="cc-stk-limits">Up to 24 stickers and about 3 MB altogether. Photos are shrunk to 320 px so they load fast (big animated GIFs become still pictures). Pictures with see-through backgrounds look best. Your account keeps them all; this device keeps a copy of the GIPHY ones and about 512 KB of your own pictures for offline.</p>' +
          '<div class="cc-stk-foot"><p class="cc-stk-credit">' + CREDIT + '</p>' +
            '<button type="button" class="primary cc-stk-done">Done</button></div>' +
        '</div>';
      body.appendChild(sheet);
      $s('.cc-stk-scrim').addEventListener('click', guard(closeSheet));
      $s('.cc-stk-x').addEventListener('click', guard(closeSheet));
      $s('.cc-stk-done').addEventListener('click', guard(closeSheet));
      $s('.cc-stk-msg').addEventListener('click', guard(e => { if (e.target.closest && e.target.closest('.cc-stk-undo')) undo(); }));
      $s('.cc-stk-up').addEventListener('click', guard(() => $s('.cc-stk-file').click()));
      $s('.cc-stk-file').addEventListener('change', guard(e => { const f = Array.from(e.target.files || []); e.target.value = ''; addFiles(f); }));
      $s('.cc-stk-giphy').addEventListener('submit', guard(e => { e.preventDefault(); addLink(); }));
      $s('.cc-stk-starter').addEventListener('click', guard(() => {
        const before = sync.list.length;
        sync.list = restoreStarter(sync.list, Date.now());
        const n = sync.list.length - before;
        say(n ? 'Added ' + n + ' starter sticker' + (n === 1 ? '' : 's') + ' back.' :
          (sync.list.length >= MAX_N ? 'Your drawer is full (24) — remove one first.' : 'The starter pack is all here already.'));
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
        const i = sync.list.findIndex(x => x.id === dragId), j = sync.list.findIndex(x => x.id === li.dataset.id);
        dragId = null;
        if (i < 0 || j < 0 || i === j) return;
        sync.list = move(sync.list, i, j - i);
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
    // `withUndo`: a small Undo button after the message, for as long as the message shows
    function say(t, bad, withUndo) {
      const m = $s('.cc-stk-msg');
      if (!m) return;
      m.textContent = t || '';
      m.classList.toggle('bad', !!bad);
      if (!withUndo) lastGone = null;
      if (t && withUndo) {
        const u = el('button', 'cc-stk-undo', { type: 'button' });
        u.textContent = 'Undo';
        m.appendChild(u);
      }
      clearTimeout(msgT);
      if (t) msgT = setTimeout(guard(() => { if (m.textContent.indexOf(t) === 0) { m.textContent = ''; lastGone = null; } }), withUndo ? 8000 : 7000);
    }
    let lastGone = null;             // { item, index } of the sticker just removed
    function undo() {
      const g = lastGone;
      lastGone = null;
      if (!g) return;
      const ok = canAdd(sync.list, g.item);
      if (!ok.ok) { say(ok.why, true); return; }
      const out = sync.list.slice();
      out.splice(Math.min(g.index, out.length), 0, g.item);
      sync.list = out;
      gone.delete(g.item.id);
      say('Put ' + (g.item.name || 'it') + ' back.');
      changed();
      const p = sheet && sheet.querySelector('.cc-stk-item[data-id="' + g.item.id + '"] .cc-stk-prev');
      if (p) p.focus();
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
      sync.list.forEach((it, i) => {
        const nm = it.name || (it.kind === 'giphy' ? 'GIPHY sticker' : 'your picture');
        const li = el('li', 'cc-stk-item', { draggable: 'true' });
        li.dataset.id = it.id;
        const pv = el('button', 'cc-stk-prev', { type: 'button', 'aria-label': 'Preview ' + nm + ' (sticker ' + (i + 1) + ' of ' + sync.list.length + ')' });
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
        r.textContent = '▶'; r.disabled = i === sync.list.length - 1;
        mv.appendChild(l); mv.appendChild(r);
        li.appendChild(pv); li.appendChild(rm); li.appendChild(mv);
        grid.appendChild(li);
      });
      if (!sync.list.length) {
        const li = el('li', 'cc-stk-empty');
        li.textContent = 'No stickers yet — upload one, paste a GIPHY link, or restore the starter pack.';
        grid.appendChild(li);
      }
      const bytes = listBytes(sync.list);
      const lim = $s('.cc-stk-limits');
      if (lim) lim.dataset.used = sync.list.length + ' of 24 · ' + (bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB') + ' of 3 MB';
    }
    function onGridClick(e) {
      const b = e.target.closest && e.target.closest('button');
      const li = b && b.closest('.cc-stk-item');
      if (!li) return;
      const i = sync.list.findIndex(x => x.id === li.dataset.id);
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
        const was = sync.list[i];
        sync.list = sync.list.filter(x => x.id !== was.id);
        gone.add(was.id);
        say('Removed ' + (was.name || 'that sticker') + '.', false, true);
        lastGone = { item: was, index: i };
        changed();
        const next = sync.list[Math.min(i, sync.list.length - 1)];
        if (next) focusAfter(next.id, 'rm'); else { const u = $s('.cc-stk-up'); if (u) u.focus(); }
        if (peekItem && peekItem.id === was.id) placePeek(true, true);
      } else if (act === 'left' || act === 'right') {
        const id = sync.list[i].id;
        sync.list = move(sync.list, i, act === 'left' ? -1 : 1);
        changed();
        focusAfter(id, act);
      }
    }
    function addLink() {
      const inp = $s('#ccStkLink');
      const id = giphyId(inp.value);
      if (!id) { say('That doesn’t look like a GIPHY link. Open the sticker on giphy.com, copy its link, and paste it here.', true); return; }
      const it = { id: 'g' + id.slice(0, 20) + Date.now().toString(36), kind: 'giphy', src: id, name: 'GIPHY sticker', added: Date.now() };
      const ok = canAdd(sync.list, it);
      if (!ok.ok) { say(ok.why, true); return; }
      sync.list = sync.list.concat([it]);
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
          const ok = canAdd(sync.list, it);
          if (!ok.ok) { why = ok.why; break; }
          sync.list = sync.list.concat([it]);
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
    // Nothing — no reading, no network, no page-wide observer — until the Cinnamoroll theme
    // is chosen: a person who never picks it never has stickers saved for them.
    function mount() {
      if (mounted) return;
      mounted = true;
      if (!sync.list) sync.loadLocal();
      buildFab();
      watch();
      placePeek(true);
      pull();
    }
    function unmount() {
      if (!mounted) return;
      mounted = false;
      unwatch();
      closeSheet();
      removePeek();
      sync.stop();
      if (fab) { fab.remove(); fab = null; }
      if (sheet) { sheet.remove(); sheet = null; }
      if (layer) { layer.remove(); layer = null; }
      if (partyLayer) { partyLayer.remove(); partyLayer = null; }
      partyOn = false;
      flying.clear();
    }

    /* What it watches. Always: only body's data-theme. While mounted: the room tabs, the
       answer card appearing, the party, and the peeking sticker's card changing size (so its
       fit is re-measured whenever the layout settles, not only on the first frame). */
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
    const themeMo = new MutationObserver(guard(() => { if (on()) mount(); else unmount(); }));
    themeMo.observe(body, { attributes: true, attributeFilter: ['data-theme'] });
    let pageMo = null;
    function watch() {
      if (!pageMo) pageMo = new MutationObserver(guard(recs => {
        let roomed = false, host = false, party = null;
        for (const r of recs) {
          const t = r.target;
          if (r.attributeName === 'aria-selected') { if (t.getAttribute('aria-selected') === 'true' && t.matches('[role="tab"][data-room]')) roomed = true; }
          else if (r.attributeName === 'class') {
            if (t.id === 'party') party = t.classList.contains('on');
            else if (t === body && /\bsigned-in\b/.test((t.className || '') + ' ' + (r.oldValue || ''))) host = true;
          } else if (r.attributeName === 'style') { if (t.id === 'answerCard' || t === peekHost) host = true; }
        }
        if (!mounted) return;
        if (roomed) rehost(true, true);
        else if (host) rehost(false);
        if (party !== null) guard(onParty)(party);
      }));
      pageMo.observe(body, { attributes: true, subtree: true, attributeOldValue: true,
                             attributeFilter: ['aria-selected', 'class', 'style'] });
      if (ro) { ro.observe(body); }
    }
    function unwatch() {
      if (pageMo) pageMo.disconnect();
      if (ro) ro.disconnect();
    }
    win.addEventListener('resize', guard(() => { if (mounted) fitSoon(); }));
    win.addEventListener('load', guard(() => { if (mounted) fitSoon(); }));
    try { if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(guard(() => { if (mounted) fitSoon(); })); } catch (e) {}
    doc.addEventListener('cc:increase', guard(onIncrease));
    doc.addEventListener('cc:drawn', guard(onDrawn));
    // the page just signed in (or out): the account to talk to has changed
    doc.addEventListener('cc:stickerstore', guard(() => { if (mounted) pull(); }));
    if (mq) {
      const chg = guard(() => { if (mounted) { if (calm()) clearTimeout(idleT); else idleSoon(); } });
      if (mq.addEventListener) mq.addEventListener('change', chg); else if (mq.addListener) mq.addListener(chg);
    }

    if (on()) mount();
  }
})();
