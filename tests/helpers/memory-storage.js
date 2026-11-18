// Stockage en mémoire pour tester sync-core.js : même interface que le stockage GitHub.
'use strict';
const Core = require('../../src/sync-core.js');
const { gitHash } = require('../../src/github-store.js');

function createMemoryStorage(initial = {}) {
  const S = { files: new Map(Object.entries(initial)), seq: 0, head: 'h0', log: [], failNext: null, beforeCommit: null };
  const versions = new Map(); // chemin -> hash (cache)
  async function h(text) { return gitHash(text); }
  async function snapshot() {
    const notes = {}; let root = 'absent', rootText = '';
    for (const [p, t] of S.files) {
      const id = Core.idFromPath(p);
      if (id) notes[id] = await h(t);
      else if (p === Core.ROOT_FILE) { rootText = t; root = t.startsWith('GRIMOIRE-FORMAT-2') ? 'marker' : 'other'; }
    }
    return { head: S.head, notes, root, rootText };
  }
  return {
    state: S,
    hash: h,
    async list() { S.log.push('list'); return snapshot(); },
    async read(ids) { S.log.push('read'); const out = {}; for (const id of ids) { const t = S.files.get(Core.notePath(id)); if (t !== undefined) out[id] = t; } return out; },
    async commit({ head, writes = {}, deletes = [], extra = {}, message }) {
      S.log.push('commit');
      if (S.failNext) { const e = S.failNext; S.failNext = null; throw e; }
      if (S.beforeCommit) { const f = S.beforeCommit; S.beforeCommit = null; f(); }
      if (head !== S.head) throw { code: 'stale' };
      for (const [id, t] of Object.entries(writes)) S.files.set(Core.notePath(id), t);
      for (const id of deletes) S.files.delete(Core.notePath(id));
      for (const [p, t] of Object.entries(extra)) S.files.set(p, t);
      S.head = 'h' + (++S.seq);
      return { head: S.head };
    },
    /** Un autre appareil écrit directement (sans passer par la synchro). */
    external(writes = {}, deletes = []) {
      for (const [p, t] of Object.entries(writes)) S.files.set(p, t);
      for (const p of deletes) S.files.delete(p);
      S.head = 'h' + (++S.seq);
    },
    notes() { const out = {}; for (const [p, t] of S.files) { const id = Core.idFromPath(p); if (id) out[id] = Core.parse(t); } return out; }
  };
}
module.exports = { createMemoryStorage };
