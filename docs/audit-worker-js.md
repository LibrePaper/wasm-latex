# JavaScript Web Worker Security Audit

Audit date: 2026-09-08  
Scope: All hand-written JavaScript in `/wasm-build/` used by browser Web Workers  
Purpose: Supply-chain risk assessment

## Summary Table

| File | Lines | Network | eval/Function | Hard-coded URLs | Verdict |
|------|-------|---------|---------------|-----------------|---------|
| pdftex-worker.js | 1910 | XMLHttpRequest(2) | None | None | ✓ Safe |
| xetex-worker.js | 433 | XMLHttpRequest(1) | None | None | ✓ Safe |
| luatex-worker.js | 595 | XMLHttpRequest(2) | None | None | ✓ Safe |
| dvipdfm-worker.js | 380 | XMLHttpRequest(1) | None | None | ✓ Safe |
| bibtex-worker.js | 251 | XMLHttpRequest(1) | None | None | ✓ Safe |
| bibtex8-worker.js | 223 | XMLHttpRequest(1) | None | None | ✓ Safe |
| makeindex-worker.js | 208 | XMLHttpRequest(1) | None | None | ✓ Safe |
| kpse-resolve.cjs | 70 | None | None | None | ✓ Safe |
| resolver-evidence.js | 16 | postMessage only | None | None | ✓ Safe |
| library.js | 23 | None | None | None | ✓ Safe |
| luatex-library.js | 16 | None | None | None | ✓ Safe |
| xetex-library.js | 16 | None | None | None | ✓ Safe |
| xetex-dvipdfm-library.js | 18 | None | None | None | ✓ Safe |

**Total: 4154 lines, all authored (no minification or obfuscation detected)**

## Per-File Details

### pdftex-worker.js (1910 lines)

**Network calls:**
- Line 582: `XMLHttpRequest` for TeX Live CDN file fetches (sync, format-specific URLs)
- Line 690: `XMLHttpRequest` for PK font fetches (sync, format-specific URLs)
- URL origin: Host-supplied via `setTexliveEndpoint()` (line 1349), constructs via `self.texlive_endpoint + "pdftex/" + format + "/" + name`

**postMessage calls:**
- Lines 91, 98, 579, 1122: Payload includes compilation results (PDF/SyncTeX as ArrayBuffer transfers), logs, exit status
- Lines 579, 1467-1500: Exports cached TeX Live files for host persistence via `dumpcache` command
- No file contents except compiled outputs/logs are sent

**importScripts calls:**
- Line 27: `wasmtex-pdftex-resolver-evidence.js` (local)
- Lines 1896, 1902, 1908: Conditionally loads `wasmtex-kpse-resolve.js`, `wasmtex-pdftex-checkpoint.js`, or `wasmtex-pdftex.js` (all local)

**Other findings:**
- Bloom filter validation at line 1393: Magic bytes "BF01" verified before use
- No eval, new Function, or dynamic imports
- All URLs derived from host-supplied `texlive_endpoint` + static format/format mapping

### xetex-worker.js (433 lines)

**Network calls:**
- Line 58: `XMLHttpRequest` for ICU data (CDN endpoint set by host via `settexliveurl`)
- Line 394: `XMLHttpRequest` for TeX Live files (format-based URL routing)
- URLs: Host-supplied `texlive_endpoint` + `"pdftex/" + dir + "/" + filename"`

**postMessage calls:**
- Lines 80, 235-245: Compilation results (XDV output, logs, inputFiles)
- Line 410: Download progress notifications
- No raw file contents sent except outputs

**importScripts:**
- Line 19: `wasmtex-xetex-resolver-evidence.js` (local)
- Line 432: `wasmtex-xetex.js` (local)

**Other findings:**
- No eval, new Function, or dynamic imports
- Font-by-name path disabled at line 426 (returns 0)
- All URLs from host configuration

### luatex-worker.js (595 lines)

**Network calls:**
- Line 169: `XMLHttpRequest` for luaotfload names database (sync fetch, cached)
- Line 526: `XMLHttpRequest` for kpse file resolution (multiple candidates with bloom-filter optimization)
- URLs derived from host-supplied endpoint

**postMessage calls:**
- Lines 278-299: Compilation output (PDF, logs, inputFiles)
- Line 365: Download progress with CDN directory info
- Line 403: Cache export for persistence
- No project file contents sent except outputs

**importScripts:**
- Line 24: `wasmtex-luatex-resolver-evidence.js` (local)
- Line 594: `wasmtex-luatex.js` (local)

**Other findings:**
- Bloom filter support at line 446 (validates magic bytes)
- No eval, Function, or dynamic code execution
- Extension-based routing (Lua, OTF, TTF, PFB, AFM, TFM)

### dvipdfm-worker.js (380 lines)

**Network calls:**
- Line 321: `XMLHttpRequest` for font file resolution (loops through CDN candidates)
- URLs: Host-supplied endpoint + directory/filename from `cdnCandidates()` function
- Supports multiple font container formats (OTF, TTF, TTC, PFB)

**postMessage calls:**
- Lines 173-178: Compilation output (PDF buffer)
- Line 360: Download progress
- Line 250: Cache dump

**importScripts:**
- Line 19: `wasmtex-xetex-resolver-evidence.js` (local)
- Line 380: `wasmtex-dvipdfm.js` (local)

**Other findings:**
- No eval, Function, or dynamic imports
- Heap snapshot restoration before each compile (for state cleanup)
- Path normalization at line 302 strips cache-root prefix to avoid rejection

### bibtex-worker.js (251 lines)

**Network calls:**
- Line 89: `XMLHttpRequest` for BibTeX/bibliography resource fetches (smart extension retry)
- URL: `self.texlive_endpoint + "pdftex/" + format + "/" + name`

