# SPEC: The LaTeX experience, and how packages reach the browser

Status: accepted 2026-09-09; implementation status at the end. The seam and
the local tier restate and extend what LibrePaper's `docs/specs/wasmtex.md`
and `docs/specs/latex.md` already describe. Where the spec names a file that
exists, it says what changes in it; where it names one that does not, it says
so.

## Decision

LaTeX that runs on the author's machine, not ours. The browser compiles
anything that is TeX plus data. The paired local app runs anything that is a
program or a font the author installed. That one rule is the whole product
seam; users are never shown an engine list.

This spec has two parts. The first fixes the seam and the order of work on
each side. The second is the part that is new: packages are delivered to the
browser as bundles rather than one file per request, which removes both the
request cost and the hosting limit that a full TeX Live would otherwise hit.

## The seam

Two things live on a machine and nowhere else: installed programs and
installed fonts. Everything else in a LaTeX build is data, and data can be
served to a tab.

Browser side, because it is TeX plus data:

- Every engine, eventually including LuaTeX. An engine is a deterministic
  function of source and package files. Performance is a reason to *offer*
  local compilation, never a reason to force it.
- All of TeX Live's macros, and the fonts TeX Live ships.
- BibTeX, BibTeX8, makeindex, and Biber. Biber is a program, but to an author
  it is bibliography processing, and the VM makes it behave like data. Nobody
  should learn that Biber is Perl.

Local side, because it is a program or a font you installed:

- Shell escape: Pygments, gnuplot, Inkscape, Python, R, Sage.
- System fonts by name under XeTeX and LuaTeX. The browser serves TeX Live's
  OpenType set and stops there.
- Large or slow jobs, as a button the author presses, not a fallback that
  fires on its own.

Where shelling out is reasonable: on the owner's own machine, with the
owner's explicit choice, under confinement.

- Restricted shell escape only. Off by default. Enabled per project by the
  project owner, and only on the owner's paired app. A collaborator's app
  never runs shell escape for a document they do not own.
- The restricted allowlist, so `\write18` can reach `epstopdf` and `pygmentize`
  and not `rm`.
- Sandboxed to the job workspace with no network, as LibrePaper's
  `docs/specs/wasmtex.md` already requires. Refuse rather than degrade when
  the platform cannot confine.

## Browser tier, in build order

1. Serve the entire TeX Live macro tree, bundled as described below.
2. Type1 fonts and a generated `pdftex.map`, so font packages embed.
   `docs/texlive-snapshot-2026.md` describes the map problem: it is produced
   by `updmap-sys` into `texmf-var` and is in no release archive.
3. makeindex and BibTeX8. `wasm-build/Dockerfile.makeindex` and
   `Dockerfile.bibtex8` exist and have never been run. Each needs a link
   inventory before it can ship.
4. Precise failure messages. When the browser tier stops, name the missing
   package or the required program and print the one-line pairing
   instruction. The resolver evidence the worker already emits
   (`wasmtexResolverEvidence`) carries what is needed.
5. A published "what works in the browser" page, readable by people and by
   agents.
6. XeTeX with ICU data and TeX Live's OpenType fonts, rebuilt with SyncTeX.
   `Dockerfile.xetex` and `build-icu-data.sh` exist and have never been run.
7. Biber VM warmed in the background the moment a document loads biblatex.
8. LuaTeX once its timeout is diagnosed.

## Local tier

Pairing, tool discovery and native compilation exist in LibrePaper under
`crates/librepaper/src/local/`. Before the local route is advertised:

- Platform confinement, tested with host-file access and process-execution
  probes, on every supported desktop.
- The shell-escape policy above.
- `librepaper local doctor` output an agent can act on, including which TeX
  distribution to install and how. The app discovers tools; it does not
  install them.
- Stored renderings. A native build publishes its PDF and log to the project,
  so a collaborator without a paired app sees the same output the owner does
  instead of a browser failure. The two authors' editing experiences still
  differ; their view of the document does not.

## Package delivery: bundles, not files

### The problem

