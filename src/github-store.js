/* =====================================================================
   Grimoire — stockage GitHub pour sync-core.js (API Git Data, un commit atomique par synchro).
   Rien d'écrit dans les journaux : ni jeton, ni contenu de note. Les erreurs ne portent qu'un code et un statut HTTP.
   ===================================================================== */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./sync-core.js') : root.GrimoireSync);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrimoireGitHub = api;
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';

  const enc = new TextEncoder(), dec = new TextDecoder();
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  /** SHA-1 en JS pur : repli si WebCrypto est absent (contexte non sécurisé dans certains webviews). */
  function sha1(bytes) {
    const l = bytes.length, n = ((l + 8) >> 6) + 1, w = new Int32Array(n * 16), rol = (x, c) => (x << c) | (x >>> (32 - c));
    for (let i = 0; i < l; i++) w[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    w[l >> 2] |= 0x80 << (24 - (l % 4) * 8); w[n * 16 - 1] = l * 8;
    let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0; const x = new Int32Array(80);
    for (let b = 0; b < n * 16; b += 16) {
      for (let t = 0; t < 80; t++) x[t] = t < 16 ? w[b + t] : rol(x[t - 3] ^ x[t - 8] ^ x[t - 14] ^ x[t - 16], 1);
      let a = h0, bb = h1, c = h2, d = h3, e = h4;
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? (bb & c) | (~bb & d) : t < 40 ? bb ^ c ^ d : t < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
        const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc | 0 : 0xca62c1d6 | 0;
        const tmp = (rol(a, 5) + f + e + k + x[t]) | 0; e = d; d = c; c = rol(bb, 30); bb = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
  }
  /** Empreinte « blob » de git : sha1("blob <octets>\0" + contenu). C'est la version GitHub du fichier. */
  async function gitHash(text) {
    const body = enc.encode(text), head = enc.encode('blob ' + body.length + '\0'), all = new Uint8Array(head.length + body.length);
    all.set(head); all.set(body, head.length);
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) return hex(await crypto.subtle.digest('SHA-1', all));
    return sha1(all);
  }
  const b64e = s => { const b = enc.encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };
  const b64d = s => dec.decode(Uint8Array.from(atob(String(s).replace(/\s/g, '')), c => c.charCodeAt(0)));
  const httpErr = (status, code) => Object.assign(new Error(code || 'http'), { code: code || 'http', status });

  function create({ repo, token, fetch: f, apiBase = 'https://api.github.com' }) {
    const doFetch = f || ((...a) => fetch(...a));
    const H = () => ({ Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    const base = apiBase + '/repos/' + repo;
    const markerHash = Core.MARKER ? gitHash(Core.MARKER) : null;
    const S = { branch: null, refEtag: null, head: null, listing: null, versions: {} };

    async function call(method, path, body, extra) {
      const r = await doFetch(base + path, {
        method, cache: 'no-store',
        headers: Object.assign({}, H(), body ? { 'Content-Type': 'application/json' } : {}, extra || {}),
        body: body ? JSON.stringify(body) : undefined
      });
      return r;
    }
    async function json(r) { try { return await r.json(); } catch (e) { throw httpErr(r.status, 'badresponse'); } }

    async function branch() {
      if (S.branch) return S.branch;
      const r = await call('GET', '');
      if (!r.ok) throw httpErr(r.status);
      S.branch = (await json(r)).default_branch || 'main';
      return S.branch;
    }
    /** Tête de la branche, null si le dépôt est vide. Requête conditionnelle : un 304 ne compte pas dans les quotas. */
    async function getHead() {
      const b = await branch();
      const r = await call('GET', '/git/ref/heads/' + encodeURIComponent(b), null, S.refEtag && S.head ? { 'If-None-Match': S.refEtag } : null);
      if (r.status === 304) return S.head;
      if (r.status === 404 || r.status === 409) { S.head = null; S.refEtag = null; return null; }
      if (!r.ok) throw httpErr(r.status);
      const j = await json(r);
      S.refEtag = r.headers && r.headers.get ? r.headers.get('etag') : null;
      return (S.head = j.object.sha);
    }
    async function readBlob(sha) {
      const r = await call('GET', '/git/blobs/' + sha);
      if (!r.ok) throw httpErr(r.status);
      return b64d((await json(r)).content || '');
    }

    async function list() {
      const head = await getHead();
      if (!head) return { head: null, notes: {}, root: 'absent', rootText: '' };
      if (S.listing && S.listing.head === head) return S.listing;
      const c = await call('GET', '/git/commits/' + head);
      if (!c.ok) throw httpErr(c.status);
      const treeSha = (await json(c)).tree.sha;
      const t = await call('GET', '/git/trees/' + treeSha + '?recursive=1');
      if (!t.ok) throw httpErr(t.status);
      const tj = await json(t);
      if (tj.truncated) throw httpErr(0, 'truncated');
      const notes = {}; let rootSha = null;
      for (const e of tj.tree || []) {
        if (e.type !== 'blob') continue;
        if (e.path === Core.ROOT_FILE) rootSha = e.sha;
        else { const id = Core.idFromPath(e.path); if (id) notes[id] = e.sha; }
      }
      let root = 'absent', rootText = '';
      if (rootSha) {
        if (rootSha === await markerHash) root = 'marker';
        else { rootText = await readBlob(rootSha); root = rootText.startsWith('GRIMOIRE-FORMAT-2') ? 'marker' : 'other'; }
      }
      S.versions = notes;
      return (S.listing = { head, tree: treeSha, notes, root, rootText });
    }

    async function read(ids) {
      const out = {}, queue = [...ids];
      const worker = async () => { for (let id; (id = queue.shift()) !== undefined;) { const sha = S.versions[id]; if (sha) out[id] = await readBlob(sha); } };
      await Promise.all([worker(), worker(), worker(), worker()]);
      return out;
    }

    async function commit({ head, writes = {}, deletes = [], extra = {}, message = 'sync' }) {
      const files = {}; // chemin -> texte | null
      for (const [id, text] of Object.entries(writes)) files[Core.notePath(id)] = text;
      for (const id of deletes) files[Core.notePath(id)] = null;
      for (const [p, text] of Object.entries(extra)) files[p] = text;
      const b = await branch();
      if (!head) { // dépôt vide : l'API Git Data refuse d'y écrire, on crée d'abord le fichier marqueur par l'API Contents
        const text = files[Core.ROOT_FILE] != null ? files[Core.ROOT_FILE] : Core.MARKER;
        const r = await call('PUT', '/contents/' + Core.ROOT_FILE, { message: 'Grimoire : fichier marqueur', content: b64e(text), branch: b });
        if (!r.ok) throw httpErr(r.status);
        delete files[Core.ROOT_FILE]; S.listing = null; S.refEtag = null; S.head = null;
        head = await getHead();
        if (!head) throw httpErr(0, 'badresponse');
        if (!Object.keys(files).length) return { head };
      }
      const cur = S.listing && S.listing.head === head ? S.listing : await list();
      if (cur.head !== head) throw { code: 'stale' };
      const entries = [];
      for (const [p, text] of Object.entries(files)) {
        if (text === null) { entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); continue; }
        const r = await call('POST', '/git/blobs', { content: b64e(text), encoding: 'base64' });
        if (!r.ok) throw httpErr(r.status);
        entries.push({ path: p, mode: '100644', type: 'blob', sha: (await json(r)).sha });
      }
      const tr = await call('POST', '/git/trees', { base_tree: cur.tree, tree: entries });
      if (!tr.ok) throw httpErr(tr.status);
      const cm = await call('POST', '/git/commits', { message, tree: (await json(tr)).sha, parents: [head] });
      if (!cm.ok) throw httpErr(cm.status);
      const sha = (await json(cm)).sha;
      const up = await call('PATCH', '/git/refs/heads/' + encodeURIComponent(b), { sha, force: false });
      if (up.status === 422 || up.status === 409) { S.listing = null; S.refEtag = null; throw { code: 'stale' }; }
      if (!up.ok) throw httpErr(up.status);
      S.listing = null; S.refEtag = null; S.head = sha;
      return { head: sha };
    }

    return { hash: gitHash, list, read, commit, readRoot: async () => { const l = await list(); return l.rootText; } };
  }

  return { create, gitHash, sha1, b64e, b64d };
});
