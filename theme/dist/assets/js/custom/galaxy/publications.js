// theme/src/js/custom/galaxy/publications.js
// Load data for the Publications page and render the four boxes:
// - Publications (list)
// - Metrics (totals, h-index, etc.)
// - Top-Cited (top N by citations)
// - Research Topics (tags)

const API = (location.hostname === 'localhost')
  ? 'http://127.0.0.1:3001/api'
  : '/api';

const state = {
  publications: [],
  metrics: null,
  topCited: [],
  topics: []
};

// ---------- utils ----------
const $ = (sel) => document.querySelector(sel);
function createEl(tag, opts = {}) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.html != null) el.innerHTML = opts.html;
  if (opts.attrs) Object.entries(opts.attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const by = (k, dir = 'desc') => (a, b) => {
  const d = ((a?.[k] ?? 0) - (b?.[k] ?? 0));
  return dir === 'asc' ? d : -d;
};
function uniq(arr) {
  return [...new Set(arr)];
}

// h-index from citations array
function computeHIndex(citationsArr) {
  const sorted = [...citationsArr].sort((a, b) => b - a);
  let h = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] >= i + 1) h = i + 1;
    else break;
  }
  return h;
}

// client-side metrics fallback if API doesn’t provide
function computeMetricsFromPublications(pubs) {
  const cites = pubs.map(p => Number(p.citations || 0));
  const totalPubs = pubs.length;
  const totalCites = sum(cites);
  const avgCites = totalPubs ? Math.round((totalCites / totalPubs) * 10) / 10 : 0;
  const hIndex = computeHIndex(cites);
  const i10 = pubs.filter(p => Number(p.citations || 0) >= 10).length;
  return { totalPubs, totalCites, avgCites, hIndex, i10 };
}

// ---------- data loading ----------
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function loadFromAPI() {
  // Expect (but don’t require) these endpoints:
  //   GET /api/publications            -> { publications: [...] }
  //   GET /api/publications/metrics    -> { totalPubs, totalCites, avgCites, hIndex, i10 }
  //   GET /api/publications/top-cited  -> [{...}]
  //   GET /api/publications/topics     -> ["NLP","Vision",...]
  const [pubsPayload, metricsPayload, topPayload, topicsPayload] = await Promise.allSettled([
    fetchJSON(`${API}/publications`),
    fetchJSON(`${API}/publications/metrics`),
    fetchJSON(`${API}/publications/top-cited`),
    fetchJSON(`${API}/publications/topics`)
  ]);

  const pubs = pubsPayload.status === 'fulfilled'
    ? (pubsPayload.value.publications || pubsPayload.value || [])
    : [];

  const metrics = metricsPayload.status === 'fulfilled'
    ? metricsPayload.value
    : computeMetricsFromPublications(pubs);

  const topCited = topPayload.status === 'fulfilled'
    ? (topPayload.value.topCited || topPayload.value || [])
    : [...pubs].sort(by('citations', 'desc')).slice(0, 5);

  const topics = topicsPayload.status === 'fulfilled'
    ? (topicsPayload.value.topics || topicsPayload.value || [])
    : deriveTopics(pubs);

  return { pubs, metrics, topCited, topics };
}

async function loadFromStatic() {
  // Fallback JSON (put your seed data here if you want): theme/dist/data/publications.json
  // The CopyWebpackPlugin can copy theme/src/data/publications.json -> theme/dist/data/publications.json
  const data = await fetchJSON('data/publications.json').catch(() => ({}));

  const pubs = data.publications || data || [];
  const metrics = data.metrics || computeMetricsFromPublications(pubs);
  const topCited = data.topCited || [...pubs].sort(by('citations', 'desc')).slice(0, 5);
  const topics = data.topics || deriveTopics(pubs);

  return { pubs, metrics, topCited, topics };
}

// derive topics quickly if none provided
function deriveTopics(pubs) {
  const all = pubs.flatMap(p => (p.tags || p.topics || []));
  return uniq(all).slice(0, 12);
}

async function loadAll() {
  // Try API → fallback to static
  try {
    const { pubs, metrics, topCited, topics } = await loadFromAPI();
    state.publications = pubs;
    state.metrics = metrics;
    state.topCited = topCited;
    state.topics = topics;
    return;
  } catch (e) {
    console.warn('[publications] API failed, falling back to static', e);
  }
  try {
    const { pubs, metrics, topCited, topics } = await loadFromStatic();
    state.publications = pubs;
    state.metrics = metrics;
    state.topCited = topCited;
    state.topics = topics;
  } catch (e) {
    console.error('[publications] No data available', e);
  }
}

