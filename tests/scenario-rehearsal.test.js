'use strict';
// Répétition du scénario réel contre le faux GitHub : prouve que le scénario lui-même est correct avant de le lancer pour de vrai.
const test = require('node:test');
const { createFakeGitHub } = require('./helpers/fake-github.js');
const { run } = require('./helpers/scenario.js');
test('scénario complet (ancien format -> migration -> 2 appareils -> 1.3.2) contre le faux GitHub', async () => {
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': '{}', 'notes/vieux.md': '---\nid: vieux\ntitle: v\n---\nx' } });
  await run({ repo: 'o/r', token: 'faux-jeton', apiBase: 'https://api.github.com', fetchImpl: fake.fetch });
});
