# Provenance

This repository owns the WebAssembly builds of the TeX engines LibrePaper
compiles LaTeX with in the browser. It was seeded on 2026-09-08 from the
engine build layer of WasmTex, https://github.com/corca-ai/wasmtex (MIT,
see LICENSE-wasmtex), at the snapshot its 2026 engine release was built from.

| Input | Identity |
|---|---|
| WasmTex build snapshot | `0dddc924cc6e69bd2a4b4630e02efe414f84515e` |
| WasmTex wrapper revision LibrePaper evaluated | `44c5861fcdf729838205b00b96ac9509bc7fb677` |
| Engine release reproduced | `2026-8b7946970153c52e` |
| TeX Live source commit | `fb6158926661cb7a7246b3a94a0cb170a9624d5a` (github.com/TeX-Live/texlive-source) |
| TeX Live package snapshot | `2026-ba38749b8714505a` |
| Emscripten | 3.1.46, `emscripten/emsdk:3.1.46@sha256:2491bc4bf6caf8c41993660822341bc72759cb577363dfe0781f0a2d05f7d357` |
| Corresponding-source tarball | `wasmtex-2026-8b7946970153c52e-source.tar.xz`, sha256 `a858abfd2d5b0ad7699ccb6b1dab8b45658c32ecac7a08d68c88bf76847b7cf2` |

What was copied, verbatim, from the snapshot:

- `wasm-build/`: Dockerfiles, Makefile, build scripts, C shims, TeX Live
  patches and the worker controllers. The whole TeX-to-wasm layer.
- `scripts/`: upstream's release tooling (build receipts, corresponding
  source, format extraction, TeX Live mirror sync). To be pruned to what
  the engine builds need.
- `LICENSES/`, `THIRD_PARTY_NOTICES.md`, `docs/licensing.md`,
  `docs/corresponding-source.md`: the licence obligations the engines carry.
  The engines are GPL; a build we publish must publish its source.
- `upstream-ci/`: upstream's GitHub workflows, kept as the reference for
  how each engine was built. Not wired up here.

The upstream editor, runtime library and application code were not copied.
LibrePaper has its own controller.
