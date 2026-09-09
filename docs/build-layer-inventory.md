# Build Layer Inventory

## Per-Engine Build Sequences

### pdfTeX + BibTeX (wasm-build.yml)
- **configure-engine-build-mirror.mjs** — resolve immutable TeX Live mirror URL + revision
- **check-annual-engine-source.mjs** — verify source licensing policy
- **check-license-compliance.mjs** — GPL/license compliance on release branch (2025 only)
- `docker buildx build` — Dockerfile (texlive-source-YEAR.ref), cache in /tmp/.buildx-cache, output to wasm-build/dist/
- `docker run` — pdfTeX/BibTeX WASM build
- **gen-engine-build-receipt.mjs** (pdftex, bibtex) — record build inputs/outputs to BUILD-RECEIPT.*.json
- **extract-format.mjs** — Playwright: start Chrome + vite server, run pdfTeX -ini, extract prebuilt .fmt
- Smoke test: validate WASM, check core symbols (_scanHashTable, _compileLaTeX, etc.), verify controller hooks

### XeTeX + dvipdfmx (wasm-xetex.yml)
- **configure-engine-build-mirror.mjs**
- **check-annual-engine-source.mjs**
- **check-license-compliance.mjs** (2025 only)
- **build-xetex-fromsource.sh** — orchestrates full Docker build:
  - Dockerfile.xetex build (Phase 1 native codegen via texlive-source, Phase 2 emcc)
  - Runs **test-xetex-pdf-geometry.mjs** + **build-xetex-pdf-visual-fixture.mjs** inside Docker for PDF inclusion gate tests
  - docker run for dvipdfm build (wasm-build/build-dvipdfm2.sh inside container)
- **gen-engine-build-receipt.mjs** (xetex) — record xetex + dvipdfm build receipts
- **extract-xetex-format.mjs** — Playwright: extract prebuilt XeLaTeX .fmt.gz
- Smoke test: validate WASM, check AGPL markers absent, verify interposition contract symbols

### LuaTeX (wasm-luatex.yml)
- **configure-engine-build-mirror.mjs**
- **check-annual-engine-source.mjs**
- **check-license-compliance.mjs** (2025 only)
- Dockerfile.luatex build (Phase 1 native, cached, Phase 2 emcc at `docker run`)
- Runs **generate-pdf-compat-fixtures.mjs** + **probe-luahbtex-pdf-api.lua** inside Docker for WTPDF lifetime + pdfe/pdfscanner gates
- **gen-engine-build-receipt.mjs** (luahbtex)
- **extract-luatex-format.mjs** — Playwright: extract prebuilt LuaLaTeX .fmt.gz
- Smoke test: WASM validity, controller hooks, entry exports (_compileLaTeX, _setMainEntry)

### BibTeX8 (wasm-bibtex8.yml)
- **configure-engine-build-mirror.mjs**
- **check-annual-engine-source.mjs**
- **check-license-compliance.mjs** (2025 only)
- `docker buildx build` Dockerfile.bibtex8, `docker run`
- **gen-engine-build-receipt.mjs** (bibtex8)
- Smoke test: WASM validity, entry + hook symbols

### MakeIndex (wasm-makeindex.yml)
- **configure-engine-build-mirror.mjs**
- **check-annual-engine-source.mjs**
- **check-license-compliance.mjs** (2025 only)
- `docker buildx build` Dockerfile.makeindex, `docker run`
- **gen-engine-build-receipt.mjs** (makeindex)
- Smoke test: WASM validity, interposition contract (_compileMakeindex, _setMainEntry, kpse_find_file_impl)

### Corresponding Source Build (build-corresponding-source.yml)
- `npm ci`
- **gen-asset-manifest.mjs** — generate release asset manifest
- **check-release-notices.mjs** — verify release notice compliance
- **build-corresponding-source.mjs** — assemble complete corresponding source tar.xz
- **check-corresponding-source.mjs** — verify completeness of source archive

## What scripts/ holds now

Upstream shipped 113 files here. Sixteen remain. The rest were removed on
2026-09-08; `git log` has them if one turns out to be needed.

The test was whether a script can do useful work *in this repository*, which
holds the engine build layer and nothing else. Most of upstream's tooling
assumed the full WasmTex application tree — `src/`, `public/wasmtex/<year>/`,
`.github/workflows/`, a `package.json` with Playwright and Vite — and fails on
its first file read here. Keeping a check that cannot run is worse than not
having it: it looks like coverage.

### Kept

| File | Why |
|---|---|
| `check-annual-engine-source.mjs`, `lib/annual-engine-source.mjs` | Verifies the pinned TeX Live source commit. Runs here today. |
| `build-corresponding-source.mjs`, `check-corresponding-source.mjs`, `lib/corresponding-source.mjs`, `lib/engine-build-receipt.mjs`, `lib/release-assets.mjs`, `corresponding-source-2026.json` | Assembles and verifies the GPL corresponding-source archive. A real obligation for anything we distribute. |
| `engine-components-2026.json` | The archive-to-component license mapping cited by `THIRD_PARTY_NOTICES.md`. |
| `build-xetex-fromsource.sh`, `build-luatex-fromsource.sh`, `build-icu-data.sh` | Docker orchestration for the engines not yet built here. |
| `test-xetex-pdf-geometry.mjs`, `build-xetex-pdf-visual-fixture.mjs`, `generate-pdf-compat-fixtures.mjs`, `probe-luahbtex-pdf-api.lua` | The PDF-inclusion and pdfe/pdfscanner gates those two builds run. Pure Node and Lua, no browser. |

Every reference from a kept script resolves to another kept file.

### Removed, by reason

