# Releasing

The wasm-latex engines and their data are released through this repository. LibrePaper imports them by pinning the manifest digest.

## Release

The command sequence is in [README.md](../README.md#making-a-release).

Composite targets in order of use:
- `make rebuild`: engines, biber-build, vendor, test, bundles, format, inventory
- `make engines`: every Docker engine build, then `node tools/check-pins.mjs`
- `make release TAG=<tag>`: preflight, test, inventory, source, commit receipts, publish-source, stage, annotate; refuses a dirty tree, an existing tag, or no gh login
- `make push`: alternative to `deploy/assets publish`

## TeX Live snapshot

One place provides all TeX Live inputs: the official TeX Live 2026 texmf release archive, verified against TUG's signed hash.

### Obtaining and verifying

```sh
mkdir -p vendor/texlive-2026 && cd vendor/texlive-2026
B=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2026
curl -O $B/texlive-20260301-texmf.tar.xz.sha512 \
     -O $B/texlive-20260301-texmf.tar.xz.sha512.asc \
     -O https://tug.org/texlive/files/texlive.asc

# Verify the hash file is signed by the TeX Live distribution key
export GNUPGHOME=$(mktemp -d) && chmod 700 $GNUPGHOME
gpg -q --import texlive.asc && gpg -q --export > tl.gpg
gpgv --keyring ./tl.gpg texlive-20260301-texmf.tar.xz.sha512{.asc,}

# Verify the archive
curl -C - -O $B/texlive-20260301-texmf.tar.xz
sha512sum -c texlive-20260301-texmf.tar.xz.sha512
tar -xJf texlive-20260301-texmf.tar.xz
```

Verified 2026-09-08: `texlive-20260301-texmf.tar.xz` (4,963,412,512 bytes), sha512 matched, signed by TeX Live Distribution, extracted to `texlive-20260301-texmf/texmf-dist` (9.1 GB).

### Font map generation

`texmf-dist` does not contain `pdftex.map`; `updmap` writes it.

```sh
T=vendor/texlive-2026/texlive-20260301-texmf/texmf-dist
V=vendor/texlive-2026/texmf-var
TEXMFDIST=$T TEXMFMAIN=$T TEXMFVAR=$V TEXMFSYSVAR=$V \
TEXMFCONFIG=$V TEXMFSYSCONFIG=$V TEXMFHOME=$V \
  updmap --quiet --nohash --cnffile $T/web2c/updmap.cfg
```

- Runs local TeX Live's `updmap` with all inputs from the 2026 tree
- Verify by size: 2026 map is 5,541,403 bytes

### Where it lives

- `vendor/texlive-2026/` is gitignored: 14 GB (archive, hash, signature, extracted texmf-dist, generated texmf-var)
- Repository keeps only the receipt naming what was used and the hash of every file that went in
- Tree can be rebuilt and checked against the receipt

## Engine builds

Every engine builds once per TeX Live source pin with Docker.

```sh
# pdftex, bibtex, bibtex8, makeindex
docker buildx build --platform linux/amd64 --load \
  --build-arg TEXLIVE_REF=$(cat wasm-build/texlive-source-2026.ref) \
  -t librepaper-pdftex-wasm wasm-build/
docker run --rm --platform linux/amd64 -v $PWD/wasm-build/dist:/dist librepaper-pdftex-wasm

# Same pattern with Dockerfile.makeindex, Dockerfile.bibtex, Dockerfile.bibtex8

# XeTeX and dvipdfm
TEXLIVE_YEAR=2026 bash wasm-build/build-xetex-fromsource.sh wasm-build/dist
bash wasm-build/build-icu-data.sh

# LaTeXML (experimental, separate pinned Rust build)
docker buildx build --platform linux/amd64 --load \
  -f wasm-build/Dockerfile.latexml -t librepaper-latexml-wasm .
docker run --rm --platform linux/amd64 \
  -e LATEXML_DIST_DIR=/dist -v $PWD/wasm-build/dist:/dist \
  librepaper-latexml-wasm
```

- Each build: 15 to 20 minutes
- `node tools/check-pins.mjs` confirms source commit and Emscripten image are pinned
- Skip when nothing under `wasm-build/` changed

## Staging and committing

```sh
git add receipts/
git commit

make stage SOURCE_URL=<url>

sha256sum staged/MANIFEST.json
```

- `make stage` assembles `staged/` from `wasm-build/dist` and the bundle tree, runs the gate, prints SHA-256
- That hash is the release's identity; LibrePaper imports against it and the GitHub Release records it
- Tags are never moved; a second release gets a new tag and archive
- Commit `receipts/SOURCE-RECEIPT.json` after `make source` so the receipt is in the tag's history

## Mirror layout

```
mirror/
  _headers                                 everything immutable, plus CORS
  <id>/                                    one release; <id> = sha256 of MANIFEST.json
    MANIFEST.json                          byte copy of the staged manifest
    release.json                           the loader entry for this release
    pdftex.worker.js pdftex.js pdftex.wasm
    pdftex.fmt pdftex-resolver-evidence.js
    kpse-resolve.js bundle-mode.js
    bibtex.* bibtex8.* makeindex.* biber.* biber-notices/
    xetex.* xetex.fmt.gz icudt68l.dat.gz dvipdfm.*
    latexml.worker.js latexml.js latexml.wasm latexml.css LaTeXML.css
    LaTeXML-blue.css LaTeXML-marginpar.css LaTeXML-navbar-left.css LaTeXML-navbar-right.css
    ltx-amsart.css ltx-apj.css ltx-article.css ltx-book.css ltx-listings.css
    ltx-report.css ltx-svjour.css ltx-ulem.css
    LICENSE THIRD_PARTY_NOTICES.md SOURCE.md SOURCE-RECEIPT.json RELINK.md
    LICENSES/  LINK-INVENTORY.*.json  FORMAT-RECEIPT.*.json  BUNDLE-RECEIPT.*.json
    bundles/bundles.json                   package index
    bundles/b/<sha256>/<slug>.tar          one tar per package directory
```

- `<id>` is the SHA-256 of staged `MANIFEST.json`
- Nothing mutable: no top-level manifest, default release, or bytes changing under a fixed name
- Release found by its id, which LibrePaper's build pins; a new digest is a new directory
- `make mirror` holds exactly the one staged release, clearing whatever an earlier build left
- Biber WASM travels with the release
- `--biber-vm` server setting is legacy fallback for mirrors that do not advertise `engines.biber`

## release.json, format 2

Every path is relative to the release directory (`<mirror URL>/<id>/`). There is no `base`.

```json
{
  "format": 2,
  "id": "<sha256>",
  "engine_release": "<sha256>",
  "engines": {
    "pdftex":  { "worker": "pdftex.worker.js", "format": "pdftex.fmt", "files": ["..."] },
    "xetex":   { "worker": "xetex.worker.js",  "format": "xetex.fmt.gz", "icu": "icudt68l.dat.gz", "files": ["..."] },
    "dvipdfm": { "worker": "dvipdfm.worker.js", "files": ["..."] },
    "bibtex":  { "worker": "bibtex.worker.js", "files": ["..."] },
    "bibtex8": { "worker": "bibtex8.worker.js", "files": ["..."] },
    "biber": { "worker": "biber.worker.js", "files": ["biber.worker.js", "biber.js", "biber.wasm", "biber.data", "biber.build.json"] },
    "makeindex": { "worker": "makeindex.worker.js", "files": ["..."] },
    "latexml": { "worker": "latexml.worker.js", "files": ["latexml.worker.js", "..."] }
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
  "licences": { "pdftex": "GPL-2.0-only", "xetex": "GPL-2.0-only AND LicenseRef-XeTeX", "..." },
  "sizes": { "pdftex": 5807474, "..." },
  "digest": "<sha256 hex of canonical JSON without digest>"
}
```

Consumed by LibrePaper's `configure()` in `web/src/lib/latex/worker.js`:
- `engines`, `files`, `bibliography`, `bundles`, `source`: every `url` and `bundles.index` resolved against release directory
- Extra fields (`format`, `id`, `engine_release`, `digest`, `licences`, `sizes`, `vm`): provenance, not protocol

Details:
- `luatex` absent from `engines` on every release: engine unbuilt, file set never complete, incomplete engines not advertised
- `vm` always `null`; legacy field for older releases with `--biber-vm <url>#<sha256>`
- `bibliography.control_file` and `bibliography.biblatex` read from release's bundled `tex/latex/biblatex/biblatex.sty`, found via `bundles.json`, unpacked with tar reader in `wasm-build/kpse-resolve.cjs`

## Serving the mirror

Every object under `<id>/` is immutable. Set cache headers once in `mirror/_headers`:

```
Cache-Control: public, max-age=31536000, immutable
```

- Add CORS headers; configure bucket CORS explicitly during setup
- Shared S3 publisher applies matching cache policy and content types
- Serves gzip-encoded responses where applicable; preserves object paths without altering bytes
- Browsers decode gzip before checking payload integrity
- Only published build releases and receipts present; no user documents, inputs, outputs, or request bodies
- No release beyond the one referenced by current LibrePaper build is promised available

## Building and checking the mirror

```sh
node tools/build-mirror.mjs --staged staged --sha256 <hash> --out mirror

node tools/check-mirror.mjs mirror

node tools/check-mirror.mjs https://<mirror-url>/ <release-id>
```

`build-mirror.mjs`:
- Verifies every payload file against staged manifest before writing (re-run because mirror is separate trust boundary)
- Owns `--out`: directory emptied first, result is exactly one release

`check-mirror.mjs` on directory:
- Only release directories (each named by SHA-256 of `MANIFEST.json`) and `_headers` present
- Each `release.json` is format 2, lists exactly disk files with matching digests and sizes
- Release has complete pdfTeX engine
- `bundles.json` digest matches release entry
- Every bundle tar on disk with matching digest

`check-mirror.mjs` on URL:
- Checks shape of `<url>/<id>/release.json`
- Downloads largest advertised file, verifies decoded size and digest

## What the gate checks

`make check` runs `tools/check-release.mjs` on `staged/`:

- Every artifact named and unmodified
- Every linked component classified with its notice present
- LGPL relink recipe shipped
- Corresponding source named, hashed and built for these exact bytes
- Every format's inputs receipted
- Every bundle matching the index and the index matching the manifest

It fails closed. See `docs/licensing.md` for the obligations behind each check.
