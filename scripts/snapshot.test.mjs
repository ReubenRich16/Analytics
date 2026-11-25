// Guards the snapshot robot's quota behaviour.
//
// The robot shares one YouTube key, and its 10,000 units a day, with the Worker's minute
// recorder and the weekly rank check. Two things are pinned here:
//   · a quiet in-between run (11 of every 12) costs one unit, not three-plus, and an hourly
//     full run still walks the whole back catalogue and takes the subscriber sample;
//   · running out of quota near the daily reset ends the run cleanly (exit 0, history left
//     alone) instead of failing every 5 minutes, but still fails once the last full record
//     is hours old, because that means something is burning quota and someone should look.
//
// It runs the real scripts/snapshot.mjs as a child process in a temp folder, with fetch
// replaced by a preload module that answers from a scripted fake API and logs each call.
// No network, no secrets.
//
// Run: node scripts/snapshot.test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPT = fileURLToPath(new URL('./snapshot.mjs', import.meta.url));
const CID = 'UC' + 'a'.repeat(22);
const UPLOADS = 'UU' + 'a'.repeat(22);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

// The preload: answers channels / playlistItems / videos from SCENARIO (JSON in an env
// var) and appends every request to calls.log in the working directory.
const PRELOAD = `
import fs from 'fs';
const S = JSON.parse(process.env.SCENARIO);
const send = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async u => {
  u = new URL(u);
  const ep = u.pathname.split('/').pop();
  const p = Object.fromEntries(u.searchParams);
  fs.appendFileSync('calls.log', JSON.stringify({ ep, ...p }) + '\\n');
  if (S.fail && S.fail.ep === ep) return send(S.fail.status, { error: { code: S.fail.status, message: 'nope', errors: [{ reason: S.fail.reason }] } });
  if (ep === 'channels') return send(200, { items: [{ id: S.cid, snippet: { title: 'Chan' },
    statistics: { subscriberCount: '500', viewCount: '9000' }, contentDetails: { relatedPlaylists: { uploads: S.uploads } } }] });
  if (ep === 'playlistItems') {
    const page = +(p.pageToken || 0);
    const items = S.vids.slice(page * 50, page * 50 + 50).map(v => ({ contentDetails: { videoId: v.id, videoPublishedAt: v.pub } }));
    return send(200, { items, ...(S.vids.length > (page + 1) * 50 ? { nextPageToken: String(page + 1) } : {}) });
  }
  if (ep === 'videos') return send(200, { items: p.id.split(',').map(id => ({ id, statistics: { viewCount: '10', likeCount: '1', commentCount: '0' } })) });
  return send(404, {});
};
`;

const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
// 80 videos: two fresh (under 2 days), the rest old — two playlist pages
const VIDS = Array.from({ length: 80 }, (_, i) => ({ id: 'v' + i, pub: hoursAgo(i < 2 ? 5 + i : 24 * (3 + i)) }));

function run({ history, fail, vids = VIDS }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'preload.mjs'), PRELOAD);
  const histText = JSON.stringify(history);
  fs.writeFileSync(path.join(dir, 'data/history.json'), histText);
  const r = spawnSync(process.execPath, ['--import', './preload.mjs', SCRIPT], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, YT_API_KEY: 'test-key', CHANNEL_ID: CID, BENCH_CHANNELS: '',
           SCENARIO: JSON.stringify({ cid: CID, uploads: UPLOADS, vids, fail }) },
  });
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const calls = read('calls.log').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const after = read('data/history.json');
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), calls, histText, after, hist: after ? JSON.parse(after) : null };
}
const eps = calls => calls.map(c => c.ep).join(',');
const recent = () => ({ lastFull: Date.now() - 10 * 60e3, channels: {}, videos: {} });

console.log('in-between run, nothing fresh');
{
  const r = run({ history: recent(), vids: VIDS.slice(2) });
  check('exits 0', r.code === 0, r.out);
  check('costs one unit: a single playlistItems page, no channels call', eps(r.calls) === 'playlistItems', eps(r.calls));
  check('reads the uploads playlist derived from the channel id', r.calls[0] && r.calls[0].playlistId === UPLOADS, JSON.stringify(r.calls[0]));
  check('records no subscriber sample', !(r.hist.channels[CID] || []).length);
}

console.log('in-between run, one channel with fresh uploads');
{
  const r = run({ history: recent() });
  check('exits 0', r.code === 0, r.out);
  check('one playlist page, then the channel, then the fresh videos', eps(r.calls) === 'playlistItems,channels,videos', eps(r.calls));
  check('samples only the two fresh videos', r.calls[2] && r.calls[2].id === 'v0,v1', r.calls[2] && r.calls[2].id);
  check('takes the subscriber sample', (r.hist.channels[CID] || []).length === 1 && r.hist.channels[CID][0][1] === 500);
  check('records the channel title', r.hist.channelMeta[CID] === 'Chan');
}

console.log('hourly full run');
{
  const r = run({ history: { lastFull: Date.now() - 2 * 3600e3, channels: {}, videos: {} } });
  check('exits 0', r.code === 0, r.out);
  check('channels, both playlist pages, then every video in two batches',
    eps(r.calls) === 'channels,playlistItems,playlistItems,videos,videos', eps(r.calls));
  check('records all 80 videos', Object.keys(r.hist.videos).length === 80, Object.keys(r.hist.videos).length);
  check('takes the subscriber sample', (r.hist.channels[CID] || []).length === 1);
  check('moves lastFull forward', r.hist.lastFull > Date.now() - 60e3);
}

console.log('quota runs out shortly before the reset');
for (const reason of ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded']) {
  const r = run({ history: recent(), fail: { ep: 'playlistItems', status: 403, reason } });
  check(reason + ': exits 0', r.code === 0, r.out);
  check(reason + ': leaves a warning annotation', /::warning::YouTube quota exhausted/.test(r.out), r.out);
  check(reason + ': leaves history.json untouched', r.after === r.histText);
}
{
  // on a full run the quota can run out on the very first call
  const r = run({ history: { lastFull: Date.now() - 90 * 60e3, channels: {}, videos: {} }, fail: { ep: 'channels', status: 403, reason: 'quotaExceeded' } });
  check('full run out of quota inside the grace window: exits 0', r.code === 0, r.out);
  check('…without writing history', r.after === r.histText);
}

console.log('quota out for hours');
{
  const r = run({ history: { lastFull: Date.now() - 7 * 3600e3, channels: {}, videos: {} }, fail: { ep: 'channels', status: 403, reason: 'quotaExceeded' } });
  check('fails once the last full record is over 6h old', r.code !== 0, r.out);
  check('says why', /::error::YouTube quota exhausted/.test(r.out), r.out);
}
{
  const r = run({ history: { channels: {}, videos: {} }, fail: { ep: 'channels', status: 403, reason: 'quotaExceeded' } });
  check('fails when there has never been a full record', r.code !== 0, r.out);
}

console.log('other API errors still fail');
{
  const r = run({ history: recent(), fail: { ep: 'playlistItems', status: 403, reason: 'forbidden' } });
  check('a non-quota 403 fails the run', r.code !== 0, r.out);
  check('and leaves history alone', r.after === r.histText);
}
{
  const r = run({ history: recent(), fail: { ep: 'playlistItems', status: 400, reason: 'keyInvalid' } });
  check('a bad key fails the run', r.code !== 0, r.out);
}

console.log(fail ? `✗ ${fail} FAILED, ${pass} passed` : `${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
