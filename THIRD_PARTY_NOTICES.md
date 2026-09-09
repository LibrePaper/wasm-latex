# Third-Party Notices

The MIT license in [`LICENSE`](LICENSE) applies to this repository's own code and
documentation unless a file says otherwise. It does not relicense third-party code,
generated engine artifacts, TeX Live files, fonts, or data. Those materials remain
under their respective licenses.

This notice records the components known to be used by the current source tree. A
binary or CDN distributor must also retain every notice from the exact source and
data files included in that release.

**Scope.** This repository tracks source only: no engine binaries, formats, or
TeX Live files are committed (`wasm-build/dist/` and `vendor/` are ignored). The
obligations below attach to the artifacts a build produces and to anyone who
distributes them, which is why the notices are kept here rather than only in the
place binaries eventually land. Sections describing files this repository does not
contain have been removed; what remains describes what a build here links or emits.

## WasmTex

This repository's build layer was seeded from WasmTex
(<https://github.com/corca-ai/wasmtex>), which is MIT-licensed. Much of
`wasm-build/` is that code, modified or verbatim,
and it remains under its own copyright and notice.

- Copyright: 2025-2026 WasmTex contributors
- License: MIT
- Notice: [`LICENSES/WasmTex.txt`](LICENSES/WasmTex.txt)
- Provenance and the exact snapshot seeded: [`README.md`](README.md)

Retaining that notice is a condition of the MIT license and applies to any
distribution of this repository or a work derived from it.

## SyncTeX

The engines are built with SyncTeX support: `wasm-build/Makefile` compiles
`texk/web2c/synctexdir/synctex.c` from the pinned TeX Live source into every
pdfTeX unit, under renamed symbols. The code is by Jérôme Laurens.

- Copyright: 2008-2017 Jérôme Laurens
- License: MIT-like permission notice with a non-endorsement clause
- Notice: [`LICENSES/SyncTeX.txt`](LICENSES/SyncTeX.txt)
- Upstream: <https://github.com/TeX-Live/texlive-source/tree/trunk/texk/web2c/synctexdir>

## TeX Live engine artifacts

The engine build is pinned to TeX Live source commit
`fb6158926661cb7a7246b3a94a0cb170a9624d5a` (`wasm-build/texlive-source-2026.ref`). The generated JavaScript, WebAssembly,
worker, and format files a build writes to `wasm-build/dist/` are
not covered solely by the WasmTex MIT license.

| Artifact family | Principal upstream terms |
| --- | --- |
| pdfTeX | **GPL-2.0-only for this combined release**: pdfTeX permits GPL-2.0-or-later, while the linked Xpdf 4.06 copy is selected under GPL-2.0-only. Web2C, kpathsea, SyncTeX, libpng, zlib, and other notices are retained. |
| BibTeX | The BibTeX 0.99d/TeX notice in `LICENSES/BibTeX.txt`, Web2C notices, and LGPL-2.1-or-later kpathsea with complete-source relink support. |
| BibTeX8 | GPL-2.0-or-later source in `texk/bibtex-x`, plus kpathsea and linked-library terms. |
| makeindex | The identical MakeIndex Distribution Notice, plus LGPL-2.1-or-later kpathsea with complete-source relink support. The WebAssembly port is a modified version and the release notice says how to obtain its source. |
| XeTeX | **GPL-2.0-only for this combined release**, plus the XeTeX notice. Xpdf 4.06 and FreeType are selected under GPL-2.0-only. The MIT WTPDF adapter, LGPL kpathsea/Graphite2/TECkit, ICU, HarfBuzz, libpng, zlib, and other notices are retained. |
| dvipdfmx | GPL-2.0-or-later terms, plus kpathsea, FreeType, libpng, zlib, and other linked-library terms. |
| LuaHBTeX | **GPL-2.0-only for this combined release**: LuaHBTeX permits GPL-2.0-or-later and Xpdf 4.06 is selected under GPL-2.0-only. The MIT WTPDF/SHA-2 code, LGPL kpathsea/Graphite2/zziplib, Lua and other embedded-library notices are retained. |

Relevant license texts included here are:

- [`LICENSES/GPL-2.0.txt`](LICENSES/GPL-2.0.txt)
- [`LICENSES/GPL-3.0.txt`](LICENSES/GPL-3.0.txt)
- [`LICENSES/LGPL-2.1.txt`](LICENSES/LGPL-2.1.txt)
- [`LICENSES/MakeIndex.txt`](LICENSES/MakeIndex.txt)
- [`LICENSES/BibTeX.txt`](LICENSES/BibTeX.txt)
- [`LICENSES/XeTeX.txt`](LICENSES/XeTeX.txt)
- [`LICENSES/SyncTeX.txt`](LICENSES/SyncTeX.txt)
- [`LICENSES/Aladdin-MD5.txt`](LICENSES/Aladdin-MD5.txt)
- [`LICENSES/Xpdf-4.06-GPL-2.0.txt`](LICENSES/Xpdf-4.06-GPL-2.0.txt)
- [`LICENSES/Xpdf-4.06-README.txt`](LICENSES/Xpdf-4.06-README.txt)

The exact component-to-license mapping for what our builds actually link is
machine-readable in [`linked-components.json`](linked-components.json), and
`tools/link-inventory.mjs` checks a build against it, failing on any component it
cannot classify. That is a gate, and it runs: see
[`docs/licensing.md`](docs/licensing.md).

Upstream published its own component inventory with its release. It is theirs to
distribute and is not carried here; the mapping above is ours, derived from the
link maps of the binaries this repository produces.

Corresponding source means the pinned TeX Live source plus the WasmTex glue, patches,
build scripts, Dockerfiles, and any other material needed to rebuild the distributed
object code. The build inputs are described in `wasm-build/` and
`wasm-build/texlive-source-2026.ref`. A distributor must make a complete source bundle
available with each binary release; an upstream link alone is not a substitute for
that bundle.

### MakeIndex source-obtainment statement

**The WebAssembly port is a modified version of MakeIndex.** Its executable is
accompanied by the conspicuous permission notice in
[`LICENSES/MakeIndex.txt`](LICENSES/MakeIndex.txt). The exact machine-readable source
for the port is the corresponding-source archive named by the adjacent engine
`LICENSE-MANIFEST.json` under `correspondingSource.url`; verify it with the recorded
SHA-256. Do not distribute MakeIndex while that field is empty or inaccessible.

### Legacy pplib licensing evidence

Legacy LuaHBTeX and XeTeX artifacts included `pplib`. The pinned TeX Live copy and
the public pplib repository do not contain a standalone license grant that is
sufficient for WasmTex to record exact redistribution terms. Inclusion in TeX Live
is useful context, but it is not a replacement for a license notice from the
copyright holder.

Do not publish any legacy `pplib`-linked browser artifact as a cleared release.
Such an artifact would require one of the following:

- an explicit upstream license or written redistribution grant covering pplib;
- a licensed replacement for pplib; or
- a build and link audit proving that the distributed artifact no longer contains it.

This is a documentation/evidence blocker; it is not a claim that upstream lacks a
valid private or historical grant.

Upstream reported that its WTPDF/Xpdf XeTeX and LuaHBTeX candidates no longer contain
this dependency, in build-evidence documents (`xetex-wtpdf-23f2ce1.md`,
`luahbtex-wtpdf-666663b.md`) that were not seeded into this repository. Neither engine
has been built here yet. Treat the blocker as standing for anything built here until
a link audit of our own XeTeX and LuaHBTeX artifacts is recorded — a WasmTex claim
whose evidence we do not hold is not our evidence. Linked
component notices, license selections, and the relink method are now recorded in the
machine-readable inventory; the corresponding-source, security, compatibility, and
public-audit gates still apply.

## Aladdin MD5

`texk/web2c/libmd5/md5.c` by L. Peter Deutsch is compiled into pdfTeX. It carries
a zlib-style permission notice that may not be removed or altered.

- Copyright: 1999, 2000, 2002 Aladdin Enterprises
- License: Zlib-style
- Notice: [`LICENSES/Aladdin-MD5.txt`](LICENSES/Aladdin-MD5.txt)

It was linked with no notice retained until `tools/link-inventory.mjs` read it
out of the link map.

## Emscripten and ports

Engine artifacts are generated with Emscripten 3.1.46. Emscripten is distributed
under the MIT and University of Illinois/NCSA licenses and incorporates separately
licensed runtime code. See [`LICENSES/Emscripten-3.1.46.txt`](LICENSES/Emscripten-3.1.46.txt).

Emscripten ports retain their upstream licenses. In particular, current builds use
ports including FreeType, ICU, libpng, and zlib. FreeType is dual-licensed; this
release selects its **GPL-2.0-only** option for the XeTeX unit.

The Xpdf version matters to that selection, and the prose here previously said
4.04 while the pinned TeX Live source ships 4.06. Verified against the source the
build actually compiles: `libs/xpdf/xpdf-src` reports `xpdfVersion "4.06"`, and its
`COPYING`, `COPYING3`, and `README` are byte-identical to
`LICENSES/Xpdf-4.06-GPL-2.0.txt`, `LICENSES/GPL-3.0.txt`, and
`LICENSES/Xpdf-4.06-README.txt`. The 4.04 texts have been removed;
WasmTex's `ENGINE-COMPONENTS.json` already recorded 4.06. The alternative
FreeType License is retained for provenance in
[`LICENSES/FreeType.txt`](LICENSES/FreeType.txt), but is not the selected license for
that combined binary.

The Emscripten sysroot also contributes musl libc, dlmalloc, libc++, libc++abi, and
compiler-rt. Their retained notices include [`LICENSES/musl.txt`](LICENSES/musl.txt),
Apache-2.0 and [`LICENSES/LLVM-exception.txt`](LICENSES/LLVM-exception.txt). The LLVM
exception expressly addresses GPLv2 combined software.

Notices for libraries linked by one or more current engines are also retained in:

- [`LICENSES/HarfBuzz.txt`](LICENSES/HarfBuzz.txt)
- [`LICENSES/Graphite2.txt`](LICENSES/Graphite2.txt)
- [`LICENSES/TECkit.txt`](LICENSES/TECkit.txt)
- [`LICENSES/libpng.txt`](LICENSES/libpng.txt)
- [`LICENSES/zlib.txt`](LICENSES/zlib.txt)
- [`LICENSES/zziplib.txt`](LICENSES/zziplib.txt)
- [`LICENSES/LGPL-2.0.txt`](LICENSES/LGPL-2.0.txt)

## ICU data

`icudt68l.dat` is built from ICU 68.2 source and data. It is governed by the ICU
license and the third-party notices contained in the exact ICU 68.2 release. See
[`LICENSES/ICU-68.2.txt`](LICENSES/ICU-68.2.txt).

## TeX Live packages, fonts, Lua files, and formats

The separately operated versioned CDN mirrors the full official TeX Live 2025
distribution. TeX Live is an aggregation: individual packages and fonts can use
LPPL, SIL OFL, GPL, permissive, public-domain, or other terms. Generated `.fmt` files
are compiled works whose source inputs retain their own terms. None of these files is
licensed by WasmTex under MIT.

The LaTeX kernel and many base packages use LPPL 1.3c. The authoritative license
text is available from the LaTeX Project at
<https://www.latex-project.org/lppl/lppl-1-3c/>. A release must retain the exact
license and source material belonging to each mirrored package rather than assuming
that every TeX Live file uses LPPL.

The full mirror must preserve the official distribution's copying information and
the license/source materials shipped for its packages. A package-by-package manual
override database is not a WasmTex engine-release gate. The exact inputs and creation
procedure for `.fmt` files distributed with an engine release remain part of that
release's evidence. See <https://tug.org/texlive/copying.html> and the scope in
[`docs/licensing.md`](docs/licensing.md).

## Application-side components

Monaco Editor, PDF.js, and pdf-lib are dependencies of the LibrePaper editor, not of
anything built here. Their notices belong with whatever ships them and are no longer
carried in this repository.
