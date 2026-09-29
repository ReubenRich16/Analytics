/* Channel Command — motion.js
 *
 * One shared, dependency-free layer of motion for all three pages. It reads what the pages
 * render and nothing on a page ever calls into it, so if this file fails to load — or
 * throws — the pages look exactly as they did before it existed: every chart fully drawn,
 * every number exactly as the page wrote it.
 *
 * What it adds
 *   • Charts draw themselves in (lines left→right, bars up from the baseline, dots popping,
 *     horizontal bars growing) the first time you SEE them: on load, on switching room, on
 *     opening the drawer, and after you press something inside a card. The pages repaint
 *     their cards on every poll (30–120 s) by replacing innerHTML; a repaint with no action
 *     from you in between is recognised by its key and stays still.
 *   • Headline numbers count up from 0 on the same rule. A count always FINISHES on the
 *     page's own text, byte for byte, and if the page writes anything to the element while
 *     a count is running the count stops at once and the page's text stands.
 *   • The room you switch to slides in from the side you moved towards, with a pill that
 *     glides under the tabs.
 *   • When a live total goes up on a poll, a brief green glow and a "▲ +N" chip — N is the
 *     page's own delta text, copied, never a number worked out here. Anything a page marks
 *     .cc-win (a genuine record) gets a sparkle the first time it is shown.
 *
 * prefers-reduced-motion: reduce → it does nothing at all, and text is never touched.
 *
 * The number helpers at the top are pure and exported for Node, so scripts/motion.test.mjs
 * can prove every format it accepts round-trips exactly. */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------------------
     Count-up parsing. Deliberately narrow: ONE number, an optional sign, thousands
     separators, one decimal part, and an optional unit/word suffix — "+1,234", "−7",
     "8.6%", "35,436 views", "12.5k", "8.6% like rate". Anything else is left alone:
     two numbers ("3 of 5"), words before the number ("Top 12%"), dates, times, "3h ago",
     ranges, durations ("5 days"). A string only qualifies if formatting its own value
     reproduces it exactly, so the last frame of a count is, by construction, the page's
     text — and the animator writes the original string back anyway. */
  const NUM_RE = /^([+−-]?)((?:[1-9]\d{0,2}(?:,\d{3})+)|0|[1-9]\d*)(?:\.(\d{1,3}))?([%kKMB]?)((?: [A-Za-z]+(?:\/[A-Za-z]+)?){0,3})$/;
  // a word after the number that makes it a time, a date or a duration rather than a count
  const TIME_WORD = /^(?:ago|am|pm|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|daily|wk|wks|week|weeks|weekly|mo|mos|month|months|monthly|y|yr|yrs|year|years|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|tonight|yesterday|tomorrow|midnight|noon|old|since|until)$/i;

  function formatCount(p, v) {
    const s = Math.max(0, v).toFixed(p.decimals);
    const dot = s.indexOf('.');
    let ip = dot < 0 ? s : s.slice(0, dot);
    const fp = dot < 0 ? '' : s.slice(dot);
    if (p.grouped) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return p.sign + ip + fp + p.suffix;
  }

  function parseCount(s) {
    if (typeof s !== 'string' || !s || s.length > 48) return null;
    const m = NUM_RE.exec(s);
    if (!m) return null;
    const words = m[5] ? m[5].trim().split(/[ /]/) : [];
    for (const w of words) if (TIME_WORD.test(w)) return null;
    const dec = m[3] || '';
    const value = Number(m[2].replace(/,/g, '') + (dec ? '.' + dec : ''));
    if (!isFinite(value) || value > 1e15) return null;
    const p = { sign: m[1], value, decimals: dec.length, grouped: m[2].indexOf(',') >= 0, suffix: m[4] + m[5] };
    // the guarantee everything else rests on: this format reproduces the original exactly
    if (formatCount(p, value) !== s) return null;
    return p;
  }

  // The text for fraction k ∈ [0,1] of a count. Ease-out, and floored to the displayed
  // precision so no frame ever shows more than the real value; k ≥ 1 is the real value.
  function countFrame(p, k) {
    if (!(k < 1)) return formatCount(p, p.value);
    const e = 1 - Math.pow(1 - Math.max(0, k), 4);
    const f = Math.pow(10, p.decimals);
    const v = Math.floor(p.value * e * f + 1e-7) / f;
    return formatCount(p, Math.min(v, p.value));
  }

  const api = { parseCount, formatCount, countFrame };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  try { boot(); } catch (e) { /* decoration only: a failure here must never reach the page */ }

  function boot() {
    const doc = document, body = doc.body, win = window;
    if (!body || typeof MutationObserver !== 'function' || typeof requestAnimationFrame !== 'function') return;
    const mq = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const calm = () => !!(mq && mq.matches);
    if (calm()) return;
    const now = () => (win.performance && performance.now ? performance.now() : Date.now());
    const guard = fn => function () { try { return fn.apply(this, arguments); } catch (e) { /* never the page's problem */ } };

    /* ---------------- what gets animated ---------------- */
    const KINDS = [
      ['chart', 'svg.chart'], ['spark', 'svg.spark'], ['bars', '.bars'], ['hrow', '.hbar-row'],
      ['gbar', '.gbar'], ['pj', '.pjtrack'], ['pct', '.pctbox .track'], ['t1k', '.t1krow'],
      ['grid', '.metric-grid, .bignums']
    ];
    const KIND_SEL = {};
    KINDS.forEach(k => { KIND_SEL[k[0]] = k[1]; });
    const UNIT_SEL = KINDS.map(k => k[1]).join(', ');
    const NUM_SEL = '.stat-num, .mcell .val, .abody .af, .tile .v, .mrow .v, #party .pnum, [data-count]';
    const WIN_SEL = '.cc-win';
    const kindOf = el => { for (const k of KINDS) if (el.matches(k[1])) return k[0]; return null; };

    /* ---------------- the gate ----------------
       A unit's key is stable across repaints: its own id, or the nearest ancestor id plus
       its position among units of the same kind (and the same aria-label, digits stripped)
       under that ancestor. `seen` holds the epoch each key last animated in. A key never
       seen before animates; after that it animates again only inside a RESET — a scope
       (a room, the drawer, a card you pressed) opened by something you did, for a short
       window. A poll repaint happens outside any reset, so it finds its keys already seen
       and stays still. */
    const seen = new Map();
    let epoch = 1;
    const resets = [];
    function reset(scope, ms) {
      epoch++;
      resets.push({ scope: scope || null, epoch, until: now() + ms });
      if (resets.length > 48) resets.shift();
    }
    function activeReset(el, t) {
      for (let i = resets.length - 1; i >= 0; i--) {
        const r = resets[i];
        if (t > r.until) continue;
        if (!r.scope || r.scope === el || r.scope.contains(el)) return r;
      }
      return null;
    }
    function fresh(el, key, t) {
      const rec = seen.get(key);
      if (rec === undefined) return true;
      const r = activeReset(el, t);
      return !!(r && rec < r.epoch);
    }
    const sigOf = el => {
      const a = el.getAttribute && el.getAttribute('aria-label');
      return a ? a.replace(/[\d.,:%+−-]+/g, '#').slice(0, 80) : '';
    };
    function keyOf(el, kind, sel, cache) {
      if (el.id) return kind + '#' + el.id;
      let anc = el.parentElement;
      while (anc && !anc.id) anc = anc.parentElement;
      const sig = sigOf(el);
      const ck = kind + '|' + (anc ? anc.id : '') + '|' + sig;
      let list = cache.get(ck);
      if (!list) {
        list = Array.prototype.filter.call((anc || doc).querySelectorAll(sel), e => sigOf(e) === sig);
        cache.set(ck, list);
      }
      return ck + '|' + list.indexOf(el);
    }
    const shown = el => el.isConnected && el.getClientRects().length > 0;
    const vh = () => win.innerHeight || doc.documentElement.clientHeight || 800;
    // Under automation (a screenshot harness) nothing waits to be scrolled to, so a
    // full-page capture shows finished charts rather than ones frozen at their first frame.
    const deferOK = typeof IntersectionObserver === 'function' && !(navigator && navigator.webdriver);
    const inView = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < vh(); };

    /* ---------------- draw-ins ----------------
       measure() only READS (lengths, positions, classification); apply() only WRITES.
       Every effect is a CSS animation under .cc-draw in style.css with fill-mode
       `backwards` and a from-only keyframe, so when it ends the element is back on its
       own styles exactly — an inline opacity:.35 on a faded series stays .35. */
    const waiting = new Set();
    const waitingNums = new Map();
    const io = deferOK ? new IntersectionObserver(guard(onSeen), { rootMargin: '0px 0px -4% 0px' }) : null;

    function barDir(d) {
      const m = /^M\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)\s*V\s*(-?[\d.]+)/.exec(d || '');
      if (!m) return null;
      return +m[3] <= +m[2] ? 'up' : 'down';
    }
    function lenOf(p) {
      try { const l = p.getTotalLength(); return isFinite(l) && l > 0 ? l : 0; } catch (e) { return 0; }
    }
    function siblingIndex(el, sel) {
      let i = 0, s = el.previousElementSibling;
      while (s) { if (s.matches(sel)) i++; s = s.previousElementSibling; }
      return i;
    }
    function measure(el, kind, base) {
      const ops = [];   // [node, className|null, {var: value}]
      const add = (n, cls, vars) => ops.push([n, cls, vars || null]);
      if (kind === 'chart') {
        const bars = [];
        for (const p of el.querySelectorAll('path')) {
          if (p.closest('defs, clipPath')) continue;
          if (p.classList.contains('line')) {
            // a dashed line keeps its dashes: drawing it would overwrite them for a second
            if (/stroke-dasharray/.test(p.getAttribute('style') || '')) continue;
            if (p.hasAttribute('pathLength')) { add(p, 'cc-line'); continue; }
            const len = lenOf(p);
            if (len) add(p, 'cc-line', { '--cc-len': (len + 2).toFixed(1) });
          } else if (/^url\(/.test(p.getAttribute('fill') || '')) {
            // the area wash: style.css animates it by attribute (or by its clip-path wipe)
          } else {
            const dir = barDir(p.getAttribute('d'));
            if (dir) bars.push([p, dir]); else add(p, 'cc-extra');
          }
        }
        for (const r of el.querySelectorAll('rect')) {
          if (r.closest('defs, clipPath') || r.classList.contains('cband') || r.classList.contains('rowhit')) continue;
          bars.push([r, 'up']);
        }
        const bStep = Math.min(24, 460 / Math.max(1, bars.length));
        bars.forEach(([b, dir], i) => add(b, dir === 'down' ? 'cc-bar cc-down' : 'cc-bar', { '--cc-d': Math.round(i * bStep) + 'ms' }));
        const tracks = el.querySelectorAll('line.rowtrack');
        tracks.forEach((ln, i) => add(ln, null, { '--cc-d': (i * 45) + 'ms' }));
        const pts = el.querySelectorAll('circle.pt');
        const pStep = Math.min(14, 520 / Math.max(1, pts.length));
        pts.forEach((c, i) => add(c, null, { '--cc-d': Math.round(tracks.length ? i * 45 + 380 : i * pStep) + 'ms' }));
        for (const c of el.querySelectorAll('circle:not(.pt):not(.cdot):not(.end-dot)')) add(c, 'cc-end');
      } else if (kind === 'spark') {
        const p = el.querySelector('path');
        const len = p ? lenOf(p) : 0;
        if (len) add(p, 'cc-line', { '--cc-len': (len + 2).toFixed(1) });
      } else if (kind === 'bars') {
        const kids = el.querySelectorAll('.bar');
        const step = Math.min(22, 420 / Math.max(1, kids.length));
        kids.forEach((b, i) => add(b, null, { '--cc-d': Math.round(i * step) + 'ms' }));
      } else if (kind === 'hrow' || kind === 'gbar' || kind === 't1k') {
        const i = Math.min(12, siblingIndex(el, KIND_SEL[kind]));
        add(el, null, { '--cc-d': (i * (kind === 'hrow' ? 45 : 90)) + 'ms' });
      } else if (kind === 'grid') {
        let i = 0;
        for (const c of el.children) if (c.classList.contains('mcell')) add(c, null, { '--cc-d': (Math.min(12, i++) * 38) + 'ms' });
      }
      return { el, ops, base: Math.round(base || 0), wait: deferOK && !inView(el) };
    }
    function apply(d) {
      for (const [n, cls, vars] of d.ops) {
        if (cls) cls.split(' ').forEach(c => n.classList.add(c));
        if (vars) for (const k in vars) n.style.setProperty(k, vars[k]);
      }
      if (d.base) d.el.style.setProperty('--cc-base', d.base + 'ms'); else d.el.style.removeProperty('--cc-base');
      d.el.classList.remove('cc-still');
      d.el.classList.add('cc-draw');
      if (d.wait) { d.el.classList.add('cc-wait'); waiting.add(d.el); io.observe(d.el); }
      else unwait(d.el);
    }
    function still(el) {
      if (el.classList.contains('cc-draw')) el.classList.remove('cc-draw');
      unwait(el);
      el.classList.add('cc-still');
    }
    function unwait(el) {
      if (el.classList.contains('cc-wait')) el.classList.remove('cc-wait');
      if (waiting.delete(el) && io) io.unobserve(el);
    }
    function onSeen(entries) {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target;
        if (waiting.has(el)) unwait(el);
        if (waitingNums.has(el)) {
          const base = waitingNums.get(el);
          waitingNums.delete(el);
          if (io) io.unobserve(el);
          startCount(el, base);
        }
      }
    }

    /* ---------------- count-ups ----------------
       The count owns the element's single text node and only ever edits that node's data.
       The pages write numbers with textContent, which REPLACES the node — so a changed
       node, extra children, or data that is not what this code last wrote all mean the
       page has spoken, and the count stops without writing another character. */
    const counting = new Map();
    // Text nodes this file has ever written into. The pages never edit a text node's data
    // (they replace it with textContent/innerHTML), so a characterData change on one of
    // these is always our own frame — including the final write-back, which lands in the
    // NEXT flush, after the count has ended, and must not read as the page writing anew.
    const ours = new WeakSet();
    let countRaf = 0;
    function singleText(el) {
      const tn = el.firstChild;
      return tn && tn.nodeType === 3 && el.childNodes.length === 1 ? tn : null;
    }
    function startCount(el, base) {
      if (calm() || !el.isConnected) return;
      stopCount(el);   // first: a running count puts the real text back before it is read
      const tn = singleText(el);
      if (!tn) return;
      const p = parseCount(tn.data);
      if (!p || !(p.value > 0)) return;
      const job = { el, tn, original: tn.data, p, last: tn.data, t0: null,
                    base: Math.min(320, base || 0), dur: p.value < 10 && !p.decimals ? 650 : 950 };
      counting.set(el, job);
      ours.add(tn);
      el.classList.add('cc-counting');
      write(job, countFrame(p, 0));
      if (!countRaf) countRaf = requestAnimationFrame(guard(tickCounts));
    }
    function write(job, s) { if (job.tn.data !== s) job.tn.data = s; job.last = s; }
    function intact(job) {
      return job.el.firstChild === job.tn && job.el.childNodes.length === 1 && job.tn.data === job.last;
    }
    // Ends a count. The original goes back ONLY onto our own, untouched node — if the page
    // has written since, `intact` is false and the page's text is left exactly as it is.
    function endCount(job) {
      counting.delete(job.el);
      try {
        if (intact(job) && job.tn.data !== job.original) job.tn.data = job.original;
      } catch (e) {}
      job.el.classList.remove('cc-counting');
    }
    function stopCount(el) { const j = counting.get(el); if (j) endCount(j); }
    function finishAll() { Array.from(counting.values()).forEach(endCount); }
    function tickCounts() {
      countRaf = 0;
      const t = now();
      for (const job of Array.from(counting.values())) {
        try {
          if (!intact(job)) { endCount(job); continue; }   // the page spoke: stop, write nothing
          if (job.t0 === null) job.t0 = t + job.base;
          const k = (t - job.t0) / job.dur;
          if (k >= 1) { write(job, job.original); endCount(job); continue; }
          write(job, countFrame(job.p, k < 0 ? 0 : k));
        } catch (e) { endCount(job); }
      }
      if (counting.size) countRaf = requestAnimationFrame(guard(tickCounts));
    }
    // a hidden tab stops rAF, so a count would sit mid-way until you came back: finish now
    doc.addEventListener('visibilitychange', guard(() => { if (doc.hidden) finishAll(); }));
    win.addEventListener('beforeprint', guard(finishAll));

    /* ---------------- little rewards ---------------- */
    const chipAt = new WeakMap();
    function celebrateDelta(de, t) {
      if (!de.classList.contains('up')) return;
      const txt = (de.textContent || '').trim();
      if (!/^\+\d{1,3}(?:,\d{3})*$/.test(txt)) return;   // the page's own "+N", nothing else
      const tile = de.closest('.stat');
      if (!tile || !shown(tile) || !inView(tile)) return;
      if (t - (chipAt.get(tile) || -1e9) < 900) return;
      chipAt.set(tile, t);
      return () => {
        const chip = doc.createElement('span');
        chip.className = 'cc-chip'; chip.setAttribute('aria-hidden', 'true');
        chip.textContent = '▲ ' + txt;
        const ring = doc.createElement('span');
        ring.className = 'cc-glow'; ring.setAttribute('aria-hidden', 'true');
        tile.appendChild(ring); tile.appendChild(chip);
        setTimeout(guard(() => { chip.remove(); ring.remove(); }), 1700);
      };
    }
    function sparkle(el) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const R = Math.max(28, Math.min(96, Math.max(r.width, r.height) / 2 + 16));
      return () => {
        const box = doc.createElement('div');
        box.className = 'cc-sparks'; box.setAttribute('aria-hidden', 'true');
        box.style.left = cx.toFixed(1) + 'px'; box.style.top = cy.toFixed(1) + 'px';
        const n = 10;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + 0.35;
          const s = doc.createElement('i');
          s.textContent = i % 2 ? '✦' : '✧';
          s.style.setProperty('--dx', (Math.cos(a) * R).toFixed(1) + 'px');
          s.style.setProperty('--dy', (Math.sin(a) * R * 0.8).toFixed(1) + 'px');
          s.style.setProperty('--d', (i % 3) * 40 + 'ms');
          box.appendChild(s);
        }
        body.appendChild(box);
        el.classList.remove('cc-win-go'); void el.offsetWidth; el.classList.add('cc-win-go');
        setTimeout(guard(() => { box.remove(); el.classList.remove('cc-win-go'); }), 1400);
      };
    }

    /* ---------------- rooms: direction, slide, glider ---------------- */
    const roomTabs = () => Array.from(doc.querySelectorAll('[role="tab"][data-room]'));
    const selectedIdx = () => roomTabs().findIndex(b => b.getAttribute('aria-selected') === 'true');
    let lastRoom = selectedIdx();
    let roomT = 0, slideReq = false;
    function slidePane(pane) {
      const idx = selectedIdx();
      const dir = lastRoom >= 0 && idx >= 0 && idx !== lastRoom ? (idx > lastRoom ? 'fwd' : 'back') : null;
      if (idx >= 0) lastRoom = idx;
      if (!dir || body.classList.contains('onepage-on')) return null;
      slideReq = true;
      return () => {
        body.setAttribute('data-roomdir', dir);
        body.classList.add('cc-rooming');
        pane.classList.add('cc-roomin');
        clearTimeout(roomT);
        roomT = setTimeout(guard(() => {
          body.classList.remove('cc-rooming');
          doc.querySelectorAll('.room-pane.cc-roomin').forEach(p => p.classList.remove('cc-roomin'));
        }), 460);
      };
    }
    const gliders = new Map();   // .tabs → glider span
    function placeGlider(tabs, animate) {
      const g = gliders.get(tabs);
      if (!g || !g.isConnected) return;
      const sel = tabs.querySelector('[role="tab"][aria-selected="true"]');
      if (!sel || sel.offsetParent !== tabs || !sel.offsetWidth || !sel.offsetHeight) {
        tabs.classList.remove('cc-glide');   // hidden or unmeasurable: the button's own pill shows
        return;
      }
      const x = sel.offsetLeft, y = sel.offsetTop, w = sel.offsetWidth, h = sel.offsetHeight;
      const jump = !animate || !tabs.classList.contains('cc-glide');
      if (jump) g.classList.add('cc-noanim');
      g.style.width = w + 'px'; g.style.height = h + 'px';
      g.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      tabs.classList.add('cc-glide');
      if (jump) { void g.offsetWidth; g.classList.remove('cc-noanim'); }
    }
    let glideRaf = 0, glideAnim = false;
    function glideSoon(animate) {
      glideAnim = glideAnim || !!animate;
      if (glideRaf) return;
      glideRaf = requestAnimationFrame(guard(() => {
        glideRaf = 0;
        const a = glideAnim; glideAnim = false;
        if (calm()) return;
        gliders.forEach((g, tabs) => placeGlider(tabs, a));
      }));
    }
    function setupGliders() {
      const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(guard(() => glideSoon(false))) : null;
      doc.querySelectorAll('.tabs').forEach(tabs => {
        if (!tabs.querySelector('[role="tab"][data-room]') || gliders.has(tabs)) return;
        const g = doc.createElement('span');
        g.className = 'cc-glider'; g.setAttribute('aria-hidden', 'true');
        tabs.insertBefore(g, tabs.firstChild);
        gliders.set(tabs, g);
        if (ro) { ro.observe(tabs); tabs.querySelectorAll('[role="tab"]').forEach(b => ro.observe(b)); }
      });
      win.addEventListener('resize', guard(() => glideSoon(false)));
      if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(guard(() => glideSoon(false)), () => {});
      glideSoon(false);
    }

    /* ---------------- the batch ----------------
       The observer only queues; the work happens once per frame. Reads (visibility,
       lengths, positions) all come before writes (classes, text), so a repaint costs one
       layout rather than one per chart. */
    let queue = [], queued = false, booting = true;
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(guard(flush)); } };
    const mo = new MutationObserver(guard(recs => {
      if (queue.length > 6000) queue = queue.slice(-3000);
      for (const r of recs) queue.push(r);
      schedule();
    }));
    const hasCls = (s, c) => (' ' + (s || '') + ' ').indexOf(' ' + c + ' ') >= 0;
    const cardBase = el => {
      const c = el.closest('.card, .grid');
      const i = c ? parseFloat(c.style.getPropertyValue('--i')) : 0;
      return (isFinite(i) ? i : 0) * 70 + 90;
    };

    function flush() {
      queued = false;
      const recs = queue; queue = [];
      if (calm()) return;
      const t = now();
      const units = new Map(), nums = new Map(), wins = new Map(), deltas = new Set();
      const later = [];     // write-phase closures
      const put = (map, el, force, base) => {
        const o = map.get(el);
        if (!o) map.set(el, { force, base });
        else { o.force = o.force || force; o.base = Math.max(o.base, base); }
      };
      const scan = (root, force, base) => {
        if (!root || root.nodeType !== 1) return;
        const b = el => (typeof base === 'function' ? base(el) : base);
        if (root.matches(UNIT_SEL)) put(units, root, force, b(root));
        if (root.matches(NUM_SEL)) put(nums, root, force, b(root));
        if (root.matches(WIN_SEL)) put(wins, root, force, b(root));
        if (!root.firstElementChild) return;
        root.querySelectorAll(UNIT_SEL).forEach(e => put(units, e, force, b(e)));
        root.querySelectorAll(NUM_SEL).forEach(e => put(nums, e, force, b(e)));
        root.querySelectorAll(WIN_SEL).forEach(e => put(wins, e, force, b(e)));
      };

      if (booting) {
        booting = false;
        scan(body, false, 80);   // whatever the page drew before this file ran is a first sighting
      }

      // 1. attribute changes carry the resets: a room opening, the drawer, the party, One page
      for (const r of recs) {
        if (r.type !== 'attributes') continue;
        const el = r.target;
        if (el.nodeType !== 1) continue;
        if (r.attributeName === 'aria-selected') { if (el.matches('[role="tab"][data-room]')) glideSoon(true); continue; }
        const cls = el.getAttribute('class') || '', old = r.oldValue || '';
        if (el === body) {
          if (hasCls(cls, 'onepage-on') && !hasCls(old, 'onepage-on')) { reset(null, 1500); scan(body, true, cardBase); }
          continue;
        }
        const cl = el.classList;
        if (cl.contains('room-pane')) {
          if (hasCls(cls, 'on') && !hasCls(old, 'on') && !body.classList.contains('onepage-on')) {
            reset(el, 1500);
            scan(el, true, cardBase);
            const slide = slidePane(el);
            if (slide) later.push(slide);
            glideSoon(true);
          }
        } else if (cl.contains('drawer')) {
          if (hasCls(cls, 'opening') && !hasCls(old, 'opening')) { reset(el, 15000); scan(el, true, 140); }
        } else if (el.id === 'party') {
          if (hasCls(cls, 'on') && !hasCls(old, 'on')) { reset(el, 3000); scan(el, true, 260); }
        } else if (cl.contains('delta')) {
          deltas.add(el);
        }
        if (hasCls(cls, 'cc-win') && !hasCls(old, 'cc-win')) put(wins, el, false, 0);
      }

      // 2. content: new subtrees, and text written into a number or a delta
      for (const r of recs) {
        if (r.type === 'attributes') continue;
        let tg = r.target;
        if (r.type === 'characterData') {
          if (ours.has(tg)) continue;   // our own frame
          tg = tg.parentElement;
        }
        if (!tg || tg.nodeType !== 1 || !tg.isConnected) continue;
        if (r.type === 'childList') {
          for (const n of r.addedNodes) if (n.nodeType === 1 && n.isConnected) scan(n, false, 0);
          const u = tg.closest(UNIT_SEL);
          if (u) put(units, u, false, 0);
        }
        const nm = tg.closest(NUM_SEL);
        if (nm) put(nums, nm, false, 0);
        if (tg.classList.contains('delta')) deltas.add(tg);
      }

      // clear out anything that was waiting to be scrolled to and has since been replaced
      waiting.forEach(el => { if (!el.isConnected) unwait(el); });
      waitingNums.forEach((b, el) => { if (!el.isConnected) { waitingNums.delete(el); if (io) io.unobserve(el); } });

      // 3. READ: decide, and measure what will be drawn
      const cache = new Map();
      const draws = [], stills = [];
      units.forEach((o, el) => {
        if (!el.isConnected) return;
        const kind = kindOf(el);
        if (!kind) return;
        if (!shown(el)) { stills.push(el); return; }   // a hidden room: replayed when it opens
        const key = keyOf(el, kind, KIND_SEL[kind], cache);
        if (o.force || fresh(el, key, t)) { seen.set(key, epoch); draws.push(measure(el, kind, o.base)); }
        else stills.push(el);
      });
      const counts = [];
      nums.forEach((o, el) => {
        if (!el.isConnected || (counting.has(el) && !o.force)) return;
        const tn = singleText(el);
        if (!tn) return;
        const job = counting.get(el);
        const p = parseCount(job ? job.original : tn.data);
        if (!p || !(p.value > 0) || !shown(el)) return;
        const key = keyOf(el, 'num', NUM_SEL, cache);
        if (!(o.force || fresh(el, key, t))) return;
        seen.set(key, epoch);
        counts.push([el, o.base, deferOK && !inView(el)]);
      });
      wins.forEach((o, el) => {
        if (!el.isConnected || !shown(el)) return;
        const key = keyOf(el, 'win', WIN_SEL, cache);
        if (!(o.force || fresh(el, key, t))) return;
        seen.set(key, epoch);
        const go = sparkle(el);
        if (go) later.push(go);
      });
      deltas.forEach(de => { const go = celebrateDelta(de, t); if (go) later.push(go); });

      // 4. WRITE
      stills.forEach(still);
      const restart = draws.filter(d => d.el.classList.contains('cc-draw'));
      restart.forEach(d => d.el.classList.remove('cc-draw'));
      // a quick second switch lands on a pane still sliding: take the class off so it replays
      const panes = slideReq ? doc.querySelectorAll('.room-pane.cc-roomin') : [];
      slideReq = false;
      panes.forEach(p => p.classList.remove('cc-roomin'));
      if (restart.length || panes.length) void body.offsetWidth;   // one reflow so they restart
      draws.forEach(apply);
      counts.forEach(([el, base, wait]) => {
        if (wait && io) { waitingNums.set(el, base); io.observe(el); }
        else startCount(el, base);
      });
      later.forEach(fn => { try { fn(); } catch (e) {} });
    }

    /* ---------------- you did something: open a reset over what you touched ---------------- */
    const poke = guard(e => {
      const tg = e.target;
      if (!tg || !tg.closest) return;
      if (e.type === 'keydown' && (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey)) return;
      // long enough for a press that fetches (a date range, another upload) to come back;
      // a key only replays once per reset, so a poll inside the window finds it seen
      const drawer = tg.closest('.drawer');
      if (drawer) { reset(drawer, 8000); return; }
      const card = tg.closest('.card, .grid');
      if (card) reset(card, 8000);
    });
    doc.addEventListener('click', poke, true);
    doc.addEventListener('keydown', poke, true);
    doc.addEventListener('change', poke, true);

    /* ---------------- reduced motion switched on mid-visit: stand everything down ---------------- */
    if (mq) {
      const off = guard(() => {
        if (!mq.matches) return;
        finishAll();
        doc.querySelectorAll('.cc-draw, .cc-wait').forEach(el => { el.classList.remove('cc-draw', 'cc-wait'); });
        gliders.forEach((g, tabs) => { tabs.classList.remove('cc-glide'); g.remove(); });
        gliders.clear();
        body.classList.remove('cc-intro', 'cc-rooming');
      });
      if (mq.addEventListener) mq.addEventListener('change', off); else if (mq.addListener) mq.addListener(off);
    }

    /* ---------------- go ---------------- */
    mo.observe(body, { childList: true, subtree: true, characterData: true,
                       attributes: true, attributeOldValue: true, attributeFilter: ['class', 'aria-selected'] });
    body.classList.add('cc-intro');
    setTimeout(guard(() => body.classList.remove('cc-intro')), 1900);
    setupGliders();
    schedule();
  }
})();
