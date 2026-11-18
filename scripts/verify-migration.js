#!/usr/bin/env node
// Vérifie la migration de LonerFy/grimoire-notes-test (et SEULEMENT ce dépôt) contre une sauvegarde de grimoire-notes.json.
// Lecture seule : n'écrit rien, ni dans le dépôt ni dans la sauvegarde. Passe par `gh api` (aucun jeton lu ni affiché).
// Usage : node scripts/verify-migration.js [chemin/de/grimoire-notes.json]   (défaut : ~/sauvegarde-grimoire-notes/grimoire-notes.json)
// Code de sortie : 0 conforme (avertissements possibles), 1 échec de contrôle, 2 dépôt cible inattendu.
// La logique de comparaison (verify) est pure et testée dans tests/verify-migration.test.js.
'use strict';
const Core = require('../src/sync-core.js');

const REPO = 'LonerFy/grimoire-notes-test';
// Copie de conflit : ancien nom (heure locale, 1.4.0) ou nouveau (UTC, 1.4.1).
const CONFLICT = /\(conflit \d{4}-\d\d-\d\d \d\d:\d\d( UTC)?\)$/;

/** repo : { files: { chemin: texte } pour grimoire-notes.json, legacy/* et notes/*, other: [autres chemins] }.
    backupText : contenu de la sauvegarde grimoire-notes.json. Renvoie { checks: [{ level: 'ok'|'fail'|'warn', section, msg }], fails, warns }. */
function verify({ repo, backupText }) {
  const checks = [];
  const add = (level, section, msg) => checks.push({ level, section, msg });
  const files = repo.files || {}, paths = Object.keys(files);

  const backup = Core.readLegacy(backupText), raw = JSON.parse(backupText), expected = {};
  for (const n of raw.notes) { const ts = backup.deleted[n.id]; if (ts && ts >= (+n.updated || 0)) continue; expected[n.id] = n; }
  const expIds = Object.keys(expected);
  add('ok', 'Sauvegarde de référence', expIds.length + ' notes attendues dans le dépôt');

  // 3. racine
  const S3 = 'grimoire-notes.json (racine)';
  if (!(Core.ROOT_FILE in files)) add('fail', S3, 'absent : il ne doit jamais être supprimé');
  else {
    const root = files[Core.ROOT_FILE];
    let isJson = true; try { JSON.parse(root); } catch (e) { isJson = false; }
    add(isJson ? 'fail' : 'ok', S3, isJson ? 'c\'est du JSON valide : une ancienne version le prendrait pour un dépôt à l\'ancien format' : 'n\'est pas du JSON valide');
    add(root.startsWith('GRIMOIRE-FORMAT-2') ? 'ok' : 'fail', S3, root.startsWith('GRIMOIRE-FORMAT-2') ? 'commence par le texte marqueur' : 'ne commence pas par GRIMOIRE-FORMAT-2');
    if (root.startsWith('GRIMOIRE-FORMAT-2') && root !== Core.MARKER) add('warn', S3, 'texte différent du marqueur de l\'appli (pas bloquant)');
  }

  // 4. legacy
  const S4 = 'legacy/ (sauvegarde de l\'ancien fichier)', legacy = paths.filter(p => p.startsWith(Core.LEGACY_DIR));
  if (!legacy.length) add('fail', S4, 'dossier legacy/ absent ou vide');
  else {
    add('ok', S4, legacy.length + ' fichier(s) : ' + legacy.join(', '));
    add(legacy.some(p => files[p] === backupText) ? 'ok' : 'fail', S4, legacy.some(p => files[p] === backupText) ? 'une copie est identique octet pour octet à la sauvegarde' : 'aucun fichier de legacy/ n\'est identique à la sauvegarde');
  }

  // 5. notes/
  const S5 = 'notes/ : un fichier par note', notePaths = paths.filter(p => p.startsWith(Core.NOTES_DIR));
  if (!notePaths.length) add('fail', S5, 'dossier notes/ absent ou vide');
  const bad = notePaths.filter(p => !Core.idFromPath(p));
  add(bad.length ? 'fail' : 'ok', S5, bad.length ? 'fichiers qui ne sont pas notes/<id>.md : ' + bad.join(', ') : notePaths.length + ' fichiers, tous de la forme notes/<id>.md');
  const found = {};
  for (const p of notePaths) {
    const id = Core.idFromPath(p); if (!id) continue;
    const n = Core.parse(files[p]);
    if (!n) { add('fail', S5, p + ' : illisible'); continue; }
    if (n.id !== id) add('fail', S5, p + ' : l\'id interne (' + n.id + ') ne correspond pas au nom du fichier');
    found[id] = { n, text: files[p] };
  }
  const missing = expIds.filter(id => !found[id]);
  add(missing.length ? 'fail' : 'ok', S5, missing.length ? 'notes de la sauvegarde absentes du dépôt : ' + missing.join(', ') : 'les ' + expIds.length + ' notes de la sauvegarde sont toutes présentes');
  // Notes en plus : attendues quand l'appli avait des notes locales absentes de la sauvegarde (elles ont été envoyées au dépôt à la première synchro).
  const extra = Object.keys(found).filter(id => !expected[id]);
  const copies = extra.filter(id => CONFLICT.test(found[id].n.title)), locals = extra.filter(id => !CONFLICT.test(found[id].n.title));
  const label = id => id + ' « ' + found[id].n.title + ' »';
  if (locals.length) add('warn', S5, locals.length + ' note(s) locale(s) en plus de la sauvegarde — ATTENDU si l\'appli en avait déjà : ' + locals.map(label).join(' ; '));
  if (copies.length) add('warn', S5, copies.length + ' copie(s) « conflit » — à relire : ' + copies.map(label).join(' ; '));
  if (!extra.length) add('ok', S5, 'aucune note en plus de la sauvegarde');
  if (repo.other && repo.other.length) add('ok', S5, 'autres fichiers laissés tels quels : ' + repo.other.join(', '));

  // 6. contenu
  const S6 = 'Contenu de chaque note comparé à la sauvegarde'; let identical = 0;
  for (const id of expIds) {
    if (!found[id]) continue;
    const e = expected[id], g = found[id].n, diff = [];
    if (g.title !== String(e.title || '').replace(/[\n\r]/g, ' ')) diff.push('titre');
    if (g.body !== String(e.body || '').replace(/\r\n/g, '\n')) diff.push('corps');
    if (g.pinned !== !!e.pinned) diff.push('épinglée');
    if (g.created !== Math.floor(+e.created || +e.updated || 0)) diff.push('création');
    if (g.updated !== Math.floor(+e.updated || +e.created || 0)) diff.push('modification');
    if (diff.length) add('fail', S6, id + ' : diffère (' + diff.join(', ') + ')');
    else if (found[id].text !== Core.serialize({ id, title: String(e.title || ''), body: String(e.body || ''), pinned: !!e.pinned, created: +e.created || +e.updated || 0, updated: +e.updated || +e.created || 0 })) add('warn', S6, id + ' : même contenu mais fichier mis en forme autrement');
    else identical++;
  }
  add(identical === expIds.length ? 'ok' : 'warn', S6, identical === expIds.length ? 'les ' + identical + ' notes sont identiques, champ par champ et octet pour octet' : identical + '/' + expIds.length + ' identiques octet pour octet');

  return { checks, fails: checks.filter(c => c.level === 'fail').length, warns: checks.filter(c => c.level === 'warn').length };
}

