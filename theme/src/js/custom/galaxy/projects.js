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
  const state = {
    // tiles
    impact: { total: 0, change: '+0%', note: '' },
    budget: { amount: 0, change: '+0%', note: '' },

    // projects
    projects: [
      // { title, status: 'active'|'on_hold'|'stopped' }
    ],

    // snapshot
    snapshot: {
      status: 'Active',        // text
      statusColor: '#20E3B2',  // dot color
      days: 0,
      title: '',
      desc: '',
      tags: [],                // ['NLP', 'Genomics']
      donut: null              // percent number
    },

    // right column
    latestActivity: [
      // { name, action, iconUrl?, avatarUrl?, when }
    ],
    messages: [
      // { from, preview, avatarUrl?, at? }
    ],
    deadline: { label: '', date: '' }
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

        const impact = root.impact_points || root.impact;
        if (impact) {
          state.impact = {
            total: Number(impact.total ?? 0) || 0,
            change: impact.change ?? '',
            note: impact.note ?? ''
          };
        }
        const budget = root.total_budget || root.budget;
        if (budget) {
          state.budget = {
            amount: Number(budget.amount ?? 0) || 0,
            change: budget.change ?? '',
            note: budget.note ?? ''
          };
        }

        if (root.project_status && Array.isArray(root.project_status.projects)) {
          state.projects = root.project_status.projects.map(p => ({
            title: p.label || p.title || 'Untitled',
            status: p.status || 'active'
          }));
        } else if (Array.isArray(root.projects)) {
          state.projects = root.projects.map(p => ({
            title: p.title || p.label || 'Untitled',
            status: p.status || 'active'
          }));
        }

        const snap = root.project_snapshot || root.snapshot;
        if (snap) {
          state.snapshot = {
            status: snap.status || '',
            statusColor: snap.statusColor || '#20E3B2',
            days: Number(snap.days || snap.days_remaining || 0) || 0,
            title: snap.title || '',
            desc: snap.description || snap.desc || '',
            tags: (snap.tags || []).map(t => typeof t === 'string' ? t : (t.label || '')).filter(Boolean),
            donut: (snap.donut_percentage != null ? Number(snap.donut_percentage)
                                                  : (snap.donut != null ? Number(snap.donut) : null))
          };
        }

        if (Array.isArray(root.latest_activity)) {
          state.latestActivity = root.latest_activity.map(a => ({
            name: a.name || '',
            action: a.action || '',
            when: a.time_ago || a.when || '',
            avatarUrl: a.avatar || ''
          }));
        }
        if (Array.isArray(root.messages)) {
          state.messages = root.messages.map(m => ({
            from: m.name || m.from || '',
            preview: m.subject || m.preview || '',
            avatarUrl: m.avatar || ''
          }));
        }
        if (root.next_deadline || root.deadline) {
          const dl = root.next_deadline || root.deadline;
          state.deadline = { label: dl.label || '', date: dl.date || '' };
        }
      }

      // 3) Optional granular overrides (if your backend exposes them)
      const [tiles, projects, snapshot, activity, messages, deadline] = await Promise.allSettled([
        fetch(`${API}/projects/tiles`),
        fetch(`${API}/projects`),          // some backends return list directly
        fetch(`${API}/projects/snapshot`),
        fetch(`${API}/projects/activity`),
        fetch(`${API}/projects/messages`),
        fetch(`${API}/projects/deadline`)
      ]);

      if (tiles.status==='fulfilled' && tiles.value.ok) {
        const t = await tiles.value.json();
        if (t.impact) state.impact = t.impact;
        if (t.budget) state.budget = t.budget;
      }
      if (projects.status==='fulfilled' && projects.value.ok) {
        const p = await projects.value.json();
        if (Array.isArray(p.projects))      state.projects = p.projects;
        else if (Array.isArray(p))          state.projects = p;
      }
      if (snapshot.status==='fulfilled' && snapshot.value.ok) {
        state.snapshot = await snapshot.value.json();
      }
      if (activity.status==='fulfilled' && activity.value.ok) {
        const a = await activity.value.json();
        state.latestActivity = a.items || a || [];
      }
      if (messages.status==='fulfilled' && messages.value.ok) {
        const m = await messages.value.json();
        state.messages = m.items || m || [];
      }
      if (deadline.status==='fulfilled' && deadline.value.ok) {
        state.deadline = await deadline.value.json();
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

    if (it) it.textContent = safeText(state.impact.total);
    if (ic) ic.textContent = safeText(state.impact.change);
    if (inote) inote.textContent = safeText(state.impact.note);
    if (ba) ba.textContent = fmtMoney(state.budget.amount);
    if (bc) bc.textContent = safeText(state.budget.change);
    if (bnote) bnote.textContent = safeText(state.budget.note);
  }

  function renderProjects() {
    const wrap = $('#projects_list');
    const cA = $('#count_active');
    const cH = $('#count_on_hold');
    const cS = $('#count_stopped');
    if (!wrap) return;

    wrap.innerHTML = '';
    const list = state.projects || [];
    if (!list.length) {
      wrap.innerHTML = '<div class="text-gray-400">—</div>';
    } else {
      list.forEach(p => {
        const dot = p.status==='active' ? '#20E3B2' : (p.status==='on_hold' ? '#F5A623' : '#A0A0A0');
        const col = H('div','col-sm-6','');
        col.appendChild(H('div','px-3 py-2 rounded bg-body-secondary', `<span style="color:${dot}">●</span> ${safeText(p.title,'Untitled')}`));
        wrap.appendChild(col);
      });
    }
    const active  = list.filter(p=>p.status==='active').length;
    const onHold  = list.filter(p=>p.status==='on_hold').length;
    const stopped = list.filter(p=>p.status==='stopped').length;
    if (cA) cA.textContent = `(${active})`;
    if (cH) cH.textContent = `(${onHold})`;
    if (cS) cS.textContent = `(${stopped})`;
  }

    function renderSnapshot() {
    const s   = state.snapshot || {};
    const dot = $('#snapshot_status_dot');
    const st  = $('#snapshot_status');
    const sd  = $('#snapshot_days');
    const tt  = $('#snapshot_title');
    const ds  = $('#snapshot_desc');
    const tg  = $('#snapshot_tags');

    if (dot) dot.style.color = s.statusColor || '#20E3B2';
    if (st)  st.textContent  = safeText(s.status);
    if (sd)  sd.textContent  = Number(s.days||0);
    if (tt)  tt.textContent  = safeText(s.title);
    if (ds)  ds.textContent  = safeText(s.desc);

    if (tg) {
      tg.innerHTML = '';
      const arr = s.tags || [];
      if (!arr.length) tg.appendChild(H('span','text-gray-400','—'));
      else arr.forEach(t => tg.appendChild(H('span','badge bg-success bg-opacity-20 text-success me-1 mb-1', t)));
    }

    // 🔸 Drive the donut SVG (percent + ring color)
    //    Expects the HTML to have: .snapshot-donut-ring + #snapshot_donut_pct
    if (s.donut == null || s.donut === '') {
      driveDonut(0, s.statusColor || '#20E3B2');        // show 0% if missing
      const label = document.getElementById('snapshot_donut_pct');
      if (label) label.textContent = '—';
    } else {
      driveDonut(Number(s.donut) || 0, s.statusColor || '#20E3B2');
    }
  }


  function renderLatestActivity() {
    const list = $('#latest_activity_list'); if (!list) return;
    list.innerHTML = '';
    const items = state.latestActivity || [];
    if (!items.length) {
      list.appendChild(H('div','text-gray-400','—'));
      return;
    }
    items.forEach(i => {
      const row = H('div','d-flex align-items-center justify-content-between','');
      row.innerHTML = `
        <div class="d-flex align-items-center gap-3">
          <div class="symbol symbol-35px">
            <img src="${i.avatarUrl || 'assets/media/avatars/blank.png'}" alt="">
          </div>
          <div>
            <div class="fw-semibold">${safeText(i.name,'—')}</div>
            <div class="text-gray-300 fs-8">${safeText(i.action,'')}</div>
          </div>
        </div>
        <span class="text-gray-500 fs-8">${safeText(i.when,'')}</span>
      `;
      list.appendChild(row);
    });
  }

  function renderMessages() {
    const first = $('#messages_first'); if (!first) return;
    first.innerHTML = '';
    const msgs = state.messages || [];
    if (!msgs.length) {
      first.appendChild(H('div','text-gray-400','—'));
      return;
    }
    const m = msgs[0];
    const card = H('div','d-flex align-items-center gap-3','');
    card.innerHTML = `
      <div class="symbol symbol-35px"><img src="${m.avatarUrl || 'assets/media/avatars/blank.png'}" alt=""></div>
      <div>
        <div class="fw-semibold">${safeText(m.from,'—')}</div>
        <div class="text-gray-300 fs-8">${safeText(m.preview,'')}</div>
      </div>`;
    first.appendChild(card);
  }

  function renderDeadline() {
    const l = $('#deadline_label'); const d = $('#deadline_date');
    if (l) l.textContent = safeText(state.deadline.label);
    if (d) d.textContent = safeText(state.deadline.date);
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
      let rail = header.querySelector('.card-toolbar'); if (!rail) { rail = H('div','card-toolbar'); header.appendChild(rail); }
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
            <button type="button" class="btn btn-icon btn-sm btn-light" data-bs-dismiss="modal">
              <i class="ki-duotone ki-cross fs-2"></i>
            </button>
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
    const body = $('#projects_modal_body'); body.innerHTML = ''; body.appendChild(bodyNode);
    const old = $('#projects_modal_save');
    const neo = old.cloneNode(true);
    old.parentNode.replaceChild(neo, old);
    neo.addEventListener('click', async () => {
      await onSave();                                // inputs -> state
      await persistPage('projects', {                // NEW
        impact_points:   state.impact,
        total_budget:    state.budget,
        project_status:  { projects: state.projects },
        project_snapshot:{
          status: state.snapshot?.status || '',
          statusColor: state.snapshot?.statusColor || '#20E3B2',
          days_remaining: Number(state.snapshot?.days || 0),
          title: state.snapshot?.title || '',
          description: state.snapshot?.desc || '',
          tags: state.snapshot?.tags || [],
          donut_percentage: (state.snapshot?.donut ?? null)
        },
        latest_activity: state.latestActivity || [],
        messages:        state.messages || [],
        next_deadline:   state.deadline || { label:'', date:'' }
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
        <div class="col-md-4"><label class="form-label">Total</label><input id="imp_total" class="form-control" value="${state.impact.total||0}"></div>
        <div class="col-md-4"><label class="form-label">Change</label><input id="imp_change" class="form-control" value="${state.impact.change||''}" placeholder="+5%"></div>
        <div class="col-md-12"><label class="form-label">Note</label><input id="imp_note" class="form-control" value="${state.impact.note||''}" placeholder="Short note"></div>
      </div>`;
    const onSave = () => {
      state.impact = {
        total: Number($('#imp_total').value||0)||0,
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
        <div class="col-md-4"><label class="form-label">Amount</label><input id="bud_amount" class="form-control" value="${state.budget.amount||0}"></div>
        <div class="col-md-4"><label class="form-label">Change</label><input id="bud_change" class="form-control" value="${state.budget.change||''}" placeholder="+2%"></div>
        <div class="col-md-12"><label class="form-label">Note</label><input id="bud_note" class="form-control" value="${state.budget.note||''}" placeholder="Short note"></div>
      </div>`;
    const onSave = () => {
      state.budget = {
        amount: Number($('#bud_amount').value||0)||0,
        change: $('#bud_change').value.trim(),
        note: $('#bud_note').value.trim()
      };
    };
    return [wrap, onSave];
  }

  function buildProjectsModal() {
    const {wrap, box} = section('Projects');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (title='', status='active') => {
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-md-7"><input class="form-control" placeholder="Project title" value="${title}"></div>
        <div class="col-md-3">
          <select class="form-select">
            <option value="active"${status==='active'?' selected':''}>Active</option>
            <option value="on_hold"${status==='on_hold'?' selected':''}>On Hold</option>
            <option value="stopped"${status==='stopped'?' selected':''}>Stopped</option>
          </select>
        </div>
        <div class="col-md-2 d-grid">
          <button class="btn btn-light-danger">Remove</button>
        </div>`;
      on(r.querySelector('.btn-light-danger'),'click',()=>r.remove());
      return r;
    };

    (state.projects||[]).forEach(p => list.appendChild(row(p.title||'', p.status||'active')));
    const add = H('button','btn btn-light mt-2','+ Add project'); on(add,'click',()=>list.appendChild(row()));
    box.appendChild(list); box.appendChild(add);

    const onSave = () => {
      const arr = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const title = r.querySelector('input').value.trim();
        const status = r.querySelector('select').value;
        if (title) arr.push({ title, status });
      });
      state.projects = arr;
    };
    return [wrap, onSave];
  }

  function buildSnapshotModal() {
    const {wrap, box} = section('Project Snapshot');
    const s = state.snapshot || {};
    box.innerHTML = `
      <div class="row g-3">
        <div class="col-md-4"><label class="form-label">Status</label><input id="sn_status" class="form-control" value="${s.status||''}" placeholder="Active"></div>
        <div class="col-md-4"><label class="form-label">Status Dot Color</label><input id="sn_color" type="color" class="form-control form-control-color" value="${s.statusColor||'#20E3B2'}"></div>
        <div class="col-md-4"><label class="form-label">Days</label><input id="sn_days" class="form-control" value="${s.days||0}"></div>

        <div class="col-md-12"><label class="form-label">Title</label><input id="sn_title" class="form-control" value="${s.title||''}"></div>
        <div class="col-md-12"><label class="form-label">Description</label><textarea id="sn_desc" class="form-control" rows="4">${s.desc||''}</textarea></div>

        <div class="col-md-12"><label class="form-label">Tags (comma or newline)</label><textarea id="sn_tags" class="form-control" rows="3">${(s.tags||[]).join(', ')}</textarea></div>
        <div class="col-md-4"><label class="form-label">Donut %</label><input id="sn_donut" class="form-control" value="${s.donut??''}" placeholder="e.g. 72"></div>
      </div>`;
    const onSave = () => {
      state.snapshot = {
        status: $('#sn_status').value.trim(),
        statusColor: $('#sn_color').value || '#20E3B2',
        days: Number($('#sn_days').value||0)||0,
        title: $('#sn_title').value.trim(),
        desc: $('#sn_desc').value.trim(),
        tags: $('#sn_tags').value.replace(/\n/g, ',').split(',').map(s=>s.trim()).filter(Boolean),
        donut: $('#sn_donut').value==='' ? null : Number($('#sn_donut').value)||0
      };
    };
    return [wrap, onSave];
  }

  function buildActivityModal() {
    const {wrap, box} = section('Latest Activity');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (name='', action='', when='') => {
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-md-3"><input class="form-control" placeholder="Name" value="${name}"></div>
        <div class="col-md-6"><input class="form-control" placeholder="Action" value="${action}"></div>
        <div class="col-md-2"><input class="form-control" placeholder="When" value="${when}" ></div>
        <div class="col-md-1 d-grid"><button class="btn btn-light-danger">X</button></div>`;
      on(r.querySelector('button'),'click',()=>r.remove());
      return r;
    };

    (state.latestActivity||[]).forEach(i => list.appendChild(row(i.name||'', i.action||'', i.when||'')));
    const add = H('button','btn btn-light mt-2','+ Add item'); on(add,'click',()=>list.appendChild(row()));
    box.appendChild(list); box.appendChild(add);

    const onSave = () => {
      const arr = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const [name, action, when] = r.querySelectorAll('input');
        if (name.value.trim() || action.value.trim()) {
          arr.push({ name: name.value.trim(), action: action.value.trim(), when: when.value.trim() });
        }
      });
      state.latestActivity = arr;
    };
    return [wrap, onSave];
  }

  function buildMessagesModal() {
    const {wrap, box} = section('Messages (first will be shown)');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (from='', preview='') => {
      const r = H('div','row g-2 align-items-center','');
      r.innerHTML = `
        <div class="col-md-3"><input class="form-control" placeholder="From" value="${from}"></div>
        <div class="col-md-8"><input class="form-control" placeholder="Preview" value="${preview}"></div>
        <div class="col-md-1 d-grid"><button class="btn btn-light-danger">X</button></div>`;
      on(r.querySelector('button'),'click',()=>r.remove());
      return r;
    };

    (state.messages||[]).forEach(m => list.appendChild(row(m.from||'', m.preview||'')));
    const add = H('button','btn btn-light mt-2','+ Add message'); on(add,'click',()=>list.appendChild(row()));
    box.appendChild(list); box.appendChild(add);

    const onSave = () => {
      const arr = [];
      list.querySelectorAll(':scope > .row').forEach(r=>{
        const [from, preview] = r.querySelectorAll('input');
        if (from.value.trim() || preview.value.trim()) {
          arr.push({ from: from.value.trim(), preview: preview.value.trim() });
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
        <div class="col-md-6"><label class="form-label">Label</label><input id="dl_label" class="form-control" value="${state.deadline.label||''}" placeholder="Proposal round"></div>
        <div class="col-md-6"><label class="form-label">Date</label><input id="dl_date" type="date" class="form-control" value="${state.deadline.date||''}"></div>
      </div>`;
    const onSave = () => {
      state.deadline = {
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
