# services/enrich.py
import json
import os, time, re
import requests
from urllib.parse import urlencode
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import json as pyjson

# One shared session with retries/backoff
_SERP_SESSION = requests.Session()
_SERP_SESSION.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=3,                # try up to 3 times
            backoff_factor=1.5,     # 0s, 1.5s, 3s…
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"]
        )
    )
)

OPENALEX_BASE = os.getenv("OPENALEX_BASE", "https://api.openalex.org")
OPENALEX_CONTACT = os.getenv("OPENALEX_CONTACT", "niyoosha.tahami@masterly.ca")
SERPAPI_KEY = os.getenv("SERPAPI_KEY")
ORCID_BASE = os.getenv("ORCID_BASE", "https://pub.orcid.org")
CROSSREF_BASE = os.getenv("CROSSREF_BASE", "https://api.crossref.org")
CROSSREF_CONTACT = os.getenv("CROSSREF_CONTACT", OPENALEX_CONTACT)

# ---------------- ORCID / Crossref GETs ----------------
def orcid_get(path, params=None):
    url = path if path.startswith("http") else f"{ORCID_BASE}{path}"
    headers = {**HEADERS, "Accept": "application/json"}
    return requests.get(url, params=params or {}, headers=headers, timeout=30)

def crossref_get(path, params=None):
    url = path if path.startswith("http") else f"{CROSSREF_BASE}{path}"
    headers = {**HEADERS, "User-Agent": f"Galaxy/1.0 (mailto:{CROSSREF_CONTACT})"}
    return requests.get(url, params=params or {}, headers=headers, timeout=30)

def orcid_search(full_name, affiliation_hint=None):
    parts = (full_name or "").strip().split()
    if not parts:
        return None
    given = " ".join(parts[:-1]) if len(parts) > 1 else parts[0]
    family = parts[-1]

    def _do_search(q, rows=5):
        r = orcid_get("/v3.0/expanded-search", params={"q": q, "rows": rows})
        if r.status_code >= 400:
            return []
        return (r.json() or {}).get("expanded-result", []) or []

    # Try with affiliation first
    q = f'given-names:"{given}" AND family-name:"{family}"'
    if affiliation_hint:
        q_aff = q + f' AND affiliation-org-name:"{affiliation_hint}"'
        items = _do_search(q_aff, rows=3)
        if items:
            return items[0]

    # Fallback: no affiliation filter
    items = _do_search(q, rows=5)
    return items[0] if items else None


def orcid_record(orcid_id):
    if not orcid_id:
        return {}
    r = orcid_get(f"/v3.0/{orcid_id}/person")
    if r.status_code >= 400:
        return {}
    return r.json() or {}

def map_orcid_to_profile(orcid_json):
    # Pull a few safe fields (employment/education names) to enhance profile
    try:
        out_affs = []
        emp = (orcid_json.get("employments") or {}).get("employment-summary") or []
        edu = (orcid_json.get("educations") or {}).get("education-summary") or []
        for s in emp + edu:
            org = (s.get("organization") or {}).get("name")
            if org and org not in out_affs:
                out_affs.append(org)
        return {"affiliations": out_affs}
    except Exception:
        return {}

# --------- ORCID fundings (summary + detail hydration) ---------
def orcid_funding_detail(orcid_id, put_code):
    """Fetch a single funding record with full fields (amount, currency, etc.)."""
    if not orcid_id or not put_code:
        return {}
    r = orcid_get(f"/v3.0/{orcid_id}/funding/{put_code}")
    if r.status_code >= 400:
        return {}
    return r.json() or {}

def _orcid_pick_amount(obj):
    """Return (currency, value_float) from an ORCID 'amount' object (summary/detail)."""
    try:
        amt = obj.get("amount") or {}
        val = amt.get("value")
        cur = (amt.get("currency-code") or "").upper()
        if isinstance(val, str):
            val = val.replace(",", "").strip()
        val = float(val) if val not in (None, "") else 0.0
        return (cur, val)
    except Exception:
        return ("", 0.0)

