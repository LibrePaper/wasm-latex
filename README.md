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

**Check the pins.** `tools/check-pins.mjs` verifies that the TeX Live commit and
the Emscripten image digest are pinned and that every place naming them agrees —
the Dockerfile builds with the image the published manifest claims:

    node tools/check-pins.mjs

**Check it against the published release.** `tools/compare-receipt.mjs` compares
your build to a `BUILD-RECEIPT.json` byte for byte. Against WasmTex's published
receipts for `2026-8b7946970153c52e` it matches exactly — the evidence that the
published binary is what its published source says. The hashes and the method are
in [`docs/reproduction-2026-pdftex.md`](docs/reproduction-2026-pdftex.md).

    node tools/compare-receipt.mjs <BUILD-RECEIPT.pdftex.json> wasm-build/dist

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

**Build the package bundles.** `tools/build-bundles.mjs` packs the same tree
into one tar per package directory, 5,503 bundles and 3.5 GB for 2026, indexed
by `bundles.json`, so the browser fetches a package in one request instead of
one request per file. Deterministic, receipted, and never bundles what a browser
engine cannot read. See [`docs/bundles.md`](docs/bundles.md).

    node tools/build-bundles.mjs \
      --texmf vendor/texlive-2026/texlive-20260301-texmf/texmf-dist \
      --texmf vendor/texlive-2026/texmf-var \
      --out wasm-build/dist/bundles \
      --evidence receipts/BUNDLE-RECEIPT.texlive-2026.json

`tools/build-format.mjs --bundles wasm-build/dist/bundles --expect-inputs
receipts/FORMAT-RECEIPT.pdftex-2026.json` builds the format through the
bundles instead of the tree and checks it resolved the same inputs.

**Prepare a distributable release.** The engines are GPL, so publishing them
carries obligations: notices, complete corresponding source, and a working
relink path for the LGPL library inside them. Four commands discharge and then
check every obligation this repository can check —
[`docs/licensing.md`](docs/licensing.md) explains each:

    node tools/link-inventory.mjs --family pdftex --out receipts/LINK-INVENTORY.pdftex.json
    node tools/build-corresponding-source.mjs --dist wasm-build/dist --out dist-source/
    node tools/stage-release.mjs --dist wasm-build/dist --bundles wasm-build/dist/bundles --out staged/ --source-url <published URL>
    node tools/check-release.mjs --dir staged/

Staging also runs the release gate. When it passes, `MANIFEST.json` records
`releaseGate: "passed"`, lists hashes and sizes for the entire payload (including
notices and receipts), and the command prints the manifest's SHA-256. LibrePaper
imports that directory with `make latex-mirror LATEX_RELEASE=<staged directory>
LATEX_RELEASE_SHA256=<reviewed manifest hash>`. No build or source checkout is
needed by the importer. An incomplete stage has no passing marker and cannot be
imported. `node tools/stage-release.test.mjs` tests this contract without building
engines or accessing the network.

`check-release.mjs` fails closed. Until the source archive is published
somewhere and named with `--source-url`, it refuses the release, which is the
correct answer: a GPL binary without its source is not distributable.

**Know what the workers can reach.** The JavaScript we ship alongside the wasm
contains no dynamic code and no embedded endpoint — every URL it builds comes
from the host — which is what lets it be published without auditing the host's
network policy too: [`docs/audit-worker-js.md`](docs/audit-worker-js.md).

## What is not done yet

- pdfTeX, BibTeX, BibTeX8, makeindex, XeTeX and dvipdfm are built here, with
  ICU data for XeTeX. XeTeX boots but has no format file and has compiled no
  document yet. LuaHBTeX has its Dockerfile and gates but has never been run.
- The engine Dockerfiles still clone TeX Live source from GitHub rather than
  using a vendored tarball.
- Compliance is established for every engine built. LuaHBTeX has no link
  inventory, so no terms are established for it.
- Nowhere is the source archive published yet, and LibrePaper does not link to
  it from the page serving the engines. That is a product decision, and until
  it is made `check-release.mjs` blocks the release.
- A clean rebuild *from the source archive* is not yet verified to reproduce
  the distributed bytes.
- LibrePaper's shipped mirror still points at the pinned WasmTex package
  snapshot until a release built here, with bundles, is imported. The
  importer, the controller's bundle mode, and the failure message that names
  a missing package are in LibrePaper; the release is not published.
- Only the pdfTeX worker resolves through bundles. The XeTeX, LuaTeX and
  dvipdfm workers still resolve one file at a time.

The product plan these serve, and where the browser stops and the paired local
app begins, is [`SPEC-latex.md`](SPEC-latex.md); the user-facing version is
[`docs/what-works-in-the-browser.md`](docs/what-works-in-the-browser.md).

## Two upstreams

The word is ambiguous here, so this repository avoids it and names which one it
means:

- **TeX Live** is upstream of the *source*: the C and Pascal that compile into
  the engines (`texlive-source`, pinned by commit) and the packages a document
  loads (`vendor/`, from the signed release archive).
- **WasmTex** (<https://github.com/corca-ai/wasmtex>) is upstream of the *build
  layer and the published binaries*: this repository was seeded from it, and it
  publishes its own compiled engine releases.

So "we reproduced the release byte for byte" means: WasmTex compiled TeX Live's
source to WebAssembly and published the result; we rebuilt from the same TeX
Live commit with the same recipe and got identical bytes.

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
- `LICENSES/`, `THIRD_PARTY_NOTICES.md`, `docs/licensing.md` — the obligations
  the engines carry. They are GPL: a build we publish must publish its source.

WasmTex's editor, runtime library and application code were not copied;
LibrePaper has its own controller. Written since the seed: `tools/`,
`receipts/`, and the docs named above.

## Layout

| Path | What |
|---|---|
| `wasm-build/` | The build: Dockerfiles, Makefile, worker controllers, C shims, and the from-source orchestration and gates for the engines not built here yet. Outputs to `dist/` (ignored). |
| `tools/` | Everything that runs here: format builder, bundle builder, link inventory, pin check, release staging and gate. |
| `receipts/` | Our build evidence — link inventories, format inputs, bundle summary, source-archive hashes. |
| `vendor/` | The verified TeX Live tree (ignored; 14 GB). |
| `docs/` | How each part works and what is still missing. |
| `LICENSES/` | Verbatim third-party notice texts, shipped whole with any release. |
| `linked-components.json`, `RELINK.md` | What is linked and on what terms, and the LGPL relink recipe — at the root because that is where they land in a release, beside `LICENSE` and `THIRD_PARTY_NOTICES.md`. |

This repository's own code is MIT ([`LICENSE`](LICENSE)). It tracks source only:
no engine binaries, formats, or TeX Live files are committed.
