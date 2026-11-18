'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Core = require('../src/sync-core.js');
const GH = require('../src/github-store.js');
const { createFakeGitHub } = require('./helpers/fake-github.js');
const { createDevice } = require('./helpers/device.js');

const mk = (fake, token = 'faux-jeton') => GH.create({ repo: 'o/r', token, fetch: fake.fetch });
const note = (id, body, x = {}) => ({ id, title: 'T-' + id, body, pinned: false, created: 1, updated: 10, ...x });

test('dépôt vide : le marqueur est créé par l\'API Contents, puis les notes en un commit', async () => {
  const fake = createFakeGitHub(), a = createDevice('a', mk(fake));
  a.put(note('n1', 'un')); a.put(note('n2', 'deux'));
  await a.sync();
  const f = fake.files();
  assert.equal(f['grimoire-notes.json'], Core.MARKER);
  assert.equal(Core.parse(f['notes/n1.md']).body, 'un'); assert.equal(Core.parse(f['notes/n2.md']).body, 'deux');
});
test('une synchro réelle = un seul commit pour N notes', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } }), a = createDevice('a', mk(fake));
  for (let i = 0; i < 12; i++) a.put(note('n' + i, 'c' + i));
  const before = fake.G.commits.size; await a.sync();
  assert.equal(fake.G.commits.size, before + 1);
  assert.equal(Object.keys(fake.files()).filter(p => p.startsWith('notes/')).length, 12);
});
test('deux appareils via le faux GitHub : aller-retour, conflit, suppression', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } });
  const a = createDevice('a', mk(fake)), b = createDevice('b', mk(fake));
  a.put(note('n1', 'x')); a.put(note('n2', 'y')); await a.sync(); await b.sync();
  assert.equal(b.local.size, 2);
  a.put({ ...a.local.get('n1'), body: 'A', updated: 20 }); b.put({ ...b.local.get('n1'), body: 'B', updated: 21 });
  await a.sync(); const r = await b.sync(); assert.equal(r.conflicts.length, 1);
  b.local.delete('n2'); await b.sync(); await a.sync();
  assert.ok(!a.local.has('n2')); assert.equal(a.local.size, 2);
});
test('tête qui bouge pendant le commit (PATCH refusé) : nouvel essai, rien de perdu', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } }), a = createDevice('a', mk(fake)), other = mk(fake);
  a.put(note('n1', 'x'));
  fake.G.onPatchRef = async () => { /* un autre client écrit entre-temps */ fake.setFiles({ 'notes/zz.md': Core.serialize(note('zz', 'ailleurs')) }); };
  await a.sync();
  assert.equal(Core.parse(fake.files()['notes/zz.md']).body, 'ailleurs'); assert.equal(Core.parse(fake.files()['notes/n1.md']).body, 'x');
});
test('interrogation sans changement : une seule requête conditionnelle (304)', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } }), a = createDevice('a', mk(fake));
  a.put(note('n1', 'x')); await a.sync(); await a.sync();
  const n0 = fake.requests().length; await a.sync();
  const extra = fake.requests().slice(n0);
  assert.equal(extra.length, 1, extra.join(' | ')); assert.match(extra[0], /GET \/git\/ref\/heads\/main/);
});
test('seules les notes modifiées sont relues', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER } });
  const a = createDevice('a', mk(fake)), b = createDevice('b', mk(fake));
  for (let i = 0; i < 10; i++) a.put(note('n' + i, 'c' + i));
  await a.sync(); await b.sync();
  a.put({ ...a.local.get('n3'), body: 'neuf', updated: 50 }); await a.sync();
  const n0 = fake.requests().length; await b.sync();
  const blobs = fake.requests().slice(n0).filter(r => r.startsWith('GET /git/blobs/'));
  assert.equal(blobs.length, 1);
  assert.equal(b.local.get('n3').body, 'neuf');
});
test('erreurs : jeton refusé (401), dépôt absent (404), sans fuite du jeton', async () => {
  const fake = createFakeGitHub({ token: 'secret-123' });
  const bad = mk(fake, 'mauvais-jeton-xyz');
  await assert.rejects(bad.list(), e => { assert.equal(e.status, 401); assert.ok(!JSON.stringify(e).includes('mauvais-jeton-xyz') && !String(e.stack).includes('mauvais-jeton-xyz')); return true; });
  const gone = GH.create({ repo: 'o/r', token: 'secret-123', fetch: async () => new Response('{}', { status: 404 }) });
  await assert.rejects(gone.list(), e => e.status === 404);
});
test('migration complète via l\'adaptateur : notes, sauvegarde legacy/, marqueur, vérification', async () => {
  const legacy = JSON.stringify({ app: 'grimoire', v: 1, notes: [note('n1', 'un'), note('n2', 'deux\nlignes', { pinned: true }), note('n3', 'supprimée', { updated: 5 })], deleted: { n3: 9 } });
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': legacy, 'README.md': 'autre fichier' } });
  const st = mk(fake);
  const a = createDevice('a', st); a.put(note('n1', 'un'));
  await assert.rejects(a.sync(), e => e.code === 'legacy');
  const root = await st.readRoot();
  assert.equal(Core.isLegacy(root), true);
  const res = await Core.migrate({ storage: st, legacyText: root, when: Date.UTC(2026, 10, 18, 10, 30) });
  assert.equal(res.count, 2);
  const f = fake.files();
  assert.equal(f['grimoire-notes.json'], Core.MARKER);
  assert.equal(f['legacy/grimoire-notes.v1.20261118-1030.json'], legacy, 'sauvegarde identique octet pour octet');
  assert.equal(f['README.md'], 'autre fichier');
  assert.ok(!f['notes/n3.md'], 'note supprimée non migrée');
  assert.equal(Core.parse(f['notes/n2.md']).pinned, true);
  await a.sync(); // après migration la synchro marche, la note locale identique n'est pas dupliquée
  assert.equal(a.local.size, 2); assert.equal(a.lastResult.conflicts.length, 0);
});
test('migration : refusée si le dépôt a déjà des notes/, ou si un id est invalide ; vérification qui détecte une écriture altérée', async () => {
  const legacy = JSON.stringify({ notes: [note('n1', 'x')], deleted: {} });
  const done = createFakeGitHub({ files: { 'grimoire-notes.json': legacy, 'notes/z.md': Core.serialize(note('z', 'z')) } });
  await assert.rejects(Core.migrate({ storage: mk(done), legacyText: legacy }), e => e.code === 'deja-migre');
  const badIds = JSON.stringify({ notes: [note('a/b', 'x'), note('ok', 'y')], deleted: {} });
  const f2 = createFakeGitHub({ files: { 'grimoire-notes.json': badIds } });
  await assert.rejects(Core.migrate({ storage: mk(f2), legacyText: badIds }), e => e.code === 'legacy-ids' && e.ids[0] === 'a/b');
  assert.equal(f2.files()['grimoire-notes.json'], badIds, 'dépôt intact après refus');
  const f3 = createFakeGitHub({ files: { 'grimoire-notes.json': legacy } }), st = mk(f3), real = st.read;
  st.read = async ids => { const o = await real(ids); for (const k of Object.keys(o)) o[k] += 'X'; return o; };
  await assert.rejects(Core.migrate({ storage: st, legacyText: legacy }), e => e.code === 'verif');
});
test('migration : fichier illisible refusé, rien d\'écrit', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': '{pas du json' } });
  await assert.rejects(Core.migrate({ storage: mk(fake), legacyText: '{pas du json' }), e => e.code === 'legacy-illisible');
  assert.equal(fake.files()['grimoire-notes.json'], '{pas du json');
});
