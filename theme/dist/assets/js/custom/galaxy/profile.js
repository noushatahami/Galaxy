(function () {
  const state = {
    profile: {
      name: "—",
      photo_url: "assets/media/avatars/300-1.jpg",
      social_media: {},
      media_mentions: [],
      research_areas: [],
      awards: [],
      patents: [],
      mentors: [],
      colleagues: [],
      partners: {},
      positions: [],
      affiliations: [],
      education: [],
      memberships: []
    }
  };

  // ---- globals/helpers ----
  let editMode = false; // <— controls visibility of remove buttons & per-card Edit
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const $on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  const el = (tag, cls, html) => { const x=document.createElement(tag); if(cls)x.className=cls; if(html!=null)x.innerHTML=html; return x; };
  const pill = (t) => `<span class="badge badge-light-primary fw-semibold me-2 mb-2">${t}</span>`;

  const API = (location.hostname === 'localhost')
  ? 'http://localhost:3001/api'
  : '/api';

  // Example: upload CV and enrich
  async function parseCv(file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${API}/ingest/cv`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('CV parse failed');
    return r.json();
  }

  async function enrichData(parsed, userContext) {
    const r = await fetch(`${API}/enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parsed, user_context: userContext })
    });
    if (!r.ok) throw new Error('Enrich failed');
    return r.json();
  }

  async function loadProfile() {
    const local = localStorage.getItem("galaxy_profile");
    if (local) { 
      state.profile = JSON.parse(local); 
      return; 
    }
    try {
      // 👇 call the backend
      const res = await fetch(`${API}/profile`, { cache: "no-store" });
      if (res.ok) {
        state.profile = await res.json();
        return;
      }
    } catch (err) {
      console.warn("Falling back to static JSON:", err);
    }

    // fallback: static JSON file
    try {
      const res = await fetch("data/profile.json", { cache: "no-store" });
      if (res.ok) state.profile = await res.json();
    } catch (_) {}
  }

  function saveProfile(){ localStorage.setItem("galaxy_profile", JSON.stringify(state.profile)); }

  function updateRemoveButtonsVisibility() {
    $$(".remove-btn").forEach(b => b.classList.toggle("d-none", !editMode));
  }

  function renderList(selector, arr) {
    const ul = $(selector); if (!ul) return;
    ul.innerHTML = "";
    if (!arr?.length) { ul.innerHTML = `<li class="text-muted">—</li>`; return; }
    arr.forEach((item, i) => {
      const li = el("li");
      li.innerHTML = `${item} <button class="btn btn-sm btn-light-danger ms-2 remove-btn" data-remove-list="${selector}" data-index="${i}">Remove</button>`;
      ul.appendChild(li);
    });
  }

  function render() {
    const p = state.profile;

    // header/avatar
    $("#profile_name_display").textContent = p.name || "—";
    const wrapper = $("#avatar_wrapper");
    if (wrapper) wrapper.style.backgroundImage = `url('${p.photo_url || "assets/media/avatars/300-1.jpg"}')`;

    // lists
    renderList("#positions_list", p.positions);
    renderList("#affiliations_list", p.affiliations);
    renderList("#education_list", p.education);
    renderList("#memberships_list", p.memberships);
    renderList("#mentors_list", p.mentors);
    renderList("#colleagues_list", p.colleagues);

    // social media (view + editor rows)
    const smView = $("#social_media_view");
    if (smView) {
      smView.innerHTML = "";
      const keys = Object.keys(p.social_media || {});
      if (!keys.length) smView.innerHTML = `<li class="text-muted">—</li>`;
      keys.forEach(k => smView.appendChild(el("li", null, `<span class="fw-semibold">${k}:</span> ${p.social_media[k]}`)));
    }
    const smList = $("#social_media_list");
    if (smList) {
      smList.innerHTML = "";
      Object.keys(p.social_media || {}).forEach(k => {
        smList.appendChild(el("div","d-flex align-items-center gap-2 mb-2",`
          <input class="form-control form-control-sm" value="${k}" data-k="k">
          <input class="form-control form-control-sm" value="${p.social_media[k]}" data-k="v">
          <button class="btn btn-sm btn-light-danger remove-btn" data-remove="social_media" data-key="${k}">Remove</button>`));
      });
    }

    // research areas (chips)
    const rtags = $("#research_areas_tags");
    if (rtags) rtags.innerHTML = (p.research_areas || []).map(pill).join("") || `<span class="text-muted">—</span>`;

    // awards
    const aw = $("#awards_list");
    if (aw) {
      aw.innerHTML = "";
      if (!p.awards?.length) aw.innerHTML = `<li class="text-muted">—</li>`;
      (p.awards || []).forEach(a => {
        aw.appendChild(el("li", null, `<span class="fw-semibold">${a.year||""}</span> ${a.title||""}
          <button class="btn btn-sm btn-light-danger ms-3 remove-btn" data-remove="awards" data-year="${a.year}" data-title="${a.title}">Remove</button>`));
      });
    }

    // patents
    const pl = $("#patents_list");
    if (pl) {
      pl.innerHTML = "";
      if (!p.patents?.length) pl.innerHTML = `<li class="text-muted">—</li>`;
      (p.patents || []).forEach((pt, idx) => {
        const color = (pt.status||"").toLowerCase()==="pending" ? "text-warning" : "text-success";
        pl.appendChild(el("li","mb-3",`
          <div class="fw-semibold">${pt.title||""}</div>
          <div>No: ${pt.number||""}</div>
          <div>Inventors: ${(pt.inventors||[]).join(", ")}</div>
          <div>Filed: ${pt.filed||""}</div>
          <div class="${color}">● ${pt.status||""}</div>
          <button class="btn btn-sm btn-light-danger mt-1 remove-btn" data-remove="patents" data-index="${idx}">Remove</button>`));
      });
    }

    // partners
    const pv = $("#partners_view");
    if (pv) {
      pv.innerHTML = "";
      const pk = Object.keys(p.partners||{});
      if (!pk.length) pv.innerHTML = `<li class="text-muted">—</li>`;
      pk.forEach(k => pv.appendChild(el("li", null, `<span class="fw-semibold">${p.partners[k]}</span> ${k}`)));
    }
    const plst = $("#partners_list");
    if (plst) {
      plst.innerHTML = "";
      Object.keys(p.partners||{}).forEach(k => {
        plst.appendChild(el("div","d-flex align-items-center gap-2 mb-2",`
          <input class="form-control form-control-sm" value="${k}" data-k="k">
          <input class="form-control form-control-sm" value="${p.partners[k]}" data-k="v">
          <button class="btn btn-sm btn-light-danger remove-btn" data-remove="partners" data-key="${k}">Remove</button>`));
      });
    }

    // finally, sync remove buttons visibility with current mode
    updateRemoveButtonsVisibility();
  }

  // editors / events
  function wireEditors() {
    // adders
    const addList = (inputSel, key) => {
      const v = $(inputSel)?.value.trim(); if (!v) return;
      (state.profile[key] ||= []).push(v); $(inputSel).value=""; saveProfile(); render();
    };
    $on($("[data-add='positions']"), "click", () => addList("#positions_input","positions"));
    $on($("[data-add='affiliations']"), "click", () => addList("#affiliations_input","affiliations"));
    $on($("[data-add='media_mentions']"), "click", () => addList("#media_mentions_input","media_mentions"));
    $on($("[data-add='mentors']"), "click", () => addList("#mentors_input","mentors"));
    $on($("[data-add='colleagues']"), "click", () => addList("#colleagues_input","colleagues"));
    $on($("[data-add='education']"), "click", () => addList("#education_input","education"));
    $on($("[data-add='memberships']"), "click", () => addList("#memberships_input","memberships"));

    $on($("[data-add='social_media']"), "click", () => {
      const k=$("#sm_key")?.value.trim(), v=$("#sm_val")?.value.trim(); if(!k||!v) return;
      (state.profile.social_media ||= {})[k]=v; $("#sm_key").value=""; $("#sm_val").value="";
      saveProfile(); render();
    });
    $on($("[data-add='partners']"), "click", () => {
      const k=$("#partner_key")?.value.trim(), v=$("#partner_val")?.value.trim(); if(!k||!v) return;
      (state.profile.partners ||= {})[k]=v; $("#partner_key").value=""; $("#partner_val").value="";
      saveProfile(); render();
    });

    $on($("[data-add='awards']"), "click", () => {
      const year=$("#award_year")?.value.trim(), title=$("#award_title")?.value.trim(); if(!year||!title) return;
      (state.profile.awards ||= []).push({year,title}); $("#award_year").value=""; $("#award_title").value="";
      saveProfile(); render();
    });
    $on($("[data-add='patents']"), "click", () => {
      const title=$("#pat_title")?.value.trim(); if(!title) return;
      const number=$("#pat_number")?.value.trim();
      const inventors=($("#pat_inventors")?.value||"").split(",").map(s=>s.trim()).filter(Boolean);
      const filed=$("#pat_filed")?.value.trim(); const status=$("#pat_status")?.value;
      (state.profile.patents ||= []).push({title, number, inventors, filed, status});
      ["#pat_title","#pat_number","#pat_inventors","#pat_filed"].forEach(s=>$(s).value="");
      saveProfile(); render();
    });

    // generic removes
    document.addEventListener("click", (e) => {
      const t = e.target; if (!(t instanceof HTMLElement)) return;

      if (t.hasAttribute("data-remove-list")) {
        const sel = t.getAttribute("data-remove-list");
        const idx = +t.getAttribute("data-index");
        const map = {
          "#positions_list":"positions","#affiliations_list":"affiliations",
          "#media_mentions_list":"media_mentions","#mentors_list":"mentors",
          "#colleagues_list":"colleagues","#education_list":"education","#memberships_list":"memberships"
        };
        const key = map[sel]; if (!key) return;
        state.profile[key].splice(idx,1); saveProfile(); render();
      }
      if (t.getAttribute("data-remove")==="social_media") {
        delete state.profile.social_media[t.getAttribute("data-key")]; saveProfile(); render();
      }
      if (t.getAttribute("data-remove")==="partners") {
        delete state.profile.partners[t.getAttribute("data-key")]; saveProfile(); render();
      }
      if (t.getAttribute("data-remove")==="awards") {
        const y=t.getAttribute("data-year"), ti=t.getAttribute("data-title");
        state.profile.awards = (state.profile.awards||[]).filter(a=>!(a.year===y && a.title===ti));
        saveProfile(); render();
      }
      if (t.getAttribute("data-remove")==="patents") {
        const idx = +t.getAttribute("data-index");
        state.profile.patents.splice(idx,1); saveProfile(); render();
      }
    });

    // avatar preview
    $on($("#photo_input"), "change", (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        state.profile.photo_url = r.result;
        const wrap = $("#avatar_wrapper");
        if (wrap) wrap.style.backgroundImage = `url('${state.profile.photo_url}')`;
        saveProfile();
      };
      r.readAsDataURL(f);
    });

    // per-card edit buttons toggle editor visibility
    $$(".box-edit-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const targets = (btn.getAttribute("data-edit-target") || "").split(",").map(s => s.trim()).filter(Boolean);
        targets.forEach(sel => { const ed = $(sel); if (ed) ed.classList.toggle("d-none"); });
      });
    });

    // global edit toggle
    const setEditMode = (on) => {
      editMode = on;
      const btn = $("#editToggle"); if (btn) btn.textContent = on ? "Done" : "Edit";
      $$(".box-edit-btn").forEach(b => b.classList.toggle("d-none", !on));
      if (!on) { $$(".editor").forEach(ed => ed.classList.add("d-none")); }
      updateRemoveButtonsVisibility();
    };
    $on($("#editToggle"), "click", () => setEditMode(!editMode));
    setEditMode(false); // start off
  }

  // Tagify
  function initTagify() {
    const input = $("#research_areas_tagify");
    if (!input || !window.Tagify) return;
    const tagify = new Tagify(input, {
      originalInputValueFormat: (values) => values.map(v => v.value).join(", ")
    });
    tagify.addTags(state.profile.research_areas || []);
    const sync = () => {
      state.profile.research_areas = tagify.value.map(t => t.value);
      saveProfile();
      const rtags = $("#research_areas_tags");
      if (rtags) rtags.innerHTML =
        (state.profile.research_areas || []).map(t => `<span class="badge badge-light-primary fw-semibold me-2 mb-2">${t}</span>`).join("")
        || `<span class="text-muted">—</span>`;
    };
    tagify.on("add", sync); tagify.on("remove", sync); tagify.on("blur", sync);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await loadProfile();
    wireEditors();
    initTagify();
    render();
  });
})();
