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
    checkpoints: [],
    audits: [],
    notes: [],
    summary: { compliant:0, pending:0, noncompliant:0 },
    quickActions: [],
    contacts: []
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

  function recomputeSummaryFromCheckpoints(){
    const cps = Array.isArray(state.checkpoints) ? state.checkpoints : [];
    if (!cps.length) return;
    let compliant=0, pending=0, noncompliant=0;
    cps.forEach(cp=>{
      const st = normalizeStatus(cp.status);
      if (st === 'compliant') compliant++;
      else if (st === 'pending' || st === '') pending++;
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

    const cached = localStorage.getItem('galaxy_compliance');
    if (cached && !hasCV) {
      try { Object.assign(state, JSON.parse(cached)); } catch {}
    }

    try {
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
    } catch {}

    if (!state.summary && !state.checkpoints?.length && !state.audits?.length) {
      try {
        const r = await fetch('data/compliance.json', { cache: 'no-store' });
        if (r.ok) Object.assign(state, await r.json());
      } catch {}
    }

    state.summary = state.summary || { compliant: 0, pending: 0, noncompliant: 0 };
    state.checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : [];
    state.audits      = Array.isArray(state.audits)      ? state.audits      : [];
    state.notes       = Array.isArray(state.notes)       ? state.notes       : [];
    state.quickActions= Array.isArray(state.quickActions)? state.quickActions: [];
    state.keyContacts = Array.isArray(state.keyContacts) ? state.keyContacts : [];

    recomputeSummaryFromCheckpoints();

    try { localStorage.setItem('galaxy_compliance', JSON.stringify(state)); } catch {}
  }

  /* ----------------------- renderers ----------------------- */
  function renderCheckpoints(){
    const wrap = $('#checkpoints_list'); if (!wrap) return;
    wrap.innerHTML = '';
    
    if (!state.checkpoints?.length) {
      wrap.innerHTML = '<div class="empty-state"><i class="ki-duotone ki-shield-tick d-block"><span class="path1"></span><span class="path2"></span></i>No checkpoints defined</div>';
      return;
    }
    
    state.checkpoints.forEach(cp=>{
      const st = normalizeStatus(cp.status);
      const statusClass = st === 'compliant' ? 'checkpoint-compliant' : (st === 'pending' ? 'checkpoint-pending' : 'checkpoint-noncompliant');
      const statusIcon = st === 'compliant' ? 'ki-shield-tick' : (st === 'pending' ? 'ki-time' : 'ki-information');
      
      const card = H('div', `checkpoint-card ${statusClass}`);
      card.innerHTML = `
        <div class="checkpoint-header">
          <div class="checkpoint-title">
            <i class="ki-duotone ${statusIcon} fs-2"><span class="path1"></span><span class="path2"></span></i>
            <span>${cp.title || '—'}</span>
          </div>
          ${cp.link ? `<a href="${cp.link}" target="_blank" class="btn btn-sm btn-light">View Details</a>` : '<button class="btn btn-sm btn-light">View Details</button>'}
        </div>
        <div class="checkpoint-meta">
          <span class="checkpoint-date">Last Reviewed: ${fmtDate(cp.lastReviewed)}</span>
        </div>
      `;
      wrap.appendChild(card);
    });
  }

  function renderAudits(){
    const wrap = $('#audits_list'); if (!wrap) return;
    wrap.innerHTML = '';
    
    if (!state.audits?.length) {
      wrap.innerHTML = '<div class="empty-state"><i class="ki-duotone ki-document d-block"><span class="path1"></span><span class="path2"></span></i>No audits recorded</div>';
      return;
    }
    
    state.audits.forEach(a=>{
      const card = H('div', 'audit-card');
      const tags = Array.isArray(a.tags) ? a.tags : [];
      
      card.innerHTML = `
        <div class="audit-header">
          <div class="audit-name">${a.name || 'Audit'}</div>
          <div class="audit-score">${a.score ?? '—'}</div>
        </div>
        <div class="audit-date">${fmtDate(a.date)}</div>
        ${tags.length ? `<div class="audit-tags">${tags.map(tag => `<span class="pill">${tag}</span>`).join('')}</div>` : ''}
      `;
      wrap.appendChild(card);
    });
  }

  function renderNotes(){
    const wrap = $('#notes_list'); if (!wrap) return;
    wrap.innerHTML = '';
    
    if (!state.notes?.length) {
      wrap.innerHTML = '<div class="empty-state"><i class="ki-duotone ki-notepad d-block"><span class="path1"></span><span class="path2"></span><span class="path3"></span><span class="path4"></span><span class="path5"></span></i>No compliance notes</div>';
      return;
    }
    
    const list = H('ul', 'info-list');
    state.notes.forEach(n=>{
      const text = typeof n === 'string' ? n : (n.text || '—');
      const li = H('li', 'info-list-item');
      li.innerHTML = `
        <div class="info-list-item-icon">
          <i class="ki-duotone ki-note-2 fs-3"><span class="path1"></span><span class="path2"></span><span class="path3"></span><span class="path4"></span></i>
        </div>
        <div class="info-list-item-content">
          <div class="info-list-item-text">${text}</div>
        </div>
      `;
      list.appendChild(li);
    });
    wrap.appendChild(list);
  }

  function renderSummary(){
    const s = state.summary || {};
    const c = $('#summary_compliant'), p = $('#summary_pending'), n = $('#summary_noncompliant');
    if (c) c.textContent = String(s.compliant ?? 0);
    if (p) p.textContent = String(s.pending ?? 0);
    if (n) n.textContent = String(s.noncompliant ?? 0);

    const total = (s.compliant||0) + (s.pending||0) + (s.noncompliant||0);
    const pct   = total ? Math.round((s.compliant||0) * 100 / total) : 0;
    const pctPending = total ? Math.round((s.pending||0) * 100 / total) : 0;
    const pctNon     = total ? Math.round((s.noncompliant||0) * 100 / total) : 0;

    const path = $('#summary_donut_path');
    const pctText = $('#summary_percent_text');
    const totalText = $('#summary_total_text');
    const CIRC = 2 * Math.PI * 64;
    if (path){
      const dash = (pct/100) * CIRC;
      path.setAttribute('stroke-dasharray', `${dash} ${CIRC - dash}`);
      const color = pct >= 75 ? '#22c55e' : (pct >= 40 ? '#f59e0b' : '#ef4444');
      path.setAttribute('stroke', color);
    }
    if (pctText)   pctText.textContent = `${pct}%`;
    if (totalText) totalText.textContent = `${s.compliant||0} of ${total}`;

    const g = $('#bar_green'), a = $('#bar_amber'), r = $('#bar_red');
    if (g) g.style.width = `${pct}%`;
    if (a) a.style.width = `${pctPending}%`;
    if (r) r.style.width = `${pctNon}%`;
  }

  function renderQuickActions(){
    const wrap = $('#quick_actions_list'); if (!wrap) return;
    wrap.innerHTML = '';
    
    if (!state.quickActions?.length) {
      wrap.innerHTML = '<div class="empty-state"><i class="ki-duotone ki-rocket d-block"><span class="path1"></span><span class="path2"></span></i>No quick actions</div>';
      return;
    }
    
    const list = H('div', 'quick-actions-list');
    state.quickActions.forEach(a=>{
      const label = typeof a === 'string' ? a : (a.label || 'Action');
      const href  = typeof a === 'object' ? a.href : null;
      
      const item = H('div', 'quick-action-item');
      item.innerHTML = `
        <i class="ki-duotone ki-arrow-right fs-3"><span class="path1"></span><span class="path2"></span></i>
        <span>${label}</span>
      `;
      
      if (href) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => window.open(href, '_blank'));
      }
      
      list.appendChild(item);
    });
    wrap.appendChild(list);
  }

  function renderContacts(){
    const wrap = $('#key_contacts_list'); if (!wrap) return;
    wrap.innerHTML = '';
    
    if (!state.contacts?.length) {
      wrap.innerHTML = '<div class="empty-state"><i class="ki-duotone ki-profile-user d-block"><span class="path1"></span><span class="path2"></span><span class="path3"></span><span class="path4"></span></i>No contacts listed</div>';
      return;
    }
    
    const list = H('div', 'contacts-list');
    state.contacts.forEach(c=>{
      const item = H('div', 'contact-item');
      item.innerHTML = `
        <img src="${c.avatar || 'assets/media/avatars/blank.png'}" alt="${c.name}" class="contact-avatar">
        <div class="contact-info">
          <div class="contact-name">${c.name || '—'}</div>
          <div class="contact-role">${c.role || '—'}</div>
        </div>
      `;
      list.appendChild(item);
    });
    wrap.appendChild(list);
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
      await onSave();
      recomputeSummaryFromCheckpoints();
      await persistPage('compliance', {
        summary: state.summary,
        quick_actions: state.quickActions,
        key_contacts: state.keyContacts,
        checkpoints: state.checkpoints,
        audits: state.audits,
        notes: state.notes
      });
      save();
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