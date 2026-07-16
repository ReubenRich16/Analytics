/**
 * Channel Command — per-minute offline tracker (Cloudflare Worker)
 *
 * Why this exists: YouTube's API has no minute-level history, and the dashboard
 * can only record the minute race while someone has it open. This Worker runs on
 * Cloudflare's cron every minute, so a new upload's first hours are captured
 * minute-by-minute even when nobody is watching. When the dashboard next opens it
 * fetches this Worker and merges the samples into its own race history.
 *
 * Tracking security: the cron uses ONLY the same public YouTube API key the
 * GitHub robot uses — no OAuth, no login token, no account access. Public view
 * counts and nothing else.
 *
 * Optional AI proxy (/ai): if GEMINI_KEY is set, the Worker also answers the
 * dashboard's Idea Studio so the Gemini key lives here as a hidden secret and is
 * never exposed in the public page. It is LOCKED to the channel owners: every
 * /ai request must carry a valid YouTube login token whose channel is in
 * CHANNEL_ID, so only you and your partner can ever spend the Gemini quota. The
 * login token is used once to verify the channel, then discarded — never stored
 * or logged.
 *
 * Cost: $0. It stays inside the Cloudflare Workers free tier by writing at most
 * once per minute and ONLY while a video is inside its "hot" launch window
 * (HOT_HOURS, default 6h) — so a launch costs ~360 KV writes total, well under
 * the 1,000/day free limit. Outside a launch it just does a light scan every few
 * minutes to notice a new upload.
 *
 * Setup lives in ../README.md ("Per-minute offline tracker").
 */

const HOT_HOURS   = 6;      // record a video minute-by-minute for this long after publish
const SCAN_MIN    = 5;      // re-scan the uploads playlist this often to notice new uploads
const KEEP_DAYS   = 3;      // drop samples older than this from the served bundle
const KV_KEY      = 'minute-v1';
const YT          = 'https://www.googleapis.com/youtube/v3/';
// tried in order; different models have separate free-tier quota pools, so a 429 on one
// may still succeed on the next. NOTE: gemini-2.0-flash / -lite have a free-tier quota of
// 0 on new projects (they 429 instantly); the 2.5 models carry the real free allowance.
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });

