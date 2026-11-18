'use strict';
// Exécute le VRAI code de synchro de la 1.3.2 (extrait de `git show v1.3.2:src/app.js`) contre le faux GitHub,
// pour prouver ce que l'ancienne appli fait d'un fichier marqueur, absent, ou égal à "{}".
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), { execFileSync } = require('node:child_process'), path = require('node:path');
const Core = require('../src/sync-core.js');
const { createFakeGitHub } = require('./helpers/fake-github.js');

let source = null;
try { source = execFileSync('git', ['show', 'v1.3.2:src/app.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* tag absent */ }
const skip = source ? false : 'tag v1.3.2 introuvable (clone sans tags)';

function oldApp(fake, localNotes) {
  const a = source.indexOf('function ghMerge'), b = source.indexOf('function seedNotes');
  const grab = re => { const m = source.match(re); if (!m) throw new Error('extraction impossible : ' + re); return m[0]; };
  const code = grab(/const toDoc = .*;/) + '\n' + grab(/const fromDoc = .*;/) + '\n' + source.slice(a, b);
  const calls = { puts: 0, afterRemote: 0 };
  const ctx = vm.createContext({
    fetch: (u, i) => { if (i && i.method === 'PUT') calls.puts++; return fake.fetch(u, i); },
    btoa: s => Buffer.from(s, 'latin1').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('latin1'),
    TextEncoder, TextDecoder, Uint8Array, Date, JSON, Object, Array, Set, Map, Promise, setTimeout, clearTimeout, console,
    GH: { cfg: { repo: 'o/r' }, token: 'faux-jeton', tomb: {}, busy: false, queued: false, err: null, timer: 0, last: 0 },
    S: { backend: { kind: 'github' }, notes: new Map(localNotes.map(n => [n.id, n])) },
    dirty: new Set(), saving: new Set(), LS: { set() {}, get() { return null; } },
    ghOn: () => true, persistVault: { now() {} }, paintSync() {}, afterRemote() { calls.afterRemote++; }, ghSchedule() {},
    b64e: s => { const bytes = new TextEncoder().encode(s); return Buffer.from(bytes).toString('base64'); },
    b64d: s => Buffer.from(String(s).replace(/\s/g, ''), 'base64').toString('utf8')
  });
  vm.runInContext(code + '\nthis.__sync = ghSync;', ctx);
  return { run: () => ctx.__sync(), ctx, calls };
}
const local = [{ id: 'loc1', title: 'Locale', body: 'texte local', pinned: false, created: 1, updated: 2 }];

test('1.3.2 : devant le marqueur, elle refuse (fichier illisible) et n\'écrit RIEN', { skip }, async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': Core.MARKER, 'notes/n1.md': Core.serialize({ id: 'n1', title: 't', body: 'b', pinned: false, created: 1, updated: 1 }) } });
  const before = JSON.stringify(fake.files()), headBefore = fake.G.head, app = oldApp(fake, local);
  await app.run();
  assert.equal(app.ctx.GH.err, 'badfile');
  assert.equal(app.calls.puts, 0);
  assert.equal(fake.G.head, headBefore, 'aucun commit créé');
  assert.equal(JSON.stringify(fake.files()), before);
});
test('1.3.2 : si le fichier racine est ABSENT, elle le recrée en JSON (c\'est pourquoi on ne le supprime jamais)', { skip }, async () => {
  const fake = createFakeGitHub({ files: { 'notes/n1.md': 'x' } }), app = oldApp(fake, local);
  await app.run();
  assert.equal(app.calls.puts, 1);
  assert.ok(Core.isLegacy(fake.files()['grimoire-notes.json']));
});
test('1.3.2 : si le fichier racine vaut "{}", elle l\'écrase (c\'est pourquoi le marqueur n\'est pas "{}")', { skip }, async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': '{}' } }), app = oldApp(fake, local);
  await app.run();
  assert.equal(app.calls.puts, 1);
  assert.ok(Core.isLegacy(fake.files()['grimoire-notes.json']));
});
test('1.3.2 : après migration complète, le marqueur survit à plusieurs tentatives de synchro de l\'ancienne appli', { skip }, async () => {
  const { createMemoryStorage } = require('./helpers/memory-storage.js'); void createMemoryStorage;
  const GHs = require('../src/github-store.js');
  const legacy = JSON.stringify({ app: 'grimoire', v: 1, notes: [{ id: 'n1', title: 'A', body: 'a', pinned: false, created: 1, updated: 2 }], deleted: {} });
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': legacy } });
  await Core.migrate({ storage: GHs.create({ repo: 'o/r', token: 'faux-jeton', fetch: fake.fetch }), legacyText: legacy });
  const snap = JSON.stringify(fake.files());
  for (let i = 0; i < 3; i++) { const app = oldApp(fake, local); await app.run(); assert.equal(app.ctx.GH.err, 'badfile'); }
  assert.equal(JSON.stringify(fake.files()), snap);
});
