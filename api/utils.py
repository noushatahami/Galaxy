import os
import base64
from openai import OpenAI
from dotenv import load_dotenv

def get_base64_image(image_path):
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode()

# Define paths
image_dir = "assets/images"

image_files = {
    "logo": "logo.png",
    "search": "search.png",
    "dashboard": "dashboard.png",
    "insights": "insights.png",
    "reports": "reports.png",
    "settings": "settings.png",
    "more": "more.png",
    "help": "help.png",
    "messages": "messages.png",
    "notifications": "notifications.png",
    "social_media": "social_media.png",
    "media_mentions": "media_mentions.png",
    "partners": "partners.png",
    "profile": "profile.png",
    "money": "money.png",
    "impact_points": "impact_points.png",
    "donut_chart": "donut_chart.png",
    "xls": "xls.png",
    "pdf": "pdf.png",
    "doc": "doc.png",
    "duration": "duration.png",
    "amount": "amount.png",
    "people": "people.png",
    "deadline": "deadline.png",
    "globe": "globe.png",
    "citation": "citation.png",
    "jira": "jira.png",
    "gitHub": "gitHub.png",
    "slack": "slack.png",
    "zoom": "zoom.png"
}

# Load all images as base64 in a dictionary
base64_images = {name: get_base64_image(os.path.join(image_dir, file)) for name, file in image_files.items()}

import pdfplumber
import re

def extract_cv_data(cv_path):
    # Load OpenAI API key from .env
    load_dotenv()
    client = OpenAI(api_key=os.getenv("OPENAI_KEY"))
    model = os.getenv("OPENAI_MODEL")

    if not client.api_key or not model:
        raise ValueError("Missing OpenAI API key or model in .env")
    
    # Extract plain text from PDF
    with pdfplumber.open(cv_path) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    # Load the schema from file
    with open("schema.txt", "r") as f:
        schema = f.read()

    # Construct GPT prompt
    prompt = f"""
You are a CV parser.

Return your result as a JSON object with the following top-level keys:
"compliance", "grants", "profile", "projects", "publications"

Each section must match the structure shown below. If String data is missing, instead of leaving the values empty, write "Pending Input". If Int data is missing leave as 0. but preserve the structure.

{schema}

Now parse the following CV and return ONLY valid raw JSON (no markdown, no backticks):

{text}
"""

    try:
        # Call OpenAI model (gpt-4.1-nano)
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2
        )
        content = response.choices[0].message.content
        return json.loads(content)

    except Exception as e:
        print("❌ Error parsing CV with OpenAI:", e)
        return {}

import copy
import json

def fill_template(template_path, data):
    with open(template_path, "r") as f:
        template = json.load(f)

    def recursive_fill(template_node, data_node):
        if isinstance(template_node, dict):
            return {
                key: recursive_fill(template_node[key], data_node.get(key, template_node[key]))
                for key in template_node
            }
        elif isinstance(template_node, list):
            return data_node if isinstance(data_node, list) else template_node
        else:
            return data_node if data_node is not None else template_node

    return recursive_fill(template, data)
