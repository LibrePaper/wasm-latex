# TeX Format Generation for WebAssembly Engines

## Overview

TeX format files (`.fmt`) are precompiled binary representations of LaTeX macros and hyphenation data. The WasmTeX build pipeline generates these once per engine binary, so the browser can load them without rebuilding on every page load.

## 1. How .fmt Files Are Generated

Each engine type produces its format differently:

### pdfTeX
**Script:** `scripts/extract-format.mjs` (scripts/extract-format.mjs:1-86)

- Starts a Vite dev server and launches Playwright Chrome
- Navigates to a sample document endpoint
- Loads engine code via ESM and instantiates `WasmTexPdftexEngine`
- Calls `await engine.buildFormat()` to dump the format bytes
- Saves base64-decoded output to `public/wasmtex/<year>/wasmtex-pdftex.fmt`

**Inputs required:** Engine WASM binary, `latex.ltx`, hyphenation patterns, font metrics, core packages (loaded via `TEXLIVE_URL`)

### XeLaTeX and LuaTeX
**Scripts:** `scripts/extract-xetex-format.mjs` and `scripts/extract-luatex-format.mjs`

- Similar pattern: Vite + Playwright browser environment
- Uses `createCompileWorker()` to instantiate each engine as a worker
- Calls `await tex.run('compileformat')` to invoke the engine's native `*tex -ini` command
- Captures output bytes and saves to `public/wasmtex/<year>/wasmtex-xetex.fmt.gz` (gzip-compressed)
- Timeout: 300s for XeLaTeX, 180s for LuaTeX (scripts/extract-xetex-format.mjs:88, scripts/extract-luatex-format.mjs:91)

**Inputs required:** Engine worker/WASM, initialization files (`xelatex.ini`, `lualatex.ini`), packages, fonts (all from `TEXLIVE_URL`)

## 2. Mirror Inputs and Resolution

### Mirror URL Resolution Chain
The format generation needs TeX Live packages from three environment sources:

1. **`TEXLIVE_URL`** (direct override, lowest precedence)
   - Example: `https://texlive.corca.ai/snapshots/2026-ba38749b8714505a/2026/`

2. **`configure-engine-build-mirror.mjs` (scripts/configure-engine-build-mirror.mjs:1-35)**
   - Reads `scripts/engine-release-components.json`
   - Resolves environment overrides: `INPUT_TEXLIVE_URL`, `INPUT_MIRROR_REVISION`, `INPUT_PROVENANCE_SHA256`
   - Falls back to release.mirror in the JSON (highest precedence)
   - Validates mirror revision format: `YYYY-<16hex digits>` (scripts/lib/engine-release-components.mjs:9)

3. **Default mirrors** (`scripts/lib/default-texlive-mirrors.mjs:1-10`)
   - 2025: `https://texlive.corca.ai/snapshots/2025-92e10d3241a312f0/2025/`
   - 2026: `https://texlive.corca.ai/snapshots/2026-ba38749b8714505a/2026/`

### Engine Release Configuration
File: `scripts/engine-release-components.json` (scripts/engine-release-components.json:1-95)

For each TeX Live year, specifies:
- `mirror.url`: Base URL (must contain immutable revision in path)
- `mirror.revision`: YYYY-<16hex> identifier
- `mirror.provenanceSha256`: SHA-256 hash of mirror's provenance manifest
- `downloads`: GitHub Actions run IDs for each engine family

The entire configuration is validated atomically (scripts/lib/engine-release-components.mjs:24-70).

### Package Key Format
TeX Live files are requested using this key scheme:
```
<format>/<filename>
26/amsmath.sty    # format 26 = generic TeX/LaTeX package
33/ptmb7t.vf      # format 33 = virtual font
```

The mapping is hardcoded in `wasm-build/kpse-resolve.cjs` (wasm-build/kpse-resolve.cjs:13-19).

## 3. Building a Snapshot (sync-texlive-mirror.sh)

The `sync-texlive-mirror.sh` script (scripts/sync-texlive-mirror.sh) creates the immutable mirror snapshot that format generation depends on:

### Source Selection
Configured via `TEXLIVE_MIRROR_CONFIG` (default: `texlive-mirror-2025.json`):
- **Release archives** (default): Downloads `texmf-dist.tar.xz` and `texlive.tlpdb` from TUG FTP
  - URLs and SHA-512 hashes specified in JSON (scripts/texlive-mirror-2025.json:1-13)
  - Example source: `https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/`

- **tlnet repository**: Materializes live CTAN snapshot (requires `prepare-tlnet-snapshot.sh` first)

