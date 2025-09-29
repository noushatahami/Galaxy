// theme/src/js/custom/galaxy/projects.js
// Renders: Total Impact Points, Total Budget, Projects, Project Snapshot,
// Latest Activity, Messages, Next Deadline. Tries API first, falls back to static.

const API = (location.hostname === 'localhost')
  ? 'http://127.0.0.1:3001/api'
  : '/api';

const state = {
  summary: { impactTotal: 0, impactChange: '', impactNote: '', budgetAmount: 0, budgetChange: '', budgetNote: '' },
  projects: [],          // [{id,title,status,tags,owner,progress,days,desc,...}]
  counts: { active: 0, on_hold: 0, stopped: 0 },
  snapshot: null,        // { title, status, days, desc, tags[], donutPercent, members[] }
  latest: [],            // [{user,name,avatar,what,when}]
  messages: [],          // [{from, avatar, text, when}]
  nextDeadline: null     // { label, date }
};

/* ---------------- utils ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const sum = (a) => a.reduce((x,y)=>x+y,0);
const fmtMoney = (n) => (n==null ? '—' : n.toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:0}));

const STATUS_COLORS = {
  Active:  '#20E3B2',   // emerald
  'On Hold': '#F5A623', // amber
  Stopped: '#A0A0A0'    // gray
};

/* ---------------- derives ---------------- */
function deriveCounts(projects){
  const c = { active:0, on_hold:0, stopped:0 };
  (projects||[]).forEach(p=>{
    const s = (p.status||'').toLowerCase();
    if (s === 'active') c.active++;
    else if (s === 'on hold' || s === 'on_hold') c.on_hold++;
    else c.stopped++;
  });
  return c;
}

function defaultSnapshot(projects){
  if (!projects?.length) return {
    title:'—', status:'Active', days:0, desc:'—', tags:[], donutPercent:0, members:[]
  };
  const p = [...projects].sort((a,b)=>(b?.progress||0)-(a?.progress||0))[0];
  return {
    title: p.title || '—',
    status: p.status || 'Active',
    days: p.days || 0,
    desc: p.desc || p.description || '—',
    tags: p.tags || [],
    donutPercent: Math.max(0, Math.min(100, Number(p.progress||0))),
    members: p.members || []
  };
}

