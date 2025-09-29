// theme/src/js/custom/galaxy/grants.js

const API = (location.hostname === 'localhost')
  ? 'http://127.0.0.1:3001/api'
  : '/api';

const state = {
  // raw
  grants: [],            // [{id,title,agency,type,amountAwarded,amountReceived,amountSpent,tags,awardedAt,...}]
  breakdown: null,       // { categories:[{label,value}], total:number } (flexible)
  reports: null,         // { grantId,nextDue,lastSubmitted }
  keywords: [],          // ["nlp","genomics",...]
  // derived
  totals: { totalAwarded: 0, availableBudget: 0 },
  lastAwarded: null      // grant object
};

/** ---------- utils ---------- */
const $ = (sel) => document.querySelector(sel);
const sum = (arr) => arr.reduce((a,b)=>a+(Number(b)||0),0);
const fmtMoney = (n) => (n==null ? '—' :
  n.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 }));

function byDateDesc(a,b){
  const da = new Date(a?.awardedAt || a?.date || 0).getTime();
  const db = new Date(b?.awardedAt || b?.date || 0).getTime();
  return db - da;
}

async function fetchJSON(url, opts){
  const r = await fetch(url, opts);
  if(!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

/** ---------- derive helpers ---------- */
function deriveTotals(grants){
  const totalAwarded = sum(grants.map(g=>g.amountAwarded||g.amount||0));
  const totalReceived = sum(grants.map(g=>g.amountReceived||0));
  const totalSpent    = sum(grants.map(g=>g.amountSpent||0));
  const availableBudget = Math.max(totalReceived - totalSpent, 0);
  return { totalAwarded, availableBudget };
}

function pickLastAwarded(grants){
  if(!grants?.length) return null;
  const sorted = [...grants].sort(byDateDesc);
  return sorted[0];
}

function deriveKeywords(grants){
  const set = new Set();
  (grants||[]).forEach(g=>{
    (g.tags||g.keywords||[]).forEach(t=>set.add(t));
  });
  return [...set].slice(0, 20);
}

/** ---------- data loading ---------- */
async function loadFromAPI(){
  // Expected (but optional) endpoints:
  //   GET /api/grants                 -> { grants:[...] }
  //   GET /api/grants/summary         -> { totalAwarded, availableBudget, lastAwarded:{...}? }
  //   GET /api/grants/breakdown       -> { categories:[{label,value}], total:number } (or any shape you like)
  //   GET /api/grants/reports         -> { grantId,nextDue,lastSubmitted }
  //   GET /api/grants/keywords        -> { keywords:[...] }
  const [grantsP, summaryP, breakdownP, reportsP, keywordsP] = await Promise.allSettled([
    fetchJSON(`${API}/grants`),
    fetchJSON(`${API}/grants/summary`),
    fetchJSON(`${API}/grants/breakdown`),
    fetchJSON(`${API}/grants/reports`),
    fetchJSON(`${API}/grants/keywords`)
  ]);

  const grants = grantsP.status==='fulfilled'
    ? (grantsP.value.grants || grantsP.value || [])
    : [];

  const summary = summaryP.status==='fulfilled' ? summaryP.value : null;
  const totals = summary?.totalAwarded!=null && summary?.availableBudget!=null
    ? { totalAwarded: summary.totalAwarded, availableBudget: summary.availableBudget }
    : deriveTotals(grants);
  const lastAwarded = summary?.lastAwarded || pickLastAwarded(grants);

  const breakdown = breakdownP.status==='fulfilled' ? (breakdownP.value || null) : null;
  const reports   = reportsP.status==='fulfilled'   ? (reportsP.value || null)   : null;
  const keywords  = keywordsP.status==='fulfilled'
    ? (keywordsP.value.keywords || keywordsP.value || [])
    : deriveKeywords(grants);

  return { grants, totals, lastAwarded, breakdown, reports, keywords };
}

async function loadFromStatic(){
  // Fallback seed at theme/dist/data/grants.json (copy from src/data via CopyWebpackPlugin)
  const data = await fetchJSON('data/grants.json').catch(()=> ({}));
  const grants     = data.grants || data || [];
  const totals     = data.totals || deriveTotals(grants);
  const lastAwarded= data.lastAwarded || pickLastAwarded(grants);
  const breakdown  = data.breakdown || null;
  const reports    = data.reports || null;
  const keywords   = data.keywords || deriveKeywords(grants);
  return { grants, totals, lastAwarded, breakdown, reports, keywords };
}

async function loadAll(){
  try {
    const d = await loadFromAPI();
    Object.assign(state, d);
    return;
  } catch(e){
    console.warn('[grants] API failed, using static:', e);
  }
  try {
    const d = await loadFromStatic();
    Object.assign(state, d);
  } catch(e){
    console.error('[grants] No data available:', e);
  }
}

/** ---------- renderers ---------- */

// Stat tiles
function renderTotals(){
  const totalEl = document.getElementById('total_grants_awarded');
  const availEl = document.getElementById('available_budget');
  if (totalEl) totalEl.textContent = fmtMoney(state.totals.totalAwarded);
  if (availEl) availEl.textContent = fmtMoney(state.totals.availableBudget);
}

// Last Awarded Grant card
function renderLastAwarded(){
  const ul = document.getElementById('last_awarded_grant');
  if(!ul) return;
  ul.innerHTML = '';

  const g = state.lastAwarded;
  if(!g){
    ul.innerHTML = `<li class="text-gray-400">—</li>`;
    return;
  }

  const rows = [
    ['Title', g.title],
    ['Grant ID', g.id || g.grantId],
    ['Agency', g.agency],
    ['Type', g.type],
    ['Duration', g.duration],
    ['Amount Awarded', fmtMoney(g.amountAwarded || g.amount)],
    ['Amount Received', fmtMoney(g.amountReceived)],
    ['Amount Spent', fmtMoney(g.amountSpent)],
    ['Tags', (g.tags||g.keywords||[]).map(t=>`<span class="badge bg-secondary me-1 mb-1">${t}</span>`).join(' ')]
  ];

  rows.forEach(([k,v])=>{
    const li = document.createElement('li');
    li.innerHTML = `<strong>${k}:</strong> ${v!=null && v!=='' ? v : '—'}`;
    ul.appendChild(li);
  });
}

// Breakdown card
function renderBreakdown(){
  const wrap = document.getElementById('breakdown');
  if(!wrap) return;
  wrap.innerHTML = '';

  const b = state.breakdown;
  if(!b || !Array.isArray(b.categories) || !b.categories.length){
    wrap.textContent = '—';
    return;
  }

  // Simple text bars (no external chart lib)
  const total = b.total || sum(b.categories.map(c=>Number(c.value)||0)) || 1;
  b.categories.forEach(cat=>{
    const pct = Math.round((Number(cat.value||0)/total)*100);
    const row = document.createElement('div');
    row.className = 'mb-3';
    row.innerHTML = `
      <div class="d-flex justify-content-between">
        <span class="text-gray-300">${cat.label}</span>
        <span class="text-gray-300">${fmtMoney(cat.value)} · ${pct}%</span>
      </div>
      <div class="h-6px bg-light rounded">
        <div class="h-6px bg-primary rounded" style="width:${pct}%"></div>
      </div>
    `;
    wrap.appendChild(row);
  });
}

// Reports card
function renderReports(){
  const gid = document.getElementById('reports_grant_id');
  const due = document.getElementById('reports_next_due');
  const last= document.getElementById('reports_last_submitted');

  const r = state.reports || {};
  if (gid)  gid.textContent  = r.grantId ? String(r.grantId) : '—';
  if (due)  due.textContent  = r.nextDue || '—';
  if (last) last.textContent = r.lastSubmitted || '—';
}

// Keywords card
function renderKeywords(){
  const wrap = document.getElementById('keywords_section');
  if(!wrap) return;
  wrap.innerHTML = '';

  if(!state.keywords?.length){
    const badge = document.createElement('span');
    badge.className = 'badge bg-secondary';
    badge.textContent = '—';
    wrap.appendChild(badge);
    return;
  }

  state.keywords.forEach(k=>{
    const badge = document.createElement('span');
    badge.className = 'badge bg-secondary';
    badge.textContent = k;
    wrap.appendChild(badge);
  });
}

function renderAll(){
  renderTotals();
  renderLastAwarded();
  renderBreakdown();
  renderReports();
  renderKeywords();
}

/** ---------- boot ---------- */
document.addEventListener('DOMContentLoaded', async ()=>{
  await loadAll();
  renderAll();
});
