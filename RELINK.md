# Relinking kpathsea

kpathsea is licensed **LGPL-2.1-or-later** and is linked statically into every
engine this repository builds. Static linking does not dissolve those terms.
LGPL-2.1 §6 gives two ways to satisfy them; this project takes route (a), the
"provide source" route: the complete source of the library, of everything it is
linked with, and a way for a recipient to substitute a modified kpathsea and
produce a working engine again.

Nothing here is a favour to the recipient — it is the condition on which the
engine may be distributed at all.

## What you receive

The corresponding-source archive (`tools/build-corresponding-source.mjs`; see
`docs/licensing.md` for what it contains) carries:

- `texlive-source/texk/kpathsea/` — the unmodified kpathsea source at the pinned
  TeX Live commit, the exact tree the distributed binary was built from;
- `repo/wasm-build/` — the Dockerfile, Makefile, C shims and worker controller
  that build and link it;
- every other statically linked component's source, in the same archive.

The engine is also relinkable in the ordinary sense: it is object code compiled
from source you have in full, not an opaque blob with a library baked in.

## Substituting your own kpathsea

    tar xf librepaper-wasm-latex-<release>-source.tar.xz
    cd librepaper-wasm-latex-<release>-source

Edit `texlive-source/texk/kpathsea/` as you like, then rebuild. The build takes
the TeX Live tree from the image, so point it at yours:

    docker buildx build --platform linux/amd64 --load \
      --build-arg TEXLIVE_REF=$(cat repo/wasm-build/texlive-source-2026.ref) \
      --build-arg TEXLIVE_SRC_DIR=texlive-source \
      -t relinked-pdftex repo/wasm-build/
    docker run --rm --platform linux/amd64 -v "$PWD/out:/dist" relinked-pdftex

`out/` then holds `pdftex.wasm`, its JavaScript, and the worker,
linked against your kpathsea. `wasm-libs` in the Makefile configures and builds
`texk/kpathsea` explicitly, so a change there is picked up without touching
anything else.

To confirm your library is the one in the artifact, compare the link map:

    grep libkpathsea out/pdftex.map

and the inventory the build produces:

    node repo/tools/link-inventory.mjs --root repo --dist out --family pdftex

## Format files

A `.fmt` is not linked code and is unaffected by relinking. Rebuild one from
your own TeX Live tree with `repo/tools/build-format.mjs`; see
`repo/docs/format-generation.md`.

## If the recipe does not work

That is a defect in this document, and the obligation is not satisfied by a
recipe that fails. Report it against this repository.
