// Hourly public-stats snapshotter. Runs on a plain API key (public data only) —
// the dashboard's OAuth stays interactive-only. Writes data/history.json and
// data/alerts.json; milestone texts also go to new-alerts.txt (repo root, not
// committed) for the workflow's issue step.
import fs from 'fs';

const KEY = process.env.YT_API_KEY;
const CHANNELS = (process.env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const BENCH = (process.env.BENCH_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!KEY || !CHANNELS.length) {
  console.log('YT_API_KEY / CHANNEL_ID secrets not set — skipping snapshot.');
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

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const channelsById = async ids => {
  const items = [];
  for (const part of chunk(ids, 50)) {
    const d = await api('channels', { part: 'snippet,statistics,contentDetails', id: part.join(',') });
    items.push(...(d.items || []));
  }
  return items;
};

const now = Date.now();
const HIST = 'data/history.json';
let h = { channels: {}, channelMeta: {}, videos: {}, bench: {}, benchMeta: {}, lastAlerts: {} };
try { h = { ...h, ...JSON.parse(fs.readFileSync(HIST, 'utf8')) }; } catch {}
// migrate the old single-channel shape, and guard against missing keys
if (Array.isArray(h.channel)) { if (CHANNELS[0]) h.channels[CHANNELS[0]] = h.channel; delete h.channel; }
if (!h.channels) h.channels = {};
if (!h.channelMeta) h.channelMeta = {};

// own channel(s) + uploads — chunked so >50 channels still work
const ownItems = await channelsById(CHANNELS);
if (!ownItems.length) throw new Error('No CHANNEL_ID channels found');
let vidCount = 0;
for (const c of ownItems) {
  h.channelMeta[c.id] = c.snippet.title;
  (h.channels[c.id] = h.channels[c.id] || []).push([now, +c.statistics.subscriberCount || 0, +c.statistics.viewCount || 0]);
  const uploads = c.contentDetails.relatedPlaylists.uploads;
  let ids = [], pageToken = '';
  while (ids.length < 200) {
    const d = await api('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    ids.push(...d.items.map(i => i.contentDetails.videoId));
    pageToken = d.nextPageToken;
    if (!pageToken) break;
  }
  for (let i = 0; i < ids.length; i += 50) {
    const d = await api('videos', { part: 'statistics', id: ids.slice(i, i + 50).join(',') });
    for (const it of d.items) {
      const s = it.statistics;
      (h.videos[it.id] = h.videos[it.id] || []).push([now, +(s.viewCount || 0), +(s.likeCount || 0), +(s.commentCount || 0)]);
    }
  }
  vidCount += ids.length;
}

// benchmark channels (optional) — chunked so >50 still work
if (BENCH.length) {
  for (const it of await channelsById(BENCH)) {
    (h.bench[it.id] = h.bench[it.id] || []).push([now, +it.statistics.subscriberCount || 0, +it.statistics.viewCount || 0]);
    h.benchMeta[it.id] = it.snippet.title;
  }
}

// prune: hourly for 14 days, then one sample per UTC day, nothing past 400 days
const cutoff = now - 14 * 864e5;
const maxAge = now - 400 * 864e5;
const prune = arr => {
  const out = [], seen = new Set();
  for (const s of arr) {
    if (s[0] < maxAge) continue;
    if (s[0] >= cutoff) { out.push(s); continue; }
    const day = new Date(s[0]).toISOString().slice(0, 10);
    if (!seen.has(day)) { seen.add(day); out.push(s); }
  }
  return out;
};
for (const k of Object.keys(h.channels)) h.channels[k] = prune(h.channels[k]);
for (const k of Object.keys(h.videos)) h.videos[k] = prune(h.videos[k]);
for (const k of Object.keys(h.bench)) h.bench[k] = prune(h.bench[k]);

// milestones + acceleration alerts
let alerts = [];
try { alerts = JSON.parse(fs.readFileSync('data/alerts.json', 'utf8')); } catch {}
const newAlerts = [];
const atOrBefore = (arr, t) => { let v = null; for (const s of arr) { if (s[0] <= t) v = s; else break; } return v; };

for (const [cid, arr] of Object.entries(h.channels)) {
  if (arr.length < 2) continue;
  const cur = arr[arr.length - 1][1];
  const step = Math.max(10, Math.pow(10, Math.floor(Math.log10(Math.max(10, cur)))) / 10);
  const milestone = Math.floor(cur / step) * step;
  const key = 'subs:' + cid;
  // only fire when we cross a HIGHER milestone than last announced (dedup across oscillation)
  if (milestone > (h.lastAlerts[key] || 0) && arr.length >= 2 && arr[arr.length - 2][1] < milestone) {
    h.lastAlerts[key] = milestone;
    newAlerts.push({ ts: now, type: 'subs', text: (h.channelMeta[cid] || 'Channel') + ' crossed ' + milestone.toLocaleString() + ' subscribers (now ' + cur.toLocaleString() + ')' });
  }
}
for (const [vid, arr] of Object.entries(h.videos)) {
  if (arr.length < 3) continue;
  const nowS = arr[arr.length - 1];
  const d1 = atOrBefore(arr, now - 864e5), d2 = atOrBefore(arr, now - 2 * 864e5);
  if (!d1 || !d2 || d1 === d2 || d1 === nowS) continue;
  const r1 = nowS[1] - d1[1], r0 = d1[1] - d2[1];
  const key = 'accel:' + vid;
  // require a positive prior baseline so YouTube view corrections (negative r0) don't fire a fake alert
  if (r1 >= 100 && r0 > 0 && r1 >= r0 * 2 && (now - (h.lastAlerts[key] || 0)) > 3 * 864e5) {
    h.lastAlerts[key] = now;
    newAlerts.push({ ts: now, type: 'accel', vid, text: 'Video https://youtu.be/' + vid + ' is accelerating: ' + r1.toLocaleString() + ' views in the last 24h (previous 24h: ' + r0.toLocaleString() + ')' });
  }
}
alerts.push(...newAlerts);
alerts = alerts.slice(-100);

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(HIST, JSON.stringify(h));
fs.writeFileSync('data/alerts.json', JSON.stringify(alerts, null, 1));
if (newAlerts.length) fs.writeFileSync('new-alerts.txt', newAlerts.map(a => a.text).join('\n'));
console.log('Snapshot ok: ' + CHANNELS.length + ' channel(s), ' + vidCount + ' videos, ' + BENCH.length + ' benchmark channels, ' + newAlerts.length + ' new alerts.');
