from __future__ import annotations
import json
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Optional
from pydantic import BaseModel
import uuid
from fastapi import HTTPException, Form
from typing import Optional

from utils import (
    read_pdf_text, first_reasonable_name, grep_lines, guess_research_areas,
    ss_find_author_by_name, ss_author_papers, verify_publications_against_cv
)

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
            # Try to format common CV shapes nicely
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

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8080","http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Simple in-memory store for dev
STORE: Dict[str, Dict] = {}  # cv_id -> {"text": "...", "profile": {...}}

class Profile(BaseModel):
    name: Optional[str] = None
    socials: Dict[str,str] = {}
    research_areas: list[str] = []
    positions: list[str] = []
    education: list[str] = []
    memberships: list[str] = []

@app.get("/api/health")
def health():
    return {"ok": True}

@app.post("/api/ingest/cv")
async def ingest_cv(
    cv: UploadFile = File(...),
    linkedin_url: Optional[str] = Form(None),
    scholar_url: Optional[str] = Form(None),
    x_url: Optional[str] = Form(None),
):
    blob = await cv.read()
    text = read_pdf_text(blob)

    # --- use OpenAI to parse CV ---
    from utils import extract_cv_data
    parsed = extract_cv_data(text)
    prof = parsed.get("profile", parsed) if isinstance(parsed, dict) else {}

    # merge socials typed in form
    socials = {**(prof.get("socials") or {}), **{
        "LinkedIn": linkedin_url,
        "Google Scholar": scholar_url,
        "X": x_url
    }}
    socials = {k: v for k, v in socials.items() if v}

    # --- normalize arrays coming from GPT ---
    norm_research = _coerce_str_list(prof.get("research_areas")) or guess_research_areas(text)
    norm_positions = _coerce_str_list(prof.get("positions")) or grep_lines(text, ["Professor","Scientist","Engineer","Director","Lecturer"], 12)
    norm_education = _coerce_str_list(prof.get("education")) or grep_lines(text, ["PhD","Master","Bachelor","Doctor"], 12)
    norm_members   = _coerce_str_list(prof.get("memberships"))

    profile = Profile(
        name=prof.get("name") or first_reasonable_name(text) or cv.filename.rsplit(".",1)[0],
        socials=socials,
        research_areas=norm_research,
        positions=norm_positions,
        education=norm_education,
        memberships=norm_members,
    ).model_dump()

    cv_id = str(uuid.uuid4())
    STORE[cv_id] = {"text": text, "profile": profile, "parsed": parsed}

    return {"cv_id": cv_id, "profile": profile, "parsed": parsed}


@app.post("/api/publications/verify")
async def publications_verify(
    cv_id: Optional[str] = Form(None),
    person_name: Optional[str] = Form(None),
    scholar_url: Optional[str] = Form(None),
):
    # recover CV text (for verification) and name if not provided
    cv_text = ""
    if cv_id and cv_id in STORE:
        cv_text = STORE[cv_id].get("text","")
        if not person_name:
            person_name = STORE[cv_id]["profile"].get("name")

    # Resolve Semantic Scholar author
    author_id = None
    if person_name:
        author_id = ss_find_author_by_name(person_name)

    # (If you later want Scholar URL resolution, add it here.)

    pubs = []
    if author_id:
        pubs = ss_author_papers(author_id, limit=100)

    verified, metrics = verify_publications_against_cv(pubs, cv_text or "")

    return {
        "authorId": author_id,
        "publications": verified,
        "metrics": metrics
    }

@app.post("/api/publications/aggregate")
async def publications_aggregate(
    cv_id: Optional[str] = Form(None),
):
    if not cv_id or cv_id not in STORE:
        raise HTTPException(status_code=400, detail="Missing or unknown cv_id")

    stored  = STORE[cv_id]
    parsed  = stored.get("parsed")  or {}
    profile = stored.get("profile") or {}
    name    = profile.get("name") or ""

    # Prefer Semantic Scholar (uses API key via utils.py)
    pubs = []
    author_id = None
    if name:
        author_id = ss_find_author_by_name(name)
        if author_id:
            pubs = ss_author_papers(author_id, limit=100)

    # Fallback to any publications the CV parser returned
    if not pubs:
        pubs = ((parsed.get("publications") or {}).get("publications")) or []

    # Normalize to frontend shape
    out = []
    for p in pubs:
        title = p.get("title","")
        venue = p.get("venue") or p.get("journal") or p.get("conference") or ""
        year  = p.get("year") or p.get("date") or 0
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
