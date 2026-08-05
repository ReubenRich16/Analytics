// Harness: run the real worker.js tick() against a mock KV + mock D1 and assert the
// dual-write contract — KV behaviour byte-identical, D1 mirrored, D1 faults invisible.
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') + '\nexport { HANDLER, tick, ttTick, d1Write, d1Backfill, d1Prune, D1_BACKFILL_V, rosterOf, metaFp };';
const tmp = HERE + '.worker-under-test.mjs';
fs.writeFileSync(tmp, src);
const W = await import(tmp);
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (e) {} });

const NOW = Date.now();
function mockKV(seed={}) {
  const store = new Map(Object.entries(seed));
  return { store, puts: 0,
    // loadState() calls get(key, 'json') — the real KV parses for you, so the mock must too
    async get(k, type){ const v = store.has(k) ? store.get(k) : null;
      return (type === 'json' && v != null) ? JSON.parse(v) : v; },
    async put(k,v){ this.puts++; store.set(k,v); } };
}
function mockD1(opts={}) {
  const rows = { samples: new Map(), videos: new Map() };
  const d1 = { batches: 0, stmts: 0, rows, fail: opts.fail || false,
    // prepare().bind() must carry .all()/.run() as well as being inspectable as a
    // statement, because the prune reads the platform list before deleting per platform.
    prepare(sql){
      // real D1 allows .all() straight off prepare() for a statement with no bindings,
      // which is how the prune reads its platform list
      const stmt = (...a) => ({
        sql, args:a,
        all: async () => {
          if (d1.fail) throw new Error('D1 is down');
          if (/FROM videos/.test(sql)) {
            const seen = new Set([...rows.videos.values()].map(v => v[0]));
            return { results: [...seen].map(platform => ({ platform })) };
          }
          return { results: [] };
        },
        run: async () => {
          if (d1.fail) throw new Error('D1 is down');
          let n = 0;
          if (/DELETE FROM samples/.test(sql)) {
            const [platform, cutoff] = a;
            for (const [k, v] of [...rows.samples]) if (v[0] === platform && v[2] < cutoff) { rows.samples.delete(k); n++; }
          } else if (/DELETE FROM videos/.test(sql)) {
            const [cutoff] = a;
            for (const [k, v] of [...rows.videos]) if (v[2] < cutoff) { rows.videos.delete(k); n++; }
          }
          d1.deleted = (d1.deleted || 0) + n;
          return { meta: { changes: n } };
        }
      });
      return Object.assign({ sql, bind: (...a) => stmt(...a) }, { all: stmt().all, run: stmt().run });
    },
    async batch(list){
      if (this.fail) throw new Error('D1 is down');
      this.batches++; this.stmts += list.length;
      for (const s of list) {
        if (s.sql.includes('INTO samples')) {
          const k = s.args.slice(0,3).join('|');
          if (!rows.samples.has(k)) rows.samples.set(k, s.args);   // OR IGNORE
        } else rows.videos.set(s.args.slice(0,2).join('|'), s.args);
      }
      return [];
    } };
  return d1;
}
// stub the YouTube Data API
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  const url = String(u);
  if (url.includes('/playlistItems') || url.includes('/search')) return new Response(JSON.stringify({items:[]}),{status:200});
  if (url.includes('/channels')) return new Response(JSON.stringify({items:[{id:'UC1',contentDetails:{relatedPlaylists:{uploads:'UU1'}}}]}),{status:200});
  if (url.includes('/videos')) {
    const ids = new URL(url).searchParams.get('id').split(',');
    return new Response(JSON.stringify({items: ids.map((id,i)=>({id, statistics:{viewCount:String(1000+i*7), likeCount:String(50+i), commentCount:String(3+i)}}))}),{status:200});
  }
  return new Response('{}',{status:200});
};

const seedState = { updated: NOW, videos: {
  v1: { pub: new Date(NOW-2*3600e3).toISOString(), title:'Fresh one', chan:'UC1', s:[[NOW-120000, 900, 44, 2],[NOW-60000, 950, 47, 2]] }
}};
let pass=0, fail=0;
const check=(name,cond,extra='')=>{ if(cond){pass++;console.log('  ✓',name);} else {fail++;console.log('  ✗',name,extra);} };

