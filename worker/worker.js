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
// Seed list of text chat models, tried in order. Each has its OWN free-tier daily quota and
// the loop below skips any that fail (wrong id / no quota / incompatible), so the effective
// free budget is the SUM across the models that work, at $0. The "-latest" entries are stable
// aliases Google keeps pointing at a current flash model.
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.0-flash'];
// Models that can't do plain text generateContent (speech / image / audio / specialised) —
// excluded from auto-discovery so a text request never hits a 400 modality error.
const NON_TEXT_MODEL = /tts|image|audio|lyria|nano-banana|robotics|computer-use|deep-research|antigravity|embedding|gemma|vision|omni/i;

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

// Ask Google which models this key can actually call with generateContent.
async function listGenerateModels(key) {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key));
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace('models/', ''))
      .filter(Boolean);
  } catch (e) { return []; }
}

// Call Gemini, self-healing across models: try the cached/known-good model, then the
// seed list, then whatever the key actually offers (flash first). 404 = wrong id → skip;
// 429 = no free quota on that model → skip. Remembers the winner in KV so later calls are
// a single request.
async function callGemini(env, prompt) {
  const key = env.GEMINI_KEY;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, responseMimeType: 'application/json' } });
  let sawQuota = false, lastErr = 'no response', cached = null;
  try { cached = await env.MINUTE.get('ai-model'); } catch (e) {}

  const seen = new Set();
  const attempt = async (model) => {
    if (!model || seen.has(model)) return undefined;
    seen.add(model);
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    // Skip ANY model that doesn't return OK — wrong id (404), no free quota (429), or an
    // incompatible model that rejects a text request (400) — and try the next one.
    if (!r.ok) {
      if (r.status === 429) sawQuota = true;
      lastErr = model + ' → HTTP ' + r.status;
      return undefined;
    }
    const j = await r.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] ? j.candidates[0].content.parts[0].text : '';
    const parsed = JSON.parse(txt);
    if (model !== cached) { try { await env.MINUTE.put('ai-model', model); } catch (e) {} } // remember the winner
    return parsed;
  };

  // 1) cached winner, then the seed list
  for (const m of [cached, ...GEMINI_MODELS]) { const out = await attempt(m); if (out !== undefined) return out; }
  // 2) discover what this key really offers — text models only, flash first (free-tier friendly)
  const discovered = (await listGenerateModels(key)).filter(m => !NON_TEXT_MODEL.test(m));
  const ordered = [...discovered.filter(m => /flash/i.test(m)), ...discovered.filter(m => !/flash/i.test(m))];
  for (const m of ordered) { const out = await attempt(m); if (out !== undefined) return out; }

  if (sawQuota) throw new Error("Gemini's free API quota is used up for now (HTTP 429) — it resets on Google's schedule (per-minute limits clear in ~a minute; the daily cap resets each day). Note: a Gemini app/chat subscription does NOT raise the API limit — the API free tier is separate.");
  throw new Error(lastErr + ' — no usable Gemini model found for this key.');
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
    'Give a large, varied set (the caller has plenty of token budget but few requests, so pack this response fully). Return JSON only, with keys: "titles" (20 title strings in their style), "onscreenText" (20 punchy on-screen text hooks, max 6 words each), "tags" (40 lowercase tag strings), "videoIdeas" (15 objects each {"title","why"} where why is one short reason it should work for this channel).';
  try { return json(await callGemini(env, prompt)); }
  catch (e) { return json({ error: String(e.message || e) }, 502); }
}

