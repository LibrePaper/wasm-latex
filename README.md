# librepaper-wasm-latex

TeX engines built to WebAssembly for LibrePaper's in-browser LaTeX compiler:
pdfTeX, XeTeX, LuaHBTeX, dvipdfm, BibTeX, BibTeX8, makeindex.

The point of owning this layer is that nothing LibrePaper ships has to be taken
on trust from someone else's CDN. Every engine binary is built here from pinned
source, and every format file from a TeX Live tree whose signature we checked.

## What you can do with it

**Build the engine.** One Docker command compiles TeX Live's sources into
`wasmtex-pdftex.wasm` and BibTeX, about 15 minutes:

    docker buildx build --platform linux/amd64 --load \
      --build-arg TEXLIVE_REF=$(cat wasm-build/texlive-source-2026.ref) \
      -t librepaper-pdftex-wasm wasm-build/
    docker run --rm --platform linux/amd64 -v $PWD/wasm-build/dist:/dist librepaper-pdftex-wasm

**Check it against the published release.** `tools/compare-receipt.mjs` compares
your build to upstream's pinned receipts byte for byte. It currently matches
exactly, which is the evidence that the published binary is what its published
source says — see [`docs/reproduction-2026-pdftex.md`](docs/reproduction-2026-pdftex.md).

    node tools/compare-receipt.mjs pinned/2026-8b7946970153c52e/BUILD-RECEIPT.pdftex.json wasm-build/dist

**Build the format.** `tools/build-format.mjs` dumps `wasmtex-pdftex.fmt` in about
five seconds from a texmf tree on disk — no browser, no network, deterministic,
and it hashes every input into a receipt. `--smoke` then compiles a document with
the result. See [`docs/format-generation.md`](docs/format-generation.md).

    node tools/build-format.mjs \
      --texmf vendor/texlive-2026/texlive-20260301-texmf/texmf-dist \
      --texmf vendor/texlive-2026/texmf-var \
      --out wasm-build/dist/wasmtex-pdftex.fmt \
      --evidence receipts/FORMAT-RECEIPT.pdftex-2026.json --smoke

The texmf tree comes from the official TeX Live release archive, verified
against TUG's signed hash: [`docs/texlive-snapshot-2026.md`](docs/texlive-snapshot-2026.md).

## What is not done yet

- Only pdfTeX and BibTeX are built here. XeTeX, LuaHBTeX, dvipdfm, BibTeX8 and
  makeindex have their Dockerfiles and gates but have never been run.
- The engine Dockerfiles still clone TeX Live source from GitHub rather than
  using a vendored tarball.
- No license-compliance gate runs here; upstream's needed its application tree
  and was removed. The policy still binds — see the status note at the top of
  [`docs/licensing.md`](docs/licensing.md). This is a precondition for
  publishing engine artifacts.
- We generate no build receipts of our own for engine binaries, only for formats.
- LibrePaper itself still fetches TeX Live packages from upstream's CDN at
  compile time. This repository makes the engine ours; the package mirror is
  the next job.

## Provenance

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
- `scripts/` — upstream's release tooling, since pruned from 113 files to the
  16 that do useful work here ([`docs/build-layer-inventory.md`](docs/build-layer-inventory.md)).
- `LICENSES/`, `THIRD_PARTY_NOTICES.md`, `docs/licensing.md`,
  `docs/corresponding-source.md` — the obligations the engines carry. They are
  GPL: a build we publish must publish its source.

Upstream's GitHub workflows were seeded too and have since been removed: they
could not run here, and what they actually did per engine is written down in
[`docs/build-layer-inventory.md`](docs/build-layer-inventory.md).

The upstream editor, runtime library and application code were not copied;
LibrePaper has its own controller. Written since the seed: `tools/`,
`receipts/`, and the docs named above.

## Layout

| Path | What |
|---|---|
| `wasm-build/` | The build: Dockerfiles, Makefile, worker controllers, C shims. Outputs to `dist/` (ignored). |
| `tools/` | Ours: format builder, receipt comparison. |
| `receipts/` | Our build evidence — inputs and hashes for what we produce. |
| `pinned/` | Upstream's published receipts for release `2026-8b7946970153c52e`, the thing we compare against. |
| `scripts/` | Kept upstream tooling: pinned-source check, corresponding-source builder, gates for the engines not yet built. |
| `vendor/` | The verified TeX Live tree (ignored; 14 GB). |
| `docs/` | How each part works and what is still missing. |

This repository's own code is MIT ([`LICENSE`](LICENSE)). It tracks source only:
no engine binaries, formats, or TeX Live files are committed.