console.log('\n1. Dual-write: KV unchanged, D1 mirrored');
{
  const KV = mockKV({ 'minute-v1': JSON.stringify(seedState) });
  const DB = mockD1();
  const env = { MINUTE: KV, DB, YT_API_KEY:'k', CHANNEL_ID:'UC1' };
  const r = await W.tick(env);
  const after = JSON.parse(KV.store.get('minute-v1'));
  check('KV still written', KV.puts === 1);
  check('KV sample appended', after.videos.v1.s.length === 3, JSON.stringify(after.videos.v1.s.length));
  check('backfill ran on first tick', r.d1.backfill === true, JSON.stringify(r.d1));
  check('backfill copied the seeded samples', DB.rows.samples.size >= 3, DB.rows.samples.size);
  check('video metadata mirrored', DB.rows.videos.size === 1, DB.rows.videos.size);
  check('backfill flag persisted to KV', !!after.d1Backfilled);
}
console.log('\n2. Second tick only writes the new sample (no re-backfill)');
{
  const st = JSON.parse(JSON.stringify(seedState)); st.d1Backfilled = W.D1_BACKFILL_V;   // already at the current version
  const KV = mockKV({ 'minute-v1': JSON.stringify(st) });
  const DB = mockD1();
  const env = { MINUTE: KV, DB, YT_API_KEY:'k', CHANNEL_ID:'UC1' };
  const r = await W.tick(env);
  check('no backfill flag', r.d1.backfill !== true, JSON.stringify(r.d1));
  check('exactly one new sample row', DB.rows.samples.size === 1, DB.rows.samples.size);
}
console.log('\n3. D1 failure must be invisible to KV');
{
  const KV = mockKV({ 'minute-v1': JSON.stringify(seedState) });
  const DB = mockD1({ fail:true });
  const env = { MINUTE: KV, DB, YT_API_KEY:'k', CHANNEL_ID:'UC1' };
  let threw=null; let r;
  try { r = await W.tick(env); } catch(e){ threw = e.message; }
  check('tick did not throw', threw === null, threw);
  check('KV still written', KV.puts >= 1);
  check('error reported, not raised', !!(r && r.d1 && r.d1.error), JSON.stringify(r && r.d1));
  const after = JSON.parse(KV.store.get('minute-v1'));
  check('backfill NOT marked done after failure', !after.d1Backfilled);
}
console.log('\n4. No D1 binding at all (rollback / old deploy)');
{
  const KV = mockKV({ 'minute-v1': JSON.stringify(seedState) });
  const env = { MINUTE: KV, YT_API_KEY:'k', CHANNEL_ID:'UC1' };
  let threw=null; let r;
  try { r = await W.tick(env); } catch(e){ threw = e.message; }
  check('tick did not throw', threw === null, threw);
  check('KV path intact', KV.puts === 1);
  check('reported as skipped', r.d1.skipped || r.d1pruned.skipped, JSON.stringify(r.d1));
}
console.log('\n5. Idempotency: same sample twice is one row');
{
  const DB = mockD1();
  const env = { DB };
  const rows=[{id:'v1',ts:NOW,views:5,likes:1,comments:0,shares:0}];
  await W.d1Write(env,'yt',rows,[]);
  await W.d1Write(env,'yt',rows,[]);
  check('one row after two identical writes', DB.rows.samples.size === 1, DB.rows.samples.size);
}
console.log('\n6. Prune: daily slot only, per platform, and never orphans a sample');
{
  const t = new Date(NOW); t.setUTCHours(3,7,0,0);
  const off = new Date(NOW); off.setUTCHours(11,22,0,0);
  const at = t.getTime();
  const DAY = 864e5, KEEP = 60 * DAY;

  const DB = mockD1();
  // three platforms, so the per-platform loop has something to iterate
  const put = (platform, id, pub, sampleTs) => {
    DB.rows.videos.set(platform+'|'+id, [platform, id, pub, '', '', '', pub]);
    for (const ts of sampleTs) DB.rows.samples.set([platform,id,ts].join('|'), [platform, id, ts, 1, 0, 0, 0]);
  };
  put('yt',        'old',   at - 90*DAY, [at - 90*DAY, at - 61*DAY]);   // entirely past retention
  put('yt',        'keep',  at - 10*DAY, [at - 10*DAY, at - 1*DAY]);    // well inside
  put('tt:acct-a', 'ttOld', at - 80*DAY, [at - 80*DAY]);
  // the orphan case: published just past the cutoff, but still sampling when it crossed,
  // so it owns samples that are INSIDE retention. Deleting its videos row would leave
  // those samples in the table and invisible in the bundle, which walks videos.
  put('tt:acct-a', 'edge',  at - KEEP - 3600e3, [at - KEEP + 3600e3]);

  const b = await W.d1Prune({DB}, off.getTime());
  check('skips every other minute', !!b.skipped, JSON.stringify(b));

  const a = await W.d1Prune({DB}, at);
  check('pruned the out-of-window samples', a.pruned === 3, JSON.stringify(a));
  check('visited every platform', a.platforms === 2, JSON.stringify(a));
  check('in-window samples survive', DB.rows.samples.has(['yt','keep',at - 1*DAY].join('|')));
  check('the edge video keeps its in-window sample',
    DB.rows.samples.has(['tt:acct-a','edge',at - KEEP + 3600e3].join('|')));
  check('and keeps its metadata row, so that sample stays visible',
    DB.rows.videos.has('tt:acct-a|edge'), [...DB.rows.videos.keys()].join(','));
  check('genuinely ancient videos are dropped', !DB.rows.videos.has('yt|old'), [...DB.rows.videos.keys()].join(','));
  check('recent videos are untouched', DB.rows.videos.has('yt|keep'));
}
console.log('\n7. Timestamps survive the write (regression: `| 0` truncated epoch ms to 1969)');
{
  const DB = mockD1();
  const PUB = 1785759351134;                 // real epoch ms, well past 2^31
  await W.d1Write({DB}, 'yt', [{id:'v1', ts:PUB, views:3e9, likes:1, comments:0, shares:0}],
                             [{id:'v1', pub:PUB, title:'t', chan:'c'}]);
  const vrow = [...DB.rows.videos.values()][0];
  const srow = [...DB.rows.samples.values()][0];
  check('published_at kept in full', vrow[2] === PUB, vrow[2] + ' (expected ' + PUB + ')');
  check('published_at is not negative', vrow[2] > 0, vrow[2]);
  check('sample ts kept in full', srow[2] === PUB, srow[2]);
  check('a 3-billion view count does not wrap', srow[3] === 3e9, srow[3]);
}
console.log('\n8. Backfill re-runs when the version is bumped');
{
  const st = JSON.parse(JSON.stringify(seedState)); st.d1Backfilled = W.D1_BACKFILL_V - 1;   // one version behind
  const KV = mockKV({ 'minute-v1': JSON.stringify(st) });
  const DB = mockD1();
  const r = await W.tick({ MINUTE: KV, DB, YT_API_KEY:'k', CHANNEL_ID:'UC1' });
  check('stale version triggers a re-run', r.d1.backfill === true, JSON.stringify(r.d1));
  const after = JSON.parse(KV.store.get('minute-v1'));
  check('flag updated to the new version', after.d1Backfilled === W.D1_BACKFILL_V, after.d1Backfilled);
}