/* ---------------- data loading ---------------- */
async function fetchJSON(url, opts){
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function loadFromAPI(){
  // Optional endpoints your API can expose:
  // GET /api/projects                -> { projects:[...] , summary? }
  // GET /api/projects/summary        -> { impactTotal, impactChange, impactNote, budgetAmount, budgetChange, budgetNote }
  // GET /api/projects/snapshot       -> { ...snapshot }
  // GET /api/projects/latest         -> { items:[...] }
  // GET /api/projects/messages       -> { items:[...] }
  // GET /api/projects/next-deadline  -> { label, date }
  const [projectsP, summaryP, snapshotP, latestP, messagesP, deadlineP] = await Promise.allSettled([
    fetchJSON(`${API}/projects`),
    fetchJSON(`${API}/projects/summary`),
    fetchJSON(`${API}/projects/snapshot`),
    fetchJSON(`${API}/projects/latest`),
    fetchJSON(`${API}/projects/messages`),
    fetchJSON(`${API}/projects/next-deadline`)
  ]);

  const projects = projectsP.status==='fulfilled'
    ? (projectsP.value.projects || projectsP.value || [])
    : [];

  const summary = summaryP.status==='fulfilled'
    ? (summaryP.value || {})
    : (projectsP.status==='fulfilled' && projectsP.value.summary) ? projectsP.value.summary : {};

  const snapshot = snapshotP.status==='fulfilled'
    ? (snapshotP.value || null)
    : defaultSnapshot(projects);

  const latest    = latestP.status==='fulfilled'   ? (latestP.value.items || latestP.value || []) : [];
  const messages  = messagesP.status==='fulfilled' ? (messagesP.value.items || messagesP.value || []) : [];
  const nextDeadline = deadlineP.status==='fulfilled' ? (deadlineP.value || null) : null;

  return { projects, summary, snapshot, latest, messages, nextDeadline };
}

async function loadFromStatic(){
  // Place seed at: theme/src/data/projects.json → copied to theme/dist/data/projects.json
  const data = await fetchJSON('data/projects.json').catch(() => ({}));

  const projects = data.projects || [];
  const summary = data.summary || {};
  const snapshot = data.snapshot || defaultSnapshot(projects);
  const latest = data.latest || [];
  const messages = data.messages || [];
  const nextDeadline = data.nextDeadline || null;

  return { projects, summary, snapshot, latest, messages, nextDeadline };
}

async function loadAll(){
  try {
    const d = await loadFromAPI();
    Object.assign(state, d);
  } catch(e){
    console.warn('[projects] API failed, using static', e);
    const d = await loadFromStatic();
    Object.assign(state, d);
  }
  state.counts = deriveCounts(state.projects);
}

/* ---------------- renderers ---------------- */
function renderSummary(){
  const s = state.summary || {};
  const impactTotal = document.getElementById('impact_total');
  const impactChange = document.getElementById('impact_change');
  const impactNote = document.getElementById('impact_note');

  const budgetAmount = document.getElementById('budget_amount');
  const budgetChange = document.getElementById('budget_change');
  const budgetNote = document.getElementById('budget_note');

  if (impactTotal)  impactTotal.textContent  = String(s.impactTotal ?? '—');
  if (impactChange) impactChange.textContent = s.impactChange || '';
  if (impactNote)   impactNote.textContent   = s.impactNote || '';

  if (budgetAmount) budgetAmount.textContent = fmtMoney(s.budgetAmount ?? 0);
  if (budgetChange) budgetChange.textContent = s.budgetChange || '';
  if (budgetNote)   budgetNote.textContent   = s.budgetNote || '';
}

function renderProjectsList(){
  const wrap = document.getElementById('projects_list');
  if (!wrap) return;
  wrap.innerHTML = '';

  // legend counts
  const elActive = document.getElementById('count_active');
  const elHold   = document.getElementById('count_on_hold');
  const elStop   = document.getElementById('count_stopped');
  if (elActive) elActive.textContent = `(${state.counts.active})`;
  if (elHold)   elHold.textContent   = `(${state.counts.on_hold})`;
  if (elStop)   elStop.textContent   = `(${state.counts.stopped})`;

  if (!state.projects?.length){
    wrap.innerHTML = `<div class="text-gray-400">—</div>`;
    return;
  }

  state.projects.forEach(p=>{
    const col = document.createElement('div');
    col.className = 'col-sm-6';

    const card = document.createElement('div');
    card.className = 'px-3 py-2 rounded bg-body-secondary d-flex align-items-center justify-content-between';

    const left = document.createElement('div');
    left.className = 'd-flex align-items-center gap-2';

    const dot = document.createElement('span');
    dot.textContent = '●';
    dot.style.color = STATUS_COLORS[p.status] || '#A0A0A0';

    const title = document.createElement('span');
    title.className = 'fw-semibold';
    title.textContent = p.title || 'Untitled';

    left.appendChild(dot);
    left.appendChild(title);

    const right = document.createElement('span');
    right.className = 'badge badge-light-primary';
    const pct = Number(p.progress || 0);
    right.textContent = isFinite(pct) ? `${pct}%` : '—';

    card.appendChild(left);
    card.appendChild(right);
    col.appendChild(card);
    wrap.appendChild(col);
  });
}

function renderSnapshot(){
  const s = state.snapshot || defaultSnapshot(state.projects);

  const statusDot = document.getElementById('snapshot_status_dot');
  const statusTxt = document.getElementById('snapshot_status');
  const days      = document.getElementById('snapshot_days');
  const title     = document.getElementById('snapshot_title');
  const desc      = document.getElementById('snapshot_desc');
  const tagsWrap  = document.getElementById('snapshot_tags');
  const donut     = document.getElementById('snapshot_donut');

  if (statusDot) statusDot.style.color = STATUS_COLORS[s.status] || '#A0A0A0';
  if (statusTxt) statusTxt.textContent = s.status || '—';
  if (days)      days.textContent      = String(s.days ?? 0);
  if (title)     title.textContent     = s.title || '—';
  if (desc)      desc.textContent      = s.desc || '—';

  if (tagsWrap) {
    tagsWrap.innerHTML = '';
    (s.tags || []).forEach(t=>{
      const pill = document.createElement('span');
      pill.className = 'badge badge-light';
      pill.textContent = t;
      tagsWrap.appendChild(pill);
    });
    if (!(s.tags||[]).length){
      const m = document.createElement('span');
      m.className = 'text-gray-400';
      m.textContent = '—';
      tagsWrap.appendChild(m);
    }
  }

  if (donut) donut.textContent = isFinite(s.donutPercent) ? `${Math.round(s.donutPercent)}%` : '—';
}

function renderLatest(){
  const list = document.getElementById('latest_activity_list');
  if (!list) return;
  list.innerHTML = '';

  if (!state.latest?.length){
    list.innerHTML = `<div class="text-gray-400">—</div>`;
    return;
  }

  state.latest.forEach(item=>{
    const row = document.createElement('div');
    row.className = 'd-flex align-items-center justify-content-between';

    const left = document.createElement('div');
    left.className = 'd-flex align-items-center gap-3';

    const sym = document.createElement('div');
    sym.className = 'symbol symbol-35px';
    const img = document.createElement('img');
    img.src = item.avatar || 'assets/media/avatars/blank.png';
    img.alt = '';
    sym.appendChild(img);

    const meta = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'fw-semibold';
    name.textContent = item.name || item.user || '—';

    const what = document.createElement('div');
    what.className = 'text-gray-300 fs-8';
    what.textContent = item.what || '';

    meta.appendChild(name);
    meta.appendChild(what);

    left.appendChild(sym);
    left.appendChild(meta);

    const when = document.createElement('span');
    when.className = 'text-gray-500 fs-8';
    when.textContent = item.when || '';

    row.appendChild(left);
    row.appendChild(when);
    list.appendChild(row);
  });
}

function renderMessages(){
  const first = document.getElementById('messages_first');
  if (!first) return;
  first.innerHTML = '';

  if (!state.messages?.length){
    first.innerHTML = `<div class="text-gray-400">—</div>`;
    return;
  }

  const m = state.messages[0];
  const box = document.createElement('div');
  box.className = 'd-flex align-items-start gap-3';

  const sym = document.createElement('div');
  sym.className = 'symbol symbol-35px';
  const img = document.createElement('img');
  img.src = m.avatar || 'assets/media/avatars/blank.png';
  img.alt = '';
  sym.appendChild(img);

  const body = document.createElement('div');
  const who = document.createElement('div');
  who.className = 'fw-semibold';
  who.textContent = m.from || '—';
  const text = document.createElement('div');
  text.className = 'text-gray-300';
  text.textContent = m.text || '—';
  const when = document.createElement('div');
  when.className = 'text-gray-500 fs-8';
  when.textContent = m.when || '';

  body.appendChild(who);
  body.appendChild(text);
  body.appendChild(when);

  box.appendChild(sym);
  box.appendChild(body);
  first.appendChild(box);
}

function renderDeadline(){
  const label = document.getElementById('deadline_label');
  const date  = document.getElementById('deadline_date');

  const d = state.nextDeadline || {};
  if (label) label.textContent = d.label || '—';
  if (date)  date.textContent  = d.date  || '—';
}

function renderAll(){
  renderSummary();
  renderProjectsList();
  renderSnapshot();
  renderLatest();
  renderMessages();
  renderDeadline();
}

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  renderAll();
});
