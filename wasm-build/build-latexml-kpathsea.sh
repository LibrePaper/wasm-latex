#!/usr/bin/env bash
set -euo pipefail

# Build the same in-process libkpathsea used by the native latexml binary, but
# through Emscripten. The resulting archive is passed to kpathsea_sys with
# KPATHSEA_LIB_DIR/KPATHSEA_STATIC. The browser resolver wrapper then supplies
# files that are not present in the local MEMFS tree.

source_dir="${KPATHSEA_SRC_DIR:-/build/texlive-source}"
ref="${KPSE_REF:-def12ffd4d6e46bae03b3e5c7ff6f5f14dced3ab}"

if [[ ! -f "${source_dir}/texk/kpathsea/tex-file.c" ]]; then
  if [[ -e "$source_dir" && -n "$(ls -A "$source_dir")" ]]; then
    echo "Refusing to replace a nonempty kpathsea source directory: ${source_dir}" >&2
    exit 1
  fi
  mkdir -p "$source_dir"
  git init -q "$source_dir" >&2
  git -C "$source_dir" remote add origin https://github.com/TeX-Live/texlive-source.git >&2
  git -C "$source_dir" sparse-checkout init --cone >&2
  git -C "$source_dir" sparse-checkout set texk/kpathsea build-aux m4 >&2
  git -C "$source_dir" fetch --depth 1 --filter=blob:none origin "$ref" >&2
  git -C "$source_dir" checkout -q FETCH_HEAD >&2
fi

if [[ ! -d "${source_dir}/.git" ]]; then
  echo "kpathsea source is not a Git checkout: ${source_dir}" >&2
  exit 1
fi
source_head="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$source_head" != "$ref" ]]; then
  echo "kpathsea source HEAD ${source_head} does not match pinned ${ref}" >&2
  exit 1
fi
if ! git -C "$source_dir" diff --quiet; then
  echo "kpathsea source has tracked modifications: ${source_dir}" >&2
  exit 1
fi

cd "${source_dir}/texk/kpathsea"
if [[ ! -f Makefile ]]; then
  emconfigure ./configure \
    --host=wasm32-unknown-emscripten \
    --enable-static --disable-shared --disable-dependency-tracking \
    --without-x >&2
fi
emmake make -j"${JOBS:-4}" libkpathsea.la >&2
test -s .libs/libkpathsea.a
printf '%s\n' "$(pwd)/.libs"
