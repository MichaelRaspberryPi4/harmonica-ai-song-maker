"""
Companion backend for the Harmonica AI Song Maker.

The front end is a static site and does almost everything itself -- decoding, transcription,
arranging and playback all run in the browser. Two jobs cannot be done there, and they are
the only reason this service exists:

  1. Fetching audio from a YouTube link. Browsers cannot do this: it is cross-origin and
     needs a real extractor.
  2. Isolating the vocal from a full mix, which makes melody transcription dramatically
     better but needs more compute than a browser tab should be asked for.

Designed to run on a free Hugging Face Space (Docker SDK). Both endpoints are optional --
if this service is down, the front end still works for uploaded audio files.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, field_validator

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("harmonica-backend")

# Set ALLOWED_ORIGINS to your GitHub Pages origin in the Space's settings.
# The "*" default keeps first-run friction low; tighten it once you know your URL.
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

MAX_DURATION_SECONDS = int(os.environ.get("MAX_DURATION_SECONDS", "600"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(40 * 1024 * 1024)))

WORK_DIR = Path(tempfile.gettempdir()) / "harmonica"
WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Harmonica AI Song Maker backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


class ExtractRequest(BaseModel):
    url: str

    @field_validator("url")
    @classmethod
    def must_be_http(cls, value: str) -> str:
        if not value.startswith(("http://", "https://")):
            raise ValueError("url must be http or https")
        return value


@app.get("/health")
def health() -> dict[str, object]:
    """Lets the front end decide whether to offer link-based input at all."""
    return {
        "ok": True,
        "ytdlp": shutil.which("yt-dlp") is not None,
        "demucs": _demucs_available(),
        "max_duration_seconds": MAX_DURATION_SECONDS,
    }


def _demucs_available() -> bool:
    try:
        import demucs  # noqa: F401
        return True
    except ImportError:
        return False


def _cleanup(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


@app.post("/extract")
def extract(request: ExtractRequest) -> FileResponse:
    """
    Downloads the audio track of a link and returns it as an m4a.

    Note: downloading from YouTube is against YouTube's Terms of Service. This endpoint
    exists because it was explicitly asked for; uploading a file you already have is the
    supported path and does not depend on this service at all.
    """
    if shutil.which("yt-dlp") is None:
        raise HTTPException(status_code=503, detail="yt-dlp is not installed on this server")

    job = WORK_DIR / uuid.uuid4().hex
    job.mkdir(parents=True, exist_ok=True)

    command = [
        "yt-dlp",
        "--no-playlist",
        "--extract-audio",
        "--audio-format", "m4a",
        "--audio-quality", "5",
        # Refuse anything longer than the cap before downloading a byte of it.
        "--match-filter", f"duration < {MAX_DURATION_SECONDS}",
        "--output", str(job / "audio.%(ext)s"),
        request.url,
    ]

    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        _cleanup(job)
        raise HTTPException(status_code=504, detail="Extraction timed out")

    if result.returncode != 0:
        _cleanup(job)
        log.warning("yt-dlp failed: %s", result.stderr[-2000:])
        raise HTTPException(status_code=502, detail=f"Could not extract audio: {result.stderr[-300:]}")

    files = sorted(job.glob("audio.*"))
    if not files:
        _cleanup(job)
        raise HTTPException(
            status_code=422,
            detail=f"No audio produced. The track may be longer than {MAX_DURATION_SECONDS}s.",
        )

    return FileResponse(files[0], media_type="audio/mp4", filename="audio.m4a")


@app.post("/separate")
async def separate(file: UploadFile = File(...)) -> FileResponse:
    """
    Isolates the vocal from a mix so the transcriber hears the tune and not the backing.

    This is by far the slowest thing here. On a free CPU Space expect several minutes for
    a normal-length song, which is why the front end treats it as opt-in.
    """
    if not _demucs_available():
        raise HTTPException(status_code=503, detail="demucs is not installed on this server")

    job = WORK_DIR / uuid.uuid4().hex
    job.mkdir(parents=True, exist_ok=True)
    source = job / "input.wav"

    size = 0
    with source.open("wb") as handle:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                _cleanup(job)
                raise HTTPException(status_code=413, detail="File too large")
            handle.write(chunk)

    command = [
        "python", "-m", "demucs",
        # Quantised model and a vocals/no-vocals split only: roughly the fastest useful
        # configuration, since the other stems would be discarded anyway.
        "-n", "mdx_extra_q",
        "--two-stems", "vocals",
        "-o", str(job / "out"),
        str(source),
    ]

    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        _cleanup(job)
        raise HTTPException(status_code=504, detail="Separation timed out")

    if result.returncode != 0:
        _cleanup(job)
        log.warning("demucs failed: %s", result.stderr[-2000:])
        raise HTTPException(status_code=500, detail="Separation failed")

    vocals = next((job / "out").rglob("vocals.wav"), None)
    if vocals is None:
        _cleanup(job)
        raise HTTPException(status_code=500, detail="Separation produced no vocal stem")

    return FileResponse(vocals, media_type="audio/wav", filename="vocals.wav")


@app.exception_handler(ValueError)
def value_error_handler(_request: object, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})
