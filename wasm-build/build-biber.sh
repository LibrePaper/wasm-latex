#!/usr/bin/env bash
# Run inside Dockerfile.biber, with only the experimental output mounted.
set -euo pipefail
mkdir -p /opt/perl-wasm /out
bash /src/texlyre-biber/biber/build_biber.sh
node /src/biber-smoke.cjs "$BUILD"
bash /src/export-biber.sh
