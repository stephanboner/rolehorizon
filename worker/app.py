"""iCloud Drive document bridge for an n8n application workflow.

AI reasoning and Google-Sheets tracking happen in n8n; this service reads the profile and saves files.
The worker is intended to be reachable on the private Docker network only.
"""
from __future__ import annotations

import html
import io
import os
import re
import secrets
import subprocess
import tempfile
import threading
from pathlib import Path
from job_source import MAX_JOB_CHARS, capture_path, fetch_original
from typing import Any
from urllib.parse import urlparse

from docx import Document
from docx.shared import Cm, Pt, RGBColor
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable
from pypdf import PdfReader

APP = FastAPI(title="Bewerbungen iCloud Bridge", docs_url=None, redoc_url=None)
ROOT = os.getenv("ICLOUD_BEWERBUNGEN_ROOT", "Bewerbungen").strip("/ ") or "Bewerbungen"
REMOTE = os.getenv("ICLOUD_REMOTE", "icloud").strip().rstrip(":") or "icloud"
TOKEN = os.getenv("WORKER_TOKEN", "")
LOCK = threading.Lock()
MAX_PROFILE_CHARS = 55000


class CoverLetter(BaseModel):
    subject: str = Field(min_length=4, max_length=250)
    salutation: str = Field(min_length=3, max_length=150)
    paragraphs: list[str] = Field(min_length=2, max_length=7)
    closing: str = Field(min_length=2, max_length=150)
    signature: str = Field(min_length=2, max_length=150)


class Analysis(BaseModel):
    company: str = Field(min_length=1)
    position: str = Field(min_length=1)
    language: str = Field(min_length=2, max_length=12)
    cv_focus: list[str] = Field(default_factory=list)
    cv_bullets: list[str] = Field(default_factory=list)
    ats_keywords: list[str] = Field(default_factory=list)
    gaps_to_check: list[str] = Field(default_factory=list)
    cover_letter: CoverLetter


class SaveRequest(BaseModel):
    company: str = Field(min_length=1, max_length=200)
    position: str = Field(min_length=1, max_length=250)
    job_text: str = Field(min_length=20, max_length=MAX_JOB_CHARS)
    job_url: str = Field(default="", max_length=2000)
    job_capture_id: str = Field(default="", max_length=80)
    job_language: str = Field(default="", max_length=12)
    analysis: Analysis

    @field_validator("job_url")
    @classmethod
    def valid_url(cls, url: str) -> str:
        if not url.strip():
            return ""
        u = urlparse(url.strip())
        if u.scheme not in ("https", "http") or not u.netloc:
            raise ValueError("Stellenlink muss eine gueltige http(s)-URL sein")
        return url.strip()


def require_token(x_worker_token: str | None = Header(None)) -> None:
    if not TOKEN or not x_worker_token or not secrets.compare_digest(TOKEN, x_worker_token):
        raise HTTPException(status_code=401, detail="Ungueltiger Worker-Token")


def remote_path(*parts: str) -> str:
    clean = [x.strip("/") for x in parts if x and x.strip("/")]
    return f"{REMOTE}:{'/'.join(clean)}"


