from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Dict, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from utils import (
    oa_author_works_all, read_pdf_text, first_reasonable_name, grep_lines, guess_research_areas,
    verify_publications_against_cv, extract_cv_data,
    # OpenAlex:
    oa_pick_author_by_cv, oa_author_works,
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
    "publications": {},   # <- we will keep the *verified* publications here
}

def _latest_cv_id() -> Optional[str]:
    return next(reversed(STORE.keys())) if STORE else None

def _get_from_parsed(cv_id: Optional[str], key: str, default):
    if not cv_id:
        cv_id = ACTIVE["cv_id"] or _latest_cv_id()
    if not cv_id or cv_id not in STORE:
        return default
    return (STORE[cv_id].get("parsed") or {}).get(key) or default

def _profile_scholar_url(profile: dict) -> Optional[str]:
    sm = (profile or {}).get("social_media") or (profile or {}).get("socials") or {}
    # Keys are normalized later but support both:
    return sm.get("Google Scholar") or sm.get("Scholar") or sm.get("scholar")

# ---------- normalizers for pages ----------
def _norm_profile(p: dict | None, *, photo_url_default: str = "") -> dict:
    p = p or {}
    # legacy/gpt keys we might see:
    socials_in = p.get("social_media") or p.get("socials") or {}
    socials = {}
    if isinstance(socials_in, dict):
        # normalize well-known keys
        for k, v in socials_in.items():
            if not v: continue
            key = k.strip()
            if key.lower() in {"twitter","x"}: key = "Twitter"
            if key.lower() in {"linkedin","linkedin url"}: key = "LinkedIn"
            if key.lower() in {"google scholar","scholar"}: key = "Google Scholar"
            socials[key] = v

    # partners: accept either array of {type,count} or already-an-object
    partners_in = p.get("partners") or {}
    if isinstance(partners_in, list):
        partners = {}
        for item in partners_in:
            t = (item.get("type") or "").strip()
            c = item.get("count") or 0
            if t:
                partners[t] = int(str(c).replace(",", "").strip() or 0)
    elif isinstance(partners_in, dict):
        partners = {k: int(str(v).replace(",", "").strip() or 0) for k, v in partners_in.items()}
    else:
        partners = {}

    def _arr(key):
        v = p.get(key) or []
        if isinstance(v, list): return [str(x).strip() for x in v if str(x).strip()]
        return []

    def _education():
        """Format education data as comma-separated strings like positions."""
        out = []
        for edu in p.get("education") or []:
            if isinstance(edu, dict):
                # Convert dict to comma-separated string
                parts = []
                if edu.get("degree"): parts.append(edu["degree"])
                if edu.get("field"): parts.append(edu["field"])
                if edu.get("institution"): parts.append(edu["institution"])
                if edu.get("year"): parts.append(str(edu["year"]))
                if edu.get("GPA"): parts.append(f"GPA: {edu['GPA']}")
                out.append(", ".join(parts))
            elif isinstance(edu, str):
                # Try to parse Python dict string representation and convert to comma-separated
                try:
                    edu_str = edu.strip()
                    if edu_str.startswith("{") and edu_str.endswith("}"):
                        # Replace single quotes with double quotes for JSON parsing
                        json_str = edu_str.replace("'", '"')
                        parsed = json.loads(json_str)
                        parts = []
                        if parsed.get("degree"): parts.append(parsed["degree"])
                        if parsed.get("field"): parts.append(parsed["field"])
                        if parsed.get("institution"): parts.append(parsed["institution"])
                        if parsed.get("year"): parts.append(str(parsed["year"]))
                        if parsed.get("GPA"): parts.append(f"GPA: {parsed['GPA']}")
                        out.append(", ".join(parts))
                    else:
                        # Already a plain string
                        out.append(edu_str)
                except (json.JSONDecodeError, ValueError):
                    # If parsing fails, use as-is
                    out.append(edu.strip())
        return out

    def _awards():
        out = []
        for a in p.get("awards") or []:
            if not isinstance(a, dict): continue
            out.append({"year": (a.get("year") or "").strip(), "title": (a.get("title") or "").strip()})
        return out

    def _patents():
        out = []
        for a in p.get("patents") or []:
            if not isinstance(a, dict): continue
            inv = a.get("inventors")
            if isinstance(inv, str): inv = [s.strip() for s in inv.split(",") if s.strip()]
            if not isinstance(inv, list): inv = []
            out.append({
                "title": (a.get("title") or "").strip(),
                "number": (a.get("number") or "").strip(),
                "inventors": inv,
                "filed": (a.get("filed") or "").strip(),
                "status": (a.get("status") or "").strip(),
            })
        return out

    photo_url = (p.get("photo_url") or "").strip()
    if not photo_url: photo_url = photo_url_default

    # ensure name fallback stays non-empty (important for S2 lookups)
    name = (p.get("name") or "").strip()

    return {
        "name": name,
        "photo_url": photo_url,
        "social_media": socials,
        "media_mentions": _arr("media_mentions"),
        "research_areas": _arr("research_areas"),
        "awards": _awards(),
        "patents": _patents(),
        "positions": _arr("positions"),
        "affiliations": _arr("affiliations"),
        "education": _education(),
        "memberships": _arr("memberships"),
        "mentors": _arr("mentors"),
        "colleagues": _arr("colleagues"),
        "keywords": _arr("keywords"),
        "partners": partners or {"Academic Partners": 0, "Industry Partners": 0},
    }

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

    # Merge typed socials into the incoming profile
    typed_socials = {k:v for k,v in {
        "LinkedIn": linkedin_url,
        "Google Scholar": scholar_url,
        "X": x_url,   # we’ll remap X→Twitter in normalizer
    }.items() if v}

    prof_in = dict(prof or {})
    # some earlier extractions used "socials"
    prof_in["socials"] = {**(prof_in.get("socials") or {}), **typed_socials}

    # Build normalized profile to your schema
    profile = _norm_profile(prof_in, photo_url_default="assets/media/avatars/300-1.jpg")
    if "X" in profile["social_media"]:  # remap to Twitter key for final shape
        profile["social_media"]["Twitter"] = profile["social_media"].pop("X")

    # Ensure non-blank name fallback (important for S2 author search)
    if not (profile.get("name") or "").strip():
        fallback = first_reasonable_name(text) or (cv.filename.rsplit(".", 1)[0] if cv.filename else "")
        profile["name"] = fallback.strip()

    # normalize the other sections for immediate serving
    projects_norm   = _norm_projects(parsed.get("projects"))
    grants_norm     = _norm_grants(parsed.get("grants"))
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
    ACTIVE["publications"] = {"publications": [], "authorId": None, "name": profile.get("name","")}

    # return normalized sections so the client can cache to localStorage right away
    return {
        "cv_id": cv_id,
        "profile": profile,
        "projects": ACTIVE["projects"],
        "grants": ACTIVE["grants"],
        "compliance": ACTIVE["compliance"],
        "publications": ACTIVE["publications"],  # empty until aggregate runs
    }

