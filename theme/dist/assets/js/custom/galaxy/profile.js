// theme/src/js/custom/galaxy/profile.js
// ONE tiny edit button per card. The "Research Area" card edits Research Areas + Awards + Patents in ONE modal.

(() => {
  /* ---------------- helpers ---------------- */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const H  = (t, c='', inner='') => { const n=document.createElement(t); if(c)n.className=c; if(inner!=null)n.innerHTML=inner; return n; };
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  // API base (local dev vs prod)
  const isLocalApi = ['localhost','127.0.0.1','0.0.0.0'].includes(location.hostname);
  const API = isLocalApi ? 'http://127.0.0.1:3001/api' : '/api';

  let editMode = false;

  /* ---------------- state & persistence ---------------- */
  const state = {
    profile: {
      name: '—',
      photo_url: 'assets/media/avatars/300-1.jpg',
      social_media: {},             // { Platform: url/handle }
      media_mentions: [],           // [string]
      research_areas: [],           // [string]
      awards: [],                   // [{year,title}]
      patents: [],                  // [{title,number,inventors[],filed,status}]
      mentors: [],                  // [string]
      colleagues: [],               // [string]
      partners: { "Academic Partners": 0, "Industry Partners": 0 }, // object, not array
      affiliations: [],  // <-- add (schema field)
      keywords: [],       // <-- add (schema field)
      positions: [],                // [string]
      education: [],                // [string]
      memberships: []               // [string]
    }
  };

  function ensureShape() {
    const p = state.profile || (state.profile = {});
    p.social_media   = p.social_media   || {};
    p.media_mentions = p.media_mentions || [];
    p.research_areas = p.research_areas || [];
    p.awards         = p.awards         || [];
    p.patents        = p.patents        || [];
    p.mentors        = p.mentors        || [];
    p.colleagues     = p.colleagues     || [];
    p.partners = (p.partners && typeof p.partners === 'object' && !Array.isArray(p.partners)) ? p.partners : {"Academic Partners":0,"Industry Partners":0};
    p.affiliations = p.affiliations || [];
    p.keywords = p.keywords || [];
    p.positions      = p.positions      || [];
    p.education      = p.education      || [];
    p.memberships    = p.memberships    || [];
  }

  function saveProfile() { ensureShape(); localStorage.setItem('galaxy_profile', JSON.stringify(state.profile)); }
  async function loadProfile() {
    const local = localStorage.getItem('galaxy_profile');
    if (local) { try { state.profile = JSON.parse(local); ensureShape(); return; } catch {} }
    try {
      const r = await fetch('data/profile.json', { cache:'no-store' });
      if (r.ok) { state.profile = await r.json(); ensureShape(); }
    } catch {}
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

  function toProfilePayload(){
    const p = state.profile || {};
    return {
      name: p.name || undefined,
      photo_url: p.photo_url || "",
      social_media: p.social_media || {},
      media_mentions: p.media_mentions || [],
      research_areas: p.research_areas || [],
      awards: p.awards || [],
      patents: p.patents || [],
      positions: p.positions || [],
      affiliations: p.affiliations || [],   // NEW
      education: p.education || [],
      memberships: p.memberships || [],
      mentors: p.mentors || [],
      colleagues: p.colleagues || [],
      keywords: p.keywords || [],          // NEW
      partners: p.partners || {"Academic Partners":0,"Industry Partners":0}
    };
  }

  /* ---------------- renderers ---------------- */
  const badge = (t) => `<span class="badge badge-light-primary fw-semibold me-2 mb-2">${t}</span>`;

  function renderHeader() {
    const n = $('#profile_name_display'); if (n) n.textContent = state.profile.name || '—';
    const a = $('#avatar_wrapper'); if (a) a.style.backgroundImage = `url('${state.profile.photo_url || 'assets/media/avatars/300-1.jpg'}')`;
  }

  function renderSimpleList(sel, key) {
    const ul = $(sel); if (!ul) return;
    const arr = state.profile[key] || [];
    ul.innerHTML = '';
    if (!arr.length) { ul.innerHTML = '<li class="text-muted">—</li>'; return; }
    arr.forEach(v => ul.appendChild(H('li','', v)));
  }

  function renderSocial() {
    const ul = $('#social_media_view'); if (!ul) return;
    const entries = Object.entries(state.profile.social_media || {});
    ul.innerHTML = '';
    if (!entries.length) { ul.innerHTML = '<li class="text-muted">—</li>'; return; }
    entries.forEach(([k, v]) => ul.appendChild(H('li','', `<strong>${k}:</strong> ${v}`)));
  }

  function renderResearchAreas() {
    const w = $('#research_areas_tags'); if (!w) return;
    const arr = state.profile.research_areas || [];
    w.innerHTML = arr.length ? arr.map(badge).join('') : '<span class="text-muted">—</span>';
  }

  function renderAwards() {
    const ul = $('#awards_list'); if (!ul) return;
    const arr = state.profile.awards || [];
    ul.innerHTML = '';
    if (!arr.length) { ul.innerHTML = '<li class="text-muted">—</li>'; return; }
    arr.forEach(a => ul.appendChild(H('li','', `<span class="fw-semibold">${a.year || ''}</span> ${a.title || ''}`)));
  }

  function renderPatents() {
    const ul = $('#patents_list'); if (!ul) return;
    const arr = state.profile.patents || [];
    ul.innerHTML = '';
    if (!arr.length) { ul.innerHTML = '<li class="text-muted">—</li>'; return; }
    arr.forEach(pt => {
      const color = (pt.status||'').toLowerCase()==='pending' ? 'text-warning' : 'text-success';
      ul.appendChild(H('li','mb-3', `
        <div class="fw-semibold">${pt.title || ''}</div>
        <div>No: ${pt.number || ''}</div>
        <div>Inventors: ${(Array.isArray(pt.inventors)?pt.inventors:String(pt.inventors||'').split(',')).filter(Boolean).join(', ')}</div>
        <div>Filed: ${pt.filed || ''}</div>
        <div class="${color}">● ${pt.status || ''}</div>
      `));
    });
  }

  function renderAll() {
    renderHeader();
    renderSocial();
    renderSimpleList('#media_mentions_list','media_mentions');
    renderResearchAreas();
    renderAwards();
    renderPatents();
    renderSimpleList('#mentors_list','mentors');
    renderSimpleList('#colleagues_list','colleagues');
    const pv = $('#partners_view');
    if (pv) {
      const obj = state.profile.partners || {};
      const entries = Object.entries(obj);
      pv.innerHTML = entries.length
        ? entries.map(([label, count]) => `<li><span class="fw-semibold">${count}</span> ${label}</li>`).join('')
        : '<li class="text-muted">—</li>';
    }
    renderSimpleList('#positions_list','positions');
    renderSimpleList('#education_list','education');
    renderSimpleList('#memberships_list','memberships');
    reflectEditMode();
  }

  // Force-paint with a plain profile object
  function paintProfileImmediate(profile){
    const nameEl = document.getElementById('profile_name_display');
    if (nameEl) nameEl.textContent = profile?.name || '—';

    const socialWrap = document.getElementById('social_media_view');
    if (socialWrap) {
      socialWrap.innerHTML = '';
      const entries = Object.entries(profile?.socials || {});
      if (!entries.length) socialWrap.innerHTML = '<li class="text-muted">—</li>';
      else entries.forEach(([k,v])=>{
        const li = document.createElement('li');
        li.innerHTML = `<strong>${k}:</strong> ${v}`;
        socialWrap.appendChild(li);
      });
    }

    const tagWrap = document.getElementById('research_areas_tags');
    if (tagWrap) {
      tagWrap.innerHTML = '';
      (profile?.research_areas || []).forEach(t=>{
        const b = document.createElement('span');
        b.className = 'badge badge-light-success me-2 mb-2';
        b.textContent = t;
        tagWrap.appendChild(b);
      });
      if ((profile?.research_areas||[]).length === 0) tagWrap.innerHTML = '<span class="text-muted">—</span>';
    }

    const paintList = (id, items) => {
      const ul = document.getElementById(id);
      if (!ul) return;
      ul.innerHTML = '';
      (items || []).forEach(v => {
        const li = document.createElement('li'); li.textContent = v; ul.appendChild(li);
      });
      if (!items || !items.length) ul.innerHTML = '<li class="text-muted">—</li>';
    };
    paintList('positions_list',   profile?.positions);
    paintList('education_list',   profile?.education);
    paintList('memberships_list', profile?.memberships);

    const notes = document.getElementById('media_mentions_list');
    if (notes) {
      const li = document.createElement('li');
      li.textContent = `Imported CV ${new Date().toLocaleDateString()}`;
      notes.prepend(li);
    }
  }

  /* ---------------- edit-mode tiny buttons ---------------- */
  function reflectEditMode() {
    const t = $('#editToggle'); if (t) t.textContent = editMode ? 'Done' : 'Edit';
    $$('.box-edit-btn').forEach(b => b.classList.toggle('d-none', !editMode));
     const importBtn = $('#importCvBtn');
     if (importBtn) importBtn.classList.toggle('d-none', !editMode);
  }
  
  // inject ONE tiny edit button per card
  function ensureTinyButtons() {
    const configs = [
      { key:'social',  anchor:'#social_media_view',   title:'Edit: Social Media',        build: buildSocialModal },
      { key:'media',   anchor:'#media_mentions_list', title:'Edit: Media Appearances',   build: () => buildSimpleLinesModal('media_mentions','One per line') },
      // SINGLE button for the Research card → edits research areas + awards + patents
      { key:'research_all', anchor:'#research_areas_tags', title:'Edit: Research Area',   build: buildResearchAwardsPatentsModal },
      { key:'mentorscol', anchor:'#mentors_list',     title:'Edit: Mentors & Colleagues', build: buildMentorsColleaguesModal },
      { key:'partners', anchor:'#partners_view',      title:'Edit: Partners',             build: buildPartnersModal },
      { key:'positions',anchor:'#positions_list',     title:'Edit: Positions',            build: () => buildSimpleLinesModal('positions','One per line') },
      { key:'education',anchor:'#education_list',     title:'Edit: Education',            build: () => buildSimpleLinesModal('education','One per line') },
      { key:'members',  anchor:'#memberships_list',   title:'Edit: Memberships',          build: () => buildSimpleLinesModal('memberships','One per line') },
    ];

    configs.forEach(cfg => {
      const card = document.querySelector(cfg.anchor)?.closest('.card');
      const header = card?.querySelector('.card-header');
      if (!header) return;

      // Clean up any older multiple buttons inside this header
      header.querySelectorAll('.box-edit-btn').forEach(b => b.remove());

      let rail = header.querySelector('.card-toolbar');
      if (!rail) { rail = H('div','card-toolbar'); header.appendChild(rail); }

      const btn = H('button','btn btn-sm btn-light box-edit-btn d-none','Edit');
      btn.addEventListener('click', () => openModal(cfg.title, ...cfg.build()));
      rail.appendChild(btn);
    });
  }

  /* ---------------- shared modal shell ---------------- */
  let bsModal;
  function ensureModal() {
    if ($('#galaxy_box_modal')) return;
    const shell = H('div','modal fade','');
    shell.id = 'galaxy_box_modal';
    shell.tabIndex = -1;
    shell.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-xl">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">Edit</h3>
            <button type="button" class="btn btn-icon btn-sm btn-light" data-bs-dismiss="modal" aria-label="Close">
              <span class="fs-2 fw-bold" style="line-height:1;color:#111827;">×</span>
            </button>
          </div>
          <div class="modal-body"><div id="galaxy_box_modal_body"></div></div>
          <div class="modal-footer">
            <button id="galaxy_box_modal_save" class="btn btn-primary">Save</button>
            <button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(shell);
    bsModal = new bootstrap.Modal(shell);
  }

  function openModal(title, bodyNode, onSave) {
    ensureModal();
    $('#galaxy_box_modal .modal-title').textContent = title;
    const body = $('#galaxy_box_modal_body'); body.innerHTML = ''; body.appendChild(bodyNode);

    const oldSave = $('#galaxy_box_modal_save');
    const newSave = oldSave.cloneNode(true);
    oldSave.parentNode.replaceChild(newSave, oldSave);
    newSave.addEventListener('click', async () => {
      await onSave();                // pull inputs → state.profile
      saveProfile();                 // local cache
      await persistPage('profile', toProfilePayload()); // <-- NEW: write-through to API
      renderAll();
      bsModal.hide();
    });
    bsModal.show();
  }

  /* ---------------- modal builders ---------------- */
  function labeledSection(title) {
    const s = H('div','mb-6','');
    s.appendChild(H('div','fw-bold fs-5 mb-3', title));
    const box = H('div','p-4 rounded bg-white bg-opacity-5 border border-white border-opacity-10','');
    s.appendChild(box);
    return {wrap:s, box};
  }

  function buildSimpleLinesModal(key, hint='One per line') {
    const {wrap, box} = labeledSection(hint);
    const ta = H('textarea','form-control', (state.profile[key]||[]).join('\n')); ta.rows = 10; box.appendChild(ta);
    const onSave = () => { state.profile[key] = ta.value.split('\n').map(s=>s.trim()).filter(Boolean); };
    return [wrap, onSave];
  }

  function buildSocialModal() {
    const {wrap, box} = labeledSection('Add, edit, or remove your social links.');
    const list = H('div','d-flex flex-column gap-2','');
    const row = (k='',v='') => {
      const r = H('div','d-flex gap-2 align-items-center','');
      r.innerHTML = `
        <input class="form-control" placeholder="Platform (e.g., LinkedIn)" value="${k}">
        <input class="form-control" placeholder="Handle / URL" value="${v}">
        <button class="btn btn-light-danger">Remove</button>`;
      r.lastElementChild.addEventListener('click',()=>r.remove());
      return r;
    };
    Object.entries(state.profile.social_media||{}).forEach(([k,v])=>list.appendChild(row(k,v)));
    const add = H('button','btn btn-light mt-3','+ Add row'); add.addEventListener('click',()=>list.appendChild(row()));
    box.appendChild(list); box.appendChild(add);
    const onSave = () => {
      const next={}; list.querySelectorAll(':scope > div').forEach(d=>{
        const [p,h] = d.querySelectorAll('input'); const pk=p.value.trim(), hv=h.value.trim();
        if (pk && hv) next[pk]=hv;
      });
      state.profile.social_media = next;
    };
    return [wrap,onSave];
  }

  // ONE modal for Research Areas + Awards + Patents (matches your screenshot idea)
  function buildResearchAwardsPatentsModal() {
    const root = H('div');

    // Research Areas
    {
      const sec = labeledSection('Research Areas');
      const list = H('div','d-flex flex-column gap-2','');
      const row = (val='') => {
        const r = H('div','d-flex gap-2 align-items-center','');
        r.innerHTML = `
          <input class="form-control" placeholder="add research area" value="${val}">
          <button class="btn btn-icon btn-light"><i class="ki-duotone ki-cross"></i></button>`;
        r.lastElementChild.addEventListener('click',()=>r.remove());
        return r;
      };
      (state.profile.research_areas||[]).forEach(a => list.appendChild(row(a)));
      const add = H('button','btn btn-light mt-3','+ Add area'); add.addEventListener('click',()=>list.appendChild(row()));
      sec.box.appendChild(list); sec.box.appendChild(add);
      root.appendChild(sec.wrap);

      // capture onSave piece
      root._saveAreas = () => {
        const arr=[];
        list.querySelectorAll('input').forEach(i=>{ const v=i.value.trim(); if(v) arr.push(v); });
        state.profile.research_areas = arr;
      };
    }

    // Awards & Honors
    {
      const sec = labeledSection('Awards & Honors');
      const list = H('div','d-flex flex-column gap-2','');
      const row = (year='', title='') => {
        const r = H('div','d-flex gap-2 align-items-center','');
        r.innerHTML = `
          <div class="text-gray-500 fs-8">year</div>
          <input class="form-control" style="max-width:160px" value="${year}">
          <div class="text-gray-500 fs-8 ms-3">title</div>
          <input class="form-control" value="${title}">
          <button class="btn btn-light-danger">Remove</button>`;
        r.lastElementChild.addEventListener('click',()=>r.remove());
        return r;
      };
      (state.profile.awards||[]).forEach(a => list.appendChild(row(a.year||'', a.title||'')));
      const add = H('button','btn btn-light mt-3','+ Add award'); add.addEventListener('click',()=>list.appendChild(row()));
      sec.box.appendChild(list); sec.box.appendChild(add);
      root.appendChild(sec.wrap);

      root._saveAwards = () => {
        const next=[]; list.querySelectorAll(':scope > div').forEach(d=>{
          const ins = d.querySelectorAll('input');
          const year = (ins[0]?.value||'').trim(); const title=(ins[1]?.value||'').trim();
          if (title) next.push({year, title});
        });
        state.profile.awards = next;
      };
    }

    // Patents
    {
      const sec = labeledSection('Patents');
      const list = H('div','d-flex flex-column gap-3','');
      const card = (pt={}) => {
        const inv = Array.isArray(pt.inventors)?pt.inventors.join(', '):(pt.inventors||'');
        const c = H('div','p-3 rounded bg-white bg-opacity-5 border border-white border-opacity-10','');
        c.innerHTML = `
          <div class="row g-2">
            <div class="col-md-6"><input class="form-control" placeholder="Title" value="${pt.title||''}"></div>
            <div class="col-md-6"><input class="form-control" placeholder="Number" value="${pt.number||''}"></div>
            <div class="col-md-6"><input class="form-control" placeholder="Inventors (comma-separated)" value="${inv}"></div>
            <div class="col-md-3"><input class="form-control" placeholder="Filed (YYYY-MM)" value="${pt.filed||''}"></div>
            <div class="col-md-3">
              <select class="form-select">
                <option ${pt.status==='Pending'?'selected':''}>Pending</option>
                <option ${pt.status==='Granted'?'selected':''}>Granted</option>
              </select>
            </div>
          </div>
          <div class="mt-2 text-end">
            <button class="btn btn-sm btn-light-danger">Remove</button>
          </div>`;
        c.querySelector('.btn-light-danger').addEventListener('click',()=>c.remove());
        return c;
      };
      (state.profile.patents||[]).forEach(p => list.appendChild(card(p)));
      const add = H('button','btn btn-light mt-3','+ Add patent'); add.addEventListener('click',()=>list.appendChild(card()));
      sec.box.appendChild(list); sec.box.appendChild(add);
      root.appendChild(sec.wrap);

      root._savePatents = () => {
        const next=[]; list.querySelectorAll(':scope > .p-3').forEach(b=>{
          const ins=b.querySelectorAll('input,select');
          const [tEl,nEl,iEl,fEl,sEl]=ins;
          const title=tEl.value.trim(); if (!title) return;
          next.push({
            title,
            number:nEl.value.trim(),
            inventors:(iEl.value||'').split(',').map(s=>s.trim()).filter(Boolean),
            filed:fEl.value.trim(),
            status:sEl.value.trim()
          });
        });
        state.profile.patents = next;
      };
    }

    const onSave = () => {
      root._saveAreas && root._saveAreas();
      root._saveAwards && root._saveAwards();
      root._savePatents && root._savePatents();
    };
    return [root, onSave];
  }

  function buildMentorsColleaguesModal() {
    const sec = H('div','row','');
    const c1 = H('div','col-md-6','<div class="fw-semibold mb-2">Mentors</div>');
    const c2 = H('div','col-md-6','<div class="fw-semibold mb-2">Colleagues</div>');
    const t1 = H('textarea','form-control', (state.profile.mentors||[]).join('\n')); t1.rows=10;
    const t2 = H('textarea','form-control', (state.profile.colleagues||[]).join('\n')); t2.rows=10;
    c1.appendChild(t1); c2.appendChild(t2); sec.appendChild(c1); sec.appendChild(c2);
    const onSave = () => {
      state.profile.mentors = t1.value.split('\n').map(s=>s.trim()).filter(Boolean);
      state.profile.colleagues = t2.value.split('\n').map(s=>s.trim()).filter(Boolean);
    };
    return [sec, onSave];
  }

  function buildPartnersModal() {
    const {wrap, box} = labeledSection('Partner type (key) + count (value)');
    const list = H('div','d-flex flex-column gap-2','');

    const row = (label='', count='') => {
      const r = H('div','d-flex gap-2 align-items-center','');
      r.innerHTML = `
        <input class="form-control" placeholder="Label (e.g., Academic Partners)" value="${label}">
        <input class="form-control" placeholder="Count" value="${count}">
        <button class="btn btn-light-danger">Remove</button>`;
      r.lastElementChild.addEventListener('click',()=>r.remove());
      return r;
    };

    const entries = Object.entries(state.profile.partners || {});
    if (entries.length === 0) list.appendChild(row('Academic Partners', '0'));
    entries.forEach(([k,v]) => list.appendChild(row(k, v)));

    const add = H('button','btn btn-light mt-3','+ Add pair');
    add.addEventListener('click',()=>list.appendChild(row()));

    box.appendChild(list); box.appendChild(add);

    const onSave = () => {
      const out = {};
      list.querySelectorAll(':scope > div').forEach(d=>{
        const [kEl,vEl] = d.querySelectorAll('input');
        const k = (kEl?.value || '').trim();
        const vRaw = (vEl?.value || '').trim();
        if (!k) return;
        const v = parseInt(vRaw.replace(/,/g,''),10);
        out[k] = Number.isFinite(v) ? v : 0;
      });
      state.profile.partners = out;
    };
    return [wrap, onSave];
  }

  /* ---------------- avatar & edit toggle ---------------- */
  function wireAvatar() {
    on($('#photo_input'),'change', e => {
      const f = e.target.files?.[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { state.profile.photo_url = r.result; saveProfile(); renderHeader(); };
      r.readAsDataURL(f);
    });
  }

  function wireEditToggle() {
    on($('#editToggle'),'click', e => {
      e.preventDefault();
      editMode = !editMode;
      reflectEditMode();
    });
  }

  function wireImportButton() {
    const btn = $('#importCvBtn');
    const modal = $('#importCvModal');
    if (!btn || !modal) return;
    btn.addEventListener('click', () => {
      bootstrap.Modal.getOrCreateInstance(modal).show();
    });
  }

  function wireImportSubmit(){
    const form  = document.getElementById('importCvForm');
    const modal = document.getElementById('importCvModal');
    const errEl = document.getElementById('cv_err');
    if (!form || !modal) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (errEl) errEl.classList.add('d-none');

      const file = document.getElementById('cvFile')?.files?.[0];
      if (!file) {
        if (errEl) { errEl.textContent = 'Please choose a CV (PDF).'; errEl.classList.remove('d-none'); }
        return;
      }

      const fd = new FormData(form);
      fd.set('cv', file); // backend expects "cv"

      try {
        const r = await fetch(`${API}/ingest/cv`, { method:'POST', body: fd });
        if (!r.ok) throw new Error(`Upload failed (${r.status})`);
        const data = await r.json();

        // Save cv_id for other pages (e.g., Publications verify)
        if (data.cv_id) localStorage.setItem('galaxy_cv_id', data.cv_id);

        localStorage.removeItem('galaxy_grants');
        localStorage.removeItem('galaxy_projects');
        localStorage.removeItem('galaxy_compliance');

        const p = data.profile || {};
        // also include the socials typed by the user so UI updates immediately
        p.socials = p.socials || {};
        const li = form.querySelector('[name="linkedin_url"]')?.value?.trim();
        const sc = form.querySelector('[name="scholar_url"]')?.value?.trim();
        const tw = form.querySelector('[name="x_url"]')?.value?.trim();
        if (li) p.socials['LinkedIn'] = li;
        if (sc) p.socials['Google Scholar'] = sc;
        if (tw) p.socials['X'] = tw;

        // Merge into your state shape
        state.profile.name = p.name || state.profile.name;
        state.profile.social_media = { ...(state.profile.social_media||{}), ...(p.socials||{}) };
        if (Array.isArray(p.research_areas)) state.profile.research_areas = p.research_areas;
        if (Array.isArray(p.positions))       state.profile.positions      = p.positions;
        if (Array.isArray(p.education))       state.profile.education      = p.education;
        if (Array.isArray(p.memberships))     state.profile.memberships    = p.memberships;

        // Persist & paint now
        localStorage.setItem('galaxy_profile', JSON.stringify(state.profile));
        paintProfileImmediate({
          name: state.profile.name,
          socials: state.profile.social_media,
          research_areas: state.profile.research_areas,
          positions: state.profile.positions,
          education: state.profile.education,
          memberships: state.profile.memberships
        });

        setTimeout(()=>bootstrap.Modal.getOrCreateInstance(modal).hide(), 50);
      } catch (err) {
        console.error('[CV Import] error', err);
        if (errEl) { errEl.textContent = err.message || 'Import failed.'; errEl.classList.remove('d-none'); }
      }
    });
  }

  /* ---------------- boot ---------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    await loadProfile();
    ensureShape();

    ensureTinyButtons();   // inject ONE tiny edit button for each card
    wireEditToggle();
    wireAvatar();
    wireImportButton();
    wireImportSubmit();
    renderAll();
  });
})();