The worker inherited WasmTex's delivery model: kpathsea asks for a
(format, name) pair, `tryFetch` in `wasm-build/pdftex-worker.js` issues one
synchronous `XMLHttpRequest` to `<endpoint>/pdftex/<format>/<name>`, and a
bloom filter suppresses requests for names the mirror does not have. Every
`.sty`, `.cls`, `.fd`, `.tfm`, `.vf`, `.enc`, `.pfb` and `.map` is its own
round trip.

Measured against the corpus, a cold compile of a plain article touches about
50 files; a TikZ or beamer document about 400. Two consequences:

- Requests are what Cloudflare meters. Workers Free allows 100,000 per day;
  the paid plan includes 10 million per month. A few hundred daily users with
  cold caches approach that.
- The full macro tree is 32,614 files in `texmf-dist/tex` alone, and Workers
  static assets cap a deployment at 20,000 files. Per-file delivery cannot be
  hosted as static assets at all, and moving to R2 trades the file limit for
  a metered read count.

Bundling fixes both. Requests drop by an order of magnitude, the file count
falls under the static-asset cap, and static-asset requests are not counted
against the Workers quota under Cloudflare's terms as of this writing. No R2,
no request ceiling, no bill. If the terms change, the fallback origin below
is the answer, not R2.

### The unit

A bundle is one texmf package directory. The inputs are the two vendored
trees the format build already takes, `texmf-dist` from the signed archive
and the `texmf-var` generated beside it, and nothing else: `tlpkg/texlive.tlpdb`
is not in the texmf archive and this spec does not want a second verified
download for grouping.

- For macros: `tex/<format>/<pkg>/` is one bundle, e.g. `tex/latex/amsmath/`,
  `tex/generic/pgf/`. `<format>` is `latex`, `generic`, `plain`, `xelatex`,
  `lualatex`, `latex-dev`, and so on, as the tree has them.
- For fonts: the union of `fonts/<kind>/<foundry>/<name>/` across every
  `<kind>` (`tfm`, `vf`, `type1`, `afm`, `enc`, `map`, `opentype`,
  `truetype`) is one bundle named `fonts/<foundry>/<name>`. A font package's
  metrics and glyphs arrive together, which is what every font request
  actually needs.
- `bibtex/bst/<pkg>/`, `bibtex/bib/<pkg>/`, `makeindex/<pkg>/`,
  `tex/latex/base/`, and `web2c/` follow the macro rule.
- Any bundle over 20 MiB of tar bytes is split into numbered parts by file order; the
  index records the part. Almost none reach this; `pgf` and the largest font
  families are the candidates.
- `texmf-var/fonts/map/` is the one directory taken from the second tree; its
  files join the `core` bundle. Nothing else in `texmf-var` is bundled.
- `doc/` and `source/` are never bundled. That removes 4.6 GB and most of
  the remainder that is not needed at compile time.

### The core bundle

One bundle, `core`, pre-merges what nearly every pdfLaTeX document loads
before the first line of its preamble: `tex/latex/base`, `tex/latex/l3kernel`,
`tex/latex/l3backend`, `tex/latex/l3packages`, `tex/latex/amsmath`,
`tex/latex/amsfonts`, `tex/latex/graphics`, `tex/latex/graphics-cfg`,
`tex/latex/graphics-def`, `tex/latex/hyperref`, `tex/latex/geometry`,
`tex/latex/tools`, `tex/latex/babel`, `tex/generic/babel`,
`tex/latex/kvoptions`, `tex/generic/iftex`, `tex/generic/infwarerr`,
`tex/generic/ltxcmds`, `tex/generic/kvsetkeys`, `tex/generic/pdftexcmds`,
`tex/latex/auxhook`, `tex/latex/rerunfilecheck`, `tex/latex/url`, the
Computer Modern and AMS font bundles, `pdftex.map`, and the encoding files
those fonts reference.

The list is a starting point. The right list is whatever the corpus in
LibrePaper's `latex/corpus/` touches on its first pass through the kernel;
`wasmtex-record.mjs` already measures that. Target: under 20 MB compressed.
Files in `core` are not repeated in their own package bundles; the index
points to `core`.

