// Harness: run the real worker.js tick() against a mock KV + mock D1 and assert the
// dual-write contract — KV behaviour byte-identical, D1 mirrored, D1 faults invisible.
import fs from 'fs';
const HERE = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(HERE + 'worker.js', 'utf8')
  .replace(/export default\s*\{/, 'const HANDLER = {') + '\nexport { HANDLER, tick, ttTick, d1Write, d1Backfill, d1Prune, D1_BACKFILL_V };';
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
    prepare(sql){ return { sql, bind:(...a)=>({sql, args:a}) }; },
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
console.log('\n6. Prune only fires in its daily slot');
{
  const DB = mockD1(); DB.prepare = sql => ({ bind: () => ({ async run(){ return { meta:{ changes: 42 } }; } }) });
  const t = new Date(NOW); t.setUTCHours(3,7,0,0);
  const off = new Date(NOW); off.setUTCHours(11,22,0,0);
  const a = await W.d1Prune({DB}, t.getTime());
  const b = await W.d1Prune({DB}, off.getTime());
  check('prunes at 03:07 UTC', a.pruned === 42, JSON.stringify(a));
  check('skips every other minute', !!b.skipped, JSON.stringify(b));
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

globalThis.fetch = realFetch;
console.log('\n' + (fail? '✗ '+fail+' FAILED, ':'') + pass + ' passed');
process.exit(fail?1:0);
