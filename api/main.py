from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Dict, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from utils import (
    read_pdf_text, first_reasonable_name, grep_lines, guess_research_areas,
    ss_find_author_by_name, ss_author_papers, verify_publications_against_cv,
    extract_cv_data,
)

# ----------------------------
# Models / helpers
# ----------------------------

def _coerce_str_list(val):
    """Normalize arrays coming from GPT into list[str] for the UI/Profile model."""
    if not val:
        return []
    out = []
    for item in val:
        if isinstance(item, str):
            s = item.strip()
            if s:
                out.append(s)
        elif isinstance(item, dict):
            degree = (item.get("degree") or item.get("title") or "").strip()
            field  = (item.get("field") or "").strip()
            inst   = (item.get("institution") or item.get("university") or "").strip()
            date   = (item.get("date") or item.get("year") or "").strip()
            head = (f"{degree} in {field}".strip() if degree and field else (degree or field))
            pieces = [p for p in [head, inst, date] if p]
            s = ", ".join(pieces) if pieces else json.dumps(item, ensure_ascii=False)
            out.append(s)
        else:
            out.append(str(item))
    return out


class Profile(BaseModel):
    name: Optional[str] = None
    socials: Dict[str, str] = {}
    research_areas: list[str] = []
    positions: list[str] = []
    education: list[str] = []
    memberships: list[str] = []


# ----------------------------
# App setup
# ----------------------------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # dev: allow all; tighten later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory store for dev:
# cv_id -> { "text": str, "profile": dict, "parsed": dict, "pub_author_id": Optional[str] }
STORE: Dict[str, Dict] = {}

# "Active" snapshot used by GET endpoints unless cv_id is provided.
ACTIVE = {
    "cv_id": None,
    "text": "",
    "profile": {},
    "projects": {},
    "grants": {},
    "compliance": {},
}

def _latest_cv_id() -> Optional[str]:
    return next(reversed(STORE.keys())) if STORE else None

def _get_from_parsed(cv_id: Optional[str], key: str, default):
    if not cv_id:
        cv_id = ACTIVE["cv_id"] or _latest_cv_id()
    if not cv_id or cv_id not in STORE:
        return default
    return (STORE[cv_id].get("parsed") or {}).get(key) or default

# ---------- normalizers for non-profile sections ----------

def _norm_projects(p: dict | None) -> dict:
    p = p or {}
    out = {
        "project_snapshot": {"status": "", "days_remaining": 0, "title": "", "description": "", "donut_percentage": 0, "tags": []},
        "project_status": {"counts": {"active": 0, "on_hold": 0, "stopped": 0}, "projects": []},
        "impact_points": {"total": "", "change": "", "note": ""},
        "total_budget": {"amount": "", "change": "", "note": ""},
        "next_deadline": {"label": "", "date": ""},
        "messages": [],
        "latest_activity": [],
    }
    # shallow merge to keep any parsed values
    out.update(p)
    out["project_snapshot"].update(p.get("project_snapshot") or {})
    out["project_status"].update(p.get("project_status") or {})
    out["project_status"]["counts"].update((p.get("project_status") or {}).get("counts") or {})
    out["impact_points"].update(p.get("impact_points") or {})
    out["total_budget"].update(p.get("total_budget") or {})
    out["next_deadline"].update(p.get("next_deadline") or {})
    if p.get("messages") is not None:
        out["messages"] = p["messages"]
    if p.get("latest_activity") is not None:
        out["latest_activity"] = p["latest_activity"]
    return out

def _norm_grants(g: dict | None) -> dict:
    g = g or {}
    out = {
        "grants": g.get("grants") or [],
        "breakdown": g.get("breakdown") or {"categories": [], "total": 0},
        "reports": g.get("reports") or {"grantId": "", "nextDue": "", "lastSubmitted": ""},
        "keywords": g.get("keywords") or [],
    }
    # Fill keywords from grant tags if empty
    if not out["keywords"]:
        seen = set()
        for item in out["grants"]:
            for t in (item.get("tags") or item.get("keywords") or []):
                if t and t not in seen:
                    out["keywords"].append(t)
                    seen.add(t)
    return out

def _norm_compliance(c: dict | None) -> dict:
    c = c or {}
    s = c.get("summary") or {}
    if "noncompliant" not in s and "non_compliant" in s:
        s["noncompliant"] = s.get("non_compliant") or 0
    out = {
        "summary": {
            "compliant": s.get("compliant", 0),
            "pending": s.get("pending", 0),
            "noncompliant": s.get("noncompliant", 0),
        },
        "quick_actions": c.get("quick_actions") or [],
        "key_contacts": c.get("key_contacts") or [],
        "checkpoints": c.get("checkpoints") or [],
        "audits": c.get("audits") or [],
        "notes": c.get("notes") or [],
    }
    return out