Most papers then make one to three requests on a cold cache, and none on a
warm one.

### The index

`bundles.json`, served with the release:

    {
      "snapshot": "texlive-20260301",
      "bundles": {
        "core":            { "url": "b/<sha256>/core.tar",        "size": 19234567, "sha256": "<sha256>" },
        "tex/latex/tikz":  { "url": "b/<sha256>/tex-latex-tikz.tar", ... },
        "fonts/public/lm": { "url": "b/<sha256>/fonts-public-lm.tar", ... }
      },
      "files": {
        "tex/latex/amsmath/amsmath.sty": "core",
        "tex/generic/pgf/basiclayer/pgfcorequick.code.tex": "tex/generic/pgf",
        "fonts/tfm/public/lm/rm-lmr10.tfm": "fonts/public/lm"
      }
    }

`files` maps every texmf-relative path to its bundle. A bundle is an
uncompressed tar of those paths; the HTTP layer compresses it. Tar rather than
a custom format because the reader is thirty lines and every tool on earth can
inspect it.

Digests are over the bundle bytes; the bundle URL carries the digest, as the
engine release directory already does in LibrePaper's `latex/tools/mirror.mjs`,
so `Cache-Control: public, max-age=31536000, immutable` is correct and the
edge cache absorbs every repeat.

The index is the one file fetched by a name without a digest. It is small,
`no-cache`, and its own digest is in the release `MANIFEST.json`.

The index doubles as the existence check. With it loaded, the bloom filter is
redundant and is retired. The extension-candidate logic in `fetchCandidates`,
which tries the stripped and appended forms of a name in kpathsea's order,
stays; it consults the index instead of the filter.

### The resolver

`kpse_find_file_impl` in the worker changes in one place. Where it now builds
a per-file URL and calls `tryFetch`, it instead:

1. Resolves the (format, name) request to a texmf path. At load the worker
   inverts `files` once into a name-to-paths map; a name with several paths
   (`latex.ltx` in both `base` and `latex-dev/base`, `hyphen.cfg` in three
   packages) is ranked by the same `FORMAT_SEARCH_ORDER` `tools/build-format.mjs`
   uses for the format build. The ranking moves from the harness into
   `kpse-resolve.cjs`, so the format and the runtime resolve identically. Two
   copies of that ordering would drift.
2. Looks the path up in `files`. Absent means absent: record it in
   `texlive404_cache` and return 0, no request.
3. If the bundle is not yet loaded, fetches it (one synchronous XHR, as now),
   verifies its digest against the index, and unpacks every member into the
   virtual filesystem under `/texmf/`. Members are written once; later
   requests for siblings hit `texlive200_cache`.
4. Returns the path.

The XHR stays synchronous because kpathsea is synchronous and the engine is
not re-entrant; that constraint is unchanged. What changes is how often it
fires.

The worker's `downloading` message gains the bundle name and size, so the
host's progress indicator reports "amsmath, 1.2 MB" instead of a stream of
file names.

### Browser cache

A verified bundle is stored in Cache Storage keyed by its digested URL before
it is unpacked. On the next session the worker checks the cache before the
network. Editing sessions then make no requests; the count is driven only by
new users and new packages. LibrePaper's spec already asks for offline
readiness scoped to what a project has used; this is the mechanism.

The engine `.wasm`, format `.fmt` and `core` are fetched at page load and
cached the same way.

### Hosting

Bundles are Workers static assets under `deploy/latex/`, beside the engines.
Estimated shape, from the vendored tree without `doc/` and `source/`:

| Content | Bundles | Size on disk |
|---|---|---|
| Macro tree | about 4,000 | 694 MB |
| Type1, tfm, vf, afm, enc, map | about 1,500 | about 1.8 GB |
| OpenType and TrueType, for XeTeX | about 300 | about 1 GB |

Under the 20,000-file cap with room. Egress is free. Requests to static assets
are not metered. There is nothing to pay for at LibrePaper's scale.

