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
  _headers                                 everything immutable, plus CORS
  <id>/                                    one release; <id> = sha256 of its MANIFEST.json
    MANIFEST.json                          byte copy of the staged manifest
    release.json                           the loader entry for this release
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
    bundles/bundles.json                   package index
    bundles/b/<sha256>/<slug>.tar          one tar per package directory
```

`<id>` is the bare `<sha256 of the staged MANIFEST.json>`. Nothing in the
mirror is mutable: there is no top-level manifest, no default release and no
file whose bytes change under a fixed name. A release is found by its id,
which LibrePaper's build pins; a new digest is a new directory. `make mirror`
holds exactly the one staged release and clears whatever an earlier build left
in the output directory. Biber WASM travels with the release. The separate
`--biber-vm` server setting is only a legacy fallback for mirrors that do not
advertise `engines.biber`.

## release.json, format 2

Every path in `release.json` is relative to the release directory
(`<mirror URL>/<id>/`). There is no `base`.

```json
{
  "format": 2,
  "id": "<sha256>",
  "engine_release": "<sha256>",
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
  "files": { "<name>": { "url": "<name>", "sha256": "...", "size": 123 } },
  "bibliography": {
    "bibtex": "0.99e",
    "biblatex": "3.22",
    "control_file": "3.11",
    "biber": { "version": "2.22", "compatible": ["2.22"], "incompatible_hint": "..." }
  },
  "bundles": { "index": "bundles/bundles.json", "sha256": "...", "snapshot": "texlive-20260301-texmf", "count": 5501, "bytes": 3492000000 },
  "vm": null,
  "source": {
    "corresponding_source": { "url": "https://...", "sha256": "..." },
    "manifest": { "url": "MANIFEST.json", "sha256": "...", "size": 0 },
    "build_receipts": ["FORMAT-RECEIPT.pdftex-2026.json", "..."],
    "reproduced": false
  },
  "licences": { "pdftex": "GPL-2.0-only", "xetex": "GPL-2.0-only AND LicenseRef-XeTeX", "...": "...", "notices": "" },
  "sizes": { "pdftex": 5807474, "xetex": 0, "...": 0 },
  "digest": "<sha256 hex of the canonical JSON of this entry without `digest`>"
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
directly by `configure()` in LibrePaper's `web/src/lib/latex/worker.js`,
which resolves every `url` and `bundles.index` against the release
directory. No other field is consumed by anything on LibrePaper's side;
extra fields (`format`, `digest`, `licences`, `sizes`) are provenance, not
protocol.

`bibliography.control_file`/`biblatex` are read out of the release's own
bundled `tex/latex/biblatex/biblatex.sty` (`\blx@bcfversion`,
`\ProvidesPackage` version and date), found via `bundles.json`'s own `files`
map and unpacked with the tar reader in `wasm-build/kpse-resolve.cjs`
(`readTar`) -- the same reader the browser resolver uses. This needs no
network: the former importer's old CDN fetch of `biblatex.sty` at import time is gone,
because the file is already part of the staged release's `core` bundle.

`vm` is always `null`. The field survives from the time the Biber VM was
registered into the mirror; older releases can find their VM through the
`--biber-vm <url>#<sha256>` flag and ignores this field.

## Serving

The browser fetches directly from its configured HTTPS mirror URL, at
`<mirror URL>/<id>/release.json` and the paths it names. Every object is
immutable, so one rule covers the tree (`mirror/_headers`):

| Request | Answer |
| --- | --- |
| anything under `<id>/` | Static, `Cache-Control: public, max-age=31536000, immutable`, with CORS. |

No path is served `no-store` or `no-cache`: `bundles/bundles.json` is
inside the release directory the digest already names, so it never changes
either. The shared S3 publisher applies the matching cache policy and content
types, and serves gzip-encoded responses where applicable. Configure public
bucket CORS explicitly during setup. Browsers decode gzip before checking
payload integrity.

### Retention and platform limits

The mirror contains published build releases and their receipts only. It does
not accept, retain, or log user documents, compiler inputs, compiler outputs,
or request bodies. A release build is published as immutable objects. Existing objects on the previous Cloudflare host are unaffected by this publisher.
No release beyond the one referenced by the current LibrePaper build is
promised to remain available.

Objects are published to OVH S3 through the shared publisher. Package bundle
granularity and content hashes are recorded in `bundles.json` and the release
manifest; the publisher preserves those object paths and uploads the checked
files without altering their bytes. HTTP gzip encoding is transparent to browser fetches,
which expose the decoded bytes for the existing manifest integrity checks.

## Building it

`tools/build-mirror.mjs` builds this from a staged release
(`tools/stage-release.mjs`'s output) and the reviewed SHA-256 of its
`MANIFEST.json`:

    node tools/build-mirror.mjs --staged staged --sha256 <manifest digest> --out mirror

It verifies every payload file against the staged manifest before writing
anything (the same check `tools/check-release.mjs` already ran once at stage
time, re-run here because the mirror is a separate trust boundary: nothing
stops staged/ from being edited between staging and importing). It owns
`--out`: the directory is emptied first, so the result is exactly the one
release and a rebuild with the same input writes the same bytes.

`tools/check-mirror.mjs` verifies the result, or a deployed URL:

    node tools/check-mirror.mjs mirror
    node tools/check-mirror.mjs https://<configured-mirror-url>/ <release id>

A directory argument gets the full check: it holds only release directories
(each named by the sha256 of its `MANIFEST.json`) and `_headers`; each
`release.json` is format 2 and lists exactly the files on disk, with matching
digests and sizes; the release has a complete pdfTeX engine; `bundles.json`'s
own digest matches the release entry; and every bundle tar it names is on disk
with a matching digest. A URL argument checks the shape of
`<url>/<id>/release.json` and downloads the largest advertised file, verifying
its decoded size and digest. LibrePaper's browser smoke test exercises
rendering against the deployed mirror.