def orcid_activities(orcid_id):
    """Fetch activities summary; if no fundings there, fall back to /fundings."""
    if not orcid_id:
        return {}
    r = orcid_get(f"/v3.0/{orcid_id}/activities")
    if r.status_code >= 400:
        r2 = orcid_get(f"/v3.0/{orcid_id}/fundings")
        if r2.status_code >= 400:
            return {}
        return {"fundings": r2.json() or {}}

    j = r.json() or {}
    groups = (((j.get("fundings") or {}).get("group")) or [])
    if not groups:
        r2 = orcid_get(f"/v3.0/{orcid_id}/fundings")
        if r2.status_code < 400:
            return {"fundings": r2.json() or {}}
    return j


def parse_orcid_fundings(orcid_id, activities_json):
    """Flatten funding summaries; if amount is missing, hydrate from detail endpoint."""
    groups = (((activities_json or {}).get("fundings") or {}).get("group")) or []
    items = []
    for g in groups:
        for fsum in (g.get("funding-summary") or []):
            title = ((fsum.get("title") or {}).get("title") or {}).get("value", "") or fsum.get("title", {}).get("value", "") or ""
            org = ((fsum.get("organization") or {}).get("name")) or ""
            ftype = (fsum.get("type") or "").replace("_", " ").title()
            put_code = fsum.get("put-code")

            # Try amount from summary first
            cur, val = _orcid_pick_amount(fsum)

            # If summary has no amount, fetch the detail record
            if not val and put_code and orcid_id:
                fdetail = orcid_funding_detail(orcid_id, put_code)
                if fdetail:
                    cur, val = _orcid_pick_amount(fdetail)
                    if not title:
                        title = ((fdetail.get("title") or {}).get("title") or {}).get("value", "") or ""
                    if not org:
                        org = ((fdetail.get("organization") or {}).get("name")) or org
                    if not ftype:
                        ftype = (fdetail.get("type") or "").replace("_", " ").title()

            # Dates
            def _safe_date(d):
                if not d: return ""
                y = ((d.get("year") or {}).get("value")) or ""
                m = ((d.get("month") or {}).get("value")) or "01"
                day = ((d.get("day") or {}).get("value")) or "01"
                return f"{y}-{int(m):02d}-{int(day):02d}" if y else ""
            start = _safe_date(fsum.get("start-date") or {})
            end = _safe_date(fsum.get("end-date") or {})

            # External/grant id
            gid = ""
            try:
                eids = ((fsum.get("external-ids") or {}).get("external-id")) or []
                for e in eids:
                    t = (e.get("external-id-type") or "").lower()
                    v = e.get("external-id-value") or ""
                    if t in ("grant_number","award","proposal","application","other-id") and v:
                        gid = v; break
                if not gid and eids:
                    gid = eids[0].get("external-id-value") or ""
            except Exception:
                pass

            items.append({
                "title": title,
                "agency": org,
                "type": ftype,
                "start": start,
                "end": end,
                "amount_currency": cur,
                "amount_value": val,
                "grant_id": gid,
            })
    return items

