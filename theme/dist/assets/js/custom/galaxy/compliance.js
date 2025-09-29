// theme/src/js/custom/galaxy/compliance.js
// Renders: Compliance Checkpoints, Recent Audits & Reviews, Compliance Notes,
//          Compliance Summary, Quick Actions, Key Contacts.
// Tries your API first, falls back to static JSON.

const API = (location.hostname === 'localhost')
  ? 'http://127.0.0.1:3001/api'
  : '/api';

const state = {
  checkpoints: [],     // [{id,title,status,lastReviewed,link}]
  audits: [],          // [{id,name,date,score,tags:[]}]
  notes: [],           // ["text", ...] or [{text, date}]
  summary: { compliant:0, pending:0, noncompliant:0 },
  quickActions: [],    // ["Upload SOC2 evidence", ...] or [{label, href}]
  contacts: []         // [{name, role, avatar}]
};

/* ---------- utils ---------- */
const $ = (s) => document.querySelector(s);
function el(tag, opts = {}) {
  const e = document.createElement(tag);
  if (opts.class) e.className = opts.class;
  if (opts.text != null) e.textContent = opts.text;
  if (opts.html != null) e.innerHTML = opts.html;
  if (opts.attrs) Object.entries(opts.attrs).forEach(([k,v]) => e.setAttribute(k, v));
  return e;
}
async function fetchJSON(url, opts){
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
function fmtDate(d){
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString();
}

/* ---------- data loading ---------- */
async function loadFromAPI(){
  // Supported (but optional) endpoints:
  // GET /api/compliance                    -> { checkpoints, audits, notes, summary, quickActions, contacts }
  // GET /api/compliance/checkpoints        -> { items:[...] } or [...]
  // GET /api/compliance/audits             -> { items:[...] } or [...]
  // GET /api/compliance/notes              -> { items:[...] } or [...]
  // GET /api/compliance/summary            -> { compliant, pending, noncompliant }
  // GET /api/compliance/quick-actions      -> { items:[...] } or [...]
  // GET /api/compliance/contacts           -> { items:[...] } or [...]
  const [rootP, cpsP, audP, notesP, sumP, qaP, kcP] = await Promise.allSettled([
    fetchJSON(`${API}/compliance`),
    fetchJSON(`${API}/compliance/checkpoints`),
    fetchJSON(`${API}/compliance/audits`),
    fetchJSON(`${API}/compliance/notes`),
    fetchJSON(`${API}/compliance/summary`),
    fetchJSON(`${API}/compliance/quick-actions`),
    fetchJSON(`${API}/compliance/contacts`)
  ]);

  const root = rootP.status === 'fulfilled' ? rootP.value : {};

  // Prefer specific endpoints, else fall back to root payload fields, else empty
  const checkpoints = cpsP.status==='fulfilled'
    ? (cpsP.value.items || cpsP.value || [])
    : (root.checkpoints || []);

  const audits = audP.status==='fulfilled'
    ? (audP.value.items || audP.value || [])
    : (root.audits || []);

  const notes = notesP.status==='fulfilled'
    ? (notesP.value.items || notesP.value || [])
    : (root.notes || []);

  const summary = sumP.status==='fulfilled'
    ? (sumP.value || {})
    : (root.summary || {});

  const quickActions = qaP.status==='fulfilled'
    ? (qaP.value.items || qaP.value || [])
    : (root.quickActions || []);

  const contacts = kcP.status==='fulfilled'
    ? (kcP.value.items || kcP.value || [])
    : (root.contacts || []);

  return { checkpoints, audits, notes, summary, quickActions, contacts };
}

async function loadFromStatic(){
  // Seed file: theme/src/data/compliance.json → copied to theme/dist/data/compliance.json
  const data = await fetchJSON('data/compliance.json').catch(()=> ({}));
  return {
    checkpoints: data.checkpoints || [],
    audits: data.audits || [],
    notes: data.notes || [],
    summary: data.summary || { compliant:0, pending:0, noncompliant:0 },
    quickActions: data.quickActions || [],
    contacts: data.contacts || []
  };
}

async function loadAll(){
  try {
    Object.assign(state, await loadFromAPI());
    return;
  } catch (e){
    console.warn('[compliance] API failed, using static:', e);
  }
  try {
    Object.assign(state, await loadFromStatic());
  } catch (e){
    console.error('[compliance] No data available:', e);
  }
}

/* ---------- renderers ---------- */
function renderCheckpoints(){
  const wrap = $('#checkpoints_list');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (!state.checkpoints?.length){
    wrap.appendChild(el('div', { class:'text-gray-400', text:'—' }));
    return;
  }

  state.checkpoints.forEach(cp=>{
    const box = el('div', { class:'rounded border border-white/10 p-3 bg-white/5' });
    const row = el('div', { class:'d-flex align-items-center justify-content-between' });

    const left = el('div', { class:'fw-semibold' });
    left.innerHTML = `${cp.title || '—'} ${cp.status ? `<span class="ms-2">${cp.status === 'pass' || cp.status === 'compliant' ? '✅' : '⏳'}</span>` : ''}`;

    const btn = el('a', {
      class:'btn btn-sm btn-light',
      text:'View Details',
      attrs: { href: cp.link || '#', target: cp.link ? '_blank' : '_self' }
    });

    row.appendChild(left);
    row.appendChild(btn);
    box.appendChild(row);
    box.appendChild(el('div', { class:'text-gray-400 fs-8 mt-1', text:`Last Reviewed: ${fmtDate(cp.lastReviewed)}` }));
    wrap.appendChild(box);
  });
}

function renderAudits(){
  const wrap = $('#audits_list');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (!state.audits?.length){
    wrap.appendChild(el('div', { class:'text-gray-400', text:'—' }));
    return;
  }

  state.audits.forEach(a=>{
    const box = el('div', { class:'ps-3 border-start border-3 border-secondary' });
    box.appendChild(el('div', { class:'fw-semibold', text: a.name || 'Audit' }));
    box.appendChild(el('div', {
      class:'text-gray-400 fs-8',
      text: `Date: ${fmtDate(a.date)}  |  Score: ${a.score ?? '—'}`
    }));
    const tags = Array.isArray(a.tags) ? a.tags : [];
    if (tags.length){
      const t = el('div', { class:'text-gray-500 fs-8 mt-1' });
      t.textContent = `Tags: ${tags.join(', ')}`;
      box.appendChild(t);
    }
    wrap.appendChild(box);
  });
}

function renderNotes(){
  const wrap = $('#notes_list');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (!state.notes?.length){
    wrap.appendChild(el('div', { class:'text-gray-400', text:'—' }));
    return;
  }

  state.notes.forEach(n=>{
    const text = typeof n === 'string' ? n : (n.text || '—');
    const row = el('div', { class:'text-gray-200' });
    row.textContent = text;
    wrap.appendChild(row);
  });
}

function renderSummary(){
  const s = state.summary || {};
  const c = document.getElementById('summary_compliant');
  const p = document.getElementById('summary_pending');
  const n = document.getElementById('summary_noncompliant');
  if (c) c.textContent = String(s.compliant ?? 0);
  if (p) p.textContent = String(s.pending ?? 0);
  if (n) n.textContent = String(s.noncompliant ?? 0);
}

function renderQuickActions(){
  const wrap = $('#quick_actions_list');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (!state.quickActions?.length){
    wrap.appendChild(el('div', { class:'text-gray-400', text:'—' }));
    return;
  }

  state.quickActions.forEach(a=>{
    const label = typeof a === 'string' ? a : (a.label || 'Action');
    const href  = typeof a === 'object' ? a.href : null;
    const btn = el(href ? 'a' : 'button', {
      class: 'text-start px-3 py-2 rounded bg-white/10 border border-white/10',
      text: label,
      attrs: href ? { href, target: '_blank' } : {}
    });
    wrap.appendChild(btn);
  });
}

function renderContacts(){
  const wrap = $('#key_contacts_list');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (!state.contacts?.length){
    wrap.appendChild(el('div', { class:'text-gray-400', text:'—' }));
    return;
  }

  state.contacts.forEach(c=>{
    const row = el('div', { class:'d-flex align-items-center gap-3' });
    const sym = el('div', { class:'symbol symbol-40px' });
    const img = el('img', { attrs:{ src: c.avatar || 'assets/media/avatars/blank.png', alt:'', class:'rounded-circle' } });
    sym.appendChild(img);

    const meta = el('div', { class:'lh-sm' });
    meta.appendChild(el('div', { class:'fw-semibold', text: c.name || '—' }));
    meta.appendChild(el('div', { class:'text-gray-400 fs-8', text: c.role || '—' }));

    row.appendChild(sym);
    row.appendChild(meta);
    wrap.appendChild(row);
  });
}

function renderAll(){
  renderCheckpoints();
  renderAudits();
  renderNotes();
  renderSummary();
  renderQuickActions();
  renderContacts();
}

/* ---------- boot ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  renderAll();
});
