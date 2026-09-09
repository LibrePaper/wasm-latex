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

## KEEP List (Scripts Required for Engine Builds)

| Script | Reason | Imports |
|--------|--------|---------|
| `configure-engine-build-mirror.mjs` | All engines: resolve immutable TeX Live mirror | lib/engine-release-components.mjs, engine-release-components.json |
| `check-annual-engine-source.mjs` | All engines: verify licensing policy | lib/annual-engine-source.mjs |
| `check-license-compliance.mjs` | All engines: GPL/license compliance | lib/engine-build-receipt.mjs, lib/engine-license-inventory.mjs, lib/engine-release-components.mjs |
| `gen-engine-build-receipt.mjs` | All engines: record build evidence | lib/engine-build-receipt.mjs, corresponding-source-*.json |
| `extract-format.mjs` | pdfTeX build: Playwright format extraction | lib/format-input-evidence.mjs, lib/default-texlive-mirrors.mjs, @playwright/test, vite |
| `extract-xetex-format.mjs` | XeTeX build: Playwright format extraction | lib/format-input-evidence.mjs, lib/default-texlive-mirrors.mjs, @playwright/test, vite |
| `extract-luatex-format.mjs` | LuaTeX build: Playwright format extraction | lib/format-input-evidence.mjs, lib/default-texlive-mirrors.mjs, @playwright/test, vite |
| `build-xetex-fromsource.sh` | XeTeX: Docker orchestration + tests | test-xetex-pdf-geometry.mjs, build-xetex-pdf-visual-fixture.mjs |
| `build-luatex-fromsource.sh` | LuaTeX: Docker orchestration + gates | generate-pdf-compat-fixtures.mjs, probe-luahbtex-pdf-api.lua |
| `generate-pdf-compat-fixtures.mjs` | LuaTeX gate: generate test fixtures | @playwright/test, vite |
| `test-xetex-pdf-geometry.mjs` | XeTeX gate: validate PDF geometry | (Node.js only) |
| `build-xetex-pdf-visual-fixture.mjs` | XeTeX gate: deterministic XDV fixture | (Node.js only) |
| `gen-asset-manifest.mjs` | Corresponding source: generate release manifest | lib/release-assets.mjs, engine-release-components.json, corresponding-source-*.json |
| `check-release-notices.mjs` | Corresponding source: verify notices | lib/engine-license-inventory.mjs |
| `build-corresponding-source.mjs` | Corresponding source: assemble archive | lib/corresponding-source.mjs, lib/engine-build-receipt.mjs, lib/release-assets.mjs, corresponding-source-*.json |
| `check-corresponding-source.mjs` | Corresponding source: verify completeness | lib/corresponding-source.mjs |

**Lib files (transitive):**
- `lib/annual-engine-source.mjs`
- `lib/corresponding-source.mjs`
- `lib/default-texlive-mirrors.mjs`
- `lib/engine-build-receipt.mjs`
- `lib/engine-license-inventory.mjs`
- `lib/engine-release-components.mjs`
- `lib/format-input-evidence.mjs`
- `lib/release-assets.mjs`

**Config JSON (read at runtime):**
- `corresponding-source-2025.json`
- `corresponding-source-2026.json`
- `engine-release-components.json`

**Test/fixture files used in build gates:**
- `probe-luahbtex-pdf-api.lua` — embedded in LuaTeX build image
- `wasm-build/pdf-backend/fixtures/xetex-geometry.expected.json`
- `wasm-build/pdf-backend/fixtures/xetex-visual.expected.sha256`
- `wasm-build/pdf-backend/fixtures/luahbtex-repeat-image.tex`
- `wasm-build/pdf-backend/fixtures/luahbtex-pdf-api.expected.json`

**Count:** 17 scripts total
- 14 .mjs (engine orchestration, format extraction, gates, corresponding source)
- 2 .sh (XeTeX and LuaTeX build orchestration)
- 1 .lua (LuaTeX PDF API gate probe)
- Plus 8 lib modules + 3 config JSONs + 4 fixture files (.json, .sha256, .tex)

## DROP List (Unrelated to Engine Builds)