def map_orcid_fundings_to_grants(full_name, current_grants, fundings, orcid_keywords=None):
    """Map ORCID funding list to your grants schema (best-effort)."""
    data = dict(current_grants or {})
    data["name"] = full_name or data.get("name","")

    # Choose the 'last awarded' as the one with the latest end (fallback: start)
    def sort_key(f):
        return (f.get("end") or f.get("start") or "", f.get("title") or "")
    fundings_sorted = sorted([f for f in fundings if any([f.get("start"), f.get("end")])], key=sort_key, reverse=True)
    last = fundings_sorted[0] if fundings_sorted else (fundings[0] if fundings else {})

    # Fill last_awarded_grant
    if last:
        amount_awarded = f"{last['amount_currency']} {int(last['amount_value'])}" if last.get("amount_value") else ""
        data["last_awarded_grant"] = {
            "title": last.get("title",""),
            "grant_id": last.get("grant_id",""),
            "agency": last.get("agency",""),
            "agency_short": (last.get("agency","")[:12] + "…") if last.get("agency") and len(last["agency"])>12 else last.get("agency",""),
            "type": last.get("type",""),
            "duration": "",
            "extension": "",
            "amount_awarded": amount_awarded,
            "amount_received": "",
            "amount_spent": "",
            "tags": [t for t in (orcid_keywords or [])][:5] or [""]
        }
        if last.get("start") or last.get("end"):
            ys = last.get("start","")[:4]; ye = last.get("end","")[:4]
            if ys and ye and ys != "":
                data["last_awarded_grant"]["duration"] = f"{ys}–{ye}"

        gid = last.get("grant_id","")
        data["breakdown"] = {"grant_id": gid}
        data["reports"] = {"grant_id": gid, "next_due": "", "last_submitted": ""}
        data["keywords_section"] = {"grant_id": gid, "keywords": [t for t in (orcid_keywords or [])][:10] or [""]}

    # Total per currency; display the largest bucket
    if fundings:
        totals = {}
        for f in fundings:
            c = (f.get("amount_currency") or "").upper()
            v = float(f.get("amount_value") or 0)
            if c and v:
                totals[c] = totals.get(c, 0) + v
        if totals:
            top = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[0]
            data["total_grants_awarded"] = {"amount": f"{top[0]} {int(top[1])}", "change": "", "note": "From ORCID fundings"}
        data.setdefault("available_budget", {"amount": "", "change": "", "note": ""})
        data.setdefault("partners", {"Academic Partners": 0, "Industry Partners": 0})
    return data

# ---------------- Crossref (per-DOI) ----------------
def crossref_work(doi):
    doi = _doi(doi)
    if not doi:
        return {}
    r = crossref_get(f"/works/{doi}")
    if r.status_code >= 400:
        return {}
    return (r.json() or {}).get("message", {})

def map_crossref_to_pub_fields(msg):
    if not msg:
        return {}
    journal = (msg.get("container-title") or [""])[0] or ""
    year = 0
    try:
        y = (msg.get("issued") or {}).get("date-parts") or []
        if y and y[0]:
            year = int(y[0][0])
    except Exception:
        pass
    url = msg.get("URL", "")
    issue = (msg.get("issue") or "")
    volume = (msg.get("volume") or "")
    pages = (msg.get("page") or "")
    return {
        "journal": journal,
        "year": year or 0,
        "pdf_link": url or "",
        "issue": issue,
        "volume": volume,
        "pages": pages
    }

# ---------- Helpers ----------
HEADERS = {"User-Agent": f"Galaxy/1.0 (mailto:{OPENALEX_CONTACT})"}
CONTACT = {"mailto": OPENALEX_CONTACT}

def _norm(s):
    return (s or "").strip()

def _doi(s):
    if not s: return ""
    s = s.lower().strip()
    return s.replace("https://doi.org/", "").replace("http://doi.org/", "")

def dedupe_publications(items):
    seen = set()
    out = []
    for it in items:
        key = _doi(it.get("doi")) or (_norm(it.get("title")).lower(), it.get("year"))
        if key not in seen:
            seen.add(key)
            out.append(it)
    return out

def prefer_filled_value(primary, secondary):
    if primary and _norm(primary).lower() != "pending input":
        return primary
    return secondary or primary

def merge_publications(cv_list, extra_list):
    merged = list(cv_list or [])
    merged.extend(extra_list or [])
    return dedupe_publications(merged)

def serpapi_get(params, timeout=60):
    r = _SERP_SESSION.get("https://serpapi.com/search.json", params=params, timeout=timeout)
    r.raise_for_status()
    return r.json()

# ---------- OpenAlex ----------
def oa_get(path_or_url, params):
    """Centralized GET with contact + headers."""
    if path_or_url.startswith("http"):
        url = path_or_url
    else:
        url = f"{OPENALEX_BASE}{path_or_url}"
    params = {**(params or {}), **CONTACT}
    return requests.get(url, params=params, headers=HEADERS, timeout=30)

