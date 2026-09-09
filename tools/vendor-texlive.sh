#!/usr/bin/env bash
# Fetch, verify and unpack the TeX Live texmf release archive into vendor/,
# then generate the font map that no archive contains. Every later step of the
# pipeline reads from what this writes. Idempotent: an archive already on disk
# is verified, not re-downloaded; an extracted tree is left alone; the map is
# regenerated only when missing. docs/texlive-snapshot-2026.md records the
# values checked the first time this ran.
#
#   tools/vendor-texlive.sh            # defaults below
#   TEXLIVE_YEAR=2026 TEXLIVE_DATE=20260301 tools/vendor-texlive.sh
set -euo pipefail

YEAR=${TEXLIVE_YEAR:-2026}
DATE=${TEXLIVE_DATE:-20260301}
BASE=${TEXLIVE_BASE:-https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/$YEAR}
KEY_URL=https://tug.org/texlive/files/texlive.asc
# TeX Live Distribution <tex-live@tug.org>. A key file that does not carry
# this fingerprint is not the key, whatever tug.org served.
FINGERPRINT=${TEXLIVE_KEY_FINGERPRINT:-C78B82D8C79512F79CC0D7C80D5E5D9106BAB6BC}

ARCHIVE=texlive-$DATE-texmf.tar.xz
DIR=vendor/texlive-$YEAR
DIST=$DIR/texlive-$DATE-texmf/texmf-dist
VAR=$DIR/texmf-var

for tool in curl gpg gpgv sha512sum tar xz updmap; do
  command -v "$tool" >/dev/null || { echo "vendor: $tool is not on PATH" >&2; exit 1; }
done

mkdir -p "$DIR"
cd "$DIR"

# 1. The signed hash, and the key that signed it.
[ -f "$ARCHIVE.sha512" ] || curl -sSfO "$BASE/$ARCHIVE.sha512"
[ -f "$ARCHIVE.sha512.asc" ] || curl -sSfO "$BASE/$ARCHIVE.sha512.asc"
[ -f texlive.asc ] || curl -sSfo texlive.asc "$KEY_URL"

export GNUPGHOME
GNUPGHOME=$(mktemp -d); chmod 700 "$GNUPGHOME"
gpg -q --import texlive.asc
if ! gpg --with-colons --fingerprint | grep -q "^fpr:.*:$FINGERPRINT:"; then
  echo "vendor: texlive.asc does not carry the TeX Live distribution key $FINGERPRINT" >&2
  exit 1
fi
gpg -q --export > tl.gpg
gpgv --keyring ./tl.gpg "$ARCHIVE.sha512.asc" "$ARCHIVE.sha512" 2>&1 | sed 's/^/vendor: /'

# 2. The archive, checked against the hash the signature covers.
[ -f "$ARCHIVE" ] || curl -sSf -C - -O "$BASE/$ARCHIVE"
sha512sum -c --quiet "$ARCHIVE.sha512"
echo "vendor: $ARCHIVE verified ($(wc -c < "$ARCHIVE") bytes)"

# 3. Extract once.
if [ -d "texlive-$DATE-texmf/texmf-dist" ]; then
  echo "vendor: texmf-dist already extracted"
else
  echo "vendor: extracting (several minutes, 9 GB)"
  tar -xJf "$ARCHIVE"
fi
cd - >/dev/null

# 4. The generated font map. updmap is a local TeX Live's script, but every
# input it reads and every byte it writes comes from the tree above.
if [ -f "$VAR/fonts/map/pdftex/updmap/pdftex.map" ]; then
  echo "vendor: pdftex.map already generated"
else
  echo "vendor: running updmap into texmf-var"
  mkdir -p "$VAR"
  TEXMFDIST=$PWD/$DIST TEXMFMAIN=$PWD/$DIST TEXMFVAR=$PWD/$VAR TEXMFSYSVAR=$PWD/$VAR \
  TEXMFCONFIG=$PWD/$VAR TEXMFSYSCONFIG=$PWD/$VAR TEXMFHOME=$PWD/$VAR \
    updmap --quiet --nohash --cnffile "$PWD/$DIST/web2c/updmap.cfg"
fi
echo "vendor: pdftex.map $(wc -c < "$VAR/fonts/map/pdftex/updmap/pdftex.map") bytes"
echo "vendor: ready at $DIST and $VAR"
