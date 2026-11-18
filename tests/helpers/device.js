// Un « appareil » : notes locales + état de synchro, appliqués comme le fait l'appli.
'use strict';
const Core = require('../../src/sync-core.js');
let counter = 0;
function createDevice(name, storage, opts = {}) {
  const d = {
    name, local: new Map(), state: { base: {} }, busy: new Set(), lastResult: null,
    newId: () => 'c' + name + (++counter),
    put(n) { d.local.set(n.id, { id: n.id, title: n.title || '', body: n.body || '', pinned: !!n.pinned, created: n.created || 1, updated: n.updated || 1, ...n }); },
    async sync(o = {}) {
      const r = await Core.sync({ storage, local: d.local, state: d.state, busy: id => d.busy.has(id), newId: d.newId, now: opts.now || (() => 1700000000000), ...o });
      if (o.crash) return r; // coupure juste après le commit : rien n'est appliqué ici
      for (const [id, n] of r.toLocal) d.local.set(id, n);
      for (const id of r.removeLocal) d.local.delete(id);
      d.state = r.state; d.lastResult = r; return r;
    }
  };
  return d;
}
module.exports = { createDevice };
