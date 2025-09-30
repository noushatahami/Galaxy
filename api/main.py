from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
import os, io, json, tempfile

# your modules
from utils import extract_cv_data, fill_template, base64_images  # <- images dict is ready to use
from enrich import enrich

load_dotenv()
app = FastAPI(title="Galaxy API")

# allow the Saul dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health():
    return {"ok": True}

@app.get("/api/images")
def images():
    """Return your base64 images dictionary for the UI to use when needed."""
    return base64_images  # comes from utils.py
    # keys: "logo","search","dashboard",...; values: base64 strings

@app.post("/api/ingest/cv")
async def ingest_cv(file: UploadFile = File(...)):
    """Upload a CV PDF -> parse to your normalized JSON using GPT + schema."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a PDF.")
    pdf_bytes = await file.read()
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name
    try:
        parsed = extract_cv_data(tmp_path)  # returns your top-level JSON
        return parsed
    except Exception as e:
        raise HTTPException(500, f"CV parse failed: {e}")
    finally:
        try: os.remove(tmp_path)
        except: pass

@app.post("/api/template/fill")
async def template_fill(payload: dict):
    """
    Fill a JSON template with parsed data.
    Body: { "template_path": "path-or-relative", "data": {...} }
    """
    template_path = payload.get("template_path")
    data = payload.get("data") or {}
    if not template_path:
        raise HTTPException(400, "template_path required")
    try:
        result = fill_template(template_path, data)
        return result
    except Exception as e:
        raise HTTPException(500, f"Template fill failed: {e}")

@app.post("/api/enrich")
async def do_enrich(payload: dict):
    """
    Enrich previously parsed data with ORCID/OpenAlex/etc.
    Body: { "parsed": {...}, "user_context": {...} }
    """
    parsed = payload.get("parsed") or {}
    user_ctx = payload.get("user_context") or {}
    try:
        out = enrich(parsed, user_ctx)
        return out
    except Exception as e:
        raise HTTPException(500, f"Enrichment failed: {e}")
