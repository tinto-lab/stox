#!/bin/sh
# Builds llama.cpp's llama-server (static, Metal embedded) into build/bin/,
# where the app looks for it (and electron-builder packs it). It runs the
# local Gemma model that polishes dictation. Needs git and cmake
# (`brew install cmake`).
set -eu
cd "$(dirname "$0")/.."

REF="${LLAMA_REF:-b11549}"
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT

git clone --depth 1 --branch "$REF" https://github.com/ggml-org/llama.cpp "$SRC"
cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON
cmake --build "$SRC/build" --target llama-server -j

mkdir -p build/bin
cp "$SRC/build/bin/llama-server" build/bin/llama-server
echo "Built build/bin/llama-server ($REF)"
