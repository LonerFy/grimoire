(() => {
'use strict';

/* =====================================================================
   Grimoire — notes liées, graphe, synchronisation entre appareils
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const newId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.now = (...a) => { clearTimeout(t); fn(...a); }; return d; };
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
};
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const isPhone = () => window.matchMedia('(max-width: 860px)').matches;
const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 50) return "à l'instant";
  if (s < 3600) return 'il y a ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'il y a ' + Math.round(s / 3600) + ' h';
  if (s < 172800) return 'hier';
  const d = new Date(ts), o = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('fr-FR', o);
}

/* ---------- state ---------- */
const S = {
  notes: new Map(), active: null, view: 'notes', mode: 'read', q: '', tag: null,
  loaded: false, backend: null,
  sync: { fromCache: false, error: null, slow: false },
  gopt: { tags: false, ghosts: true, orphans: true }
};
let I = { title: new Map(), out: new Map(), back: new Map(), ghosts: new Map(), tags: new Map() };
let downloads = null;

const app = $('#app'), listEl = $('#list'), tagsEl = $('#tags'), qEl = $('#q');
const titleEl = $('#title'), bodyEl = $('#body'), readEl = $('#read'), metaEl = $('#meta');
const pageEl = $('#page'), noteViewEl = $('#noteView'), suggestEl = $('#suggest');

/* ---------- parsing ---------- */
const tagRe = () => /(^|[\s(\[{>«"'’])#([\p{L}\d][\p{L}\d_\/-]*)/gu;
const mask = b => b.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, m => m.replace(/[^\n]/g, ' '));

function parsed(n) {
  if (n._p && n._pb === n.body) return n._p;
  const m = mask(n.body || ''), links = [], tags = new Set();
  let r; const rl = /\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]*)?\]\]/g;
  while ((r = rl.exec(m))) { const t = r[1].trim(); if (t) links.push(t); }
  const rt = tagRe();
  while ((r = rt.exec(m))) if (/\p{L}/u.test(r[2])) tags.add(r[2].toLowerCase());
  n._pb = n.body;
  n._nb = norm(n.body);
  return (n._p = { links, tags, words: ((n.body || '').match(/\S+/g) || []).length });
}

function excerpt(n, max = 120) {
  const line = (n.body || '').split('\n').map(l => l.trim()).find(l => l && !/^(```|---|#[^\s#])/.test(l) || /^#\s/.test(l)) || '';
  return line.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]/g, (m, a, b) => b || a)
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/^#+\s+/, '').replace(/[*_`>]/g, '').slice(0, max);
}

function reindex() {
  const title = new Map(), out = new Map(), back = new Map(), ghosts = new Map(), tags = new Map();
  const byAge = [...S.notes.values()].sort((a, b) => a.created - b.created);
  for (const n of byAge) { const k = norm(n.title); if (k && !title.has(k)) title.set(k, n.id); }
  for (const n of byAge) {
    const p = parsed(n), o = new Set();
    for (const t of p.links) {
      const k = norm(t), id = title.get(k);
      if (id) { if (id !== n.id) { o.add(id); if (!back.has(id)) back.set(id, new Set()); back.get(id).add(n.id); } }
      else if (k) { if (!ghosts.has(k)) ghosts.set(k, { label: t, from: new Set() }); ghosts.get(k).from.add(n.id); }
    }
    out.set(n.id, o);
    for (const t of p.tags) { if (!tags.has(t)) tags.set(t, new Set()); tags.get(t).add(n.id); }
  }
  I = { title, out, back, ghosts, tags };
}

/* ---------- markdown ---------- */
const WL = /\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]*))?\]\]/g;
const renderMd = (() => {
  if (window.marked && window.DOMPurify) {
    try {
      window.marked.use({
        gfm: true, breaks: true,
        extensions: [{
          name: 'wikilink', level: 'inline',
          start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
          tokenizer(src) {
            const m = /^\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]*))?\]\]/.exec(src);
            if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), label: (m[2] || m[1]).trim() };
          },
          renderer(t) { return '<a class="wl" data-wl="' + esc(t.target) + '">' + esc(t.label) + '</a>'; }
        }]
      });
      return src => window.DOMPurify.sanitize(window.marked.parse(src), { ADD_ATTR: ['data-wl'] });
    } catch (e) { /* repli ci-dessous */ }
  }
  return src => esc(src)
    .replace(WL, (m, a, b) => '<a class="wl" data-wl="' + a.trim() + '">' + (b || a).trim() + '</a>')
    .split(/\n{2,}/).map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
})();

function decorate(root) {
  root.querySelectorAll('a').forEach(a => {
    if (a.classList.contains('wl')) {
      const id = I.title.get(norm(a.dataset.wl));
      a.classList.toggle('ghost', !id); a.tabIndex = 0; a.setAttribute('role', 'link'); a.removeAttribute('href');
      if (!id) a.title = 'Note à écrire. Clique pour la créer.';
      return;
    }
    const h = a.getAttribute('href') || '';
    if (/^https?:/i.test(h)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    else if (!/^mailto:/i.test(h)) a.removeAttribute('href');
  });
  root.querySelectorAll('table').forEach(t => { const w = document.createElement('div'); w.className = 'tablewrap'; t.replaceWith(w); w.append(t); });
  root.querySelectorAll('input[type="checkbox"]').forEach((c, i) => {
    c.disabled = false; c.dataset.i = i; c.id = 'task-' + i;
    const li = c.closest('li'); if (li) { li.classList.add('task'); li.classList.toggle('done', c.checked); }
  });
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), todo = [];
  while (w.nextNode()) { const t = w.currentNode; if (t.nodeValue.includes('#') && !t.parentElement.closest('code,pre,a')) todo.push(t); }
  for (const t of todo) {
    const v = t.nodeValue, re = tagRe(); let m, last = 0, frag = null;
    while ((m = re.exec(v))) {
      if (!/\p{L}/u.test(m[2])) continue;
      frag = frag || document.createDocumentFragment();
      const at = m.index + m[1].length;
      frag.append(v.slice(last, at));
      const s = document.createElement('span');
      s.className = 'tagref'; s.dataset.tag = m[2].toLowerCase(); s.textContent = '#' + m[2]; s.tabIndex = 0; s.setAttribute('role', 'button');
      frag.append(s); last = re.lastIndex;
    }
    if (frag) { frag.append(v.slice(last)); t.replaceWith(frag); }
  }
}

/* =====================================================================
   Force-directed graph on canvas
   ===================================================================== */
class Web {
  constructor(cv, o) {
    this.cv = cv; this.ctx = cv.getContext('2d'); this.o = o || {};
    this.nodes = []; this.edges = []; this.map = new Map(); this.sig = '';
    this.k = 1; this.tx = 0; this.ty = 0; this.w = 0; this.h = 0; this.dpr = 1;
    this.alpha = 0; this.raf = 0; this.hover = null; this.sel = null;
    this.userMoved = false; this.hot = false; this.ptrs = new Map(); this.drag = null; this.pinch = null;
    this.bind();
    if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(cv);
    else window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { this.w = 0; return; }
    const d = Math.min(window.devicePixelRatio || 1, 2), was = this.w;
    this.w = r.width; this.h = r.height; this.dpr = d;
    this.cv.width = Math.round(r.width * d); this.cv.height = Math.round(r.height * d);
    if (!this.userMoved || !was) this.fit(true);
    this.draw();
    if (this.alpha > 0.004) this.kick();
  }

  setData(nodes, edges) {
    const old = this.map, map = new Map(); let fresh = 0;
    for (const n of nodes) {
      const p = old.get(n.id);
      if (p) { n.x = p.x; n.y = p.y; n.vx = p.vx; n.vy = p.vy; } else { n.vx = n.vy = 0; n.isNew = true; fresh++; }
      n.fx = null; n.deg = 0; map.set(n.id, n);
    }
    const E = [], seen = new Set();
    for (const e of edges) {
      const a = map.get(e[0]), b = map.get(e[1]); if (!a || !b || a === b) continue;
      const key = a.id < b.id ? a.id + '\u0001' + b.id : b.id + '\u0001' + a.id; if (seen.has(key)) continue;
      seen.add(key); E.push({ a, b }); a.deg++; b.deg++;
    }
    let i = 0;
    for (const n of nodes) {
      if (!n.isNew) continue;
      let anchor = null;
      for (const e of E) { if (e.a === n && !e.b.isNew) { anchor = e.b; break; } if (e.b === n && !e.a.isNew) { anchor = e.a; break; } }
      if (anchor) { const t = Math.random() * 6.283; n.x = anchor.x + Math.cos(t) * 34; n.y = anchor.y + Math.sin(t) * 34; }
      else { const r = 16 * Math.sqrt(0.5 + i), t = i * 2.39996; n.x = Math.cos(t) * r; n.y = Math.sin(t) * r; i++; }
    }
    for (const n of nodes) delete n.isNew;
    const sig = nodes.length + '|' + [...seen].sort().join(',');
    const cold = !old.size || fresh > nodes.length / 2;
    this.nodes = nodes; this.edges = E; this.map = map;
    this.sel = this.sel ? map.get(this.sel.id) || null : null; this.hover = null;
    if (cold) {
      this.alpha = 1; this.userMoved = false;
      const steps = reduceMotion ? 320 : clamp(Math.ceil(5e6 / Math.max(1, nodes.length * nodes.length)), 12, 200);
      for (let s = 0; s < steps; s++) this.step();
      if (reduceMotion) this.alpha = 0;
      this.fit(true);
    } else if (sig !== this.sig) {
      this.alpha = Math.max(this.alpha, 0.5);
      if (reduceMotion) { for (let s = 0; s < 200; s++) this.step(); this.alpha = 0; }
    }
    this.sig = sig;
    this.kick();
  }