**Needs the application repository** — `check-license-compliance.mjs` (requires
`public/wasmtex/…`, `docs/license-evidence/…`, `.github/actions/…`),
`check-engine-license-inventory.mjs`, `check-release-notices.mjs`,
`gen-asset-manifest.mjs`, `check-dts-exports.mjs`, `compat/`. Each was run
here and each crashed on a missing path.

**Replaced by `tools/build-format.mjs`** — `extract-format.mjs`,
`extract-xetex-format.mjs`, `extract-luatex-format.mjs`,
`lib/format-input-evidence.mjs`, and with them the Playwright and Vite
dependencies. See [`format-generation.md`](format-generation.md).

**Tied to upstream's CDN and object store** —
`configure-engine-build-mirror.mjs`, `lib/default-texlive-mirrors.mjs`,
`sync-texlive-mirror.sh`, `prepare-tlnet-snapshot.sh`, `verify-object-mirror.mjs`,
`lib/object-store.mjs`, `sync-engine-assets.mjs`, `audit-mirror.mjs`, and the
`texlive-mirror-*.json` configs. Our TeX Live inputs come from a signed release
archive instead ([`texlive-snapshot-2026.md`](texlive-snapshot-2026.md)).
`gen-engine-build-receipt.mjs` went with them: it refuses to emit a receipt
without a mirror revision to name.

**Editor and catalog data generation** — bloom filters, semantic catalogs,
completion data, font lists, luaotfload names, SBOM and link inventories,
benchmarks and performance budgets. All of it produces data for the editor
application, not for an engine build.

**Tests of removed code, and tests that need `.github/workflows/`** — every
`*.test.mjs`. They were run first; they fail here on missing workflow files.

**Superseded 2025 configs** — the pinned release is 2026.

### Known gaps this leaves

- No license-compliance gate runs in this repository. The policy in
  [`licensing.md`](licensing.md) still stands; the enforcement does not, and
  a replacement needs writing against this layout.
- No engine build receipts are generated for our own builds; only
  `tools/compare-receipt.mjs` comparing against upstream's pinned ones.
- The LuaTeX and XeTeX format extraction has no replacement yet.

## External References (Hard-Coded URLs)

### TeX Live Source Repository
- **wasm-build/Dockerfile:61** — `https://github.com/TeX-Live/texlive-source.git`
- **wasm-build/Dockerfile.xetex:51** — `https://github.com/TeX-Live/texlive-source.git`
- **wasm-build/Dockerfile.luatex:48** — `https://github.com/TeX-Live/texlive-source.git`
- **wasm-build/Dockerfile.bibtex8:28** — `https://github.com/TeX-Live/texlive-source.git`
- **wasm-build/Dockerfile.makeindex:31** — `https://github.com/TeX-Live/texlive-source.git`

### Upstream (WasmTeX) Repository
- **scripts/corresponding-source-2025.json:5** — `https://github.com/corca-ai/wasmtex.git`
- **scripts/corresponding-source-2026.json:5** — `https://github.com/corca-ai/wasmtex.git`

### TeX Live Mirror (Corca CDN)
- **scripts/engine-release-components.json:8, 53** — `https://texlive.corca.ai/snapshots/[revision]/[year]/`
- **scripts/lib/default-texlive-mirrors.mjs:2-3** — `https://texlive.corca.ai/snapshots/[hashes]/[year]/`

### Emscripten Ports (External Dependencies)
- **scripts/corresponding-source-2025.json:14** — `https://github.com/emscripten-core/emscripten.git`
- **scripts/corresponding-source-2025.json:23** — `https://github.com/emscripten-ports/FreeType/archive/version_1.zip`
- **scripts/corresponding-source-2025.json:30** — `https://github.com/unicode-org/icu/releases/download/release-68-2/icu4c-68_2-src.zip`
- **scripts/corresponding-source-2025.json:37** — `https://storage.googleapis.com/webassembly/emscripten-ports/libpng-1.6.39.tar.gz`
- **scripts/corresponding-source-2025.json:44** — `https://github.com/madler/zlib/archive/refs/tags/v1.2.13.tar.gz`

### Build-Time ICU Data (Optional CDN)
- **scripts/build-icu-data.sh:43, 45** — `https://github.com/unicode-org/icu/releases/download/` (only if building ICU data locally)

### External Object Storage (Optional)
- **scripts/build-icu-data.sh:27** — Defaults to `corca-texlive-production` S3 bucket
- **scripts/sync-texlive-mirror.sh:61** — Defaults to `corca-texlive-production` S3 bucket
- **scripts/lib/object-store.mjs:4** — References `TEXLIVE_OBJECT_BUCKET` env var (default: corca-texlive-production)

**Critical upstream infrastructure dependencies to replace:**
1. **github.com/TeX-Live/texlive-source.git** — Dockerfile git remote (can be forked)
2. **github.com/corca-ai/wasmtex.git** — Corresponding source reference (for GPL compliance)
3. **texlive.corca.ai** — TeX Live mirror CDN (must replace with self-hosted or standard TeX Live mirror)
4. **github.com/emscripten-ports/** — Emscripten library ports (accessible via mirrors)
5. **github.com/emscripten-core/emscripten.git** — Emscripten source (can be forked)

---

**Build-only summary:**
- **17 scripts to keep** (14 Node.js + 2 shell + 1 Lua): engine orchestration, Docker gates, format extraction, corresponding source assembly
- **~65+ scripts to drop** (editor tools, diagnostics, testing, manifest generation)
- **2 npm packages required:** @playwright/test + vite (for format extraction via browser automation)
- **5 critical upstream infrastructure dependencies** to replace: TeX Live source repo, Corca mirror CDN, emscripten repos