console.log('\n9. KV write gate: sample growth waits, the roster never does');
{
  // a video already known and already declared to D1, so a plain tick changes only samples
  const fresh = () => {
    const st = JSON.parse(JSON.stringify(seedState));
    st.d1Backfilled = W.D1_BACKFILL_V;
    st.videos.v1.d1m = null;                 // filled in by the first tick below
    return st;
  };
  // tick 1 — d1m is unset, so the metadata is stated and the roster changes: must persist
  const KV = mockKV({ 'minute-v1': JSON.stringify(fresh()) });
  const DB = mockD1();
  const env = { MINUTE: KV, DB, YT_API_KEY:'k', CHANNEL_ID:'UC1' };
  const r1 = await W.tick(env);
  check('first tick persists (roster/metadata changed)', r1.wrote === true, JSON.stringify(r1));
  const afterFirst = JSON.parse(KV.store.get('minute-v1'));
  check('the metadata fingerprint was stored', !!afterFirst.videos.v1.d1m, afterFirst.videos.v1.d1m);
  check('metadata upserted once', DB.rows.videos.size === 1, DB.rows.videos.size);

  // tick 2 — nothing but a new sample. updated is now, so the gate is not due
  const putsBefore = KV.puts, stmtsBefore = DB.stmts;
  const r2 = await W.tick(env);
  check('second tick defers the KV write', r2.wrote === false && r2.deferred === true, JSON.stringify(r2));
  check('KV really was not written', KV.puts === putsBefore, KV.puts + ' vs ' + putsBefore);
  check('but D1 still got the sample', DB.stmts === stmtsBefore + 1, DB.stmts + ' vs ' + stmtsBefore);
  check('and no redundant metadata upsert', DB.rows.videos.size === 1, DB.rows.videos.size);

  // tick 3 — same state, but the gate has come due
  const stale = JSON.parse(KV.store.get('minute-v1'));
  stale.updated = Date.now() - 16 * 60000;
  KV.store.set('minute-v1', JSON.stringify(stale));
  const r3 = await W.tick(env);
  check('a due tick writes again', r3.wrote === true, JSON.stringify(r3));
}

