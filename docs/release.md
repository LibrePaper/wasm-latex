# Releasing

The wasm-latex engines and their data are released through this repository. LibrePaper imports them by pinning the manifest digest.

## Release

The full sequence from source to deployed mirror.

```sh
# Fetch, verify and unpack TeX Live 2026; generate font map
make vendor

# Build engines with Docker; build Biber, data, receipts (about two hours cold)
make rebuild

# Commit receipts/ changes
git add receipts/
git commit -m "..."

# Tag HEAD and create GitHub Release; assemble and gate the release
make release TAG=engines-2026.1

# Verify the staged manifest, then build the mirror
make mirror

# From ../librepaper, check the mirror and publish it
deploy/assets check
deploy/assets smoke
deploy/assets publish --test
deploy/assets publish

# Update the latex row of assets.lock
```

`make rebuild` runs `make engines` (Docker, once per TeX Live pin) followed by `make vendor`, `make test`, `make bundles`, `make format`, `make inventory`, and `make biber-build` in order.

`make release TAG=<tag>` runs the full chain: `make source`, `make publish-source TAG=<tag>`, `make stage`, and annotates the release with the manifest SHA-256. It refuses to start if the tree is dirty, the tag exists, or `gh` is not signed in. After it prints the staged manifest hash, review `staged/MANIFEST.json` and run `make mirror` manually.

Legacy alternative: `make push` (from this repository) publishes `mirror/` through `../librepaper/tools/publish-mirror.mjs`.

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

Verified 2026-09-08: `texlive-20260301-texmf.tar.xz` (4 963 412 512 bytes), sha512 matched, signed by TeX Live Distribution, extracted to `texlive-20260301-texmf/texmf-dist` (9.1 GB).

### Font map generation

`texmf-dist` does not contain `pdftex.map`; `updmap` writes it.

```sh
T=vendor/texlive-2026/texlive-20260301-texmf/texmf-dist
V=vendor/texlive-2026/texmf-var
TEXMFDIST=$T TEXMFMAIN=$T TEXMFVAR=$V TEXMFSYSVAR=$V \
TEXMFCONFIG=$V TEXMFSYSCONFIG=$V TEXMFHOME=$V \
  updmap --quiet --nohash --cnffile $T/web2c/updmap.cfg
```

This runs a local TeX Live's `updmap` with all inputs from the 2026 tree. Verify by size: the 2026 map is 5 541 403 bytes.

### Where it lives

`vendor/texlive-2026/` is gitignored and contains the archive, hash, signature, extracted `texmf-dist`, and generated `texmf-var` (14 GB total). The repository keeps only the receipt naming what was used and the hash of every file that went in, so the tree can be rebuilt from the commands above and checked against it.

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

Each build is 15 to 20 minutes. `node tools/check-pins.mjs` confirms the source commit and Emscripten image are the pinned ones. Skip when nothing under `wasm-build/` changed.

## Staging and committing

```sh
# Commit receipts/ that changed
git add receipts/
git commit

# Assemble staged/ and run the gate
make stage SOURCE_URL=<url>

# The hash of staged/MANIFEST.json is the release's identity
sha256sum staged/MANIFEST.json
```

`make stage` assembles `staged/` from `wasm-build/dist` and the bundle tree, runs the gate, and prints the SHA-256 of `staged/MANIFEST.json`. That hash is what LibrePaper imports against and what the GitHub Release records. Tags are never moved; a second release gets a new tag and a new archive. Commit `receipts/SOURCE-RECEIPT.json` after `make source` so the receipt of the published archive is in the history the tag names.

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

`<id>` is the SHA-256 of the staged `MANIFEST.json`. Nothing in the mirror is mutable: there is no top-level manifest, no default release, no file whose bytes change under a fixed name. A release is found by its id, which LibrePaper's build pins; a new digest is a new directory. `make mirror` holds exactly the one staged release and clears whatever an earlier build left. Biber WASM travels with the release. The separate `--biber-vm` server setting is only a legacy fallback for mirrors that do not advertise `engines.biber`.

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

Fields consumed by LibrePaper's `configure()` in `web/src/lib/latex/worker.js`:
- `engines`, `files`, `bibliography`, `bundles`, `source`: every `url` and `bundles.index` are resolved against the release directory
- Extra fields (`format`, `id`, `engine_release`, `digest`, `licences`, `sizes`, `vm`) are provenance, not protocol

`luatex` is absent from `engines` on every release this repository ships: its engine is unbuilt, so its file set is never complete, and an engine whose file set is not complete is not advertised. LibrePaper's `configure()` treats missing `engines.luatex` as "this release has no LuaTeX", which is correct.

`vm` is always `null`. The field survives from when the Biber VM was registered into the mirror. Older releases can find their VM through the `--biber-vm <url>#<sha256>` flag.

`bibliography.control_file` and `bibliography.biblatex` are read from the release's bundled `tex/latex/biblatex/biblatex.sty`, found via `bundles.json` and unpacked with the tar reader in `wasm-build/kpse-resolve.cjs`. This needs no network: the old CDN fetch of `biblatex.sty` at import time is gone.

## Serving the mirror

Every object under `<id>/` is immutable. Set cache headers once in `mirror/_headers`:

```
Cache-Control: public, max-age=31536000, immutable
```

Add CORS headers and configure bucket CORS explicitly during setup. The shared S3 publisher applies matching cache policy and content types, serves gzip-encoded responses where applicable, and preserves object paths without altering bytes. Browsers decode gzip before checking payload integrity.

No release beyond the one referenced by the current LibrePaper build is promised to remain available. The mirror contains published build releases and their receipts only; it does not accept, retain, or log user documents, compiler inputs, compiler outputs, or request bodies.

## Building and checking the mirror

```sh
# Build the mirror from staged/ and the reviewed manifest hash
node tools/build-mirror.mjs --staged staged --sha256 <hash> --out mirror

# Verify the local mirror
node tools/check-mirror.mjs mirror

# Verify a deployed mirror
node tools/check-mirror.mjs https://<mirror-url>/ <release-id>
```

`build-mirror.mjs` verifies every payload file against the staged manifest before writing anything (the same check `check-release.mjs` already ran at stage time, re-run here because the mirror is a separate trust boundary). It owns `--out`: the directory is emptied first, so the result is exactly the one release.

`check-mirror.mjs` with a directory argument runs the full check: only release directories (each named by the SHA-256 of its `MANIFEST.json`) and `_headers` are present, each `release.json` is format 2 and lists exactly the files on disk with matching digests and sizes, the release has a complete pdfTeX engine, `bundles.json`'s digest matches the release entry, and every bundle tar it names is on disk with matching digest. A URL argument checks the shape of `<url>/<id>/release.json` and downloads the largest advertised file, verifying its decoded size and digest.

## What the gate checks

`make check` runs `tools/check-release.mjs` on `staged/`:

- Every artifact named and unmodified
- Every linked component classified with its notice present
- LGPL relink recipe shipped
- Corresponding source named, hashed and built for these exact bytes
- Every format's inputs receipted
- Every bundle matching the index and the index matching the manifest

It fails closed. See `docs/licensing.md` for the obligations behind each check.
