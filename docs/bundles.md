# Package bundles

The browser engines do not fetch TeX Live one file at a time. `tools/build-bundles.mjs`
packs the verified texmf tree into one tar per package directory, indexed by
`bundles.json`, and the worker fetches a whole bundle the first time any file in it
is asked for. SPEC-latex.md ("Package delivery: bundles, not files") explains why:
requests are what Cloudflare meters, and the per-file tree could not be hosted as
static assets at all.

## Building

    node tools/build-bundles.mjs \
      --texmf vendor/texlive-2026/texlive-20260301-texmf/texmf-dist \
      --texmf vendor/texlive-2026/texmf-var \
      --out wasm-build/dist/bundles \
      --evidence receipts/BUNDLE-RECEIPT.texlive-2026.json

The first tree is the signed release archive. The second contributes only its
`fonts/map/` directory, the `pdftex.map` and friends that `updmap-sys` generates
and that no archive contains; for those paths the later tree wins over the copy
`texmf-dist` ships. Any other path present in both trees is an error.

`--epoch` (or `SOURCE_DATE_EPOCH`) fixes every tar member's mtime, entries are
written in sorted order with uid, gid and mode fixed, and a tar whose digested
path already exists is not rewritten. The same tree yields the same bytes; the
receipt records the index hash so a rebuild can be checked against it.

## What is in a bundle

The grouping rules are in `tools/bundle-rules.mjs` and have no input beyond the
tree:

- `tex/<format>/<package>/` is one bundle.
- A font family is one bundle across every kind that ships it: `fonts/tfm`,
  `vf`, `type1`, `enc`, `map`, `opentype`, `truetype` under the same
  `<foundry>/<name>` fold into `fonts/<foundry>/<name>`, so metrics and glyphs
  arrive together.
- `bibtex/bst/<package>`, `bibtex/bib/<package>`, `makeindex/<package>`,
  `web2c`, and `scripts/<package>` for Lua files only.
- `core` merges the kernel and what nearly every pdfLaTeX document loads before
  its preamble: `tex/latex/base`, l3kernel, l3backend, amsmath, graphics,
  hyperref, geometry, babel, the small generic helpers, and the Computer Modern
  fonts. The list is `DEFAULT_CORE` in the rules module, measured (not guessed)
  from four representative documents resolving through the format build and
  the per-file harness - see the comment above `DEFAULT_CORE` for the method
  and what got cut for size. The measurement also found two files that
  dragged whole packages in: `supp-pdf.mkii`, which `pdftex.def` loads at
  `\begin{document}` and which sat in 47 MB of ConTeXt, and `pdftex.map`,
  which sat beside two 5.5 MB variants nothing reads. `FILE_BUNDLE_OVERRIDES`
  in the rules module names those files: the `supp-*.mkii` set is its own
  half-megabyte bundle and part of core, and `pdftex.map` is its own 5.5 MB
  bundle. `fonts/public/amsfonts` (4.6 MB, for `amssymb`) stays separate. A
  plain article fetches core, the map, amsfonts, then its own packages.
- A bundle over 20 MiB of tar bytes, headers and padding included, is split
  into `<name>.part1`, `<name>.part2`, ... so that every file stays well under
  the 25 MiB static-asset limit. The resolver sees parts as ordinary bundles.
  XeTeX's ICU data, 27 MiB raw, is shipped gzipped at 11 MiB for the same
  reason; the host inflates it before `loadicudata`.

Never bundled, because no browser engine can read them: `doc/`, `source/`,
Metafont sources and PK bitmaps under `fonts/`, AFM metrics, Type 3 fonts, the
non-Lua scripts, and the trees belonging to tools that are not shipped
(tex4ht, MetaPost, dvips, xindy, Asymptote and the rest). `tex/latex-dev` is
excluded by default (`--include-latex-dev` re-enables it): the format build
already has to rank it below `tex/latex`, and serving it invites the same
mistake at runtime.

## The 2026 build

| | |
|---|---|
| Bundles | 5,479 (73 of them split parts) |
| Files | 159,000 |
| Bytes | 3.49 GB, of which fonts 2.77 GB and macros 645 MB |
| `core` | 18.3 MB in one part, 2,185 files (measured 2026-09-09; was 32 MB in two parts under the spec's guessed list) |
| Index | `bundles.json`, 159,000 file entries |

## The index

    {
      "schemaVersion": 1,
      "snapshot": "texlive-20260301-texmf",
      "sourceDateEpoch": 1772323200,
      "bundles": { "tex/latex/tikz": { "url": "b/<sha256>/tex-latex-tikz.tar", "size": 1234, "sha256": "<sha256>", "files": 12 } },
      "files":   { "tex/latex/tikz/tikz.sty": "tex/latex/tikz" }
    }

`files` maps every texmf-relative path to its bundle, and doubles as the
existence check: a name not in it is absent, with no request. Bundle URLs are
relative to the texlive endpoint and carry the tar's own digest, so they are
served with `Cache-Control: immutable` and the edge cache absorbs repeats. The
index is the one file fetched by a name without a digest; its hash is in the
release `MANIFEST.json`.

`RECEIPT-FILES.json.gz` beside the index lists every member of every bundle with
its size and sha256. It ships with the bundles. The committed
`receipts/BUNDLE-RECEIPT.*.json` is the summary: inputs, epoch, exclusions,
core list, the index hash, and one line per bundle.

## How the worker uses it

`wasm-build/pdftex-worker.js` accepts `loadbundleindex` with the index text.
From then on `kpse_find_file_impl` never issues a per-file request. A
(format, name) pair is resolved by the same `FORMAT_SEARCH_ORDER` ranking the
format build uses, now shared from `wasm-build/kpse-resolve.cjs`; the path's
bundle is fetched once by synchronous XHR, its sha256 is checked in pure JS
(the kpathsea callback is synchronous, so `crypto.subtle` cannot be used),
its members are unpacked under `/texmf/` in the virtual filesystem, and later
requests for siblings are answered from there. Where the Cache Storage API is
available, fetched bundles are written to the `wasmtex-bundles` cache and
preloaded from it on the next `loadbundleindex`, so a warm session makes no
network requests.

Without `loadbundleindex` the worker behaves as before, one file per request,
which the format harness and the previous LibrePaper mirror still use.

## Format build through bundles

`tools/build-format.mjs --bundles wasm-build/dist/bundles` serves the index
and the tars to the worker instead of individual files, and
`--expect-inputs receipts/FORMAT-RECEIPT.pdftex-2026.json` asserts that it
resolved exactly the files the per-file build did, hash for hash, with no
per-file request during the smoke compile. The two `.fmt` files are not
byte-identical: TeX records the path it opened a few hyphenation loaders
under, and bundle mode nests those under `/texmf/`. Both typeset the same.
The committed format stays the per-file build, whose hash
`docs/texlive-snapshot-2026.md` pins.

## Release

`tools/stage-release.mjs --bundles wasm-build/dist/bundles` copies the index,
the file receipt and the tars into `staged/bundles/`, records `bundles` in the
manifest, and `tools/check-release.mjs` verifies every tar against the index,
the index against the manifest, and refuses a tar the index does not name.
