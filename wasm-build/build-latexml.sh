#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF_FILE="${ROOT}/wasm-build/latexml-source.ref"
BUILD="${LATEXML_BUILD_DIR:-/build/latexml}"
SOURCE="${LATEXML_SOURCE_DIR:-${BUILD}/source}"
DIST="${LATEXML_DIST_DIR:-${ROOT}/wasm-build/dist}"

# Docker cache volumes can be owned by the host user while this build runs as
# root.  This checkout is created and validated by this script, so register it
# explicitly with Git before using -C operations.
git -C /tmp config --global --add safe.directory "$SOURCE"

repo="$(sed -n 's/^repository=//p' "$REF_FILE")"
commit="$(sed -n 's/^commit=//p' "$REF_FILE")"
test -n "$repo" && test -n "$commit"

if [[ ! -d "${SOURCE}/.git" ]]; then
  # Git accepts an empty mounted directory and refuses to overwrite unrelated
  # contents when a caller supplies an existing source path.
  mkdir -p "$(dirname "$SOURCE")"
  git clone --no-checkout "$repo" "$SOURCE"
  git -C "$SOURCE" checkout --detach "$commit"
else
  test "$(git -C "$SOURCE" rev-parse HEAD)" = "$commit"
fi
git -C "$SOURCE" diff --quiet HEAD --

mkdir -p "$DIST"
export CFLAGS="${CFLAGS:--O2}"
export CXXFLAGS="${CXXFLAGS:--O2}"

# Generate the kernel snapshots before the cross build.  latexml_engine's
# build script embeds every versioned dump found under resources/dumps, so the
# resulting WASM carries the exact plain/LaTeX state from this pinned source
# checkout and does not need to invoke kpsewhich in the browser.  The image
# installs only TeX Live base plus LaTeX base, which supplies plain.tex,
# latex.ltx, and expl3-code.tex used by tools/make_formats.sh.
if [[ "${LATEXML_SKIP_DUMPS:-0}" != 1 ]]; then
  (
    cd "$SOURCE"
    # The container entrypoint may set cross-link RUSTFLAGS (including a
    # host-unavailable mold linker).  Dump generation is a native build, so
    # isolate it from those target flags and select the image's host cc.
    env RUSTFLAGS= CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=cc \
      PROFILE=release tools/make_formats.sh
  )
fi

# libxml/libxslt's build scripts use pkg-config to locate their target
# archives. A cross build cannot consume the host libraries, so build those
# archives with emconfigure and create target .pc files in one private prefix.
LIBXML_WORK="${BUILD}/libxml"
PREFIX="${LIBXML_WORK}/prefix"
mkdir -p "$LIBXML_WORK" "$PREFIX"
if [[ ! -s "${PREFIX}/lib/libxml2.a" || ! -s "${PREFIX}/lib/libxslt.a" ]]; then
  cd "$LIBXML_WORK"
  curl -fsSL https://download.gnome.org/sources/libxml2/2.13/libxml2-2.13.5.tar.xz -o libxml2.tar.xz
  curl -fsSL https://download.gnome.org/sources/libxslt/1.1/libxslt-1.1.42.tar.xz -o libxslt.tar.xz
  printf '%s\n' \
    '74fc163217a3964257d3be39af943e08861263c4231f9ef5b496b6f6d4c7b2b6  libxml2.tar.xz' \
    '85ca62cac0d41fc77d3f6033da9df6fd73d20ea2fc18b0a3609ffb4110e1baeb  libxslt.tar.xz' | sha256sum --check
  tar xf libxml2.tar.xz
  tar xf libxslt.tar.xz
  cd libxml2-2.13.5
  emconfigure ./configure --prefix="$PREFIX" --enable-static --disable-shared \
    --without-python --without-zlib --without-lzma --without-icu \
    --disable-dependency-tracking
  emmake make -j"${JOBS:-4}"
  emmake make install
  cd ../libxslt-1.1.42
  PKG_CONFIG_PATH="${PREFIX}/lib/pkgconfig" emconfigure ./configure \
    --prefix="$PREFIX" --enable-static --disable-shared --without-python \
    --without-crypto --with-libxml-prefix="$PREFIX" --disable-dependency-tracking
  emmake make -j"${JOBS:-4}"
  emmake make install
fi

