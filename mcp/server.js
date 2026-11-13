#!/usr/bin/env node
// Serveur MCP de Grimoire.
// Lit et écrit le même fichier que l'appli : grimoire-notes.json dans ton dépôt GitHub privé
// (GRIMOIRE_REPO + GRIMOIRE_TOKEN), ou un fichier local exporté (GRIMOIRE_FILE).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';

const REPO = process.env.GRIMOIRE_REPO, TOKEN = process.env.GRIMOIRE_TOKEN, FILE = process.env.GRIMOIRE_FILE;
const PATH = process.env.GRIMOIRE_PATH || 'grimoire-notes.json';
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.GRIMOIRE_READ_ONLY || '');
if (!FILE && !(REPO && TOKEN)) {
  console.error('Grimoire MCP : définis GRIMOIRE_REPO (proprietaire/nom) et GRIMOIRE_TOKEN, ou GRIMOIRE_FILE (chemin d\'un export .json).');
  process.exit(1);
}

/* ---------- stockage ---------- */
const empty = () => ({ app: 'grimoire', v: 1, notes: [], deleted: {} });
const clean = d => ({ app: 'grimoire', v: 1, notes: Array.isArray(d?.notes) ? d.notes.filter(n => n && n.id) : [], deleted: d?.deleted && typeof d.deleted === 'object' ? d.deleted : {} });

