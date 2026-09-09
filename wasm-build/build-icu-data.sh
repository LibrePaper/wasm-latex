#!/usr/bin/env bash
# Produce the ICU common-data file the from-source XeTeX engine fetches at runtime.
#
# Why: emscripten's -sUSE_ICU links libicu_stubdata (ICU with NO converter data), so
# the unpatched upstream XeTeX font manager (ucnv_open("macintosh")) fails. Rather
# than bake ~28MB into the wasm, the engine fetches `icudt68l.dat` from the CDN at
# init (see wasm-build/icu-data-loader.c + xetex-worker.js) and registers it
# via udata_setCommonData.
#
# This is an IMMUTABLE asset, tied to ICU 68.2 (the version emscripten's port uses),
# so it is built once and only rebuilt when the ICU version changes. It is not part
# of an engine build.
#
#   wasm-build/build-icu-data.sh                 # build icudt68l.dat into /tmp/icu-data/
#
# Publishing it is deliberately not this script's job. It previously uploaded to a
# Cloudflare R2 bucket, defaulting to WasmTex's own `corca-texlive-production` —
# infrastructure that is not ours, named as the destination of an `--upload` flag.
# Serving the asset belongs with whatever serves the engines; the worker fetches it
# from ${texlive_endpoint}icudt68l.dat, gzipped, with a long immutable cache header.
set -euo pipefail

ICU_VER="68_2"          # must match emscripten's ICU port (tools/ports/icu.py TAG)
ICU_MAJOR="68"
YEAR="${TEXLIVE_YEAR:-${YEAR:-2025}}"
EMSDK_IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:3.1.46}"
WORK="${WORK_DIR:-/tmp/icu-data}"
if [ "${1:-}" = "--upload" ]; then
  echo "--upload was removed: it published to a bucket that is not ours." >&2
  echo "Build the file here, then publish it alongside the engines." >&2
  exit 2
fi

command -v docker >/dev/null || { echo "docker required"; exit 1; }
mkdir -p "$WORK"
cd "$WORK"

# ICU's src tarball ships only the prebuilt data blob, not the data SOURCE (.ucm/.txt);
# the separate data archive has the source we need to (re)build the .dat.
[ -f "icu4c-${ICU_VER}-src.tgz" ] || \
  wget -q "https://github.com/unicode-org/icu/releases/download/release-${ICU_VER//_/-}/icu4c-${ICU_VER}-src.tgz"
[ -f "icu4c-${ICU_VER}-data.zip" ] || \
  wget -q "https://github.com/unicode-org/icu/releases/download/release-${ICU_VER//_/-}/icu4c-${ICU_VER}-data.zip"

# Build native ICU (clean toolchain in the emsdk image) -> data/out/tmp/icudt${MAJOR}l.dat.
# We ship the FULL data (gz ~11MB on the wire, cached once). Shrinking it is DEFERRED:
#   - ICU's databuilder filter DOES engage with `{"strategy":"additive","featureFilters":
#     {"conversion_mappings":"include","misc":"include","normalization":"include",
#     "ulayout":"include"}}` (keys must be real categories; the old `"*"`/`ubidi`/`uprops`
#     keys were silently ignored). It yields ~3MB gz...
#   - ...BUT that minimal set (and an icupkg locale/coll prune of the full data) both make
#     XeTeX's font manager fail at `ucnv_open(...)` -> "cannot read font names". So
#     ucnv_open has a runtime ICU dependency not captured by the build-time filter; only
#     the full dataset works. Isolating the missing category needs ICU-internal debugging.
docker run --rm --platform linux/amd64 -v "$WORK":/w -w /w "$EMSDK_IMAGE" bash -c "
  set -e
  rm -rf icu && tar xzf icu4c-${ICU_VER}-src.tgz
  cd icu/source && rm -rf data && unzip -q /w/icu4c-${ICU_VER}-data.zip
  rm -f data/in/icudt${ICU_MAJOR}l.dat
  ./configure >/tmp/c.log 2>&1
  make -j\$(nproc) >/tmp/m.log 2>&1
  export LD_LIBRARY_PATH=/w/icu/source/lib
  cp data/out/tmp/icudt${ICU_MAJOR}l.dat /w/icudt${ICU_MAJOR}l.dat
"
DAT="$WORK/icudt${ICU_MAJOR}l.dat"
[ -f "$DAT" ] || { echo "ICU data build produced no .dat"; exit 1; }
echo "Built $DAT ($(wc -c < "$DAT") bytes)"

echo "Publish it next to the engines, gzipped, at the URL the worker fetches."
