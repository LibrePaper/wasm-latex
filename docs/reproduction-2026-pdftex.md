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

- `wasmtex-pdftex.fmt`: not attempted, and no longer a goal. The format is
  now built offline from a local texmf tree by `tools/build-format.mjs` (see
  format-generation.md), from inputs we hash ourselves rather than from
  upstream's CDN, so its bytes are ours and are not expected to match the
  pinned receipt.
- The other engines: XeTeX, LuaHBTeX, dvipdfm, BibTeX8, makeindex each have
  their own Dockerfile in `wasm-build/`, and their build sequence is recorded
  in `build-layer-inventory.md`.

## Notes on the recipe

- The Dockerfile clones TeX Live source from GitHub at the pinned commit
  during the image build. The corresponding-source tarball carries the same
  tree; pointing the build at it is part of the vendoring work.
- `wasm-libs` ran a recursive make with `-` and `|| true`, expecting it to
  fail once it reached libraries pdfTeX does not use (it failed configuring
  luajit). A tolerated failure hides real ones. Replaced with an explicit
  list of the subdirectories the link lines draw from (`libs/zlib`,
  `texk/kpathsea`), each of which must now succeed. `native-build` still
  tolerates its own failure, for a harder reason: the native phase exists to
  run web2c's code generation across the whole tree, and it is checked
  afterwards by asserting the generated pdfTeX C files exist.
- Source maps (`*.map`) are produced beside the modules and are not part of
  the receipt.