async function api(ep, params, key) {
  const u = new URL(YT + ep);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', key);
  const r = await fetch(u);
  if (!r.ok) throw new Error(ep + ' HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function loadState(env) {
  let s = null;
  try { s = await env.MINUTE.get(KV_KEY, 'json'); } catch (e) {}
  if (!s || typeof s !== 'object') s = {};
  s.videos = s.videos || {};   // { vid: { pub, title, chan, s: [[ts,views,likes,comments],...] } }
  s.lastScan = s.lastScan || 0;
  return s;
}

// Find fresh (< HOT_HOURS old) uploads across all tracked channels.
async function scanFresh(channels, key) {
  const hotMs = HOT_HOURS * 3600e3;
  const now = Date.now();
  const fresh = {}; // vid -> { pub, title, chan }
  const chans = [];
  for (const part of chunk(channels, 50)) {
    const d = await api('channels', { part: 'snippet,contentDetails', id: part.join(',') }, key);
    chans.push(...(d.items || []));
  }
  for (const c of chans) {
    const uploads = c.contentDetails.relatedPlaylists.uploads;
    // only the newest page — a hot upload is always among the most recent items
    const d = await api('playlistItems', { part: 'contentDetails,snippet', playlistId: uploads, maxResults: 25 }, key);
    for (const it of (d.items || [])) {
      const vid = it.contentDetails.videoId;
      const pub = it.contentDetails.videoPublishedAt;
      if (!pub) continue;
      if (now - new Date(pub).getTime() < hotMs) {
        fresh[vid] = { pub, title: (it.snippet && it.snippet.title) || '', chan: c.id };
      }
    }
  }
  return fresh;
}

async function tick(env) {
  const key = env.YT_API_KEY;
  const channels = (env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!key || !channels.length) return { skipped: 'missing YT_API_KEY / CHANNEL_ID' };

  const now = Date.now();
  const hotMs = HOT_HOURS * 3600e3;
  const s = await loadState(env);

  // (1) periodically scan for new uploads (also when we currently track nothing)
  const haveHot = Object.values(s.videos).some(v => now - new Date(v.pub).getTime() < hotMs);
  if (!haveHot || now - s.lastScan > SCAN_MIN * 60e3) {
    try {
      const fresh = await scanFresh(channels, key);
      for (const [vid, info] of Object.entries(fresh)) {
        if (!s.videos[vid]) s.videos[vid] = { pub: info.pub, title: info.title, chan: info.chan, s: [] };
        else { s.videos[vid].title = info.title || s.videos[vid].title; s.videos[vid].pub = info.pub; }
      }
      s.lastScan = now;
    } catch (e) { /* transient API hiccup — try again next minute */ }
  }

  // (2) which tracked videos are still inside their hot window?
  const hotIds = Object.keys(s.videos).filter(vid => now - new Date(s.videos[vid].pub).getTime() < hotMs);

  // (3) sample the hot videos' live stats (1 quota unit per 50)
  let sampled = 0;
  if (hotIds.length) {
    for (const part of chunk(hotIds, 50)) {
      try {
        const d = await api('videos', { part: 'statistics', id: part.join(',') }, key);
        for (const it of (d.items || [])) {
          const st = it.statistics;
          const rec = s.videos[it.id];
          if (!rec) continue;
          rec.s.push([now, +(st.viewCount || 0), +(st.likeCount || 0), +(st.commentCount || 0)]);
          sampled++;
        }
      } catch (e) { /* skip this sample; the curve tolerates a gap */ }
    }
  }

  // (4) prune: drop samples & videos older than KEEP_DAYS
  const cutoff = now - KEEP_DAYS * 864e5;
  for (const vid of Object.keys(s.videos)) {
    const rec = s.videos[vid];
    rec.s = (rec.s || []).filter(x => x[0] >= cutoff);
    // keep a video only while hot OR while it still carries recent samples to serve
    if (now - new Date(rec.pub).getTime() >= hotMs && !rec.s.length) delete s.videos[vid];
  }

  // (5) write back ONLY when something changed (keeps us inside the free write budget)
  if (sampled || !haveHot) {
    s.updated = now;
    await env.MINUTE.put(KV_KEY, JSON.stringify(s));
  }
  return { hot: hotIds.length, sampled };
}

/* ---------- AI proxy (Idea Studio), locked to the channel owners ---------- */

// Verify the caller's YouTube login token belongs to one of the tracked channels.
// Returns the channel id on success, or null. The token is used once and discarded.
async function verifyOwner(token, channels) {
  if (!token) return null;
  try {
    const r = await fetch(YT + 'channels?part=id&mine=true', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const d = await r.json();
    const id = d.items && d.items[0] && d.items[0].id;
    return id && channels.includes(id) ? id : null;
  } catch (e) { return null; }
}

async function callGemini(key, prompt) {
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, responseMimeType: 'application/json' } });
  let sawQuota = false, lastErr = 'no response';
  for (const model of GEMINI_MODELS) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (r.status === 404) { lastErr = 'model ' + model + ' unavailable'; continue; }   // model gone → next
    if (r.status === 429) { sawQuota = true; lastErr = 'quota'; continue; }             // rate/quota → try a lighter model
    if (!r.ok) throw new Error('Gemini HTTP ' + r.status + ': ' + (await r.text()).slice(0, 160));
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] ? j.candidates[0].content.parts[0].text : '';
    return JSON.parse(txt);
  }
  if (sawQuota) throw new Error("Gemini's free API quota is used up for now (HTTP 429) — it resets on Google's schedule (per-minute limits clear in ~a minute; the daily cap resets each day). Note: a Gemini app/chat subscription does NOT raise the API limit — the API free tier is separate.");
  throw new Error(lastErr);
}

async function aiHandler(request, env) {
  const channels = (env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!env.GEMINI_KEY) return json({ error: 'AI is not configured on this Worker (no GEMINI_KEY secret).' }, 501);
  // login token: Authorization header preferred, body fallback
  let payload = {};
  try { payload = await request.json(); } catch (e) {}
  const auth = request.headers.get('Authorization') || '';
  const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '') || payload.token || '';
  const owner = await verifyOwner(token, channels);
  if (!owner) return json({ error: 'Not authorised — sign in with one of the tracked channels.' }, 401);
  const desc = String(payload.desc || '').slice(0, 2000);
  const style = String(payload.style || '').slice(0, 6000);
  if (!desc) return json({ error: 'No description provided.' }, 400);
  const prompt = 'You are a YouTube growth assistant. Using ONLY the channel\'s own style below, write ideas that sound like this creator for the new video described. Match their tone, separators and emoji habits.\n\n' +
    'CHANNEL STYLE:\n' + style + '\n\n' +
    'NEW VIDEO:\n"' + desc + '"\n\n' +
    'Return JSON only, with keys: "titles" (6 title strings in their style), "onscreenText" (6 punchy on-screen text hooks, max 6 words each), "tags" (15 lowercase tag strings), "videoIdeas" (5 objects each {"title","why"} where why is one short reason it should work for this channel).';
  try { return json(await callGemini(env.GEMINI_KEY, prompt)); }
  catch (e) { return json({ error: String(e.message || e) }, 502); }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    // AI proxy for the Idea Studio (owner-locked)
    if (url.pathname === '/ai') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      return aiHandler(request, env);
    }
    // manual trigger for testing: /run does one tick immediately
    if (url.pathname === '/run') {
      const r = await tick(env);
      return json(r);
    }
    // default: serve the recorded minute bundle for the dashboard to merge
    let body = '{}';
    try { body = (await env.MINUTE.get(KV_KEY)) || '{}'; } catch (e) {}
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
  },
};
