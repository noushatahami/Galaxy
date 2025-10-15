from __future__ import annotations
from typing import List, Dict, Optional, Tuple
from pypdf import PdfReader
from rapidfuzz import fuzz, process
import io, re, requests, os, json
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

# --- Initialize OpenAI client safely ---
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
GPT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-nano")

def extract_cv_data(cv_text: str) -> dict:
    """Use OpenAI to extract structured info from CV text in a strict schema."""
    # NOTE: schema expanded so Grants / Projects / Compliance always have the
    # fields your pages bind to.
    schema_hint = {
        "profile": {
            "name": "",
            "socials": {"LinkedIn": "", "Google Scholar": "", "X": ""},
            "research_areas": [],
            "positions": [],
            "education": [],
            "memberships": []
        },
        "publications": {
            "publications": [
                {"title":"", "authors":[], "venue":"", "year":0, "citationCount":0, "url":""}
            ]
        },

        # Projects is an OBJECT (not a list) with all tiles your UI renders
        "projects": {
            "project_snapshot": {
                "status": "",
                "days_remaining": 0,
                "title": "",
                "description": "",
                "donut_percentage": 0,
                "tags": [{"label": ""}]
            },
            "project_status": {
                "counts": {"active": 0, "on_hold": 0, "stopped": 0},
                "projects": [{"label": "", "status": "", "selected": False}]
            },
            "impact_points": {"total": "", "change": "", "note": ""},
            "total_budget": {"amount": "", "change": "", "note": ""},
            "next_deadline": {"label": "", "date": ""},
            "messages": [{"name": "", "time_ago": "", "subject": ""}],
            "latest_activity": [{"name": "", "action": "", "time_ago": "", "avatar": "", "approved": False}]
        },

        # Grants is an OBJECT with subkeys the Grants page needs
        "grants": {
            "grants": [
                {
                    "id": "",
                    "title": "",
                    "agency": "",
                    "type": "",
                    "duration": "",
                    "amountAwarded": 0,
                    "amountReceived": 0,
                    "amountSpent": 0,
                    "awardedAt": "",
                    "tags": []
                }
            ],
            "reports": { "grantId": "", "nextDue": "", "lastSubmitted": "" },
            "breakdown": { "categories": [ {"label":"", "value":0} ], "total": 0 },
            "keywords": []
        },

        # Compliance is an OBJECT with the cards your page renders
        "compliance": {
            "summary": {"compliant": 0, "pending": 0, "non_compliant": 0},
            "quick_actions": [],
            "key_contacts": [{"name": "", "role": "", "image": ""}],
            "checkpoints": [{"title": "", "status": "", "last_reviewed": ""}],
            "audits": [{"name": "", "date": "", "score": "", "tags": [""]}],
            "notes": []
        }
    }

    prompt = f"""
You are a strict JSON generator for CV parsing.
Return ONLY valid JSON. No commentary.

Schema (use these exact keys; for missing values use empty strings/arrays/objects):
{json.dumps(schema_hint)}

Rules:
- profile.name must be a single string (author's full name).
- profile.research_areas must be an array of short topic strings.
- profile.education must be an array of strings formatted as "Degree, Field, Institution, Year, GPA: X.X".
- publications.publications is an array of items:
  {{"title":"", "authors":[], "venue":"", "year":0, "citationCount":0, "url":""}}
- Projects MUST be an object with keys shown above (not an array).
- Grants MUST include 'grants' array and the sub-objects ('reports','breakdown','keywords').
  * Normalize amounts to digits-only numbers when possible.
  * awardedAt should be YYYY-MM-DD if present, else "".
- Compliance MUST include summary/quick_actions/key_contacts/checkpoints/audits/notes.
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

        # -------- Normalize: ensure all keys exist so the UI never sees undefined --------
        def ensure(k, default):
            if k not in parsed or parsed[k] is None:
                parsed[k] = default

        ensure("profile", schema_hint["profile"])
        ensure("publications", {"publications": []})
        ensure("projects", {})
        ensure("grants", {})
        ensure("compliance", {})

        # Profile defaults
        prof = parsed.get("profile") or {}
        prof.setdefault("socials", {"LinkedIn": "", "Google Scholar": "", "X": ""})
        prof.setdefault("research_areas", [])
        prof.setdefault("positions", [])
        prof.setdefault("education", [])
        prof.setdefault("memberships", [])
        parsed["profile"] = prof

        # Publications defaults
        pubs = parsed.get("publications") or {}
        pubs.setdefault("publications", [])
        parsed["publications"] = pubs

        # Projects defaults (object shape your UI expects)
        proj = parsed.get("projects") or {}
        proj.setdefault("project_snapshot", {
            "status":"", "days_remaining":0, "title":"", "description":"",
            "donut_percentage":0, "tags":[]
        })
        proj.setdefault("project_status", {
            "counts":{"active":0,"on_hold":0,"stopped":0},
            "projects":[]
        })
        proj.setdefault("impact_points", {"total":"", "change":"", "note":""})
        proj.setdefault("total_budget", {"amount":"", "change":"", "note":""})
        proj.setdefault("next_deadline", {"label":"", "date":""})
        proj.setdefault("messages", [])
        proj.setdefault("latest_activity", [])
        parsed["projects"] = proj

        # Grants defaults (object shape your UI expects)
        gr = parsed.get("grants") or {}
        gr.setdefault("grants", [])
        gr.setdefault("reports", {"grantId": "", "nextDue": "", "lastSubmitted": ""})
        gr.setdefault("breakdown", {"categories": [], "total": 0})
        gr.setdefault("keywords", [])
        # Best-effort numeric coercion for amounts inside grants.grants
        for g in gr["grants"]:
            for k in ("amountAwarded","amountReceived","amountSpent"):
                v = g.get(k)
                if isinstance(v, str):
                    # strip currency symbols and commas
                    num = re.sub(r"[^\d.-]", "", v)
                    try:
                        g[k] = int(float(num)) if num else 0
                    except Exception:
                        g[k] = 0
                elif v is None:
                    g[k] = 0
        parsed["grants"] = gr

        # Compliance defaults (object shape your UI expects)
        comp = parsed.get("compliance") or {}
        comp.setdefault("summary", {"compliant":0, "pending":0, "non_compliant":0})
        comp.setdefault("quick_actions", [])
        comp.setdefault("key_contacts", [])
        comp.setdefault("checkpoints", [])
        comp.setdefault("audits", [])
        comp.setdefault("notes", [])
        parsed["compliance"] = comp

        return parsed

    except Exception as e:
        print("OpenAI extraction error:", e)
        # Return full default shape so pages still render empty but valid
        return {
            "profile": schema_hint["profile"],
            "publications": {"publications": []},
            "projects": {
                "project_snapshot": {"status":"", "days_remaining":0, "title":"", "description":"", "donut_percentage":0, "tags":[]},
                "project_status": {"counts":{"active":0,"on_hold":0,"stopped":0}, "projects":[]},
                "impact_points": {"total":"", "change":"", "note":""},
                "total_budget": {"amount":"", "change":"", "note":""},
                "next_deadline": {"label":"", "date":""},
                "messages": [],
                "latest_activity": []
            },
            "grants": {
                "grants": [],
                "reports": {"grantId": "", "nextDue": "", "lastSubmitted": ""},
                "breakdown": {"categories": [], "total": 0},
                "keywords": []
            },
            "compliance": {
                "summary": {"compliant":0, "pending":0, "non_compliant":0},
                "quick_actions": [],
                "key_contacts": [],
                "checkpoints": [],
                "audits": [],
                "notes": []
            }
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

# === OpenAlex robust matching helpers ===
import os, re, unicodedata, requests
from typing import Optional, Iterable
from rapidfuzz import fuzz, process

OA_BASE = os.getenv("OPENALEX_BASE", "https://api.openalex.org").rstrip("/")
OA_CONTACT = os.getenv("OPENALEX_CONTACT", "").strip()  # e.g., "you@org.com"

def _oa_params(extra: dict | None = None):
    p = dict(extra or {})
    if OA_CONTACT:
        p["mailto"] = OA_CONTACT
    return p

def oa_search_authors(name: str, limit: int = 10) -> list[dict]:
    if not name: return []
    try:
        r = requests.get(f"{OA_BASE}/authors",
                         params=_oa_params({"search": name, "per_page": limit}),
                         timeout=20)
        if r.ok:
            return (r.json() or {}).get("results") or []
        else:
            print("OpenAlex author search error:", r.status_code, r.text[:300])
    except Exception as e:
        print("OpenAlex author search exception:", e)
    return []

def oa_author_works(author_id: str, per_page: int = 200) -> list[dict]:
    if not author_id: return []
    try:
        r = requests.get(f"{OA_BASE}/works",
                         params=_oa_params({"filter": f"author.id:{author_id}", "per_page": per_page}),
                         timeout=30)
        if r.ok:
            return (r.json() or {}).get("results") or []
        else:
            print("OpenAlex works error:", r.status_code, r.text[:300])
    except Exception as e:
        print("OpenAlex works exception:", e)
    return []

def oa_author_works_all(author_id: str, max_pages: int = 2) -> list[dict]:
    """Fetch up to ~400 works (2 pages × 200)."""
    allw = []
    page = 1
    while page <= max_pages:
        try:
            r = requests.get(f"{OA_BASE}/works",
                             params=_oa_params({
                                 "filter": f"author.id:{author_id}",
                                 "per_page": 200,
                                 "page": page
                             }),
                             timeout=30)
            if not r.ok: break
            j = r.json() or {}
            batch = j.get("results") or []
            allw.extend(batch)
            if not batch or len(batch) < 200: break
            page += 1
        except Exception as e:
            print("OpenAlex works paged exception:", e)
            break
    return allw

# --- CV parsing + normalization ---

_TITLE_SPLIT = re.compile(r'[:\-–|]\s+')
_DOI_RE = re.compile(r'\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+\b', re.I)

def normalize_title(t: str) -> str:
    """Lowercase, strip accents, collapse spaces, drop punctuation, trim subtitles."""
    if not t: return ""
    # remove subtitles after colon/dash to handle “Main title: subtitle”
    t = _TITLE_SPLIT.split(t, 1)[0]
    t = unicodedata.normalize("NFKD", t)
    t = "".join(ch for ch in t if not unicodedata.combining(ch))
    t = t.lower()
    # keep alnum and spaces
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t

def extract_cv_titles(cv_titles_or_text: Iterable[str] | str) -> list[str]:
    """Accept a list of titles OR raw CV text; return a list of normalized titles."""
    titles: list[str] = []
    if isinstance(cv_titles_or_text, (list, tuple)):
        for t in cv_titles_or_text:
            nt = normalize_title(t)
            if nt: titles.append(nt)
    else:
        # rough extraction from text: lines that look like paper titles (fallback)
        for line in (cv_titles_or_text or "").splitlines():
            line = line.strip()
            if len(line) >= 8 and any(ch.isalpha() for ch in line):
                nt = normalize_title(line)
                if len(nt.split()) >= 3:  # avoid tiny lines
                    titles.append(nt)
    # de-dup
    seen, out = set(), []
    for t in titles:
        if t and t not in seen:
            seen.add(t); out.append(t)
    return out

def extract_dois_from_cv(cv_text: str) -> set[str]:
    return set(m.group(0).lower() for m in _DOI_RE.finditer(cv_text or ""))

def work_main_title(w: dict) -> str:
    return normalize_title(w.get("display_name") or "")

def work_doi(w: dict) -> Optional[str]:
    doi = (w.get("ids") or {}).get("doi") or ""
    return doi.lower() if doi else None

def author_affiliation_str(author_obj: dict) -> str:
    """Join institution/display names OpenAlex provides for the author."""
    parts = []
    inst = author_obj.get("last_known_institution") or {}
    if isinstance(inst, dict):
        nm = inst.get("display_name")
        if nm: parts.append(nm)
    # some candidates have "institutions" array
    for i in author_obj.get("institutions") or []:
        nm = i.get("display_name")
        if nm: parts.append(nm)
    return " | ".join(parts)

# --- Robust author picker ---
def oa_pick_author_by_cv(
    person_name: str,
    cv_titles_or_text: Iterable[str] | str,
    *,
    cv_affiliation: Optional[str] = None,
    high_thresh: int = 88,
    mid_thresh: int = 75,
) -> Optional[str]:
    """
    Return an OpenAlex author.id (URI) ONLY IF we are confident:
      - DOI match with any work, OR
      - max title similarity >= high_thresh, OR
      - at least two titles >= mid_thresh (more tolerant),
      (and optionally affiliation similarity helps tie-break).
    Otherwise return None.
    """
    if not person_name:
        return None

    # Collect CV titles + DOIs
    cv_titles = extract_cv_titles(cv_titles_or_text)
    cv_dois   = extract_dois_from_cv(cv_titles_or_text if isinstance(cv_titles_or_text, str) else "")

    if not cv_titles and not cv_dois:
        return None

    candidates = oa_search_authors(person_name, limit=10) or []
    chosen_id, chosen_score = None, -1

    for cand in candidates:
        aid = cand.get("id") or cand.get("openalex")
        if not aid:
            continue

        works = oa_author_works_all(aid, max_pages=2)  # up to ~400 works
        if not works:
            continue

        # quick DOI shortcut (strongest signal)
        if cv_dois:
            w_dois = set(filter(None, (work_doi(w) for w in works)))
            if w_dois & cv_dois:
                return aid  # immediate accept

        # title similarity stats
        s_titles = [work_main_title(w) for w in works if work_main_title(w)]
        max_sim = 0
        count_mid = 0

        # score each CV title against OpenAlex titles using multiple scorers; keep max
        for t in cv_titles:
            # try a few fuzz scorers and take the best
            s1 = fuzz.token_set_ratio(t, s_titles, score_cutoff=0) if isinstance(s_titles, str) else 0
            # fall back to manual best-of list
            best_list = 0
            for st in s_titles:
                best_list = max(
                    best_list,
                    fuzz.token_set_ratio(t, st),
                    fuzz.token_sort_ratio(t, st),
                    fuzz.partial_ratio(t, st),
                )
            best = max(s1 or 0, best_list)
            max_sim = max(max_sim, best)
            if best >= mid_thresh:
                count_mid += 1

        # Affiliation nudge (non-blocking)
        aff_boost = 0
        if cv_affiliation:
            a_aff = author_affiliation_str(cand)
            if a_aff:
                aff_boost = fuzz.token_set_ratio(cv_affiliation, a_aff)

        # decide
        strong = max_sim >= high_thresh
        moderate = count_mid >= 2
        boosted = (aff_boost >= 80 and max_sim >= (mid_thresh - 2))

        if strong or moderate or boosted:
            # prefer the best score across candidates
            score_for_choice = max_sim + (aff_boost / 100.0)  # tiny boost
            if score_for_choice > chosen_score:
                chosen_score = score_for_choice
                chosen_id = aid

    return chosen_id
# ------------- Semantic Scholar helpers -------------

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

def verify_publications_against_cv(pubs: list[dict], cv_text: str) -> tuple[list[dict], dict]:
    verified = []
    for p in pubs:
        title = p.get("title") or ""
        ok, score = fuzzy_match(title, cv_text)

        # --- normalize authors: allow list[str] or list[dict] ---
        raw_authors = p.get("authors") or []
        authors: list[str] = []
        if isinstance(raw_authors, list):
            for a in raw_authors:
                if isinstance(a, dict):
                    if a.get("name"):
                        authors.append(a["name"])
                elif isinstance(a, str):
                    if a.strip():
                        authors.append(a.strip())

        # --- normalize citations to what the UI expects ---
        citations = p.get("citations")
        if citations is None:
            citations = p.get("citationCount", 0)

        p2 = {
            "title": title,
            "year": p.get("year"),
            "venue": p.get("venue") or p.get("journal") or p.get("conference"),
            "citations": citations,                    # <-- UI key
            "authors": authors,
            "url": p.get("url"),
            "verified": bool(ok),
            "score": score,
        }
        verified.append(p2)

    # metrics (unchanged; now uses 'citations')
    cites = [int(p.get("citations") or 0) for p in verified]
    total_cites = sum(cites)
    s = sorted(cites, reverse=True)
    h = 0
    for i, c in enumerate(s, start=1):
        if c >= i: h = i
        else: break
    i10 = sum(1 for c in cites if c >= 10)
    metrics = {"totalCitations": total_cites, "hIndex": h, "i10": i10}
    return verified, metrics

# --- CV-aware + stable S2 author resolution ---

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
        # Step 1: candidate list by name
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
    
# --- Author disambiguation using CV titles (drop-in) ---
def _extract_cv_titles_from_text(cv_text: str) -> list[str]:
    """
    Very light heuristic: collect lines under a 'PUBLICATIONS' block and lines that look like papers.
    Your CV example already has a PUBLICATIONS section; this is enough for matching.
    """
    titles = []
    lines = [l.strip(" •\t\r") for l in cv_text.splitlines()]
    in_pubs = False
    for ln in lines:
        up = ln.upper()
        if "PUBLICATIONS" in up:
            in_pubs = True
            continue
        if in_pubs:
            # stop if we hit another big section
            if up in {"CONFERENCES","AWARDS","HONOURS","TEACHING","EXPERIENCE","SKILLS","EXTRA CURRICULARS","EXTRACURRICULARS"}:
                break
            # very loose: collect lines with at least ~6 words and a period or quote
            if len(ln.split()) >= 6:
                titles.append(ln)
    # clean obvious leading numbering like "1. " etc
    titles = [t.split(")", 1)[-1].split(".", 1)[-1].strip() if t[:2].isdigit() else t for t in titles]
    # de-duplicate
    seen = set()
    uniq = []
    for t in titles:
        tt = t.lower()
        if tt not in seen:
            uniq.append(t)
            seen.add(tt)
    return uniq[:20]  # keep it small

def ss_pick_author_by_cv(person_name: str, cv_text: str, *, max_candidates: int = 5) -> Optional[str]:
    """
    Try several candidate authors for this name and keep the one that has
    at least ONE fuzzy match with a CV title. Returns author_id or None.
    """
    if not person_name:
        return None

    cv_titles = _extract_cv_titles_from_text(cv_text or "")
    # if CV has no clear titles, fall back to plain name search
    if not cv_titles:
        try:
            return ss_find_author_by_name(person_name)
        except Exception:
            return None

    # get a few candidate authors by name (your ss_find_author_by_name returns a single id).
    # If you only have single-id search available, we can still verify it below and bail if no match.
    first_author = None
    try:
        first_author = ss_find_author_by_name(person_name)
    except Exception:
        first_author = None

    candidates = [a for a in [first_author] if a][:max_candidates]

    best_author = None
    best_score = -1

    for author_id in candidates:
        try:
            papers = ss_author_papers(author_id, limit=100) or []
        except Exception:
            papers = []

        # titles from S2
        s2_titles = []
        for p in papers:
            t = p.get("title") or ""
            if t:
                s2_titles.append(t)

        # fastest check: max fuzzy partial ratio against any S2 title
        # If any CV title ≈ any S2 title at >= 85, call it a hit.
        local_best = 0
        for cvt in cv_titles:
            match, score, _ = process.extractOne(
                cvt,
                s2_titles,
                scorer=fuzz.token_set_ratio
            ) if s2_titles else (None, 0, None)
            if score > local_best:
                local_best = score

        if local_best >= 85:
            # strong evidence this is the right author
            if local_best > best_score:
                best_score = local_best
                best_author = author_id

    # If nothing verified, return None (caller will fall back to CV-only pubs)
    return best_author
