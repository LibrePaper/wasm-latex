# librepaper-wasm-latex

Engines built to WebAssembly for LibrePaper's in-browser LaTeX compiler:
pdfTeX, XeTeX, dvipdfm, BibTeX, BibTeX8, Biber and makeindex, plus the
experimental LaTeXML HTML renderer and the TeX Live packages they load, packed
for the browser.

Nothing LibrePaper ships has to be taken on trust from someone else's CDN.
Every engine is built here from pinned source, every format and package from
a TeX Live tree whose signature was checked, and every release carries the
receipts and notices that let a reader verify that.

## Use it

    make vendor                  # fetch and verify the TeX Live tree, once
    make test                    # every check that needs no Docker or network
    make bundles                 # pack TeX Live into per-package bundles
    make format                  # dump and smoke the pdfTeX and XeTeX formats
    make release TAG=<tag>       # publish the source, stage, gate, print the manifest hash
    make mirror                  # build the mirror LibrePaper serves from staged/
    make push                    # deploy it to Cloudflare (needs CLOUDFLARE_API_TOKEN)

Engines themselves are built with Docker; see [`docs/release.md`](docs/release.md)
for the whole path from source to a mirror LibrePaper serves. `make help`
lists every target.

## Docs

- [`SPEC-latex.md`](SPEC-latex.md): the product plan, where the browser
  stops and the paired local app begins, and what is done and not done.
- [`docs/what-works-in-the-browser.md`](docs/what-works-in-the-browser.md):
  the same seam for authors and agents deciding whether to pair.
- [`docs/release.md`](docs/release.md): the release runbook.
- [`docs/biber.md`](docs/biber.md): the pinned TeXlyre Biber build, release packaging and browser checks.
- [`docs/latexml.md`](docs/latexml.md): the experimental LaTeXML HTML worker,
  standalone CSS resources, and pinned source receipt.
- [`docs/mirror.md`](docs/mirror.md): the mirror LibrePaper serves -- layout,
  manifest format 1, and the contract `tools/build-mirror.mjs` and
  `tools/check-mirror.mjs` implement.
- [`docs/bundles.md`](docs/bundles.md): how packages reach the browser, and
  what is and is not bundled.
- [`docs/format-generation.md`](docs/format-generation.md): how the formats
  are dumped, and why it takes two texmf trees.
- [`docs/licensing.md`](docs/licensing.md): the obligations behind each
  release-gate check.
- [`docs/audit-worker-js.md`](docs/audit-worker-js.md): the shipped
  JavaScript has no dynamic code and no embedded endpoint.
- [`docs/provenance.md`](docs/provenance.md): where this repository came
  from, the pinned inputs, and what "upstream" means here.
- [`docs/texlive-snapshot-2026.md`](docs/texlive-snapshot-2026.md): the
  dated record of how the 2026 tree was fetched and verified.

## Layout

| Path | What |
|---|---|
| `wasm-build/` | Dockerfiles, build scripts, C shims and worker controllers. Outputs to `dist/`, ignored. |
| `tools/` | Everything that runs here: bundle and format builders, link inventory, pin check, staging, the gate, release publishing. |
| `receipts/` | Build evidence: link inventories, format and bundle inputs, source-archive hashes. |
| `vendor/` | The verified TeX Live tree, ignored, 14 GB. |
| `LICENSES/`, `THIRD_PARTY_NOTICES.md`, `linked-components.json`, `RELINK.md` | What is linked, on what terms, the notice texts, and the LGPL relink recipe, at the root because that is where they land in a release. |

This repository's own code is MIT ([`LICENSE`](LICENSE)). The vendored TeXlyre
Biber build retains its [AGPL-3.0 license](third-party/texlyre-biber/LICENSE).
It tracks source only:
no engine binaries, formats or TeX Live files are committed.
