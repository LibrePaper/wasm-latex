# Corresponding source

A GPL binary may be distributed only together with the complete source it was
built from. For these engines that source is not "TeX Live" and not "this
repository on GitHub" — it is one archive, published where the binaries are,
containing everything needed to rebuild them.

    node tools/build-corresponding-source.mjs --dist wasm-build/dist --out dist-source/

## What goes in

| Path in the archive | What |
|---|---|
| `repo/` | This repository at the commit that built the artifacts: Dockerfile, Makefile, C shims, worker controller, patches, tools, notices. |
| `texlive-source/` | The pinned TeX Live tree, read out of the build image rather than cloned again — so it is the tree that compiled, not one that ought to match. Contains kpathsea, zlib, libpng, xpdf, web2c, synctex and libmd5. |
| `MANIFEST.json` | The artifacts this source corresponds to, with SHA-256; the TeX Live commit; the digest-pinned Emscripten image. |
| `REBUILD.md` | How to rebuild the engines from this archive. |
| `RELINK.md` | How to substitute a modified LGPL library and relink. |

The Emscripten runtime pieces linked into the binaries (musl libc, libc++,
libc++abi, compiler-rt, dlmalloc) come from the digest-pinned `emscripten/emsdk`
image, which the manifest names exactly. Their source is Emscripten's, at that
digest; their notices are in `repo/LICENSES/`.

## Why the tree comes out of the image

The Dockerfile fetches TeX Live at a pinned commit during the image build, so the
image holds the exact tree the compiler saw. Taking it from there removes a step
where the archive could quietly diverge from the binary — a re-clone can differ
if the pin is wrong, if a tag moved, or if the fetch was patched. The manifest
still records the commit, so the archive can be checked against upstream.

## Rebuilding from it

The Dockerfile uses a `texlive-source/` tree found in its build context in
preference to fetching one. So a rebuild from the archive is:

    cp -r texlive-source repo/wasm-build/texlive-source
    docker buildx build --platform linux/amd64 --load \
      --build-arg TEXLIVE_REF=$(cat repo/wasm-build/texlive-source-2026.ref) \
      -t rebuild repo/wasm-build/
    docker run --rm --platform linux/amd64 -v "$PWD/out:/dist" rebuild

That path exists for the LGPL relink obligation, and it is what makes the archive
self-contained rather than a snapshot that still needs the network.

## Receipt

The builder writes `receipts/SOURCE-RECEIPT.json`: the archive's own hash, the
repository commit, whether that tree was dirty, the TeX Live commit, and the
artifacts the archive corresponds to. `tools/check-release.mjs` refuses to pass a
staged release whose binaries are not the ones named there, or whose source was
built from a dirty tree — a source archive that does not correspond to the
binary is worse than none, because it looks like compliance.

## What is not automated yet

Verifying that a clean rebuild *from the archive* reproduces the distributed
bytes. The pinned inputs are known to rebuild byte-identically
(`reproduction-2026-pdftex.md`); closing the loop from the archive itself is
open work.
