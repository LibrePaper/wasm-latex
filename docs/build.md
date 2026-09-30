# Building engines and formats

## Bundles

The browser engines do not fetch TeX Live one file at a time. A cold compile of a plain article touches about 50 files, TikZ or beamer about 400. `tools/build-bundles.mjs` packs the verified texmf tree into one tar per package directory, indexed by `bundles.json`, and the worker fetches a whole bundle the first time any file in it is asked for. Bundling reduces requests by an order of magnitude while preserving package-level on-demand downloads.

### Building bundles

```sh
node tools/build-bundles.mjs \
  --texmf vendor/texlive-2026/texlive-20260301-texmf/texmf-dist \
  --texmf vendor/texlive-2026/texmf-var \
  --out wasm-build/dist/bundles \
  --evidence receipts/BUNDLE-RECEIPT.texlive-2026.json
```

The first tree is the signed release archive. The second contributes only its `fonts/map/` directory, the `pdftex.map` and friends that `updmap-sys` generates; for those paths the later tree wins. Any other path present in both trees is an error.

Bundles are deterministic: tar entries are written in sorted path order, mtime is fixed at `SOURCE_DATE_EPOCH`, uid and gid are zero, and a tar whose digested path already exists is not rewritten. The same tree yields the same bytes; the receipt records the index hash so a rebuild can be checked against it.

### What is in a bundle

The grouping rules are in `tools/bundle-rules.mjs` and have no input beyond the tree:

- For macros: `tex/<format>/<package>/` is one bundle (e.g. `tex/latex/amsmath/`, `tex/generic/pgf/`).
- For fonts: the union of `fonts/<kind>/<foundry>/<name>/` across every `<kind>` (`tfm`, `vf`, `type1`, `enc`, `map`, `opentype`, `truetype`) is one bundle named `fonts/<foundry>/<name>`. A font package's metrics and glyphs arrive together.
- `bibtex/bst/<package>/`, `bibtex/bib/<package>/`, `makeindex/<package>/`, `tex/latex/base/`, and `web2c/` follow the macro rule.
- `tex/xetex/fontlist`: `xetexfontlist.txt`, the by-name font database XeTeX's fontconfig shim reads (kpse format 26). It has no counterpart in TeX Live; `tools/xetex-fontlist.mjs` generates it with `otfinfo` and `tools/build-bundles.mjs --extra` adds it to the index.
- Any bundle over 20 MiB of tar bytes is split into numbered parts by file order; the resolver sees parts as ordinary bundles.
- `texmf-var/fonts/map/` (the `pdftex.map` and variants) joins the `core` bundle; nothing else in `texmf-var` is bundled.
- Never bundled (no browser engine reads them): `doc/`, `source/`, Metafont sources, PK bitmaps, AFM metrics, Type 3 fonts, non-Lua scripts, and trees of tools not shipped (tex4ht, MetaPost, dvips, xindy, Asymptote and the rest).
- `tex/latex-dev` is excluded by default (`--include-latex-dev` re-enables it): the format build already has to rank it below `tex/latex`, and serving it invites the same mistake at runtime.
- A file that would drag a whole package in for one member is named in `FILE_BUNDLE_OVERRIDES`: `supp-pdf.mkii` (which `pdftex.def` loads and which sat in 47 MB of ConTeXt) goes into core; `pdftex.map` (a 5.5 MB variant) is its own bundle.

### The core bundle

One bundle, `core`, pre-merges what nearly every pdfLaTeX document loads before its first preamble line: `tex/latex/base`, `tex/latex/l3kernel`, `tex/latex/l3backend`, `tex/latex/l3packages`, `tex/latex/amsmath`, `tex/latex/graphics`, `tex/latex/graphics-cfg`, `tex/latex/graphics-def`, `tex/latex/hyperref`, `tex/latex/geometry`, `tex/latex/tools`, `tex/latex/babel`, `tex/generic/babel`, `tex/latex/kvoptions`, `tex/generic/iftex`, `tex/generic/infwarerr`, `tex/generic/ltxcmds`, `tex/generic/kvsetkeys`, `tex/generic/pdftexcmds`, `tex/latex/auxhook`, `tex/latex/rerunfilecheck`, `tex/latex/url`, the Computer Modern and AMS font bundles, `pdftex.map`, and the encoding files those fonts reference.