  step() {
    const N = this.nodes, a = this.alpha, mini = !!this.o.mini;
    const L = mini ? 70 : 92, charge = mini ? 190 : 230;
    for (let i = 0; i < N.length; i++) {
      const p = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const q = N[j];
        let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
        if (d2 > 250000) continue;
        if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
        const f = charge * a / d2;
        p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f;
      }
      p.vx -= p.x * 0.05 * a; p.vy -= p.y * 0.05 * a;
    }
    for (const e of this.edges) {
      const A = e.a, B = e.b;
      let dx = B.x + B.vx - A.x - A.vx, dy = B.y + B.vy - A.y - A.vy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const l = (d - L) / d * a * (0.9 / Math.min(A.deg, B.deg));
      dx *= l; dy *= l;
      const bias = A.deg / (A.deg + B.deg);
      B.vx -= dx * bias; B.vy -= dy * bias; A.vx += dx * (1 - bias); A.vy += dy * (1 - bias);
    }
    for (const n of N) {
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6; n.x += n.vx; n.y += n.vy;
    }
    this.alpha += ((this.hot ? 0.3 : 0) - a) * 0.028;
  }

  kick() {
    if (this.raf) return;
    const run = () => {
      this.raf = 0;
      if (!this.w) return;
      if (this.alpha > 0.004) {
        this.step();
        if (!this.userMoved && !this.drag) this.fit(true);
        this.draw();
        this.raf = requestAnimationFrame(run);
      } else this.draw();
    };
    this.raf = requestAnimationFrame(run);
  }

  fit(quiet) {
    if (!this.nodes.length || !this.w) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const n of this.nodes) { if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x; if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y; }
    const padX = this.o.mini ? 46 : 90, padT = this.o.mini ? 22 : 70, padB = this.o.mini ? 34 : 80;
    const bw = Math.max(x1 - x0, 80), bh = Math.max(y1 - y0, 80);
    this.k = clamp(Math.min((this.w - padX * 2) / bw, (this.h - padT - padB) / bh), 0.12, this.o.mini ? 1.25 : 2.1);
    this.tx = -(x0 + x1) / 2 * this.k; this.ty = -(y0 + y1) / 2 * this.k + (padT - padB) / 2;
    if (!quiet) { this.userMoved = false; this.draw(); }
  }

  zoomAt(x, y, f) {
    const nk = clamp(this.k * f, 0.12, 4), wx = (x - this.w / 2 - this.tx) / this.k, wy = (y - this.h / 2 - this.ty) / this.k;
    this.tx = x - this.w / 2 - wx * nk; this.ty = y - this.h / 2 - wy * nk; this.k = nk; this.userMoved = true; this.draw();
  }

  radius(n) {
    const base = n.kind === 'note' ? 3.2 + Math.sqrt(n.deg) * 1.7 : n.kind === 'tag' ? 4.8 : 4.6;
    return base * clamp(Math.sqrt(this.k), 0.7, 1.35);
  }

  hit(x, y, pad) {
    const k = this.k, ox = this.w / 2 + this.tx, oy = this.h / 2 + this.ty; let best = null, bd = Infinity;
    for (const n of this.nodes) {
      const dx = ox + n.x * k - x, dy = oy + n.y * k - y, r = this.radius(n) + pad, d = dx * dx + dy * dy;
      if (d <= r * r && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  draw() {
    if (!this.w) return;
    const c = this.ctx, d = this.dpr, k = this.k, ox = this.w / 2 + this.tx, oy = this.h / 2 + this.ty;
    c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, this.w, this.h);
    const focus = this.hover || this.sel, activeId = this.o.activeId ? this.o.activeId() : null;
    let near = null;
    if (focus) { near = new Set([focus]); for (const e of this.edges) { if (e.a === focus) near.add(e.b); else if (e.b === focus) near.add(e.a); } }

    c.lineWidth = 1;
    for (const e of this.edges) {
      const hot = focus && (e.a === focus || e.b === focus);
      const soft = e.a.kind !== 'note' || e.b.kind !== 'note';
      c.strokeStyle = hot ? 'rgba(240,86,106,.9)' : focus ? 'rgba(233,229,220,.05)' : soft ? 'rgba(233,229,220,.09)' : 'rgba(233,229,220,.2)';
      c.beginPath(); c.moveTo(ox + e.a.x * k, oy + e.a.y * k); c.lineTo(ox + e.b.x * k, oy + e.b.y * k); c.stroke();
    }

    for (const n of this.nodes) {
      const x = ox + n.x * k, y = oy + n.y * k, r = this.radius(n);
      const lit = n === focus || n.id === activeId;
      c.globalAlpha = focus && !near.has(n) ? 0.2 : 1;
      c.beginPath();
      if (n.kind === 'tag') { c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); }
      else c.arc(x, y, r, 0, 6.2832);
      if (n.kind === 'note') {
        if (lit) { c.shadowColor = 'rgba(214,26,58,.95)'; c.shadowBlur = 20; c.fillStyle = '#d61a3a'; }
        else c.fillStyle = n.deg ? '#e9e5dc' : '#8a867f';
        c.fill(); c.shadowBlur = 0;
        if (lit) { c.strokeStyle = 'rgba(240,86,106,.55)'; c.beginPath(); c.arc(x, y, r + 4.5, 0, 6.2832); c.stroke(); }
      } else {
        c.fillStyle = '#08080a'; c.fill();
        if (n.kind === 'ghost') c.setLineDash([2, 2.5]);
        c.strokeStyle = n === focus ? '#f0566a' : '#9d9990'; c.lineWidth = 1.2; c.stroke(); c.setLineDash([]); c.lineWidth = 1;
      }
    }

    const base = clamp((k - 0.45) / 0.4, 0, 1);
    c.textAlign = 'center'; c.textBaseline = 'top';
    for (const n of this.nodes) {
      const strong = n === focus || n.id === activeId || (near && near.has(n));
      let al = strong ? 1 : focus ? 0 : base * (n.kind === 'note' ? 0.82 : 0.55);
      if (!focus && !strong && n.deg >= 4) al = Math.max(al, 0.7);
      if (al < 0.04) continue;
      const big = n === focus || n.id === activeId;
      c.globalAlpha = al;
      c.font = (n.kind === 'tag' ? '500 11.5px "IBM Plex Mono", monospace' : (n.kind === 'ghost' ? 'italic 400 ' : 'italic 600 ') + (big ? 17 : 15) + 'px "Cormorant Garamond", Georgia, serif');
      c.fillStyle = n.kind === 'note' ? '#e9e5dc' : '#9d9990';
      const lab = n.label.length > 30 ? n.label.slice(0, 29) + '…' : n.label;
      c.fillText(lab, ox + n.x * k, oy + n.y * k + this.radius(n) + (big ? 8 : 5));
    }
    c.globalAlpha = 1;
  }

  pt(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  bind() {
    const cv = this.cv, dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
    cv.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      try { cv.setPointerCapture(e.pointerId); } catch (x) { /* ignoré */ }
      const p = this.pt(e); this.ptrs.set(e.pointerId, p);
      if (this.ptrs.size === 2) {
        const [a, b] = [...this.ptrs.values()];
        if (this.drag && this.drag.n) this.drag.n.fx = null;
        this.drag = null; this.hot = false;
        this.pinch = { d: dist(a, b), k: this.k, wx: ((a.x + b.x) / 2 - this.w / 2 - this.tx) / this.k, wy: ((a.y + b.y) / 2 - this.h / 2 - this.ty) / this.k };
        return;
      }
      this.drag = { n: this.hit(p.x, p.y, e.pointerType === 'mouse' ? 6 : 16), sx: p.x, sy: p.y, tx: this.tx, ty: this.ty, moved: false, id: e.pointerId };
    });
    cv.addEventListener('pointermove', e => {
      const p = this.pt(e);
      if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, p);
      if (this.pinch && this.ptrs.size >= 2) {
        const [a, b] = [...this.ptrs.values()], nk = clamp(this.pinch.k * dist(a, b) / this.pinch.d, 0.12, 4);
        this.k = nk; this.tx = (a.x + b.x) / 2 - this.w / 2 - this.pinch.wx * nk; this.ty = (a.y + b.y) / 2 - this.h / 2 - this.pinch.wy * nk;
        this.userMoved = true; this.draw(); return;
      }
      const g = this.drag;
      if (g && g.id === e.pointerId) {
        const dx = p.x - g.sx, dy = p.y - g.sy;
        if (!g.moved && dx * dx + dy * dy > 30) g.moved = true;
        if (!g.moved) return;
        if (g.n) {
          g.n.fx = (p.x - this.w / 2 - this.tx) / this.k; g.n.fy = (p.y - this.h / 2 - this.ty) / this.k;
          g.n.x = g.n.fx; g.n.y = g.n.fy; this.hot = true; this.userMoved = true;
          if (reduceMotion) this.draw(); else { this.alpha = Math.max(this.alpha, 0.25); this.kick(); }
        } else { this.tx = g.tx + dx; this.ty = g.ty + dy; this.userMoved = true; this.draw(); }
        return;
      }
      if (e.pointerType === 'mouse') {
        const n = this.hit(p.x, p.y, 6);
        if (n !== this.hover) { this.hover = n; cv.style.cursor = n ? 'pointer' : 'grab'; this.draw(); }
      }
    });
    const up = e => {
      this.ptrs.delete(e.pointerId);
      if (this.ptrs.size < 2) this.pinch = null;
      const g = this.drag;
      if (g && g.id === e.pointerId) {
        this.drag = null; this.hot = false;
        if (g.n) g.n.fx = null;
        if (!g.moved && e.type === 'pointerup') this.tap(g.n);
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.draw(); } });
    cv.addEventListener('wheel', e => { e.preventDefault(); const p = this.pt(e); this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
  }

  tap(n) {
    if (this.o.mini) { if (n && this.o.onOpen) this.o.onOpen(n); return; }
    if (n && this.sel === n) { if (this.o.onOpen) this.o.onOpen(n); return; }
    this.sel = n; if (this.o.onSelect) this.o.onSelect(n); this.draw();
  }
}

/* =====================================================================
   Storage: per-account cloud vault, or this browser when unavailable
   ===================================================================== */
const dirty = new Set(), saving = new Set(), again = new Set(), removing = new Set();
const timers = new Map(), lastLocal = new Map(), fails = new Map();
const toDoc = n => ({ title: n.title || '', body: n.body || '', pinned: !!n.pinned, created: n.created || Date.now(), updated: n.updated || Date.now() });
const fromDoc = (id, d) => ({ id, title: String(d.title || ''), body: String(d.body || ''), pinned: !!d.pinned, created: +d.created || Date.now(), updated: +d.updated || +d.created || Date.now() });

