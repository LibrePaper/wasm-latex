# Vendored Biber build

`third-party/texlyre-biber/` contains an unmodified selection from
[TeXlyre's build repository](https://github.com/TeXlyre/texlyre-busytex-build),
pinned to `f544a51a99e7d3978bb70608e927a9a23f96d4a7`.
`UPSTREAM.json` records the upstream path and SHA-256 of every selected file.
The complete `biber/` directory, license, notice, root README, Makefile and
Biber CI workflow are preserved. The latter three are reference material;
our build invokes the Biber driver directly, not the upstream Makefile.

## Build

From the repository root:

```sh
make biber-vendor-check
make biber-build
make biber-smoke # repeat the smoke check without rebuilding
```

The Docker build uses Emscripten 5.0.4, Perl 5.38.2 and Biber 2.22, matching
the upstream recipe. The container downloads dependencies, compiles Perl and
its XS modules, and runs a Node smoke check for XS loading and Unicode Biber
tool output. Only successful builds copy artifacts into
`dist/biber-experimental/`: `biber.js`, `biber.wasm`, `biber.data`, the vendor
receipt, installed package versions and compiler version. Both building the
image and running it require network access. Each run uses a fresh build tree.

This is a build integration, not advertised browser support. It neither
replaces LibrePaper's VM nor adds Biber to the release manifest. The existing
release source collector does not yet collect this family's dependencies.

## Initial validation (2026-09-09)

The Docker build and the Node smoke check passed, both inside the container
and through `make biber-smoke` on the host. All 21 vendored files were also
compared byte for byte with the pinned Git commit. `make test` passed.
The initial smoke check covers XS loading and Unicode processing in Biber
tool mode. The subsequent browser integration check below exercises `.bbl`
generation and the complete document workflow.
Under Node, the generated loader reports that IndexedDB is unavailable and
falls back to loading the data file directly; this is expected.

Measured output sizes (gzip level 9, each file compressed separately):

| File | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| `biber.js` | 959,313 | 218,137 |
| `biber.wasm` | 9,644,474 | 3,552,041 |
| `biber.data` | 18,261,749 | 10,219,791 |

Total: **27.53 MiB raw, 13.34 MiB gzipped**. These are this experimental
build's measurements, not a browser performance benchmark or a release-size
guarantee. The data pack already uses Emscripten's LZ4 packaging.

## Browser integration validation (2026-09-09)

The complete **pdfTeX WASM → Biber WASM → pdfTeX WASM → PDF** workflow
passed in Chromium 151.0.7922.137. It used this repository's built pdfTeX
worker, format, package bundles, and Biber artifacts, served by a local HTTP
server. Both engines ran in browser workers. No native TeX or Biber process
participated in this browser compilation.

The tracked `wasm-build/biber-fixture/` document uses biblatex's author-year
style and name/year/title sorting, with four references containing Åström,
Ecclésiastique, Sallustius and Žižek. The bundled biblatex identified itself
as **3.21**, with BCF **3.11**. After Biber and two further TeX passes, the
PDF contained all four references and the final TeX log had no unresolved
citation/reference or rerun-Biber warnings.

The 5,564-byte `.bbl` was byte-identical across browser Biber, Node Biber,
native Biber 2.22 (using the source extracted from our build), and the locally
installed Biber 2.21 beta. The browser and native inputs also had identical
`.bcf` bytes. The common `.bbl` SHA-256 was:

```text
b7cfbcf35d7a86318581107c440846da0c4d511d45b0e1042e46bf9cf39492fe
```

First browser run timings on this machine:

| Phase | Seconds |
| --- | ---: |
| First pdfTeX pass | 1.67 |
| Cold Biber initialization | 0.48 |
| Cold Biber execution | 1.09 |
| Warm Biber initialization, fresh instance in the same worker | 0.17 |
| Warm Biber execution | 0.50 |
| Second and third pdfTeX passes, combined | 0.60 |

These are one small fixture on a local HTTP server, not internet download
measurements or a broad compatibility/performance guarantee. The warm run
also verified that a fresh Biber instance reproduced the cold `.bbl` exactly.

Repeat with Node 22+, Chromium and `pdftotext` on PATH:

```sh
make biber-browser-check
# Optionally require equality with an independently produced native .bbl:
make biber-browser-check BIBER_CHECK_ARGS='--native-bbl /path/to/native/main.bbl'
```

`CHROMIUM` can select a different Chromium executable. The check writes the
PDF, extracted text, BCF, BBL, logs, timings and Biber artifact hashes under
`dist/biber-validation/browser/`. It uses a fresh browser profile on each run.
This verifies the engine combination in an isolated harness; LibrePaper's
application controller still needs to be connected to this Biber backend.

## Licensing

The vendored code retains TeXlyre's AGPL-3.0 license and copyright notice.
It is excluded from this repository's MIT claim. Local wrappers and checks
are MIT; the upstream scripts and patches are unchanged. The source snapshot
includes runtime patches and `browser_prerun.js`, not just build scripts:
audit their effect on the resulting artifact's terms before distributing it.
The Perl, Biber, XS and supporting-library licenses also need inventory.

## Before release integration

- Lock OS packages, CPAN archive URLs and hashes, and
  emperl/sombok git commits. Upstream currently resolves downloads at build
  time and copies pure Perl dependencies from `/usr/share/perl5`.
- Archive the complete sources and record the linked/runtime components.
- Expand the passing browser/native comparison beyond the Unicode author-year
  fixture to disambiguation, sourcemaps, cross-references, multiple bibliography
  sections and nested project paths.
- Add a browser worker that preserves relative project paths, then measure
  compressed download size, memory, cold and warm execution in browsers.

To update the vendor snapshot, select a new upstream commit, copy the same
paths without modification, regenerate `UPSTREAM.json`, and review the diff.
Keep local integration changes outside the snapshot so upstream updates remain
easy to inspect.
