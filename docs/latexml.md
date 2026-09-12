# LaTeXML HTML renderer

The LaTeXML browser engine converts a staged LaTeX project to HTML in a Web
Worker. Its runtime payload is `latexml.worker.js`, `latexml.js`,
`latexml.wasm`, the shared resolver and bundle helpers, the LaTeXML CSS sheets,
and `latexml.build.json`. The worker inlines the CSS links emitted by
LaTeXML, including document-class sheets, and rewrites project image URLs to
data URLs so the returned HTML can be rendered in an isolated iframe.

The wrapper enables LaTeXML's Graphics postprocessor before HTML conversion.
It resolves each digested `graphicx` node and computes `imagewidth` and
`imageheight` from its TeX dimensions and the source image's intrinsic size.
Thus `width=0.12\linewidth` is evaluated in the current TeX context, including
macros and minipages; it is not reconstructed from source text or converted
to a viewport percentage by JavaScript.

Sources live in `/work` and generated graphics in `/output` in the worker's
virtual filesystem. The worker embeds the referenced output bytes without
changing HTML dimensions. Both directories are cleared between snapshots.
PNG/JPEG and SVG sizing uses the upstream processor's native copy-and-size
path. Operations that require external image-converter executables remain
subject to the browser runtime's limitations.

LaTeXML is built from the pinned `latexml-oxide` checkout in
`wasm-build/latexml-source.ref`. Its native libxml2, libxslt, and kpathsea
inputs are separate source components. A release therefore carries a
`latexml.build.json` receipt naming the exact source commits, archive hashes,
licenses, notices, Cargo lock graph (including `libmarpa-asf-sys` where linked),
and artifact hashes. The TeX Live source receipt covers the TeX engines and
kpathsea source; it is not a substitute for the LaTeXML source receipt.
The shipped notices include the upstream CC0 text, the libxml2/libxslt
Copyright/COPYING files, and libmarpa's MIT and LGPL COPYING files.
The receipt also records the embedded `plain.YYYY.dump.txt` and
`latex.YYYY.dump.txt` files, their `texlive.YYYY.version` stamp, and each
SHA-256. The current build image's host TeX Live produces the 2023 pair;
the runtime chooses a matching on-disk year when one is supplied and otherwise
falls back to the newest embedded pair. A mirror's TeX Live 2026 package tree
does not relabel a 2023 LaTeXML snapshot; a build made with a 2026 host records
and embeds the 2026 pair separately.
The corresponding-source builder copies the receipt-verified snapshots from
`dist/latexml-kernels` into `latexml-oxide/resources/dumps` in the source
archive.
LaTeXML is compiled with the separately pinned Emscripten 6.0.9 image
(`sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc`)
and nightly Rust `2026-08-02`; the TeX engines continue to use Emscripten 3.1.46.
After the WASM link, run `node tools/link-inventory.mjs --family latexml
--dist wasm-build/dist --out receipts/LINK-INVENTORY.latexml.json`; it requires
the actual `latexml.map` and records native inputs while keeping the Cargo graph
conservative.

Build the engine into `wasm-build/dist/` with:

```sh
docker build -f wasm-build/Dockerfile.latexml -t librepaper-latexml-wasm .
docker run --rm -e LATEXML_DIST_DIR=/dist -v "$PWD/wasm-build/dist:/dist" librepaper-latexml-wasm
```

The protocol check uses a mocked Emscripten module and the real BundleMode and
resolver helpers:

```sh
node wasm-build/latexml-worker.test.cjs
```

See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and the receipt in a
staged release for the complete redistribution terms.
