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
test('chaque code d\'erreur produit par l\'appli a un message', () => {
  for (const k of ['auth', 'repo', 'net', 'conflict', 'legacy', 'legacymixed', 'massdelete']) {
    assert.ok(Array.isArray(GH_ERRORS[k]) && GH_ERRORS[k][0] && GH_ERRORS[k][1], k);
  }
});
