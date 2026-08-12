// Weekly search-rank tracker. search.list costs 100 quota units PER PAGE, and a
// keyword the channel doesn't rank for pages deep — so worst case is
// MAX_PAGES*100 units per non-ranking keyword. A shared RUN_PAGE_BUDGET caps the
// whole run so it can't drain the daily quota that the hourly snapshot job shares.
import fs from 'fs';

const KEY = process.env.YT_API_KEY;
const CHANset = new Set((process.env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean));
let kws = [];
try { kws = JSON.parse(fs.readFileSync('data/keywords.json', 'utf8')).keywords || []; } catch {}
if (!KEY || !CHANset.size || !kws.length) {
  console.log('Secrets or data/keywords.json keywords missing — skipping rank check.');
  process.exit(0);
}

const api = async (ep, params) => {
  const u = new URL('https://www.googleapis.com/youtube/v3/' + ep);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', KEY);
  const r = await fetch(u);
  if (!r.ok) throw new Error(ep + ' HTTP ' + r.status + ': ' + (await r.text()).slice(0, 300));
  return r.json();
};

let ranks = {};
try { ranks = JSON.parse(fs.readFileSync('data/ranks.json', 'utf8')); } catch {}

// Page down until the channel is found (early exit = cheap once ranking) or limits hit.
// MAX_PAGES per keyword (~top 400), RUN_PAGE_BUDGET across the whole run so a Monday
// where nothing ranks tops out at 4000 units, leaving the daily quota for the snapshot job.
const MAX_PAGES = 8;
const RUN_PAGE_BUDGET = 40;
let pagesUsed = 0;

/* Start somewhere different each week.
   MAX_PAGES(8) x 5 non-ranking keywords is exactly RUN_PAGE_BUDGET(40), so with a fixed
   start the same first five keywords ate the whole budget every single run and the tail of
   the list was never searched at all — not "rarely", never. Rotating the start by the week
   number gives every keyword its turn. The list stays in its configured order otherwise. */
const week = Math.floor(Date.now() / (7 * 864e5));
const pick = kws.slice(0, 10);
const offset = pick.length ? week % pick.length : 0;
const ordered = pick.slice(offset).concat(pick.slice(0, offset));

for (const q of ordered) {
  let pageToken = '', base = 0, hit = { rank: null }, checked = 0, fetched = 0;
  try {
    for (let p = 0; p < MAX_PAGES && pagesUsed < RUN_PAGE_BUDGET; p++) {
      const d = await api('search', { part: 'snippet', type: 'video', q, maxResults: 50, order: 'relevance', ...(pageToken ? { pageToken } : {}) });
      pagesUsed++; fetched++;
      const items = d.items || [];
      const pos = items.findIndex(it => it.snippet && CHANset.has(it.snippet.channelId));
      checked += items.length;
      if (pos >= 0) { hit = { rank: base + pos + 1, videoId: items[pos].id.videoId, title: items[pos].snippet.title }; break; }
      base += items.length;
      pageToken = d.nextPageToken;
      if (!pageToken || !items.length) break;
    }
  } catch (e) { console.log('  (stopped deep search for "' + q + '": ' + String(e.message).slice(0, 80) + ')'); }

  /* Only record what was actually measured.
     This push used to be unconditional, so a keyword that never ran — budget exhausted
     before its first page, or a 403 on page 1 — got `{checkedDepth: 0, rank: null}`, a row
     indistinguishable from a genuine "searched 400 deep, not there". The dashboard then
     read `'not in top ' + (last.checkedDepth || 50)`, and 0 is falsy, so it stated
     "not in top 50" — a specific, confident claim with zero API calls behind it. Since
     history is capped at 52 rows, those phantoms also evicted real measurements: "brain
     tickles" charted at #31 in a stored week and four fabricated rows later asserted it
     had never ranked.

     Gated on pages FETCHED rather than on `checked`, because a first page that legitimately
     comes back empty is a real observation and should still be recorded. */
  if (!fetched) { console.log('"' + q + '": skipped — no pages fetched (budget spent or the API refused)'); continue; }
  (ranks[q] = ranks[q] || []).push({ ts: Date.now(), checkedDepth: checked, ...hit });
  ranks[q] = ranks[q].slice(-52);
  console.log('"' + q + '": ' + (hit.rank ? '#' + hit.rank : 'not in top ' + checked));
}

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/ranks.json', JSON.stringify(ranks, null, 1));
