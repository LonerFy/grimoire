'use strict';
// Le vrai serveur MCP (processus fils, protocole stdio) contre un faux GitHub servi en HTTP local.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), path = require('node:path');
const Core = require('../src/sync-core.js');
const { createFakeGitHub } = require('./helpers/fake-github.js');

const mcpDir = path.join(__dirname, '..', 'mcp');
let sdk; const load = async () => sdk || (sdk = {
  Client: (await import(path.join(mcpDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))).Client,
  Transport: (await import(path.join(mcpDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'))).StdioClientTransport
});
const note = (id, body, x = {}) => ({ id, title: 'T-' + id, body, pinned: false, created: 1, updated: 10, ...x });

async function boot(fake, token = 'faux-jeton') {
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await fake.fetch('http://x' + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { Client, Transport } = await load();
  const transport = new Transport({ command: process.execPath, args: [path.join(mcpDir, 'server.js')], stderr: 'pipe',
    env: { PATH: process.env.PATH, GRIMOIRE_REPO: 'o/r', GRIMOIRE_TOKEN: token, GRIMOIRE_API_BASE: 'http://127.0.0.1:' + srv.address().port } });
  const client = new Client({ name: 'test', version: '1' }); await client.connect(transport);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const t = r.content[0].text; return { err: !!r.isError, text: t, json: r.isError ? null : (() => { try { return JSON.parse(t); } catch { return t; } })() }; };
  return { call, close: async () => { await client.close(); srv.close(); } };
}
const seed = extra => ({ 'grimoire-notes.json': Core.MARKER, 'notes/n1.md': Core.serialize(note('n1', 'un')), 'notes/n2.md': Core.serialize(note('n2', 'deux')), ...extra });

test('MCP, disposition notes/ : lecture, version, écriture avec base_version, marqueur intact', async () => {
  const fake = createFakeGitHub({ files: seed() }), m = await boot(fake);
  try {
    const list = await m.call('list_notes', {}); assert.equal(list.json.total, 2);
    const r = await m.call('read_note', { note: 'n1' }); assert.match(r.json.version, /^[0-9a-f]{40}$/);
    const noBase = await m.call('update_note', { note: 'n1', body: 'sans version' }); assert.equal(noBase.err, true);
    assert.equal(Core.parse(fake.files()['notes/n1.md']).body, 'un');
    const commits = fake.G.commits.size;
    const ok = await m.call('update_note', { note: 'n1', base_version: r.json.version, body: 'modifié' }); assert.equal(ok.err, false, ok.text);
    assert.equal(Core.parse(fake.files()['notes/n1.md']).body, 'modifié');
    assert.equal(fake.G.commits.size, commits + 1);
    assert.equal(fake.files()['grimoire-notes.json'], Core.MARKER);
    assert.ok(fake.files()['notes/n2.md'], 'les autres notes ne sont pas touchées');
  } finally { await m.close(); }
});
test('MCP : base_version périmée refusée (update, delete, append), rien n\'est modifié', async () => {
  const fake = createFakeGitHub({ files: seed() }), m = await boot(fake);
  try {
    const v = (await m.call('read_note', { note: 'n1' })).json.version;
    fake.setFiles({ 'notes/n1.md': Core.serialize(note('n1', 'modifié par l\'appli', { updated: 99 })) }); // l'appli écrit entre-temps
    const before = JSON.stringify(fake.files());
    for (const [tool, args] of [['update_note', { note: 'n1', base_version: v, body: 'écrase' }], ['delete_note', { note: 'n1', base_version: v }], ['append_to_note', { note: 'n1', base_version: v, text: 'ajout' }]]) {
      const r = await m.call(tool, args); assert.equal(r.err, true, tool); assert.match(r.text, /a changé depuis ta lecture/);
    }
    assert.equal(JSON.stringify(fake.files()), before);
    const v2 = (await m.call('read_note', { note: 'n1' })).json.version;
    assert.equal((await m.call('append_to_note', { note: 'n1', text: 'ajout sans version' })).err, false); // append reste possible sans base_version
    assert.match(Core.parse(fake.files()['notes/n1.md']).body, /ajout sans version$/);
    assert.equal((await m.call('delete_note', { note: 'n2', base_version: (await m.call('read_note', { note: 'n2' })).json.version })).err, false);
    assert.ok(!fake.files()['notes/n2.md']); assert.equal(fake.files()['grimoire-notes.json'], Core.MARKER); void v2;
  } finally { await m.close(); }
});
test('MCP : create_note écrit notes/<id>.md ; dépôt vide → marqueur créé', async () => {
  const fake = createFakeGitHub(), m = await boot(fake);
  try {
    const r = await m.call('create_note', { title: 'Idée', body: 'texte [[Autre]]' }); assert.equal(r.err, false, r.text);
    const f = fake.files(); assert.equal(f['grimoire-notes.json'], Core.MARKER);
    const paths = Object.keys(f).filter(p => p.startsWith('notes/')); assert.equal(paths.length, 1);
    assert.equal(Core.parse(f[paths[0]]).title, 'Idée');
  } finally { await m.close(); }
});
test('MCP : écriture concurrente de l\'appli pendant la sienne → nouvel essai, rien de perdu', async () => {
  const fake = createFakeGitHub({ files: seed() }), m = await boot(fake);
  try {
    fake.G.onPatchRef = () => fake.setFiles({ 'notes/n9.md': Core.serialize(note('n9', 'écrit par l\'appli')) });
    const r = await m.call('create_note', { title: 'Nouvelle', body: 'x' }); assert.equal(r.err, false, r.text);
    const f = fake.files(); assert.ok(f['notes/n9.md']); assert.equal(Object.keys(f).filter(p => p.startsWith('notes/')).length, 4);
  } finally { await m.close(); }
});
test('MCP : dépôt encore à l\'ancien format → fonctionne à l\'ancienne, sans créer notes/', async () => {
  const legacy = JSON.stringify({ app: 'grimoire', v: 1, notes: [note('n1', 'un')], deleted: {} });
  const fake = createFakeGitHub({ files: { 'grimoire-notes.json': legacy } }), m = await boot(fake);
  try {
    const v = (await m.call('read_note', { note: 'n1' })).json.version;
    assert.equal((await m.call('update_note', { note: 'n1', base_version: v, body: 'neuf' })).err, false);
    const f = fake.files(); assert.equal(JSON.parse(f['grimoire-notes.json']).notes[0].body, 'neuf');
    assert.equal(Object.keys(f).filter(p => p.startsWith('notes/')).length, 0);
  } finally { await m.close(); }
});
test('MCP : jeton refusé → message clair, sans le jeton', async () => {
  const fake = createFakeGitHub({ files: seed(), token: 'bon-jeton' }), m = await boot(fake, 'mauvais-jeton-xyz');
  try { const r = await m.call('list_notes', {}); assert.equal(r.err, true); assert.match(r.text, /refuse le jeton/); assert.ok(!r.text.includes('mauvais-jeton-xyz')); }
  finally { await m.close(); }
});
