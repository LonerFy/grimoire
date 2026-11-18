'use strict';
// Textes affichés à l'utilisateur, extraits de src/app.js : on vérifie le libellé exact et on bloque les anciennes formulations.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

function grab(name) {
  const i = app.indexOf('const ' + name + ' = {'); assert.ok(i >= 0, name + ' introuvable dans app.js');
  const j = app.indexOf('\n};', i); assert.ok(j > i);
  return vm.runInNewContext('(' + app.slice(i + ('const ' + name + ' = ').length, j + 2) + ')');
}
const SYNC = grab('SYNC'), GH_ERRORS = grab('GH_ERRORS');

test('badge : synchro en pause ou bloquée', () => {
  assert.equal(SYNC.error[0], 'Synchro en pause');
  assert.equal(SYNC.error[1], 'Synchronisation interrompue');
  assert.ok(!/Non enregistré|Enregistrement interrompu/.test(JSON.stringify(SYNC)));
});
test('erreur 404 : message demandé', () => {
  assert.equal(GH_ERRORS.repo[0], 'Dépôt ou accès introuvable');
  assert.equal(GH_ERRORS.repo[1], 'Vérifie le nom (propriétaire/nom) et que ton jeton couvre ce dépôt.');
});
test('ancien format : message « Migrer » simplifié, identique dans la bulle', () => {
  assert.equal(GH_ERRORS.legacy[1], "Ton dépôt GitHub utilise l'ancien format. Migre-le pour reprendre la synchro : l'ancien fichier est gardé dans legacy/. Clone ton dépôt avant, par sécurité.");
  assert.ok(!/un seul fichier|grimoire-notes\.json/.test(GH_ERRORS.legacy[1]));
  assert.ok(!app.includes('est encore à l\'ancien format (un seul fichier)'));
});
test('chaque code d\'erreur produit par l\'appli a un message', () => {
  for (const k of ['auth', 'repo', 'net', 'conflict', 'legacy', 'legacymixed', 'massdelete']) {
    assert.ok(Array.isArray(GH_ERRORS[k]) && GH_ERRORS[k][0] && GH_ERRORS[k][1], k);
  }
});

function seeds() {
  const i = app.indexOf('function seedNotes()'), j = app.indexOf('\n}\n', i);
  assert.ok(i >= 0 && j > i);
  return vm.runInNewContext('(' + app.slice(i, j + 2) + ')()');
}
test('note d\'accueil « Synchronisation » : conflit = copie, rien n\'est perdu', () => {
  const n = seeds().find(x => x.id === 'seed-synchro');
  assert.ok(n, 'note seed-synchro absente');
  assert.ok(!/dernière écriture|l'emporte/.test(n.body), 'ancienne règle encore présente');
  assert.ok(n.body.includes('aucune version n\'est perdue'));
  assert.ok(n.body.includes('« (conflit …) »'));
});
test('aucune note d\'accueil ne promet encore « la dernière écriture »', () => {
  for (const n of seeds()) assert.ok(!/dernière écriture/.test(n.body), n.id);
});

test('note d\'accueil « Synchronisation » : le badge décrit les vrais libellés', () => {
  const n = seeds().find(x => x.id === 'seed-synchro');
  assert.ok(!/rouge pendant l'envoi|Le point à côté/.test(n.body), 'ancienne description du point');
  for (const lib of [SYNC.synced[0], SYNC.saving[0], SYNC.error[0]]) assert.ok(n.body.includes('« ' + lib + ' »'), 'libellé « ' + lib + ' » absent de la note');
  assert.ok(n.body.includes('(point rouge)'));
});
