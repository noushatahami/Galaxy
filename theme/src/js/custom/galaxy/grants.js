(() => {
  /* ----------------------- utils ----------------------- */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const H  = (t, c='', inner='') => { const n=document.createElement(t); if(c)n.className=c; if(inner!=null)n.innerHTML=inner; return n; };
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  
  // DEV/PROD API base
  const API = (['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname))
    ? 'http://127.0.0.1:3001/api'
    : '/api';

  const fmtMoney = (n) => (n==null || n===''
    ? '—'
    : Number(n).toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 })
  );
  
  const fmtMoneyShort = (n) => {
    n = Number(n)||0; 
    const a = Math.abs(n);
    if (a >= 1e9) return `$${(n/1e9).toFixed(1)}B`;
    if (a >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
    if (a >= 1e3) return `$${(n/1e3).toFixed(1)}k`;
    return `$${n.toFixed(0)}`;
  };
  
  const sum = (arr) => arr.reduce((a,b)=>a+(Number(b)||0),0);

  function nz(x){
    if (typeof x === 'string') x = x.replace(/[$,]/g,'');
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function amountAwarded(g){ return nz(g.amountAwarded ?? g.amount_awarded ?? g.awarded ?? g.amount ?? g.total_amount ?? g.value ?? g.budget?.total); }
  function amountReceived(g){ return nz(g.amountReceived ?? g.amount_received ?? g.received ?? g.budget?.received); }
  function amountSpent(g){ return nz(g.amountSpent ?? g.amount_spent ?? g.spent ?? g.budget?.spent); }

  /* ----------------------- state ----------------------- */
  let editMode = false;
  const state = {
    grants: [],
    totals: { totalAwarded: 0, availableBudget: 0 },
    lastAwarded: null,
    breakdown: { categories: [], total: 0 },
    reports: { grantId: '', nextDue: '', lastSubmitted: '' },
    keywords: []
  };

  /* ----------------------- persistence ----------------------- */
  function save() { 
    localStorage.setItem('galaxy_grants', JSON.stringify(state)); 
    console.log('✅ Saved to localStorage');
  }
  
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

    // 1) Soft-load local cache
    const local = localStorage.getItem('galaxy_grants');
    if (local && !hasCV) {
      try { Object.assign(state, JSON.parse(local)); } catch {}
    }

    // 2) Prefer API
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
    const totalAwarded  = sum(state.grants.map(g=>amountAwarded(g)));
    const totalReceived = sum(state.grants.map(g=>amountReceived(g)));
    const totalSpent    = sum(state.grants.map(g=>amountSpent(g)));
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

  /* ----------------------- enhanced renderers ----------------------- */
  function renderGrantsSummary() {
    const totalAwarded  = sum(state.grants.map(g=>amountAwarded(g)));
    const totalReceived = sum(state.grants.map(g=>amountReceived(g)));
    const totalSpent    = sum(state.grants.map(g=>amountSpent(g)));
    const total = totalAwarded + totalReceived + totalSpent;

    console.log('📊 Chart update - Awarded:', totalAwarded, 'Received:', totalReceived, 'Spent:', totalSpent);

    // Update donut
    const donutPath = $('#summary_donut_path');
    const percentText = $('#summary_percent_text');

    if(donutPath && percentText){
      const percent = totalReceived > 0 ? Math.min(100, Math.round((totalSpent / totalReceived) * 100)) : 0;
      const circumference = 402;
      const filled = (percent / 100) * circumference;

      donutPath.setAttribute('stroke-dasharray', `${filled} ${circumference}`);
      percentText.textContent = `${percent}%`;

      if(percent >= 90) {
        donutPath.setAttribute('stroke', '#ef4444');
      } else if(percent >= 70) {
        donutPath.setAttribute('stroke', '#f59e0b');
      } else {
        donutPath.setAttribute('stroke', '#22c55e');
      }
    }

    // Update text values
    const awardedEl = $('#summary_awarded');
    const receivedEl = $('#summary_received');
    const spentEl = $('#summary_spent');

    if(awardedEl) awardedEl.textContent = fmtMoneyShort(totalAwarded);
    if(receivedEl) receivedEl.textContent = fmtMoneyShort(totalReceived);
    if(spentEl) spentEl.textContent = fmtMoneyShort(totalSpent);

    // Update bars
    const barBlue = $('#bar_blue');
    const barYellow = $('#bar_yellow');
    const barRed = $('#bar_red');

    if(barBlue && barYellow && barRed && total > 0){
      setTimeout(()=>{
        barBlue.style.width = `${(totalAwarded / total) * 100}%`;
        barYellow.style.width = `${(totalReceived / total) * 100}%`;
        barRed.style.width = `${(totalSpent / total) * 100}%`;
      }, 50);
    }
  }

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
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><i class="ki-duotone ki-information-2 d-block"><span class="path1"></span><span class="path2"></span><span class="path3"></span></i>No grants found</div></td></tr>';
      if (countBadge) countBadge.textContent = '0 grants';
      return;
    }

    if (countBadge) countBadge.textContent = `${state.grants.length} grant${state.grants.length !== 1 ? 's' : ''}`;

    tbody.innerHTML = state.grants.map((g, idx) => {
      const awarded = amountAwarded(g);
      const received = amountReceived(g);
      const spent = amountSpent(g);

      return `<tr class="grant-row" data-index="${idx}">
        <td>
          <div class="grant-cell-title">${g.title || '—'}</div>
          <div class="grant-cell-meta">${g.id || g.grantId || 'No ID'}</div>
        </td>
        <td>
          <div class="grant-cell-agency">${g.agency || '—'}</div>
          <div class="grant-cell-type">${g.type || 'Not specified'}</div>
        </td>
        <td>
          <div class="grant-amount-primary">${fmtMoneyShort(awarded)}</div>
          <div class="grant-amount-label">Awarded</div>
        </td>
        <td>
          <div class="grant-amount-primary">${fmtMoneyShort(received)}</div>
          <div class="grant-amount-label">Received</div>
        </td>
        <td>
          <div class="grant-amount-primary">${fmtMoneyShort(spent)}</div>
          <div class="grant-amount-label">Spent</div>
        </td>
        <td class="text-center">
          <span class="grant-status-badge ${received > 0 ? 'grant-status-active' : 'grant-status-pending'}">${received > 0 ? 'Active' : 'Pending'}</span>
        </td>
      </tr>`;
    }).join('');

    wireRowClicks();
  }

  function renderLastAwarded() {
    const container = $('#last_awarded_grant'); 
    if (!container) return;
    
    container.className = 'grant-detail-list';
    container.innerHTML = '';
    
    const g = state.lastAwarded;
    if (!g) { 
      container.innerHTML = '<div class="empty-state"><i class="ki-duotone ki-award d-block"><span class="path1"></span><span class="path2"></span><span class="path3"></span></i>No awarded grants yet</div>'; 
      return; 
    }

    const rows = [
      { icon: 'ki-document', label: 'Title', value: g.title },
      { icon: 'ki-tag', label: 'Grant ID', value: g.id || g.grantId },
      { icon: 'ki-office-bag', label: 'Agency', value: g.agency },
      { icon: 'ki-category', label: 'Type', value: g.type },
      { icon: 'ki-time', label: 'Duration', value: g.duration },
      { icon: 'ki-dollar', label: 'Amount Awarded', value: fmtMoney(amountAwarded(g)) },
      { icon: 'ki-wallet', label: 'Amount Received', value: fmtMoney(amountReceived(g)) },
      { icon: 'ki-chart-simple', label: 'Amount Spent', value: fmtMoney(amountSpent(g)) },
      { icon: 'ki-calendar', label: 'Awarded', value: g.awardedAt ? new Date(g.awardedAt).toLocaleDateString() : '—' }
    ];

    rows.forEach(({icon, label, value}) => {
      const item = H('div', 'grant-detail-item');
      item.innerHTML = `
        <div class="grant-detail-icon">
          <i class="ki-duotone ${icon} fs-3"><span class="path1"></span><span class="path2"></span></i>
        </div>
        <div class="grant-detail-content">
          <div class="grant-detail-label">${label}</div>
          <div class="grant-detail-value">${value != null && value !== '' ? value : '—'}</div>
        </div>
      `;
      container.appendChild(item);
    });

    // Tags section
    if ((g.tags||g.keywords||[]).length > 0) {
      const tagsItem = H('div', 'grant-detail-item');
      tagsItem.innerHTML = `
        <div class="grant-detail-icon">
          <i class="ki-duotone ki-tag fs-3"><span class="path1"></span><span class="path2"></span></i>
        </div>
        <div class="grant-detail-content">
          <div class="grant-detail-label">Tags</div>
          <div class="grant-detail-value grant-tags-wrap">
            ${(g.tags||g.keywords||[]).map(t => `<span class="pill">${t}</span>`).join('')}
          </div>
        </div>
      `;
      container.appendChild(tagsItem);
    }
  }

  function renderBreakdown() {
    const wrap = $('#breakdown'); 
    if (!wrap) return;
    
    wrap.innerHTML = '';
    const b = state.breakdown;
    const cats = b?.categories || [];
    
    if (!cats.length) { 
      wrap.innerHTML = '<div class="empty-state"><i class="ki-duotone ki-chart-pie-simple d-block"><span class="path1"></span><span class="path2"></span></i>No breakdown data</div>'; 
      return; 
    }
    
    const total = b.total || sum(cats.map(c=>Number(c.value)||0)) || 1;
    
    cats.forEach(c => {
      const val = Number(c.value)||0;
      const pct = Math.round((val/total)*100);
      const row = H('div','breakdown-item');
      row.innerHTML = `
        <div class="breakdown-header">
          <span class="breakdown-label">${c.label || '—'}</span>
          <span class="breakdown-value">
            <span class="breakdown-amount">${fmtMoneyShort(val)}</span>
            <span class="breakdown-percent">${pct}%</span>
          </span>
        </div>
        <div class="breakdown-bar-bg">
          <div class="breakdown-bar-fill" style="width:${pct}%"></div>
        </div>`;
      wrap.appendChild(row);
    });
  }

  function renderReports() {
    const container = $('#reports_container');
    if (!container) return;
    
    const r = state.reports || {};
    
    const grantCard = container.querySelector('.report-stat-card:nth-child(1) .report-stat-value');
    const dueCard = container.querySelector('.report-stat-card:nth-child(2) .report-stat-value');
    const lastCard = container.querySelector('.report-stat-card:nth-child(3) .report-stat-value');
    
    if (grantCard) grantCard.textContent = r.grantId ? String(r.grantId) : '—';
    if (dueCard) dueCard.textContent = r.nextDue || '—';
    if (lastCard) lastCard.textContent = r.lastSubmitted || '—';
  }

  function renderKeywords() {
    const wrap = $('#keywords_section'); 
    if (!wrap) return;
    
    wrap.innerHTML = '';
    
    if (!state.keywords?.length) {
      wrap.innerHTML = '<div class="empty-state"><i class="ki-duotone ki-tag d-block"><span class="path1"></span><span class="path2"></span></i>No keywords yet</div>';
      return;
    }
    
    state.keywords.forEach(k => {
      const pill = H('span','pill', k);
      wrap.appendChild(pill);
    });
  }

  function renderAll() {
    renderTotals();
    renderGrantsTable();
    renderLastAwarded();
    renderBreakdown();
    renderReports();
    renderKeywords();
    renderGrantsSummary();
    reflectEditMode();
  }

  /* ----------------------- grant details popup ----------------------- */
  function buildGrantDetailsView(g) {
    const wrap = H('div','grant-details-view');
    
    const awarded  = amountAwarded(g);
    const received = amountReceived(g);
    const spent    = amountSpent(g);
    const status   = received > 0 ? 'Active' : 'Pending';
    const statusClass = received > 0 ? 'grant-status-active' : 'grant-status-pending';

    wrap.innerHTML = `
      <div class="grant-details-header">
        <h4 class="grant-details-title">${g.title || 'Untitled Grant'}</h4>
        <span class="grant-status-badge ${statusClass}">${status}</span>
      </div>
      
      <div class="grant-details-grid">
        <div class="grant-detail-cell">
          <div class="grant-detail-cell-label">Grant ID</div>
          <div class="grant-detail-cell-value">${g.id || g.grantId || '—'}</div>
        </div>
        <div class="grant-detail-cell">
          <div class="grant-detail-cell-label">Agency</div>
          <div class="grant-detail-cell-value">${g.agency || '—'}</div>
        </div>
        <div class="grant-detail-cell">
          <div class="grant-detail-cell-label">Type</div>
          <div class="grant-detail-cell-value">${g.type || '—'}</div>
        </div>
        <div class="grant-detail-cell">
          <div class="grant-detail-cell-label">Duration</div>
          <div class="grant-detail-cell-value">${g.duration || '—'}</div>
        </div>
        <div class="grant-detail-cell">
          <div class="grant-detail-cell-label">Amount Awarded</div>
          <div class="grant-detail-cell-value grant-detail-amount">${fmtMoney(awarded)}</div>
        </div>
        <div class="grant-detail-cell">
          <div class="grant-detail-cell-label">Amount Received</div>
          <div class="grant-detail-cell-value grant-detail-amount">${fmtMoney(received)}</div>
        </div>
        <div class="grant-detail-cell">
          <div class="grant-detail-cell-label">Amount Spent</div>
          <div class="grant-detail-cell-value grant-detail-amount">${fmtMoney(spent)}</div>
        </div>
        <div class="grant-detail-cell">
          <div class="grant-detail-cell-label">Awarded Date</div>
          <div class="grant-detail-cell-value">${g.awardedAt ? new Date(g.awardedAt).toLocaleDateString() : '—'}</div>
        </div>
      </div>
      
      ${(g.tags||g.keywords||[]).length > 0 ? `
        <div class="grant-details-section">
          <div class="grant-details-section-title">Tags</div>
          <div class="grant-tags-wrap">
            ${(g.tags||g.keywords||[]).map(t => `<span class="pill">${t}</span>`).join('')}
          </div>
        </div>
      ` : ''}
      
      ${g.url || g.link ? `
        <div class="grant-details-section">
          <a href="${g.url || g.link}" class="btn btn-light-primary" target="_blank" rel="noopener">
            <i class="ki-duotone ki-arrow-up-right"><span class="path1"></span><span class="path2"></span></i>
            Open Grant Link
          </a>
        </div>
      ` : ''}
    `;

    return wrap;
  }

  function showGrantDetails(g) {
    const bodyNode = buildGrantDetailsView(g);
    openViewModal('Grant Details', bodyNode);
  }

  function openViewModal(title, bodyNode) {
    ensureModal();
    $('#grants_modal .modal-title').textContent = title;
    const body = $('#grants_modal_body'); body.innerHTML = ''; body.appendChild(bodyNode);

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

    if (!window.bootstrap || !window.bootstrap.Modal) return;
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
  function reflectEditMode(){
    const t = $('#editToggle'); if (t) t.textContent = editMode ? 'Done' : 'Edit';
    $$('.box-edit-btn').forEach(b => b.classList.toggle('d-none', !editMode));
  }
  function wireEditToggle(){
    on($('#editToggle'), 'click', (e)=>{
      e.preventDefault();
      editMode = !editMode;
      reflectEditMode();
    });
  }

  function ensureTinyButtons() {
    const cfgs = [
      { anchor:'#total_grants_awarded', title:'Edit Totals',       build: buildTotalsModal },
      { anchor:'#grants_tbody',         title:'Edit All Grants',   build: buildAllGrantsModal },
      { anchor:'#last_awarded_grant',   title:'Edit Last Awarded', build: buildLastAwardedModal },
      { anchor:'#breakdown',            title:'Edit Breakdown',    build: buildBreakdownModal },
      { anchor:'#reports_container',    title:'Edit Reports',      build: buildReportsModal },
      { anchor:'#keywords_section',     title:'Edit Keywords',     build: buildKeywordsModal },
    ];
    cfgs.forEach(cfg => {
      const anchorEl = document.querySelector(cfg.anchor);
      const card = anchorEl?.closest('.card');
      const header = card?.querySelector('.card-header');
      if (!header) return;
      header.querySelectorAll('.box-edit-btn').forEach(b => b.remove());
      let rail = header.querySelector('.card-toolbar'); 
      if (!rail) { rail = H('div','card-toolbar'); header.appendChild(rail); }
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
      await onSave();
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
            <input class="grant-awarded form-control" value="${amountAwarded(g)}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Awarded Date</label>
            <input class="grant-awardedAt form-control" type="date" value="${g.awardedAt ? new Date(g.awardedAt).toISOString().slice(0,10) : ''}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Amount Received</label>
            <input class="grant-received form-control" value="${amountReceived(g)}">
          </div>
          <div class="col-md-3">
            <label class="form-label">Amount Spent</label>
            <input class="grant-spent form-control" value="${amountSpent(g)}">
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
        <div class="col-md-3"><label class="form-label">Amount Awarded</label><input id="la_awarded" class="form-control" value="${amountAwarded(g)}"></div>
        <div class="col-md-3"><label class="form-label">Awarded Date</label><input id="la_awardedAt" type="date" class="form-control" value="${g.awardedAt ? new Date(g.awardedAt).toISOString().slice(0,10) : ''}"></div>

        <div class="col-md-3"><label class="form-label">Amount Received</label><input id="la_received" class="form-control" value="${amountReceived(g)}"></div>
        <div class="col-md-3"><label class="form-label">Amount Spent</label><input id="la_spent" class="form-control" value="${amountSpent(g)}"></div>
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
    const add = H('button','btn btn-light mt-2','+ Add row'); 
    add.addEventListener('click',()=>list.appendChild(row()));
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
    console.log('🚀 Grants.js loaded');
    await load();
    ensureTinyButtons();
    wireEditToggle();
    renderAll();
    window.dispatchEvent(new CustomEvent('galaxy:grants:updated'));
  });
})();