'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Core = require('../src/sync-core.js');
const { createMemoryStorage } = require('./helpers/memory-storage.js');
const { createDevice } = require('./helpers/device.js');

const note = (id, body, extra = {}) => ({ id, title: 'T-' + id, body, pinned: false, created: 1, updated: 10, ...extra });
const bodies = st => Object.fromEntries(Object.entries(st.notes()).map(([id, n]) => [id, n.body]));
const allBodies = (...sources) => sources.flatMap(s => Object.values(s).map(n => n.body));

test('première synchro : tout est poussé, le marqueur est créé, la 2e synchro ne fait rien', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st);
  a.put(note('n1', 'un')); a.put(note('n2', 'deux'));
  const r = await a.sync();
  assert.equal(r.pushed, 2);
  assert.deepEqual(bodies(st), { n1: 'un', n2: 'deux' });
  assert.equal(st.state.files.get('grimoire-notes.json'), Core.MARKER);
  const commits = st.state.log.filter(x => x === 'commit').length;
  await a.sync();
  assert.equal(st.state.log.filter(x => x === 'commit').length, commits, 'aucun commit quand rien ne change');
});
test('un autre appareil reçoit, modifie, le premier reçoit', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st), b = createDevice('b', st);
  a.put(note('n1', 'un')); await a.sync();
  await b.sync(); assert.equal(b.local.get('n1').body, 'un');
  b.put({ ...b.local.get('n1'), body: 'un modifié', updated: 20 }); await b.sync();
  await a.sync(); assert.equal(a.local.get('n1').body, 'un modifié');
});
test('conflit : la version distante garde l\'id, la version locale entière devient une copie, rien n\'est perdu', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st), b = createDevice('b', st);
  a.put(note('n1', 'ligne 1\nligne 2\nligne 3')); await a.sync(); await b.sync();
  a.put({ ...a.local.get('n1'), body: 'ligne 1\nA a changé la ligne 2\nligne 3', updated: 20 });
  b.put({ ...b.local.get('n1'), body: 'ligne 1\nligne 2\nB a changé la ligne 3', updated: 21 });
  await a.sync();
  const r = await b.sync();
  assert.equal(r.conflicts.length, 1);
  assert.equal(b.local.get('n1').body, 'ligne 1\nA a changé la ligne 2\nligne 3', 'pas de fusion de lignes : la version distante est intacte');
  const copy = b.local.get(r.conflicts[0].copyId);
  assert.equal(copy.body, 'ligne 1\nligne 2\nB a changé la ligne 3', 'la version locale est conservée en entier');
  assert.match(copy.title, /^T-n1 \(conflit \d{4}-\d\d-\d\d \d\d:\d\d\)$/);
  await a.sync();
  assert.equal(a.local.size, 2); assert.deepEqual(bodies(st), Object.fromEntries([...a.local].map(([id, n]) => [id, n.body])));
});
test('seul l\'épinglage diffère : le plus récent gagne, pas de copie', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st), b = createDevice('b', st);
  a.put(note('n1', 'x')); await a.sync(); await b.sync();
  a.put({ ...a.local.get('n1'), pinned: true, updated: 20 }); await a.sync();
  b.put({ ...b.local.get('n1'), pinned: false, updated: 15 });
  const r = await b.sync();
  assert.equal(r.conflicts.length, 0); assert.equal(b.local.size, 1); assert.equal(b.local.get('n1').pinned, true);
});
test('suppression locale propagée ; suppression distante appliquée', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st), b = createDevice('b', st);
  a.put(note('n1', 'x')); a.put(note('n2', 'y')); await a.sync(); await b.sync();
  a.local.delete('n1'); await a.sync();
  assert.deepEqual(Object.keys(st.notes()), ['n2']);
  await b.sync(); assert.deepEqual([...b.local.keys()], ['n2']);
});
test('supprimée d\'un côté, modifiée de l\'autre : la modification gagne, dans les deux sens', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st), b = createDevice('b', st);
  a.put(note('n1', 'x')); a.put(note('n2', 'y')); await a.sync(); await b.sync();
  // A supprime n1 ; B modifie n1
  a.local.delete('n1'); await a.sync();
  b.put({ ...b.local.get('n1'), body: 'x modifié par B', updated: 30 }); await b.sync();
  assert.equal(bodies(st).n1, 'x modifié par B');
  await a.sync(); assert.equal(a.local.get('n1').body, 'x modifié par B');
  // B supprime n2 ; A modifie n2 avant de synchroniser
  b.local.delete('n2'); await b.sync();
  a.put({ ...a.local.get('n2'), body: 'y modifié par A', updated: 40 });
  await a.sync();
  assert.equal(bodies(st).n2, 'y modifié par A');
});
test('une note en cours d\'édition n\'est jamais écrasée localement', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st), b = createDevice('b', st);
  a.put(note('n1', 'x')); await a.sync(); await b.sync();
  a.put({ ...a.local.get('n1'), body: 'distant', updated: 20 }); await a.sync();
  b.busy.add('n1');
  const r = await b.sync();
  assert.deepEqual(r.skipped, ['n1']); assert.equal(b.local.get('n1').body, 'x');
  b.busy.clear(); await b.sync(); assert.equal(b.local.get('n1').body, 'distant');
});
test('garde-fou : suppression massive refusée sauf confirmation', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st);
  for (let i = 0; i < 20; i++) a.put(note('n' + i, 'c' + i));
  await a.sync();
  a.local.clear(); // coffre local vidé par erreur
  await assert.rejects(a.sync(), e => e.code === 'massdelete' && e.deleteRemote === 20);
  assert.equal(Object.keys(st.notes()).length, 20, 'rien n\'a été supprimé à distance');
  await a.sync({ allowMass: true });
  assert.equal(Object.keys(st.notes()).length, 0);
});
test('garde-fou symétrique : suppressions distantes massives refusées localement', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st), b = createDevice('b', st);
  for (let i = 0; i < 20; i++) a.put(note('n' + i, 'c' + i));
  await a.sync(); await b.sync();
  st.external({}, Object.keys(st.notes()).map(Core.notePath));
  await assert.rejects(b.sync(), e => e.code === 'massdelete' && e.deleteLocal === 20);
  assert.equal(b.local.size, 20);
});
test('commit concurrent : nouvel essai automatique, rien de perdu', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st);
  a.put(note('n1', 'x'));
  st.state.beforeCommit = () => st.external({ 'notes/zz.md': Core.serialize(note('zz', 'écrit ailleurs')) });
  await a.sync();
  assert.deepEqual(bodies(st), { n1: 'x', zz: 'écrit ailleurs' });
  assert.equal(a.local.get('zz').body, 'écrit ailleurs');
});
test('échec réseau pendant le commit : rien n\'est appliqué, la reprise réussit', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st);
  a.put(note('n1', 'x'));
  st.state.failNext = Object.assign(new Error('net'), { code: 'net' });
  await assert.rejects(a.sync(), e => e.code === 'net');
  assert.deepEqual(a.state.base, {}); assert.equal(Object.keys(st.notes()).length, 0);
  await a.sync(); assert.equal(bodies(st).n1, 'x');
});
test('coupure juste après le commit : la reprise ne crée ni conflit ni doublon', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st);
  a.put(note('n1', 'x'));
  await a.sync({ crash: true });          // le commit a réussi, l'appareil n'a rien enregistré
  const r = await a.sync();
  assert.equal(r.conflicts.length, 0); assert.equal(a.local.size, 1);
});
test('fichier distant illisible : jamais touché, jamais supprimé', async () => {
  const st = createMemoryStorage({ 'notes/bad.md': 'pas une note', 'grimoire-notes.json': Core.MARKER }), a = createDevice('a', st);
  a.put(note('n1', 'x'));
  const r = await a.sync();
  assert.deepEqual(r.invalid, ['bad']); assert.equal(st.state.files.get('notes/bad.md'), 'pas une note');
});
test('racine : marqueur recréé s\'il manque, contenu étranger jamais écrasé', async () => {
  const st = createMemoryStorage(), a = createDevice('a', st);
  a.put(note('n1', 'x')); await a.sync();
  st.external({}, ['grimoire-notes.json']);
  await a.sync(); assert.equal(st.state.files.get('grimoire-notes.json'), Core.MARKER);
  st.external({ 'grimoire-notes.json': 'texte libre de l\'utilisateur' });
  const r = await a.sync(); assert.equal(r.rootForeign, true);
  assert.equal(st.state.files.get('grimoire-notes.json'), 'texte libre de l\'utilisateur');
});
test('racine en JSON ancien : synchro refusée tant que la migration n\'est pas faite', async () => {
  const st = createMemoryStorage({ 'grimoire-notes.json': JSON.stringify({ app: 'grimoire', v: 1, notes: [note('n1', 'x')], deleted: {} }) });
  const a = createDevice('a', st); a.put(note('n9', 'local'));
  await assert.rejects(a.sync(), e => e.code === 'legacy');
  assert.equal(Object.keys(st.notes()).length, 0, 'aucune note poussée dans notes/ avant la migration');
  st.external({ 'notes/n2.md': Core.serialize(note('n2', 'y')) });
  await assert.rejects(a.sync(), e => e.code === 'legacy-mixed');
});