**postMessage calls:**
- Lines 195-199, 205-207: Compilation logs and status
- Line 221: File write confirmations
- No payload carries file contents

**importScripts:**
- Line 251: `wasmtex-bibtex.js` (local)

**Other findings:**
- No eval, Function, or dynamic code
- Smart retry logic (bare name if extension fails) at lines 105-131

### bibtex8-worker.js (223 lines)

**Network calls:**
- Line 85: `XMLHttpRequest` for .bib/.bst file fetches (same retry as bibtex-worker.js)

**postMessage calls:**
- Lines 167-171: Compilation logs and status
- Line 203: File confirmations
- No raw contents sent

**importScripts:**
- Line 223: `wasmtex-bibtex8.js` (local)

**Other findings:**
- Identical to bibtex-worker.js but drives `_compileBibtex8`
- No eval, Function, or dynamic imports

### makeindex-worker.js (208 lines)

**Network calls:**
- Line 90: `XMLHttpRequest` for optional `.ist` style file lookup
- URL construction identical to other workers

**postMessage calls:**
- Lines 152-156: Compilation logs and status
- Line 178: File write confirmations

**importScripts:**
- Line 208: `wasmtex-makeindex.js` (local)

**Other findings:**
- No eval, Function, or dynamic code
- kpse hook only exercised when `-s style.ist` passed by host

### kpse-resolve.cjs (70 lines)

**Purpose:** Pure helper functions for kpathsea name resolution (shared by workers and tests)

**Functions:**
- `retryExtensions()`: Returns format-specific retry extensions (no network)
- `bloomCandidates()`: Generates bloom-filter check keys
- `fetchCandidates()`: Orders candidates for fallback fetch

**Security:**
- No network calls, no eval, no dynamic code
- CommonJS export at line 68 (harmless in worker context where module is undefined)
- All logic deterministic based on format ID and requested name

### resolver-evidence.js (16 lines)

**Purpose:** Telemetry helper for TeX Live resolver outcomes

**postMessage calls:**
- Line 5: Sends resolver evidence (name, format, outcome, attempts)
- Line 15: Sends `resolverready` signal

**Security:**
- Sanitization at line 8: `String(requestedName).slice(0, 512)` caps input
- Attempt array truncated to 8 entries max at line 4
- No network, eval, or dynamic code

### library.js (23 lines)

**Purpose:** Emscripten glue for pdfTeX kpse hooks (C → JS bridge)

**Functions:**
- `kpse_find_file_js()`: Routes C-side kpse lookups to worker's `kpse_find_file_impl()`
- `kpse_find_pk_js()`: Routes PK font lookups to worker's `kpse_find_pk_impl()`

**Security:**
- Emscripten library syntax, no network or eval
- Delegates to worker implementations (reviewed above)

### luatex-library.js, xetex-library.js (16-18 lines)

**Purpose:** Emscripten glue for LuaTeX and XeTeX engines

**Security:**
- Same pattern as library.js
- Route to worker implementations
- No network, eval, or dynamic code

### xetex-dvipdfm-library.js (18 lines)

**Purpose:** Emscripten glue for dvipdfmx (from-source build)

**Security:**
- 3-argument signature matches dvipdfmx's wrapper
- Routes to dvipdfm-worker.js implementation

## Cross-File Analysis

**URL Construction Pattern:** All 8 workers use identical pattern:
```javascript
var url = self.texlive_endpoint + "pdftex/" + format + "/" + name;
```
- `texlive_endpoint` comes exclusively from host via `settexliveurl` command
- No hard-coded endpoints, no fallback URLs, no embedded CDN domains

**postMessage Protocol:** Consistent across workers:
- Commands dispatched by `cmd` field
- Responses include `result`, `status`, `log`, `cmd` fields
- File transfers use ArrayBuffer with explicit transferables
- No file contents sent except: compiled outputs (PDF/XDV/format), logs, metadata

**File Fetching:** Uses synchronous XMLHttpRequest (blocking, required for TeX Live on-demand model)
- No fetch API or async variants
- Timeout set appropriately (150s for large files)
- No cookie/credential handling (public CDN, CORS-free)

## Security Findings

**Network:**
- All network calls are XMLHttpRequest for TeX Live CDN
- URLs always derived from host-supplied `texlive_endpoint`
- No hard-coded hostnames, no fallback CDN URLs
- No navigator, EventSource, or WebSocket usage
- No credential handling (public mirror)

**Code Execution:**
- No `eval()`, `new Function()`, `Function()`, or `setTimeout(...code)`
- No dynamic `import()` statements
- importScripts loads only local Emscripten outputs and evidence helpers
- No script-loading from external sources

**Data Handling:**
- postMessage payloads: compilation outputs (PDF/log), metadata, cached file lists
- No user project files sent except via explicit readfile/writefile commands
- Input sanitization: bloom filter data validated, resolver evidence truncated

**Code Quality:**
- No minification, obfuscation, or base64 encoding detected
- All code is readable and authored (no generated glue except Emscripten modules)
- Comments explain key decisions (bloom filter, heap snapshots, preamble caching)

## Verdict

**Low risk. No supply-chain vulnerabilities detected.**

All network I/O is:
- Read-only (TeX Live CDN mirrors)
- URL-controlled by host (no embedded URLs)
- Scoped to TeX files (no write to network, no outbound telemetry beyond resolver evidence)

All code is authored, readable, and free of eval/Function/dynamic-import patterns that could enable injection attacks. The workers follow a clear, single-purpose architecture: compile TeX → fetch missing files from host-configured endpoint → return PDF + logs.