function print(result) {
  const mark = { ok: '✓', fail: '✗', warn: '!' };
  let last = '';
  for (const c of result.checks) {
    if (c.section !== last) { console.log('\n' + c.section); last = c.section; }
    console.log('  ' + mark[c.level] + ' ' + c.msg);
  }
  console.log('\nRésultat : ' + (result.fails ? result.fails + ' échec(s)' : 'tout est conforme') + (result.warns ? ', ' + result.warns + ' avertissement(s)' : '') + '.');
}

function main() {
  const { execFileSync } = require('node:child_process'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const api = p => JSON.parse(execFileSync('gh', ['api', 'repos/' + REPO + p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const blob = s => Buffer.from(api('/git/blobs/' + s).content, 'base64').toString('utf8');
  console.log('Vérification de la migration — ' + REPO);
  const info = api('');
  if (info.full_name !== REPO) { console.log('✗ dépôt inattendu : arrêt.'); process.exit(2); }
  if (!info.private) { console.log('✗ le dépôt n\'est pas privé : arrêt.'); process.exit(2); }
  console.log('✓ dépôt exactement ' + REPO + ', privé');
  const tree = api('/git/trees/HEAD?recursive=1');
  if (tree.truncated) { console.log('✗ arbre tronqué : arrêt.'); process.exit(2); }
  const files = {}, other = [];
  for (const e of tree.tree.filter(e => e.type === 'blob')) {
    if (e.path === Core.ROOT_FILE || e.path.startsWith(Core.LEGACY_DIR) || e.path.startsWith(Core.NOTES_DIR)) files[e.path] = blob(e.sha); else other.push(e.path);
  }
  const backupPath = process.argv[2] || path.join(os.homedir(), 'sauvegarde-grimoire-notes', 'grimoire-notes.json');
  const result = verify({ repo: { files, other }, backupText: fs.readFileSync(backupPath, 'utf8') });
  print(result);
  process.exit(result.fails ? 1 : 0);
}

if (require.main === module) main();
module.exports = { verify, CONFLICT, REPO };
