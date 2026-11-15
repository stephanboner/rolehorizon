"""Retrieve full, original job adverts and optionally print the source page to PDF.

Job URLs are untrusted input. This module rejects local/private destinations
and browser network requests, and intentionally never uses sheet summaries.
"""
from __future__ import annotations

import ipaddress
import html
import json
import os
import re
import secrets
import socket
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from bs4 import BeautifulSoup
from langdetect import DetectorFactory, detect
from playwright.sync_api import sync_playwright

DetectorFactory.seed = 0
CAPTURE_DIR = Path(os.getenv("JOB_CAPTURE_DIR", "/tmp/application-job-captures"))
CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
MAX_JOB_CHARS = 150_000


def check_public_url(url: str, cache: dict[str, bool] | None = None) -> str:
    """Conservatively reject SSRF destinations, including DNS-resolved private IPs."""
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise ValueError("Stellen-URL muss http(s) mit Hostname sein")
    if parts.username is not None or parts.password is not None:
        raise ValueError("URLs mit Benutzerinformationen sind nicht erlaubt")
    if parts.port not in (None, 80, 443):
        raise ValueError("Nichtstandard-Ports sind nicht erlaubt")
    host = parts.hostname.lower().rstrip(".")
    if (
        host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".docker", ".test"))
        or not re.fullmatch(r"[a-z0-9._:-]+", host)
    ):
        raise ValueError("Nichtoeffentlicher Hostname")
    if cache is not None and cache.get(host):
        return url
    try:
        addresses = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("Stellen-Hostname ist nicht aufloesbar") from exc
    for entry in addresses:
        ip = ipaddress.ip_address(entry[4][0])
        if not ip.is_global:
            raise ValueError("Stellen-URL verweist auf eine nichtoeffentliche Adresse")
    if cache is not None:
        cache[host] = True
    return url


def fetch_ashby_original(url: str) -> tuple[str, str] | None:
    """Public Ashby job-board API provides the employer's unabridged description."""
    parsed = urlsplit(url)
    if parsed.hostname != "jobs.ashbyhq.com":
        return None
    bits = [s for s in parsed.path.split("/") if s]
    if len(bits) < 2 or not re.fullmatch(r"[A-Za-z0-9_-]+", bits[0]):
        return None
    board, posting_id = bits[0], bits[1]
    api_url = f"https://api.ashbyhq.com/posting-api/job-board/{board}"
    check_public_url(api_url)
    try:
        with httpx.Client(timeout=12.0, follow_redirects=False) as client:
            response = client.get(api_url, headers={"Accept": "application/json"})
            response.raise_for_status()
            if len(response.content) > 8_000_000:
                return None
            jobs = response.json().get("jobs", [])
    except (httpx.HTTPError, ValueError, TypeError):
        return None
    for job in jobs:
        job_url = str(job.get("jobUrl") or "")
        segments = [s for s in urlsplit(job_url).path.split("/") if s]
        if len(segments) < 2 or segments[1].casefold() != posting_id.casefold():
            continue
        description = str(job.get("descriptionPlain") or "").strip()
        if len(description) < 300:
            continue
        title = str(job.get("title") or "").strip()
        location = str(job.get("location") or "").strip()
        employment = str(job.get("employmentType") or "").strip()
        preface = [x for x in [title, location, employment] if x]
        return "\n".join(preface) + "\n\n" + description, "ashby_public_job_api"
    return None