def run_rclone(*args: str, timeout: int = 160) -> str:
    try:
        cp = subprocess.run(["rclone", *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as exc:
        raise RuntimeError("rclone ist im Worker nicht installiert") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("iCloud-Zugriff durch rclone ist abgelaufen") from exc
    if cp.returncode:
        # Don't echo auth/config details from stderr into a web response.
        raise RuntimeError(f"rclone '{args[0]}' fehlgeschlagen (Exit {cp.returncode}); iCloud-Anmeldung und Verbindung pruefen")
    return cp.stdout


def list_remote_folder(folder: str, dirs_only: bool = True) -> list[str]:
    option = "--dirs-only" if dirs_only else "--files-only"
    raw = run_rclone("lsf", folder, option, "--format", "p")
    return [line.rstrip("/") for line in raw.splitlines() if line.strip()]


def find_existing_directory(parent: str, desired: str) -> str | None:
    return next((x for x in list_remote_folder(parent) if x.casefold() == desired.casefold()), None)


def slug_component(name: str) -> str:
    s = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", name)
    s = re.sub(r"\s+", " ", s).strip(" .")
    if s in ("", ".", ".."):
        raise ValueError("Firma oder Stellenname konnte nicht ermittelt werden")
    return s[:110].rstrip(" .")


def next_versioned_filename(preferred: str, existing: set[str]) -> str:
    """Never overwrite user-edited drafts; create a numbered new version."""
    if preferred not in existing:
        return preferred
    stem, ext = Path(preferred).stem, Path(preferred).suffix
    for num in range(2, 1000):
        candidate = f"{stem}_v{num}{ext}"
        if candidate not in existing:
            return candidate
    raise ValueError("Zu viele Dokumentversionen im Bewerbungsordner")


def remote_file_bytes(path: str) -> bytes:
    with tempfile.TemporaryDirectory(prefix="application-profile-") as folder:
        local = Path(folder) / "source"
        run_rclone("copyto", path, str(local))
        return local.read_bytes()


def decode_profile_content(path: str, data: bytes) -> str:
    if path.endswith(".txt"):
        return data.decode("utf-8-sig", errors="replace")
    if path.endswith(".docx"):
        doc = Document(io.BytesIO(data))
        chunks = [p.text for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            chunks += [" | ".join(cell.text for cell in row.cells) for row in table.rows]
        return "\n".join(chunks)
    if path.endswith(".pdf"):
        reader = PdfReader(io.BytesIO(data))
        extracted = "\n".join(page.extract_text() or "" for page in reader.pages)
        if not extracted.strip():
            raise ValueError("Master-CV PDF ist nicht textdurchsuchbar; bitte DOCX oder TXT nutzen")
        return extracted
    raise ValueError("Profilformat nicht unterstuetzt")


@APP.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "configured": bool(TOKEN), "remote": REMOTE}


@APP.get("/profile", dependencies=[Depends(require_token)])
def get_profile() -> dict[str, Any]:
    p = remote_path(ROOT, "_Profil")
    try:
        files = list_remote_folder(p, dirs_only=False)
        files_set = {f.casefold(): f for f in files}
        primary = next((files_set[name] for name in ["master_cv.docx", "master_cv.pdf", "master_cv.txt"] if name in files_set), None)
        extra = files_set.get("profil.txt")
        style = files_set.get("schreibstil.txt")
        if not primary and not extra:
            raise HTTPException(status_code=422, detail="Bitte zuerst Bewerbungen/_Profil/master_cv.docx (oder PDF/TXT) oder profil.txt auf iCloud Drive ablegen")
        pieces: list[str] = []
        sources: list[str] = []
        for f in [primary, extra]:
            if f:
                decoded = decode_profile_content(f.lower(), remote_file_bytes(remote_path(ROOT, "_Profil", f)))
                pieces.append(f"--- {f} ---\n{decoded}")
                sources.append(f)
        profile = "\n\n".join(pieces).strip()[:MAX_PROFILE_CHARS]
        if len(profile) < 80:
            raise HTTPException(status_code=422, detail="Master-CV enthaelt zu wenig maschinenlesbaren Text")
        style_text = ""
        if style:
            style_text = remote_file_bytes(remote_path(ROOT, "_Profil", style)).decode("utf-8-sig", errors="replace")[:10000]
        return {"profile_text": profile, "style_text": style_text, "source_files": sources}
    except HTTPException:
        raise
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


class SourceRequest(BaseModel):
    job_url: str = Field(default="", max_length=2000)
    # Only used when NO URL was supplied, e.g. complete manual form input.
    job_text: str = Field(default="", max_length=MAX_JOB_CHARS)


@APP.post("/job-source", dependencies=[Depends(require_token)])
def job_source(req: SourceRequest) -> dict[str, Any]:
    try:
        return fetch_original(req.job_url, req.job_text)
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def register_fonts() -> tuple[str, str]:
    regular_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    bold_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if not Path(regular_path).is_file():
        return "Helvetica", "Helvetica-Bold"
    if "ApplicationSans" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("ApplicationSans", regular_path))
        pdfmetrics.registerFont(TTFont("ApplicationSansBold", bold_path))
        pdfmetrics.registerFontFamily("ApplicationSans", normal="ApplicationSans", bold="ApplicationSansBold")
    return "ApplicationSans", "ApplicationSansBold"


def create_job_pdf(file_path: Path, req: SaveRequest) -> None:
    regular, bold = register_fonts()
    title_style = ParagraphStyle("T", fontName=bold, fontSize=16, leading=22, textColor=colors.HexColor("#172A46"), spaceAfter=11)
    subtitle_style = ParagraphStyle("S", fontName=regular, fontSize=9, leading=13, textColor=colors.HexColor("#58677B"), spaceAfter=9)
    text_style = ParagraphStyle("P", fontName=regular, fontSize=9.2, leading=14.7, alignment=TA_LEFT, spaceAfter=6)
    doc = SimpleDocTemplate(str(file_path), pagesize=A4, rightMargin=23*mm, leftMargin=23*mm, topMargin=23*mm, bottomMargin=23*mm)
    story = [Paragraph(html.escape(req.position), title_style), Paragraph(html.escape(req.company), subtitle_style)]
    if req.job_url:
        url = html.escape(req.job_url, quote=True)
        story.append(Paragraph(f'Stellenlink: <link href="{url}" color="#2463A6">Originalanzeige oeffnen</link>', subtitle_style))
    story.extend([Paragraph("Volltext-Archiv der Originalanzeige (kein Webseiten-Ausdruck)", subtitle_style), HRFlowable(width="100%", thickness=0.4, color=colors.HexColor("#CAD4DF")), Spacer(1, 12)])
    for raw in req.job_text.splitlines():
        if not raw.strip():
            story.append(Spacer(1, 6))
        else:
            story.append(Paragraph(html.escape(raw.strip()), text_style))

    def page_footer(canvas: Any, pdf_doc: Any) -> None:
        canvas.setFont(regular, 8)
        canvas.setFillColor(colors.HexColor("#8792A2"))
        canvas.drawRightString(A4[0] - 23*mm, 14*mm, str(pdf_doc.page))

    doc.build(story, onFirstPage=page_footer, onLaterPages=page_footer)


def bullet_lines(label: str, lines: list[str]) -> str:
    if not lines:
        return label + "\n- Keine spezifischen Hinweise.\n"
    return label + "\n" + "\n".join("- " + x.strip() for x in lines if x.strip()) + "\n"


def create_cv_advice(path: Path, req: SaveRequest) -> None:
    a = req.analysis
    content = [
        f"CV-FOKUS FUER: {req.position} | {req.company}",
        "=" * 74,
        "",
        "VOR DEM VERSAND PRUEFEN: Nur belegbare Angaben in den Lebenslauf uebernehmen.",
        "Erfahrungen, Zahlen, Technologien und Verantwortungen nicht erfinden.",
        "",
        bullet_lines("1. WELCHE ERFAHRUNGEN PRIORISIEREN?", a.cv_focus),
        bullet_lines("2. KONKRETE FORMULIERUNGSVORSCHLAEGE FUER DEN CV", a.cv_bullets),
        bullet_lines("3. RELEVANTE SUCHBEGRIFFE (NUR WENN ZUTREFFEND)", a.ats_keywords),
        bullet_lines("4. OFFENE PUNKTE / LUECKEN, DIE ZU PRUEFEN SIND", a.gaps_to_check),
        f"Originalstelle: {req.job_url or '(kein Link angegeben)'}",
    ]
    path.write_text("\n".join(content), encoding="utf-8")


def create_cover_letter(path: Path, req: SaveRequest) -> None:
    letter = req.analysis.cover_letter
    doc = Document()
    sec = doc.sections[0]
    sec.page_height, sec.page_width = Cm(29.7), Cm(21)
    sec.top_margin, sec.bottom_margin = Cm(2.6), Cm(2.3)
    sec.left_margin, sec.right_margin = Cm(2.7), Cm(2.7)
    st = doc.styles["Normal"]
    st.font.name = "Aptos"
    st.font.size = Pt(10.5)
    st.font.color.rgb = RGBColor(31, 43, 57)
    st.paragraph_format.line_spacing = 1.16
    st.paragraph_format.space_after = Pt(11)
    subject = doc.add_paragraph()
    subject.paragraph_format.space_after = Pt(19)
    subject.paragraph_format.keep_with_next = True
    run = subject.add_run(letter.subject.strip())
    run.bold = True
    run.font.size = Pt(12)
    run.font.color.rgb = RGBColor(18, 43, 73)
    doc.add_paragraph(letter.salutation.strip())
    for text in letter.paragraphs:
        if not text.strip():
            continue
        doc.add_paragraph(text.strip())
    doc.add_paragraph(letter.closing.strip())
    sign = doc.add_paragraph(letter.signature.strip())
    sign.paragraph_format.space_before = Pt(6)
    doc.save(path)


@APP.post("/save", dependencies=[Depends(require_token)])
def save(req: SaveRequest) -> dict[str, Any]:
    """Batch-upload only the application documents to iCloud Drive.

    Tracking is performed by n8n in the existing Google Sheets Stellen-Tracker.
    A prior original-PDF and hand-edited documents are never overwritten.
    """
    try:
        company = slug_component(req.company)
        position = slug_component(req.position)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    with LOCK:
        try:
            root = remote_path(ROOT)
            # Only company folder names are required; no Excel tracker is loaded.
            entries = run_rclone("lsf", root, "--dirs-only", "--format", "p").splitlines()
            root_dirs = [line.rstrip("/") for line in entries if line.endswith("/")]
            company = next((c for c in root_dirs if c.casefold() == company.casefold()), company)
            company_path = remote_path(ROOT, company)
            if company in root_dirs:
                jobs = list_remote_folder(company_path, dirs_only=True)
            else:
                jobs = []
            position = next((c for c in jobs if c.casefold() == position.casefold()), position)
            job_folder = remote_path(ROOT, company, position)
            if position in jobs:
                present = set(list_remote_folder(job_folder, dirs_only=False))
            else:
                present = set()

            with tempfile.TemporaryDirectory(prefix="application-save-") as temp:
                t = Path(temp)
                upload_dir = t / "upload_job"
                upload_dir.mkdir()
                files: list[tuple[str, Path]] = []
                capture = capture_path(req.job_capture_id)
                # Never label a generated text PDF as a literal webpage print.
                pdf_name = "01_Originalinserat_Webseite.pdf" if capture else "01_Originalinserat_Volltext.pdf"
                if pdf_name not in present:
                    pdf = upload_dir / pdf_name
                    if capture:
                        import shutil
                        shutil.copyfile(capture, pdf)
                    else:
                        create_job_pdf(pdf, req)
                    files.append((pdf_name, pdf))
                for name, factory in (
                    ("02_CV_Anpassungen.txt", create_cv_advice),
                    ("03_Motivationsschreiben_Entwurf.docx", create_cover_letter),
                ):
                    actual_name = next_versioned_filename(name, present)
                    target = upload_dir / actual_name
                    factory(target, req)
                    files.append((actual_name, target))

                if files:
                    # One transfer for all new docs; preserves user changes on reruns.
                    run_rclone("copy", str(upload_dir), job_folder, "--ignore-existing", "--transfers", "3", timeout=240)

            return {
                "success": True,
                "company": company,
                "position": position,
                "folder_path": f"{ROOT}/{company}/{position}",
                "files_created": [name for name, _ in files],
                "files_preserved": sorted(present),
                "pdf_method": "webpage_print" if capture else "full_text_archive",
                # Keep existing Form-Completion node compatible.
                "status": "Bewerbung vorbereitet",
            }
        except (RuntimeError, ValueError, OSError, KeyError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc