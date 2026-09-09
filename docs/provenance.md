# Provenance

This repository was seeded on 2026-09-08 from the engine build layer of WasmTex,
<https://github.com/corca-ai/wasmtex> (MIT, see
[`LICENSES/WasmTex.txt`](LICENSES/WasmTex.txt)), at the snapshot its 2026 engine
release was built from.

| Input | Identity |
|---|---|
| WasmTex build snapshot | `0dddc924cc6e69bd2a4b4630e02efe414f84515e` |
| WasmTex wrapper revision LibrePaper evaluated | `44c5861fcdf729838205b00b96ac9509bc7fb677` |
| Engine release reproduced | `2026-8b7946970153c52e` |
| TeX Live source commit | `fb6158926661cb7a7246b3a94a0cb170a9624d5a` (github.com/TeX-Live/texlive-source) |
| TeX Live packages, upstream's | `2026-ba38749b8714505a` (their CDN; not used as a build input here) |
| TeX Live packages, ours | `texlive-20260301-texmf.tar.xz`, signature-verified |
| Emscripten | 3.1.46, `emscripten/emsdk:3.1.46@sha256:2491bc4bf6caf8c41993660822341bc72759cb577363dfe0781f0a2d05f7d357` |
| Corresponding-source tarball | `wasmtex-2026-8b7946970153c52e-source.tar.xz`, sha256 `a858abfd2d5b0ad7699ccb6b1dab8b45658c32ecac7a08d68c88bf76847b7cf2` |

Copied verbatim from that snapshot:

- `wasm-build/` — Dockerfiles, Makefile, build scripts, C shims, TeX Live
  patches, worker controllers. The whole TeX-to-wasm layer.
- `LICENSES/`, `THIRD_PARTY_NOTICES.md`, `docs/licensing.md` — the obligations
  the engines carry. They are GPL: a build we publish must publish its source.

WasmTex's editor, runtime library and application code were not copied;
LibrePaper has its own controller. Written since the seed: `tools/`,
`receipts/`, and the docs named above.

## Two upstreams

The word is ambiguous here, so this repository avoids it and names which one it
means:

- **TeX Live** is upstream of the *source*: the C and Pascal that compile into
  the engines (`texlive-source`, pinned by commit) and the packages a document
  loads (`vendor/`, from the signed release archive).
- **WasmTex** (<https://github.com/corca-ai/wasmtex>) is upstream of the *build
  layer and the published binaries*: this repository was seeded from it, and it
  publishes its own compiled engine releases.

## The seed was checked once

On 2026-09-08, before anything here was changed, the seed's recipe was run
from the pinned TeX Live commit and compared with the receipts of WasmTex's
published `2026-8b7946970153c52e` release. Every compiled file matched byte
for byte: `wasmtex-pdftex.wasm` (1,672,898 bytes, sha256
`bf0b9fd1772fc78b02ad19eff39f7e03a73d7eefc1c1d05b15387768e57d013d`) and
`wasmtex-bibtex.wasm` (205,813 bytes, sha256
`7ee47f5959d9f2a0d4cbde264be97472b6c1b7a1da2ca58b67baea759b03c3d6`) among
them. That established that the layer we started from was what its source
said. It is history, not process: nothing here compares against WasmTex any
more, and the reproduction evidence this repository owes is its own, a
rebuild from its published source archive matching its staged manifest.
