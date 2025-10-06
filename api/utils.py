from __future__ import annotations
from typing import List, Dict, Optional, Tuple
from pypdf import PdfReader
from rapidfuzz import fuzz
import io, re, requests, os, json
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

# --- Initialize OpenAI client safely ---
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
GPT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-nano")

def extract_cv_data(cv_text: str) -> dict:
    """Use OpenAI to extract structured info from CV text in a strict schema."""
    schema_hint = {
        "profile": {
            "name": "",
            "socials": {"LinkedIn": "", "Google Scholar": "", "X": ""},
            "research_areas": [],
            "positions": [],
            "education": [],
            "memberships": []
        },
        "publications": {"publications": []},
        "projects": [],
        "grants": {},
        "compliance": {}
    }

    prompt = f"""
You are a strict JSON generator for CV parsing.
Return ONLY valid JSON. No commentary.

Schema (use these exact keys; for missing values use empty strings/arrays/objects):
{json.dumps(schema_hint)}

Rules:
- profile.name must be a single string (author's full name).
- profile.research_areas must be an array of short topic strings.
- publications.publications is an array of items: 
  {{ "title":"", "authors":[], "venue":"", "year":0, "citationCount":0, "url":"" }}
- Do not invent items; if not in CV, leave empty arrays/zeros/empty strings.
- Titles and names should be as they appear in the CV.

CV TEXT (truncate to 15k chars):
{cv_text[:15000]}
"""
    try:
        completion = client.chat.completions.create(
            model=GPT_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            response_format={"type": "json_object"}
        )
        data = completion.choices[0].message.content
        parsed = json.loads(data)

        # Normalize: ensure all keys exist so the UI never sees undefined
        def ensure(k, default):
            if k not in parsed or parsed[k] is None:
                parsed[k] = default
        ensure("profile", schema_hint["profile"])
        ensure("publications", {"publications": []})
        ensure("projects", [])
        ensure("grants", {})
        ensure("compliance", {})

        # Ensure required subkeys
        prof = parsed.get("profile") or {}
        prof.setdefault("socials", {"LinkedIn": "", "Google Scholar": "", "X": ""})
        prof.setdefault("research_areas", [])
        prof.setdefault("positions", [])
        prof.setdefault("education", [])
        prof.setdefault("memberships", [])
        parsed["profile"] = prof

        pubs = parsed.get("publications") or {}
        pubs.setdefault("publications", [])
        parsed["publications"] = pubs

        return parsed
    except Exception as e:
        print("OpenAI extraction error:", e)
        return {
            "profile": schema_hint["profile"],
            "publications": {"publications": []},
            "projects": [],
            "grants": {},
            "compliance": {}
        }

# ------------- PDF helpers -------------

def read_pdf_text(file_bytes: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(file_bytes))
        out = []
        for p in reader.pages:
            out.append(p.extract_text() or "")
        return "\n".join(out)
    except Exception:
        return ""

def first_reasonable_name(txt: str) -> Optional[str]:
    for line in (txt or "").splitlines():
        L = line.strip()
        if not L:
            continue
        # short line with letters/spaces, not a section header
        if 3 < len(L) <= 60 and re.search(r"[A-Za-z]", L) and not L.endswith(":"):
            if not (L.isupper() and " " not in L.strip()):
                return L
    return None

def grep_lines(txt: str, needles: List[str], max_items: int = 12) -> List[str]:
    hits = []
    for line in (txt or "").splitlines():
        L = " ".join(line.split())
        if not L:
            continue
        for n in needles:
            if n.lower() in L.lower():
                hits.append(L)
                break
    # dedupe keep order
    seen, out = set(), []
    for h in hits:
        if h not in seen:
            out.append(h)
            seen.add(h)
    return out[:max_items]

def guess_research_areas(txt: str) -> List[str]:
    CAND = [
        "AI","Artificial Intelligence","Machine Learning","Deep Learning","NLP",
        "Computer Vision","Robotics","Biomedical","HCI","Reinforcement Learning",
        "Data Mining","Security","Systems","Databases","Genomics","Wearables"
    ]
    found = []
    for w in CAND:
        if re.search(rf"\b{re.escape(w)}\b", txt, flags=re.I):
            found.append(w)
    norm = {"Artificial Intelligence":"AI"}
    return [norm.get(x,x) for x in found]

# ------------- Semantic Scholar helpers -------------

import os
SS_BASE = "https://api.semanticscholar.org/graph/v1"
SS_KEY = os.getenv("SEMANTIC_SCHOLAR_API_KEY", "").strip()
SS_HEADERS = {"x-api-key": SS_KEY} if SS_KEY else {}

def ss_find_author_by_name(name: str) -> Optional[str]:
    try:
        r = requests.get(
            f"{SS_BASE}/author/search",
            params={"query": name, "limit": 1, "fields": "name"},
            headers=SS_HEADERS or None,
            timeout=20,
        )
        if r.ok:
            data = r.json()
            if data.get("total",0) > 0 and data.get("data"):
                return str(data["data"][0]["authorId"])
        else:
            print("S2 search error:", r.status_code, r.text[:300])
    except Exception as e:
        print("S2 search exception:", e)
    return None

