# Rebuilding Biber from the release source

This archive contains the patched sources actually compiled (`src/`), the
exact pure Perl files supplied by the build host (`host-perl5/`), the packaged
runtime (`runtime/`), the Emscripten source including runtime and LZ4 support
(`emscripten/`), notices, package versions, and the vendored build recipe.
The top-level release source archive additionally contains LibrePaper's host
worker and release tooling at its recorded commit.

Build the tooling image from the enclosing repository using
`wasm-build/Dockerfile.biber`. To rebuild with this archive's sources, start
that image with a shell entrypoint and mount this extracted directory at
`/frozen` and an empty output directory at `/out`, then run:

```sh
mkdir -p /build/biber/src
cp -a /frozen/src/. /build/biber/src/
cp -a /frozen/host-perl5/. /usr/share/perl5/
bash /src/build-biber.sh
```

The vendored fetcher skips source directories already present. The Perl
patch marker is retained because these sources are already patched. Build
tools and native Perl still come from the container's OS packages; their
versions are recorded in `build-packages.txt`. Source availability is not a
claim that the entire toolchain produces bit-identical binaries across hosts.