def _to_int(x):
    try: return int(str(x).replace(",", "").strip())
    except: return 0

def _deep_merge(dst, src):
    """Deep merge dicts: values in src overwrite/extend dst in-place."""
    if not isinstance(dst, dict) or not isinstance(src, dict):
        return src
    for k, v in src.items():
        if k in dst and isinstance(dst[k], dict) and isinstance(v, dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst

def _active_cv_id():
    # prefer ACTIVE snapshot if present
    return ACTIVE.get("cv_id") or (next(reversed(STORE.keys())) if STORE else None)

# ----------------------------
# Health
# ----------------------------

@app.get("/api/health")
def health():
    return {"ok": True}

# ----------------------------
# CV ingest — stores ACTIVE snapshot for all sections
# ----------------------------

@app.post("/api/ingest/cv")
async def ingest_cv(
    cv: UploadFile = File(...),
    linkedin_url: Optional[str] = Form(None),
    scholar_url: Optional[str] = Form(None),
    x_url: Optional[str] = Form(None),
):
    blob = await cv.read()
    text = read_pdf_text(blob)

    parsed = extract_cv_data(text) or {}
    prof = parsed.get("profile", parsed) if isinstance(parsed, dict) else {}

    # socials merged with typed values
    socials = {**(prof.get("socials") or {}), **{
        "LinkedIn": linkedin_url,
        "Google Scholar": scholar_url,
        "X": x_url,
    }}
    socials = {k: v for k, v in socials.items() if v}

    # normalize arrays for profile
    norm_research = _coerce_str_list(prof.get("research_areas")) or guess_research_areas(text)
    norm_positions = _coerce_str_list(prof.get("positions")) or grep_lines(
        text, ["Professor", "Scientist", "Engineer", "Director", "Lecturer"], 12
    )
    norm_education = _coerce_str_list(prof.get("education")) or grep_lines(
        text, ["PhD", "Master", "Bachelor", "Doctor"], 12
    )
    norm_members = _coerce_str_list(prof.get("memberships"))

    profile = Profile(
        name=prof.get("name") or first_reasonable_name(text) or cv.filename.rsplit(".", 1)[0],
        socials=socials,
        research_areas=norm_research,
        positions=norm_positions,
        education=norm_education,
        memberships=norm_members,
    ).model_dump()

    # normalize the other sections for immediate serving
    projects_norm = _norm_projects(parsed.get("projects"))
    grants_norm   = _norm_grants(parsed.get("grants"))
    compliance_norm = _norm_compliance(parsed.get("compliance"))

    # totals for grants (used by UI)
    grants_list = grants_norm.get("grants") or []
    total_awarded  = sum(_to_int(x.get("amountAwarded") or x.get("amount") or 0) for x in grants_list)
    total_received = sum(_to_int(x.get("amountReceived") or 0) for x in grants_list)
    total_spent    = sum(_to_int(x.get("amountSpent") or 0) for x in grants_list)
    available_budget = max(total_received - total_spent, 0)

    # choose a "last awarded" grant
    def _dtv(s):
        s = (s or "").strip()
        for fmt in ("%Y-%m-%d", "%Y-%m", "%b %Y", "%B %Y", "%Y"):
            try:
                return datetime.strptime(s, fmt)
            except Exception:
                pass
        return None
    last_awarded = None
    dated = [(g, _dtv(g.get("awardedAt"))) for g in grants_list]
    dated = [t for t in dated if t[1] is not None]
    if dated:
        dated.sort(key=lambda t: t[1], reverse=True)
        last_awarded = dated[0][0]
    elif grants_list:
        last_awarded = grants_list[0]

    cv_id = str(uuid.uuid4())
    STORE[cv_id] = {
        "text": text,
        "profile": profile,
        "parsed": parsed,
        "pub_author_id": None,
    }

    # set ACTIVE snapshot so GET endpoints immediately serve fresh data
    ACTIVE["cv_id"] = cv_id
    ACTIVE["text"] = text
    ACTIVE["profile"] = profile
    ACTIVE["projects"] = projects_norm
    ACTIVE["grants"] = {
        **grants_norm,
        "total_grants_awarded": {"amount": total_awarded},
        "available_budget": {"amount": available_budget},
        "last_awarded_grant": last_awarded,
    }
    ACTIVE["compliance"] = compliance_norm

    # return normalized sections so the client can cache to localStorage right away
    return {
        "cv_id": cv_id,
        "profile": profile,
        "projects": ACTIVE["projects"],
        "grants": ACTIVE["grants"],
        "compliance": ACTIVE["compliance"],
    }

# ----------------------------
# Publications (unchanged logic)
# ----------------------------

@app.post("/api/publications/verify")
async def publications_verify(
    cv_id: Optional[str] = Form(None),
    person_name: Optional[str] = Form(None),
    scholar_url: Optional[str] = Form(None),
):
    cv_text = ""
    if cv_id and cv_id in STORE:
        cv_text = STORE[cv_id].get("text", "")
        if not person_name:
            person_name = STORE[cv_id]["profile"].get("name")

    author_id = None
    if person_name:
        author_id = ss_find_author_by_name(person_name)

    pubs = []
    if author_id:
        pubs = ss_author_papers(author_id, limit=100)

    verified, metrics = verify_publications_against_cv(pubs, cv_text or "")
    return {"authorId": author_id, "publications": verified, "metrics": metrics}


@app.post("/api/publications/aggregate")
async def publications_aggregate(cv_id: Optional[str] = Form(None)):
    if not cv_id or cv_id not in STORE:
        raise HTTPException(status_code=400, detail="Missing or unknown cv_id")

    stored = STORE[cv_id]
    parsed = stored.get("parsed") or {}
    profile = stored.get("profile") or {}
    name = profile.get("name") or ""

    pubs = []
    author_id = None
    if name:
        author_id = ss_find_author_by_name(name)
        if author_id:
            pubs = ss_author_papers(author_id, limit=100)

    if not pubs:
        pubs = ((parsed.get("publications") or {}).get("publications")) or []

    out = []
    for p in pubs:
        title = p.get("title", "")
        venue = p.get("venue") or p.get("journal") or p.get("conference") or ""
        year = p.get("year") or p.get("date") or 0
        citations = p.get("citationCount") or p.get("citations") or 0
        url = p.get("url") or p.get("pdf_link") or ""
        authors = p.get("authors") or []
        if authors and isinstance(authors[0], dict):
            authors = [a.get("name") for a in authors if a.get("name")]

        out.append({
            "title": title,
            "venue": venue,
            "year": int(year) if str(year).isdigit() else 0,
            "citationCount": int(citations) if str(citations).isdigit() else 0,
            "url": url,
            "authors": authors
        })

    return {"publications": out, "authorId": author_id, "name": name}

# ----------------------------
# Grants — GET (reads ACTIVE)
# ----------------------------

@app.get("/api/grants")
def api_grants(cv_id: Optional[str] = None):
    if cv_id and cv_id in STORE:
        # build a fresh bundle from parsed for this cv_id
        g = _norm_grants(_get_from_parsed(cv_id, "grants", {}))
        grants = g.get("grants") or []
        total_awarded  = sum(_to_int(x.get("amountAwarded") or x.get("amount") or 0) for x in grants)
        total_received = sum(_to_int(x.get("amountReceived") or 0) for x in grants)
        total_spent    = sum(_to_int(x.get("amountSpent") or 0) for x in grants)
        available      = max(total_received - total_spent, 0)
        return {
            **g,
            "total_grants_awarded": {"amount": total_awarded},
            "available_budget": {"amount": available},
            "last_awarded_grant": grants[0] if grants else None,
        }
    # default: serve ACTIVE
    return ACTIVE.get("grants") or {"grants": []}

@app.get("/api/grants/summary")
def api_grants_summary(cv_id: Optional[str] = None):
    base = api_grants(cv_id)
    return {
        "totalAwarded": base.get("total_grants_awarded", {}).get("amount", 0),
        "availableBudget": base.get("available_budget", {}).get("amount", 0),
        "lastAwarded": base.get("last_awarded_grant"),
    }

@app.get("/api/grants/breakdown")
def api_grants_breakdown(cv_id: Optional[str] = None):
    base = api_grants(cv_id)
    return base.get("breakdown") or {"categories": [], "total": 0}

@app.get("/api/grants/reports")
def api_grants_reports(cv_id: Optional[str] = None):
    base = api_grants(cv_id)
    return base.get("reports") or {"grantId": "", "nextDue": "", "lastSubmitted": ""}

@app.get("/api/grants/keywords")
def api_grants_keywords(cv_id: Optional[str] = None):
    base = api_grants(cv_id)
    return {"keywords": base.get("keywords") or []}

# ----------------------------
# Projects — GET (reads ACTIVE)
# ----------------------------

@app.get("/api/projects")
def api_projects(cv_id: Optional[str] = None):
    if cv_id and cv_id in STORE:
        return _norm_projects(_get_from_parsed(cv_id, "projects", {}))
    return ACTIVE.get("projects") or _norm_projects({})

@app.get("/api/projects/tiles")
def api_projects_tiles(cv_id: Optional[str] = None):
    p = api_projects(cv_id)
    return {"impact": p.get("impact_points"), "budget": p.get("total_budget")}

@app.get("/api/projects/snapshot")
def api_projects_snapshot(cv_id: Optional[str] = None):
    return api_projects(cv_id).get("project_snapshot") or {}

@app.get("/api/projects/activity")
def api_projects_activity(cv_id: Optional[str] = None):
    return {"items": api_projects(cv_id).get("latest_activity") or []}

@app.get("/api/projects/messages")
def api_projects_messages(cv_id: Optional[str] = None):
    return {"items": api_projects(cv_id).get("messages") or []}

@app.get("/api/projects/deadline")
def api_projects_deadline(cv_id: Optional[str] = None):
    return api_projects(cv_id).get("next_deadline") or {"label": "", "date": ""}

# ----------------------------
# Compliance — GET (reads ACTIVE)
# ----------------------------

@app.get("/api/compliance")
def api_compliance(cv_id: Optional[str] = None):
    if cv_id and cv_id in STORE:
        return _norm_compliance(_get_from_parsed(cv_id, "compliance", {}))
    return ACTIVE.get("compliance") or _norm_compliance({})

@app.get("/api/compliance/checkpoints")
def api_compliance_checkpoints(cv_id: Optional[str] = None):
    return {"items": api_compliance(cv_id).get("checkpoints") or []}

@app.get("/api/compliance/audits")
def api_compliance_audits(cv_id: Optional[str] = None):
    return {"items": api_compliance(cv_id).get("audits") or []}

@app.get("/api/compliance/notes")
def api_compliance_notes(cv_id: Optional[str] = None):
    return {"items": api_compliance(cv_id).get("notes") or []}

@app.get("/api/compliance/summary")
def api_compliance_summary(cv_id: Optional[str] = None):
    return api_compliance(cv_id).get("summary") or {"compliant": 0, "pending": 0, "noncompliant": 0}

@app.get("/api/compliance/quick-actions")
def api_compliance_quick_actions(cv_id: Optional[str] = None):
    return {"items": api_compliance(cv_id).get("quick_actions") or []}

@app.get("/api/compliance/contacts")
def api_compliance_contacts(cv_id: Optional[str] = None):
    return {"items": api_compliance(cv_id).get("key_contacts") or []}

# page-save endpoint
from fastapi import Body

@app.post("/api/page")
def api_page_save(payload: dict = Body(...)):
    """
    Accepts:
      { "page": "projects"|"grants"|"compliance", "data": {...} }
    Merges into ACTIVE and STORE[cv_id]['parsed'][page] so /api/<page> serves it.
    """
    page = (payload or {}).get("page")
    data = (payload or {}).get("data") or {}
    if page not in {"projects", "grants", "compliance"}:
        raise HTTPException(status_code=400, detail="Unsupported page")

    cv_id = _active_cv_id()
    if not cv_id or cv_id not in STORE:
        raise HTTPException(status_code=400, detail="No active CV")

    # 1) Merge into ACTIVE snapshot
    cur_active = ACTIVE.get(page) or {}
    ACTIVE[page] = _deep_merge(cur_active.copy(), data)

    # 2) Mirror into parsed CV so subsequent GETs match
    parsed = STORE[cv_id].setdefault("parsed", {})
    cur_parsed = parsed.get(page) or {}
    parsed[page] = _deep_merge(cur_parsed, data)

    # 3) Page-specific derived fields (for Grants totals)
    if page == "grants":
        def _to_int2(x):
            try: return int(str(x).replace(",", "").strip())
            except: return 0
        grants_list = ACTIVE["grants"].get("grants") or []
        total_awarded  = sum(_to_int2(x.get("amountAwarded") or x.get("amount") or 0) for x in grants_list)
        total_received = sum(_to_int2(x.get("amountReceived") or 0) for x in grants_list)
        total_spent    = sum(_to_int2(x.get("amountSpent") or 0) for x in grants_list)
        ACTIVE["grants"]["total_grants_awarded"] = {"amount": total_awarded}
        ACTIVE["grants"]["available_budget"]     = {"amount": max(total_received - total_spent, 0)}

    return {"ok": True, "page": page, "data": ACTIVE[page]}
