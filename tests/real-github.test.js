'use strict';
// Test RÉEL contre le dépôt jetable LonerFy/grimoire-notes-test, uniquement si GRIMOIRE_TEST_TOKEN est défini.
// Garde-fous : un seul dépôt autorisé (codé en dur), jamais d'écriture ailleurs, le jeton n'est ni affiché ni mis dans un message.
const test = require('node:test'), assert = require('node:assert/strict');
const { run } = require('./helpers/scenario.js');
const REPO = 'LonerFy/grimoire-notes-test', TOKEN = process.env.GRIMOIRE_TEST_TOKEN || '';
const skip = TOKEN ? false : 'GRIMOIRE_TEST_TOKEN non défini : test réel ignoré';

test('réel : dépôt jetable — migration, deux appareils, conflit, 1.3.2', { skip, timeout: 300000 }, async () => {
  assert.equal(REPO, 'LonerFy/grimoire-notes-test');
  const r = await fetch('https://api.github.com/repos/' + REPO, { headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/vnd.github+json' } });
  assert.equal(r.status, 200, 'dépôt jetable inaccessible avec ce jeton (statut ' + r.status + ')');
  const j = await r.json();
  assert.equal(j.full_name, REPO); assert.equal(j.private, true, 'le dépôt de test doit être privé');
  try { await run({ repo: REPO, token: TOKEN, log: m => console.log('  [réel] ' + m) }); }
  catch (e) { e.message = String(e.message).split(TOKEN).join('***'); if (e.stack) e.stack = e.stack.split(TOKEN).join('***'); throw e; }
});
