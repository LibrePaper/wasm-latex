# Licensing and release compliance

No legal advice. What this repository may distribute:
- What it builds: pdfTeX, BibTeX, BibTeX8, makeindex, XeTeX, dvipdfm (LuaHBTeX is not built)
- Each has its own link inventory under `receipts/`
- Scope: the obligations identified, the reasoning, and where the evidence lives

## Obligations

Distribution terms apply:
- When a `.wasm` or `.fmt` is served to a browser (from LibrePaper, a CDN, an npm package, anywhere)
- Serving over the network is distribution; a CDN in front changes nothing
- This repository tracks no binaries, so it currently distributes nothing and owes nothing

Each engine is one statically linked program:
- Distribution terms must be satisfiable by every linked component at once
- What is linked is read out of link maps by `tools/link-inventory.mjs`
- Recorded in `receipts/LINK-INVENTORY.<family>.json`

| Family | Combined terms |
|---|---|
| pdfTeX (`pdftex`, `pdftex-checkpoint`) | GPL-2.0-only |
| BibTeX (`bibtex`) | LicenseRef-BibTeX-Web2C-Notices AND LGPL-2.1-or-later |

Why pdfTeX is GPL-2.0-only:
- pdfTeX and web2c are GPL-2.0-or-later; v2 satisfies this
- Linked Xpdf 4.06 is offered under "GPL v2 or v3"; v2 is elected
- v2-only and v3 code cannot be combined, so this election fixes the whole unit at GPL-2.0-only
- This is a choice, recorded in `linked-components.json`, not an inference

Why BibTeX differs:
- BibTeX links no Xpdf, libpng or zlib (verified, not assumed)
- Its only copyleft component is kpathsea
- BibTeX and web2c sources carry permission notices rather than the GPL

Formats are not engine code:
- A `.fmt` is a compiled dump of LPPL- and otherwise-licensed TeX Live inputs
- It carries those inputs' terms, not the engine's
- Every input is recorded with its hash in `receipts/FORMAT-RECEIPT.*.json`

The MIT boundary:
- This repository's own code (build glue, shims, `tools/`) is MIT (`LICENSE`)
- The build layer it was seeded from is MIT (`LICENSES/WasmTex.txt`)
- That MIT never describes an engine artifact
- npm metadata, package labels and repository badges must not imply it does; engines are GPL and separately delivered

## What ships with a binary

1. **The notices**
   - Every notice its link inventory lists, plus `THIRD_PARTY_NOTICES.md` explaining what applies where
   - `tools/stage-release.mjs` copies exactly these
   - `tools/check-release.mjs` refuses a directory missing any

2. **The complete corresponding source** (GPL-2.0 s3)
   - Source must be published where the binary is, not a link to TeX Live or this repository
   - `tools/build-corresponding-source.mjs` assembles it (this repository at building commit, plus TeX Live tree from build image)
   - Hashes it and writes `receipts/SOURCE-RECEIPT.json`
   - `SOURCE.md` in staged directory tells recipient where it is

3. **A working relink path for kpathsea** (LGPL-2.1 s6)
   - kpathsea is the only LGPL component in either engine and is linked statically
   - Static linking does not dissolve its terms
   - [RELINK.md](RELINK.md) is the recipe; Dockerfile takes `texlive-source/` tree from build context
   - Recipe must work to discharge the obligation

4. **Emscripten's generated license comments**
   - Must survive whatever minifier or bundler the artifacts pass through

5. **The format's input receipt**
   - Required wherever a `.fmt` is served

### What the source archive contains

| Path | What |
|---|---|
| `repo/` | This repository at the commit that built the artifacts: Dockerfile, Makefile, C shims, worker controller, patches, tools, notices |
| `texlive-source/` | Pinned TeX Live tree, read out of the build image rather than cloned again. Contains kpathsea, zlib, libpng, xpdf, web2c, synctex and libmd5 |
| `MANIFEST.json` | Artifacts this source corresponds to (with SHA-256), TeX Live commit, and digest-pinned Emscripten image |
| `REBUILD.md`, `RELINK.md` | How to rebuild the engines from the archive, and how to substitute a modified LGPL library and relink |

Taking the tree out of the image, rather than re-cloning, removes a step where the archive could quietly diverge from the binary: a re-clone can differ if the pin is wrong, if a tag moved, or if the fetch was patched. The manifest still records the commit, so the archive can be checked against the TeX Live repository it came from.

The Emscripten runtime pieces linked into the binaries (musl libc, libc++, libc++abi, compiler-rt, dlmalloc) come from the digest-pinned `emscripten/emsdk` image, which the manifest names exactly. Their source is Emscripten's, at that digest; their notices are in `repo/LICENSES/`.

## The gate

    make inventory                       # every family: tools/link-inventory.mjs
    make source                          # tools/build-corresponding-source.mjs
    make stage SOURCE_URL=<published URL>  # tools/stage-release.mjs --bundles
    make check                           # tools/check-release.mjs

The full sequence, including publishing the archive, is in [`release.md`](release.md).

`check-release.mjs` verifies:
- every artifact is named and unmodified
- every linked component has a recorded license and source
- every required notice is present
- an LGPL component is accompanied by the relink recipe
- the corresponding source is named, hashed, built from a clean tree and built for these exact bytes
- every format declares its inputs

It fails closed: an unclassifiable component is one whose redistribution basis nobody has established, and it stops the release.

