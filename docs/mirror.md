# The mirror LibrePaper serves

This is the contract LibrePaper's `latex/tools/check-mirror.mjs` and
`web/src/lib/latex/worker.js` (`configure()`) consume. It used to live as
section 1 of LibrePaper's `docs/specs/latex-interfaces.md`, back when
LibrePaper's own importer built the mirror from a staged wasm-latex release
and fetched a TeX Live package snapshot from a third party. Both of those
moved here: this repository now builds and
deploys the whole mirror (`make mirror`, `make push`; see
[`docs/release.md`](release.md)), and LibrePaper keeps only a URL and this
consumer-side contract. There is no legacy per-file TeX Live snapshot in
what this repository ships, and no bloom filter -- every release here ships
package bundles only (SPEC-latex.md, "Package delivery: bundles, not
files").

## Layout

```
mirror/
  manifest.json
  engines/<engineRelease>/                 engine files from a staged release
    pdftex.worker.js pdftex.js pdftex.wasm
    pdftex.fmt pdftex-resolver-evidence.js ...
    kpse-resolve.js bundle-mode.js   -- imported by every worker
    bibtex.* bibtex8.* makeindex.* biber.* biber-notices/
    xetex.* xetex.fmt.gz icudt68l.dat.gz dvipdfm.*
    latexml.worker.js latexml.js latexml.wasm latexml.css LaTeXML.css
    LaTeXML-blue.css LaTeXML-marginpar.css LaTeXML-navbar-left.css LaTeXML-navbar-right.css
    ltx-amsart.css ltx-apj.css ltx-article.css ltx-book.css ltx-listings.css
    ltx-report.css ltx-svjour.css ltx-ulem.css kpse-resolve.js bundle-mode.js
    LICENSE THIRD_PARTY_NOTICES.md SOURCE.md SOURCE-RECEIPT.json RELINK.md
    LICENSES/  LINK-INVENTORY.*.json  FORMAT-RECEIPT.*.json  BUNDLE-RECEIPT.*.json
  engines/<engineRelease>/bundles/bundles.json     package index
  engines/<engineRelease>/bundles/b/<sha256>/<slug>.tar   one tar per package directory
  engines/<engineRelease>/<name>.br                brotli sidecar; see "Serving"
```

`<engineRelease>` is the bare `<sha256 of the staged MANIFEST.json>`.
Directories are immutable; a new digest is a new directory, and every
release this repository has ever imported stays in `manifest.releases` --
only `default_release` moves. Biber WASM travels with the engine release.
The separate `--biber-vm` server setting is only a legacy fallback for mirrors
that do not advertise `engines.biber`.

## Manifest, format 1

```json
{
  "format": 1,
  "version": 1,
  "default_release": "<sha256>",
  "releases": {
    "<sha256>": {
      "id": "<sha256>",
      "digest": "<sha256 hex of the canonical JSON of this entry without `digest`>",
      "engine_release": "<sha256>",
      "base": "engines/<sha256>/",
      "engines": {
        "pdftex":  { "worker": "pdftex.worker.js", "format": "pdftex.fmt", "files": ["pdftex.worker.js", "pdftex.js", "pdftex.wasm", "pdftex-resolver-evidence.js", "kpse-resolve.js", "bundle-mode.js", "pdftex.fmt"] },
        "xetex":   { "worker": "xetex.worker.js",  "format": "xetex.fmt.gz", "icu": "icudt68l.dat.gz", "files": [...] },
        "dvipdfm": { "worker": "dvipdfm.worker.js", "files": [...] },
        "bibtex":  { "worker": "bibtex.worker.js", "files": [...] },
        "bibtex8": { "worker": "bibtex8.worker.js", "files": [...] },
        "biber": { "worker": "biber.worker.js", "files": ["biber.worker.js", "biber.js", "biber.wasm", "biber.data", "biber.build.json"] },
        "makeindex": { "worker": "makeindex.worker.js", "files": [...] },
        "latexml": { "worker": "latexml.worker.js", "files": ["latexml.worker.js", "latexml.js", "latexml.wasm", "latexml.css", "LaTeXML.css", "LaTeXML-blue.css", "LaTeXML-marginpar.css", "LaTeXML-navbar-left.css", "LaTeXML-navbar-right.css", "ltx-amsart.css", "ltx-apj.css", "ltx-article.css", "ltx-book.css", "ltx-listings.css", "ltx-report.css", "ltx-svjour.css", "ltx-ulem.css", "kpse-resolve.js", "bundle-mode.js", "latexml.build.json"] }
      },
      "files": { "<name>": { "url": "engines/<sha256>/<name>", "sha256": "...", "size": 123 } },
      "bibliography": {
        "bibtex": "0.99e",
        "biblatex": "3.22",
        "control_file": "3.11",
        "biber": { "version": "2.22", "compatible": ["2.22"], "incompatible_hint": "..." }
      },
      "bundles": { "index": "engines/<sha256>/bundles/bundles.json", "sha256": "...", "snapshot": "texlive-20260301-texmf", "count": 5501, "bytes": 3492000000 },
      "vm": null,
      "source": {
        "corresponding_source": { "url": "https://...", "sha256": "..." },
        "manifest": { "url": "engines/<sha256>/MANIFEST.json", "sha256": "...", "size": 0 },
        "build_receipts": ["FORMAT-RECEIPT.pdftex-2026.json", "..."],
        "reproduced": false
      },
      "licences": { "pdftex": "GPL-2.0-only", "xetex": "GPL-2.0-only AND LicenseRef-XeTeX", "...": "...", "notices": "engines/<sha256>/" },
      "sizes": { "pdftex": 5807474, "xetex": 0, "...": 0 }
    }
  }
}
```

`luatex` is absent from `engines` on every release this repository ships:
its engine is unbuilt (SPEC-latex.md, "Implementation status"), so its file
set is never complete, and an engine whose file set is not complete is not
advertised (see `readRelease` in `tools/build-mirror.mjs`). LibrePaper's
`web/src/lib/latex/worker.js` treats a missing `engines.luatex` as "this
release has no LuaTeX", which is correct: `ensureEngine("luatex")` throws
before it ever needs `release.texlive_base` (also absent, on purpose --
there is no legacy per-file snapshot).

`engines`, `files`, `bibliography`, `bundles`, `vm` and `source` are read
directly by `configure()` in LibrePaper's `web/src/lib/latex/worker.js`;
`default_release` and `releases` are read by the same file and by
`check-mirror.mjs`. No other top-level or per-release field is consumed by
anything on LibrePaper's side; extra fields (`digest`, `licences`, `sizes`)
are provenance, not protocol.

`bibliography.control_file`/`biblatex` are read out of the release's own
bundled `tex/latex/biblatex/biblatex.sty` (`\blx@bcfversion`,
`\ProvidesPackage` version and date), found via `bundles.json`'s own `files`
map and unpacked with the tar reader in `wasm-build/kpse-resolve.cjs`
(`readTar`) -- the same reader the browser resolver uses. This needs no
network: the former importer's old CDN fetch of `biblatex.sty` at import time is gone,
because the file is already part of the staged release's `core` bundle.

`vm` is always `null`. The field survives from the time the Biber VM was
registered into the mirror; older releases can find their VM through the
`--biber-vm <url>#<sha256>` flag and ignores this field. It will be dropped
in format 2.

## Serving

The browser fetches everything from `<base>/latex/` on its own origin (or
directly from the deployed Cloudflare Worker):

| Request | Answer |
| --- | --- |
| `engines/<engineRelease>/bundles/bundles.json` | `Cache-Control: no-cache`; the one bundle file named without a digest. |
| `engines/<engineRelease>/<file>` | Static, `Cache-Control: public, max-age=31536000, immutable`. |
| `manifest.json` | `Cache-Control: no-store`. |

`make push`'s `mirror/_headers` (`Makefile`) implements exactly this table.

### Retention and platform limits

The mirror contains published build releases and their receipts only. It does
not accept, retain, or log user documents, compiler inputs, compiler outputs,
or request bodies. A release build is published as immutable static assets;
the deployment keeps only releases referenced by the current manifest.
No release beyond the one referenced by the current LibrePaper build is
promised to remain available.

As verified on September 11, 2026, Cloudflare's Workers limits allow 20,000 files on the Free plan and
100,000 on paid plans, with a 25 MiB maximum individual asset. Static asset
requests are free and unlimited. See the official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Static Assets billing and limitations](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
pages when sizing a release.

### Brotli

Every engine file over 4 KiB that brotli can shrink below 90% of its size
has a `<name>.br` beside it, compressed once at `make mirror` time at
quality 11. `tools/mirror-worker.js` serves that sidecar in place of the
file, with `Content-Encoding: br` and the headers the table above assigns
the file itself. Bundle tars are excluded -- there are 11k of them and 7 GB,
and the edge's own compression is what they get.

This is worth doing because Cloudflare compresses on the fly at a much lower
brotli quality than is worth paying for once, at release time, on a file
every cold start has to fetch. Measured on `latexml.wasm`, the largest:

| | bytes |
| --- | --- |
| identity | 21.69 MB |
| gzip (edge) | 6.11 MB |
| brotli (edge, on the fly) | 5.81 MB |
| **brotli quality 11 (sidecar)** | **4.21 MB** |

Two things about this are worth knowing before changing it:

* **The Worker cannot negotiate.** Cloudflare rewrites the request's
  `Accept-Encoding` to a constant `"br, gzip"` before the Worker sees it,
  whatever the client sent -- so the Worker returns the encoded
  representation unconditionally and the edge transcodes per client. Do not
  add an `Accept-Encoding` check to `tools/mirror-worker.js`; it would read
  the same on every request.
* **`run_worker_first` is load-bearing.** Static assets are served before
  the Worker runs, and every path here *is* a static asset, so without
  `assets.run_worker_first` in `wrangler.jsonc` the sidecars are never
  consulted and the Worker is dead code. It is scoped to `/engines/*`.

A sidecar is not named in `manifest.json`: it is a second representation of
a file the manifest already pins, not a payload file. `check-mirror.mjs`
decompresses every one and compares it against the file it sits beside,
which is what keeps an unpinned sidecar from ever disagreeing with a
published digest.

## Building it

`tools/build-mirror.mjs` builds this from a staged release
(`tools/stage-release.mjs`'s output) and the reviewed SHA-256 of its
`MANIFEST.json`:

    node tools/build-mirror.mjs --staged staged --sha256 <manifest digest> --out mirror

It verifies every payload file against the staged manifest before writing
anything (the same check `tools/check-release.mjs` already ran once at stage
time, re-run here because the mirror is a separate trust boundary: nothing
stops staged/ from being edited between staging and importing). It is
idempotent -- a file already on disk with the right digest is left alone --
and it keeps every release already in `--out`'s `manifest.json`, only moving
`default_release` to the one just built, exactly as LibrePaper's importer
used to.

`tools/check-mirror.mjs` verifies the result, or a deployed URL:

    node tools/check-mirror.mjs mirror
    node tools/check-mirror.mjs https://latex.librepaper.workers.dev/

A directory argument gets the full check: the manifest parses, the default
release has a complete pdfTeX engine, every engine file is on disk with a
matching digest and size, `bundles.json`'s own digest matches the release
entry, every bundle tar it names is on disk with a matching digest, and
every `.br` sidecar decompresses to exactly the file it sits beside. A
URL argument gets a shape-only check (`manifest.json` fetched with
`no-store`): LibrePaper's own browser smoke test is what actually exercises
a deployed mirror's bytes, not a second full download here.
