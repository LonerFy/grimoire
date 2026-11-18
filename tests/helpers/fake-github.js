// Faux GitHub en mémoire : API Git Data + Contents, assez fidèle pour tester l'adaptateur et l'ancienne synchro 1.3.2.
'use strict';
const crypto = require('node:crypto');
const sha = (kind, buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(kind + ' ' + buf.length + '\0'), buf])).digest('hex');
const treeSha = flat => crypto.createHash('sha1').update(JSON.stringify([...flat].sort())).digest('hex');

function createFakeGitHub({ repo = 'o/r', token = 'faux-jeton', files = null } = {}) {
  const G = { blobs: new Map(), trees: new Map(), commits: new Map(), head: null, requests: [], onPatchRef: null, counter: 0, token };
  const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  function putBlob(text) { const b = Buffer.from(text, 'utf8'), s = sha('blob', b); G.blobs.set(s, b); return s; }
  function makeCommit(flat, parent, message) {
    const ts = treeSha(flat); G.trees.set(ts, new Map(flat));
    const c = crypto.createHash('sha1').update(ts + (parent || '') + message + (++G.counter)).digest('hex');
    G.commits.set(c, { tree: ts, parents: parent ? [parent] : [], message });
    return c;
  }
  const flatOf = c => new Map(G.trees.get(G.commits.get(c).tree));
  function setFiles(obj, message = 'seed') {
    const flat = new Map(G.head ? flatOf(G.head) : []);
    for (const [p, t] of Object.entries(obj)) { if (t === null) flat.delete(p); else flat.set(p, putBlob(t)); }
    G.head = makeCommit(flat, G.head, message);
  }
  if (files) setFiles(files);
  const text = s => G.blobs.get(s).toString('utf8');

  async function fetchImpl(url, init = {}) {
    const u = new URL(url), method = (init.method || 'GET').toUpperCase(), h = init.headers || {};
    const auth = h.Authorization || h.authorization;
    G.requests.push(method + ' ' + u.pathname.replace('/repos/' + repo, '') + u.search);
    if (auth !== 'Bearer ' + G.token) return json(401, { message: 'Bad credentials' });
    const p = u.pathname.replace('/repos/' + repo, ''), body = init.body ? JSON.parse(init.body) : null;
    if (p === '' && method === 'GET') return json(200, { default_branch: 'main' });
    if (p === '/git/ref/heads/main' && method === 'GET') {
      if (!G.head) return json(404, { message: 'Not Found' });
      const etag = '"' + G.head + '"';
      if ((h['If-None-Match'] || h['if-none-match']) === etag) return new Response(null, { status: 304, headers: { etag } });
      return json(200, { object: { sha: G.head } }, { etag });
    }
    let m;
    if ((m = p.match(/^\/git\/commits\/(\w+)$/)) && method === 'GET') { const c = G.commits.get(m[1]); return c ? json(200, { sha: m[1], tree: { sha: c.tree } }) : json(404, {}); }
    if ((m = p.match(/^\/git\/trees\/(\w+)$/)) && method === 'GET') {
      const t = G.trees.get(m[1]); if (!t) return json(404, {});
      return json(200, { sha: m[1], truncated: false, tree: [...t].map(([path, s]) => ({ path, mode: '100644', type: 'blob', sha: s })) });
    }
    if ((m = p.match(/^\/git\/blobs\/(\w+)$/)) && method === 'GET') { const b = G.blobs.get(m[1]); return b ? json(200, { sha: m[1], encoding: 'base64', content: b.toString('base64') }) : json(404, {}); }
    if (p === '/git/blobs' && method === 'POST') {
      if (!G.head) return json(409, { message: 'Git Repository is empty.' });
      return json(201, { sha: putBlob(Buffer.from(body.content, 'base64').toString('utf8')) });
    }
    if (p === '/git/trees' && method === 'POST') {
      const flat = new Map(G.trees.get(G.commits.get(G.head).tree).entries());
      // base_tree doit être l'arbre de la tête courante, sinon on reconstruit depuis base_tree comme le ferait GitHub
      const baseFlat = new Map(G.trees.get(body.base_tree));
      for (const e of body.tree) { if (e.sha === null) baseFlat.delete(e.path); else baseFlat.set(e.path, e.sha); }
      void flat; const ts = treeSha(baseFlat); G.trees.set(ts, baseFlat);
      return json(201, { sha: ts });
    }
    if (p === '/git/commits' && method === 'POST') {
      const c = crypto.createHash('sha1').update(body.tree + body.parents.join() + body.message + (++G.counter)).digest('hex');
      G.commits.set(c, { tree: body.tree, parents: body.parents, message: body.message });
      return json(201, { sha: c });
    }
    if (p === '/git/refs/heads/main' && method === 'PATCH') {
      if (G.onPatchRef) { const f = G.onPatchRef; G.onPatchRef = null; f(G); }
      const c = G.commits.get(body.sha);
      if (!c || (G.head && !body.force && c.parents[0] !== G.head)) return json(422, { message: 'Update is not a fast forward' });
      G.head = body.sha; return json(200, { object: { sha: G.head } });
    }
    if ((m = p.match(/^\/contents\/(.+)$/))) {
      const path = decodeURIComponent(m[1]), flat = G.head ? flatOf(G.head) : new Map();
      if (method === 'GET') {
        if (!flat.has(path)) return json(404, { message: 'Not Found' });
        const s = flat.get(path); return json(200, { sha: s, content: G.blobs.get(s).toString('base64'), encoding: 'base64', path });
      }
      if (method === 'PUT') {
        const cur = flat.get(path);
        if (cur && body.sha !== cur) return json(body.sha ? 409 : 422, { message: 'sha mismatch' });
        if (!cur && body.sha) return json(422, { message: 'sha given but file absent' });
        flat.set(path, putBlob(Buffer.from(body.content, 'base64').toString('utf8')));
        G.head = makeCommit(flat, G.head, body.message || 'put');
        return json(cur ? 200 : 201, { content: { sha: flat.get(path) } });
      }
    }
    return json(404, { message: 'route inconnue : ' + method + ' ' + p });
  }
  return {
    fetch: fetchImpl, G, setFiles,
    files() { const out = {}; if (G.head) for (const [p, s] of flatOf(G.head)) out[p] = text(s); return out; },
    requests: () => G.requests
  };
}
module.exports = { createFakeGitHub };
