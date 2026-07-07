// Hourly public-stats snapshotter. Runs on a plain API key (public data only) —
// the dashboard's OAuth stays interactive-only. Writes data/history.json and
// data/alerts.json; milestone texts also go to new-alerts.txt (repo root, not
// committed) for the workflow's issue step.
import fs from 'fs';

const KEY = process.env.YT_API_KEY;
const CHANNEL = process.env.CHANNEL_ID;
const BENCH = (process.env.BENCH_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!KEY || !CHANNEL) {
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

const now = Date.now();
const HIST = 'data/history.json';
let h = { channel: [], videos: {}, bench: {}, benchMeta: {}, lastAlerts: {} };
try { h = { ...h, ...JSON.parse(fs.readFileSync(HIST, 'utf8')) }; } catch {}

// own channel + uploads
const ch = await api('channels', { part: 'statistics,contentDetails', id: CHANNEL });
if (!ch.items || !ch.items.length) throw new Error('CHANNEL_ID not found');
const c = ch.items[0];
h.channel.push([now, +c.statistics.subscriberCount || 0, +c.statistics.viewCount || 0]);

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

// benchmark channels (optional)
if (BENCH.length) {
  const d = await api('channels', { part: 'snippet,statistics', id: BENCH.join(',') });
  for (const it of d.items || []) {
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
h.channel = prune(h.channel);
for (const k of Object.keys(h.videos)) h.videos[k] = prune(h.videos[k]);
for (const k of Object.keys(h.bench)) h.bench[k] = prune(h.bench[k]);

// milestones + acceleration alerts
let alerts = [];
try { alerts = JSON.parse(fs.readFileSync('data/alerts.json', 'utf8')); } catch {}
const newAlerts = [];
const atOrBefore = (arr, t) => { let v = null; for (const s of arr) { if (s[0] <= t) v = s; else break; } return v; };

if (h.channel.length >= 2) {
  const prev = h.channel[h.channel.length - 2][1], cur = h.channel[h.channel.length - 1][1];
  if (cur > prev) {
    const step = Math.max(10, Math.pow(10, Math.floor(Math.log10(Math.max(10, cur)))) / 10);
    if (Math.floor(cur / step) > Math.floor(prev / step)) {
      newAlerts.push({ ts: now, type: 'subs', text: 'Channel crossed ' + (Math.floor(cur / step) * step).toLocaleString() + ' subscribers (now ' + cur.toLocaleString() + ')' });
    }
  }
}
for (const [vid, arr] of Object.entries(h.videos)) {
  if (arr.length < 3) continue;
  const nowS = arr[arr.length - 1];
  const d1 = atOrBefore(arr, now - 864e5), d2 = atOrBefore(arr, now - 2 * 864e5);
  if (!d1 || !d2 || d1 === d2 || d1 === nowS) continue;
  const r1 = nowS[1] - d1[1], r0 = d1[1] - d2[1];
  const key = 'accel:' + vid;
  if (r1 >= 100 && r1 >= r0 * 2 && (now - (h.lastAlerts[key] || 0)) > 3 * 864e5) {
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
console.log('Snapshot ok: ' + ids.length + ' videos, ' + BENCH.length + ' benchmark channels, ' + newAlerts.length + ' new alerts.');