- The list is measured, not guessed: the format's own inputs plus what two ordinary papers load, resolved through `tools/build-format.mjs --smoke-doc --smoke-evidence` measured 2026-09-09.
- Size: 18.3 MB in one part, 2,185 files. `DEFAULT_CORE` in `tools/bundle-rules.mjs` is the list.
- `fonts/public/amsfonts` (4.6 MB, for `amssymb`) stays separate.
- Files in `core` are not repeated in their own package bundles; the index points to `core`.
- Most papers then make one to three requests on a cold cache, and none on a warm one.

### The 2026 build

| | |
|---|---|
| Bundles | 5,479 (73 split parts) |
| Files | 159,000 |
| Bytes | 3.49 GB: fonts 2.77 GB, macros 645 MB |
| `core` | 18.3 MB in one part, 2,185 files |
| Index | `bundles.json`, 159,000 file entries |

### The index

```json
{
  "schemaVersion": 1,
  "snapshot": "texlive-20260301-texmf",
  "sourceDateEpoch": 1772323200,
  "bundles": { "tex/latex/tikz": { "url": "b/<sha256>/tex-latex-tikz.tar", "size": 1234, "sha256": "<sha256>", "files": 12 } },
  "files":   { "tex/latex/tikz/tikz.sty": "tex/latex/tikz" }
}
```

`files` maps every texmf-relative path to its bundle, and doubles as the existence check: a name not in it is absent, with no request. Bundle URLs are relative to the texlive endpoint and carry the tar's own digest, so they are served with `Cache-Control: immutable`.

`RECEIPT-FILES.json.gz` beside the index lists every member of every bundle with its size and sha256. The committed `receipts/BUNDLE-RECEIPT.*.json` is the summary: inputs, epoch, exclusions, core list, the index hash, and one line per bundle.

### How the worker resolves files

Bundle-mode resolution in `kpse_find_file_impl` (once `loadbundleindex` has loaded the index):

1. Resolves the (format, name) request to a texmf path. At load the worker inverts `files` once into a name-to-paths map; a name with several paths (`latex.ltx` in both `base` and `latex-dev/base`, `hyphen.cfg` in three packages) is ranked by the same `FORMAT_SEARCH_ORDER` `tools/build-format.mjs` uses for the format build. The ranking is in `wasm-build/kpse-resolve.cjs`, so the format and the runtime resolve identically.
2. Looks the path up in `files`. Absent means absent: record it in `texlive404_cache` and return 0, no request.
3. If the bundle is not yet loaded, fetches it with one synchronous XHR, verifies its digest against the index, and unpacks every member into the virtual filesystem under `/texmf/`. Members are written once; later requests for siblings hit `texlive200_cache`.
4. Returns the path.

The XHR stays synchronous because kpathsea is synchronous and the engine is not re-entrant. The worker's `downloading` message gains the bundle name and size, so progress indicators report "amsmath, 1.2 MB" instead of a stream of file names.

Where the Cache Storage API is available, verified bundles are stored in the `librepaper-bundles` cache keyed by their digested URL, and preloaded on the next `loadbundleindex`. Editing sessions then make no requests; the count is driven only by new users and new packages. A warm compile of any corpus document makes no request.

Without `loadbundleindex` the worker behaves as before, one file per request, which the format harness and the previous LibrePaper mirror still use.

### Format build through bundles