/* ---------- cross-device sync store (owner-locked), replaces Google Drive ---------- */
// Stores each channel's device-local bundle (keyword research, Studio CTR, minute-race
// history) in KV keyed by the channel id, and only serves it back to a signed-in owner of
// that channel. Uses the YouTube login only — no Drive scope — so restricted accounts work.
async function syncHandler(request, env) {
  const channels = (env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const auth = request.headers.get('Authorization') || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  let body = null;
  if (request.method === 'POST') { try { body = await request.json(); } catch (e) {} if (!token && body) token = body.token || ''; }
  const owner = await verifyOwner(token, channels);
  if (!owner) return json({ error: 'Not authorised — sign in with one of the tracked channels.' }, 401);
  const key = 'sync:' + owner;
  if (request.method === 'POST') {
    if (!body || body.bundle === undefined) return json({ error: 'no bundle' }, 400);
    try { await env.MINUTE.put(key, JSON.stringify(body.bundle)); } catch (e) { return json({ error: 'store failed' }, 502); }
    return json({ ok: true });
  }
  let stored = '{}';
  try { stored = (await env.MINUTE.get(key)) || '{}'; } catch (e) {}
  return new Response(stored, { headers: { 'Content-Type': 'application/json', ...CORS } });
}

/* ================= TikTok =================
 * OAuth (Login Kit) + Display API. The client secret lives here as a Worker secret and
 * never reaches the browser: the page only ever holds an opaque session id we mint.
 * TikTok access tokens last ~24h and refresh tokens ~1 year, so the cron below can keep
 * sampling a new post's views minute-by-minute with no browser open.
 */
const TT_AUTH  = 'https://www.tiktok.com/v2/auth/authorize/';
const TT_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const TT_API   = 'https://open.tiktokapis.com/v2/';
const TT_SCOPES = 'user.info.basic,user.info.profile,user.info.stats,video.list';
const TT_VIDEO_FIELDS = 'id,title,video_description,duration,cover_image_url,share_url,create_time,like_count,comment_count,share_count,view_count';
const TT_USER_FIELDS = 'open_id,avatar_url,display_name,username,profile_deep_link,follower_count,following_count,likes_count,video_count';

const rand = n => { const a = new Uint8Array(n || 24); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); };
const ttRedirect = url => new URL(url).origin + '/tiktok/callback';

async function ttTokenCall(env, params) {
  const body = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY || '', client_secret: env.TIKTOK_CLIENT_SECRET || '', ...params });
  const r = await fetch(TT_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('TikTok token: ' + (j.error_description || j.error || ('HTTP ' + r.status)));
  return j;
}

// Persist tokens for an account and keep it in the polled-accounts list.
async function ttSaveTokens(env, t) {
  const now = Date.now();
  const rec = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: now + (t.expires_in || 86400) * 1000,
    refresh_expires_at: now + (t.refresh_expires_in || 31536000) * 1000
  };
  await env.MINUTE.put('tt:tok:' + t.open_id, JSON.stringify(rec));
  let list = [];
  try { list = JSON.parse(await env.MINUTE.get('tt:accounts') || '[]'); } catch (e) {}
  if (!list.includes(t.open_id)) { list.push(t.open_id); await env.MINUTE.put('tt:accounts', JSON.stringify(list)); }
  return rec;
}

// Returns a usable access token, refreshing it first if it's within 2 minutes of expiry.
async function ttAccessToken(env, openId) {
  let rec = null;
  try { rec = JSON.parse(await env.MINUTE.get('tt:tok:' + openId) || 'null'); } catch (e) {}
  if (!rec) return null;
  if (rec.expires_at - Date.now() > 120000) return rec.access_token;
  try {
    const t = await ttTokenCall(env, { grant_type: 'refresh_token', refresh_token: rec.refresh_token });
    const saved = await ttSaveTokens(env, { ...t, open_id: openId, refresh_token: t.refresh_token || rec.refresh_token });
    return saved.access_token;
  } catch (e) { return null; }
}

const ttGet = async (path, token) => {
  const r = await fetch(TT_API + path, { headers: { Authorization: 'Bearer ' + token } });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};
const ttPost = async (path, token, payload) => {
  const r = await fetch(TT_API + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}) });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
};

async function ttFetchVideos(token, max) {
  const out = []; let cursor = null;
  while (out.length < (max || 60)) {
    const payload = { max_count: 20, ...(cursor ? { cursor } : {}) };
    const { ok, body } = await ttPost('video/list/?fields=' + encodeURIComponent(TT_VIDEO_FIELDS), token, payload);
    const d = body && body.data;
    if (!ok || !d || !Array.isArray(d.videos)) break;
    out.push(...d.videos);
    if (!d.has_more || !d.cursor) break;
    cursor = d.cursor;
  }
  return out;
}

// session id -> open_id (the browser never sees a TikTok token)
const ttSession = async (env, request) => {
  const auth = request.headers.get('Authorization') || '';
  const sid = auth.startsWith('Bearer ') ? auth.slice(7) : (new URL(request.url).searchParams.get('s') || '');
  if (!sid) return null;
  try { return await env.MINUTE.get('tt:sess:' + sid); } catch (e) { return null; }
};

