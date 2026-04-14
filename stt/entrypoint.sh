#!/bin/bash
set -e

# Ensure the ONNX model files are fully downloaded before starting uvicorn.
#
# onnx_asr uses huggingface_hub for downloads, but if the download is
# interrupted (e.g. docker compose down), a partial directory remains.
# On next start, onnx_asr sees the directory exists and skips the download,
# then fails because the large ONNX files are missing.
#
# This entrypoint validates the download is complete and cleans up if not.

MODEL=${STT_MODEL:-nemo-parakeet-tdt-0.6b-v3}
MODEL_DIR=${STT_MODEL_DIR:-/models/parakeet}

# Check if all required ONNX model files are present
model_complete() {
	[ -f "$MODEL_DIR/config.json" ] &&
		[ -f "$MODEL_DIR/vocab.txt" ] &&
		[ -f "$MODEL_DIR/encoder-model.onnx" ] &&
		[ -f "$MODEL_DIR/decoder_joint-model.onnx" ] &&
		[ -f "$MODEL_DIR/encoder-model.onnx.data" ]
}

if model_complete; then
	echo "Model already cached: $MODEL → $MODEL_DIR"
else
	echo "Model incomplete or missing — cleaning up and re-downloading..."
	rm -rf "$MODEL_DIR"
fi

exec uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