`tools/build-format.mjs --bundles wasm-build/dist/bundles` serves the index and the tars to the worker instead of individual files, and `--expect-inputs receipts/FORMAT-RECEIPT.pdftex-2026.json` asserts that it resolved exactly the files the per-file build did, hash for hash, with no per-file request during the smoke compile. The two `.fmt` files are not byte-identical (TeX records the path it opened hyphenation loaders under, and bundle mode nests those under `/texmf/`). Both typeset the same. The committed format stays the per-file build, whose hash `docs/texlive-snapshot-2026.md` pins.

### Performance targets

With bundles, a cold compile makes far fewer requests than the per-file model:

| Document | Per-file requests | Bundled, cold | Bundled, warm |
|---|---|---|---|
| Plain article | about 50 | about 5 | 0 |
| TikZ or beamer | about 400 | about 20 | 0 |

A cold plain article after `core` fetches amsfonts, the map, and cm-super's one Type 1 file for OT1's TS1 symbols; more than that means the core list is wrong. If a warm compile of any corpus document makes a request, the cache is wrong.

### Release

`tools/stage-release.mjs --bundles wasm-build/dist/bundles` copies the index, the file receipt and the tars into `staged/bundles/`, records `bundles` in the manifest, and `tools/check-release.mjs` verifies every tar against the index, the index against the manifest, and refuses a tar the index does not name.

## Formats

A `.fmt` file is LaTeX precompiled into an engine memory image: the kernel, the class-independent macro layer, and the hyphenation tries, dumped by INITEX so the browser does not rebuild them on every page load.

### How it runs

The invocation is in the README. No network, no browser, no TypeScript host: the harness runs `wasm-build/dist/pdftex.worker.js` on Node, gives it the worker-shaped globals it expects (`self`, `importScripts`, synchronous `XMLHttpRequest`, `performance`), hands the engine its `.wasm` through `__librepaperEngineBinary`, and drives the worker's own protocol: `settexliveurl`, then `compileformat`. The format bytes come back on a `postMessage`. A build takes about five seconds after the texmf tree is indexed.

### Flags

- `--texmf` may be repeated; the trees are searched in the order given.
- `--smoke` loads the format back into the same engine and compiles a document with it, so a format built from the wrong inputs fails here.
- `--evidence` writes the input manifest described below.
- `--epoch` (or `SOURCE_DATE_EPOCH`) sets the frozen clock.
- `--verbose` logs every lookup; `--trace-messages` logs the worker protocol.

### Why the inputs need two trees

A TeX installation is not one directory. `texmf-dist` holds the distributed files, but the font map files (particularly `pdftex.map`) are generated by `updmap` into `texmf-var`, and are in no release archive. Without the map the format still builds and LaTeX still typesets, then pdfTeX fails at font embedding with `cannot open font map file`, falls back to `mktexpk`, and dies. Whatever tree we build a format against must therefore include a generated map, which means running `updmap-sys` once when the snapshot is made.

### Resolution is kpathsea's job

The engine asks for a file as a (kpathsea format id, bare name) pair. Upstream answered those from a flat CDN bucket where each name mapped to exactly one file. A real texmf tree has several: `latex.ltx` exists in both `tex/latex/base` and `tex/latex-dev/base`, and `hyphen.cfg` in babel, cslatex, and antomega.

`FORMAT_SEARCH_ORDER` in the harness lists, per format id, the path prefixes in kpathsea's preference order, mirroring the search paths pdflatex runs with (`TEXINPUTS = .;$TEXMF/tex/{latex,generic,}//`). Candidates are ranked by that order, then by which `--texmf` tree they came from, then by depth and name, so the result never depends on directory iteration order. A name found only outside its format's subtrees is not that format's file and is not offered. Picking `latex-dev`'s kernel and cslatex's `hyphen.cfg` produced a format 1.4 MB short of a correct one, because it had loaded two languages' patterns instead of every language's.

### Determinism

TeX stamps the dump with the current date. The harness freezes the clock at `SOURCE_DATE_EPOCH` (default 2026-03-01) so the same engine and the same texmf tree always produce the same bytes. Without this the format is a new file every day and no receipt means anything.