export PKG_CONFIG_PATH_wasm32_unknown_emscripten="${PREFIX}/lib/pkgconfig"
export PKG_CONFIG_LIBDIR_wasm32_unknown_emscripten="${PREFIX}/lib/pkgconfig"
export PKG_CONFIG_ALLOW_CROSS=1
# bindgen invokes host clang directly instead of emcc; tell it where the
# target libc headers live while leaving host-side proc-macro builds alone.
# Clang hides WASM declarations by default, so bindgen otherwise emits types
# without their functions (rust-bindgen issue #1941).
export BINDGEN_EXTRA_CLANG_ARGS_wasm32_unknown_emscripten="${BINDGEN_EXTRA_CLANG_ARGS_wasm32_unknown_emscripten:-} --target=wasm32-unknown-emscripten -fvisibility=default --sysroot=/emsdk/upstream/emscripten/cache/sysroot"
# The target prefix contains only static archives. Leave the global static
# toggles unset so host-side proc macros use the host's shared libxml2.
unset LIBXML2_STATIC LIBXSLT_STATIC

KPSE_DIR="$(KPATHSEA_SRC_DIR="${BUILD}/texlive-source" "${ROOT}/wasm-build/build-latexml-kpathsea.sh")"
export KPATHSEA_LIB_DIR="$KPSE_DIR" KPATHSEA_STATIC=1
export KPATHSEA_SKIP_TOOLCHAIN_CHECK=1

cd "${ROOT}/wasm-build/latexml-wasm"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${BUILD}/cargo-target}"
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-sMODULARIZE=1 -C link-arg=-sEXPORT_NAME=LatexmlModule -C link-arg=-sFORCE_FILESYSTEM=1 -C link-arg=-sALLOW_MEMORY_GROWTH=1 -C link-arg=-sINITIAL_MEMORY=134217728 -C link-arg=-sSTACK_SIZE=8388608 -C link-arg=-sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,UTF8ToString,stringToNewUTF8 -C link-arg=-Wl,--wrap=kpathsea_find_file -C link-arg=--js-library -C link-arg=/src/wasm-build/library-latexml.js"
cargo rustc --release --locked --target wasm32-unknown-emscripten --bin latexml_wasm -- \
  -C link-arg=-sEXPORTED_FUNCTIONS=_main,_alloc,_dealloc,_add_file,_clear_files,_set_main,_compile,_output_ptr,_output_len,_diagnostics_ptr,_diagnostics_len,_status \
  -C "link-arg=-Wl,-Map=$DIST/latexml.map"

cp "$CARGO_TARGET_DIR/wasm32-unknown-emscripten/release/latexml_wasm.js" "$DIST/latexml.js"
cp "$CARGO_TARGET_DIR/wasm32-unknown-emscripten/release/latexml_wasm.wasm" "$DIST/latexml.wasm"
cp "${ROOT}/wasm-build/latexml-worker.js" "$DIST/latexml.worker.js"
cp "${SOURCE}/latexml_post/resources/CSS/LaTeXML.css" "$DIST/latexml.css"
cp "${SOURCE}/latexml_post/resources/CSS/"*.css "$DIST/"
cp "${ROOT}/wasm-build/kpse-resolve.cjs" "$DIST/kpse-resolve.js"
cp "${ROOT}/wasm-build/bundle-mode.js" "$DIST/"
# Keep the generated source inputs beside the build output for the
# corresponding-source archive, including when the build container is removed.
mkdir -p "$DIST/latexml-kernels"
for dump in "$SOURCE"/resources/dumps/*.dump.txt "$SOURCE"/resources/dumps/*.version; do
  if [[ -f "$dump" ]]; then cp "$dump" "$DIST/latexml-kernels/"; fi
done
node "${ROOT}/wasm-build/write-latexml-receipt.mjs" \
  --dist "$DIST" --source "$SOURCE" --ref "$REF_FILE" \
  --libxml-dir "$LIBXML_WORK" --wrapper-lock "$ROOT/wasm-build/latexml-wasm/Cargo.lock"
sha256sum "$DIST/latexml.js" "$DIST/latexml.wasm" "$DIST/latexml.worker.js" "$DIST/latexml.css" > "$DIST/latexml.SHA256SUMS"
ls -lh "$DIST"/latexml.*
