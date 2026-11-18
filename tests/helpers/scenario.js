// Scénario de bout en bout sur un dépôt de notes : ancien format -> migration -> deux appareils -> conflit -> suppression -> ancienne appli 1.3.2.
// Utilisé deux fois : en répétition contre le faux GitHub, et pour de vrai contre le dépôt jetable (si GRIMOIRE_TEST_TOKEN est défini).
'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm'), { execFileSync } = require('node:child_process'), path = require('node:path');
const Core = require('../../src/sync-core.js'), GH = require('../../src/github-store.js');
const { createDevice } = require('./device.js');

const note = (id, body, x = {}) => ({ id, title: 'Test ' + id, body, pinned: false, created: 1, updated: 10, ...x });

function oldApp(source, { repo, token, apiBase, fetchImpl }) {
  const a = source.indexOf('function ghMerge'), b = source.indexOf('function seedNotes');
  const grab = re => source.match(re)[0];
  const code = grab(/const toDoc = .*;/) + '\n' + grab(/const fromDoc = .*;/) + '\n' + source.slice(a, b);
  const ctx = vm.createContext({
    fetch: (u, i) => (fetchImpl || fetch)(String(u).replace('https://api.github.com', apiBase), i),
    btoa, atob, TextEncoder, TextDecoder, Uint8Array, Date, JSON, Object, Array, Set, Map, Promise, setTimeout, clearTimeout, console: { log() {}, error() {} },
    GH: { cfg: { repo }, token, tomb: {}, busy: false, queued: false, err: null, timer: 0, last: 0 },
    S: { backend: { kind: 'github' }, notes: new Map([['loc', { id: 'loc', title: 'Locale', body: 'x', pinned: false, created: 1, updated: 2 }]]) },
    dirty: new Set(), saving: new Set(), LS: { set() {}, get() { return null; } }, ghOn: () => true, persistVault: { now() {} }, paintSync() {}, afterRemote() {}, ghSchedule() {},
    b64e: s => Buffer.from(new TextEncoder().encode(s)).toString('base64'), b64d: s => Buffer.from(String(s).replace(/\s/g, ''), 'base64').toString('utf8')
  });
  vm.runInContext(code + '\nthis.__sync = ghSync;', ctx);
  return ctx;
}

async function run({ repo, token, apiBase = 'https://api.github.com', fetchImpl, log = () => {} }) {
  const store = () => GH.create({ repo, token, apiBase, fetch: fetchImpl });
  const st = store();
  // 0. état de départ : ancien format (JSON à la racine, notes/ vide)
  const cur = await st.list();
  const legacy = JSON.stringify({ app: 'grimoire', v: 1, notes: [note('t1', 'un'), note('t2', 'deux\nlignes', { pinned: true }), note('t3', 'supprimée', { updated: 5 })], deleted: { t3: 9 } });
  await st.commit({ head: cur.head, writes: {}, deletes: Object.keys(cur.notes), extra: { [Core.ROOT_FILE]: legacy }, message: 'test: retour à l\'ancien format' });
  log('départ en ancien format');

  // 1. la nouvelle appli refuse de synchroniser avant migration
  const A = createDevice('a', store()); A.put(note('t1', 'un'));
  await assert.rejects(A.sync(), e => e.code === 'legacy');
  assert.equal((await store().list()).root, 'other');

  // 2. migration + vérification
  const res = await Core.migrate({ storage: store(), legacyText: await store().readRoot() });
  assert.equal(res.count, 2);
  const after = await store().list();
  assert.equal(after.root, 'marker'); assert.deepEqual(Object.keys(after.notes).sort(), ['t1', 't2']);
  log('migration vérifiée');

  // 3. l'ancienne appli 1.3.2 (vrai code) ne touche à rien
  let source = null;
  try { source = execFileSync('git', ['show', 'v1.3.2:src/app.js'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* tag absent */ }
  if (source) {
    const head = (await store().list()).head, ctx = oldApp(source, { repo, token, apiBase, fetchImpl });
    await ctx.__sync();
    assert.equal(ctx.GH.err, 'badfile'); assert.equal((await store().list()).head, head, '1.3.2 n\'a créé aucun commit');
    log('1.3.2 : refuse sans rien écrire');
  } else log('tag v1.3.2 absent : étape ignorée');

  // 4. deux appareils : synchro, conflit sans fusion de lignes, suppression
  const B = createDevice('b', store());
  await A.sync(); await B.sync();
  assert.equal(A.local.size, 2); assert.equal(B.local.size, 2); assert.equal(A.lastResult.conflicts.length, 0, 'note identique après migration : pas de copie');
  A.put({ ...A.local.get('t1'), body: 'ligne 1\nA\nligne 3', updated: 20 }); B.put({ ...B.local.get('t1'), body: 'ligne 1\nligne 2\nB', updated: 21 });
  await A.sync(); const r = await B.sync(); assert.equal(r.conflicts.length, 1);
  assert.equal(B.local.get('t1').body, 'ligne 1\nA\nligne 3');
  assert.equal(B.local.get(r.conflicts[0].copyId).body, 'ligne 1\nligne 2\nB');
  await A.sync(); assert.equal(A.local.size, 3);
  B.local.delete('t2'); await B.sync(); await A.sync(); assert.ok(!A.local.has('t2'));
  const fin = await store().list();
  assert.equal(fin.root, 'marker'); assert.equal(Object.keys(fin.notes).length, 2);
  log('deux appareils, conflit, suppression : OK');
}
module.exports = { run };