function touch(id) {
  dirty.add(id); clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => flush(id), 900));
  paintSync();
}

async function flush(id) {
  clearTimeout(timers.get(id));
  if (!S.backend || !dirty.has(id)) return;
  if (saving.has(id)) { again.add(id); return; }
  const n = S.notes.get(id);
  if (!n) { dirty.delete(id); paintSync(); return; }
  dirty.delete(id); saving.add(id); paintSync();
  try {
    await S.backend.put(n);
    lastLocal.set(id, Date.now()); fails.delete(id);
    if (S.sync.error && S.sync.error !== 'revoked') S.sync.error = null;
  } catch (e) { dirty.add(id); writeFailed(e, id); }
  saving.delete(id);
  if (again.delete(id)) flush(id);
  paintSync();
}

function flushAll() { for (const id of [...dirty]) flush(id); }

let toldError = '';
function writeFailed(e, id) {
  const code = (e && e.code) || 'unavailable', tries = (fails.get(id) || 0) + 1;
  fails.set(id, tries);
  if ((code === 'unavailable' || code === 'resource_exhausted') && tries <= 6) {
    if (id) timers.set(id, setTimeout(() => flush(id), 2500 * tries + Math.random() * 1500));
    if (tries >= 2) S.sync.error = 'unavailable';
  } else {
    S.sync.error = code;
    if (toldError !== code) {
      toldError = code;
      toast(code === 'quota_exceeded' ? "Le grimoire est plein : supprime des notes pour pouvoir en enregistrer d'autres."
        : code === 'invalid_argument' ? "Écriture refusée. Il faut au moins le rôle Contributeur sur cette page pour y tenir son carnet."
        : code === 'revoked' ? "L'accès à cette page a changé. Les modifications ne sont plus enregistrées."
        : "L'enregistrement échoue. Tes dernières modifications ne sont pas encore sauvegardées.", { ms: 9000 });
    }
  }
  paintSync();
}

let lastDocs = null, recheckTimer = 0;
function mergeRemote(docs) {
  const changed = new Set(), seen = new Set(), now = Date.now();
  let held = false; lastDocs = docs;
  for (const d of docs) {
    const data = d.data(); if (!data) continue;
    seen.add(d.id);
    if (removing.has(d.id) || dirty.has(d.id) || saving.has(d.id)) continue;
    const cur = S.notes.get(d.id), n = fromDoc(d.id, data);
    if (cur) {
      if (cur.title === n.title && cur.body === n.body && cur.pinned === n.pinned && cur.updated === n.updated) continue;
      if (cur.updated > n.updated && now - (lastLocal.get(d.id) || 0) < 6000) { held = true; continue; }
    }
    S.notes.set(d.id, n); changed.add(d.id);
  }
  for (const id of [...S.notes.keys()]) {
    if (seen.has(id) || dirty.has(id) || saving.has(id)) continue;
    if (now - (lastLocal.get(id) || 0) < 6000) { held = true; continue; }
    S.notes.delete(id); changed.add(id);
  }
  // Une écriture locale toute récente masque l'état distant : on le relit une fois le délai passé.
  clearTimeout(recheckTimer);
  if (held) recheckTimer = setTimeout(() => { if (lastDocs) { const c = mergeRemote(lastDocs); if (c.size) afterRemote(c); } }, 6200);
  return changed;
}

function startCloud(db, uid) {
  let vault, col;
  try { vault = db.doc('data/users/' + uid + '/vault'); col = vault.collection('notes'); }
  catch (e) { return startLocal(); }
  S.backend = { kind: 'cloud', put: n => col.doc(n.id).set(toDoc(n)), del: id => col.doc(id).delete() };
  let seedTried = false;
  const slow = setTimeout(() => {
    S.sync.slow = true;
    if (!S.loaded) { S.loaded = true; afterLoad(); }
    paintSync();
  }, 10000);
  col.onSnapshot(snap => {
    const md = snap.metadata || {};
    if (!md.fromCache) { clearTimeout(slow); S.sync.slow = false; }
    S.sync.fromCache = !!md.fromCache;
    if (md.fromCache && snap.empty && !S.loaded) { paintSync(); return; }
    const first = !S.loaded, changed = mergeRemote(snap.docs);
    S.loaded = true;
    if (first) afterLoad(); else if (changed.size) afterRemote(changed);
    if (!md.fromCache && snap.empty && !S.notes.size && !seedTried) { seedTried = true; seedCloud(vault); }
    paintSync();
  }, err => {
    clearTimeout(slow);
    S.sync.error = (err && err.code) || 'unavailable';
    if (!S.loaded) { S.loaded = true; afterLoad(); }
    paintSync();
  });
}

async function seedCloud(vault) {
  try {
    const v = await vault.get();
    if (v.exists) return; // carnet déjà ouvert un jour, puis vidé : on ne remet pas les exemples
    await vault.set({ seeded: true, created: Date.now() });
    const seeds = seedNotes();
    for (const n of seeds) { S.notes.set(n.id, n); lastLocal.set(n.id, Date.now() + 4000); }
    S.active = S.active || seeds[0].id;
    paintAll();
    for (const n of seeds) { await S.backend.put(n); lastLocal.set(n.id, Date.now()); }
  } catch (e) { writeFailed(e, null); }
  paintSync();
}

/* ---------- local vault + GitHub sync ---------- */
const GH = { cfg: LS.get('grimoire.gh'), tomb: LS.get('grimoire.tomb') || {}, busy: false, queued: false, err: null, timer: 0, last: 0 };
const ghOn = () => !!(GH.cfg && GH.cfg.repo && GH.cfg.token);
const b64e = s => { const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };
const b64d = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
let persistVault = () => {};

/* Coffre sur disque (appli installée) : un fichier .md par note dans le dossier Grimoire. */
const TAURI = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke ? window.__TAURI__.core : null;
const Disk = { on: false, path: '', seen: new Map(), chain: Promise.resolve(), failed: false };
const diskSig = n => n.updated + '|' + (n.pinned ? 1 : 0) + '|' + n.title + '|' + n.body.length;
function diskFlush() {
  const todo = [];
  for (const n of S.notes.values()) { const g = diskSig(n); if (Disk.seen.get(n.id) !== g) { Disk.seen.set(n.id, g); todo.push(['vault_write', { note: Object.assign({ id: n.id }, toDoc(n)) }]); } }
  for (const id of [...Disk.seen.keys()]) if (!S.notes.has(id)) { Disk.seen.delete(id); todo.push(['vault_delete', { id }]); }
  for (const [cmd, args] of todo) Disk.chain = Disk.chain.then(() => TAURI.invoke(cmd, args)).catch(e => {
    Disk.seen.delete(args.id || args.note.id);
    if (!Disk.failed) { Disk.failed = true; toast("Écriture impossible dans le dossier Grimoire : " + String(e && e.message || e), { ms: 9000 }); }
  });
  return Disk.chain;
}
async function diskOpen() {
  Disk.path = await TAURI.invoke('vault_path');
  const list = await TAURI.invoke('vault_list');
  for (const d of list) { if (!d || !d.id) continue; const n = fromDoc(d.id, d); S.notes.set(n.id, n); Disk.seen.set(n.id, diskSig(n)); }
  Disk.on = true;
  // Première ouverture après mise à jour : on reprend les notes de l'ancien stockage, une seule fois.
  const old = LS.get('grimoire.vault');
  if (old && Array.isArray(old.notes) && !LS.get('grimoire.migrated')) {
    for (const d of old.notes) { if (!d || !d.id) continue; const cur = S.notes.get(d.id), n = fromDoc(d.id, d); if (!cur || n.updated > cur.updated) S.notes.set(n.id, n); }
    await diskFlush();
    if (!Disk.failed) { LS.set('grimoire.migrated', Date.now()); try { localStorage.removeItem('grimoire.vault'); } catch (e) { /* ignoré */ } }
  }
  return list.length > 0 || !!old;
}

async function startLocal() {
  let had = false;
  if (TAURI) { try { had = await diskOpen(); } catch (e) { Disk.on = false; toast("Le dossier Grimoire est inaccessible. Les notes restent dans l'appli pour l'instant.", { ms: 9000 }); } }
  persistVault = Disk.on
    ? debounce(diskFlush, 120)
    : debounce(() => LS.set('grimoire.vault', { v: 1, notes: [...S.notes.values()].map(n => Object.assign({ id: n.id }, toDoc(n))) }), 120);
  const kind = ghOn() ? 'github' : 'local';
  S.backend = {
    kind,
    put: async () => { persistVault.now(); if (kind === 'github') ghSchedule(); },
    del: async id => { if (kind === 'github') { GH.tomb[id] = Date.now(); LS.set('grimoire.tomb', GH.tomb); } persistVault.now(); if (kind === 'github') ghSchedule(); }
  };
  const saved = Disk.on ? null : LS.get('grimoire.vault');
  if (saved && Array.isArray(saved.notes)) for (const d of saved.notes) { if (d && d.id) S.notes.set(d.id, fromDoc(d.id, d)); }
  else if (!had && !saved && kind === 'local' && !LS.get('grimoire.seeded')) { for (const n of seedNotes()) S.notes.set(n.id, n); LS.set('grimoire.seeded', 1); persistVault.now(); }
  S.loaded = true; afterLoad(); paintSync();
  if (kind === 'github') {
    ghSync();
    setInterval(() => { if (!document.hidden) ghSync(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) ghSync(); });
  }
}

function ghSchedule() { clearTimeout(GH.timer); GH.timer = setTimeout(ghSync, 1800); paintSync(); }

