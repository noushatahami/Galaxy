(() => {
  /* ----------------------- utils ----------------------- */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const H  = (t, c='', inner='') => { const n=document.createElement(t); if(c)n.className=c; if(inner!=null)n.innerHTML=inner; return n; };
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  // DEV/PROD API base (treat localhost, 127.0.0.1, 0.0.0.0 as local)
  const API = (['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname))
    ? 'http://127.0.0.1:3001/api'
    : '/api';

  const fmtMoney = (n) => (n==null || n===''
    ? '—'
    : Number(n).toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 })
  );
  const sum = (arr) => arr.reduce((a,b)=>a+(Number(b)||0),0);

  /* ----------------------- state ----------------------- */
  let editMode = false;
  const state = {
    grants: [],             // [{id,title,agency,type,duration,amountAwarded,amountReceived,amountSpent,tags[],awardedAt}]
    totals: { totalAwarded: 0, availableBudget: 0 },
    lastAwarded: null,      // grant object
    breakdown: { categories: [], total: 0 }, // {label,value}[]
    reports: { grantId: '', nextDue: '', lastSubmitted: '' },
    keywords: []            // [string]
  };

  /* ----------------------- persistence ----------------------- */
  function save() { localStorage.setItem('galaxy_grants', JSON.stringify(state)); }
  async function persistPage(page, data){
    try{
      await fetch(`${API}/page`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ page, data })
      });
    }catch(e){ console.error(e); }
  }

  async function load() {
    const hasCV = !!localStorage.getItem('galaxy_cv_id');

    // 1) Soft-load local cache (no early return)
    const local = localStorage.getItem('galaxy_grants');
    if (local && !hasCV) {
      try { Object.assign(state, JSON.parse(local)); } catch {}
    }

    // 2) Prefer API (CV-backed). Any successful fetch overrides cache/state.
    try {
      const [gr, sm, br, rp, kw] = await Promise.allSettled([
        fetch(`${API}/grants`),
        fetch(`${API}/grants/summary`),
        fetch(`${API}/grants/breakdown`),
        fetch(`${API}/grants/reports`),
        fetch(`${API}/grants/keywords`)
      ]);

      if (gr.status==='fulfilled' && gr.value.ok) {
        const data = await gr.value.json();
        state.grants = data.grants || data || [];
        if (data.total_grants_awarded?.amount!=null && data.available_budget?.amount!=null) {
          state.totals = {
            totalAwarded: Number(data.total_grants_awarded.amount)||0,
            availableBudget: Number(data.available_budget.amount)||0
          };
        }
        if (data.last_awarded_grant) state.lastAwarded = data.last_awarded_grant;
        if (data.breakdown) state.breakdown = data.breakdown;
        if (data.reports)   state.reports   = data.reports;
        if (data.keywords)  state.keywords  = data.keywords;
      }
      if (sm.status==='fulfilled' && sm.value.ok) {
        const s = await sm.value.json();
        if (s.totalAwarded!=null && s.availableBudget!=null) {
          state.totals = { totalAwarded: s.totalAwarded, availableBudget: s.availableBudget };
        }
        if (s.lastAwarded) state.lastAwarded = s.lastAwarded;
      }
      if (br.status==='fulfilled' && br.value.ok) {
        state.breakdown = await br.value.json() || state.breakdown;
      }
      if (rp.status==='fulfilled' && rp.value.ok) {
        state.reports = await rp.value.json() || state.reports;
      }
      if (kw.status==='fulfilled' && kw.value.ok) {
        const k = await kw.value.json();
        state.keywords = k.keywords || k || state.keywords;
      }
    } catch {}

    // 3) Static fallback
    if (!state.grants?.length) {
      try {
        const r = await fetch('data/grants.json', { cache:'no-store' });
        if (r.ok) {
          const d = await r.json();
          state.grants      = d.grants || d || [];
          state.totals      = d.totals || state.totals;
          state.lastAwarded = d.lastAwarded || state.lastAwarded;
          state.breakdown   = d.breakdown || state.breakdown;
          state.reports     = d.reports || state.reports;
          state.keywords    = d.keywords || state.keywords;
        }
      } catch {}
    }

    // 4) Derive missing bits
    if (!state.totals || state.totals.totalAwarded==null) deriveTotals();
    if (!state.lastAwarded) deriveLastAwarded();
    if (!state.keywords?.length) deriveKeywords();
  }

  /* ----------------------- derivations ----------------------- */
  function deriveTotals() {
    const totalAwarded  = sum(state.grants.map(g=>g.amountAwarded||g.amount||0));
    const totalReceived = sum(state.grants.map(g=>g.amountReceived||0));
    const totalSpent    = sum(state.grants.map(g=>g.amountSpent||0));
    const availableBudget = Math.max(totalReceived - totalSpent, 0);
    state.totals = { totalAwarded, availableBudget };
  }
  function deriveLastAwarded() {
    if (!state.grants?.length) { state.lastAwarded = null; return; }
    state.lastAwarded = [...state.grants].sort((a,b) =>
      new Date(b.awardedAt||0) - new Date(a.awardedAt||0)
    )[0];
  }
  function deriveKeywords() {
    const set = new Set();
    (state.grants||[]).forEach(g => (g.tags||g.keywords||[]).forEach(t => set.add(t)));
    state.keywords = [...set].slice(0, 30);
  }

  /* ----------------------- renderers ----------------------- */
  function renderTotals() {
    const totalEl = $('#total_grants_awarded');
    const availEl = $('#available_budget');
    if (totalEl) totalEl.textContent = fmtMoney(state.totals.totalAwarded);
    if (availEl) availEl.textContent = fmtMoney(state.totals.availableBudget);
  }

  function renderGrantsTable() {
    const tbody = $('#grants_tbody');
    const countBadge = $('#grants_count');
    if (!tbody) return;

    if (!state.grants?.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400">No grants found</td></tr>';
      if (countBadge) countBadge.textContent = '0 grants';
      return;
    }

    if (countBadge) countBadge.textContent = `${state.grants.length} grant${state.grants.length !== 1 ? 's' : ''}`;

    // TINY TWEAK: make rows clickable (add class + data-index)
    tbody.innerHTML = state.grants.map((g, idx) => {
      const awarded = g.amountAwarded || g.amount || 0;
      const received = g.amountReceived || 0;
      const spent = g.amountSpent || 0;

      return `<tr class="grant-row" data-index="${idx}">
        <td>${g.title || '—'}</td>
        <td>${g.agency || '—'}</td>
        <td class="text-end">${fmtMoney(awarded)}</td>
        <td class="text-end">${fmtMoney(received)}</td>
        <td class="text-end">${fmtMoney(spent)}</td>
        <td class="text-center">
          <span class="badge ${received > 0 ? 'badge-light-success' : 'badge-light-secondary'}">${received > 0 ? 'Active' : 'Pending'}</span>
        </td>
      </tr>`;
    }).join('');

    // NEW: wire row click handler once
    wireRowClicks();
  }

  function renderLastAwarded() {
    const ul = $('#last_awarded_grant'); if (!ul) return;
    ul.innerHTML = '';
    const g = state.lastAwarded;
    if (!g) { ul.innerHTML = '<li class="text-gray-400">—</li>'; return; }
    const rows = [
      ['Title', g.title],
      ['Grant ID', g.id || g.grantId],
      ['Agency', g.agency],
      ['Type', g.type],
      ['Duration', g.duration],
      ['Amount Awarded', fmtMoney(g.amountAwarded || g.amount)],
      ['Amount Received', fmtMoney(g.amountReceived)],
      ['Amount Spent', fmtMoney(g.amountSpent)],
      ['Awarded', g.awardedAt ? new Date(g.awardedAt).toLocaleDateString() : '—'],
      ['Tags', (g.tags||g.keywords||[]).map(t => `<span class="badge bg-success bg-opacity-20 text-success me-1 mb-1">${t}</span>`).join(' ')]
    ];
    rows.forEach(([k,v]) => {
      const li = H('li','', `<strong>${k}:</strong> ${v!=null && v!=='' ? v : '—'}`);
      ul.appendChild(li);
    });
  }

  function renderBreakdown() {
    const wrap = $('#breakdown'); if (!wrap) return;
    wrap.innerHTML = '';
    const b = state.breakdown;
    const cats = b?.categories || [];
    if (!cats.length) { wrap.textContent = '—'; return; }
    const total = b.total || sum(cats.map(c=>Number(c.value)||0)) || 1;
    cats.forEach(c => {
      const val = Number(c.value)||0;
      const pct = Math.round((val/total)*100);
      const row = H('div','mb-3','');
      row.innerHTML = `
        <div class="d-flex justify-content-between">
          <span class="text-gray-300">${c.label || '—'}</span>
          <span class="text-gray-300">${fmtMoney(val)} · ${pct}%</span>
        </div>
        <div class="h-6px bg-light rounded">
          <div class="h-6px bg-primary rounded" style="width:${pct}%"></div>
        </div>`;
      wrap.appendChild(row);
    });
  }

  function renderReports() {
    const gid  = $('#reports_grant_id');
    const due  = $('#reports_next_due');
    const last = $('#reports_last_submitted');
    const r = state.reports || {};
    if (gid)  gid.textContent  = r.grantId ? String(r.grantId) : '—';
    if (due)  due.textContent  = r.nextDue || '—';
    if (last) last.textContent = r.lastSubmitted || '—';
  }

  function renderKeywords() {
    const wrap = $('#keywords_section'); if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.keywords?.length) {
      wrap.appendChild(H('span','badge bg-success bg-opacity-20 text-success','—')); return;
    }
    state.keywords.forEach(k => wrap.appendChild(H('span','badge bg-success bg-opacity-20 text-success me-1 mb-1', k)));
  }

  function renderAll() {
    renderTotals();
    renderGrantsTable();
    renderLastAwarded();
    renderBreakdown();
    renderReports();
    renderKeywords();
    reflectEditMode();
  }

  /* ----------------------- NEW: grant details popup (view-only) ----------------------- */
  function buildGrantDetailsView(g) {
    const wrap = H('div','', '');
    const grid = H('div','row g-4','');

    const cell = (label, valueHtml) => {
      const c = H('div','col-md-6','');
      c.innerHTML = `
        <div class="fw-semibold text-gray-500 mb-1">${label}</div>
        <div class="fs-6">${valueHtml}</div>`;
      return c;
    };

    const badgeList = (arr=[]) =>
      (arr||[]).map(t => `<span class="badge bg-success bg-opacity-20 text-success me-1 mb-1">${t}</span>`).join(' ') || '—';

    const awarded  = g.amountAwarded || g.amount || 0;
    const received = g.amountReceived || 0;
    const spent    = g.amountSpent || 0;
    const status   = received > 0 ? '<span class="badge badge-light-success">Active</span>' :
                                    '<span class="badge badge-light-secondary">Pending</span>';

    grid.appendChild(cell('Title', g.title ? String(g.title) : '—'));
    grid.appendChild(cell('Grant ID', g.id || g.grantId || '—'));
    grid.appendChild(cell('Agency', g.agency || '—'));
    grid.appendChild(cell('Type', g.type || '—'));
    grid.appendChild(cell('Duration', g.duration || '—'));
    grid.appendChild(cell('Status', status));
    grid.appendChild(cell('Amount Awarded', fmtMoney(awarded)));
    grid.appendChild(cell('Amount Received', fmtMoney(received)));
    grid.appendChild(cell('Amount Spent', fmtMoney(spent)));
    grid.appendChild(cell('Awarded Date', g.awardedAt ? new Date(g.awardedAt).toLocaleDateString() : '—'));
    grid.appendChild(cell('Tags', badgeList(g.tags || g.keywords)));

    if (g.url || g.link) {
      grid.appendChild(cell('Link', `<a href="${g.url || g.link}" class="btn btn-sm btn-light-primary" target="_blank" rel="noopener">Open link</a>`));
    }

    wrap.appendChild(grid);
    return wrap;
  }

  function showGrantDetails(g) {
    const bodyNode = buildGrantDetailsView(g);
    openViewModal('Grant Details', bodyNode);
  }

  // View-only modal wrapper that *does not* touch your existing openModal
  function openViewModal(title, bodyNode) {
    ensureModal();
    $('#grants_modal .modal-title').textContent = title;
    const body = $('#grants_modal_body'); body.innerHTML = ''; body.appendChild(bodyNode);

    // Hide Save, relabel Cancel → Close (restore after hide)
    const saveBtn   = $('#grants_modal_save');
    const footer    = saveBtn.closest('.modal-footer');
    const cancelBtn = footer.querySelector('[data-bs-dismiss="modal"]');

    const prevCancelText = cancelBtn.textContent;
    saveBtn.classList.add('d-none');
    cancelBtn.textContent = 'Close';

    const modalEl = $('#grants_modal');
    const cleanup = () => {
      saveBtn.classList.remove('d-none');
      cancelBtn.textContent = prevCancelText;
      modalEl.removeEventListener('hidden.bs.modal', cleanup);
    };
    modalEl.addEventListener('hidden.bs.modal', cleanup);

    // Show it
    if (!window.bootstrap || !window.bootstrap.Modal) {
      // fallback if bootstrap isn't ready
      return;
    }
    const bs = bootstrap.Modal.getOrCreateInstance(modalEl);
    bs.show();
  }

  function wireRowClicks() {
    const tbody = $('#grants_tbody'); if (!tbody || tbody._wired) return;
    tbody._wired = true;
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr.grant-row');
      if (!tr) return;
      const idx = Number(tr.getAttribute('data-index'));
      if (!Number.isFinite(idx)) return;
      const g = state.grants[idx];
      if (g) showGrantDetails(g);
    });
  }

  /* ----------------------- edit-mode UI ----------------------- */
  function reflectEditMode() {
    const t = $('#editToggle'); if (t) t.textContent = editMode ? 'Done' : 'Edit';
    $$('.box-edit-btn').forEach(b => b.classList.toggle('d-none', !editMode));
  }

  function wireEditToggle() {
    on($('#editToggle'), 'click', (e) => {
      e.preventDefault();
      editMode = !editMode;
      reflectEditMode();
    });
  }

  // ONE tiny edit button per card (like profile)
  function ensureTinyButtons() {
    const cfgs = [
      { anchor:'#total_grants_awarded', title:'Edit Totals',          build: buildTotalsModal },
      { anchor:'#grants_tbody',         title:'Edit All Grants',      build: buildAllGrantsModal },  // NEW
      { anchor:'#last_awarded_grant',   title:'Edit Last Awarded',    build: buildLastAwardedModal },
      { anchor:'#breakdown',            title:'Edit Breakdown',       build: buildBreakdownModal },
      { anchor:'#reports_grant_id',     title:'Edit Reports',         build: buildReportsModal },
      { anchor:'#keywords_section',     title:'Edit Keywords',        build: buildKeywordsModal },
    ];
    cfgs.forEach(cfg => {
      const anchorEl = document.querySelector(cfg.anchor);
      const card = anchorEl?.closest('.card');
      const header = card?.querySelector('.card-header');
      if (!header) return;
      header.querySelectorAll('.box-edit-btn').forEach(b => b.remove());
      let rail = header.querySelector('.card-toolbar'); if (!rail) { rail = H('div','card-toolbar'); header.appendChild(rail); }
      const btn = H('button','btn btn-sm btn-light box-edit-btn d-none','Edit');
      btn.addEventListener('click', () => openModal(cfg.title, ...cfg.build()));
      rail.appendChild(btn);
    });
  }

  /* ----------------------- shared modal ----------------------- */
  let bsModal;
  function ensureModal() {
    if ($('#grants_modal')) return;
    const shell = H('div','modal fade','');
    shell.id = 'grants_modal'; shell.tabIndex = -1;
    shell.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-xl">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">Edit</h3>
            <button type="button" class="btn btn-icon btn-sm btn-light" data-bs-dismiss="modal" aria-label="Close">
              <span class="fs-2 fw-bold" style="line-height:1;color:#111827;">×</span>
            </button>
          </div>
          <div class="modal-body"><div id="grants_modal_body"></div></div>
          <div class="modal-footer">
            <button id="grants_modal_save" class="btn btn-primary">Save</button>
            <button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(shell);
    bsModal = new bootstrap.Modal(shell);
  }

  function openModal(title, bodyNode, onSave) {
    ensureModal();
    $('#grants_modal .modal-title').textContent = title;
    const body = $('#grants_modal_body'); body.innerHTML = ''; body.appendChild(bodyNode);
    const old = $('#grants_modal_save');
    const neo = old.cloneNode(true);
    old.parentNode.replaceChild(neo, old);
    neo.addEventListener('click', async () => {
      await onSave();                                // inputs -> state
      await persistPage('grants', {                  
        grants: state.grants,
        total_grants_awarded: { amount: state.totals?.totalAwarded ?? 0 },
        available_budget:    { amount: state.totals?.availableBudget ?? 0 },
        last_awarded_grant:  state.lastAwarded || null,
        breakdown:           state.breakdown || { categories: [], total: 0 },
        reports:             state.reports   || { grantId:'', nextDue:'', lastSubmitted:'' },
        keywords:            state.keywords  || []
      });
      save();
      renderAll();
      window.dispatchEvent(new CustomEvent('galaxy:grants:updated'));
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

  /* ----------------------- modal builders ----------------------- */
  function buildTotalsModal() {
    const {wrap, box} = labeled('Totals');
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label">Total Grants Awarded</label>
          <input id="in_total_awarded" class="form-control" value="${state.totals.totalAwarded||0}">
        </div>
        <div class="col-md-6">
          <label class="form-label">Available Budget</label>
          <input id="in_available_budget" class="form-control" value="${state.totals.availableBudget||0}">
        </div>
      </div>
      <div class="form-text mt-2">Tip: These can be auto-derived from raw grants if you prefer—just leave them as-is and we can add auto mode later.</div>
    `;
    const onSave = () => {
      const ta = Number($('#in_total_awarded').value||0) || 0;
      const ab = Number($('#in_available_budget').value||0) || 0;
      state.totals = { totalAwarded: ta, availableBudget: ab };
    };
    return [wrap, onSave];
  }

  function buildAllGrantsModal() {
    const {wrap, box} = labeled('All Grants');
    const list = H('div','d-flex flex-column gap-3','');

    const grantRow = (g = {}, idx = -1) => {
      const r = H('div','p-3 rounded bg-white bg-opacity-5 border border-white border-opacity-10','');
      r.innerHTML = `
        <div class="row g-3">
          <div class="col-md-6">
            <label class="form-label">Title</label>
            <input class="grant-title form-control" value="${g.title||''}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Grant ID</label>
            <input class="grant-id form-control" value="${g.id||g.grantId||''}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Agency</label>
            <input class="grant-agency form-control" value="${g.agency||''}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Type</label>
            <input class="grant-type form-control" value="${g.type||''}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Duration</label>
            <input class="grant-duration form-control" value="${g.duration||''}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Amount Awarded</label>
            <input class="grant-awarded form-control" value="${g.amountAwarded||g.amount||0}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Awarded Date</label>
            <input class="grant-awardedAt form-control" type="date" value="${g.awardedAt ? new Date(g.awardedAt).toISOString().slice(0,10) : ''}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Amount Received</label>
            <input class="grant-received form-control" value="${g.amountReceived||0}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Amount Spent</label>
            <input class="grant-spent form-control" value="${g.amountSpent||0}">
          </div>
          <div class="col-md-6">
            <label class="form-label">Tags (comma-separated)</label>
            <input class="grant-tags form-control" value="${(g.tags||g.keywords||[]).join(', ')}">
          </div>
          <div class="col-12">
            <button class="btn btn-light-danger btn-sm remove-grant">Remove Grant</button>
          </div>
        </div>
      `;
      r.querySelector('.remove-grant').addEventListener('click', () => r.remove());
      return r;
    };

    state.grants.forEach((g, idx) => list.appendChild(grantRow(g, idx)));

    const addBtn = H('button','btn btn-light mt-2','+ Add Grant');
    addBtn.addEventListener('click', () => list.appendChild(grantRow()));

    box.appendChild(list);
    box.appendChild(addBtn);

    const onSave = () => {
      const grants = [];
      list.querySelectorAll(':scope > div').forEach(r => {
        const obj = {
          title: r.querySelector('.grant-title')?.value.trim() || '',
          id: r.querySelector('.grant-id')?.value.trim() || undefined,
          agency: r.querySelector('.grant-agency')?.value.trim() || undefined,
          type: r.querySelector('.grant-type')?.value.trim() || undefined,
          duration: r.querySelector('.grant-duration')?.value.trim() || undefined,
          amountAwarded: Number(r.querySelector('.grant-awarded')?.value||0) || 0,
          awardedAt: r.querySelector('.grant-awardedAt')?.value ? new Date(r.querySelector('.grant-awardedAt').value).toISOString() : undefined,
          amountReceived: Number(r.querySelector('.grant-received')?.value||0) || 0,
          amountSpent: Number(r.querySelector('.grant-spent')?.value||0) || 0,
          tags: (r.querySelector('.grant-tags')?.value||'').split(',').map(s => s.trim()).filter(Boolean)
        };
        if (obj.title) grants.push(obj);
      });
      state.grants = grants;
      deriveTotals();
      deriveLastAwarded();
      deriveKeywords();
    };

    return [wrap, onSave];
  }

  function buildLastAwardedModal() {
    const {wrap, box} = labeled('Last Awarded Grant');
    const g = state.lastAwarded || {};
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-6"><label class="form-label">Title</label><input id="la_title" class="form-control" value="${g.title||''}"></div>
        <div class="col-md-3"><label class="form-label">Grant ID</label><input id="la_id" class="form-control" value="${g.id||g.grantId||''}"></div>
        <div class="col-md-3"><label class="form-label">Agency</label><input id="la_agency" class="form-control" value="${g.agency||''}"></div>

        <div class="col-md-3"><label class="form-label">Type</label><input id="la_type" class="form-control" value="${g.type||''}"></div>
        <div class="col-md-3"><label class="form-label">Duration</label><input id="la_duration" class="form-control" value="${g.duration||''}"></div>
        <div class="col-md-3"><label class="form-label">Amount Awarded</label><input id="la_awarded" class="form-control" value="${g.amountAwarded||g.amount||0}"></div>
        <div class="col-md-3"><label class="form-label">Awarded Date</label><input id="la_awardedAt" type="date" class="form-control" value="${g.awardedAt ? new Date(g.awardedAt).toISOString().slice(0,10) : ''}"></div>

        <div class="col-md-3"><label class="form-label">Amount Received</label><input id="la_received" class="form-control" value="${g.amountReceived||0}"></div>
        <div class="col-md-3"><label class="form-label">Amount Spent</label><input id="la_spent" class="form-control" value="${g.amountSpent||0}"></div>
        <div class="col-md-6"><label class="form-label">Tags (comma-separated)</label><input id="la_tags" class="form-control" value="${(g.tags||g.keywords||[]).join(', ')}"></div>
      </div>
    `;
    const onSave = () => {
      const obj = {
        title: $('#la_title').value.trim(),
        id: $('#la_id').value.trim() || undefined,
        agency: $('#la_agency').value.trim() || undefined,
        type: $('#la_type').value.trim() || undefined,
        duration: $('#la_duration').value.trim() || undefined,
        amountAwarded: Number($('#la_awarded').value||0)||0,
        awardedAt: $('#la_awardedAt').value ? new Date($('#la_awardedAt').value).toISOString() : undefined,
        amountReceived: Number($('#la_received').value||0)||0,
        amountSpent: Number($('#la_spent').value||0)||0,
        tags: $('#la_tags').value.split(',').map(s=>s.trim()).filter(Boolean)
      };
      state.lastAwarded = obj;
    };
    return [wrap, onSave];
  }

  function buildBreakdownModal() {
    const {wrap, box} = labeled('Breakdown');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (label='', value='') => {
      const r = H('div','d-flex gap-2 align-items-center','');
      r.innerHTML = `
        <input class="form-control" placeholder="Label" value="${label}">
        <input class="form-control" placeholder="Amount" value="${value}">
        <button class="btn btn-light-danger">Remove</button>`;
      r.lastElementChild.addEventListener('click',()=>r.remove());
      return r;
    };

    (state.breakdown?.categories||[]).forEach(c => list.appendChild(row(c.label||'', c.value||'')));
    const add = H('button','btn btn-light mt-2','+ Add row'); add.addEventListener('click',()=>list.appendChild(row()));
    box.appendChild(list); box.appendChild(add);

    const onSave = () => {
      const cats=[];
      list.querySelectorAll(':scope > div').forEach(d=>{
        const [l,v] = d.querySelectorAll('input');
        const label=(l.value||'').trim();
        const value=Number(v.value||0)||0;
        if (label) cats.push({label, value});
      });
      state.breakdown = { categories: cats, total: sum(cats.map(x=>x.value)) };
    };
    return [wrap, onSave];
  }

  function buildReportsModal() {
    const {wrap, box} = labeled('Reports');
    const r = state.reports || {};
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-4"><label class="form-label">Grant ID</label><input id="rp_id" class="form-control" value="${r.grantId||''}"></div>
        <div class="col-md-4"><label class="form-label">Next Due</label><input id="rp_due" type="date" class="form-control" value="${r.nextDue ? new Date(r.nextDue).toISOString().slice(0,10) : ''}"></div>
        <div class="col-md-4"><label class="form-label">Last Submitted</label><input id="rp_last" type="date" class="form-control" value="${r.lastSubmitted ? new Date(r.lastSubmitted).toISOString().slice(0,10) : ''}"></div>
      </div>
    `;
    const onSave = () => {
      state.reports = {
        grantId: $('#rp_id').value.trim(),
        nextDue: $('#rp_due').value || '',
        lastSubmitted: $('#rp_last').value || ''
      };
    };
    return [wrap, onSave];
  }

  function buildKeywordsModal() {
    const {wrap, box} = labeled('Keywords (comma or newline separated)');
    const ta = H('textarea','form-control', (state.keywords||[]).join(', ')); ta.rows = 8;
    box.appendChild(ta);
    const onSave = () => {
      state.keywords = ta.value.replace(/\n/g, ',').split(',').map(s=>s.trim()).filter(Boolean);
    };
    return [wrap, onSave];
  }

  /* ----------------------- boot ----------------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    await load();            // pulls from API (CV-backed) or local/static
    ensureTinyButtons();     // one tiny Edit per card (like profile)
    wireEditToggle();        // toggles the tiny buttons
    renderAll();             // paint
    window.dispatchEvent(new CustomEvent('galaxy:grants:updated'));
  });
})();