### Evidence

`--evidence` writes the format's complete input manifest: the texmf roots, the frozen epoch, the format's own size and sha256, every file the build resolved with its absolute path, size and sha256, and every request nothing satisfied. Unsatisfied requests are normal (kpathsea probes for names that do not exist) but the list is worth reading when a format looks wrong. The inputs recorded are the format build's only; the `--smoke` compile runs after the manifest is closed and its own font lookups are not mixed in.

### XeTeX

`--engine xetex` builds `xetex.fmt` against `wasm-build/dist/xetex.{wasm,worker.js}` instead of the pdfTeX engine. Everything above still applies (same harness, same frozen clock, same `--texmf` trees, same evidence shape), but four things differ, all confined to the XHR shim and the smoke step:

- **Gzip:** LibrePaper's `ENGINE_FILE_SETS` names `xetex.fmt.gz`, so `--engine xetex` writes both `xetex.fmt` and a gzip of it beside it. The bytes served to the engine itself are always the uncompressed form (xetex-worker.js does not gunzip client-side).
- **ICU data:** XeTeX's font manager needs real ICU data; the worker fetches `icudt68l.dat` at `<endpoint>icudt68l.dat` with no `pdftex/<format>/` prefix, and the harness answers that one URL shape directly from `wasm-build/dist/icudt68l.dat`.
- **The format is not preloaded:** pdfTeX's worker has a `loadformat` message; xetex-worker.js has no such command. The engine fetches its own format through the same kpse hook as every other file, under the bare name `--fmt=` was given in `xetex-entry.c` (`xetex`), kpathsea format 10. The harness registers the format bytes it just dumped under that name before running the smoke compile, so the fetch is served from memory instead of the disk.
- **Fonts:** `\setmainfont{lmroman10-regular.otf}` (by file name) resolves through the ordinary per-format search order (format 47 is `fonts/opentype/`, 36 is `fonts/truetype/`). `\setmainfont{Latin Modern Roman}` (by family name) goes through fontconfig-shim.c's `FcFontList()`, which reads `xetexfontlist.txt` (kpse format 26), a file with no counterpart in TeX Live. The harness generates it at build time from every OpenType/TrueType font in the `--texmf` trees, using `otfinfo` to read each font's family/style/full names in the record format `fontconfig-shim.c` parses.

`--smoke` for XeTeX compiles a fontspec document twice (once selecting the font by family name, once by file name; `--font-variant name|file` picks one, `--smoke-both` runs both), then feeds the `.xdv` XeTeX writes to a second, independently booted `dvipdfm` engine session (same texmf index, same XHR shim) and asserts the result starts with `%PDF-` and embeds an LM font. That second assertion has to look past xdvipdfmx's default use of compressed PDF object streams (a plain byte search for `LMRoman` misses a correctly embedded font whose `/BaseFont` entry lives inside a Flate-compressed `/ObjStm`), so the harness also inflates every `stream`...`endstream` region and searches the decompressed bytes.

XeTeX runs with `-synctex=1` and the worker returns the `.synctex(.gz)` bytes on the compile reply as a `synctex` field, mirroring `pdftex-worker.js`.

## Biber