Bundles are built by a new `tools/build-bundles.mjs` in this repository from
the same verified `vendor/` tree the format is built from, with a receipt
listing every input path, size and sha256 per bundle, in the style of
`receipts/FORMAT-RECEIPT.pdftex-2026.json`. Building is deterministic: tar
entries in sorted path order, mtime fixed at `SOURCE_DATE_EPOCH`, uid and gid
zero. The same tree yields the same bytes, so the receipt means something.

`tools/stage-release.mjs` includes `bundles.json` and the bundle directory in
the staged payload and `MANIFEST.json`; `check-release.mjs` verifies every
bundle's digest against the index and the index against the manifest.
LibrePaper's importer then verifies the same thing on the other side, as it
does for engines today.

### A fallback origin

If the primary is ever unreachable or metered, the same bundles can be
published as GitHub Release assets: permissive CORS, 2 GB per file, no
bandwidth charge. Because the worker verifies every bundle against an index
served from LibrePaper's own origin, the bundle host does not need to be
trusted. This is a documented option, not part of the first release.

Pointing at CTAN or TeX Live's `tlnet` mirrors directly is not an option:
they send no CORS headers, they serve packages as archives in a different
layout, and they are volunteer mirrors, not an application CDN.

### Numbers to hold the design to

| Document | Per-file requests today | Bundled, cold | Bundled, warm |
|---|---|---|---|
| Plain article | about 50 | 1 to 3 | 0 |
| TikZ or beamer | about 400 | about 20 | 0 |

If a cold plain article needs more than three requests after `core`, the core
list is wrong. If a warm compile of any corpus document makes a request, the
cache is wrong.

## Engine repository obligations that gate all of this

- Run the five unbuilt engines and produce their link inventories.
- Publish the corresponding-source archive and name its URL; until then
  `check-release.mjs` refuses the release, correctly.
- Verify a clean rebuild from that archive reproduces the distributed bytes.
- Vendor the TeX Live source tarball instead of cloning GitHub in the
  Dockerfiles.

## Acceptance

- Every document in `latex/corpus/` compiles in the browser from the bundled
  mirror, with the request counts above, on Chromium, Firefox and Safari.
- A document naming a package that exists in TeX Live but was never in the
  corpus compiles without anyone having pre-recorded it.
- A document naming a package that does not exist fails with a message that
  names the package, in under a second, with no request.
- A biblatex document gets its bibliography from the VM without the user
  pairing anything.
- A minted document stops with a message that names Pygments and shows the
  pairing instruction.
- `node tools/build-bundles.mjs` run twice yields identical bytes and an
  identical receipt.
- `tools/build-format.mjs --bundles` resolves exactly the input set the
  per-file build resolved, hash for hash, and its smoke compile makes no
  per-file request. The two formats' bytes differ: TeX records the path it
  opened a few hyphenation loaders under, and bundle mode nests those under
  `/texmf/`. The input set, not byte identity, is the check.

## Decided since

- `latex-dev` is not bundled by default; `--include-latex-dev` re-enables it.
- The `core` list is now measured, not guessed (`DEFAULT_CORE` in
  `tools/bundle-rules.mjs`, measured 2026-09-09 against four representative
  documents resolved through `tools/build-format.mjs --smoke-doc
  --smoke-evidence`): 18.3 MB in one part, 2,185 files. The measurement found
  two files that dragged whole packages in, `supp-pdf.mkii` (47 MB of
  ConTeXt, loaded by `pdftex.def` at `\begin{document}`) and `pdftex.map`
  (beside two 5.5 MB variants nothing reads); `FILE_BUNDLE_OVERRIDES` in
  `tools/bundle-rules.mjs` names them, the first into core and the second as
  a 5.5 MB bundle of its own. `fonts/public/amsfonts` (4.6 MB) stays separate,
  so a cold plain article makes about five requests after core, against the
  "1 to 3" below; the bytes are what dropped, from roughly 80 MB to 11 MB.
- OpenType and TrueType fonts are bundled now, by the same rule as Type 1.
- Also excluded, because no browser engine reads them: Metafont sources, PK
  bitmaps, AFM metrics, Type 3 fonts, non-Lua scripts, and the trees of tools
  that are not shipped (tex4ht, MetaPost, dvips, xindy, Asymptote and others).
  3.49 GB remain.

