// Weekly search-rank tracker. Each keyword costs 100 quota units (search.list),
// so keywords are capped at 10 and this runs once a week.
import fs from 'fs';

const KEY = process.env.YT_API_KEY;
const CHANNEL = process.env.CHANNEL_ID;
let kws = [];
try { kws = JSON.parse(fs.readFileSync('data/keywords.json', 'utf8')).keywords || []; } catch {}
if (!KEY || !CHANNEL || !kws.length) {
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

for (const q of kws.slice(0, 10)) {
  const d = await api('search', { part: 'snippet', type: 'video', q, maxResults: 50, order: 'relevance' });
  const pos = (d.items || []).findIndex(it => it.snippet && it.snippet.channelId === CHANNEL);
  const hit = pos >= 0
    ? { rank: pos + 1, videoId: d.items[pos].id.videoId, title: d.items[pos].snippet.title }
    : { rank: null };
  (ranks[q] = ranks[q] || []).push({ ts: Date.now(), ...hit });
  ranks[q] = ranks[q].slice(-52);
  console.log('"' + q + '": ' + (hit.rank ? '#' + hit.rank : 'not in top 50'));
}

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/ranks.json', JSON.stringify(ranks, null, 1));
