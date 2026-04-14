# Parakeet STT Service
# Runs NVIDIA Parakeet TDT 0.6B via onnx-asr + FastAPI.
# CPU-only — no CUDA/PyTorch needed.
#
# First startup downloads the ~600MB ONNX model from HuggingFace.
# Mount /models as a volume to persist across container restarts.

FROM python:3.11-slim

WORKDIR /app

# libsndfile for OGG/Opus decoding (Bookworm 1.2.x supports Opus natively).
# ffmpeg as fallback for edge-case audio formats.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Model cache directory — mount a volume here in production
RUN mkdir -p /models

EXPOSE 8000

# Entrypoint validates model files are complete (cleans up partial downloads
# from interrupted containers), then starts uvicorn.
CMD ["./entrypoint.sh"]