function ghMerge(remote) {
  const changed = new Set(), now = Date.now(), MONTHS2 = 60 * 864e5;
  const rn = Array.isArray(remote.notes) ? remote.notes : [], rd = remote.deleted && typeof remote.deleted === 'object' ? remote.deleted : {};
  const dels = Object.assign({}, rd);
  for (const [id, ts] of Object.entries(GH.tomb)) if ((dels[id] || 0) < ts) dels[id] = ts;
  for (const d of rn) {
    if (!d || !d.id) continue;
    const ts = dels[d.id], ru = +d.updated || 0, cur = S.notes.get(d.id), busy = dirty.has(d.id) || saving.has(d.id);
    if (ts && ts >= ru) { if (cur && !busy && cur.updated <= ts) { S.notes.delete(d.id); changed.add(d.id); } continue; }
    if (!cur) { S.notes.set(d.id, fromDoc(d.id, d)); changed.add(d.id); }
    else if (!busy && ru > cur.updated) { S.notes.set(d.id, fromDoc(d.id, d)); changed.add(d.id); }
  }
  for (const [id, ts] of Object.entries(dels)) {
    const cur = S.notes.get(id);
    if (cur && cur.updated <= ts && !dirty.has(id) && !saving.has(id)) { S.notes.delete(id); changed.add(id); }
  }
  const notes = [...S.notes.values()].map(n => Object.assign({ id: n.id }, toDoc(n)));
  const deleted = {};
  for (const [id, ts] of Object.entries(dels)) { const n = S.notes.get(id); if (now - ts < MONTHS2 && (!n || n.updated <= ts)) deleted[id] = ts; }
  const rmap = new Map(rn.map(d => [d.id, d]));
  let push = rn.length !== notes.length || Object.keys(rd).length !== Object.keys(deleted).length;
  if (!push) for (const n of notes) { const r = rmap.get(n.id); if (!r || r.updated !== n.updated || r.title !== n.title || r.body !== n.body || !!r.pinned !== n.pinned) { push = true; break; } }
  if (!push) for (const id of Object.keys(deleted)) if (rd[id] !== deleted[id]) { push = true; break; }
  GH.tomb = deleted; LS.set('grimoire.tomb', deleted);
  return { out: { app: 'grimoire', v: 1, notes, deleted }, changed, push };
}

async function ghSync() {
  if (!ghOn() || !S.backend || S.backend.kind !== 'github') return;
  if (GH.busy) { GH.queued = true; return; }
  GH.busy = true; GH.queued = false; paintSync();
  const url = 'https://api.github.com/repos/' + GH.cfg.repo + '/contents/grimoire-notes.json';
  const H = { Authorization: 'Bearer ' + GH.cfg.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const r = await fetch(url, { headers: H, cache: 'no-store' });
      let sha = null, remote = { notes: [], deleted: {} };
      if (r.status === 200) {
        const j = await r.json(); sha = j.sha;
        try { remote = JSON.parse(b64d(j.content || '')); } catch (e) { throw { code: 'badfile' }; }
      } else if (r.status !== 404) throw { code: 'http', status: r.status };
      const m = ghMerge(remote);
      if (m.push) {
        const body = { message: 'sync ' + new Date().toISOString(), content: b64e(JSON.stringify(m.out)) };
        if (sha) body.sha = sha;
        const w = await fetch(url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify(body) });
        if (w.status === 409 || w.status === 422) { if (m.changed.size) afterRemote(m.changed); continue; }
        if (!w.ok) throw { code: 'http', status: w.status };
      }
      persistVault.now();
      if (m.changed.size) afterRemote(m.changed);
      ok = true;
    }
    if (!ok) throw { code: 'conflict' };
    GH.err = null; GH.last = Date.now();
  } catch (e) {
    GH.err = e && e.code === 'badfile' ? 'badfile' : e && e.status === 401 ? 'auth' : e && e.status === 403 ? 'auth' : e && e.status === 404 ? 'repo' : e && e.code === 'conflict' ? 'conflict' : 'net';
  }
  GH.busy = false; paintSync();
  if (GH.queued) ghSchedule();
}

function seedNotes() {
  const t = Date.now(), mk = (id, title, body, i, pinned) => ({ id: 'seed-' + id, title, body, pinned: !!pinned, created: t - i * 60000, updated: t - i * 60000 });
  return [
    mk('bienvenue', 'Bienvenue', [
      "Ce grimoire garde tes notes, les relie entre elles et les suit du PC au téléphone.",
      "",
      "Trois gestes suffisent :",
      "",
      "- **Écrire.** Une note est un simple texte en [[Markdown]].",
      "- **Relier.** Tape `[[` pour citer une autre note. Voir [[Liens entre notes]].",
      "- **Regarder.** [[Le graphe]] dessine toutes tes notes et ce qui les relie.",
      "",
      "Rien à enregistrer à la main : voir [[Synchronisation]].",
      "",
      "## Pour commencer",
      "",
      "- [ ] Ouvrir le graphe",
      "- [ ] Créer une première note",
      "- [ ] Ouvrir cette page sur le téléphone",
      "",
      "Les notes marquées #exemple servent de démonstration. Supprime-les quand tu veux."
    ].join('\n'), 0, true),
    mk('liens', 'Liens entre notes', [
      "Entoure un titre de doubles crochets pour créer un lien : `[[Le graphe]]` donne [[Le graphe]].",
      "",
      "- La note citée garde la trace de qui la cite, dans le volet **Citée par**.",
      "- Un lien vers une note qui n'existe pas encore, comme [[Idée à creuser]], reste en pointillé. Un clic la crée.",
      "- `[[Le graphe|ce dessin]]` affiche un autre texte : [[Le graphe|ce dessin]].",
      "- Renomme une note : les liens qui pointent vers elle suivent.",
      "",
      "#exemple"
    ].join('\n'), 1),
    mk('graphe', 'Le graphe', [
      "Chaque note est un point, chaque lien un fil. Plus une note est citée, plus son point grossit.",
      "",
      "- Glisse pour te déplacer, pince ou utilise la molette pour zoomer.",
      "- Touche un point pour voir ses voisins, touche-le une seconde fois pour ouvrir la note.",
      "- Les cercles en pointillé sont les notes citées mais pas encore écrites.",
      "- Le bouton **Étiquettes** ajoute les [[Étiquettes]] au dessin.",
      "",
      "Tout part des [[Liens entre notes]].",
      "",
      "#exemple"
    ].join('\n'), 2),
    mk('synchro', 'Synchronisation', [
      "Tes notes sont rangées sur l'appareil. Avec la synchronisation GitHub, elles te suivent partout.",
      "",
      "1. Crée un dépôt GitHub privé, puis un jeton limité à ce seul dépôt (droit Contents : lecture et écriture).",
      "2. Menu ⋯ en bas de l'index, puis « Synchroniser via GitHub ». Colle le dépôt et le jeton.",
      "3. Fais pareil sur l'autre appareil. Ce que tu écris d'un côté arrive de l'autre en moins d'une minute.",
      "",
      "Le point à côté du titre **Grimoire** indique l'état : plein quand tout est envoyé, rouge pendant l'envoi.",
      "",
      "> Si tu modifies la même note sur deux appareils au même instant, la dernière écriture l'emporte.",
      "",
      "Retour à [[Bienvenue]].",
      "",
      "#exemple"
    ].join('\n'), 3),
    mk('markdown', 'Markdown', [
      "Une façon d'écrire du texte mis en forme avec quelques signes.",
      "",
      "| Tu écris | Tu obtiens |",
      "| --- | --- |",
      "| `**gras**` | **gras** |",
      "| `*italique*` | *italique* |",
      "| `## Titre` | un titre |",
      "| `- [ ] à faire` | une case à cocher |",
      "| `> citation` | une citation |",
      "",
      "```js",
      "// Le code garde sa forme",
      "const notes = new Map();",
      "```",
      "",
      "S'y ajoutent les [[Liens entre notes]] et les [[Étiquettes]].",
      "",
      "#exemple"
    ].join('\n'), 4),
    mk('etiquettes', 'Étiquettes', [
      "Un mot précédé d'un croisillon devient une étiquette : #idée, #projet, #lecture.",
      "",
      "Elles apparaissent en haut de l'index. Un clic sur l'une d'elles ne garde que les notes qui la portent.",
      "",
      "Dans [[Le graphe]], elles peuvent servir de points de ralliement.",
      "",
      "#exemple"
    ].join('\n'), 5)
  ];
}

/* =====================================================================
   Actions
   ===================================================================== */
function afterLoad() {
  reindex();
  const want = boot.saved && boot.saved.active;
  if (want && S.notes.has(want)) S.active = want;
  else if (!S.active || !S.notes.has(S.active)) {
    const first = sortedNotes()[0];
    S.active = first ? first.id : null;
  }
  app.dataset.ready = '1';
  listEl.classList.add('first'); setTimeout(() => listEl.classList.remove('first'), 1200);
  paintAll();
}

function afterRemote(changed) {
  reindex();
  if (S.active && changed.has(S.active)) {
    if (!S.notes.has(S.active)) { S.active = null; toast('Cette note a été supprimée depuis un autre appareil.'); }
    hideSuggest();
  }
  paintAll();
}

const sortedNotes = () => [...S.notes.values()].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);

function play(el, cls) {
  if (reduceMotion || !el) return;
  el.classList.remove('in-fwd', 'in-back', 'in-veil', 'turn', 'go'); void el.offsetWidth; el.classList.add(cls);
}
const VIEW_ORDER = { notes: 0, page: 1, graphe: 2 };
function setView(v, fromHash) {
  if (!['notes', 'page', 'graphe'].includes(v)) v = 'notes';
  if (S.view === 'page' && v !== 'page') softRefresh.now();
  const prev = S.view;
  S.view = v; app.dataset.view = v;
  if (prev !== v && S.loaded) {
    const phone = isPhone();
    if (v === 'graphe') { play($('#web'), 'in-veil'); play($('#sweep'), 'go'); }
    else if (phone || prev === 'graphe') { play(phone && v === 'notes' ? $('.rail') : noteViewEl, VIEW_ORDER[v] > VIEW_ORDER[prev] ? 'in-fwd' : 'in-back'); play($('#sweep'), 'go'); }
  }
  document.querySelectorAll('.tabs [data-go]').forEach(b => b.toggleAttribute('aria-current', false));
  const cur = $('.tabs [data-go="' + v + '"]'); if (cur) cur.setAttribute('aria-current', 'page');
  $('#segNotes').setAttribute('aria-selected', v !== 'graphe'); $('#segWeb').setAttribute('aria-selected', v === 'graphe');
  if (!fromHash) { try { if (location.hash !== '#' + v) location.hash = v; } catch (e) { /* ignoré */ } }
  closePops();
  if (v === 'graphe') { paintGraph(); requestAnimationFrame(() => mainWeb.resize()); }
  else { autosize(); requestAnimationFrame(() => miniWeb.resize()); }
  rememberUi();
}