def openalex_find_institution_id(display_name):
    if not display_name:
        return None
    r = oa_get("/institutions", {"search": display_name, "per_page": 1})
    r.raise_for_status()
    results = r.json().get("results", [])
    return results and results[0].get("id")

def openalex_find_author(full_name, affiliation_hint=None):
    params = {"search": full_name, "per_page": 5}
    inst_id = openalex_find_institution_id(affiliation_hint) if affiliation_hint else None
    if inst_id:
        params["filter"] = f"last_known_institution.id:{inst_id}"
    r = oa_get("/authors", params)
    # Graceful retry without filter if blocked
    if r.status_code == 403 and "filter" in params:
        params.pop("filter", None)
        r = oa_get("/authors", params)
    r.raise_for_status()
    data = r.json()
    return (data.get("results") or [None])[0]

def openalex_author_works(author_id, from_year=2010, to_year=None, per_page=200):
    if not author_id:
        return []
    filters = [f"authorships.author.id:{author_id}"]
    if from_year:
        filters.append(f"from_publication_date:{from_year}-01-01")
    if to_year:
        filters.append(f"to_publication_date:{to_year}-12-31")
    params = {"filter": ",".join(filters), "per_page": per_page, "sort": "publication_date:desc"}
    results = []
    url = "/works"
    while True:
        r = oa_get(url, params)
        if r.status_code == 403:
            r = oa_get(url, params)  # retry once
        r.raise_for_status()
        j = r.json()
        results.extend(j.get("results", []))
        next_url = j.get("meta", {}).get("next_page_url")
        if not next_url:
            break
        url, params = next_url.replace(OPENALEX_BASE, ""), {}
        time.sleep(0.2)
    return results

def map_openalex_works_to_schema(works):
    out = []
    for w in works:
        title = w.get("title") or ""
        journal = (w.get("host_venue") or {}).get("display_name") or ""
        year = int(w["publication_year"]) if w.get("publication_year") else 0
        authorships = w.get("authorships") or []
        authors = ", ".join([a.get("author", {}).get("display_name", "") for a in authorships if a.get("author")])
        doi = _doi((w.get("ids") or {}).get("doi"))
        pdf_link = (w.get("open_access") or {}).get("oa_url") or (w.get("host_venue") or {}).get("url") or ""
        tags = [t.get("display_name", "") for t in (w.get("topics") or [])]
        citations = w.get("cited_by_count") or 0
        status = "Published" if year else "In Press"
        out.append({
            "title": title,
            "authors": authors,
            "journal": journal,
            "year": year,
            "tags": tags or [""],
            "doi": doi,
            "pdf_link": pdf_link,
            "status": status,
            "citations": citations
        })
    return out

# ---------- SerpAPI (Google Scholar) ----------
def serpapi_author_metrics(scholar_url=None, name=None):
    if not SERPAPI_KEY:
        return {}
    params = {"api_key": SERPAPI_KEY}

    if scholar_url and "user=" in scholar_url:
        m = re.search(r"[?&]user=([^&]+)", scholar_url)
        if m:
            params.update({"engine": "google_scholar_author", "author_id": m.group(1)})
        else:
            params.update({"engine": "google_scholar_profiles", "mauthors": name or ""})
    else:
        params.update({"engine": "google_scholar_profiles", "mauthors": name or ""})

    params["num"] = 10

    try:
        data = serpapi_get(params, timeout=60)  # longer timeout + retries
        return data
    except Exception as e:
        print("SerpAPI enrichment skipped:", e)
        return {}

def map_scholar_to_citation_counts(scholar_json):
    try:
        if scholar_json.get("engine") == "google_scholar_author" or "cited_by" in scholar_json:
            return {"total_citations": scholar_json["cited_by"]["table"][0]["citations"]["all"]}
        profiles = scholar_json.get("profiles") or []
        if profiles and profiles[0].get("cited_by"):
            return {"total_citations": profiles[0]["cited_by"]}
    except Exception:
        pass
    return {}

