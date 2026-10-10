#!/bin/sh
# Builds whisper.cpp's whisper-server (static, Metal embedded) into
# build/bin/, where the app looks for it (and electron-builder packs it).
# Needs git and cmake (`brew install cmake`).
set -eu
cd "$(dirname "$0")/.."

REF="${WHISPER_REF:-v1.7.6}"
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT

git clone --depth 1 --branch "$REF" https://github.com/ggml-org/whisper.cpp "$SRC"
cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF
cmake --build "$SRC/build" --target whisper-server -j

mkdir -p build/bin
cp "$SRC/build/bin/whisper-server" build/bin/whisper-server
echo "Built build/bin/whisper-server ($REF)"