### Mirror Generation Process
1. **Download/extract** texmf-dist and texlive.tlpdb (scripts/sync-texlive-mirror.sh:140-209)
2. **Generate provenance manifest** via `gen-texlive-provenance.mjs` (scripts/sync-texlive-mirror.sh:225-244)
   - Records every file's hash and source
   - Derives mirror revision: `YYYY-<16hex>` hash slice from provenance JSON
3. **Generate catalog and semantic index** (scripts/sync-texlive-mirror.sh:267-285)
4. **Verify provenance** with `check-texlive-provenance.mjs` (scripts/sync-texlive-mirror.sh:252-260)
5. **Compute provenance SHA-256** (scripts/sync-texlive-mirror.sh:300)
6. **Upload to Cloudflare R2** (optional, scripts/sync-texlive-mirror.sh:304-378)

### Snapshot Layout on Mirror
```
snapshots/<revision>/<year>/
  pdftex/26/amsmath.sty              # Example package file
  33/ptmb7t.vf                        # Virtual fonts
  bloom-filter.v2.bin                 # Bloom filter for optimization
  icudt68l.dat                        # ICU data (XeTeX runtime asset)
  catalog/<revision>/texlive-provenance.json
  semantic/<revision>/...             # Semantic index
```

Mirror revision uses SHA from provenance JSON (immutable, content-derived).

## 4. LibrePaper Integration (wasmtex.mjs)

File: `/home/vincent/repos/librepaper/latex/tools/wasmtex.mjs`

The browser-side tool mirrors resources from upstream into `latex/mirror/`:

**Upstream URLs hardcoded** (wasmtex.mjs:75-76):
- Engines: `https://corca-ai.github.io/wasmtex/wasmtex/2026/`
- TeX Live: `https://texlive.corca.ai/snapshots/2026-ba38749b8714505a/2026/`

**Mirror location:** `latex/mirror/<engineRelease>/` and `latex/mirror/texlive/<snapshot>/`

**Manifest:** Records all fetched files with SHA-256 and sizes (wasmtex.mjs:104-112)

## 5. Migrating to Independent Mirrors

### 5a. Build Own TeX Live Snapshot

**Option 1: Clone existing release archives**
- Modify `scripts/texlive-mirror-2026.json` to point to alternative CTAN server
- Run: `TEXLIVE_MIRROR_CONFIG=scripts/texlive-mirror-2026.json ./scripts/sync-texlive-mirror.sh --upload`
- Requires: `TEXLIVE_OBJECT_ENDPOINT`, R2 bucket credentials, runtime assets directory

**Option 2: Snapshot from CTAN tlnet**
- Run: `./scripts/prepare-tlnet-snapshot.sh` (not included here, see upstream docs)
- Provide materialization receipt to sync script

### 5b. Point Format Generation at LibrePaper Mirror

1. **Deploy snapshot to Cloudflare** (with immutable cache headers)
   - Root path: `https://your-mirror.example/texlive/<revision>/2026/`

2. **Update defaults** in `scripts/lib/default-texlive-mirrors.mjs`:
   ```javascript
   '2026': 'https://your-mirror.example/texlive/2026-ba38749b8714505a/2026/'
   ```

3. **Update engine-release-components.json** mirror URL for each year

4. **Update LibrePaper's wasmtex.mjs** to point to deployed mirror:
   ```javascript
   const TEXLIVE_UPSTREAM = `https://your-mirror.example/texlive/${SNAPSHOT}/2026/`
   ```

5. **Regenerate formats** in CI via `node scripts/extract-format.mjs 2026`
   - The new TEXLIVE_URL environment will be used automatically

### Validation
- Format files must be reproducible: same inputs → same output bytes
- Build receipts (CI artifacts) record provenance: SHA-256 of each generated `.fmt`
- Bloom filter and manifest must be regenerated after adding new packages
- Verify deployment: `node scripts/verify-object-mirror.mjs --local-root <path> --year 2026`

## CI Integration

**File:** `upstream-ci/wasm-build.yml` (upstream-ci/wasm-build.yml:49-142)

Steps:
1. Resolve mirror via `configure-engine-build-mirror.mjs` → env vars
2. Build WASM engines in Docker
3. Extract formats via Playwright browser scripts
4. Record build receipts with format SHA-256 and fetched URLs
5. Upload artifacts (`.fmt` files + build receipts)

Format generation is the final step after WASM compilation; any mirror misconfiguration fails here loudly (format file will not exist).
