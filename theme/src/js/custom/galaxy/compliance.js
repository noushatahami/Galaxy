(() => {
  /* ----------------------- utils ----------------------- */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const H  = (t, c='', html='') => { const n=document.createElement(t); if(c)n.className=c; if(html!=null)n.innerHTML=html; return n; };
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '0.0.0.0')
    ? 'http://127.0.0.1:3001/api' : '/api';
  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d); return isNaN(dt) ? String(d) : dt.toLocaleDateString();
  };

  /* ----------------------- state ----------------------- */
  let editMode = false;
  const state = {
    checkpoints: [],     // [{id,title,status,lastReviewed,link}]
    audits: [],          // [{id,name,date,score,tags:[]}]
    notes: [],           // ["text", ...] or [{text, date}]
    summary: { compliant:0, pending:0, noncompliant:0 },
    quickActions: [],    // ["Upload SOC2 evidence", ...] or [{label, href}]
    contacts: []         // [{name, role, avatar}]
  };

  /* ----------------------- helpers ----------------------- */
  function normalizeStatus(s){
    if(!s) return '';
    const x = String(s).toLowerCase();
    if (['pass','ok','yes','done','complete','compliant'].includes(x)) return 'compliant';
    if (['pending','todo','in-progress','inprogress','open','review'].includes(x)) return 'pending';
    if (['fail','failed','noncompliant','non-compliant','issue','risk','blocked'].includes(x)) return 'noncompliant';
    return x;
  }

  // Recompute summary primarily from checkpoints. If zero checkpoints, keep server-provided summary.
  function recomputeSummaryFromCheckpoints(){
    const cps = Array.isArray(state.checkpoints) ? state.checkpoints : [];
    if (!cps.length) return; // nothing to recompute
    let compliant=0, pending=0, noncompliant=0;
    cps.forEach(cp=>{
      const st = normalizeStatus(cp.status);
      if (st === 'compliant') compliant++;
      else if (st === 'pending' || st === '') pending++; // blank treated as pending
      else noncompliant++;
    });
    state.summary = { compliant, pending, noncompliant };
  }

  /* ----------------------- persistence ----------------------- */
  function save(){ localStorage.setItem('galaxy_compliance', JSON.stringify(state)); }
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

    // 1) Soft-load cache first (but don't trust it if a new CV was uploaded)
    const cached = localStorage.getItem('galaxy_compliance');
    if (cached && !hasCV) {
      try { Object.assign(state, JSON.parse(cached)); } catch {}
    }

    // 2) Prefer API (CV-backed). Any successful fetch overrides current state.
    try {
      // unified object first
      const rootResp = await fetch(`${API}/compliance`);
      if (rootResp.ok) {
        const root = await rootResp.json();
        if (root.summary)       state.summary = root.summary;
        if (Array.isArray(root.quick_actions)) state.quickActions = root.quick_actions;
        if (Array.isArray(root.key_contacts))  state.keyContacts  = root.key_contacts;
        if (Array.isArray(root.checkpoints))   state.checkpoints  = root.checkpoints;
        if (Array.isArray(root.audits))        state.audits       = root.audits;
        if (Array.isArray(root.notes))         state.notes        = root.notes;
      }

      // granular endpoints (override pieces if they exist)
      const [summary, checkpoints, audits, notes, actions, contacts] = await Promise.allSettled([
        fetch(`${API}/compliance/summary`),
        fetch(`${API}/compliance/checkpoints`),
        fetch(`${API}/compliance/audits`),
        fetch(`${API}/compliance/notes`),
        fetch(`${API}/compliance/quick-actions`),
        fetch(`${API}/compliance/contacts`)
      ]);

      if (summary.status==='fulfilled' && summary.value.ok) {
        state.summary = await summary.value.json();
      }
      if (checkpoints.status==='fulfilled' && checkpoints.value.ok) {
        const d = await checkpoints.value.json();
        state.checkpoints = d.items || d || [];
      }
      if (audits.status==='fulfilled' && audits.value.ok) {
        const d = await audits.value.json();
        state.audits = d.items || d || [];
      }
      if (notes.status==='fulfilled' && notes.value.ok) {
        const d = await notes.value.json();
        state.notes = d.items || d || [];
      }
      if (actions.status==='fulfilled' && actions.value.ok) {
        const d = await actions.value.json();
        state.quickActions = d.items || d || [];
      }
      if (contacts.status==='fulfilled' && contacts.value.ok) {
        const d = await contacts.value.json();
        state.keyContacts = d.items || d || [];
      }
    } catch {
      // swallow; we'll try static next
    }

    // 3) Static fallback
    if (!state.summary && !state.checkpoints?.length && !state.audits?.length) {
      try {
        const r = await fetch('data/compliance.json', { cache: 'no-store' });
        if (r.ok) Object.assign(state, await r.json());
      } catch {}
    }

    // 4) Final safety defaults so UI never breaks
    state.summary = state.summary || { compliant: 0, pending: 0, noncompliant: 0 };
    state.checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
    state.audits      = Array.isArray(state.audits)      ? state.audits      : [];
    state.notes       = Array.isArray(state.notes)       ? state.notes       : [];
    state.quickActions= Array.isArray(state.quickActions)? state.quickActions: [];
    state.keyContacts = Array.isArray(state.keyContacts) ? state.keyContacts : [];

    // 5) Recompute summary from live checkpoints if we have them
    recomputeSummaryFromCheckpoints();

    // 6) Cache the good stuff for snappy reloads
    try { localStorage.setItem('galaxy_compliance', JSON.stringify(state)); } catch {}
  }

  /* ----------------------- renderers ----------------------- */
  function renderCheckpoints(){
    const wrap = $('#checkpoints_list'); if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.checkpoints?.length) { wrap.appendChild(H('div','text-gray-400','—')); return; }
    state.checkpoints.forEach(cp=>{
      const box = H('div','rounded border border-white/10 p-3 bg-white/5','');
      const row = H('div','d-flex align-items-center justify-content-between','');
      const st = normalizeStatus(cp.status);
      const statusIcon = st === 'compliant' ? '✅' : (st === 'pending' ? '⏳' : (st ? '⚠️' : ''));
      row.appendChild(H('div','fw-semibold', `${cp.title || '—'} ${statusIcon ? `<span class="ms-2">${statusIcon}</span>` : ''}`));
      const btn = cp.link
        ? H('a','btn btn-sm btn-light','View Details')
        : H('button','btn btn-sm btn-light','View Details');
      if (cp.link) btn.href = cp.link, btn.target = '_blank';
      row.appendChild(btn);
      box.appendChild(row);
      box.appendChild(H('div','text-gray-400 fs-8 mt-1', `Last Reviewed: ${fmtDate(cp.lastReviewed)}`));
      wrap.appendChild(box);
    });
  }

  function renderAudits(){
    const wrap = $('#audits_list'); if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.audits?.length) { wrap.appendChild(H('div','text-gray-400','—')); return; }
    state.audits.forEach(a=>{
      const box = H('div','ps-3 border-start border-3 border-secondary','');
      box.appendChild(H('div','fw-semibold', a.name || 'Audit'));
      box.appendChild(H('div','text-gray-400 fs-8', `Date: ${fmtDate(a.date)}  |  Score: ${a.score ?? '—'}`));
      const tags = Array.isArray(a.tags) ? a.tags : [];
      if (tags.length){
        const t = H('div','mt-2','');
        tags.forEach(tag => t.appendChild(H('span','badge bg-success bg-opacity-20 text-success me-1 mb-1', tag)));
        box.appendChild(t);
      }
      wrap.appendChild(box);
    });
  }

  function renderNotes(){
    const wrap = $('#notes_list'); if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.notes?.length) { wrap.appendChild(H('div','text-gray-400','—')); return; }
    state.notes.forEach(n=>{
      const text = typeof n === 'string' ? n : (n.text || '—');
      wrap.appendChild(H('div','text-gray-200', text));
    });
  }

  function renderSummary(){
    const s = state.summary || {};
    const c = $('#summary_compliant'), p = $('#summary_pending'), n = $('#summary_noncompliant');
    if (c) c.textContent = String(s.compliant ?? 0);
    if (p) p.textContent = String(s.pending ?? 0);
    if (n) n.textContent = String(s.noncompliant ?? 0);

    // Totals + percents
    const total = (s.compliant||0) + (s.pending||0) + (s.noncompliant||0);
    const pct   = total ? Math.round((s.compliant||0) * 100 / total) : 0;
    const pctPending = total ? Math.round((s.pending||0) * 100 / total) : 0;
    const pctNon     = total ? Math.round((s.noncompliant||0) * 100 / total) : 0;

    // Donut ring
    const path = $('#summary_donut_path');
    const pctText = $('#summary_percent_text');
    const totalText = $('#summary_total_text');
    const CIRC = 2 * Math.PI * 64; // r=64 (matches HTML)
    if (path){
      const dash = (pct/100) * CIRC;
      path.setAttribute('stroke-dasharray', `${dash} ${CIRC - dash}`);
      // color shifts slightly based on compliance
      const color = pct >= 75 ? '#22c55e' : (pct >= 40 ? '#f59e0b' : '#ef4444');
      path.setAttribute('stroke', color);
    }
    if (pctText)   pctText.textContent = `${pct}%`;
    if (totalText) totalText.textContent = `${s.compliant||0} of ${total}`;

    // Mini-bars
    const g = $('#bar_green'), a = $('#bar_amber'), r = $('#bar_red');
    if (g) g.style.width = `${pct}%`;
    if (a) a.style.width = `${pctPending}%`;
    if (r) r.style.width = `${pctNon}%`;
  }

  function renderQuickActions(){
    const wrap = $('#quick_actions_list'); if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.quickActions?.length) { wrap.appendChild(H('div','text-gray-400','—')); return; }
    state.quickActions.forEach(a=>{
      const label = typeof a === 'string' ? a : (a.label || 'Action');
      const href  = typeof a === 'object' ? a.href : null;
      const btn = href
        ? H('a','text-start px-3 py-2 rounded bg-white/10 border border-white/10 d-block', label)
        : H('button','text-start px-3 py-2 rounded bg-white/10 border border-white/10', label);
      if (href) btn.href = href, btn.target = '_blank';
      wrap.appendChild(btn);
    });
  }

  function renderContacts(){
    const wrap = $('#key_contacts_list'); if (!wrap) return;
    wrap.innerHTML = '';
    if (!state.contacts?.length) { wrap.appendChild(H('div','text-gray-400','—')); return; }
    state.contacts.forEach(c=>{
      const row = H('div','d-flex align-items-center gap-3','');
      const sym = H('div','symbol symbol-40px','');
      sym.appendChild(H('img','rounded-circle','')).src = c.avatar || 'assets/media/avatars/blank.png';
      const meta = H('div','lh-sm','');
      meta.appendChild(H('div','fw-semibold', c.name || '—'));
      meta.appendChild(H('div','text-gray-400 fs-8', c.role || '—'));
      row.appendChild(sym); row.appendChild(meta);
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
    reflectEditMode();
  }

  /* ----------------------- edit-mode shell ----------------------- */
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
  function ensureTinyButtons(){
    const cfgs = [
      { anchor:'#checkpoints_list',   title:'Edit Compliance Checkpoints', build: buildCheckpointsModal },
      { anchor:'#audits_list',        title:'Edit Recent Audits & Reviews', build: buildAuditsModal },
      { anchor:'#notes_list',         title:'Edit Compliance Notes',       build: buildNotesModal },
      { anchor:'#summary_compliant',  title:'Edit Compliance Summary',     build: buildSummaryModal },
      { anchor:'#quick_actions_list', title:'Edit Quick Actions',          build: buildQuickActionsModal },
      { anchor:'#key_contacts_list',  title:'Edit Key Contacts',           build: buildContactsModal },
    ];
    cfgs.forEach(cfg=>{
      const el = document.querySelector(cfg.anchor);
      const card = el?.closest('.card');
      const header = card?.querySelector('.card-header');
      if (!header) return;
      header.querySelectorAll('.box-edit-btn').forEach(b => b.remove());
      let rail = header.querySelector('.card-toolbar'); if (!rail) { rail = H('div','card-toolbar'); header.appendChild(rail); }
      const btn = H('button','btn btn-sm btn-light box-edit-btn d-none','Edit');
      btn.addEventListener('click', ()=> openModal(cfg.title, ...cfg.build()));
      rail.appendChild(btn);
    });
  }

  /* ----------------------- shared modal ----------------------- */
  let bsModal;
  function ensureModal(){
    if ($('#compliance_modal')) return;
    const shell = H('div','modal fade','');
    shell.id = 'compliance_modal'; shell.tabIndex = -1;
    shell.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-xl">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">Edit</h3>
            <button type="button" class="btn btn-icon btn-sm btn-light" data-bs-dismiss="modal" aria-label="Close">
              <span class="fs-2 fw-bold" style="line-height:1;color:#111827;">×</span>
            </button>
          </div>
          <div class="modal-body"><div id="compliance_modal_body"></div></div>
          <div class="modal-footer">
            <button id="compliance_modal_save" class="btn btn-primary">Save</button>
            <button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(shell);
    bsModal = new bootstrap.Modal(shell);
  }
  function openModal(title, bodyNode, onSave){
    ensureModal();
    $('#compliance_modal .modal-title').textContent = title;
    const body = $('#compliance_modal_body'); body.innerHTML = ''; body.appendChild(bodyNode);
    const old = $('#compliance_modal_save');
    const neo = old.cloneNode(true);
    old.parentNode.replaceChild(neo, old);
    neo.addEventListener('click', async ()=>{
      await onSave();                              // copy inputs -> state

      // After edits, recompute summary from checkpoints so numbers/visuals stay in sync
      recomputeSummaryFromCheckpoints();

      await persistPage('compliance', {            // push to /api/page
        summary: state.summary,
        quick_actions: state.quickActions,
        key_contacts: state.keyContacts,
        checkpoints: state.checkpoints,
        audits: state.audits,
        notes: state.notes
      });
      save();                                      // keep local cache
      renderAll();
      bsModal.hide();
    });
    bsModal.show();
  }
  function section(title){
    const wrap = H('div','mb-6','');
    wrap.appendChild(H('div','fw-bold fs-5 mb-3', title));
    const box = H('div','p-4 rounded bg-white bg-opacity-5 border border-white border-opacity-10','');
    wrap.appendChild(box);
    return {wrap, box};
  }

  /* ----------------------- modals ----------------------- */
  function buildCheckpointsModal(){
    const {wrap, box} = section('Compliance Checkpoints');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (cp={})=>{
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-lg-4"><input class="form-control" placeholder="Title" value="${cp.title||''}"></div>
        <div class="col-lg-2">
          <select class="form-select">
            <option value="" ${!cp.status?'selected':''}>—</option>
            <option value="compliant" ${normalizeStatus(cp.status)==='compliant'?'selected':''}>Compliant</option>
            <option value="pending" ${normalizeStatus(cp.status)==='pending'?'selected':''}>Pending</option>
            <option value="noncompliant" ${normalizeStatus(cp.status)==='noncompliant'?'selected':''}>Non-Compliant</option>
          </select>
        </div>
        <div class="col-lg-2"><input type="date" class="form-control" value="${cp.lastReviewed ? new Date(cp.lastReviewed).toISOString().slice(0,10) : ''}"></div>
        <div class="col-lg-3"><input class="form-control" placeholder="Link (optional)" value="${cp.link||''}"></div>
        <div class="col-lg-1 d-grid"><button class="btn btn-light-danger">X</button></div>`;
      on(r.querySelector('.btn-light-danger'),'click',()=>r.remove());
      return r;
    };

    (state.checkpoints||[]).forEach(cp=>list.appendChild(row(cp)));
    const add = H('button','btn btn-light mt-2','+ Add checkpoint'); on(add,'click',()=>list.appendChild(row({})));
    box.appendChild(list); box.appendChild(add);

    const onSave = ()=>{
      const items = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const [titleEl, statusEl, dateEl, linkEl] = r.querySelectorAll('input, select');
        const title = titleEl.value.trim();
        const status = statusEl.value || undefined;
        const lastReviewed = dateEl.value || undefined;
        const link = linkEl.value.trim() || undefined;
        if (title) items.push({ title, status, lastReviewed, link });
      });
      state.checkpoints = items;
    };
    return [wrap, onSave];
  }

  function buildAuditsModal(){
    const {wrap, box} = section('Recent Audits & Reviews');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (a={})=>{
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-md-4"><input class="form-control" placeholder="Name" value="${a.name||''}"></div>
        <div class="col-md-3"><input type="date" class="form-control" value="${a.date ? new Date(a.date).toISOString().slice(0,10) : ''}"></div>
        <div class="col-md-2"><input class="form-control" placeholder="Score" value="${a.score ?? ''}"></div>
        <div class="col-md-2"><input class="form-control" placeholder="Tags (comma)" value="${(a.tags||[]).join(', ')}"></div>
        <div class="col-md-1 d-grid"><button class="btn btn-light-danger">X</button></div>`;
      on(r.querySelector('.btn-light-danger'),'click',()=>r.remove());
      return r;
    };

    (state.audits||[]).forEach(a=>list.appendChild(row(a)));
    const add = H('button','btn btn-light mt-2','+ Add audit'); on(add,'click',()=>list.appendChild(row({})));
    box.appendChild(list); box.appendChild(add);

    const onSave = ()=>{
      const items = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const [nameEl, dateEl, scoreEl, tagsEl] = r.querySelectorAll('input');
        const name  = nameEl.value.trim();
        const date  = dateEl.value || '';
        const score = scoreEl.value.trim();
        const tags  = tagsEl.value.split(',').map(s=>s.trim()).filter(Boolean);
        if (name) items.push({ name, date, score, tags });
      });
      state.audits = items;
    };
    return [wrap, onSave];
  }

  function buildNotesModal(){
    const {wrap, box} = section('Compliance Notes (one per line)');
    const ta = H('textarea','form-control', (state.notes||[]).map(n => typeof n==='string' ? n : (n.text||'')).join('\n'));
    ta.rows = 10;
    box.appendChild(ta);
    const onSave = ()=>{
      const lines = ta.value.split('\n').map(s=>s.trim()).filter(Boolean);
      state.notes = lines;
    };
    return [wrap, onSave];
  }

  function buildSummaryModal(){
    const {wrap, box} = section('Compliance Summary');
    const s = state.summary || {};
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-4"><label class="form-label">Compliant</label><input id="sum_c" class="form-control" value="${s.compliant ?? 0}"></div>
        <div class="col-md-4"><label class="form-label">Pending</label><input id="sum_p" class="form-control" value="${s.pending ?? 0}"></div>
        <div class="col-md-4"><label class="form-label">Non-Compliant</label><input id="sum_n" class="form-control" value="${s.noncompliant ?? 0}"></div>
      </div>`;
    const onSave = ()=>{
      state.summary = {
        compliant: Number($('#sum_c').value||0)||0,
        pending: Number($('#sum_p').value||0)||0,
        noncompliant: Number($('#sum_n').value||0)||0
      };
    };
    return [wrap, onSave];
  }

  function buildQuickActionsModal(){
    const {wrap, box} = section('Quick Actions');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (label='', href='')=>{
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-md-7"><input class="form-control" placeholder="Label" value="${label}"></div>
        <div class="col-md-4"><input class="form-control" placeholder="Link (optional)" value="${href}"></div>
        <div class="col-md-1 d-grid"><button class="btn btn-light-danger">X</button></div>`;
      on(r.querySelector('button'),'click',()=>r.remove());
      return r;
    };

    (state.quickActions||[]).forEach(a=>{
      if (typeof a === 'string') list.appendChild(row(a, ''));
      else list.appendChild(row(a.label||'', a.href||''));
    });
    const add = H('button','btn btn-light mt-2','+ Add action'); on(add,'click',()=>list.appendChild(row()));
    box.appendChild(list); box.appendChild(add);

    const onSave = ()=>{
      const items = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const [labelEl, hrefEl] = r.querySelectorAll('input');
        const label = labelEl.value.trim();
        const href  = hrefEl.value.trim();
        if (label) items.push(href ? { label, href } : label);
      });
      state.quickActions = items;
    };
    return [wrap, onSave];
  }

  function buildContactsModal(){
    const {wrap, box} = section('Key Contacts');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (c={})=>{
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-md-4"><input class="form-control" placeholder="Name" value="${c.name||''}"></div>
        <div class="col-md-4"><input class="form-control" placeholder="Role" value="${c.role||''}"></div>
        <div class="col-md-3"><input class="form-control" placeholder="Avatar URL" value="${c.avatar||''}"></div>
        <div class="col-md-1 d-grid"><button class="btn btn-light-danger">X</button></div>`;
      on(r.querySelector('button'),'click',()=>r.remove());
      return r;
    };

    (state.contacts||[]).forEach(c=>list.appendChild(row(c)));
    const add = H('button','btn btn-light mt-2','+ Add contact'); on(add,'click',()=>list.appendChild(row()));
    box.appendChild(list); box.appendChild(add);

    const onSave = ()=>{
      const items = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const [nameEl, roleEl, avatarEl] = r.querySelectorAll('input');
        const name   = nameEl.value.trim();
        const role   = roleEl.value.trim();
        const avatar = avatarEl.value.trim();
        if (name) items.push({ name, role, avatar });
      });
      state.contacts = items;
    };
    return [wrap, onSave];
  }

  /* ----------------------- boot ----------------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    ensureTinyButtons();
    wireEditToggle();
    renderAll();
  });
})();
