'use strict';
// Exécute le vrai code de synchro d'app.js (extrait du fichier) avec le vrai cœur et le vrai adaptateur, contre le faux GitHub.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const Core = require('../src/sync-core.js');
const { createFakeGitHub } = require('./helpers/fake-github.js');

const root = path.join(__dirname, '..', 'src'), app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const glue = app.slice(app.indexOf('const ghState'), app.indexOf('function seedNotes'));
const fromDocSrc = app.match(/const fromDoc = .*;/)[0];

function device(fake, notes = [], token = 'faux-jeton') {
  const toasts = [], LSdata = {};
  const ctx = vm.createContext({
    fetch: fake.fetch, crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob, Date, JSON, Object, Array, Set, Map, Promise, setTimeout, clearTimeout, Math, console,
    GH: { cfg: { repo: 'o/r' }, token, busy: false, queued: false, err: null, timer: 0, last: 0 },
    S: { backend: { kind: 'github' }, notes: new Map(notes.map(n => [n.id, n])) },
    dirty: new Set(), saving: new Set(),
    LS: { get: k => (k in LSdata ? JSON.parse(LSdata[k]) : null), set: (k, v) => { LSdata[k] = JSON.stringify(v); } },
    newId: (() => { let i = 0; return () => 'cp' + (++i); })(),
    ghOn: () => true, persistVault: { now() {} }, paintSync() {}, afterRemote() {}, ghSchedule() {}, closePops() {},
    toast: (m, o) => toasts.push({ m, action: o && o.action, fn: o && o.fn }), plural: (n, a, b) => n + ' ' + (n > 1 ? b : a), esc: x => x
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sync-core.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'github-store.js'), 'utf8'), ctx);
  vm.runInContext(fromDocSrc + '\n' + glue + '\nthis.__sync = ghSync; this.__migrate = ghMigrate;', ctx);
  return { ctx, toasts, LSdata, sync: o => ctx.__sync(o), GH: ctx.GH, S: ctx.S };
}
const n = (id, body, x = {}) => ({ id, title: 'T-' + id, body, pinned: false, created: 1, updated: 10, ...x });

test('synchro normale : notes poussées, état enregistré sans texte de note ni jeton', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } }), a = device(fake, [n('n1', 'secret-contenu')]);
  await a.sync();
  assert.equal(a.GH.err, null); assert.ok(fake.files()['notes/n1.md']);
  const st = a.LSdata['grimoire.sync2']; assert.ok(st && !st.includes('secret-contenu') && !st.includes('faux-jeton'));
});
test('dépôt à l\'ancien format : pause + invitation à migrer ; l\'action migre, vérifie et reprend la synchro', async () => {
  const legacy = JSON.stringify({ app: 'grimoire', v: 1, notes: [n('n1', 'un'), n('n2', 'deux')], deleted: {} });
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': legacy } }), a = device(fake, [n('n1', 'un')]);
  await a.sync();
  assert.equal(a.GH.err, 'legacy'); assert.equal(Object.keys(fake.files()).filter(p => p.startsWith('notes/')).length, 0);
  const t = a.toasts.find(x => x.action === 'Migrer'); assert.ok(t);
  await t.fn(); await new Promise(r => setTimeout(r, 50));
  assert.equal(fake.files()['grimoire-notes.json'], Core.MARKER);
  assert.equal(a.S.notes.size, 2); assert.equal(a.GH.err, null);
  assert.ok(a.toasts.some(x => /Migration terminée et vérifiée : 2 notes/.test(x.m)));
});
test('suppression massive : bloquée avec message, rien supprimé ; confirmée, elle s\'applique', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } }), all = Array.from({ length: 20 }, (_, i) => n('n' + i, 'c' + i)), a = device(fake, all);
  await a.sync();
  a.S.notes.clear();
  await a.sync();
  assert.equal(a.GH.err, 'massdelete'); assert.equal(Object.keys(fake.files()).filter(p => p.startsWith('notes/')).length, 20);
  const t = a.toasts.find(x => x.action === 'Confirmer'); assert.ok(t);
  await t.fn(); await new Promise(r => setTimeout(r, 50));
  assert.equal(Object.keys(fake.files()).filter(p => p.startsWith('notes/')).length, 0);
});
test('conflit entre deux appareils : message clair, deux textes gardés', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } }), a = device(fake, [n('n1', 'x')]), b = device(fake, []);
  await a.sync(); await b.sync();
  a.S.notes.set('n1', n('n1', 'version A', { updated: 20 })); b.S.notes.set('n1', n('n1', 'version B', { updated: 21 }));
  await a.sync(); await b.sync();
  assert.ok(b.toasts.some(x => /Conflit sur « T-n1 »/.test(x.m)));
  const texts = [...b.S.notes.values()].map(x => x.body).sort(); assert.deepEqual(texts, ['version A', 'version B']);
});
test('erreurs : jeton refusé, dépôt absent, réseau coupé — codes d\'erreur et aucun jeton dans les messages', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } });
  const bad = device(fake, [n('n1', 'x')], 'jeton-secret-xyz'); await bad.sync(); assert.equal(bad.GH.err, 'auth');
  const off = device({ fetch: async () => { throw new TypeError('network'); } }, [n('n1', 'x')]); await off.sync(); assert.equal(off.GH.err, 'net');
  const gone = device({ fetch: async () => new Response('{}', { status: 404 }) }, []); await gone.sync(); assert.equal(gone.GH.err, 'repo');
  for (const d of [bad, off, gone]) assert.ok(!JSON.stringify(d.toasts.map(t => t.m)).includes('jeton-secret-xyz'));
});