function setMode(m, focus) {
  S.mode = m; app.dataset.mode = m;
  $('#mRead').setAttribute('aria-selected', m === 'read'); $('#mWrite').setAttribute('aria-selected', m === 'write');
  const n = S.notes.get(S.active);
  hideSuggest();
  if (m === 'read') { softRefresh.now(); if (n) renderRead(n); }
  else { autosize(); if (focus) bodyEl.focus({ preventScroll: true }); }
  rememberUi();
}

function openNote(id, o) {
  if (!S.notes.has(id)) return;
  softRefresh.now();
  const turned = S.active !== id;
  S.active = id;
  setMode((o && o.mode) || 'read');
  if (turned) { play($('#sheet'), 'turn'); play($('#sweep'), 'go'); }
  paintPage(); paintList(); paintContext();
  if (S.view !== 'page') setView(isPhone() || S.view === 'graphe' ? 'page' : S.view);
  (isPhone() ? noteViewEl : pageEl).scrollTop = 0;
  rememberUi();
}

function createNote(title, body) {
  const now = Date.now(), n = { id: newId(), title: title || '', body: body || '', pinned: false, created: now, updated: now };
  S.notes.set(n.id, n); dirty.add(n.id); flush(n.id);
  reindex(); openNote(n.id, { mode: 'write' }); paintTags(); paintCounts();
  setTimeout(() => {
    if (!n.title) titleEl.focus();
    else { bodyEl.focus(); const e = bodyEl.value.length; bodyEl.setSelectionRange(e, e); }
  }, 30);
  return n;
}

function openByTitle(t) {
  const id = I.title.get(norm(t));
  if (id) openNote(id); else createNote(t.trim());
}

function deleteNote(id) {
  const n = S.notes.get(id); if (!n) return;
  clearTimeout(timers.get(id)); dirty.delete(id); again.delete(id);
  S.notes.delete(id); removing.add(id);
  let undone = false;
  Promise.resolve().then(() => S.backend.del(id)).then(
    () => setTimeout(() => { if (!undone) removing.delete(id); }, 6000),
    e => { removing.delete(id); writeFailed(e, null); });
  if (S.active === id) {
    S.active = null;
    if (isPhone()) setView('notes'); else { const next = sortedNotes()[0]; if (next) { S.active = next.id; S.mode = 'read'; } }
  }
  reindex(); paintAll();
  toast('« ' + (n.title || 'Sans titre') + ' » supprimée.', {
    action: 'Annuler', ms: 7000, fn: () => {
      undone = true; removing.delete(id);
      n.updated = Date.now(); S.notes.set(id, n); dirty.add(id); flush(id);
      reindex(); openNote(id); paintAll();
    }
  });
}

function dailyNote() {
  const d = new Date(), title = 'Journal du ' + d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const id = I.title.get(norm(title));
  if (id) openNote(id, { mode: 'write' }); else createNote(title, '#journal\n\n');
}

function renameLinks(oldTitle, newTitle, selfId) {
  const k = norm(oldTitle); if (!k || !newTitle.trim() || k === norm(newTitle)) return 0;
  for (const n of S.notes.values()) if (n.id !== selfId && norm(n.title) === k) return 0; // titre partagé : on ne touche à rien
  let count = 0;
  for (const n of S.notes.values()) {
    if (n.id === selfId || !n.body.includes('[[')) continue;
    const m = mask(n.body); let out = '', last = 0, r, hit = false; const re = /\[\[([^\[\]|\n]+)((?:\|[^\[\]\n]*)?)\]\]/g;
    while ((r = re.exec(m))) {
      if (norm(r[1]) !== k) continue;
      out += n.body.slice(last, r.index) + '[[' + newTitle.trim() + n.body.slice(r.index + 2 + r[1].length, r.index + r[0].length);
      last = r.index + r[0].length; hit = true;
    }
    if (hit) { n.body = out + n.body.slice(last); n.updated = Date.now(); touch(n.id); count++; }
  }
  return count;
}

/* =====================================================================
   Painting
   ===================================================================== */
function paintAll() {
  reindex(); paintList(); paintTags(); paintPage(); paintContext(); paintCounts(); paintSync();
  if (S.view === 'graphe') paintGraph();
}

const softRefresh = debounce(() => {
  reindex(); paintList(); paintTags(); paintMeta(); paintContext(); paintCounts();
  if (S.view === 'graphe') paintGraph();
}, 320);

function paintList() {
  const q = norm(S.q); let arr = sortedNotes();
  if (S.tag) { const set = I.tags.get(S.tag); arr = arr.filter(n => set && set.has(n.id)); }
  if (q) {
    arr = arr.filter(n => { parsed(n); return norm(n.title).includes(q) || n._nb.includes(q); });
    arr.sort((a, b) => (norm(b.title).includes(q) ? 1 : 0) - (norm(a.title).includes(q) ? 1 : 0));
  }
  let h = '';
  if (q && !I.title.has(q)) h += '<li><button type="button" class="item create" data-create="' + esc(S.q.trim()) + '"><span class="item-t"><svg class="ic" viewBox="0 0 24 24"><use href="#i-plus"/></svg>Créer « ' + esc(S.q.trim()) + ' »</span></button></li>';
  for (const n of arr) {
    const links = (I.out.get(n.id) || new Set()).size + (I.back.get(n.id) || new Set()).size, x = excerpt(n);
    h += '<li><button type="button" class="item' + (n.id === S.active ? ' on' : '') + '" data-id="' + esc(n.id) + '">' +
      '<span class="item-t' + (n.title ? '' : ' untitled') + '">' + (n.pinned ? '<svg class="ic" viewBox="0 0 24 24"><use href="#i-pin"/></svg>' : '') + esc(n.title || 'Sans titre') + '</span>' +
      (x ? '<span class="item-x">' + esc(x) + '</span>' : '') +
      '<span class="item-m">' + ago(n.updated) + (links ? ' · ' + plural(links, 'lien', 'liens') : '') + '</span></button></li>';
  }
  if (!arr.length && !q) h += '<li class="list-empty">' + (!S.loaded ? 'Ouverture du grimoire' : S.tag ? 'Aucune note ne porte cette étiquette.' : 'Aucune note. Commence par « Nouvelle note ».') + '</li>';
  listEl.innerHTML = h;
}

