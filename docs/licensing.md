# Licensing and release compliance

What this repository may distribute, on what terms, and what has to be true
before it does. Scoped to what it actually builds: pdfTeX, BibTeX, BibTeX8,
makeindex, XeTeX and dvipdfm, each with its own link inventory under
`receipts/`. LuaHBTeX is not built and has no terms established; WasmTex's
version of this document, in git history, is where its policy would start.

Nothing here is legal advice. It is a record of the obligations we identified,
the reasoning, and where the evidence lives.

## When the obligations bite

On distribution. This repository tracks no binaries, so today it distributes
nothing and owes nothing. The moment a `.wasm` or `.fmt` is served to a browser
— from LibrePaper, a CDN, an npm package, anywhere — the terms below apply to
whoever serves it. Serving over the network is distribution; a CDN in front of
it changes nothing.

## The terms

Each engine is one statically linked program, so its distribution terms must be
satisfiable by every linked component at once. What is linked is not assumed: it
is read out of the link maps by `tools/link-inventory.mjs` and recorded in
`receipts/LINK-INVENTORY.<family>.json`.

| Family | Combined terms |
|---|---|
| pdfTeX (`wasmtex-pdftex`, `wasmtex-pdftex-checkpoint`) | `GPL-2.0-only` |
| BibTeX (`wasmtex-bibtex`) | `LicenseRef-BibTeX-Web2C-Notices AND LGPL-2.1-or-later` |

**Why pdfTeX is GPL-2.0-only.** pdfTeX and web2c are GPL-2.0-or-later, which v2
satisfies. The linked Xpdf 4.06 is offered under "GPL v2 or v3"; v2 is elected,
and because v2-only and v3 code cannot be combined, that election fixes the whole
unit at GPL-2.0-only. This is a choice, recorded in
`linked-components.json`, not an inference.

**Why BibTeX differs.** BibTeX links no Xpdf, libpng or zlib — verified, not
assumed. Its only copyleft component is kpathsea; the BibTeX and web2c sources
carry permission notices rather than the GPL.

**Formats are not engine code.** A `.fmt` is a compiled dump of LPPL- and
otherwise-licensed TeX Live inputs and carries those inputs' terms, not the
engine's. Every input is recorded with its hash in
`receipts/FORMAT-RECEIPT.*.json`.

**The MIT boundary.** This repository's own code — build glue, shims, `tools/` —
is MIT (`LICENSE`), and so is the WasmTex layer it was seeded from
(`LICENSES/WasmTex.txt`). That MIT never describes an engine artifact. npm
metadata, package labels and repository badges must not be allowed to imply it
does; the engines are GPL and are separately delivered.

## What must accompany a distributed binary

1. **The notices.** Every notice its link inventory lists, plus
   `THIRD_PARTY_NOTICES.md` explaining what applies where. `tools/stage-release.mjs`
   copies exactly these; `tools/check-release.mjs` refuses a directory missing any.
2. **The complete corresponding source** — GPL-2.0 §3. Not a link to TeX Live or
   to this repository: the source, published where the binary is.
   `tools/build-corresponding-source.mjs` assembles it (this repository at the
   building commit, plus the TeX Live tree taken out of the build image), hashes
   it, and writes `receipts/SOURCE-RECEIPT.json`. `SOURCE.md` in the staged
   directory tells the recipient where it is.
3. **A working relink path for kpathsea** — LGPL-2.1 §6. kpathsea is the only
   LGPL component in either engine and is linked statically; static linking does
   not dissolve its terms. `RELINK.md` is the recipe, and the
   Dockerfile takes a `texlive-source/` tree from its build context so a modified
   library can actually be built in. A recipe that does not work does not
   discharge the obligation.
4. **Emscripten's generated license comments** must survive whatever minifier or
   bundler the artifacts pass through.
5. **The format's input receipt**, wherever a `.fmt` is served.

### What the source archive contains

| Path in the archive | What |
|---|---|
| `repo/` | This repository at the commit that built the artifacts: Dockerfile, Makefile, C shims, worker controller, patches, tools, notices. |
| `texlive-source/` | The pinned TeX Live tree, read out of the build image rather than cloned again. Contains kpathsea, zlib, libpng, xpdf, web2c, synctex and libmd5. |
| `MANIFEST.json` | The artifacts this source corresponds to, with SHA-256; the TeX Live commit; the digest-pinned Emscripten image. |
| `REBUILD.md`, `RELINK.md` | How to rebuild the engines from the archive, and how to substitute a modified LGPL library and relink. |

Taking the tree out of the image, rather than re-cloning it, removes a step
where the archive could quietly diverge from the binary: a re-clone can differ
if the pin is wrong, if a tag moved, or if the fetch was patched. The manifest
still records the commit, so the archive can be checked against the TeX Live
repository it came from.

The Emscripten runtime pieces linked into the binaries (musl libc, libc++,
libc++abi, compiler-rt, dlmalloc) come from the digest-pinned `emscripten/emsdk`
image, which the manifest names exactly. Their source is Emscripten's, at that
digest; their notices are in `repo/LICENSES/`.

## The gate

    make inventory                       # every family: tools/link-inventory.mjs
    make source                          # tools/build-corresponding-source.mjs
    make stage SOURCE_URL=<published URL>  # tools/stage-release.mjs --bundles
    make check                           # tools/check-release.mjs

The full sequence, including publishing the archive, is in
[`release.md`](release.md).

`check-release.mjs` verifies that every artifact is named and unmodified, that
every linked component has a recorded license and source, that every required
notice is present, that an LGPL component is accompanied by the relink recipe,
that the corresponding source is named, hashed, built from a clean tree and
built for these exact bytes, and that every format declares its inputs. It fails
closed: an unclassifiable component is a component whose redistribution basis
nobody has established, and it stops the release.

`link-inventory.mjs` is the part that catches drift, because it reads the
binary's own link map. It is how we found that the notices had claimed Xpdf 4.04
when the build links 4.06, and that `libmd5` (Aladdin/zlib terms) was linked
with no notice retained at all.

## What is still owed

SPEC-latex.md's implementation status lists the gaps in the work generally. These are
the ones specific to the obligations:

- **Terms for LuaHBTeX.** It has no link inventory, and its `pplib` question
  has to be settled against artifacts we built; WasmTex's evidence for that
  was never seeded here (see `THIRD_PARTY_NOTICES.md`).
- **BibTeX8's notice text.** Its sources are GPL-1.0-or-later and the shipped
  notice is the GPL-2.0 text, which the "or later" permits; a GPL-1.0 text is
  not in `LICENSES/`.
- **An SBOM**, if downstream consumers want one. The link inventory has the
  information; nothing emits SPDX.