# ---------- Google Patents via SerpAPI ----------
def google_patents_search(name, max_results=50):
    if not SERPAPI_KEY or not name:
        return []
    params = {
        "engine": "google_patents",
        "q": f'inventor:"{name}"',
        "num": max_results,
        "api_key": SERPAPI_KEY,
    }
    try:
        data = serpapi_get(params, timeout=60)
        # SerpAPI Google Patents returns items in "organic_results"
        items = (data or {}).get("organic_results") or []
        # Optional: small debug
        print("[Google Patents] organic_results:", len(items))
        return items
    except Exception as e:
        print("Google Patents enrichment skipped:", e)
        return []

def _status_from_patent_number(num: str) -> str:
    """Infer patent status from the kind code in the number."""
    n = (num or "").upper()
    # US: A1/A = application publication; B1/B2 = granted
    # JP: B2 commonly granted; A = application publication
    if any(k in n for k in [" B1", " B2"]) or n.endswith("B1") or n.endswith("B2"):
        return "Granted"
    if "A1" in n or n.endswith("A1") or n.endswith("A"):
        return "Application"
    # Fallback if unknown
    return "Granted" if n else "Filed"

def map_google_patents_to_schema(items):
    out = []
    for it in items or []:
        title = it.get("title") or ""
        number = it.get("publication_number") or it.get("patent_number") or ""
        inventors = it.get("inventors") or []
        if isinstance(inventors, str):
            inventors = [inventors]
        filed = it.get("filing_date") or it.get("publication_date") or ""
        out.append({
            "title": title,
            "number": number,
            "inventors": inventors or [""],
            "filed": filed,
            "status": _status_from_patent_number(number)
        })
    return out

def dedupe_patents(items):
    seen, out = set(), []
    for p in items or []:
        key = (p.get("number") or "").strip().lower() or (
            (p.get("title","").strip().lower(), p.get("filed","").strip())
        )
        if key not in seen:
            seen.add(key); out.append(p)
    return out

# ---------- PatentsView ----------
def patentsview_inventor_patents(name):
    base = os.getenv("PATENTSVIEW_BASE", "https://api.patentsview.org")
    parts = (name or "").strip().split()
    first = " ".join(parts[:-1]) if len(parts) > 1 else parts[0] if parts else ""
    last = parts[-1] if len(parts) > 1 else ""

    # Try (first,last) AND; if that fails, try a full-name text search as fallback
    q_primary = {
        "_and": [
            {"inventor_first_name": first},
            {"inventor_last_name": last}
        ]
    } if first and last else {"_text_any": {"inventor_full_name": name}}

    params = {
        "q": json.dumps(q_primary),
        "f": json.dumps(["patent_number","patent_title","patent_date",
                         "inventor_last_name","inventor_first_name"]),
        "o": json.dumps({"per_page": 100})
    }
    r = requests.get(f"{base}/patents/query", params=params, timeout=30)
    if r.status_code >= 400 or not r.json().get("patents"):
        # Fallback: loose text search on full name
        params["q"] = json.dumps({"_text_any": {"inventor_full_name": name}})
        r = requests.get(f"{base}/patents/query", params=params, timeout=30)
        if r.status_code >= 400:
            return []
    return r.json().get("patents", [])

def map_patents_to_schema(items):
    out = []
    for p in items:
        number = p.get("patent_number","")
        title = p.get("patent_title","")
        filed = p.get("patent_date","")
        inventors = [""]  # we don't have inventor names from this endpoint by default
        out.append({
            "title": title,
            "number": number,
            "inventors": inventors,
            "filed": filed,
            "status": "Granted" if number else "Filed"
        })
    return out

