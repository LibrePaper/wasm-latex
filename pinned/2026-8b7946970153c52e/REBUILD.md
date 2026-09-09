# Rebuild inputs

The exact WasmTex source snapshots used by the build receipts are:

- `06f1937c502188fe04f0931fed702d06c2b78ab3`
- `0dddc924cc6e69bd2a4b4630e02efe414f84515e`

The pinned TeX Live source is under `source/texlive/`; the unused legacy
`libs/pplib` directory is deliberately absent. WTPDF/Xpdf integration, SHA-2 source,
Dockerfiles, worker glue, and build scripts are in each WasmTex snapshot.

Emscripten source is under `source/emscripten/`. Exact source archives for every
Emscripten port used by these builds are under `source/ports/`. The build image is
`emscripten/emsdk:3.1.46@sha256:2491bc4bf6caf8c41993660822341bc72759cb577363dfe0781f0a2d05f7d357`.

Run the original build workflow from the snapshot named by each receipt. A release is
not approved until a clean builder rebuild has been compared with the receipt-bound
artifact bytes and any deterministic differences have been recorded.