`link-inventory.mjs` catches drift by reading the binary's own link map. It found that notices had claimed Xpdf 4.04 when the build links 4.06, and that `libmd5` (Aladdin/zlib terms) was linked with no notice retained at all.

## Provenance

This repository was seeded on 2026-09-08 from the engine build layer of WasmTex, <https://github.com/corca-ai/wasmtex> (MIT, see [`LICENSES/WasmTex.txt`](LICENSES/WasmTex.txt)), at the snapshot its 2026 engine release was built from.

| Input | Identity |
|---|---|
| WasmTex build snapshot | 0dddc924cc6e69bd2a4b4630e02efe414f84515e |
| WasmTex wrapper revision LibrePaper evaluated | 44c5861fcdf729838205b00b96ac9509bc7fb677 |
| Engine release reproduced | 2026-8b7946970153c52e |
| TeX Live source commit | fb6158926661cb7a7246b3a94a0cb170a9624d5a (github.com/TeX-Live/texlive-source) |
| TeX Live packages, upstream's | 2026-ba38749b8714505a (their CDN, not used as a build input here) |
| TeX Live packages, ours | texlive-20260301-texmf.tar.xz (signature-verified) |
| Emscripten | 3.1.46, emscripten/emsdk:3.1.46@sha256:2491bc4bf6caf8c41993660822341bc72759cb577363dfe0781f0a2d05f7d357 |
| LaTeXML Emscripten | 6.0.9, emscripten/emsdk:6.0.9@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc (nightly Rust 2026-08-02) |
| Corresponding-source tarball | wasmtex-2026-8b7946970153c52e-source.tar.xz (sha256 a858abfd2d5b0ad7699ccb6b1dab8b45658c32ecac7a08d68c88bf76847b7cf2) |

Copied verbatim from that snapshot:
- `wasm-build/`: Dockerfiles, Makefile, build scripts, C shims, TeX Live patches, worker controllers (the whole TeX-to-wasm layer)
- `LICENSES/`, `THIRD_PARTY_NOTICES.md`, `docs/licensing.md`: the obligations the engines carry (they are GPL; a build we publish must publish its source)

Written since the seed: `tools/`, `receipts/`, and related docs.

Two upstreams:
- **TeX Live** is upstream of the source: C and Pascal that compile into the engines (`texlive-source`, pinned by commit) and packages a document loads (`vendor/`, from the signed release archive)
- **WasmTex** (<https://github.com/corca-ai/wasmtex>) is upstream of the build layer and the published binaries; this repository was seeded from it

The seed was checked once: On 2026-09-08, before anything here was changed, the seed's recipe was run from the pinned TeX Live commit and compared with WasmTex's published `2026-8b7946970153c52e` release receipts. Every compiled file matched byte for byte: `wasmtex-pdftex.wasm` (1,672,898 bytes, sha256 bf0b9fd1772fc78b02ad19eff39f7e03a73d7eefc1c1d05b15387768e57d013d) and `wasmtex-bibtex.wasm` (205,813 bytes, sha256 7ee47f5959d9f2a0d4cbde264be97472b6c1b7a1da2ca58b67baea759b03c3d6) among them. This is history, not process: nothing here compares against WasmTex any more, and the reproduction evidence this repository owes is its own, a rebuild from its published source archive matching its staged manifest.

## What the workers can reach

The seven `wasm-build/*-worker.js` files and their four Emscripten glue files are hand-written JavaScript we distribute and run in the browser. Two properties matter for anything served from them, and neither is visible without reading all 4,154 lines, so they are recorded here with the commands that recheck them.

### No dynamic code

No `eval`, `new Function`, string `setTimeout`, or dynamic `import()` anywhere. `importScripts` loads only files from our own dist directory: the Emscripten module, the kpse resolver, the resolver-evidence helper.

    grep -nE '\beval\(|new Function|Function\(|import\(' wasm-build/*.js wasm-build/*.cjs
    grep -n 'importScripts' wasm-build/*.js

### No embedded endpoint

Every network call is a synchronous `XMLHttpRequest` (required by the on-demand kpathsea model, which blocks inside the engine) and every URL is built the same way: `self.texlive_endpoint + "pdftex/" + format + "/" + name`. `texlive_endpoint` is set only by the host, through the `settexliveurl` command. There is no hard-coded hostname and no fallback URL, so the host decides what the workers may talk to; nothing in these files can send a recipient anywhere on its own.

    grep -nE 'https?://' wasm-build/*.js          # expect no matches
    grep -n 'texlive_endpoint' wasm-build/*.js

Traffic is read-only file fetches, with no credentials and no cookies. `postMessage` carries compiled output (PDF, XDV, format, logs), cache manifests, and resolver evidence (the last truncated to eight attempts and 512 characters per name). Project file contents move only on an explicit `readfile`/`writefile` from the host.

### If either property changes

They are the reason the workers can be published without auditing the host's network policy at the same time. A hard-coded URL or an `eval` in this layer would have to be justified in `THIRD_PARTY_NOTICES.md` terms, not just reviewed: it changes what a recipient of the binaries is exposed to.

## What is still owed

- **Terms for LuaHBTeX**: no link inventory; `pplib` question must be settled against artifacts we built; seed project's evidence was never seeded here (see `THIRD_PARTY_NOTICES.md`)
- **BibTeX8's notice text**: sources are GPL-1.0-or-later and shipped notice is GPL-2.0 text (which "or later" permits); GPL-1.0 text not in `LICENSES/`
- **An SBOM**, if downstream consumers want one (link inventory has the information; nothing emits SPDX)