async function ttHandler(request, env, url) {
  const p = url.pathname;
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    return json({ error: 'TikTok is not configured on this Worker (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET missing).' }, 501);
  }

  // 1) start auth — remembers where to send the browser back to
  if (p === '/tiktok/login') {
    const state = rand(16);
    const ret = url.searchParams.get('return') || '';
    await env.MINUTE.put('tt:state:' + state, ret, { expirationTtl: 900 });
    const a = new URL(TT_AUTH);
    a.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
    a.searchParams.set('scope', TT_SCOPES);
    a.searchParams.set('response_type', 'code');
    a.searchParams.set('redirect_uri', ttRedirect(url));
    a.searchParams.set('state', state);
    return Response.redirect(a.toString(), 302);
  }

  // 2) TikTok sends the user back here with a code
  if (p === '/tiktok/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state') || '';
    const err = url.searchParams.get('error');
    const ret = (await env.MINUTE.get('tt:state:' + state)) ;
    if (ret === null) return new Response('Sign-in expired or invalid. Please try again.', { status: 400, headers: CORS });
    await env.MINUTE.delete('tt:state:' + state);
    if (err || !code) return new Response('TikTok sign-in was cancelled or failed: ' + (url.searchParams.get('error_description') || err || 'no code'), { status: 400, headers: CORS });
    let t;
    try { t = await ttTokenCall(env, { grant_type: 'authorization_code', code, redirect_uri: ttRedirect(url) }); }
    catch (e) { return new Response('Could not complete TikTok sign-in: ' + e.message, { status: 502, headers: CORS }); }
    await ttSaveTokens(env, t);
    const sid = rand(24);
    await env.MINUTE.put('tt:sess:' + sid, t.open_id, { expirationTtl: 60 * 60 * 24 * 300 });
    // cache the profile so the cron can label videos without a live call
    try {
      const { body } = await ttGet('user/info/?fields=' + encodeURIComponent(TT_USER_FIELDS), t.access_token);
      if (body && body.data && body.data.user) await env.MINUTE.put('tt:meta:' + t.open_id, JSON.stringify(body.data.user));
    } catch (e) {}
    const dest = /^https:\/\/[a-z0-9.-]*github\.io\//i.test(ret) ? ret : 'https://reubenrich16.github.io/Analytics/tiktok.html';
    return Response.redirect(dest + (dest.includes('#') ? '' : '#') + 'tt=' + sid, 302);
  }

  // everything below needs a session
  const openId = await ttSession(env, request);
  if (!openId) return json({ error: 'Not signed in to TikTok.' }, 401);
  const token = await ttAccessToken(env, openId);
  if (!token) return json({ error: 'TikTok session expired — please sign in again.', reauth: true }, 401);

  if (p === '/tiktok/me') {
    const { ok, body } = await ttGet('user/info/?fields=' + encodeURIComponent(TT_USER_FIELDS), token);
    if (!ok || !body.data) return json({ error: (body.error && body.error.message) || 'user info failed' }, 502);
    await env.MINUTE.put('tt:meta:' + openId, JSON.stringify(body.data.user));
    return json(body.data.user);
  }
  if (p === '/tiktok/videos') {
    try { return json({ videos: await ttFetchVideos(token, 60) }); }
    catch (e) { return json({ error: String(e.message || e) }, 502); }
  }
  if (p === '/tiktok/history') {
    let snap = '{}';
    try { snap = (await env.MINUTE.get('tt:snap:' + openId)) || '{}'; } catch (e) {}
    return new Response(snap, { headers: { 'Content-Type': 'application/json', ...CORS } });
  }
  if (p === '/tiktok/sync') {
    const key = 'tt:sync:' + openId;
    if (request.method === 'POST') {
      let b = null; try { b = await request.json(); } catch (e) {}
      if (!b || b.bundle === undefined) return json({ error: 'no bundle' }, 400);
      await env.MINUTE.put(key, JSON.stringify(b.bundle));
      return json({ ok: true });
    }
    let stored = '{}';
    try { stored = (await env.MINUTE.get(key)) || '{}'; } catch (e) {}
    return new Response(stored, { headers: { 'Content-Type': 'application/json', ...CORS } });
  }
  if (p === '/tiktok/ai') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    if (!env.GEMINI_KEY) return json({ error: 'AI is not configured on this Worker.' }, 501);
    let b = {}; try { b = await request.json(); } catch (e) {}
    const desc = String(b.desc || '').slice(0, 2000), style = String(b.style || '').slice(0, 6000);
    if (!desc) return json({ error: 'No description provided.' }, 400);
    const prompt = 'You are a TikTok growth assistant. Using ONLY the account\'s own style below, write ideas that sound like this creator for the new video described. Match their caption tone, hashtag habits and emoji use.\n\n' +
      'ACCOUNT STYLE:\n' + style + '\n\nNEW VIDEO:\n"' + desc + '"\n\n' +
      'Give a large, varied set. Return JSON only, with keys: "titles" (20 caption strings in their style), "onscreenText" (20 punchy on-screen text hooks, max 6 words each), "tags" (40 lowercase hashtags without the # symbol), "videoIdeas" (15 objects each {"title","why"} where why is one short reason it should work for this account).';
    try { return json(await callGemini(env, prompt)); }
    catch (e) { return json({ error: String(e.message || e) }, 502); }
  }
  return json({ error: 'unknown tiktok endpoint' }, 404);
}