def fetch_workable_original(url: str) -> tuple[str, str] | None:
    """Read an employer's complete public Workable advert, not the apply form.

    Workable's own public careers-widget API exposes the job description without
    requiring an employer-specific token. Use only the board slug and shortcode
    from the supplied employer URL and match the exact posting.
    """
    parts = urlsplit(url)
    if parts.hostname != "apply.workable.com":
        return None
    match = re.fullmatch(
        r"/([a-z0-9][a-z0-9_-]*)/j/([a-z0-9]{8,20})(?:/(?:apply)?)?/?",
        parts.path, flags=re.IGNORECASE
    )
    if not match:
        return None
    board, shortcode = match.group(1), match.group(2)
    api_url = f"https://apply.workable.com/api/v1/widget/accounts/{board}?details=true"
    check_public_url(api_url)
    try:
        with httpx.Client(timeout=18.0, follow_redirects=False) as client:
            response = client.get(api_url, headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; RoleHorizon/1.0)",
            })
            response.raise_for_status()
            if len(response.content) > 8_000_000:
                return None
            payload = response.json()
    except (httpx.HTTPError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("jobs"), list):
        return None
    for job in payload["jobs"]:
        if not isinstance(job, dict) or str(job.get("shortcode") or "").casefold() != shortcode.casefold():
            continue

        def text_part(key: str) -> str:
            value = job.get(key)
            if not isinstance(value, str) or not value.strip():
                return ""
            # Public API advert fields contain HTML. Keep paragraph and list
            # boundaries so the original requirements remain legible.
            markup = html.unescape(value)
            return BeautifulSoup(markup, "html.parser").get_text("\n", strip=True)

        description = text_part("full_description")
        if not description:
            components = [
                text_part("description"),
                text_part("requirements"),
                text_part("benefits"),
            ]
            description = "\n\n".join(c for c in components if c)
        if len(description) < 350:
            return None
        location = ", ".join(
            str(job.get(k) or "").strip()
            for k in ("city", "state", "country") if job.get(k)
        )
        preface = [
            str(job.get("title") or "").strip(),
            str(payload.get("name") or "").strip(),
            location,
            str(job.get("employment_type") or "").strip(),
        ]
        return "\n".join(x for x in preface if x) + "\n\n" + description, "workable_public_job_api"
    return None


def _extract_job_jsonld(markup: str) -> str:
    """Prefer the employer's full schema.org JobPosting text over navigation UI."""
    soup = BeautifulSoup(markup, "html.parser")

    def visit(value):
        if isinstance(value, list):
            for child in value:
                found = visit(child)
                if found:
                    return found
        if isinstance(value, dict):
            types = value.get("@type", [])
            if isinstance(types, str):
                types = [types]
            if "JobPosting" in types and value.get("description"):
                description = str(value["description"])
                content = BeautifulSoup(html.unescape(description), "html.parser").get_text("\n", strip=True)
                if len(content) >= 350:
                    title = str(value.get("title") or "").strip()
                    return "\n\n".join([x for x in [title, content] if x])
            for child in value.values():
                found = visit(child)
                if found:
                    return found
        return None

    for tag in soup.select('script[type="application/ld+json"]'):
        try:
            result = visit(json.loads(tag.string or tag.get_text()))
            if result:
                return result
        except (ValueError, TypeError):
            continue
    return ""


def _render_original_page(url: str, pdf_path: Path | None, need_text: bool) -> str:
    hostname_cache: dict[str, bool] = {}
    check_public_url(url, hostname_cache)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--disable-dev-shm-usage", "--no-sandbox"])
        try:
            context = browser.new_context(locale="en-US", viewport={"width": 1280, "height": 900}, service_workers="block")
            try:
                def guard(route):
                    request_url = route.request.url
                    parsed = urlsplit(request_url)
                    if parsed.scheme in ("data", "blob"):
                        route.continue_()
                        return
                    try:
                        check_public_url(request_url, hostname_cache)
                        route.continue_()
                    except (ValueError, OSError):
                        route.abort("blockedbyclient")

                context.route("**/*", guard)
                page = context.new_page()
                response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                if response is not None and response.status >= 400:
                    raise ValueError(f"Original-Stellenanzeige liefert HTTP {response.status}")
                page.wait_for_timeout(1800)
                body_text = ""
                if need_text:
                    body_text = _extract_job_jsonld(page.content())
                    # First matching large content area, keeping all job sections.
                    for selector in ([] if body_text else [
                        '[data-testid="job-description"]',
                        '#job-description',
                        '[class*="job-description"]',
                        'main article',
                        'main',
                        '[role="main"]',
                        'article',
                        'body',
                    ]):
                        node = page.locator(selector).first
                        if node.count() == 0:
                            continue
                        candidate = node.inner_text(timeout=3000).strip()
                        if len(candidate) >= 350:
                            body_text = candidate
                            break
                    if len(body_text) < 350:
                        raise ValueError("Originaltext nicht vollstaendig lesbar (Seite dynamisch oder blockiert)")
                if pdf_path is not None:
                    page.emulate_media(media="screen")
                    page.pdf(path=str(pdf_path), format="A4", print_background=True,
                             margin={"top": "12mm", "bottom": "12mm", "left": "10mm", "right": "10mm"})
                    if pdf_path.stat().st_size < 4000:
                        raise ValueError("Webseiten-PDF ist unerwartet klein")
                return body_text
            finally:
                context.close()
        finally:
            browser.close()


