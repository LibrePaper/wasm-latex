# SPEC: The LaTeX experience, and how packages reach the browser

Status: accepted 2026-09-09; what is built and what is next are at the end. The seam and
the local tier restate and extend what LibrePaper's `docs/specs/latex-compiler.md`
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
  `docs/specs/latex-compiler.md` already requires. Refuse rather than degrade when
  the platform cannot confine.

## Browser tier

What the browser compiles with, and the order it was built in:

1. The entire TeX Live macro tree, bundled as described below.
2. Type 1 fonts and the generated `pdftex.map`, so font packages embed.
   `docs/texlive-snapshot-2026.md` describes the map: `updmap` writes it
   into `texmf-var`, and no release archive contains it.
3. makeindex and BibTeX8, each with a link inventory.
4. Precise failure messages: when the browser tier stops, the message names
   the missing package or the required program and prints the pairing
   instruction, from the resolver evidence the worker emits.
5. `docs/what-works-in-the-browser.md`, readable by people and by agents.
6. XeTeX with ICU data, TeX Live's OpenType fonts found by name through a
   generated font list, and SyncTeX, producing PDFs through dvipdfm.
7. Biber VM warmed in the background the moment a document loads biblatex.
   Not done.
8. LuaTeX once its timeout is diagnosed. Not done.

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
- Never bundled, because no browser engine reads them: `doc/`, `source/`,
  Metafont sources and PK bitmaps, AFM metrics, Type 3 fonts, non-Lua
  scripts, and the trees of tools that are not shipped (tex4ht, MetaPost,
  dvips, xindy, Asymptote and others). `tex/latex-dev` is excluded by
  default (`--include-latex-dev` re-enables it): the format build already
  has to rank it below `tex/latex`, and serving it invites the same mistake
  at runtime. 3.49 GB remain.
- A file that would drag a whole package in for one member is named in
  `FILE_BUNDLE_OVERRIDES`: `supp-pdf.mkii`, which `pdftex.def` loads at
  `\begin{document}` and which sat in 47 MB of ConTeXt, goes into core;
  `pdftex.map`, which sat beside two variants nothing reads, is a 5.5 MB
  bundle of its own.

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

The list is measured, not guessed: the format's own inputs plus what two
ordinary papers load, resolved through `tools/build-format.mjs --smoke-doc
--smoke-evidence` on 2026-09-09. It comes to 18.3 MB in one part, 2,185
files; `DEFAULT_CORE` in `tools/bundle-rules.mjs` is the list.
`fonts/public/amsfonts` (4.6 MB, for `amssymb`) stays separate.
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

Bundles are Workers static assets in the mirror `make push` deploys, beside the engines.
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

The mirror LibrePaper serves is built and deployed from this repository, not
from LibrePaper's. `tools/build-mirror.mjs` turns a staged release plus its
reviewed manifest hash into `mirror/`, in the layout and manifest shape
(format 1, bundled releases only, documented in `docs/mirror.md`)
LibrePaper's browser code already reads; `make mirror` builds and checks it,
`make push` deploys it as Cloudflare Workers static assets. LibrePaper keeps
only the URL and a consumer-side check (`latex/tools/check-mirror.mjs`) --
building, staging, and hosting the mirror are entirely this repository's
obligation now, matching what section "Engine repository obligations that
gate all of this" already asked for on the engine side.

### Numbers to hold the design to

| Document | Per-file requests today | Bundled, cold | Bundled, warm |
|---|---|---|---|
| Plain article | about 50 | about 5 | 0 |
| TikZ or beamer | about 400 | about 20 | 0 |

A cold plain article after `core` fetches amsfonts, the map, and cm-super's
one Type 1 file for OT1's TS1 symbols; more than that means the core list
is wrong. If a warm compile of any corpus document makes a request, the
cache is wrong.

## Engine repository obligations that gate all of this

- Every built engine has a link inventory. Done for six; LuaTeX is unbuilt.
- Publish the corresponding-source archive and name its URL. `make release`
  does it; not yet run. The gate checks only that the URL is HTTPS and
  hashed, so a placeholder passes it, which is how local tests are staged.
- Show that a clean rebuild from that archive reproduces the distributed
  bytes: a `make reproduce` that unpacks `dist-source/`, builds in Docker
  and compares every artefact to the staged manifest. Not done.
- Vendor the TeX Live source tarball instead of cloning GitHub in the
  Dockerfiles. Not done.

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

## Status, 2026-09-09

Everything above the "Not done" marks exists and is verified: the bundles,
the shared resolver in every worker, the release gate, six engines with
inventories, the mirror built and deployed from this repository
(`docs/release.md`), and LibrePaper's controller compiling the corpus,
XeLaTeX included, in headless Chromium against a mirror built here. The
README and the docs it lists describe what is built; this file describes
why.

## Next

1. Cut the release with `make release TAG=…`, then `make mirror` and
   `make push`. LibrePaper's app-level smoke test, which `latex-push`'s
   predecessor depended on, opens the published document read-only and never
   compiles; that access bug is LibrePaper's and blocks nothing here now,
   but it should be fixed before the mirror carries real traffic.
2. Typst fonts from the mirror: `make mirror` writes a `fonts/` set with an
   index in the shape LibrePaper's font library produces, from the same
   OpenType and TrueType files the bundles hold, and LibrePaper's `--fonts`
   defaults to it. Where typst packages come from is unexamined.
3. `make reproduce`, and the vendored TeX Live source tarball.
4. Preload `core` at page load and pass the per-project `preload` list;
   the controller sends only the bare index today.
5. Biber VM warm-up when a document loads biblatex.
6. LuaTeX.
7. The local tier: platform confinement, the owner-only restricted shell
   escape, stored renderings, doctor output an agent can act on. All Rust in
   LibrePaper; none of it started.
