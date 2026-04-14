"""
Parakeet STT Service — Speech-to-text via NVIDIA Parakeet TDT.

Accepts audio file uploads (OGG/Opus, WAV, FLAC, etc.) and returns
transcribed text using the onnx-asr library (CPU inference, no PyTorch).

Model is loaded once at startup and cached in /models.
"""

import io
import logging
import os
import subprocess
from contextlib import asynccontextmanager

import onnx_asr
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile

logger = logging.getLogger("stt")
logging.basicConfig(level=logging.INFO)

# Model selection via env var (default: English-only v2)
MODEL_NAME = os.environ.get("STT_MODEL", "nemo-parakeet-tdt-0.6b-v3")
MODEL_DIR = os.environ.get("STT_MODEL_DIR", "/models/parakeet")

model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    logger.info("Loading STT model: %s → %s", MODEL_NAME, MODEL_DIR)
    model = onnx_asr.load_model(MODEL_NAME, MODEL_DIR)
    logger.info("Model loaded successfully")
    yield


app = FastAPI(title="Parakeet STT", lifespan=lifespan)


def decode_audio(audio_bytes: bytes) -> tuple:
    """
    Decode audio bytes into a numpy waveform + sample rate.
    Tries soundfile first (supports OGG/Opus on Bookworm), falls back to ffmpeg.
    """
    try:
        waveform, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32")
        return waveform, sample_rate
    except Exception:
        pass

    # Fallback: convert via ffmpeg to 16kHz mono WAV
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-i",
                "pipe:0",
                "-f",
                "wav",
                "-ar",
                "16000",
                "-ac",
                "1",
                "pipe:1",
            ],
            input=audio_bytes,
            capture_output=True,
            check=True,
        )
        waveform, sample_rate = sf.read(io.BytesIO(result.stdout), dtype="float32")
        return waveform, sample_rate
    except Exception as e:
        raise ValueError(f"Cannot decode audio: {e}")


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=422, detail="Empty audio file")

    try:
        waveform, sample_rate = decode_audio(audio_bytes)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Downmix stereo → mono
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=1)

    text = model.recognize(waveform, sample_rate=sample_rate)
    logger.info("Transcribed %d bytes → %d chars", len(audio_bytes), len(text or ""))
    return {"text": text or ""}


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "loaded": model is not None}