def detect_original_language(text: str) -> str:
    try:
        return detect(text[:12000])
    except Exception:
        return "und"


def _prune_captures() -> None:
    now = time.time()
    for item in CAPTURE_DIR.glob("*.pdf"):
        if now - item.stat().st_mtime > 7200:
            item.unlink(missing_ok=True)


def capture_path(capture_id: str) -> Path | None:
    if not re.fullmatch(r"[a-f0-9]{32}", capture_id or ""):
        return None
    path = CAPTURE_DIR / f"{capture_id}.pdf"
    return path if path.is_file() else None


def fetch_original(job_url: str, pasted_text: str = "") -> dict:
    """Full source text for AI, captured website PDF when possible.

    If URL provided, never substitute the condensed Sheet description.
    Only a manually pasted complete advert can be used without a URL.
    """
    _prune_captures()
    url = (job_url or "").strip()
    if not url:
        text = (pasted_text or "").strip()
        if len(text) < 150:
            raise ValueError("Bitte eine Stellen-URL oder die vollstaendige Originalanzeige einfuegen")
        return {"job_text": text[:MAX_JOB_CHARS], "language": detect_original_language(text),
                "job_url": "", "capture_id": "", "source_method": "manual_full_text", "pdf_method": "full_text_archive"}
    check_public_url(url)
    # Workable job pages may show only an application form (no advert).
    # Fetch the complete public widget posting by exact shortcode instead.
    if re.fullmatch(
        r"/[a-z0-9][a-z0-9_-]*/j/[a-z0-9]{8,20}(?:/(?:apply)?)?/?",
        urlsplit(url).path, flags=re.IGNORECASE
    ) and urlsplit(url).hostname == "apply.workable.com":
        result = fetch_workable_original(url)
        if not result:
            raise ValueError(
                "Workable-Originalinserat derzeit nicht ueber die oeffentliche Jobs-API abrufbar"
            )
        text, method = result
        if len(text) > MAX_JOB_CHARS:
            raise ValueError("Originalanzeige uebertrifft das Sicherheitslimit")
        # Do not print a Workable apply form as an original job-description PDF.
        return {"job_text": text, "language": detect_original_language(text),
                "job_url": url, "capture_id": "", "source_method": method,
                "pdf_method": "full_text_archive"}
    text = ""
    method = ""
    try:
        result = fetch_ashby_original(url)
        if result:
            text, method = result
    except (ValueError, OSError):
        pass
    capture_id = secrets.token_hex(16)
    pdf_file = CAPTURE_DIR / f"{capture_id}.pdf"
    pdf_method = "webpage_print"
    try:
        rendered_text = _render_original_page(url, pdf_file, need_text=not text)
        if not text:
            text, method = rendered_text, "webpage_rendered_text"
    except Exception as exc:
        pdf_file.unlink(missing_ok=True)
        capture_id = ""
        pdf_method = "full_text_archive"
        if not text:
            raise ValueError("Originalanzeige konnte nicht vollstaendig abgerufen werden: " + str(exc)[:240]) from exc
    if len(text) < 350:
        raise ValueError("Originalanzeige zu kurz; verwende keine Sheet-Zusammenfassung als Ersatz")
    if len(text) > MAX_JOB_CHARS:
        raise ValueError("Originalanzeige uebertrifft das Sicherheitslimit")
    return {"job_text": text, "language": detect_original_language(text),
            "job_url": url, "capture_id": capture_id, "source_method": method,
            "pdf_method": pdf_method}