console.log('\n10. A newly discovered video is never deferred');
{
  // the failure this guards: hotIds comes from the stored roster, so an unpersisted
  // discovery is a video that nothing samples on the following tick — losing the opening
  // minutes of a launch from D1 too, since d1rows only covers what is in hotIds.
  const st = JSON.parse(JSON.stringify(seedState));
  st.d1Backfilled = W.D1_BACKFILL_V;
  st.videos.v1.d1m = W.metaFp(st.videos.v1.pub, st.videos.v1.title);
  st.updated = Date.now();                    // gate firmly NOT due
  const KV = mockKV({ 'minute-v1': JSON.stringify(st) });
  const DB = mockD1();

  // the scan finds a brand-new upload on this tick
  const prevFetch = globalThis.fetch;
  const NEWID = 'brandNew';
  // force the scan branch: the cadence is clock-derived, minute % SCAN_MIN === 0
  const realNow = Date.now;
  const t = new Date(); t.setUTCMinutes(0, 0, 0);
  Date.now = () => t.getTime();
  // scanFresh reads contentDetails.videoId / contentDetails.videoPublishedAt
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('/playlistItems')) return new Response(JSON.stringify({ items: [
      { contentDetails: { videoId: NEWID, videoPublishedAt: new Date(t.getTime() - 60000).toISOString() },
        snippet: { title: 'Just posted' } }
    ]}), { status: 200 });
    return prevFetch(u);
  };
  const r = await W.tick({ MINUTE: KV, DB, YT_API_KEY:'k', CHANNEL_ID:'UC1' });
  Date.now = realNow;
  globalThis.fetch = prevFetch;

  const after = JSON.parse(KV.store.get('minute-v1'));
  check('the discovery forced a write despite the gate', r.wrote === true, JSON.stringify(r));
  check('the new video is in the persisted roster', !!after.videos[NEWID], Object.keys(after.videos).join(','));
}

console.log('\n11. rosterOf ignores samples and notices everything else');
{
  const a = { v: { pub: 'p', title: 't', chan: 'c', d1m: 'x', s: [[1, 2, 3, 4]] } };
  const b = { v: { pub: 'p', title: 't', chan: 'c', d1m: 'x', s: [[1, 2, 3, 4], [5, 6, 7, 8]] } };
  check('a new sample is not a roster change', W.rosterOf(a) === W.rosterOf(b));
  check('a new video is', W.rosterOf(a) !== W.rosterOf({ ...a, w: { pub: 'q' } }));
  check('a retitle is', W.rosterOf(a) !== W.rosterOf({ v: { ...a.v, title: 'other' } }));
  check('a metadata fingerprint change is', W.rosterOf(a) !== W.rosterOf({ v: { ...a.v, d1m: 'y' } }));
}

console.log('\n12. A failed write must not mark the metadata as stated');
{
  // the sequence that would otherwise hide a video forever: D1 is down for the video's
  // first sample (metadata marked as stated anyway), then recovers. Samples retry
  // naturally as new rows -- the videos row would never be retried, and the bundle
  // walks videos, so the curve would exist in the samples table and appear nowhere.
  const st = JSON.parse(JSON.stringify(seedState));
  st.d1Backfilled = W.D1_BACKFILL_V;                 // no backfill in the way
  const KV = mockKV({ 'minute-v1': JSON.stringify(st) });

  const down = mockD1({ fail: true });
  const r1 = await W.tick({ MINUTE: KV, DB: down, YT_API_KEY:'k', CHANNEL_ID:'UC1' });
  check('the failed tick reports its error', !!(r1.d1 && r1.d1.error), JSON.stringify(r1.d1));
  const afterFail = JSON.parse(KV.store.get('minute-v1'));
  check('fingerprint NOT persisted after the failure', !afterFail.videos.v1.d1m,
    JSON.stringify(afterFail.videos.v1.d1m));

  const up = mockD1();
  await W.tick({ MINUTE: KV, DB: up, YT_API_KEY:'k', CHANNEL_ID:'UC1' });
  check('the healthy tick re-states the metadata', up.rows.videos.size === 1, up.rows.videos.size);
  const afterOk = JSON.parse(KV.store.get('minute-v1'));
  check('and only now records it as stated', !!afterOk.videos.v1.d1m, JSON.stringify(afterOk.videos.v1.d1m));
}

globalThis.fetch = realFetch;
console.log('\n' + (fail? '✗ '+fail+' FAILED, ':'') + pass + ' passed');
process.exit(fail?1:0);