| Script | Reason |
|--------|--------|
| `annual-engine-source.test.mjs` | Test only, not invoked in CI |
| `audit-mirror.mjs` | Manual audit tool, not in CI |
| `audit-texlive-provenance.mjs` | Manual audit tool |
| `bench-engines.mjs` | Performance benchmarking, not in CI |
| `check-annual-engine-source.mjs` | **KEEP** (listed above) |
| `check-corresponding-source.mjs` | **KEEP** |
| `check-deployed-completion.mjs` | Editor tool for completion data |
| `check-dts-exports.mjs` | TypeScript export checker, editor build |
| `check-engine-license-inventory.mjs` | Inventory checker, not required for builds |
| `check-engine-performance-budget.mjs` | Performance budget checker |
| `check-license-compliance.mjs` | **KEEP** |
| `check-release-notices.mjs` | **KEEP** |
| `check-texlive-catalog.mjs` | Catalog validation, not in engine builds |
| `check-tex-semantic-catalog.mjs` | Semantic catalog validation |
| `check-texlive-provenance.mjs` | Provenance auditing tool |
| `compress-assets.mjs` | Asset compression (not in workflows) |
| `corresponding-source.test.mjs` | Test only |
| `deployed-completion.test.mjs` | Test only |
| `engine-build-receipt.test.mjs` | Test only |
| `engine-components-2025.json` | Editor config (not used in builds) |
| `engine-components-2026.json` | Editor config |
| `engine-license-inventory.test.mjs` | Test only |
| `engine-performance-budgets-2025.json` | Config, not loaded by build scripts |
| `engine-performance-budgets-2026.json` | Config |
| `engine-release-components.test.mjs` | Test only |
| `extract-luatex-format.mjs` | **KEEP** |
| `extract-xetex-format.mjs` | **KEEP** |
| `extract-format.mjs` | **KEEP** |
| `gen-asset-manifest.mjs` | **KEEP** |
| `gen-bloom-filter.mjs` | Editor utility |
| `gen-bloom-filter.test.mjs` | Test only |
| `gen-engine-build-receipt.mjs` | **KEEP** |
| `gen-engine-sbom.mjs` | SBOM generation (not in CI workflows) |
| `gen-font-scripts.mjs` | Editor utility |
| `gen-link-inventory.mjs` | Link inventory generation (editor) |
| `gen-luaotfload-names.mjs` | Editor utility (font data) |
| `gen-luaotfload-names.test.mjs` | Test only |
| `gen-luatex-manifest.mjs` | Manifest generation (not in build workflows) |
| `gen-texlive-catalog.mjs` | Catalog generation |
| `gen-texlive-provenance.mjs` | Provenance generation |
| `gen-tex-semantic-catalog.mjs` | Semantic catalog generation |
| `gen-xetexfontlist.mjs` | Font list generation (editor) |
| `link-inventory.test.mjs` | Test only |
| `measure-engine-performance.mjs` | Performance measurement |
| `node-compile-smoke.mjs` | Quick smoke test (not in CI) |
| `object-inventory.test.mjs` | Test only |
| `object-store.test.mjs` | Test only |
| `prepare-tlnet-snapshot.sh` | Mirror tooling (not in build CI) |
| `reconcile-deployed-completion.mjs` | Completion reconciliation |
| `run-tex-semantic-probes.mjs` | Semantic probes (editor) |
| `snapshot-artifacts.mjs` | Artifact snapshot (not in CI) |
| `snapshot-artifacts.test.mjs` | Test only |
| `sync-engine-assets.mjs` | Asset sync from upstream CDN (optional) |
| `sync-texlive-mirror.sh` | Mirror sync (external tool) |
| `test-luahbtex-pdf-api-differential.sh` | Differential testing (not in CI) |
| `test-xetex-pdf-extended.mjs` | Extended testing |
| `test-xetex-pdf-extended-differential.sh` | Differential testing |
| `test-xetex-pdf-visual-differential.sh` | Differential testing |
| `texlive-catalog.test.mjs` | Test only |
| `texlive-completion-deployment-2025.json` | Deployment config (not in builds) |
| `texlive-mirror-*.json` | Mirror configs (not read by build scripts) |
| `texlive-mirror-overrides-*.json` | Mirror overrides (not read) |
| `texlive-profiles-2026.json` | Profile config (not read by builds) |
| `texlive-provenance.test.mjs` | Test only |
| `tex-semantic-catalog.test.mjs` | Test only |
| `tex-semantic-extractor.test.mjs` | Test only |
| `tex-semantic-overrides-*.json` | Semantic overrides (not in builds) |
| `tex-semantic-probe.test.mjs` | Test only |
| `tlnet-materialization-receipt.mjs` | Mirror materialization (not in CI) |
| `tlnet-snapshot.test.mjs` | Test only |

**compat/ directory:** All editor-specific compatibility tools (run.mjs, etc.)

**Count:** ~70+ scripts/configs unrelated to engine builds

## npm Dependencies for KEEP Scripts

From `upstream-package.json` devDependencies:
- **@playwright/test: ^1.58.2** — Format extraction via browser automation (extract-*.mjs scripts)
- **vite: ^8.2.0** — Dev server for format extraction (runs pdfTeX/xetex/luatex in browser context)
- @types/node: ^24.13.2 (implicit, not called directly)

Note: Playwright is essential for format extraction gates in pdfTeX/XeTeX/LuaTeX builds. Vite provides local HTTP server for the WASM engines during format extraction.

**No production dependencies** are consumed by build scripts.

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
