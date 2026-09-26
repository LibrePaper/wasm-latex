#!/usr/bin/env bash
# Retain the exact source/runtime closure used by this build, including the
# pure Perl modules supplied by the container distribution.
set -euo pipefail
mkdir -p /out
cp "$BUILD/biber.js" "$BUILD/biber.wasm" "$BUILD/biber.data" "$BUILD/biber.map" /out/
cp /src/biber-worker.js /out/biber.worker.js
stage=$(mktemp -d)
mkdir -p "$stage/biber/repo/third-party" "$stage/biber/repo/wasm-build" "$stage/biber/repo/tools"
cp -a /src/texlyre-biber "$stage/biber/repo/third-party/texlyre-biber"
cp /src/build-biber.sh /src/export-biber.sh /src/biber-worker.js /src/biber-smoke.cjs /src/Dockerfile.biber "$stage/biber/repo/wasm-build/"
cp /src/biber-build-receipt.mjs "$stage/biber/repo/tools/"
cp -a /usr/share/perl5 "$stage/biber/host-perl5"
mkdir -p "$stage/biber/host-notices"
for copyright in /usr/share/doc/*/copyright; do
  test -f "$copyright" || continue
  package=$(basename "$(dirname "$copyright")")
  mkdir -p "$stage/biber/host-notices/$package"
  cp -L "$copyright" "$stage/biber/host-notices/$package/copyright"
done
cp -a /usr/share/common-licenses "$stage/biber/host-notices/common-licenses"
cp -a "$BUILD/prefix-stage" "$stage/biber/runtime"
mkdir -p "$stage/biber/src" "$stage/biber/emscripten"
tar -C "$BUILD/src" --exclude=.git --exclude='*.o' --exclude='*.a' --exclude='*.wasm' --exclude='biber.data' -cf - . | tar -C "$stage/biber/src" -xf -
tar -C /emsdk/upstream/emscripten --exclude=.git --exclude=cache --exclude=node_modules -cf - . | tar -C "$stage/biber/emscripten" -xf -
cp /src/BIBER-REBUILD.md "$stage/biber/REBUILD.md"
dpkg-query -W > "$stage/biber/build-packages.txt"
git -C "$BUILD/src/emperl" rev-parse HEAD > "$stage/biber/emperl.ref"
emcc --version > "$stage/biber/emcc-version.txt"
cp "$BUILD/biber.map" "$stage/biber/biber.map"

# Notices are distributable alongside the binaries, independently of the source.
rm -rf /out/biber-notices
mkdir -p /out/biber-notices
cp -a "$stage/biber/host-notices" /out/biber-notices/host-packages
cp /src/texlyre-biber/LICENSE /src/texlyre-biber/NOTICE /out/biber-notices/
cp /emsdk/upstream/emscripten/LICENSE /out/biber-notices/Emscripten.txt
for dir in "$BUILD"/src/*; do
  test -d "$dir" || continue
  dest="/out/biber-notices/$(basename "$dir")"
  mkdir -p "$dest"
  find "$dir" -maxdepth 1 -type f \( -iname '*license*' -o -iname '*copying*' -o -iname '*copyright*' -o -name Artistic -o -name README \) -exec cp '{}' "$dest/" \;
done
mkdir -p /out/biber-notices/sombok
cp "$BUILD/src/Unicode-LineBreak/sombok/ARTISTIC" "$BUILD/src/Unicode-LineBreak/sombok/COPYING" "$BUILD/src/Unicode-LineBreak/sombok/UNICODE" /out/biber-notices/sombok/
tar -czf /out/BIBER-SOURCE.tar.gz -C "$stage" biber
node /src/biber-build-receipt.mjs "$BUILD" /out
