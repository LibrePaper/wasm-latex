# Reproduction: pdfTeX and BibTeX, engine release 2026-8b7946970153c52e

Date: 2026-09-08. Machine: 16 cores, Docker 29.7, x86_64.

Built from this repository's `wasm-build/` at the seed commit, which is the
upstream snapshot `0dddc924` the release receipts name, using upstream's own
recipe unchanged:

    docker buildx build --platform linux/amd64 --load \
      --build-arg TEXLIVE_REF=$(cat wasm-build/texlive-source-2026.ref) \
      -t librepaper-pdftex-wasm wasm-build/
    docker run --rm --platform linux/amd64 -v $PWD/wasm-build/dist:/dist librepaper-pdftex-wasm

Timings: image (native TeX Live build) 12m53s; wasm phase 2m33s.

## Result: all compiled files match the pinned receipts

`node tools/compare-receipt.mjs pinned/2026-8b7946970153c52e/BUILD-RECEIPT.pdftex.json wasm-build/dist`

| File | Bytes | Matches receipt |
|---|---|---|
| wasmtex-pdftex.wasm | 1672898 | yes |
| wasmtex-pdftex.js | 105102 | yes |
| wasmtex-pdftex.worker.js | 77849 | yes |
| wasmtex-pdftex-checkpoint.wasm | 2701068 | yes |
| wasmtex-pdftex-checkpoint.js | 111651 | yes |
| wasmtex-kpse-resolve.js | 3223 | yes |
| wasmtex-pdftex-resolver-evidence.js | 589 | yes |
| wasmtex-pdftex.fmt | | not built (see below) |

`node tools/compare-receipt.mjs pinned/2026-8b7946970153c52e/BUILD-RECEIPT.bibtex.json wasm-build/dist`

| File | Bytes | Matches receipt |
|---|---|---|
| wasmtex-bibtex.wasm | 205813 | yes |
| wasmtex-bibtex.js | 77802 | yes |
| wasmtex-bibtex.worker.js | 7044 | yes |

So the pinned Emscripten image and pinned TeX Live source produce the published
engine bytes exactly: the build is deterministic and the published binaries
are what the published source says they are.

## Not yet reproduced

- `wasmtex-pdftex.fmt`: the format is dumped by the built engine in a
  Playwright-driven browser against a TeX Live mirror (see
  format-generation.md). Separate step; needs the mirror.
- The other engines: XeTeX, LuaHBTeX, dvipdfm, BibTeX8, makeindex each have
  their own Dockerfile and workflow under `upstream-ci/`.

## Notes on the recipe

- The Dockerfile clones TeX Live source from GitHub at the pinned commit
  during the image build. The corresponding-source tarball carries the same
  tree; pointing the build at it is part of the vendoring work.
- `wasm-libs` runs a recursive make with `-` and `|| true`, expecting it to
  fail once it reaches libraries pdfTeX does not use (it fails configuring
  luajit). A tolerated failure hides real ones; replace with an explicit
  list of the subdirectories needed.
- Source maps (`*.map`) are produced beside the modules and are not part of
  the receipt.