const gh = {
  url: () => `https://api.github.com/repos/${REPO}/contents/${PATH}`,
  headers: () => ({ Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'grimoire-mcp' }),
  async load() {
    const r = await fetch(gh.url(), { headers: gh.headers() });
    if (r.status === 404) return { data: empty(), sha: null };
    if (r.status === 401 || r.status === 403) throw new Error('GitHub refuse le jeton : vérifie qu\'il n\'a pas expiré et qu\'il a le droit Contents en lecture et écriture sur ce dépôt.');
    if (!r.ok) throw new Error(`GitHub a répondu ${r.status}.`);
    const j = await r.json();
    let data;
    try { data = JSON.parse(Buffer.from(j.content || '', 'base64').toString('utf8')); }
    catch { throw new Error(`${PATH} est illisible dans le dépôt. Rien n'a été modifié.`); }
    return { data: clean(data), sha: j.sha };
  },
  async save(data, sha, message) {
    const body = { message, content: Buffer.from(JSON.stringify(data)).toString('base64') };
    if (sha) body.sha = sha;
    const r = await fetch(gh.url(), { method: 'PUT', headers: { ...gh.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) return false; // quelqu'un a écrit entre-temps
    if (!r.ok) throw new Error(`GitHub a refusé l'écriture (${r.status}).`);
    return true;
  }
};
const local = {
  async load() {
    try { return { data: clean(JSON.parse(await readFile(FILE, 'utf8'))), sha: null }; }
    catch (e) { if (e.code === 'ENOENT') return { data: empty(), sha: null }; throw new Error(`Impossible de lire ${FILE} : ${e.message}`); }
  },
  async save(data) { await writeFile(FILE, JSON.stringify(data, null, 2)); return true; }
};
const store = FILE ? local : gh;

/** Lit, applique `fn` (qui modifie data et renvoie un résultat), écrit. Réessaie si un autre appareil a écrit entre-temps. */
async function mutate(message, fn) {
  if (READ_ONLY) throw new Error('Ce serveur est en lecture seule (GRIMOIRE_READ_ONLY).');
  for (let i = 0; i < 4; i++) {
    const { data, sha } = await store.load();
    const result = fn(data);
    if (await store.save(data, sha, message)) return result;
  }
  throw new Error('Conflit d\'écriture répété avec un autre appareil. Réessaie dans un instant.');
}

/* ---------- mêmes règles que l'appli ---------- */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const mask = b => b.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, m => m.replace(/[^\n]/g, ' '));
const newId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function parse(body) {
  const m = mask(body || ''), links = [], tags = new Set(); let r;
  const rl = /\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]*)?\]\]/g;
  while ((r = rl.exec(m))) { const t = r[1].trim(); if (t) links.push(t); }
  const rt = /(^|[\s(\[{>«"'’])#([\p{L}\d][\p{L}\d_\/-]*)/gu;
  while ((r = rt.exec(m))) if (/\p{L}/u.test(r[2])) tags.add(r[2].toLowerCase());
  return { links, tags: [...tags] };
}
function index(notes) {
  const title = new Map(), out = new Map(), back = new Map(), ghosts = new Map(), tags = new Map();
  const byAge = [...notes].sort((a, b) => (a.created || 0) - (b.created || 0));
  for (const n of byAge) { const k = norm(n.title); if (k && !title.has(k)) title.set(k, n.id); }
  for (const n of byAge) {
    const p = parse(n.body), o = new Set();
    for (const t of p.links) {
      const k = norm(t), id = title.get(k);
      if (id) { if (id !== n.id) { o.add(id); if (!back.has(id)) back.set(id, new Set()); back.get(id).add(n.id); } }
      else if (k) { if (!ghosts.has(k)) ghosts.set(k, { label: t, from: new Set() }); ghosts.get(k).from.add(n.id); }
    }
    out.set(n.id, o);
    for (const t of p.tags) { if (!tags.has(t)) tags.set(t, new Set()); tags.get(t).add(n.id); }
  }
  return { title, out, back, ghosts, tags };
}
/** Trouve une note par id exact, puis par titre (sans casse ni accents). */
function find(notes, ref) {
  const byId = notes.find(n => n.id === ref); if (byId) return byId;
  const k = norm(ref), hits = notes.filter(n => norm(n.title) === k);
  if (hits.length > 1) throw new Error(`Plusieurs notes s'appellent « ${ref} ». Utilise leur id : ${hits.map(n => n.id).join(', ')}.`);
  if (!hits.length) throw new Error(`Aucune note « ${ref} ». Utilise search_notes ou list_notes pour trouver le bon titre ou id.`);
  return hits[0];
}
const iso = ts => new Date(ts || 0).toISOString();
const brief = n => ({ id: n.id, title: n.title || 'Sans titre', pinned: !!n.pinned, updated: iso(n.updated), tags: parse(n.body).tags });
const ok = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = e => ({ isError: true, content: [{ type: 'text', text: e.message || String(e) }] });
const safe = fn => async args => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const titleOf = (notes, id) => notes.find(n => n.id === id)?.title || 'Sans titre';

/* ---------- outils ---------- */
const server = new McpServer({ name: 'grimoire', version: '1.0.0' });
const RO = { readOnlyHint: true, openWorldHint: false }, RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

server.registerTool('list_notes', {
  title: 'Lister les notes',
  description: 'Liste les notes du Grimoire (id, titre, étiquettes, date de modification), des plus récentes aux plus anciennes. Filtre possible par étiquette.',
  inputSchema: { tag: z.string().optional().describe('Étiquette sans le #, par exemple "projet"'), limit: z.number().int().min(1).max(500).optional().describe('Nombre maximum de notes (défaut 100)') },
  annotations: RO
}, safe(async ({ tag, limit = 100 }) => {
  const { data } = await store.load(); let arr = data.notes;
  if (tag) { const t = tag.replace(/^#/, '').toLowerCase(); arr = arr.filter(n => parse(n.body).tags.includes(t)); }
  arr = [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
  return { total: arr.length, notes: arr.slice(0, limit).map(brief) };
}));

server.registerTool('search_notes', {
  title: 'Chercher dans les notes',
  description: 'Cherche un texte dans les titres et le contenu des notes, sans tenir compte de la casse ni des accents. Renvoie les notes trouvées avec un extrait autour de la première occurrence.',
  inputSchema: { query: z.string().min(1).describe('Texte à chercher'), limit: z.number().int().min(1).max(100).optional().describe('Nombre maximum de résultats (défaut 20)') },
  annotations: RO
}, safe(async ({ query, limit = 20 }) => {
  const { data } = await store.load(), q = norm(query), words = q.split(' ').filter(Boolean), hits = [];
  for (const n of data.notes) {
    const t = norm(n.title), b = norm(n.body);
    if (!words.every(w => t.includes(w) || b.includes(w))) continue;
    const line = (n.body || '').split('\n').find(l => words.some(w => norm(l).includes(w))) || (n.body || '').split('\n').find(l => l.trim()) || '';
    hits.push({ ...brief(n), inTitle: words.every(w => t.includes(w)), excerpt: line.trim().slice(0, 240) });
  }
  hits.sort((a, b) => (b.inTitle ? 1 : 0) - (a.inTitle ? 1 : 0) || b.updated.localeCompare(a.updated));
  return { total: hits.length, results: hits.slice(0, limit) };
}));

server.registerTool('read_note', {
  title: 'Lire une note',
  description: 'Renvoie le texte complet (Markdown) d\'une note, avec ses liens sortants, les notes qui la citent et ses étiquettes.',
  inputSchema: { note: z.string().min(1).describe('Titre ou id de la note') },
  annotations: RO
}, safe(async ({ note }) => {
  const { data } = await store.load(), n = find(data.notes, note), I = index(data.notes);
  const unresolved = [...new Set(parse(n.body).links.filter(t => !I.title.has(norm(t))))];
  return {
    ...brief(n), created: iso(n.created), body: n.body || '',
    linksTo: [...(I.out.get(n.id) || [])].map(id => ({ id, title: titleOf(data.notes, id) })),
    linkedFrom: [...(I.back.get(n.id) || [])].map(id => ({ id, title: titleOf(data.notes, id) })),
    linksToMissingNotes: unresolved
  };
}));

server.registerTool('create_note', {
  title: 'Créer une note',
  description: 'Crée une note. Le corps est en Markdown ; [[Titre]] crée un lien vers une autre note et #mot une étiquette. Refuse si une note porte déjà ce titre.',
  inputSchema: { title: z.string().min(1).max(200).describe('Titre de la note'), body: z.string().optional().describe('Contenu en Markdown'), pinned: z.boolean().optional().describe('Épingler la note en haut de la liste') },
  annotations: RW
}, safe(async ({ title, body = '', pinned = false }) => {
  const t = title.replace(/[\[\]|\n]/g, '').trim();
  if (!t) throw new Error('Le titre est vide après nettoyage.');
  return mutate(`mcp: créer « ${t} »`, data => {
    if (data.notes.some(n => norm(n.title) === norm(t))) throw new Error(`Une note « ${t} » existe déjà. Utilise update_note ou append_to_note.`);
    const now = Date.now(), n = { id: newId(), title: t, body, pinned, created: now, updated: now };
    data.notes.push(n); return { created: brief(n) };
  });
}));

server.registerTool('update_note', {
  title: 'Modifier une note',
  description: 'Remplace le titre, le corps ou l\'épinglage d\'une note. Le corps fourni remplace entièrement l\'ancien : lis la note avant, ou utilise append_to_note pour seulement ajouter. Renommer met à jour les [[liens]] des autres notes.',
  inputSchema: { note: z.string().min(1).describe('Titre ou id de la note'), title: z.string().min(1).max(200).optional().describe('Nouveau titre'), body: z.string().optional().describe('Nouveau contenu complet en Markdown'), pinned: z.boolean().optional() },
  annotations: { ...RW, destructiveHint: true }
}, safe(async ({ note, title, body, pinned }) => mutate(`mcp: modifier « ${note} »`, data => {
  const n = find(data.notes, note), now = Date.now(); let relinked = 0;
  if (title !== undefined) {
    const t = title.replace(/[\[\]|\n]/g, '').trim(), old = norm(n.title);
    if (!t) throw new Error('Le titre est vide après nettoyage.');
    if (data.notes.some(o => o.id !== n.id && norm(o.title) === norm(t))) throw new Error(`Une autre note s'appelle déjà « ${t} ».`);
    if (old && old !== norm(t) && !data.notes.some(o => o.id !== n.id && norm(o.title) === old)) {
      for (const o of data.notes) {
        if (o.id === n.id || !(o.body || '').includes('[[')) continue;
        const m = mask(o.body), re = /\[\[([^\[\]|\n]+)((?:\|[^\[\]\n]*)?)\]\]/g; let r, out = '', last = 0, hit = false;
        while ((r = re.exec(m))) {
          if (norm(r[1]) !== old) continue;
          out += o.body.slice(last, r.index) + '[[' + t + o.body.slice(r.index + 2 + r[1].length, r.index + r[0].length);
          last = r.index + r[0].length; hit = true;
        }
        if (hit) { o.body = out + o.body.slice(last); o.updated = now; relinked++; }
      }
    }
    n.title = t;
  }
  if (body !== undefined) n.body = body;
  if (pinned !== undefined) n.pinned = pinned;
  n.updated = now;
  return { updated: brief(n), linksRewrittenInOtherNotes: relinked };
})));

server.registerTool('append_to_note', {
  title: 'Ajouter à une note',
  description: 'Ajoute du texte à la fin d\'une note sans toucher au reste. Avec create_if_missing, crée la note si elle n\'existe pas (pratique pour un journal ou une boîte de réception).',
  inputSchema: { note: z.string().min(1).describe('Titre ou id de la note'), text: z.string().min(1).describe('Texte Markdown à ajouter'), create_if_missing: z.boolean().optional().describe('Créer la note si aucun titre ne correspond') },
  annotations: RW
}, safe(async ({ note, text, create_if_missing = false }) => mutate(`mcp: ajouter à « ${note} »`, data => {
  const now = Date.now(); let n;
  try { n = find(data.notes, note); }
  catch (e) {
    if (!create_if_missing || /Plusieurs notes/.test(e.message)) throw e;
    n = { id: newId(), title: note.replace(/[\[\]|\n]/g, '').trim(), body: '', pinned: false, created: now, updated: now };
    data.notes.push(n);
  }
  n.body = n.body ? n.body.replace(/\s+$/, '') + '\n\n' + text : text; n.updated = now;
  return { updated: brief(n), length: n.body.length };
})));

server.registerTool('delete_note', {
  title: 'Supprimer une note',
  description: 'Supprime définitivement une note sur tous les appareils. Les liens des autres notes vers elle deviennent des liens « à écrire ».',
  inputSchema: { note: z.string().min(1).describe('Titre ou id de la note') },
  annotations: { ...RW, destructiveHint: true }
}, safe(async ({ note }) => mutate(`mcp: supprimer « ${note} »`, data => {
  const n = find(data.notes, note);
  data.notes = data.notes.filter(o => o.id !== n.id); data.deleted[n.id] = Date.now();
  return { deleted: { id: n.id, title: n.title } };
})));

server.registerTool('list_tags', {
  title: 'Lister les étiquettes',
  description: 'Liste toutes les étiquettes (#mot) avec le nombre de notes qui les portent.',
  inputSchema: {}, annotations: RO
}, safe(async () => {
  const { data } = await store.load(), I = index(data.notes);
  return [...I.tags].map(([tag, s]) => ({ tag, notes: s.size })).sort((a, b) => b.notes - a.notes || a.tag.localeCompare(b.tag));
}));

server.registerTool('graph_overview', {
  title: 'Vue d\'ensemble du graphe',
  description: 'Résume le graphe des notes : notes les plus reliées, notes isolées (aucun lien), et notes citées mais pas encore écrites. Utile pour repérer quoi relier ou quoi écrire ensuite.',
  inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Taille maximale de chaque liste (défaut 15)') },
  annotations: RO
}, safe(async ({ limit = 15 }) => {
  const { data } = await store.load(), I = index(data.notes); let links = 0;
  const deg = data.notes.map(n => { const o = (I.out.get(n.id) || new Set()).size, b = (I.back.get(n.id) || new Set()).size; links += o; return { id: n.id, title: n.title || 'Sans titre', linksTo: o, linkedFrom: b }; });
  return {
    notes: data.notes.length, links, tags: I.tags.size,
    mostConnected: deg.filter(d => d.linksTo + d.linkedFrom).sort((a, b) => b.linksTo + b.linkedFrom - a.linksTo - a.linkedFrom).slice(0, limit),
    isolated: deg.filter(d => !d.linksTo && !d.linkedFrom).slice(0, limit).map(d => ({ id: d.id, title: d.title })),
    missingNotes: [...I.ghosts.values()].sort((a, b) => b.from.size - a.from.size).slice(0, limit).map(g => ({ title: g.label, citedBy: [...g.from].map(id => titleOf(data.notes, id)) }))
  };
}));

await server.connect(new StdioServerTransport());
console.error(`Grimoire MCP prêt (${FILE ? 'fichier ' + FILE : 'dépôt ' + REPO}${READ_ONLY ? ', lecture seule' : ''}).`);
