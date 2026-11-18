'use strict';
// Logique de scripts/verify-migration.js sur des dépôts fictifs (aucun appel à GitHub, aucun vrai dépôt).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const Core = require('../src/sync-core.js');
const { verify, REPO } = require('../scripts/verify-migration.js');

const note = (id, body, x = {}) => ({ id, title: 'T-' + id, body, pinned: false, created: 1000, updated: 2000, ...x });
const backupText = JSON.stringify({ app: 'grimoire', v: 1, notes: [note('a', 'un'), note('b', 'deux\nlignes', { pinned: true }), note('gone', 'supprimée', { updated: 5 })], deleted: { gone: 9 } });

/** Dépôt tel que la migration le produit. */
function migrated() {
  const plan = Core.planMigration(backupText, Date.UTC(2026, 10, 18, 12, 0));
  const files = { [Core.ROOT_FILE]: Core.MARKER, [plan.legacyName]: backupText };
  for (const [id, t] of Object.entries(plan.files)) files[Core.notePath(id)] = t;
  return files;
}
const run = files => verify({ repo: { files, other: ['README.md'] }, backupText });
const msgs = (r, level) => r.checks.filter(c => c.level === level).map(c => c.msg).join(' | ');

test('dépôt migré conforme : aucun échec, aucun avertissement', () => {
  const r = run(migrated());
  assert.equal(r.fails, 0, msgs(r, 'fail')); assert.equal(r.warns, 0, msgs(r, 'warn'));
  assert.match(msgs(r, 'ok'), /2 notes attendues/); // la note supprimée n'est pas attendue, et le « 9 » n'est plus codé en dur
});
test('notes locales en plus : avertissement « attendu », jamais un échec', () => {
  const f = migrated(); f['notes/loc1.md'] = Core.serialize(note('loc1', 'locale 1')); f['notes/loc2.md'] = Core.serialize(note('loc2', 'locale 2'));
  const r = run(f);
  assert.equal(r.fails, 0, msgs(r, 'fail')); assert.equal(r.warns, 1);
  assert.match(msgs(r, 'warn'), /2 note\(s\) locale\(s\) en plus de la sauvegarde — ATTENDU/);
});
test('copies « conflit » (ancien nom et nouveau nom UTC) : avertissement à relire, distinct des notes locales', () => {
  const f = migrated();
  f['notes/c1.md'] = Core.serialize(note('c1', 'x', { title: 'Monade (conflit 2026-11-18 06:23)' }));
  f['notes/c2.md'] = Core.serialize(note('c2', 'y', { title: 'Monade (conflit 2026-11-18 12:23 UTC)' }));
  const r = run(f);
  assert.equal(r.fails, 0); assert.match(msgs(r, 'warn'), /2 copie\(s\) « conflit » — à relire/); assert.doesNotMatch(msgs(r, 'warn'), /ATTENDU/);
});
test('racine : JSON valide, absente, ou sans marqueur → échec', () => {
  for (const root of [backupText, '{}', 'texte libre']) { const f = migrated(); f[Core.ROOT_FILE] = root; assert.ok(run(f).fails >= 1, root.slice(0, 12)); }
  const f = migrated(); delete f[Core.ROOT_FILE]; assert.match(msgs(run(f), 'fail'), /absent : il ne doit jamais/);
});
test('legacy/ absent ou altéré → échec', () => {
  const f = migrated(); for (const p of Object.keys(f)) if (p.startsWith('legacy/')) delete f[p];
  assert.match(msgs(run(f), 'fail'), /legacy\/ absent/);
  const g = migrated(); for (const p of Object.keys(g)) if (p.startsWith('legacy/')) g[p] += ' ';
  assert.match(msgs(run(g), 'fail'), /aucun fichier de legacy\/ n'est identique/);
});
test('note manquante, corps modifié, id incohérent, nom invalide → échecs précis', () => {
  const miss = migrated(); delete miss['notes/a.md']; assert.match(msgs(run(miss), 'fail'), /absentes du dépôt : a/);
  const alt = migrated(); alt['notes/b.md'] = Core.serialize(note('b', 'deux\nlignes MODIFIÉES', { pinned: true })); assert.match(msgs(run(alt), 'fail'), /b : diffère \(corps\)/);
  const pin = migrated(); pin['notes/b.md'] = Core.serialize(note('b', 'deux\nlignes', { pinned: false })); assert.match(msgs(run(pin), 'fail'), /b : diffère \(épinglée\)/);
  const idm = migrated(); idm['notes/a.md'] = Core.serialize(note('zzz', 'un')); assert.match(msgs(run(idm), 'fail'), /ne correspond pas au nom du fichier/);
  const bad = migrated(); bad['notes/sous/dossier.md'] = 'x'; assert.match(msgs(run(bad), 'fail'), /ne sont pas notes\/<id>\.md/);
  const ill = migrated(); ill['notes/ill.md'] = 'pas une note'; assert.match(msgs(run(ill), 'fail'), /ill\.md : illisible/);
});
test('le script ne vise que le dépôt jetable et ne s\'exécute pas à l\'import', () => {
  assert.equal(REPO, 'LonerFy/grimoire-notes-test');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-migration.js'), 'utf8');
  assert.doesNotMatch(src, /LonerFy\/grimoire-notes(?!-test)/, 'référence au vrai dépôt');
  assert.match(src, /full_name !== REPO/); assert.match(src, /info\.private/);
  assert.doesNotMatch(src, /process\.env|writeFile|PUT|POST|PATCH|DELETE/, 'le script doit rester en lecture seule');
});