// ---------- renderers ----------
function renderPublicationsList() {
  const container = $('#publications_list');
  if (!container) return;

  container.innerHTML = '';

  if (!state.publications?.length) {
    const empty = createEl('div', { class: 'text-gray-400', text: '—' });
    container.appendChild(empty);
    return;
  }

  state.publications.forEach((p, idx) => {
    const wrap = createEl('div', { class: 'border-top border-gray-300 border-opacity-10 pt-4' });

    const title = createEl('div', { class: 'fw-semibold' });
    if (p.url || p.doi) {
      const a = createEl('a', {
        class: 'text-white text-hover-primary',
        text: p.title || 'Untitled'
      });
      a.href = p.url || (p.doi ? `https://doi.org/${p.doi}` : '#');
      a.target = '_blank';
      title.appendChild(a);
    } else {
      title.textContent = p.title || 'Untitled';
    }

    const meta = createEl('div', { class: 'text-gray-400 fs-8 mt-1' });
    const authors = Array.isArray(p.authors) ? p.authors.join(', ') : (p.authors || '—');
    const venue = p.journal || p.venue || p.conference || '';
    const year = p.year || '';
    meta.textContent = [authors, venue, year].filter(Boolean).join(' • ');

    const row = createEl('div', { class: 'd-flex align-items-center justify-content-between mt-2' });

    // left: tags
    const tagsWrap = createEl('div', { class: 'd-flex flex-wrap gap-2' });
    const tags = p.tags || p.topics || [];
    tags.forEach(t => {
      const b = createEl('span', { class: 'badge bg-secondary bg-opacity-25 text-gray-200', text: t });
      tagsWrap.appendChild(b);
    });

    // right: citations (if available)
    const cites = Number(p.citations || 0);
    const citeBadge = createEl('span', {
      class: 'badge badge-light-primary',
      text: cites ? `${cites} citations` : '—'
    });

    row.appendChild(tagsWrap);
    row.appendChild(citeBadge);

    wrap.appendChild(title);
    wrap.appendChild(meta);
    wrap.appendChild(row);

    container.appendChild(wrap);
  });
}

function renderMetrics() {
  const m = state.metrics || {};
  const id = (x) => document.getElementById(x);

  const mappings = [
    ['m_totalPubs', m.totalPubs ?? 0],
    ['m_totalCites', m.totalCites ?? 0],
    ['m_avgCites', m.avgCites ?? 0],
    ['m_hIndex', m.hIndex ?? 0],
    ['m_i10Index', m.i10Index ?? 0]
  ];

  mappings.forEach(([key, val]) => {
    const el = id(key);
    if (el) el.textContent = String(val);
  });
}

function renderTopCited() {
  const ul = $('#top_cited_list');
  if (!ul) return;

  ul.innerHTML = '';
  const items = state.topCited?.length ? state.topCited : [];

  if (!items.length) {
    ul.appendChild(createEl('li', { class: 'text-gray-400', text: '—' }));
    return;
  }

  items.slice(0, 5).forEach(p => {
    const li = createEl('li');
    const a = createEl('a', {
      class: 'text-white text-hover-primary',
      text: p.title || 'Untitled'
    });
    a.href = p.url || (p.doi ? `https://doi.org/${p.doi}` : '#');
    a.target = '_blank';

    const meta = createEl('div', { class: 'text-gray-400 fs-8' });
    const authors = Array.isArray(p.authors) ? p.authors.join(', ') : (p.authors || '');
    const year = p.year || '';
    meta.textContent = [authors, year].filter(Boolean).join(' • ');

    const cites = createEl('span', {
      class: 'badge badge-light-primary ms-2',
      text: `${Number(p.citations || 0)} cites`
    });

    li.appendChild(a);
    li.appendChild(cites);
    li.appendChild(meta);
    ul.appendChild(li);
  });
}

function renderTopics() {
  const wrap = $('#research_topics_tags');
  if (!wrap) return;
  wrap.innerHTML = '';

  if (!state.topics?.length) {
    wrap.appendChild(createEl('span', { class: 'badge badge-light text-gray-500', text: '—' }));
    return;
  }

  state.topics.forEach(t => {
    wrap.appendChild(createEl('span', { class: 'badge badge-light', text: t }));
  });
}

function renderAll() {
  renderPublicationsList();
  renderMetrics();
  renderTopCited();
  renderTopics();
}

// ---------- optional: editor wiring (keep hidden by default) ----------
function wireEditorAdd() {
  const addBtn = document.getElementById('pub_add_btn');
  if (!addBtn) return;

  addBtn.addEventListener('click', () => {
    const pub = {
      title: $('#pub_title')?.value?.trim(),
      authors: $('#pub_authors')?.value?.split(',').map(s => s.trim()).filter(Boolean) || [],
      journal: $('#pub_journal')?.value?.trim(),
      year: Number($('#pub_year')?.value?.trim() || 0) || undefined,
      tags: $('#pub_tags')?.value?.split(',').map(s => s.trim()).filter(Boolean) || [],
      doi: $('#pub_doi')?.value?.trim(),
      url: $('#pub_pdf')?.value?.trim() || undefined, // treat as link for now
      status: $('#pub_status')?.value?.trim() || undefined,
      citations: Number($('#pub_citations')?.value?.trim() || 0) || 0
    };

    // naive validation
    if (!pub.title) return;

    state.publications.unshift(pub);
    // recompute derived bits
    state.metrics = computeMetricsFromPublications(state.publications);
    state.topCited = [...state.publications].sort(by('citations', 'desc')).slice(0, 5);
    state.topics = deriveTopics(state.publications);

    renderAll();
    // clear fields
    ['pub_title','pub_authors','pub_journal','pub_year','pub_tags','pub_doi','pub_pdf','pub_status','pub_citations']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  });
}

// ---------- boot ----------
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  renderAll();
  wireEditorAdd();
});