`third-party/texlyre-biber/` contains an unmodified selection from [TeXlyre's build repository](https://github.com/TeXlyre/texlyre-busytex-build), pinned to `f544a51a99e7d3978bb70608e927a9a23f96d4a7`. `UPSTREAM.json` records the upstream path and SHA-256 of every selected file. The complete `biber/` directory, license, notice, root README, Makefile and Biber CI workflow are preserved. The latter three are reference material; our build invokes the Biber driver directly, not the upstream Makefile.

### Build

```sh
make biber-vendor-check
make biber-build
make biber-smoke # repeat the smoke check without rebuilding
```

The Docker build uses Emscripten 5.0.4, Perl 5.38.2 and Biber 2.22, matching the upstream recipe. The container downloads dependencies, compiles Perl and its XS modules, and runs a Node smoke check for XS loading and Unicode Biber tool output. Only successful builds copy artifacts into `wasm-build/dist/`: `biber.js`, `biber.wasm`, `biber.data`, `biber.worker.js`, `biber.build.json`, the link map, notices and `BIBER-SOURCE.tar.gz`. Both building the image and running it require network access. Each run uses a fresh build tree.

Biber is an engine family in the normal release and mirror pipeline. The release gate verifies its artifact hashes, link inventory and source receipt. The mirror builder checks its control-file version against bundled biblatex. LibrePaper loads the verified runtime lazily and runs each bibliography job in a fresh worker. New mirrors need no Linux VM or server Biber flag.

### Validation

Measured output sizes (gzip level 9, each file compressed separately):

| File | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| `biber.js` | 959,313 | 218,137 |
| `biber.wasm` | 9,644,474 | 3,552,041 |
| `biber.data` | 18,261,749 | 10,219,791 |

Total: **27.53 MiB raw, 13.34 MiB gzipped**.

The complete pdfTeX WASM → Biber WASM → pdfTeX WASM → PDF workflow passed in Chromium 151.0.7922.137, using this repository's built pdfTeX worker, format, package bundles, and Biber artifacts, served by a local HTTP server. Both engines ran in browser workers. No native TeX or Biber process participated.

The tracked `wasm-build/biber-fixture/` document uses biblatex's author-year style and name/year/title sorting, with four references containing Åström, Ecclésiastique, Sallustius and Žižek. The bundled biblatex identified itself as version 3.21, with BCF 3.11. After Biber and two further TeX passes, the PDF contained all four references and the final TeX log had no unresolved citation/reference or rerun-Biber warnings. The 5,564-byte `.bbl` was byte-identical across browser Biber, Node Biber, native Biber 2.22 and locally-installed Biber 2.21 beta. Browser and native inputs had identical `.bcf` bytes.

First browser run timings on this machine:

| Phase | Seconds |
| --- | ---: |
| First pdfTeX pass | 1.67 |
| Cold Biber initialization | 0.48 |
| Cold Biber execution | 1.09 |
| Warm Biber initialization, fresh instance in the same worker | 0.17 |
| Warm Biber execution | 0.50 |
| Second and third pdfTeX passes, combined | 0.60 |

Repeat with Node 22+, Chromium and `pdftotext` on PATH:

```sh
make biber-browser-check
# Optionally require equality with an independently produced native .bbl:
make biber-browser-check BIBER_CHECK_ARGS='--native-bbl /path/to/native/main.bbl'
```

`CHROMIUM` can select a different Chromium executable. The check writes the PDF, extracted text, BCF, BBL, logs, timings and Biber artifact hashes under `dist/biber-validation/browser/`. It uses a fresh browser profile on each run. To test the actual LibrePaper controller against a staged mirror:

```sh
node tools/biber-app-browser-check.mjs --app ../librepaper/web --mirror mirror
```

This checks bibliography output, reuse after a prose edit, nested document paths, and invalidation after a bibliography edit.

### Licensing

The vendored code retains TeXlyre's AGPL-3.0 license and copyright notice. It is excluded from this repository's MIT claim. Local wrappers and checks are MIT; the upstream scripts and patches are unchanged. The source snapshot includes runtime patches and `browser_prerun.js`. The artifact-specific inventory records the linked XS modules, Perl runtime, Biber, supporting libraries and packaged Perl modules. Their license texts ship under `biber-notices/`. The corresponding-source collector includes `BIBER-SOURCE.tar.gz`, containing the patched sources, runtime modules, compiler sources, link map and rebuild instructions.

### Remaining coverage and reproducibility work

- Lock OS packages, CPAN archive URLs and hashes, and emperl/sombok git commits. Upstream currently resolves downloads at build time and copies pure Perl dependencies from `/usr/share/perl5`.
- Expand the passing browser/native comparison beyond the Unicode author-year fixture to disambiguation, sourcemaps, cross-references, multiple bibliography sections. Nested project paths are covered by the application check.
- Expand download, memory and execution measurements across browsers.

To update the vendor snapshot, select a new upstream commit, copy the same paths without modification, regenerate `UPSTREAM.json`, and review the diff. Keep local integration changes outside the snapshot so upstream updates remain easy to inspect.

## LaTeXML

The LaTeXML browser engine converts a staged LaTeX project to HTML in a Web Worker. Its runtime payload is `latexml.worker.js`, `latexml.js`, `latexml.wasm`, the shared resolver and bundle helpers, the LaTeXML CSS sheets, and `latexml.build.json`. The worker inlines the CSS links emitted by LaTeXML, including document-class sheets, and rewrites project image URLs to data URLs so the returned HTML can be rendered in an isolated iframe.

The wrapper enables LaTeXML's Graphics postprocessor before HTML conversion. It resolves each digested `graphicx` node and computes `imagewidth` and `imageheight` from its TeX dimensions and the source image's intrinsic size. Thus `width=0.12\linewidth` is evaluated in the current TeX context, including macros and minipages; it is not reconstructed from source text or converted to a viewport percentage by JavaScript.

Sources live in `/work` and generated graphics in `/output` in the worker's virtual filesystem. The worker embeds the referenced output bytes without changing HTML dimensions. Both directories are cleared between snapshots. PNG/JPEG and SVG sizing uses the upstream processor's native copy-and-size path. Operations that require external image-converter executables remain subject to the browser runtime's limitations.

### Building

LaTeXML is built from the pinned `latexml-oxide` checkout in `wasm-build/latexml-source.ref`. Its native libxml2, libxslt, and kpathsea inputs are separate source components. A release therefore carries a `latexml.build.json` receipt naming the exact source commits, archive hashes, licenses, notices, Cargo lock graph (including `libmarpa-asf-sys` where linked), and artifact hashes. The TeX Live source receipt covers the TeX engines and kpathsea source; it is not a substitute for the LaTeXML source receipt. The shipped notices include the upstream CC0 text, the libxml2/libxslt Copyright/COPYING files, and libmarpa's MIT and LGPL COPYING files.

The receipt also records the embedded `plain.YYYY.dump.txt` and `latex.YYYY.dump.txt` files, their `texlive.YYYY.version` stamp, and each SHA-256. The current build image's host TeX Live produces the 2023 pair; the runtime chooses a matching on-disk year when one is supplied and otherwise falls back to the newest embedded pair. A mirror's TeX Live 2026 package tree does not relabel a 2023 LaTeXML snapshot; a build made with a 2026 host records and embeds the 2026 pair separately. The corresponding-source builder copies the receipt-verified snapshots from `dist/latexml-kernels` into `latexml-oxide/resources/dumps` in the source archive.

LaTeXML is compiled with the separately pinned Emscripten 6.0.9 image (`sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc`) and nightly Rust `2026-08-02`; the TeX engines continue to use Emscripten 3.1.46. After the WASM link, run `node tools/link-inventory.mjs --family latexml --dist wasm-build/dist --out receipts/LINK-INVENTORY.latexml.json`; it requires the actual `latexml.map` and records native inputs while keeping the Cargo graph conservative.

```sh
docker build -f wasm-build/Dockerfile.latexml -t librepaper-latexml-wasm .
docker run --rm -e LATEXML_DIST_DIR=/dist -v "$PWD/wasm-build/dist:/dist" librepaper-latexml-wasm
```

The protocol check uses a mocked Emscripten module and the real BundleMode and resolver helpers:

```sh
node wasm-build/latexml-worker.test.cjs
```

See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and the receipt in a staged release for the complete redistribution terms.
