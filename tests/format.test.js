'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Core = require('../src/sync-core.js');
const { gitHash } = require('../src/github-store.js');

test('serialize produit exactement le format de vault.rs', () => {
  const t = Core.serialize({ id: 'n1', title: 'Ma note', body: 'Texte\nligne 2', pinned: true, created: 1700000000000, updated: 1700000000001 });
  assert.equal(t, '---\nid: n1\ntitle: Ma note\npinned: true\ncreated: 1700000000000\nupdated: 1700000000001\n---\nTexte\nligne 2');
});
test('aller-retour : corps, titre accentué, lignes vides, --- dans le corps', () => {
  const n = { id: 'n-abc_1.2', title: 'Été « test » : deux points', body: '\n\n---\nautre\n---\n\ncorps  \n', pinned: false, created: 5, updated: 9 };
  assert.deepEqual(Core.parse(Core.serialize(n)), n);
});
test('corps vide et titre avec retour à la ligne', () => {
  const r = Core.parse(Core.serialize({ id: 'a', title: 'a\nb', body: '', pinned: false, created: 1, updated: 2 }));
  assert.equal(r.title, 'a b'); assert.equal(r.body, '');
});
test('CRLF accepté comme vault.rs', () => {
  const r = Core.parse('---\r\nid: x\r\ntitle: T\r\n---\r\nA\r\nB');
  assert.equal(r.body, 'A\nB');
});
test('ids invalides refusés', () => {
  for (const id of ['', '.x', 'a--b', 'a/b', 'a b', 'x'.repeat(121), '../x', 'é']) assert.equal(Core.validId(id), false, id);
  for (const id of ['n1', 'seed-bienvenue', 'a_b.c']) assert.equal(Core.validId(id), true, id);
  assert.equal(Core.parse('---\nid: a/b\ntitle: x\n---\n'), null);
  assert.equal(Core.parse('pas un en-tête'), null);
});
test('chemins notes/<id>.md', () => {
  assert.equal(Core.notePath('n1'), 'notes/n1.md');
  assert.equal(Core.idFromPath('notes/n1.md'), 'n1');
  for (const p of ['notes/a/b.md', 'notes/n1.txt', 'autre/n1.md', 'grimoire-notes.json', 'notes/.md', 'notes/a--b.md']) assert.equal(Core.idFromPath(p), null, p);
});
test('le marqueur n\'est jamais du JSON valide, ni seul ni avec espaces/retours', () => {
  for (const v of [Core.MARKER, Core.MARKER.trim(), Core.MARKER + '\n', ' ' + Core.MARKER]) assert.throws(() => JSON.parse(v));
  assert.ok(/^[A-Za-z]/.test(Core.MARKER) && Core.MARKER.includes(' '));
  assert.equal(Core.isLegacy(Core.MARKER), false);
  assert.equal(Core.isLegacy('{}'), false);
  assert.equal(Core.isLegacy('{"notes":[]}'), true);
});
test('empreinte git identique à git hash-object', async () => {
  assert.equal(await gitHash('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(await gitHash(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(await gitHash('é'), (await import('node:child_process')).execSync('printf "é" | git hash-object --stdin').toString().trim());
});
test('repli SHA-1 en JS pur identique à WebCrypto (vecteurs et textes aléatoires)', async () => {
  const { sha1 } = require('../src/github-store.js'), nodeCrypto = require('node:crypto'), enc = new TextEncoder();
  assert.equal(sha1(enc.encode('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(sha1(enc.encode('')), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  for (const len of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 5000]) {
    const b = nodeCrypto.randomBytes(len); assert.equal(sha1(b), nodeCrypto.createHash('sha1').update(b).digest('hex'), 'longueur ' + len);
  }
});