# ---------- Orchestrator ----------
def enrich(parsed_data, user_context):
    profile = parsed_data.get("profile", {}) or {}
    pubs = (parsed_data.get("publications", {}) or {}).get("publications", [])  # list
    patents = profile.get("patents", []) or []

    full_name = user_context.get("name") or profile.get("name")
    affiliation = (profile.get("affiliations") or [""])[0] if isinstance(profile.get("affiliations"), list) else ""
    scholar_url = (user_context.get("socials") or {}).get("scholar") or (profile.get("social_media") or {}).get("Google Scholar","")

    # ---- ORCID assist (with fundings) ----
    try:
        orcid_hit = orcid_search(full_name, affiliation)
        orcid_id = orcid_hit.get("orcid-id") if orcid_hit else None
        aff_hint = (orcid_hit or {}).get("institution-name") or affiliation
        orcid_person = orcid_record(orcid_id) if orcid_id else {}
        orcid_profile_bits = map_orcid_to_profile(orcid_person)

        # Activities (for funding summaries) + hydrate amounts via detail
        orcid_acts = orcid_activities(orcid_id) if orcid_id else {}
        fundings = parse_orcid_fundings(orcid_id, orcid_acts)

        # Tags from ORCID keywords
        orcid_keywords = []
        try:
            kws = ((orcid_person.get("keywords") or {}).get("keyword") or [])
            orcid_keywords = [k.get("content","") for k in kws if k.get("content")]
        except Exception:
            pass
    except Exception as e:
        print("ORCID lookup skipped:", e)
        orcid_id, aff_hint, orcid_profile_bits = None, affiliation, {}
        fundings, orcid_keywords = [], []

    # OpenAlex publications (safe)
    pubs_from_openalex = []
    try:
        author = openalex_find_author(full_name, affiliation_hint=aff_hint)
        openalex_id = author.get("id") if author else None
        works = openalex_author_works(openalex_id)
        pubs_from_openalex = map_openalex_works_to_schema(works)
    except Exception as e:
        print("OpenAlex enrichment skipped:", e)

    # Crossref enrich when DOI present
    try:
        for p in pubs_from_openalex:
            if p.get("doi"):
                msg = crossref_work(p["doi"])
                extra = map_crossref_to_pub_fields(msg)
                for k, v in extra.items():
                    if not p.get(k):
                        p[k] = v
    except Exception as e:
        print("Crossref enrichment skipped:", e)

    # Patents (PatentsView + Google Patents)
    patents_from_api = []
    try:
        patent_items = patentsview_inventor_patents(full_name)
        patents_from_api = map_patents_to_schema(patent_items)
    except Exception as e:
        print("PatentsView enrichment skipped:", e)

    try:
        gp_items = google_patents_search(full_name)
        gp_patents = map_google_patents_to_schema(gp_items)
        patents_from_api.extend(gp_patents)
    except Exception as e:
        print("Google Patents enrichment skipped:", e)

    patents_from_api = dedupe_patents(patents_from_api)

    # ---- MERGE ----
    merged_pubs = merge_publications(pubs, pubs_from_openalex)
    affs_from_orcid = orcid_profile_bits.get("affiliations") if isinstance(orcid_profile_bits, dict) else None
    existing_affs = profile.get("affiliations", [])
    if isinstance(existing_affs, list) and affs_from_orcid:
        merged_affs = [*existing_affs]
        for a in affs_from_orcid:
            if a and a not in merged_affs:
                merged_affs.append(a)
    else:
        merged_affs = existing_affs or affs_from_orcid or []

    merged_profile = {
        **profile,
        "name": prefer_filled_value(profile.get("name"), full_name),
        "affiliations": merged_affs,
        "patents": patents_from_api if patents_from_api else patents,
    }

    out = {**parsed_data}
    out["profile"] = merged_profile
    out.setdefault("publications", {})
    out["publications"]["name"] = merged_profile.get("name","")
    out["publications"]["publications"] = merged_pubs

    # Grants from ORCID fundings (best-effort mapping)
    current_grants = (parsed_data.get("grants") or {})
    mapped_grants = map_orcid_fundings_to_grants(
        merged_profile.get("name",""),
        current_grants,
        fundings,
        orcid_keywords
    )
    out["grants"] = mapped_grants

    return out