# ----------------------------
# Publications — Semantic Scholar + CV verification
# ----------------------------

from typing import Optional
from fastapi import Form, HTTPException

@app.post("/api/publications/aggregate")
async def publications_aggregate(cv_id: Optional[str] = Form(None)):
    if not cv_id or cv_id not in STORE:
        raise HTTPException(status_code=400, detail="Missing or unknown cv_id")

    stored   = STORE[cv_id]
    parsed   = stored.get("parsed") or {}
    profile  = stored.get("profile") or {}
    name     = (profile.get("name") or "").strip()
    cv_text  = stored.get("text") or ""

    # NEW: build a list of CV titles if we have structured pubs
    cv_titles_struct = []
    try:
        cv_titles_struct = [
            p.get("title") for p in ((parsed.get("publications") or {}).get("publications") or [])
            if p.get("title")
        ]
    except Exception:
        cv_titles_struct = []

    # Optional affiliation string to help tie-break
    cv_affiliation = (profile.get("affiliation") or profile.get("institution") or "").strip()

    # Try cached author first
    author_id = stored.get("pub_author_id")
    if not author_id:
        try:
            # Use structured titles if available; else fall back to raw CV text
            titles_or_text = cv_titles_struct if cv_titles_struct else cv_text
            author_id = oa_pick_author_by_cv(
                name,
                titles_or_text,
                cv_affiliation=cv_affiliation or None,
                high_thresh=88,
                mid_thresh=75,
            )
        except Exception:
            author_id = None
        stored["pub_author_id"] = author_id

    pubs = []
    if author_id:
        try:
            works = oa_author_works_all(author_id, max_pages=2) or []
            pubs = []
            for w in works:
                title = w.get("display_name") or ""
                year  = w.get("publication_year") or 0
                venue = (w.get("host_venue") or {}).get("display_name") or ""
                url   = (
                    (w.get("primary_location") or {}).get("landing_page_url")
                    or (w.get("primary_location") or {}).get("source", {}).get("url")
                    or (w.get("ids") or {}).get("doi")
                    or ""
                )
                authors = [
                    (a.get("author") or {}).get("display_name")
                    for a in (w.get("authorships") or [])
                    if (a.get("author") or {}).get("display_name")
                ]
                pubs.append({
                    "title": title,
                    "venue": venue,
                    "year": int(year) if str(year).isdigit() else 0,
                    "url": url,
                    "authors": authors,
                    "citations": int(w.get("cited_by_count") or 0),
                    "source": "openalex",
                })
        except Exception:
            pubs = []

    if not pubs:
        pubs = ((parsed.get("publications") or {}).get("publications")) or []

    verified, metrics = verify_publications_against_cv(pubs, cv_text or "")

    out = []
    for p in verified:
        title   = p.get("title", "")
        venue   = p.get("venue") or p.get("journal") or p.get("conference") or ""
        year    = p.get("year") or p.get("date") or 0
        url     = p.get("url") or p.get("pdf_link") or ""
        authors = p.get("authors") or []
        if authors and isinstance(authors[0], dict):
            authors = [a.get("name") for a in authors if a.get("name")]
        out.append({
            "title": title,
            "venue": venue,
            "year": int(year) if str(year).isdigit() else 0,
            "citations": int(p.get("citations") or 0),
            "url": url,
            "authors": authors,
        })

    ACTIVE["publications"] = {"publications": out, "authorId": author_id, "name": name, "metrics": metrics}
    parsed_pub = parsed.get("publications") or {}
    parsed_pub["publications"] = out
    parsed_pub["metrics"] = metrics
    parsed["publications"] = parsed_pub

    return {"publications": out, "authorId": author_id, "name": name, "metrics": metrics}

