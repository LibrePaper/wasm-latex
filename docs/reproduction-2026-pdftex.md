# Reproduction: pdfTeX and BibTeX, engine release 2026-8b7946970153c52e

Date: 2026-09-08. Machine: 16 cores, Docker 29.7, x86_64.

Built from this repository's `wasm-build/` at the seed commit, which is the
WasmTex snapshot `0dddc924` the release receipts name, with the recipe as it
stood at that commit:

    docker buildx build --platform linux/amd64 --load \
      --build-arg TEXLIVE_REF=$(cat wasm-build/texlive-source-2026.ref) \
      -t librepaper-pdftex-wasm wasm-build/
    docker run --rm --platform linux/amd64 -v $PWD/wasm-build/dist:/dist librepaper-pdftex-wasm

Timings: image (native TeX Live build) 12m53s; wasm phase 2m33s.

## Result: every compiled file matched, byte for byte

Compared with `tools/compare-receipt.mjs` against the `BUILD-RECEIPT.*.json`
files WasmTex published with its engine release `2026-8b7946970153c52e`. Those
receipts are no longer vendored here — they are WasmTex's to publish — so the hashes
they assert are reproduced below. Anyone can rebuild and check against this
table, or fetch the receipts from WasmTex and run:

    node tools/compare-receipt.mjs <their BUILD-RECEIPT.pdftex.json> wasm-build/dist

| Artifact | Bytes | SHA-256 WasmTex asserts, and our build produced |
|---|---|---|
| `wasmtex-kpse-resolve.js` | 3223 | `0303650d65055961498677e0e109357b061873b86a063cb901800a2a84b4859d` |
| `wasmtex-pdftex-checkpoint.js` | 111651 | `7b234c8ef04fb59716487ef7f1fd56f0155488aff4d328a3b26e5f8de9decdef` |
| `wasmtex-pdftex-checkpoint.wasm` | 2701068 | `83563869d753277b32f885cc4207355d13aba86e47fd804fb712f3722fecfc48` |
| `wasmtex-pdftex-resolver-evidence.js` | 589 | `f42ab09591de3108ac07635f060cc1fca27571f62a852edf5e6307515b83b728` |
| `wasmtex-pdftex.js` | 105102 | `80da7fce4ad7238271bd5b5c6a7a790fb4f6a527ea84e8193be2721e6646b3c1` |
| `wasmtex-pdftex.wasm` | 1672898 | `bf0b9fd1772fc78b02ad19eff39f7e03a73d7eefc1c1d05b15387768e57d013d` |
| `wasmtex-pdftex.worker.js` | 77849 | `2bde4060a105d0e739c506a89ecfa765f0b5ffab8ec91a2577bf7e967b09c7fe` |
| `wasmtex-bibtex.js` | 77802 | `1355f9aa7a7fa27a514876a448bbe7b17ba07cfb1ec2c1a251a2d4f0ebc9d9b4` |
| `wasmtex-bibtex.wasm` | 205813 | `7ee47f5959d9f2a0d4cbde264be97472b6c1b7a1da2ca58b67baea759b03c3d6` |
| `wasmtex-bibtex.worker.js` | 7044 | `50f6ef0b0c16473c3dda2c20bb47cd4f2a9003d221b59c3d756226168c5947a3` |

The only file in those receipts we did not reproduce is `wasmtex-pdftex.fmt`
(3657154 bytes, sha256 `fd1f4c0411b9bceb8562acd847b62da030b3b803b72799bff6c73dc095935bb5`),
which is a format dump rather than compiled code. We build our own from a
signature-verified TeX Live tree instead; see `format-generation.md`.

So the pinned Emscripten image and pinned TeX Live source produce the published
engine bytes exactly: the build is deterministic and the published binaries
are what the published source says they are.

## Not yet reproduced

- `wasmtex-pdftex.fmt`: not attempted, and no longer a goal. The format is
  now built offline from a local texmf tree by `tools/build-format.mjs` (see
  format-generation.md), from inputs we hash ourselves rather than from
  WasmTex's CDN, so its bytes are ours and are not expected to match the
  pinned receipt.

## Notes on the recipe

- The Dockerfile clones TeX Live source from GitHub at the pinned commit
  during the image build. The corresponding-source tarball carries the same
  tree; pointing the build at it is part of the vendoring work.
- `wasm-libs` builds an explicit list of the subdirectories the link lines draw
  from (`libs/zlib`, `texk/kpathsea`), each of which must succeed, so a broken
  library cannot pass as one pdfTeX does not use. `native-build` does tolerate
  its own failure: the native phase exists to run web2c's code generation across
  the whole tree, and it is checked afterwards by asserting the generated pdfTeX
  C files exist.
- Source maps (`*.map`) are produced beside the modules and are not part of
  the receipt.