function paintTags() {
  const arr = [...I.tags.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  if (S.tag && !I.tags.has(S.tag)) S.tag = null;
  tagsEl.innerHTML = arr.map(([t, s]) => '<button type="button" class="tag" data-tag="' + esc(t) + '" aria-pressed="' + (S.tag === t) + '">#' + esc(t) + '<b>' + s.size + '</b></button>').join('');
}

function paintCounts() {
  let links = 0; for (const s of I.out.values()) links += s.size;
  $('#counts').textContent = S.loaded ? plural(S.notes.size, 'note', 'notes') + ' · ' + plural(links, 'lien', 'liens') : ' ';
}

function paintPage() {
  const n = S.notes.get(S.active);
  app.dataset.has = n ? '1' : '0'; app.dataset.mode = S.mode;
  $('#mRead').setAttribute('aria-selected', S.mode === 'read'); $('#mWrite').setAttribute('aria-selected', S.mode === 'write');
  if (!n) {
    const empty = S.loaded && !S.notes.size;
    $('#blankT').textContent = !S.loaded ? 'Ouverture du grimoire' : empty ? 'Grimoire vide' : 'Aucune page ouverte';
    $('#blankX').textContent = !S.loaded ? 'Les notes arrivent.' : empty ? "Pas encore de note. La première n'attend que toi." : "Choisis une note dans l'index, ou commences-en une.";
    $('#blankNew').hidden = !S.loaded;
    return;
  }
  if (titleEl.value !== n.title) titleEl.value = n.title;
  titleEl.dataset.was = n.title;
  if (bodyEl.value !== n.body) {
    const focused = document.activeElement === bodyEl, pos = bodyEl.selectionStart;
    bodyEl.value = n.body;
    if (focused) bodyEl.setSelectionRange(Math.min(pos, n.body.length), Math.min(pos, n.body.length));
  }
  $('#pinBtn').setAttribute('aria-pressed', !!n.pinned);
  if (S.mode === 'read') renderRead(n); else autosize();
  paintMeta();
}

function paintMeta() {
  const n = S.notes.get(S.active); if (!n) return;
  const p = parsed(n), out = (I.out.get(n.id) || new Set()).size, back = (I.back.get(n.id) || new Set()).size;
  metaEl.textContent = 'modifiée ' + ago(n.updated) + ' · ' + plural(p.words, 'mot', 'mots') + ' · cite ' + out + ' · citée par ' + back;
}

function renderRead(n) {
  if (!n.body.trim()) { readEl.innerHTML = '<p class="empty-read">Page blanche. Passe sur « Écrire » pour la remplir.</p>'; return; }
  readEl.innerHTML = renderMd(n.body);
  decorate(readEl);
}

function autosize() {
  if (S.mode !== 'write' || !S.notes.has(S.active)) return;
  const sc = isPhone() ? noteViewEl : pageEl, top = sc.scrollTop;
  bodyEl.style.height = 'auto';
  bodyEl.style.height = bodyEl.scrollHeight + 4 + 'px';
  sc.scrollTop = top;
}

function contextLine(n, targetId) {
  const lines = n.body.split('\n');
  for (const l of lines) {
    WL.lastIndex = 0; let r;
    while ((r = WL.exec(l))) if (I.title.get(norm(r[1])) === targetId)
      return l.replace(WL, (m, a, b) => b || a).replace(/^\s*(?:[-*+]|\d+[.)]|#+|>)\s+(?:\[[ xX]\]\s+)?/, '').replace(/[*_`]/g, '').trim().slice(0, 140);
  }
  return excerpt(n);
}

function paintContext() {
  const n = S.notes.get(S.active); if (!n) return;
  const backs = [...(I.back.get(n.id) || [])].map(id => S.notes.get(id)).filter(Boolean).sort((a, b) => b.updated - a.updated);
  const outs = [...(I.out.get(n.id) || [])].map(id => S.notes.get(id)).filter(Boolean);
  const ghosts = []; const seen = new Set();
  for (const t of parsed(n).links) { const k = norm(t); if (!I.title.has(k) && !seen.has(k)) { seen.add(k); ghosts.push(t); } }
  $('#backN').textContent = backs.length || ''; $('#outN').textContent = (outs.length + ghosts.length) || '';
  $('#backs').innerHTML = backs.length
    ? backs.map(b => '<li><button type="button" data-id="' + esc(b.id) + '"><span class="t">' + esc(b.title || 'Sans titre') + '</span><span class="x">' + esc(contextLine(b, n.id)) + '</span></button></li>').join('')
    : '<li class="none">Aucune note ne cite encore celle-ci.</li>';
  $('#outs').innerHTML = (outs.length || ghosts.length)
    ? outs.map(b => '<li><button type="button" data-id="' + esc(b.id) + '"><span class="t">' + esc(b.title || 'Sans titre') + '</span></button></li>').join('') +
      ghosts.map(t => '<li class="ghost"><button type="button" data-ghost="' + esc(t) + '"><span class="t">' + esc(t) + '</span><span class="x">à écrire</span></button></li>').join('')
    : '<li class="none">Tape [[ dans le texte pour citer une note.</li>';

  const ids = new Set([n.id]); outs.forEach(x => ids.add(x.id)); backs.forEach(x => ids.add(x.id));
  const nodes = [...ids].map(id => ({ id, label: S.notes.get(id).title || 'Sans titre', kind: 'note' })), edges = [];
  for (const id of ids) for (const o of I.out.get(id) || []) if (ids.has(o)) edges.push([id, o]);
  for (const t of ghosts) { const gid = 'ghost:' + norm(t); nodes.push({ id: gid, label: t, kind: 'ghost' }); edges.push([n.id, gid]); }
  miniWeb.setData(nodes, edges);
}

function graphData() {
  const o = S.gopt; let nodes = [], edges = [];
  for (const n of S.notes.values()) nodes.push({ id: n.id, label: n.title || 'Sans titre', kind: 'note' });
  for (const [a, set] of I.out) for (const b of set) edges.push([a, b]);
  const noteLinks = new Set(edges.map(e => e[0] < e[1] ? e[0] + '|' + e[1] : e[1] + '|' + e[0])).size;
  if (o.ghosts) for (const [k, g] of I.ghosts) { nodes.push({ id: 'ghost:' + k, label: g.label, kind: 'ghost' }); for (const f of g.from) edges.push([f, 'ghost:' + k]); }
  if (o.tags) for (const [t, set] of I.tags) { nodes.push({ id: 'tag:' + t, label: '#' + t, kind: 'tag' }); for (const f of set) edges.push([f, 'tag:' + t]); }
  if (!o.orphans) { const linked = new Set(); for (const e of edges) { linked.add(e[0]); linked.add(e[1]); } nodes = nodes.filter(n => linked.has(n.id)); }
  return { nodes, edges, noteLinks };
}

function paintGraph() {
  const g = graphData();
  mainWeb.setData(g.nodes, g.edges);
  const ghosts = I.ghosts.size;
  $('#legend').textContent = plural(S.notes.size, 'note', 'notes') + ' · ' + plural(g.noteLinks, 'lien', 'liens') + (ghosts ? ' · ' + ghosts + ' à écrire' : '');
  paintCard(mainWeb.sel);
}

function paintCard(node) {
  const card = $('#card');
  if (!node) { card.hidden = true; return; }
  let h = '';
  if (node.kind === 'note') {
    const n = S.notes.get(node.id); if (!n) { card.hidden = true; return; }
    const out = (I.out.get(n.id) || new Set()).size, back = (I.back.get(n.id) || new Set()).size;
    h = '<span class="k">note · cite ' + out + ' · citée par ' + back + '</span><span class="t">' + esc(n.title || 'Sans titre') + '</span><span class="x">' + esc(excerpt(n, 200)) + '</span>' +
      '<div class="row"><button type="button" class="btn solid" data-open="' + esc(n.id) + '">Ouvrir</button></div>';
  } else if (node.kind === 'ghost') {
    const g = I.ghosts.get(node.id.slice(6));
    h = '<span class="k">note à écrire · citée par ' + (g ? g.from.size : 0) + '</span><span class="t">' + esc(node.label) + '</span>' +
      '<div class="row"><button type="button" class="btn solid" data-ghost="' + esc(node.label) + '">Créer la note</button></div>';
  } else {
    const t = node.id.slice(4), set = I.tags.get(t);
    h = '<span class="k">étiquette · ' + plural(set ? set.size : 0, 'note', 'notes') + '</span><span class="t">#' + esc(t) + '</span>' +
      '<div class="row"><button type="button" class="btn solid" data-tagopen="' + esc(t) + '">Voir les notes</button></div>';
  }
  card.innerHTML = h; card.hidden = false;
}

/* ---------- sync indicator ---------- */
function syncState() {
  if (!S.backend) return 'opening';
  if (S.backend.kind === 'local') return 'local';
  if (S.backend.kind === 'github') return GH.err ? 'error' : GH.busy || dirty.size || GH.timer && !GH.busy && GH.queued ? 'saving' : 'synced';
  if (S.sync.error) return 'error';
  if (!S.loaded) return 'opening';
  if (dirty.size || saving.size) return 'saving';
  if (S.sync.fromCache || S.sync.slow) return 'cache';
  return 'synced';
}
const SYNC = {
  opening: ['Ouverture', 'Ouverture du grimoire', "Connexion à ton carnet. Si le réseau est lent, la dernière copie connue s'affiche d'abord."],
  local: ['Cet appareil', 'Cet appareil seulement', "Les notes restent sur cet appareil, dans le dossier Grimoire. Pour les retrouver sur ton PC et ton téléphone, active la synchronisation GitHub : menu ⋯ en bas de l'index."],
  saving: ['Envoi', 'Enregistrement en cours', "Tes dernières modifications partent vers ton carnet. Cela prend une seconde ou deux."],
  cache: ['Copie locale', 'Copie locale', "Le serveur ne répond pas encore. Tu vois la dernière copie connue sur cet appareil ; elle peut avoir du retard. La mise à jour se fera seule dès que la connexion revient."],
  synced: ['Synchronisé', 'Tout est synchronisé', "Tes notes sont dans ton compte Claude, dans un carnet que toi seul peux lire. Ouvre cette même page sur ton téléphone ou ton PC, connecté au même compte : elles y sont, et chaque modification arrive en direct."],
  error: ['Non enregistré', 'Enregistrement interrompu', "Les dernières modifications ne sont pas encore parvenues au serveur. Garde la page ouverte : un nouvel essai part tout seul. Par sécurité, exporte tes notes depuis le menu en bas de l'index."]
};
function paintSync() {
  const st = syncState();
  $('#sync').dataset.state = st; $('#syncDot').dataset.state = st;
  $('#syncLabel').textContent = SYNC[st][0];
  const pop = $('#syncPop'); if (!pop.hidden) fillSyncPop();
}
function fillSyncPop() {
  const st = syncState(); let extra = '';
  if (S.backend && S.backend.kind === 'github') {
    const E = { auth: ['Jeton refusé', "GitHub refuse le jeton. Vérifie qu'il n'a pas expiré et qu'il a le droit Contents en lecture et écriture sur ce dépôt."], repo: ['Dépôt introuvable', "GitHub ne trouve pas ce dépôt avec ce jeton. Vérifie l'orthographe (propriétaire/nom) et que le jeton couvre ce dépôt."], net: ['Hors ligne', "Pas de connexion à GitHub pour le moment. Tes notes sont gardées ici et partiront dès que le réseau revient."], conflict: ['Conflit', "Deux appareils écrivaient en même temps. Un nouvel essai part tout seul."], badfile: ['Fichier illisible', "Le fichier grimoire-notes.json du dépôt est abîmé. Rien n'est écrasé : restaure-le depuis l'historique du dépôt."] };
    if (GH.err) { $('#syncPop').innerHTML = '<h3>' + E[GH.err][0] + '</h3><p>' + E[GH.err][1] + '</p>'; return; }
    $('#syncPop').innerHTML = (Disk.on ? '<p>Dossier des notes : <b style="overflow-wrap:anywhere">' + esc(Disk.path) + '</b></p>' : '') + '<h3>' + SYNC[st][1] + '</h3><p>' + (st === 'saving' ? 'Envoi vers GitHub en cours.' : 'Tes notes sont dans ton dépôt GitHub' + (GH.last ? ', vérifié ' + ago(GH.last) : '') + '. Les autres appareils les recevront en moins d\'une minute.') + '</p>';
    return;
  }
  if (st === 'error' && S.sync.error === 'quota_exceeded') extra = '<p>Le carnet est plein. Supprime quelques notes pour libérer de la place.</p>';
  if (st === 'error' && S.sync.error === 'invalid_argument') extra = "<p>L'écriture est refusée pour ton accès à cette page. Il faut au moins le rôle Contributeur.</p>";
  if (Disk.on) extra += '<p>Dossier des notes : <b style="overflow-wrap:anywhere">' + esc(Disk.path) + '</b></p>';
  $('#syncPop').innerHTML = '<h3>' + SYNC[st][1] + '</h3><p>' + SYNC[st][2] + '</p>' + extra;
}

/* ---------- floating bits ---------- */
function place(pop, anchor) {
  pop.hidden = false;
  const a = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let top = a.bottom + 8; if (top + h > vh - 8) top = Math.max(8, a.top - h - 8);
  pop.style.top = top + 'px'; pop.style.left = clamp(a.left, 8, Math.max(8, vw - w - 8)) + 'px';
}
function closePops() { $('#syncPop').hidden = true; $('#menu').hidden = true; $('#shareMenu').hidden = true; }

function toast(msg, o) {
  o = o || {}; const el = document.createElement('div'); el.className = 'toast';
  const s = document.createElement('span'); s.textContent = msg; el.append(s);
  let t; const kill = () => { clearTimeout(t); el.remove(); };
  if (o.action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = o.action; b.onclick = () => { kill(); o.fn(); }; el.append(b); }
  $('#toasts').append(el); t = setTimeout(kill, o.ms || 4200);
}

/* ---------- wikilink suggestions ---------- */
let sug = null;
function linkCtx() {
  const p = bodyEl.selectionStart, v = bodyEl.value;
  if (p !== bodyEl.selectionEnd) return null;
  const s = v.lastIndexOf('[[', p - 1); if (s < 0) return null;
  const frag = v.slice(s + 2, p);
  if (/[\]\n|]/.test(frag) || frag.length > 60) return null;
  return { s, p, frag };
}
function paintSuggest() {
  if (S.mode !== 'write' || document.activeElement !== bodyEl) return hideSuggest();
  const c = linkCtx(); if (!c) return hideSuggest();
  const q = norm(c.frag);
  const hits = [...S.notes.values()].filter(n => n.id !== S.active && n.title && norm(n.title).includes(q))
    .sort((a, b) => (norm(b.title).startsWith(q) ? 1 : 0) - (norm(a.title).startsWith(q) ? 1 : 0) || b.updated - a.updated).slice(0, 6);
  const keep = sug && sug.q === q ? Math.min(sug.i, Math.max(0, hits.length - 1)) : 0;
  sug = { q, hits, i: keep, frag: c.frag.trim() };
  let h = '<span class="lbl">lier</span>';
  hits.forEach((n, i) => { h += '<button type="button" data-pick="' + esc(n.title) + '"' + (i === sug.i ? ' class="on"' : '') + '>' + esc(n.title) + '</button>'; });
  if (sug.frag && !I.title.has(q)) h += '<button type="button" data-pick="' + esc(sug.frag) + '"' + (!hits.length ? ' class="on"' : '') + '>Nouvelle : ' + esc(sug.frag) + '</button>';
  if (!hits.length && !sug.frag) h += '<span class="lbl">tape le début d’un titre</span>';
  suggestEl.innerHTML = h; suggestEl.hidden = false;
}
function hideSuggest() { sug = null; suggestEl.hidden = true; }
function pick(title) {
  const c = linkCtx(); if (!c) return hideSuggest();
  let end = c.p; if (bodyEl.value.slice(end, end + 2) === ']]') end += 2;
  bodyEl.setRangeText('[[' + title + ']]', c.s, end, 'end');
  hideSuggest(); bodyEl.focus(); fireInput();
}
const fireInput = () => bodyEl.dispatchEvent(new Event('input', { bubbles: true }));

/* ---------- formatting ---------- */
function wrapSel(a, b) {
  const s = bodyEl.selectionStart, e = bodyEl.selectionEnd, sel = bodyEl.value.slice(s, e);
  bodyEl.setRangeText(a + sel + b, s, e, 'end');
  bodyEl.setSelectionRange(s + a.length, s + a.length + sel.length);
  bodyEl.focus(); fireInput();
}
function prefixLine(p) {
  const s = bodyEl.selectionStart, v = bodyEl.value, ls = v.lastIndexOf('\n', s - 1) + 1;
  if (v.startsWith(p, ls)) bodyEl.setRangeText('', ls, ls + p.length, 'preserve');
  else bodyEl.setRangeText(p, ls, ls, s === ls ? 'end' : 'preserve');
  bodyEl.focus(); fireInput();
}
function format(kind) {
  if (kind === 'link') { wrapSel('[[', ']]'); paintSuggest(); }
  else if (kind === 'task') prefixLine('- [ ] ');
  else if (kind === 'head') prefixLine('## ');
  else if (kind === 'bold') wrapSel('**', '**');
  else if (kind === 'tag') { const s = bodyEl.selectionStart, pre = bodyEl.value[s - 1]; bodyEl.setRangeText((pre && !/\s/.test(pre) ? ' ' : '') + '#', s, bodyEl.selectionEnd, 'end'); bodyEl.focus(); fireInput(); }
}

function toggleTask(i) {
  const n = S.notes.get(S.active); if (!n) return;
  const m = mask(n.body), re = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/gm; let r, k = 0;
  while ((r = re.exec(m))) {
    if (k++ !== i) continue;
    const at = r.index + r[1].length + 1;
    n.body = n.body.slice(0, at) + (r[2] === ' ' ? 'x' : ' ') + n.body.slice(at + 1);
    n.updated = Date.now(); bodyEl.value = n.body; touch(n.id); renderRead(n); softRefresh();
    return;
  }
}

/* ---------- export / import ---------- */
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'note';
async function saveFile(filename, data, fallbackMsg) {
  const T = window.__TAURI__;
  if (T && T.core && T.core.invoke) {
    try { if (await T.core.invoke('export_file', { name: filename, content: data })) toast('« ' + filename + ' » enregistré.'); return; }
    catch (e) { /* on tente les autres voies */ }
  }
  if (downloads) {
    try { await downloads.save({ filename, data }); return; }
    catch (e) { if (e && e.code === 'declined') return; }
  }
  try {
    const a = document.createElement('a'), u = URL.createObjectURL(new Blob([data], { type: 'text/plain' }));
    a.href = u; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
    toast('Fichier « ' + filename + ' » enregistré dans les téléchargements.');
  } catch (e) {
    try { await navigator.clipboard.writeText(data); toast(fallbackMsg); } catch (x) { toast("L'export n'est pas disponible ici."); }
  }
}
function exportAll() {
  const data = JSON.stringify({ app: 'grimoire', v: 1, exported: new Date().toISOString(), notes: [...S.notes.values()].map(n => Object.assign({ id: n.id }, toDoc(n))) }, null, 2);
  saveFile('grimoire-' + new Date().toISOString().slice(0, 10) + '.json', data, 'Téléchargement indisponible ici : la sauvegarde est copiée dans le presse-papiers.');
}
function exportOne() {
  const n = S.notes.get(S.active); if (!n) return toast("Ouvre d'abord une note.");
  saveFile(slug(n.title) + '.md', '# ' + (n.title || 'Sans titre') + '\n\n' + n.body + '\n', 'Téléchargement indisponible ici : la note est copiée dans le presse-papiers.');
}
async function importFiles(files) {
  let added = 0, updated = 0;
  for (const f of files) {
    let text; try { text = await f.text(); } catch (e) { continue; }
    if (/\.json$/i.test(f.name)) {
      let d; try { d = JSON.parse(text); } catch (e) { toast('« ' + f.name + " » n'est pas un fichier JSON lisible."); continue; }
      const arr = Array.isArray(d) ? d : d && Array.isArray(d.notes) ? d.notes : null;
      if (!arr) { toast('« ' + f.name + ' » ne contient pas de notes.'); continue; }
      for (const raw of arr) {
        if (!raw || typeof raw !== 'object') continue;
        const id = /^[\w.~:@+-]{1,120}$/.test(String(raw.id || '')) ? String(raw.id) : newId();
        const n = fromDoc(id, raw), cur = S.notes.get(id);
        if (cur && cur.updated >= n.updated) continue;
        S.notes.set(id, n); dirty.add(id); cur ? updated++ : added++;
      }
    } else {
      const now = Date.now(), m = /^#\s+(.+)\n+/.exec(text);
      const n = { id: newId(), title: m ? m[1].trim() : f.name.replace(/\.[^.]+$/, ''), body: m ? text.slice(m[0].length) : text, pinned: false, created: now, updated: now };
      S.notes.set(n.id, n); dirty.add(n.id); added++;
    }
  }
  reindex(); paintAll();
  for (const id of [...dirty]) await flush(id);
  toast(added || updated ? plural(added, 'note ajoutée', 'notes ajoutées') + (updated ? ', ' + plural(updated, 'mise à jour', 'mises à jour') : '') + '.' : 'Rien de nouveau à importer.');
}

/* =====================================================================
   Wiring
   ===================================================================== */
const openNode = n => {
  if (n.kind === 'note') openNote(n.id);
  else if (n.kind === 'ghost') createNote(n.label);
  else filterTag(n.id.slice(4));
};
const mainWeb = new Web($('#graph'), { activeId: () => S.active, onSelect: paintCard, onOpen: openNode });
const miniWeb = new Web($('#mini'), { mini: true, activeId: () => S.active, onOpen: openNode });

function filterTag(t) {
  S.tag = S.tag === t && S.view === 'notes' ? null : t;
  paintTags(); paintList();
  if (S.view === 'graphe' || isPhone()) setView('notes');
  listEl.scrollTop = 0;
}

function rememberUi() { LS.set('grimoire.ui', { active: S.active, view: S.view, mode: S.mode, gopt: S.gopt }); }

function bindUi() {
  document.addEventListener('click', e => {
    const go = e.target.closest('[data-go]');
    if (go) { setView(go.dataset.go); return; }
    const md = e.target.closest('[data-mode]');
    if (md && md.closest('.seg')) { setMode(md.dataset.mode, true); return; }
  });

  listEl.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.create != null) { const t = b.dataset.create; S.q = ''; qEl.value = ''; createNote(t); }
    else if (b.dataset.id) openNote(b.dataset.id);
  });
  tagsEl.addEventListener('click', e => { const b = e.target.closest('[data-tag]'); if (b) { S.tag = S.tag === b.dataset.tag ? null : b.dataset.tag; paintTags(); paintList(); } });

  qEl.addEventListener('input', () => { S.q = qEl.value; paintList(); });
  qEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const first = listEl.querySelector('button.item'); if (first) first.click(); }
    else if (e.key === 'Escape') { qEl.value = ''; S.q = ''; paintList(); }
  });

  $('#newNote').onclick = () => createNote('');
  $('#blankNew').onclick = () => createNote('');
  $('#daily').onclick = dailyNote;

  titleEl.addEventListener('focus', () => { titleEl.dataset.was = titleEl.value; });
  titleEl.addEventListener('input', () => {
    const n = S.notes.get(S.active); if (!n) return;
    n.title = titleEl.value.replace(/[\[\]|\n]/g, ''); n.updated = Date.now(); touch(n.id); softRefresh();
  });
  titleEl.addEventListener('change', () => {
    const n = S.notes.get(S.active); if (!n) return;
    if (titleEl.value !== n.title) titleEl.value = n.title;
    const c = renameLinks(titleEl.dataset.was || '', n.title, n.id);
    titleEl.dataset.was = n.title; softRefresh.now();
    if (c) toast('Liens mis à jour dans ' + plural(c, 'note', 'notes') + '.');
  });
  titleEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setMode('write', true); } });

  bodyEl.addEventListener('input', () => {
    const n = S.notes.get(S.active); if (!n) return;
    n.body = bodyEl.value; n.updated = Date.now(); touch(n.id);
    autosize(); paintSuggest(); softRefresh();
    if (n.body.length > 180000 && !n._warned) { n._warned = true; toast('Cette note devient très longue. Coupe-la en plusieurs pour rester sous la limite de taille.', { ms: 8000 }); }
  });
  bodyEl.addEventListener('keyup', e => { if (/^(Arrow|Home|End|Page)/.test(e.key) && !(sug && /^Arrow(Up|Down)$/.test(e.key))) paintSuggest(); });
  bodyEl.addEventListener('click', paintSuggest);
  bodyEl.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== bodyEl) hideSuggest(); }, 150));
  bodyEl.addEventListener('keydown', e => {
    if (sug && !suggestEl.hidden) {
      const opts = [...suggestEl.querySelectorAll('[data-pick]')];
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && opts.length) {
        e.preventDefault();
        let i = opts.findIndex(o => o.classList.contains('on')); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
        opts.forEach((o, j) => o.classList.toggle('on', j === i)); sug.i = i; return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && opts.length) { e.preventDefault(); (opts.find(o => o.classList.contains('on')) || opts[0]).click(); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && bodyEl.selectionStart === bodyEl.selectionEnd) {
      const s = bodyEl.selectionStart, v = bodyEl.value, ls = v.lastIndexOf('\n', s - 1) + 1, line = v.slice(ls, s);
      const m = /^(\s*)(?:([-*+])|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/.exec(line);
      if (m) {
        e.preventDefault();
        if (m[0].length === line.length) bodyEl.setRangeText('', ls, s, 'end');
        else bodyEl.setRangeText('\n' + m[1] + (m[2] ? m[2] : (+m[3] + 1) + m[4]) + ' ' + (m[5] ? '[ ] ' : ''), s, s, 'end');
        fireInput();
      }
    }
  });
  suggestEl.addEventListener('pointerdown', e => e.preventDefault());
  suggestEl.addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) pick(b.dataset.pick); });

  $('#fmt').addEventListener('pointerdown', e => { if (e.target.closest('[data-fmt]')) e.preventDefault(); });
  $('#fmt').addEventListener('click', e => { const b = e.target.closest('[data-fmt]'); if (b) format(b.dataset.fmt); });

  $('#pinBtn').onclick = () => { const n = S.notes.get(S.active); if (!n) return; n.pinned = !n.pinned; n.updated = Date.now(); touch(n.id); flush(n.id); $('#pinBtn').setAttribute('aria-pressed', n.pinned); paintList(); };
  $('#delBtn').onclick = () => { if (S.active) deleteNote(S.active); };
  const noteText = n => '# ' + (n.title || 'Sans titre') + '\n\n' + n.body + '\n';
  const plainText = n => (n.title || 'Sans titre') + '\n\n' + n.body.replace(/\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]/g, (m, a, b) => b || a).replace(/^#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '').replace(/^(\s*)[-*+] \[( |x|X)\] /gm, (m, sp, c) => sp + (c === ' ' ? '☐ ' : '☑ ')) + '\n';
  const copyNote = async n => {
    try { await navigator.clipboard.writeText(noteText(n)); toast('Note copiée. Colle-la où tu veux.'); }
    catch (e) { toast('La copie est bloquée dans cette vue.'); }
  };
  $('#shareBtn').onclick = e => { e.stopPropagation(); const p = $('#shareMenu'), open = p.hidden; closePops(); if (open) { $('#shNative').hidden = !navigator.share; place(p, $('#shareBtn')); } };
  $('#shNative').onclick = async () => {
    closePops(); const n = S.notes.get(S.active); if (!n) return;
    try { await navigator.share({ title: n.title || 'Note', text: plainText(n) }); }
    catch (e) { if (!e || e.name !== 'AbortError') copyNote(n); }
  };
  $('#shCopy').onclick = () => { closePops(); const n = S.notes.get(S.active); if (n) copyNote(n); };
  $('#shMd').onclick = () => { closePops(); exportOne(); };
  $('#shTxt').onclick = () => { closePops(); const n = S.notes.get(S.active); if (n) saveFile(slug(n.title) + '.txt', plainText(n), 'Téléchargement indisponible ici : la note est copiée dans le presse-papiers.'); };
  $('#shAll').onclick = () => { closePops(); exportAll(); };

  readEl.addEventListener('click', e => {
    const wl = e.target.closest('a.wl'); if (wl) { e.preventDefault(); openByTitle(wl.dataset.wl); return; }
    const tg = e.target.closest('.tagref'); if (tg) { filterTag(tg.dataset.tag); return; }
  });
  readEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('a.wl, .tagref')) e.target.click(); });
  readEl.addEventListener('change', e => { if (e.target.matches('input[type="checkbox"]')) toggleTask(+e.target.dataset.i); });
  readEl.addEventListener('dblclick', e => { if (!e.target.closest('a, input, .tagref')) setMode('write', true); });

  $('#context').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.id) openNote(b.dataset.id); else if (b.dataset.ghost) createNote(b.dataset.ghost);
  });

  $('#card').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.open) openNote(b.dataset.open); else if (b.dataset.ghost) createNote(b.dataset.ghost); else if (b.dataset.tagopen) filterTag(b.dataset.tagopen);
  });
  const opt = (id, key) => { const el = $(id); el.checked = S.gopt[key]; el.addEventListener('change', () => { S.gopt[key] = el.checked; paintGraph(); rememberUi(); }); };
  opt('#gTags', 'tags'); opt('#gGhosts', 'ghosts'); opt('#gOrph', 'orphans');
  $('#zIn').onclick = () => mainWeb.zoomAt(mainWeb.w / 2, mainWeb.h / 2, 1.35);
  $('#zOut').onclick = () => mainWeb.zoomAt(mainWeb.w / 2, mainWeb.h / 2, 1 / 1.35);
  $('#zFit').onclick = () => mainWeb.fit();

  $('#sync').onclick = e => { e.stopPropagation(); const p = $('#syncPop'), open = p.hidden; closePops(); if (open) { fillSyncPop(); place(p, $('#sync')); } };
  $('#menuBtn').onclick = e => { e.stopPropagation(); const p = $('#menu'), open = p.hidden; closePops(); if (open) place(p, $('#menuBtn')); };
  $('#exportAll').onclick = () => { closePops(); exportAll(); };
  $('#exportOne').onclick = () => { closePops(); exportOne(); };
  $('#importBtn').onclick = () => { closePops(); $('#importFile').click(); };
  const dlg = $('#ghDlg'), ghErr = (m) => { const e = $('#ghErr'); e.textContent = m || ''; e.hidden = !m; };
  $('#ghBtn').onclick = () => {
    closePops(); ghErr('');
    $('#ghRepo').value = (GH.cfg && GH.cfg.repo) || ''; $('#ghToken').value = '';
    $('#ghToken').placeholder = ghOn() ? 'Déjà enregistré (vide = garder)' : 'github_pat_…';
    $('#ghOff').hidden = !ghOn();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  };
  $('#ghCancel').onclick = () => dlg.close();
  $('#ghOff').onclick = () => { LS.set('grimoire.gh', null); GH.cfg = null; location.reload(); };
  $('#ghForm').addEventListener('submit', e => {
    e.preventDefault();
    const repo = $('#ghRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, ''), token = $('#ghToken').value.trim() || (GH.cfg && GH.cfg.token) || '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return ghErr('Le dépôt s\'écrit propriétaire/nom, par exemple LonerFy/grimoire-notes.');
    if (!token) return ghErr('Colle le jeton d\'accès.');
    LS.set('grimoire.gh', { repo, token }); location.reload();
  });
  $('#importFile').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importFiles(f); });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.pop')) closePops(); });

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if (isPhone()) setView('notes'); qEl.focus(); qEl.select(); }
    else if (mod && e.key.toLowerCase() === 'e' && S.notes.has(S.active) && S.view !== 'graphe') { e.preventDefault(); setMode(S.mode === 'read' ? 'write' : 'read', true); }
    else if (e.key === 'Escape') closePops();
  });

  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== S.view) setView(h, true); });
  window.addEventListener('resize', debounce(autosize, 120));
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });
  window.addEventListener('pagehide', flushAll);
  setInterval(() => { if (!document.hidden && S.loaded) { paintMeta(); } }, 60000);
  if (document.fonts && document.fonts.ready) {
    Promise.all([document.fonts.load('italic 600 15px "Cormorant Garamond"'), document.fonts.load('500 12px "IBM Plex Mono"')]).catch(() => {}).then(() => { mainWeb.draw(); miniWeb.draw(); });
  }
}

/* ---------- boot ---------- */
async function boot(hot) {
  const ui = LS.get('grimoire.ui') || {};
  boot.saved = { active: (hot && hot.active) || ui.active || null };
  if (ui.gopt) Object.assign(S.gopt, ui.gopt);
  S.mode = (hot && hot.mode) || 'read';
  bindUi();
  const h = location.hash.slice(1);
  setView(['notes', 'page', 'graphe'].includes(h) ? h : (hot && hot.view) || (isPhone() ? 'notes' : ui.view === 'graphe' ? 'graphe' : 'notes'), true);
  paintAll();

  startLocal();
}

const hotApi = window.claude && window.claude.hot;
if (hotApi && hotApi.snapshot) { try { hotApi.snapshot(() => ({ active: S.active, view: S.view, mode: S.mode })); } catch (e) { /* ignoré */ } }
if (hotApi && hotApi.ready) hotApi.ready(d => boot(d || {})); else boot((hotApi && hotApi.data) || {});

})();