/* ---------- propriété : aucun texte perdu, convergence, interruptions ---------- */
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

test('propriété : 3 appareils, opérations aléatoires, coupures — aucune modification perdue, convergence finale', async () => {
  let tokenSeq = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const R = rng(seed), st = createMemoryStorage(), devs = ['a', 'b', 'c'].map(n => createDevice(n + seed, st, { now: () => 1700000000000 + seed }));
    const pending = new Map(devs.map(d => [d, new Map()])); // d -> id -> texte non encore synchronisé
    let t = 100, nid = 0;
    const check = (d) => {
      const visible = new Set([...allBodies(Object.fromEntries(d.local), st.notes())]);
      for (const [id, text] of pending.get(d)) assert.ok(visible.has(text), `seed ${seed} : texte perdu (${id}) ${text}`);
      pending.get(d).clear();
    };
    for (let step = 0; step < 40; step++) {
      const d = devs[Math.floor(R() * 3)], op = R();
      const ids = [...d.local.keys()];
      if (op < .2 || !ids.length) { const id = 'n' + (++nid) + 's' + seed; d.put(note(id, 'tok' + (++tokenSeq), { updated: ++t })); pending.get(d).set(id, d.local.get(id).body); }
      else if (op < .5) { const id = ids[Math.floor(R() * ids.length)], body = 'tok' + (++tokenSeq); d.put({ ...d.local.get(id), body, updated: ++t }); pending.get(d).set(id, body); }
      else if (op < .6) { const id = ids[Math.floor(R() * ids.length)]; d.local.delete(id); pending.get(d).delete(id); }
      else if (op < .65) { const id = ids[Math.floor(R() * ids.length)]; d.put({ ...d.local.get(id), pinned: !d.local.get(id).pinned, updated: ++t }); }
      else {
        const crash = R() < .15;
        try { await d.sync({ crash, allowMass: true }); } catch (e) { if (e.code !== 'massdelete') throw e; }
        if (!crash) check(d);
      }
    }
    for (let i = 0; i < 3; i++) for (const d of devs) await d.sync({ allowMass: true });
    const remote = Object.fromEntries(Object.entries(st.notes()).map(([id, n]) => [id, Core.canon(n)]));
    for (const d of devs) {
      const mine = Object.fromEntries([...d.local].map(([id, n]) => [id, Core.canon(n)]));
      assert.deepEqual(mine, remote, `seed ${seed} : l'appareil ${d.name} n'a pas convergé`);
    }
  }
});
