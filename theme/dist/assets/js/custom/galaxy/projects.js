// theme/src/js/custom/galaxy/projects.js
(() => {
  /* ----------------------- utils ----------------------- */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const H  = (t, c='', html='') => { const n=document.createElement(t); if(c)n.className=c; if(html!=null)n.innerHTML=html; return n; };
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  // DEV/PROD API base — treat localhost, 127.0.0.1, 0.0.0.0 as local
  const API = (['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname))
    ? 'http://127.0.0.1:3001/api'
    : '/api';

  const fmtMoney = (n) => (n==null || n===''
    ? '—'
    : Number(n).toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:0 })
  );
  const fmtPct = (n) => (n==null || n==='') ? '—' : `${Number(n)}%`;
  const safeText = (v, d='—') => (v==null || v==='') ? d : v;

  // --- donut driver (works with or without the global window.setSnapshotProgress) ---
  function driveDonut(percent, color){
    const p = Math.max(0, Math.min(100, Number(percent ?? 0) || 0));
    if (typeof window !== 'undefined' && typeof window.setSnapshotProgress === 'function') {
      window.setSnapshotProgress(p, color);
      return;
    }
    // Fallback: directly manipulate the inline SVG if global helper isn't present
    const ring  = document.querySelector('.snapshot-donut-ring');
    const label = document.getElementById('snapshot_donut_pct');
    if (ring){
      ring.style.strokeDasharray = `${p} ${100 - p}`;
      if (color) ring.style.stroke = color;
    }
    if (label){
      label.textContent = `${p}%`;
    }
  }

  /* ----------------------- state ----------------------- */
  let editMode = false;
  let currentSnapshotIndex = 0; // ✅ NEW: Track which project is shown in snapshot

  const state = {
    // tiles
    impact_points: { total: '', change: '', note: '' },
    total_budget: { amount: '', change: '', note: '' },

    // ✅ projects is now an array of project objects
    projects: [
      // { status, days_remaining, title, description, donut_percentage, tags: [{label}] }
    ],

    // additional project data
    next_deadline: { label: '', date: '' },
    messages: [
      // { name, time_ago, subject }
    ],
    latest_activity: [
      // { name, action, time_ago, avatar, approved }
    ]
  };

  /* ----------------------- persistence ----------------------- */
  function save() { localStorage.setItem('galaxy_projects', JSON.stringify(state)); }
  
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

    // 1) Soft-load cache first (only if no CV present)
    const local = localStorage.getItem('galaxy_projects');
    if (local && !hasCV) {
      try { Object.assign(state, JSON.parse(local)); } catch {}
    }

    // 2) Prefer unified API object (CV-backed)
    try {
      const rootResp = await fetch(`${API}/projects`);
      if (rootResp.ok) {
        const root = await rootResp.json();

        // Handle impact_points
        if (root.impact_points) {
          state.impact_points = {
            total: root.impact_points.total ?? '',
            change: root.impact_points.change ?? '',
            note: root.impact_points.note ?? ''
          };
        }

        // Handle total_budget
        if (root.total_budget) {
          state.total_budget = {
            amount: root.total_budget.amount ?? '',
            change: root.total_budget.change ?? '',
            note: root.total_budget.note ?? ''
          };
        }

        // Handle projects array
        if (Array.isArray(root.projects)) {
          state.projects = root.projects.map(p => ({
            status: p.status || 'active',
            days_remaining: Number(p.days_remaining || 0) || 0,
            title: p.title || '',
            description: p.description || '',
            donut_percentage: p.donut_percentage != null ? Number(p.donut_percentage) : null,
            tags: (p.tags || []).map(t => {
              if (typeof t === 'string') return { label: t };
              return { label: t.label || '' };
            }).filter(t => t.label)
          }));
        }

        // Handle next_deadline
        if (root.next_deadline) {
          state.next_deadline = {
            label: root.next_deadline.label || '',
            date: root.next_deadline.date || ''
          };
        }

        // Handle messages
        if (Array.isArray(root.messages)) {
          state.messages = root.messages.map(m => ({
            name: m.name || '',
            time_ago: m.time_ago || '',
            subject: m.subject || ''
          }));
        }

        // Handle latest_activity
        if (Array.isArray(root.latest_activity)) {
          state.latest_activity = root.latest_activity.map(a => ({
            name: a.name || '',
            action: a.action || '',
            time_ago: a.time_ago || '',
            avatar: a.avatar || '',
            approved: a.approved || false
          }));
        }
      }

      // 3) Optional granular overrides
      const [tiles, snapshot, activity, messages, deadline] = await Promise.allSettled([
        fetch(`${API}/projects/tiles`),
        fetch(`${API}/projects/snapshot`),
        fetch(`${API}/projects/activity`),
        fetch(`${API}/projects/messages`),
        fetch(`${API}/projects/deadline`)
      ]);

      if (tiles.status==='fulfilled' && tiles.value.ok) {
        const t = await tiles.value.json();
        if (t.impact) state.impact_points = t.impact;
        if (t.budget) state.total_budget = t.budget;
      }

      // Handle snapshot as a single project
      if (snapshot.status==='fulfilled' && snapshot.value.ok) {
        const snap = await snapshot.value.json();
        if (snap && Object.keys(snap).length > 0) {
          const snapProject = {
            status: snap.status || 'active',
            days_remaining: Number(snap.days_remaining || snap.days || 0) || 0,
            title: snap.title || '',
            description: snap.description || snap.desc || '',
            donut_percentage: snap.donut_percentage != null ? Number(snap.donut_percentage) : null,
            tags: (snap.tags || []).map(t => {
              if (typeof t === 'string') return { label: t };
              return { label: t.label || '' };
            }).filter(t => t.label)
          };
          
          if (!state.projects || state.projects.length === 0) {
            state.projects = [snapProject];
          }
        }
      }

      if (activity.status==='fulfilled' && activity.value.ok) {
        const a = await activity.value.json();
        state.latest_activity = a.items || a || [];
      }
      if (messages.status==='fulfilled' && messages.value.ok) {
        const m = await messages.value.json();
        state.messages = m.items || m || [];
      }
      if (deadline.status==='fulfilled' && deadline.value.ok) {
        state.next_deadline = await deadline.value.json();
      }
    } catch {}

    // 4) Static fallback
    if (!state.projects?.length) {
      try {
        const r = await fetch('data/projects.json', { cache:'no-store' });
        if (r.ok) Object.assign(state, await r.json());
      } catch {}
    }
  }

  /* ----------------------- renderers ----------------------- */
  function renderTiles() {
    const it = $('#impact_total');
    const ic = $('#impact_change');
    const inote = $('#impact_note');
    const ba = $('#budget_amount');
    const bc = $('#budget_change');
    const bnote = $('#budget_note');

    if (it) it.textContent = safeText(state.impact_points.total);
    if (ic) ic.textContent = safeText(state.impact_points.change);
    if (inote) inote.textContent = safeText(state.impact_points.note);
    if (ba) ba.textContent = fmtMoney(state.total_budget.amount);
    if (bc) bc.textContent = safeText(state.total_budget.change);
    if (bnote) bnote.textContent = safeText(state.total_budget.note);
  }

  function renderProjects() {
    const wrap = $('#projects_list');
    const cA = $('#count_active');
    const cH = $('#count_on_hold');
    const cS = $('#count_stopped');
    const cC = $('#count_completed');
    if (!wrap) return;

    wrap.innerHTML = '';
    const list = state.projects || [];
    if (!list.length) {
      wrap.innerHTML = '<div class="text-gray-400">—</div>';
    } else {
      list.forEach((p, index) => {
        const statusColors = {
          'active': '#20E3B2',
          'on_hold': '#F5A623',
          'stopped': '#A0A0A0',
          'completed': '#4A90E2'
        };
        const dot = statusColors[p.status] || '#20E3B2';
        const col = H('div','col-sm-6','');
        
        // ✅ NEW: Make project clickable
        const projectDiv = H('div','px-3 py-2 rounded bg-body-secondary', 
          `<span style="color:${dot}">●</span> ${safeText(p.title,'Untitled')}`
        );
        projectDiv.style.cursor = 'pointer';
        projectDiv.style.transition = 'all 0.2s ease';
        
        // Hover effect
        projectDiv.addEventListener('mouseenter', () => {
          projectDiv.style.backgroundColor = 'rgba(255,255,255,0.15)';
        });
        projectDiv.addEventListener('mouseleave', () => {
          projectDiv.style.backgroundColor = '';
        });
        
        // ✅ NEW: Click to show in snapshot
        projectDiv.addEventListener('click', () => {
          currentSnapshotIndex = index;
          renderSnapshot();
        });
        
        col.appendChild(projectDiv);
        wrap.appendChild(col);
      });
    }
    
    const active    = list.filter(p=>p.status==='active').length;
    const onHold    = list.filter(p=>p.status==='on_hold').length;
    const stopped   = list.filter(p=>p.status==='stopped').length;
    const completed = list.filter(p=>p.status==='completed').length;
    
    if (cA) cA.textContent = `(${active})`;
    if (cH) cH.textContent = `(${onHold})`;
    if (cS) cS.textContent = `(${stopped})`;
    if (cC) cC.textContent = `(${completed})`;
  }

  function renderSnapshot() {
    // ✅ Get the project at currentSnapshotIndex
    const projects = state.projects || [];
    const s = projects[currentSnapshotIndex] || {};

    const dot = $('#snapshot_status_dot');
    const st  = $('#snapshot_status');
    const sd  = $('#snapshot_days');
    const tt  = $('#snapshot_title');
    const ds  = $('#snapshot_desc');
    const tg  = $('#snapshot_tags');

    // Status color mapping
    const statusColors = {
      'active': '#20E3B2',
      'on_hold': '#F5A623',
      'stopped': '#A0A0A0',
      'completed': '#4A90E2'
    };
    const statusColor = statusColors[s.status] || '#20E3B2';

    if (dot) dot.style.color = statusColor;
    if (st)  st.textContent  = safeText(s.status);
    if (sd)  sd.textContent  = Number(s.days_remaining||0);
    if (tt)  tt.textContent  = safeText(s.title);
    if (ds)  ds.textContent  = safeText(s.description);

    if (tg) {
      tg.innerHTML = '';
      const arr = s.tags || [];
      if (!arr.length) {
        tg.appendChild(H('span','text-gray-400','—'));
      } else {
        arr.forEach(t => {
          const label = typeof t === 'string' ? t : (t.label || '');
          if (label) {
            tg.appendChild(H('span','badge bg-success bg-opacity-20 text-success me-1 mb-1', label));
          }
        });
      }
    }

    // Drive the donut SVG
    if (s.donut_percentage == null || s.donut_percentage === '') {
      driveDonut(0, statusColor);
      const label = document.getElementById('snapshot_donut_pct');
      if (label) label.textContent = '—';
    } else {
      driveDonut(Number(s.donut_percentage) || 0, statusColor);
    }
  }

  function renderLatestActivity() {
    const list = $('#latest_activity_list'); 
    if (!list) return;
    
    list.innerHTML = '';
    const items = state.latest_activity || [];
    if (!items.length) {
      list.appendChild(H('div','text-gray-400','—'));
      return;
    }
    
    items.forEach(i => {
      const row = H('div','d-flex align-items-center justify-content-between','');
      row.innerHTML = `
        <div class="d-flex align-items-center gap-3">
          <div class="symbol symbol-35px">
            <img src="${i.avatar || 'assets/media/avatars/blank.png'}" alt="">
          </div>
          <div>
            <div class="fw-semibold">${safeText(i.name,'—')}</div>
            <div class="text-gray-300 fs-8">${safeText(i.action,'')}</div>
          </div>
        </div>
        <span class="text-gray-500 fs-8">${safeText(i.time_ago,'')}</span>
      `;
      list.appendChild(row);
    });
  }

  function renderMessages() {
    const first = $('#messages_first'); 
    if (!first) return;
    
    first.innerHTML = '';
    const msgs = state.messages || [];
    if (!msgs.length) {
      first.appendChild(H('div','text-gray-400','—'));
      return;
    }
    
    const m = msgs[0];
    const card = H('div','d-flex align-items-center gap-3','');
    card.innerHTML = `
      <div class="symbol symbol-35px">
        <img src="${m.avatar || 'assets/media/avatars/blank.png'}" alt="">
      </div>
      <div>
        <div class="fw-semibold">${safeText(m.name,'—')}</div>
        <div class="text-gray-300 fs-8">${safeText(m.subject,'')}</div>
      </div>`;
    first.appendChild(card);
  }

  function renderDeadline() {
    const l = $('#deadline_label'); 
    const d = $('#deadline_date');
    if (l) l.textContent = safeText(state.next_deadline.label);
    if (d) d.textContent = safeText(state.next_deadline.date);
  }

  function renderAll() {
    renderTiles();
    renderProjects();
    renderSnapshot();
    renderLatestActivity();
    renderMessages();
    renderDeadline();
    reflectEditMode();
  }

  /* ----------------------- edit-mode shell ----------------------- */
  function reflectEditMode() {
    const t = $('#editToggle'); 
    if (t) t.textContent = editMode ? 'Done' : 'Edit';
    $$('.box-edit-btn').forEach(b => b.classList.toggle('d-none', !editMode));
  }
  
  function wireEditToggle() {
    on($('#editToggle'), 'click', (e) => {
      e.preventDefault();
      editMode = !editMode;
      reflectEditMode();
    });
  }
  
  function ensureTinyButtons() {
    const cfgs = [
      { anchor:'#impact_total',   title:'Edit Impact',    build: buildImpactModal },
      { anchor:'#budget_amount',  title:'Edit Budget',    build: buildBudgetModal },
      { anchor:'#projects_list',  title:'Edit Projects',  build: buildProjectsModal },
      { anchor:'#snapshot_title', title:'Edit Snapshot',  build: buildSnapshotModal },
      { anchor:'#latest_activity_list', title:'Edit Latest Activity', build: buildActivityModal },
      { anchor:'#messages_first', title:'Edit Messages',  build: buildMessagesModal },
      { anchor:'#deadline_label', title:'Edit Deadline',  build: buildDeadlineModal },
    ];
    cfgs.forEach(cfg => {
      const anchorEl = document.querySelector(cfg.anchor);
      const card = anchorEl?.closest('.card');
      const header = card?.querySelector('.card-header');
      if (!header) return;
      header.querySelectorAll('.box-edit-btn').forEach(b => b.remove());
      let rail = header.querySelector('.card-toolbar'); 
      if (!rail) { 
        rail = H('div','card-toolbar'); 
        header.appendChild(rail); 
      }
      const btn = H('button','btn btn-sm btn-light box-edit-btn d-none','Edit');
      btn.addEventListener('click', () => openModal(cfg.title, ...cfg.build()));
      rail.appendChild(btn);
    });
  }

  /* ----------------------- shared modal ----------------------- */
  let bsModal;
  function ensureModal() {
    if ($('#projects_modal')) return;
    const shell = H('div','modal fade','');
    shell.id = 'projects_modal'; shell.tabIndex = -1;
    shell.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-xl">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">Edit</h3>
            <button type="button" class="btn btn-icon btn-sm btn-light" data-bs-dismiss="modal" aria-label="Close">
              <span class="fs-2 fw-bold" style="line-height:1;color:#111827;">×</span>
            </button>
             <style>
              [data-bs-theme="dark"] #projects_modal .ki-cross { color: var(--bs-gray-200) !important; }
            </style>
          </div>
          <div class="modal-body"><div id="projects_modal_body"></div></div>
          <div class="modal-footer">
            <button id="projects_modal_save" class="btn btn-primary">Save</button>
            <button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(shell);
    bsModal = new bootstrap.Modal(shell);
  }
  
  function openModal(title, bodyNode, onSave) {
    ensureModal();
    $('#projects_modal .modal-title').textContent = title;
    const body = $('#projects_modal_body'); 
    body.innerHTML = ''; 
    body.appendChild(bodyNode);
    
    const old = $('#projects_modal_save');
    const neo = old.cloneNode(true);
    old.parentNode.replaceChild(neo, old);
    
    neo.addEventListener('click', async () => {
      await onSave();
      
      await persistPage('projects', {
        impact_points:   state.impact_points,
        total_budget:    state.total_budget,
        projects:        state.projects,
        latest_activity: state.latest_activity,
        messages:        state.messages,
        next_deadline:   state.next_deadline
      });
      
      save();
      renderAll();
      bsModal.hide();
    });
    bsModal.show();
  }
  
  function section(title) {
    const wrap = H('div','mb-6','');
    wrap.appendChild(H('div','fw-bold fs-5 mb-3', title));
    const box = H('div','p-4 rounded bg-white bg-opacity-5 border border-white border-opacity-10','');
    wrap.appendChild(box);
    return {wrap, box};
  }

  /* ----------------------- modal builders ----------------------- */
  function buildImpactModal() {
    const {wrap, box} = section('Total Impact Points');
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-4">
          <label class="form-label">Total</label>
          <input id="imp_total" class="form-control" value="${state.impact_points.total||''}">
        </div>
        <div class="col-md-4">
          <label class="form-label">Change</label>
          <input id="imp_change" class="form-control" value="${state.impact_points.change||''}" placeholder="+5%">
        </div>
        <div class="col-md-12">
          <label class="form-label">Note</label>
          <input id="imp_note" class="form-control" value="${state.impact_points.note||''}" placeholder="Short note">
        </div>
      </div>`;
    const onSave = () => {
      state.impact_points = {
        total: $('#imp_total').value.trim(),
        change: $('#imp_change').value.trim(),
        note: $('#imp_note').value.trim()
      };
    };
    return [wrap, onSave];
  }

  function buildBudgetModal() {
    const {wrap, box} = section('Total Budget');
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-4">
          <label class="form-label">Amount</label>
          <input id="bud_amount" class="form-control" value="${state.total_budget.amount||''}">
        </div>
        <div class="col-md-4">
          <label class="form-label">Change</label>
          <input id="bud_change" class="form-control" value="${state.total_budget.change||''}" placeholder="+2%">
        </div>
        <div class="col-md-12">
          <label class="form-label">Note</label>
          <input id="bud_note" class="form-control" value="${state.total_budget.note||''}" placeholder="Short note">
        </div>
      </div>`;
    const onSave = () => {
      state.total_budget = {
        amount: $('#bud_amount').value.trim(),
        change: $('#bud_change').value.trim(),
        note: $('#bud_note').value.trim()
      };
    };
    return [wrap, onSave];
  }

  function buildProjectsModal() {
    const {wrap, box} = section('Projects');
    const list = H('div','d-flex flex-column gap-4','');

    const row = (proj = {}) => {
      const r = H('div','p-3 rounded border border-white border-opacity-10 bg-white bg-opacity-5','');
      const tags = (proj.tags || []).map(t => typeof t === 'string' ? t : (t.label || '')).join(', ');
      
      r.innerHTML = `
        <div class="row g-3">
          <div class="col-md-12">
            <label class="form-label fw-bold">Title</label>
            <input class="form-control proj-title" placeholder="Project title" value="${proj.title||''}">
          </div>
          <div class="col-md-12">
            <label class="form-label fw-bold">Description</label>
            <textarea class="form-control proj-desc" rows="3" placeholder="Project description">${proj.description||''}</textarea>
          </div>
          <div class="col-md-4">
            <label class="form-label fw-bold">Status</label>
            <select class="form-select proj-status">
              <option value="active"${proj.status==='active'?' selected':''}>Active</option>
              <option value="on_hold"${proj.status==='on_hold'?' selected':''}>On Hold</option>
              <option value="stopped"${proj.status==='stopped'?' selected':''}>Stopped</option>
              <option value="completed"${proj.status==='completed'?' selected':''}>Completed</option>
            </select>
          </div>
          <div class="col-md-4">
            <label class="form-label fw-bold">Days Remaining</label>
            <input type="number" class="form-control proj-days" value="${proj.days_remaining||0}">
          </div>
          <div class="col-md-4">
            <label class="form-label fw-bold">Progress %</label>
            <input type="number" class="form-control proj-donut" value="${proj.donut_percentage??''}" placeholder="0-100">
          </div>
          <div class="col-md-12">
            <label class="form-label fw-bold">Tags (comma-separated)</label>
            <input class="form-control proj-tags" placeholder="NLP, Genomics, AI" value="${tags}">
          </div>
          <div class="col-md-12">
            <button class="btn btn-light-danger w-100">Remove Project</button>
          </div>
        </div>
      `;
      
      // ✅ NEW: Remove button is now under the project box
      on(r.querySelector('.btn-light-danger'),'click',()=>r.remove());
      return r;
    };

    (state.projects||[]).forEach(p => list.appendChild(row(p)));
    
    const add = H('button','btn btn-light mt-2','+ Add project'); 
    on(add,'click',()=>list.appendChild(row()));
    
    box.appendChild(list); 
    box.appendChild(add);

    const onSave = () => {
      const arr = [];
      list.querySelectorAll(':scope > div.p-3').forEach(r=>{
        const title = r.querySelector('.proj-title').value.trim();
        const description = r.querySelector('.proj-desc').value.trim();
        const status = r.querySelector('.proj-status').value;
        const days_remaining = Number(r.querySelector('.proj-days').value) || 0;
        const donut_val = r.querySelector('.proj-donut').value.trim();
        const donut_percentage = donut_val === '' ? null : Number(donut_val);
        const tagsStr = r.querySelector('.proj-tags').value;
        const tags = tagsStr.split(',').map(s=>s.trim()).filter(Boolean).map(label => ({label}));
        
        if (title) {
          arr.push({ 
            status, 
            days_remaining, 
            title, 
            description,
            donut_percentage,
            tags
          });
        }
      });
      state.projects = arr;
    };
    return [wrap, onSave];
  }

  function buildSnapshotModal() {
    // ✅ Edit the project at currentSnapshotIndex
    const {wrap, box} = section('Project Snapshot (Currently Viewing)');
    const s = (state.projects && state.projects[currentSnapshotIndex]) ? state.projects[currentSnapshotIndex] : {};
    const tags = (s.tags || []).map(t => typeof t === 'string' ? t : (t.label || '')).join(', ');
    
    // Status color mapping
    const statusColors = {
      'active': '#20E3B2',
      'on_hold': '#F5A623',
      'stopped': '#A0A0A0',
      'completed': '#4A90E2'
    };
    const currentColor = statusColors[s.status] || '#20E3B2';
    
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-4">
          <label class="form-label">Status</label>
          <select id="sn_status" class="form-select">
            <option value="active"${s.status==='active'?' selected':''}>Active</option>
            <option value="on_hold"${s.status==='on_hold'?' selected':''}>On Hold</option>
            <option value="stopped"${s.status==='stopped'?' selected':''}>Stopped</option>
            <option value="completed"${s.status==='completed'?' selected':''}>Completed</option>
          </select>
        </div>
        <div class="col-md-4">
          <label class="form-label">Status Dot Color (auto from status)</label>
          <input id="sn_color" type="color" class="form-control form-control-color" value="${currentColor}" disabled>
        </div>
        <div class="col-md-4">
          <label class="form-label">Days Remaining</label>
          <input id="sn_days" type="number" class="form-control" value="${s.days_remaining||0}">
        </div>

        <div class="col-md-12">
          <label class="form-label">Title</label>
          <input id="sn_title" class="form-control" value="${s.title||''}">
        </div>
        <div class="col-md-12">
          <label class="form-label">Description</label>
          <textarea id="sn_desc" class="form-control" rows="4">${s.description||''}</textarea>
        </div>

        <div class="col-md-12">
          <label class="form-label">Tags (comma-separated)</label>
          <input id="sn_tags" class="form-control" value="${tags}" placeholder="NLP, Genomics, AI">
        </div>
        <div class="col-md-4">
          <label class="form-label">Donut %</label>
          <input id="sn_donut" type="number" class="form-control" value="${s.donut_percentage??''}" placeholder="0-100">
        </div>
      </div>`;
    
    const onSave = () => {
      const newStatus = $('#sn_status').value;
      
      const tags = $('#sn_tags').value.split(',').map(s=>s.trim()).filter(Boolean).map(label => ({label}));
      const donutVal = $('#sn_donut').value.trim();
      
      const updatedProject = {
        status: newStatus,
        days_remaining: Number($('#sn_days').value||0)||0,
        title: $('#sn_title').value.trim(),
        description: $('#sn_desc').value.trim(),
        tags: tags,
        donut_percentage: donutVal === '' ? null : Number(donutVal)
      };
      
      // Update the project at currentSnapshotIndex
      if (!state.projects) state.projects = [];
      if (currentSnapshotIndex >= state.projects.length) {
        state.projects.push(updatedProject);
      } else {
        state.projects[currentSnapshotIndex] = updatedProject;
      }
    };
    return [wrap, onSave];
  }

  function buildActivityModal() {
    const {wrap, box} = section('Latest Activity');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (item = {}) => {
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-md-3">
          <input class="form-control act-name" placeholder="Name" value="${item.name||''}">
        </div>
        <div class="col-md-5">
          <input class="form-control act-action" placeholder="Action" value="${item.action||''}">
        </div>
        <div class="col-md-2">
          <input class="form-control act-time" placeholder="Time" value="${item.time_ago||''}" >
        </div>
        <div class="col-md-2 d-grid">
          <button class="btn btn-light-danger"><span class="text-gray-900">X</span></button>
        </div>`;
      on(r.querySelector('button'),'click',()=>r.remove());
      return r;
    };

    (state.latest_activity||[]).forEach(i => list.appendChild(row(i)));
    
    const add = H('button','btn btn-light mt-2','+ Add item'); 
    on(add,'click',()=>list.appendChild(row()));
    
    box.appendChild(list); 
    box.appendChild(add);

    const onSave = () => {
      const arr = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const name = r.querySelector('.act-name').value.trim();
        const action = r.querySelector('.act-action').value.trim();
        const time_ago = r.querySelector('.act-time').value.trim();
        
        if (name || action) {
          arr.push({ 
            name, 
            action, 
            time_ago,
            avatar: '',
            approved: false
          });
        }
      });
      state.latest_activity = arr;
    };
    return [wrap, onSave];
  }

  function buildMessagesModal() {
    const {wrap, box} = section('Messages (first will be shown)');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (msg = {}) => {
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-md-3">
          <input class="form-control msg-name" placeholder="From" value="${msg.name||''}">
        </div>
        <div class="col-md-8">
          <input class="form-control msg-subject" placeholder="Subject" value="${msg.subject||''}">
        </div>
        <div class="col-md-1 d-grid">
          <button class="btn btn-light-danger"><span class="text-gray-900">X</span></button>
        </div>`;
      on(r.querySelector('button'),'click',()=>r.remove());
      return r;
    };

    (state.messages||[]).forEach(m => list.appendChild(row(m)));
    
    const add = H('button','btn btn-light mt-2','+ Add message'); 
    on(add,'click',()=>list.appendChild(row()));
    
    box.appendChild(list); 
    box.appendChild(add);

    const onSave = () => {
      const arr = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const name = r.querySelector('.msg-name').value.trim();
        const subject = r.querySelector('.msg-subject').value.trim();
        
        if (name || subject) {
          arr.push({ 
            name, 
            subject,
            time_ago: ''
          });
        }
      });
      state.messages = arr;
    };
    return [wrap, onSave];
  }

  function buildDeadlineModal() {
    const {wrap, box} = section('Next Deadline');
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-6">
          <label class="form-label">Label</label>
          <input id="dl_label" class="form-control" value="${state.next_deadline.label||''}" placeholder="Proposal round">
        </div>
        <div class="col-md-6">
          <label class="form-label">Date</label>
          <input id="dl_date" type="date" class="form-control" value="${state.next_deadline.date||''}">
        </div>
      </div>`;
    const onSave = () => {
      state.next_deadline = {
        label: $('#dl_label').value.trim(),
        date: $('#dl_date').value
      };
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