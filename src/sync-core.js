/* =====================================================================
   Grimoire — cœur de synchro, une note = un fichier notes/<id>.md
   Aucune E/S ici : tout passe par une « interface de stockage » (voir plus bas).
   Utilisable dans l'appli (window.GrimoireSync) et dans Node (require).
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrimoireSync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- format d'une note (identique à src-tauri/src/vault.rs) ---------- */
  const ROOT_FILE = 'grimoire-notes.json';
  const NOTES_DIR = 'notes/';
  const LEGACY_DIR = 'legacy/';
  /** Texte qui remplace l'ancien JSON à la racine. Il commence par une lettre et contient des espaces : jamais du JSON valide. */
  const MARKER = 'GRIMOIRE-FORMAT-2 : les notes sont maintenant dans le dossier notes/, une note par fichier (notes/<id>.md). ' +
    'Ce fichier est un marqueur, il ne doit être ni supprimé ni déplacé ni remplacé par du JSON : les anciennes versions de Grimoire (1.3.2 et avant) le recréeraient et feraient diverger tes notes. ' +
    'L\'ancien contenu est conservé dans le dossier legacy/.\n';

  const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 120 && !id.startsWith('.') &&
    /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('--');
  const notePath = id => NOTES_DIR + id + '.md';
  const idFromPath = p => {
    if (!p.startsWith(NOTES_DIR) || !p.endsWith('.md')) return null;
    const id = p.slice(NOTES_DIR.length, -3);
    return validId(id) ? id : null;
  };

  function serialize(n) {
    const title = String(n.title || '').replace(/[\n\r]/g, ' ');
    return '---\nid: ' + n.id + '\ntitle: ' + title + '\npinned: ' + (n.pinned ? 'true' : 'false') +
      '\ncreated: ' + Math.floor(+n.created || 0) + '\nupdated: ' + Math.floor(+n.updated || 0) + '\n---\n' + String(n.body || '');
  }
  function parse(text) {
    text = String(text).replace(/\r\n/g, '\n');
    if (!text.startsWith('---\n')) return null;
    const rest = text.slice(4);
    let head, body;
    const i = rest.indexOf('\n---\n');
    if (i >= 0) { head = rest.slice(0, i); body = rest.slice(i + 5); }
    else if (rest.endsWith('\n---')) { head = rest.slice(0, -4); body = ''; }
    else return null;
    const n = { id: '', title: '', body, pinned: false, created: 0, updated: 0 };
    for (const line of head.split('\n')) {
      const c = line.indexOf(':'); if (c < 0) continue;
      let v = line.slice(c + 1); if (v.startsWith(' ')) v = v.slice(1);
      switch (line.slice(0, c).trim()) {
        case 'id': n.id = v.trim(); break;
        case 'title': n.title = v; break;
        case 'pinned': n.pinned = v.trim() === 'true'; break;
        case 'created': n.created = parseFloat(v.trim()) || 0; break;
        case 'updated': n.updated = parseFloat(v.trim()) || 0; break;
      }
    }
    return validId(n.id) ? n : null;
  }
  const canon = n => serialize({ id: n.id, title: n.title, body: n.body, pinned: !!n.pinned, created: n.created, updated: n.updated });
  const sameText = (a, b) => a.title === b.title && a.body === b.body;
  const pad = x => String(x).padStart(2, '0');
  /** Date de la copie de conflit, toujours en UTC (comparable à l'heure des commits, identique quel que soit l'appareil). */
  const stamp = t => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC'; };

  /* ---------- interface de stockage ----------
     storage = {
       hash(text)            -> Promise<string>   empreinte d'un fichier (sha1 « blob » git)
       list()                -> Promise<{ head, notes: { [id]: version }, root: null | 'marker' | 'other' | 'absent', rootText }>
       read(ids)             -> Promise<{ [id]: texte }>
       commit({ head, writes: { [id]: texte }, deletes: [id], extra: { [chemin]: texte }, message }) -> Promise<{ head }>
                                `extra` : fichiers hors notes/ (marqueur racine, sauvegarde legacy/). Tout est un seul commit atomique.
                                lève { code: 'stale' } si head n'est plus à jour
     }
     Les « versions » sont opaques : seule leur égalité compte. */

  const MAX_TRIES = 4;
  const isLegacy = t => { try { const d = JSON.parse(t); return !!d && typeof d === 'object' && Array.isArray(d.notes); } catch (e) { return false; } };

  /** Une passe de synchro. `local` : Map id -> note. `state` : { base: { id: { r, l } } }.
      `busy(id)` : note en cours d'édition (on ne l'écrase jamais). Renvoie ce que l'appelant doit appliquer en local. */
  async function sync(opts) {
    const { storage, local, state, busy = () => false, newId, now = Date.now, allowMass = false, message = 'sync' } = opts;
    let lastErr;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      try { return await pass({ storage, local, state, busy, newId, now, allowMass, message }); }
      catch (e) { if (e && e.code === 'stale') { lastErr = e; continue; } throw e; }
    }
    throw lastErr || { code: 'conflict' };
  }

  async function pass({ storage, local, state, busy, newId, now, allowMass, message }) {
    const remote = await storage.list();
    if (remote.root === 'other' && isLegacy(remote.rootText)) {
      const e = new Error(Object.keys(remote.notes).length ? 'legacy-mixed' : 'legacy'); e.code = e.message; throw e;
    }
    const base = state.base || {};
    const lv = new Map(), ltext = new Map();
    for (const n of local.values()) { const t = canon(n); ltext.set(n.id, t); lv.set(n.id, await storage.hash(t)); }

    const ids = new Set([...local.keys(), ...Object.keys(remote.notes), ...Object.keys(base)]);
    const needRead = [];
    for (const id of ids) {
      const R = remote.notes[id], B = base[id], L = local.has(id);
      if (R !== undefined && L && B && R === B.r && lv.get(id) === B.l) continue; // rien n'a bougé
      if (R !== undefined && (!B || R !== B.r)) needRead.push(id);                  // il faut voir le texte distant
    }
    const rtext = needRead.length ? await storage.read(needRead) : {};

    const writes = {}, deletes = [], toLocal = new Map(), removeLocal = [], conflicts = [], skipped = [], invalid = [];
    const newBase = {};   // id -> { r, l } | null (null = oublier)
    const postWrite = []; // [id, texte] : base à fixer après le commit (version distante = hash du texte écrit)
    let massDel = 0, massDelLocal = 0;

    for (const id of ids) {
      const R = remote.notes[id], B = base[id], L = local.has(id), Lv = lv.get(id);
      const remoteHas = R !== undefined;
      const rChanged = !B || R !== B.r, lChanged = !B || Lv !== B.l;

      if (L && remoteHas) {
        if (!rChanged && !lChanged) continue;
        if (!rChanged) { writes[id] = ltext.get(id); postWrite.push([id, ltext.get(id)]); continue; }
        const rn = rtext[id] === undefined ? null : parse(rtext[id]);
        if (!rn || rn.id !== id) { invalid.push(id); continue; }
        const rl = await storage.hash(canon(rn));
        if (rl === Lv) { newBase[id] = { r: R, l: Lv }; continue; } // même contenu des deux côtés
        if (!lChanged) {
          if (busy(id)) { skipped.push(id); continue; }
          toLocal.set(id, rn); newBase[id] = { r: R, l: rl }; continue;
        }
        const ln = local.get(id);
        if (sameText(ln, rn)) { // seuls l'épinglage ou les dates diffèrent : le plus récent gagne, pas de copie
          if ((+rn.updated || 0) >= (+ln.updated || 0)) {
            if (busy(id)) { skipped.push(id); continue; }
            toLocal.set(id, rn); newBase[id] = { r: R, l: rl };
          } else { writes[id] = ltext.get(id); postWrite.push([id, ltext.get(id)]); }
          continue;
        }
        // Conflit : la version distante garde l'id, la version locale entière devient une copie. Aucune fusion de lignes.
        if (busy(id)) { skipped.push(id); continue; }
        const t = now(), cid = newId(), copy = { id: cid, title: (ln.title || 'Sans titre') + ' (conflit ' + stamp(t) + ')', body: ln.body, pinned: false, created: t, updated: t };
        toLocal.set(id, rn); newBase[id] = { r: R, l: rl };
        toLocal.set(cid, copy);
        const ct = canon(copy); writes[cid] = ct; postWrite.push([cid, ct]);
        conflicts.push({ id, copyId: cid, title: ln.title || 'Sans titre' });
        continue;
      }

      if (L && !remoteHas) {
        if (B && !lChanged) { // supprimée à distance, intacte ici : on la supprime ici
          if (busy(id)) { skipped.push(id); continue; }
          removeLocal.push(id); newBase[id] = null; massDelLocal++; continue;
        }
        writes[id] = ltext.get(id); postWrite.push([id, ltext.get(id)]); continue; // nouvelle ici, ou modifiée après suppression distante : on la garde
      }

      if (!L && remoteHas) {
        if (B && !rChanged) { deletes.push(id); newBase[id] = null; massDel++; continue; } // supprimée ici, intacte là-bas
        const rn = rtext[id] === undefined ? null : parse(rtext[id]);
        if (!rn || rn.id !== id) { invalid.push(id); continue; }
        toLocal.set(id, rn); newBase[id] = { r: R, l: await storage.hash(canon(rn)) }; continue; // nouvelle là-bas, ou modifiée après suppression ici
      }

      if (B) newBase[id] = null; // disparue des deux côtés
    }

    const n0 = Object.keys(base).length, limit = Math.max(5, Math.ceil(n0 * 0.3));
    if (!allowMass && (massDel > limit || massDelLocal > limit)) {
      const e = new Error('massdelete'); e.code = 'massdelete'; e.deleteRemote = massDel; e.deleteLocal = massDelLocal; throw e;
    }

    let head = remote.head;
    const needMarker = remote.root === 'absent';
    if (Object.keys(writes).length || deletes.length || needMarker) {
      const extra = needMarker ? { [ROOT_FILE]: MARKER } : {};
      const res = await storage.commit({ head, writes, deletes, extra, message });
      head = res.head;
    }
    for (const [id, text] of postWrite) { const h = await storage.hash(text); newBase[id] = { r: h, l: h }; }

    const nb = {};
    for (const [id, b] of Object.entries(base)) nb[id] = b;
    for (const [id, b] of Object.entries(newBase)) { if (b === null) delete nb[id]; else nb[id] = b; }
    return {
      toLocal, removeLocal, conflicts, skipped, invalid, head,
      state: { base: nb },
      pushed: Object.keys(writes).length + deletes.length,
      pulled: toLocal.size - conflicts.length + removeLocal.length,
      rootForeign: remote.root === 'other'
    };
  }

  /* ---------- migration de l'ancien grimoire-notes.json ---------- */
  /** Lit l'ancien JSON. Renvoie { notes, deleted } ou lève une erreur si le fichier n'est pas un export Grimoire. */
  function readLegacy(text) {
    let d; try { d = JSON.parse(text); } catch (e) { throw Object.assign(new Error('legacy-illisible'), { code: 'legacy-illisible' }); }
    if (!d || typeof d !== 'object' || !Array.isArray(d.notes)) throw Object.assign(new Error('legacy-illisible'), { code: 'legacy-illisible' });
    return { notes: d.notes.filter(n => n && validId(n.id)), deleted: d.deleted && typeof d.deleted === 'object' ? d.deleted : {} };
  }
  /** Plan de migration : fichiers à écrire, sans rien perdre. Les notes dont l'id est invalide sont signalées, jamais écartées en silence. */
  function planMigration(legacyText, when) {
    const leg = readLegacy(legacyText), raw = JSON.parse(legacyText), files = {}, skipped = [];
    for (const n of raw.notes || []) {
      if (!n || !validId(n.id)) { skipped.push(n && n.id != null ? String(n.id) : '?'); continue; }
      const ts = leg.deleted[n.id];
      if (ts && ts >= (+n.updated || 0)) continue; // supprimée avant sa dernière modification : l'ancienne synchro l'écartait aussi
      files[n.id] = serialize({ id: n.id, title: String(n.title || ''), body: String(n.body || ''), pinned: !!n.pinned, created: +n.created || +n.updated || 0, updated: +n.updated || +n.created || 0 });
    }
    const d = new Date(when || Date.now());
    const legacyName = LEGACY_DIR + 'grimoire-notes.v1.' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + '-' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '.json';
    return { files, skipped, legacyName, legacyText, marker: MARKER, count: Object.keys(files).length };
  }

  /** Migre via le stockage : un commit atomique (notes + sauvegarde + marqueur), puis relecture et comparaison note par note. */
  async function migrate({ storage, legacyText, when }) {
    const plan = planMigration(legacyText, when);
    if (plan.skipped.length) throw Object.assign(new Error('legacy-ids'), { code: 'legacy-ids', ids: plan.skipped });
    const remote = await storage.list();
    if (Object.keys(remote.notes).length) throw Object.assign(new Error('deja-migre'), { code: 'deja-migre' });
    await storage.commit({ head: remote.head, writes: plan.files, deletes: [], extra: { [ROOT_FILE]: plan.marker, [plan.legacyName]: plan.legacyText }, message: 'migration vers notes/<id>.md' });
    // Vérification : tout ce qui devait être écrit est bien là, au caractère près.
    const after = await storage.list(), back = await storage.read(Object.keys(plan.files)), bad = [];
    for (const [id, text] of Object.entries(plan.files)) {
      if (after.notes[id] === undefined || back[id] !== text) bad.push(id);
    }
    if (after.root !== 'marker') bad.push(ROOT_FILE);
    if (bad.length) throw Object.assign(new Error('verif'), { code: 'verif', ids: bad });
    return { count: plan.count, legacyName: plan.legacyName, head: after.head };
  }

  return { ROOT_FILE, NOTES_DIR, LEGACY_DIR, MARKER, validId, notePath, idFromPath, serialize, parse, canon, sync, isLegacy, readLegacy, planMigration, migrate };
});
