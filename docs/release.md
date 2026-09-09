# Releasing

The whole path from source to a mirror LibrePaper serves, in the order it
runs. Every step is a `make` target here or in LibrePaper; the only step that
publishes anything is `make publish-source`, and `make release` refuses to
start if the tree is dirty, the tag exists, or `gh` is not signed in.

## 1. Build the engines (Docker, once per TeX Live source pin)

    docker buildx build --platform linux/amd64 --load \
      --build-arg TEXLIVE_REF=$(cat wasm-build/texlive-source-2026.ref) \
      -t librepaper-pdftex-wasm wasm-build/
    docker run --rm --platform linux/amd64 -v $PWD/wasm-build/dist:/dist librepaper-pdftex-wasm

The same shape with `Dockerfile.makeindex`, `Dockerfile.bibtex8`, and
`Dockerfile.luatex` builds those engines; XeTeX and dvipdfm come from
`TEXLIVE_YEAR=2026 bash wasm-build/build-xetex-fromsource.sh wasm-build/dist`,
and XeTeX's ICU data from `bash wasm-build/build-icu-data.sh`, which writes
the gzip the release ships. Each takes 15 to 20 minutes. `node
tools/check-pins.mjs` confirms the source commit and the Emscripten image are
the pinned ones. Skip this step when nothing under `wasm-build/` changed.

## 2. Build the data from the vendored tree

    make test         # unit tests, pin check, resolver tests
    make bundles      # font list, per-package bundles, receipt
    make format       # pdfTeX and XeTeX formats, smoked, with receipts
    make inventory    # link inventories for every engine family

`vendor/` must hold the verified TeX Live tree
(`docs/texlive-snapshot-2026.md`). `make bundles` and `make format` are
deterministic; rerunning them changes nothing unless the tree or the engines
did.

## 3. Commit

Everything under `receipts/` that changed is release evidence and is
committed. `make source` refuses a tree with uncommitted changes under
`wasm-build/`, `tools/` or `linked-components.json`, because the archive it
builds is `git archive HEAD` and would not be the source of the artifacts.

## 4. Publish the source and stage the release

    make release TAG=engines-2026.1

which is, step by step:

    make source                              # dist-source/<archive>.tar.xz and receipts/SOURCE-RECEIPT.json
    make publish-source TAG=engines-2026.1   # tags HEAD, creates the GitHub Release, uploads the archive
    make stage SOURCE_URL=<the URL it printed>
    tools/release.sh annotate engines-2026.1 # writes the manifest hash into the release notes

`make stage` assembles `staged/` and runs the gate. When it passes it prints
the SHA-256 of `staged/MANIFEST.json`. That hash is the release's identity;
it is what LibrePaper imports against and what the GitHub Release records.
Commit `receipts/SOURCE-RECEIPT.json` after `make source` so the receipt of
the published archive is in the history the tag names.

Tags are never moved. A second release gets a new tag and a new archive.

## 5. Import into LibrePaper and push the mirror

In the LibrePaper repository:

    node latex/tools/wasmtex.mjs --release ../wasm-latex/staged --sha256 <manifest hash>
    node latex/tools/check-mirror.mjs latex/mirror

The importer verifies the manifest against the hash and every payload file
against the manifest, then writes the release under `latex/mirror/`. A
release with bundles needs no per-file package set; `make latex-mirror` also
runs the legacy `--scheme` fetch from WasmTex's CDN, which a bundled release
does not use. Then, with the Cloudflare credentials loaded:

    make latex-push

which runs the mirror check and the browser smoke test first, writes the
`_headers` that keep `bundles.json` uncached and everything digest-named
immutable, and deploys the directory as Workers static assets. Every file
in a staged release is under the 25 MiB per-file limit and the whole set is
about 5,600 files, under the free plan's 20,000.

## What the gate checks

`make check` runs `tools/check-release.mjs` on `staged/`: every artifact
named and unmodified, every linked component classified with its notice
present, the LGPL relink recipe shipped, the corresponding source named,
hashed and built for these exact bytes, every format's inputs receipted, and
every bundle matching the index and the index matching the manifest. It
fails closed. `docs/licensing.md` explains the obligations behind each check.