## Not decided here

- The source archive's published location.

## Implementation status, updated 2026-09-09 evening

Done in this repository:

- `tools/bundle-rules.mjs`, `tools/build-bundles.mjs`, their test, and the
  2026 build: 5,479 bundles, 159,000 files, receipt in
  `receipts/BUNDLE-RECEIPT.texlive-2026.json`.
- `wasm-build/kpse-resolve.cjs` holds the one search order, the name index,
  ranking, a synchronous SHA-256 and a tar reader; `wasm-build/bundle-mode.js`
  holds bundle mode once, and every worker (pdfTeX, XeTeX, LuaTeX, dvipdfm,
  BibTeX, BibTeX8, makeindex) imports it, answers `loadbundleindex` and
  `preloadbundle`, and consults the index before any network. The Cache
  Storage preload takes an optional list of bundle names and reports what it
  skipped; a cached tar whose digest no longer matches is deleted. Legacy
  per-file mode is unchanged.
- `tools/build-format.mjs --bundles --expect-inputs`: the bundle-built format
  resolves the same 238 inputs as the per-file build, with zero per-file
  requests in the smoke compile.
- `tools/stage-release.mjs --bundles` and the gate's section 7, tested at
  full scale.
- makeindex and BibTeX8 built, link-inventoried, and smoke-tested against
  the native tools' output. A missing placeholder file made makeindex exit
  before reading its input; fixed in `makeindex-worker.js`.
- XeTeX built from source with the fontconfig shim, plus dvipdfm and the
  ICU data file, all link-inventoried. `tools/build-format.mjs --engine xetex`
  dumps its format (receipt in `receipts/FORMAT-RECEIPT.xetex-2026.json`)
  and smokes a fontspec document by font name and by file name through
  dvipdfm to a PDF with Latin Modern embedded. SyncTeX is passed and returned.
  Both workers lacked `.tfm` in their extension table, which failed every
  document on the preloaded Computer Modern metrics; fixed.
- A root `Makefile` names each release step and `tools/release.sh` publishes
  the corresponding-source archive to a GitHub Release and annotates it with
  the staged manifest hash.
- `docs/bundles.md` and `docs/what-works-in-the-browser.md`.
- OpenType font lookup by name, as far as this repository ships it:
  `tools/xetex-fontlist.mjs` (extracted from `tools/build-format.mjs`, which
  now imports it) builds `xetexfontlist.txt` with `otfinfo`, and
  `tools/build-bundles.mjs --extra` adds it to the bundle set as
  `tex/xetex/fontlist`, so a browser resolver answering format-26 requests
  from the bundle index can serve it like any other file. The XeTeX worker
  reading it, and LibrePaper handing XeTeX its ICU data, remain below.

Done in LibrePaper:

- The importer records `bundles` on the release, `check-mirror.mjs` verifies
  every bundle, the dev server and the Cloudflare headers treat the index as
  `no-cache`, the controller loads the index for pdfTeX and skips the
  per-file warmups, progress shows the bundle name and size, and a failed
  compile whose resolver evidence names an absent package says so with the
  pairing instruction.

Not done:

- OpenType font lookup by name in the browser: `xetexfontlist.txt` ships in a
  bundle now (`tex/xetex/fontlist`, see above), but the XeTeX worker does not
  yet read it, LibrePaper still sends the bundle index to pdfTeX only, and it
  does not hand XeTeX its ICU data through `loadicudata`.
- LuaTeX's timeout; its engine is still unbuilt.
- The local tier: platform confinement, the shell-escape policy, stored
  renderings, and doctor output for agents. All of it is Rust in LibrePaper
  and none of it was touched.
- Biber VM warm-up on biblatex load.
- Preloading `core` at page load through `preloadbundle`, and passing the
  `preload` list from what a project used last time; the controller sends
  only the bare index today.
- Publishing the corresponding source and importing a release into
  LibrePaper's shipped mirror.
