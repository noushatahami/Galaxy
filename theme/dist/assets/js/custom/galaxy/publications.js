// theme/src/js/custom/galaxy/publications.js
// Edit-mode with tiny per-card buttons; each card opens ONE modal to edit that box.

(() => {
  /* ---------------- utils ---------------- */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const H  = (t, c='', inner='') => { const n=document.createElement(t); if(c)n.className=c; if(inner!=null)n.innerHTML=inner; return n; };
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  const API = (location.hostname === 'localhost') ? 'http://127.0.0.1:3001/api' : '/api';

  const sum = (arr) => arr.reduce((a,b)=>a+b,0);
  const by  = (k, dir='desc') => (a,b) => dir==='asc' ? ((a?.[k]??0)-(b?.[k]??0)) : ((b?.[k]??0)-(a?.[k]??0));

  function uniq(arr){ return [...new Set(arr)]; }

  function computeHIndex(citationsArr) {
    const s = [...citationsArr].sort((a,b)=>b-a);
    let h=0; for (let i=0;i<s.length;i++){ if (s[i] >= i+1) h=i+1; else break; }
    return h;
  }
  function computeMetricsFromPublications(pubs) {
    const cites = pubs.map(p => Number(p.citations||0));
    const totalPubs = pubs.length;
    const totalCites = sum(cites);
    const avgCites = totalPubs ? Math.round((totalCites/totalPubs)*10)/10 : 0;
    const hIndex = computeHIndex(cites);
    const i10Index = pubs.filter(p => Number(p.citations||0) >= 10).length;
    return { totalPubs, totalCites, avgCites, hIndex, i10Index };
  }
  function deriveTopics(pubs) {
    const all = pubs.flatMap(p => (p.tags || p.topics || []));
    return uniq(all).slice(0, 12);
  }

  async function persistPage(page, data){
    try{
      const isLocal = ['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname);
      const API = isLocal ? 'http://127.0.0.1:3001/api' : '/api';
      await fetch(`${API}/page`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ page, data })
      });
    }catch(e){ console.error('persistPage error:', e); }
  }

  function toPublicationsPayload(){
    return {
      publications: state.publications || [],
      metrics: state.metrics || null,
      topics: state.topics || [],
      topCited: state.topCited || [],
      overrides: state.overrides || {}
    };
  }

  /* ---------------- state & persistence ---------------- */
  let editMode = false;

  const state = {
    publications: [],     // [{title, authors[], journal/year/venue, doi/url, tags[], citations}]
    metrics: null,        // { totalPubs, totalCites, avgCites, hIndex, i10Index }
    topCited: [],         // [{...}] manual override (if empty, we compute)
    topics: [],           // [string]
    overrides: {          // lets user decide whether a box follows auto or manual
      metrics: false,
      topCited: false,
      topics: false
    }
  };

  function save() { localStorage.setItem('galaxy_publications', JSON.stringify(state)); }
  async function load() {
    const local = localStorage.getItem('galaxy_publications');
    if (local) {
      try { Object.assign(state, JSON.parse(local)); return; } catch {}
    }
    // Optional: seed from API/static
    try {
      const r = await fetch(`${API}/publications`); if (r.ok) {
        const payload = await r.json();
        state.publications = payload.publications || payload || [];
      }
    } catch {}
    if (!state.metrics) state.metrics = computeMetricsFromPublications(state.publications);
    if (!state.topics?.length) state.topics = deriveTopics(state.publications);
    if (!state.topCited?.length) state.topCited = [...state.publications].sort(by('citations')).slice(0,5);
  }

  /* ---------------- renderers ---------------- */
  function renderPublicationsList() {
    const container = $('#publications_list'); if (!container) return;
    container.innerHTML = '';

    if (!state.publications?.length) {
      container.innerHTML = '<div class="text-gray-400">—</div>'; return;
    }

    state.publications.forEach(p => {
      const blk = H('div','border-top border-gray-300 border-opacity-10 pt-4','');
      const title = H('div','fw-semibold','');
      if (p.url || p.doi) {
        const a = H('a','text-white text-hover-primary', p.title || 'Untitled');
        a.href = p.url || (p.doi ? `https://doi.org/${p.doi}` : '#'); a.target = '_blank';
        title.appendChild(a);
      } else { title.textContent = p.title || 'Untitled'; }
      const meta = H('div','text-gray-400 fs-8 mt-1','');
      const authors = Array.isArray(p.authors) ? p.authors.join(', ') : (p.authors||'—');
      const venue = p.journal || p.venue || p.conference || '';
      const year  = p.year || '';
      meta.textContent = [authors, venue, year].filter(Boolean).join(' • ');

      const row = H('div','d-flex align-items-center justify-content-between mt-2','');
      const tagsWrap = H('div','d-flex flex-wrap gap-2','');
      const tags = p.tags || p.topics || [];
      tags.forEach(t =>
        tagsWrap.appendChild(
          H('span','badge bg-success bg-opacity-20 text-success', t)
        )
      );
      const cites = H('span','badge badge-light-primary', Number(p.citations||0) ? `${p.citations} citations` : '—');

      row.appendChild(tagsWrap); row.appendChild(cites);
      blk.appendChild(title); blk.appendChild(meta); blk.appendChild(row);
      container.appendChild(blk);
    });
  }

  function renderMetrics() {
    const m = state.overrides.metrics ? (state.metrics||{}) : computeMetricsFromPublications(state.publications);
    const map = [
      ['m_totalPubs',  m.totalPubs ?? 0],
      ['m_totalCites', m.totalCites ?? 0],
      ['m_avgCites',   m.avgCites ?? 0],
      ['m_hIndex',     m.hIndex ?? 0],
      ['m_i10Index',   m.i10Index ?? 0]
    ];
    map.forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.textContent = String(val); });
  }

  function renderTopCited() {
    const ul = $('#top_cited_list'); if (!ul) return;
    let items = state.overrides.topCited && state.topCited?.length
      ? state.topCited
      : [...state.publications].sort(by('citations')).slice(0,5);

    ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = '<li class="text-gray-400">—</li>'; return; }

    items.slice(0,5).forEach(p => {
      const li = H('li','','');
      const a = H('a','text-white text-hover-primary', p.title || 'Untitled');
      a.href = p.url || (p.doi ? `https://doi.org/${p.doi}` : '#'); a.target = '_blank';
      const meta = H('div','text-gray-400 fs-8','');
      const authors = Array.isArray(p.authors) ? p.authors.join(', ') : (p.authors||'');
      meta.textContent = [authors, p.year||''].filter(Boolean).join(' • ');
      const cites = H('span','badge badge-light-primary ms-2', `${Number(p.citations||0)} cites`);
      li.appendChild(a); li.appendChild(cites); li.appendChild(meta);
      ul.appendChild(li);
    });
  }

  function renderTopics() {
    const wrap = $('#research_topics_tags'); if (!wrap) return;
    const items = state.overrides.topics && state.topics?.length ? state.topics : deriveTopics(state.publications);
    wrap.innerHTML = items.length
      ? items.map(t => `<span class="badge bg-success bg-opacity-20 text-success">${t}</span>`).join('')
      : '<span class="badge badge-light text-gray-500">—</span>';
  }

  function renderAll() {
    renderPublicationsList();
    renderMetrics();
    renderTopCited();
    renderTopics();
    reflectEditMode();
  }

  /* ---------------- edit mode buttons ---------------- */
  function reflectEditMode() {
    const t = $('#editToggle'); if (t) t.textContent = editMode ? 'Done' : 'Edit';
    $$('.box-edit-btn').forEach(b => b.classList.toggle('d-none', !editMode));
  }

  function ensureTinyButtons() {
    const cfgs = [
      { anchor:'#publications_list',  build: modalPublications, title:'Edit: Publications' },
      { anchor:'#m_totalPubs',        build: modalMetrics,      title:'Edit: Metrics' },
      { anchor:'#top_cited_list',     build: modalTopCited,     title:'Edit: Top-Cited' },
      { anchor:'#research_topics_tags', build: modalTopics,     title:'Edit: Research Topics' },
    ];
    cfgs.forEach(cfg => {
      const card = document.querySelector(cfg.anchor)?.closest('.card');
      const header = card?.querySelector('.card-header');
      if (!header) return;
      header.querySelectorAll('.box-edit-btn').forEach(b => b.remove());
      let rail = header.querySelector('.card-toolbar'); if (!rail){ rail = H('div','card-toolbar'); header.appendChild(rail); }
      const btn = H('button','btn btn-sm btn-light box-edit-btn d-none','Edit');
      btn.addEventListener('click', () => openModal(cfg.title, ...cfg.build()));
      rail.appendChild(btn);
    });
  }

  /* ---------------- fetch verified pubs form backend ---------------- */
  async function fetchPublicationsAggregate() {
    const isLocal = ['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname);
    const API = isLocal ? 'http://127.0.0.1:3001/api' : '/api';

    const fd = new FormData();
    const cvId = localStorage.getItem('galaxy_cv_id') || '';
    if (cvId) fd.set('cv_id', cvId);

    const res = await fetch(`${API}/publications/aggregate`, { method: 'POST', body: fd });
    if (!res.ok) {
      console.warn('aggregate failed:', res.status);
      return null;
    }
    return await res.json(); // { publications: [...] }
  }

  /* ---------------- shared modal ---------------- */
  let bsModal;
  function ensureModal() {
    if ($('#pubs_modal')) return;
    const shell = H('div','modal fade','');
    shell.id = 'pubs_modal'; shell.tabIndex = -1;
    shell.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-xl">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">Edit</h3>
            <button type="button" class="btn btn-icon btn-sm btn-light" data-bs-dismiss="modal">
              <i class="ki-duotone ki-cross fs-2"></i>
            </button>
          </div>
          <div class="modal-body"><div id="pubs_modal_body"></div></div>
          <div class="modal-footer">
            <button id="pubs_modal_save" class="btn btn-primary">Save</button>
            <button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(shell);
    bsModal = new bootstrap.Modal(shell);
  }

  function openModal(title, node, onSave) {
    ensureModal();
    $('#pubs_modal .modal-title').textContent = title;
    const body = $('#pubs_modal_body'); body.innerHTML = ''; body.appendChild(node);
    const old = $('#pubs_modal_save');
    const neo = old.cloneNode(true);
    old.parentNode.replaceChild(neo, old);
    neo.addEventListener('click', async () => {
      await onSave();                            // inputs → state
      save();                                    // localStorage
      await persistPage('publications', toPublicationsPayload()); // <-- NEW
      renderAll();
      bsModal.hide();
    });
    bsModal.show();
  }

  function labeled(title) {
    const s = H('div','mb-6','');
    s.appendChild(H('div','fw-bold fs-5 mb-3', title));
    const box = H('div','p-4 rounded bg-white bg-opacity-5 border border-white border-opacity-10','');
    s.appendChild(box);
    return {wrap:s, box};
  }

  /* ---------------- modals ---------------- */
  function modalPublications() {
    const {wrap, box} = labeled('Manage publications');
    const list = H('div','d-flex flex-column gap-3','');

    const row = (p={}) => {
      const r = H('div','p-3 rounded bg-white bg-opacity-5 border border-white border-opacity-10','');
      r.innerHTML = `
        <div class="row g-2">
          <div class="col-md-8"><input class="form-control" placeholder="Title" value="${p.title||''}"></div>
          <div class="col-md-4"><input class="form-control" placeholder="Authors (comma-separated)" value="${Array.isArray(p.authors)?p.authors.join(', '):(p.authors||'')}"></div>
          <div class="col-md-4"><input class="form-control" placeholder="Venue / Journal" value="${p.journal || p.venue || p.conference || ''}"></div>
          <div class="col-md-2"><input class="form-control" placeholder="Year" value="${p.year||''}"></div>
          <div class="col-md-3"><input class="form-control" placeholder="DOI" value="${p.doi||''}"></div>
          <div class="col-md-3"><input class="form-control" placeholder="URL" value="${p.url||''}"></div>
          <div class="col-md-8"><input class="form-control" placeholder="Tags (comma-separated)" value="${(p.tags||p.topics||[]).join(', ')}"></div>
          <div class="col-md-2"><input class="form-control" placeholder="Citations" value="${p.citations||0}"></div>
        </div>
        <div class="mt-2 text-end">
          <button class="btn btn-sm btn-light-danger">Remove</button>
        </div>`;
      r.querySelector('.btn-light-danger').addEventListener('click',()=>r.remove());
      return r;
    };

    (state.publications||[]).forEach(p => list.appendChild(row(p)));
    const add = H('button','btn btn-light mt-3','+ Add publication'); add.addEventListener('click',()=>list.appendChild(row()));
    box.appendChild(list); box.appendChild(add);

    const onSave = () => {
      const next = [];
      list.querySelectorAll(':scope > .p-3').forEach(card => {
        const ins = card.querySelectorAll('input');
        const [titleEl, authorsEl, venueEl, yearEl, doiEl, urlEl, tagsEl, citesEl] = ins;
        const title = (titleEl.value||'').trim();
        if (!title) return;
        next.push({
          title,
          authors: (authorsEl.value||'').split(',').map(s=>s.trim()).filter(Boolean),
          journal: (venueEl.value||'').trim(),
          year: Number(yearEl.value||0) || undefined,
          doi: (doiEl.value||'').trim() || undefined,
          url: (urlEl.value||'').trim() || undefined,
          tags: (tagsEl.value||'').split(',').map(s=>s.trim()).filter(Boolean),
          citations: Number(citesEl.value||0) || 0
        });
      });
      state.publications = next;

      // auto recompute unless overridden
      if (!state.overrides.metrics) state.metrics = computeMetricsFromPublications(state.publications);
      if (!state.overrides.topCited) state.topCited = [...state.publications].sort(by('citations')).slice(0,5);
      if (!state.overrides.topics) state.topics = deriveTopics(state.publications);
    };

    return [wrap, onSave];
  }

  function modalMetrics() {
    const {wrap, box} = labeled('Metrics (toggle auto or manual)');
    const chk = H('div','form-check form-switch mb-3','');
    chk.innerHTML = `<input class="form-check-input" type="checkbox" id="m_override"> <label class="form-check-label" for="m_override">Manual override</label>`;
    box.appendChild(chk);
    const o = $('#m_override', chk);
    o.checked = !!state.overrides.metrics;

    const m = state.overrides.metrics ? (state.metrics||{}) : computeMetricsFromPublications(state.publications);
    const grid = H('div','row g-2','');
    grid.innerHTML = `
      <div class="col-md-4"><label class="form-label">Total Publications</label><input id="m_totalPubs_in" class="form-control" value="${m.totalPubs||0}"></div>
      <div class="col-md-4"><label class="form-label">Total Citations</label><input id="m_totalCites_in" class="form-control" value="${m.totalCites||0}"></div>
      <div class="col-md-4"><label class="form-label">Avg Citations</label><input id="m_avgCites_in" class="form-control" value="${m.avgCites||0}"></div>
      <div class="col-md-4"><label class="form-label">h-Index</label><input id="m_hIndex_in" class="form-control" value="${m.hIndex||0}"></div>
      <div class="col-md-4"><label class="form-label">i10-Index</label><input id="m_i10Index_in" class="form-control" value="${m.i10Index||0}"></div>
    `;
    box.appendChild(grid);

    const onSave = () => {
      state.overrides.metrics = !!o.checked;
      if (state.overrides.metrics) {
        state.metrics = {
          totalPubs:  Number($('#m_totalPubs_in').value||0)||0,
          totalCites: Number($('#m_totalCites_in').value||0)||0,
          avgCites:   Number($('#m_avgCites_in').value||0)||0,
          hIndex:     Number($('#m_hIndex_in').value||0)||0,
          i10Index:   Number($('#m_i10Index_in').value||0)||0
        };
      } else {
        state.metrics = computeMetricsFromPublications(state.publications);
      }
    };
    return [wrap, onSave];
  }

  function modalTopCited() {
    const {wrap, box} = labeled('Top-Cited (toggle auto or manual)');
    const chk = H('div','form-check form-switch mb-3','');
    chk.innerHTML = `<input class="form-check-input" type="checkbox" id="tc_override"> <label class="form-check-label" for="tc_override">Manual override</label>`;
    box.appendChild(chk);
    const o = $('#tc_override', chk);
    o.checked = !!state.overrides.topCited;

    const list = H('div','d-flex flex-column gap-3','');
    const makeRow = (p={}) => {
      const r = H('div','p-3 rounded bg-white bg-opacity-5 border border-white border-opacity-10','');
      r.innerHTML = `
        <div class="row g-2">
          <div class="col-md-8"><input class="form-control" placeholder="Title" value="${p.title||''}"></div>
          <div class="col-md-2"><input class="form-control" placeholder="Year" value="${p.year||''}"></div>
          <div class="col-md-2"><input class="form-control" placeholder="Citations" value="${p.citations||0}"></div>
          <div class="col-md-8"><input class="form-control" placeholder="URL or DOI" value="${p.url || (p.doi ? `https://doi.org/${p.doi}` : '')}"></div>
        </div>
        <div class="mt-2 text-end"><button class="btn btn-sm btn-light-danger">Remove</button></div>`;
      r.querySelector('.btn-light-danger').addEventListener('click',()=>r.remove());
      return r;
    };
    const seed = state.overrides.topCited && state.topCited?.length
      ? state.topCited
      : [...state.publications].sort(by('citations')).slice(0,5);
    seed.forEach(p => list.appendChild(makeRow(p)));
    const add = H('button','btn btn-light mt-3','+ Add'); add.addEventListener('click',()=>list.appendChild(makeRow()));
    box.appendChild(list); box.appendChild(add);

    const onSave = () => {
      state.overrides.topCited = !!o.checked;
      if (state.overrides.topCited) {
        const next=[];
        list.querySelectorAll(':scope > .p-3').forEach(card=>{
          const ins = card.querySelectorAll('input');
          const [titleEl, yearEl, citesEl, urlEl] = ins;
          const title=(titleEl.value||'').trim();
          if (!title) return;
          next.push({
            title,
            year: Number(yearEl.value||0) || undefined,
            citations: Number(citesEl.value||0) || 0,
            url: (urlEl.value||'').trim() || undefined
          });
        });
        state.topCited = next;
      } else {
        state.topCited = [...state.publications].sort(by('citations')).slice(0,5);
      }
    };
    return [wrap, onSave];
  }

  function modalTopics() {
    const {wrap, box} = labeled('Research Topics (toggle auto or manual)');
    const chk = H('div','form-check form-switch mb-3','');
    chk.innerHTML = `<input class="form-check-input" type="checkbox" id="tp_override"> <label class="form-check-label" for="tp_override">Manual override</label>`;
    box.appendChild(chk);
    const o = $('#tp_override', chk);
    o.checked = !!state.overrides.topics;

    const ta = H('textarea','form-control', (state.topics||[]).join(', ')); ta.rows=6;
    box.appendChild(ta);

    const onSave = () => {
      state.overrides.topics = !!o.checked;
      if (state.overrides.topics) {
        state.topics = ta.value.replace(/\n/g, ',').split(',').map(s=>s.trim()).filter(Boolean);
      } else {
        state.topics = deriveTopics(state.publications);
      }
    };
    return [wrap, onSave];
  }

  /* ---------------- edit toggle ---------------- */
  function wireEditToggle() {
    on($('#editToggle'),'click', e => {
      e.preventDefault();
      editMode = !editMode;
      reflectEditMode();
    });
  }

  /* ---------------- boot ---------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    await load(); // show cache instantly if any

    try{
      const isLocal = ['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname);
      const API = isLocal ? 'http://127.0.0.1:3001/api' : '/api';
      const r = await fetch(`${API}/publications`, { cache:'no-store' });
      if (r.ok){
        const saved = await r.json();
        // If you want saved manual set to override immediately:
        if (saved?.publications?.length){
          state.publications = saved.publications;
          state.metrics  = saved.metrics  || state.metrics;
          state.topics   = saved.topics   || state.topics;
          state.topCited = saved.topCited || state.topCited;
        }
      }
    }catch(e){}

    ensureTinyButtons?.();
    wireEditToggle?.();
    renderAll();
  });
})();