def ss_author_papers(author_id: str, limit: int = 100) -> List[Dict]:
    try:
        fields = "title,year,venue,citationCount,authors,url,externalIds"
        r = requests.get(
            f"{SS_BASE}/author/{author_id}/papers",
            params={"limit": limit, "fields": fields},
            headers=SS_HEADERS or None,
            timeout=30,
        )
        if r.ok:
            return r.json().get("data", [])
        else:
            print("S2 papers error:", r.status_code, r.text[:300])
    except Exception as e:
        print("S2 papers exception:", e)
    return []

# ------------- CV vs publications verification -------------

def fuzzy_match(title: str, cv_text: str, threshold: int = 80) -> Tuple[bool,int]:
    best = 0
    for line in cv_text.splitlines():
        L = " ".join(line.split())
        if not L:
            continue
        score = fuzz.token_set_ratio(title, L)
        if score > best:
            best = score
            if best >= threshold:
                return True, best
    return best >= threshold, best

def verify_publications_against_cv(pubs: List[Dict], cv_text: str) -> Tuple[List[Dict], Dict]:
    verified = []
    for p in pubs:
        title = p.get("title") or ""
        ok, score = fuzzy_match(title, cv_text)
        p2 = {
            "title": title,
            "year": p.get("year"),
            "venue": p.get("venue"),
            "citationCount": p.get("citationCount", 0),
            "authors": [a.get("name") for a in (p.get("authors") or []) if a.get("name")],
            "url": p.get("url"),
            "verified": bool(ok),
            "score": score,
        }
        verified.append(p2)

    cites = [p.get("citationCount", 0) for p in verified]
    total_cites = sum(cites)
    sorted_c = sorted(cites, reverse=True)
    h = 0
    for i, c in enumerate(sorted_c, start=1):
        if c >= i: h = i
        else: break
    i10 = sum(1 for c in cites if c >= 10)
    metrics = {"totalCitations": total_cites, "hIndex": h, "i10": i10}
    return verified, metrics

# --- CV-aware + stable S2 author resolution ---

from rapidfuzz import fuzz

AFFIL_HINT_WORDS = [
    "university","institute","laboratory","lab","college","department",
    "centre","center","school","faculty","hospital"
]

def _affil_candidates_from_cv(cv_text: str, max_len: int = 2000) -> list[str]:
    if not cv_text:
        return []
    lines = [" ".join(l.split()) for l in cv_text[:max_len].splitlines() if l.strip()]
    hits, seen = [], set()
    for L in lines:
        low = L.lower()
        if any(w in low for w in AFFIL_HINT_WORDS):
            if L not in seen:
                hits.append(L); seen.add(L)
    return hits[:20]

def _fetch_author_affiliations(author_id: str) -> str:
    try:
        r = requests.get(
            f"{SS_BASE}/author/{author_id}",
            params={"fields": "name,affiliations"},
            headers=SS_HEADERS or None,
            timeout=20,
        )
        if r.ok:
            j = r.json() or {}
            return j.get("affiliations") or ""
    except Exception:
        pass
    return ""

def resolve_s2_author_id_stable(name: str, cv_text: str, max_candidates: int = 5) -> tuple[Optional[str], dict]:
    """
    Search by name; for each candidate:
      - fetch papers and count how many titles verify against the CV text
      - compare affiliations vs CV lines
    Score = verified_count * 10 + affil_score; pick the best. Return (author_id, debug).
    """
    debug = {"candidates": []}
    try:
        # Step 1: candidate list by name (no unsupported fields param)
        r = requests.get(
            f"{SS_BASE}/author/search",
            params={"query": name, "limit": max_candidates},
            headers=SS_HEADERS or None,
            timeout=20,
        )
        if not r.ok:
            debug["error"] = f"S2 search {r.status_code}: {r.text[:200]}"
            return None, debug

        data = r.json() or {}
        cands = data.get("data") or []
        if not cands:
            debug["note"] = "no candidates"
            return None, debug

        affil_lines = _affil_candidates_from_cv(cv_text)
        best_id, best_score = None, -1

        for c in cands:
            aid = str(c.get("authorId"))
            if not aid:
                continue

            papers = ss_author_papers(aid, limit=80) or []
            verified, _m = verify_publications_against_cv(papers, cv_text or "")
            verified_count = sum(1 for p in verified if p.get("verified"))

            affs = _fetch_author_affiliations(aid)
            affil_score = 0
            for L in affil_lines:
                affil_score = max(affil_score, fuzz.partial_ratio(L, affs))

            score = verified_count * 10 + affil_score
            debug["candidates"].append({
                "author_id": aid,
                "verified_count": verified_count,
                "affil_score": affil_score,
                "score": score,
            })
            if score > best_score:
                best_score, best_id = score, aid

        # Soft guard: if literally no signal, return None so caller can fall back to CV pubs
        if best_id is None:
            return None, debug
        best = next((x for x in debug["candidates"] if x["author_id"] == best_id), None)
        if best and best["verified_count"] == 0 and best["affil_score"] < 30:
            debug["note"] = "low-confidence candidate"
            return None, debug

        debug["chosen"] = best_id
        return best_id, debug
    except Exception as e:
        debug["exception"] = str(e)
        return None, debug