@app.post("/api/publications/verify")
async def publications_verify(
    cv_id: Optional[str] = Form(None),
    person_name: Optional[str] = Form(None),
):
    """
    Debug/verify helper (OpenAlex):
    - Pick an OpenAlex author only if at least one CV title matches their works.
    - Return the matched author id and the verified works list (against the CV).
    """
    cv_text = ""
    if cv_id and cv_id in STORE:
        cv_text = STORE[cv_id].get("text", "")
        if not person_name:
            person_name = (STORE[cv_id].get("profile") or {}).get("name")

    author_id = None
    if person_name:
        author_id = oa_pick_author_by_cv(person_name, cv_text)

    pubs = []
    if author_id:
        works = oa_author_works(author_id, per_page=200) or []
        for w in works:
            pubs.append({
                "title": w.get("display_name") or "",
                "year": w.get("publication_year") or 0,
                "venue": (w.get("host_venue") or {}).get("display_name") or "",
                "url": (
                    (w.get("primary_location") or {}).get("landing_page_url")
                    or (w.get("primary_location") or {}).get("source", {}).get("url")
                    or (w.get("ids") or {}).get("doi") or ""
                ),
                "authors": [
                    (a.get("author") or {}).get("display_name")
                    for a in (w.get("authorships") or [])
                    if (a.get("author") or {}).get("display_name")
                ],
                "citations": int(w.get("cited_by_count") or 0),
            })

    verified, metrics = verify_publications_against_cv(pubs, cv_text or "")
    return {"authorId": author_id, "publications": verified, "metrics": metrics}

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

# ----------------------------
# Profile & Publications — GET (reads ACTIVE)
# ----------------------------
@app.get("/api/profile")
def api_profile(cv_id: Optional[str] = None):
    if cv_id and cv_id in STORE:
        base = (STORE[cv_id].get("profile") or {}).copy()
        return base
    return ACTIVE.get("profile") or {}

@app.get("/api/publications")
def api_publications(cv_id: Optional[str] = None):
    # Serve the verified publications we last computed (ACTIVE)
    if cv_id and cv_id in STORE:
        parsed = (STORE[cv_id].get("parsed") or {}).get("publications") or {}
        # If we already verified, prefer ACTIVE["publications"]
        return ACTIVE.get("publications") or parsed
    return ACTIVE.get("publications") or {}

# ----------------------------
# Page save (persist edits from UI)
# ----------------------------
@app.post("/api/page")
def api_page_save(payload: dict = Body(...)):
    """
    Accepts:
      { "page": "projects"|"grants"|"compliance"|"profile"|"publications", "data": {...} }
    Merges into ACTIVE and STORE[cv_id]['parsed' or 'profile'] so /api/<page> serves it.
    """
    page = (payload or {}).get("page")
    data = (payload or {}).get("data") or {}
    if page not in {"projects", "grants", "compliance", "profile", "publications"}:
        raise HTTPException(status_code=400, detail="Unsupported page")

    cv_id = _active_cv_id()
    if not cv_id or cv_id not in STORE:
        raise HTTPException(status_code=400, detail="No active CV")

    # 1) Merge into ACTIVE snapshot
    cur_active = ACTIVE.get(page) or {}
    ACTIVE[page] = _deep_merge(cur_active.copy(), data)

    # 2) Mirror into parsed/profile block so subsequent GETs match
    parsed = STORE[cv_id].setdefault("parsed", {})

    if page == "profile":
        # profile is stored at top-level too
        prof_now = STORE[cv_id].get("profile") or {}
        STORE[cv_id]["profile"] = _deep_merge(prof_now, data)
        # also mirror under parsed["profile"] for symmetry
        parsed["profile"] = _deep_merge(parsed.get("profile") or {}, data)
    else:
        parsed[page] = _deep_merge(parsed.get(page) or {}, data)

    # 3) Page-specific derived fields
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