// Background sampling: records view/like counts for recent posts so a launch is captured
// minute-by-minute even with no browser open. Gated the same way as the YouTube tracker
// so KV writes stay well inside the free tier.
async function ttTick(env) {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) return { skipped: 'not configured' };
  let list = [];
  try { list = JSON.parse(await env.MINUTE.get('tt:accounts') || '[]'); } catch (e) {}
  if (!list.length) return { accounts: 0 };
  const now = Date.now(), hotMs = HOT_HOURS * 3600e3, cutoff = now - KEEP_DAYS * 864e5;
  let sampled = 0;
  for (const openId of list) {
    const token = await ttAccessToken(env, openId);
    if (!token) continue;
    let snap = { videos: {}, lastScan: 0 };
    try { snap = JSON.parse(await env.MINUTE.get('tt:snap:' + openId) || 'null') || snap; } catch (e) {}
    snap.videos = snap.videos || {};
    const hot = Object.keys(snap.videos).filter(id => now - (snap.videos[id].create_time * 1000) < hotMs);
    if (!hot.length && now - (snap.lastScan || 0) < SCAN_MIN * 60e3) continue;
    let vids = [];
    try { vids = await ttFetchVideos(token, 20); } catch (e) { continue; }
    snap.lastScan = now;
    let changed = false;
    for (const v of vids) {
      const ct = (v.create_time || 0) * 1000;
      if (!ct || now - ct > hotMs) continue;             // only the launch window
      const rec = snap.videos[v.id] || (snap.videos[v.id] = { create_time: v.create_time, title: v.title || v.video_description || '', cover: v.cover_image_url || '', s: [] });
      rec.s.push([now, v.view_count || 0, v.like_count || 0, v.comment_count || 0, v.share_count || 0]);
      changed = true; sampled++;
    }
    for (const id of Object.keys(snap.videos)) {
      snap.videos[id].s = (snap.videos[id].s || []).filter(x => x[0] >= cutoff);
      if (now - snap.videos[id].create_time * 1000 >= hotMs && !snap.videos[id].s.length) delete snap.videos[id];
    }
    if (changed || !hot.length) { snap.updated = now; await env.MINUTE.put('tt:snap:' + openId, JSON.stringify(snap)); }
  }
  return { accounts: list.length, sampled };
}

export default {
  async scheduled(event, env, ctx) {
    // both trackers share the one-minute cron; each gates its own sampling
    ctx.waitUntil(Promise.allSettled([tick(env), ttTick(env)]));
  },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    // TikTok: OAuth + Display API (secret stays server-side)
    if (url.pathname.startsWith('/tiktok/')) return ttHandler(request, env, url);
    // AI proxy for the Idea Studio (owner-locked)
    if (url.pathname === '/ai') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      return aiHandler(request, env);
    }
    // cross-device sync store (owner-locked): GET pulls the bundle, POST saves it
    if (url.pathname === '/sync') {
      if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'GET/POST only' }, 405);
      return syncHandler(request, env);
    }
    // manual trigger for testing: /run does one tick immediately
    if (url.pathname === '/run') {
      const [yt, tt] = await Promise.all([tick(env), ttTick(env).catch(e => ({ error: String(e.message || e) }))]);
      return json({ youtube: yt, tiktok: tt });
    }
    // diagnostic: which Gemini models this key can call, plus the remembered winner
    if (url.pathname === '/models') {
      if (!env.GEMINI_KEY) return json({ error: 'no GEMINI_KEY set' }, 501);
      let picked = null; try { picked = await env.MINUTE.get('ai-model'); } catch (e) {}
      return json({ picked, generateContentModels: await listGenerateModels(env.GEMINI_KEY) });
    }
    // default: serve the recorded minute bundle for the dashboard to merge
    let body = '{}';
    try { body = (await env.MINUTE.get(KV_KEY)) || '{}'; } catch (e) {}
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...CORS } });
  },
};
