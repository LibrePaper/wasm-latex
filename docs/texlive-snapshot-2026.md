# TeX Live 2026 snapshot

The format build, and eventually the package mirror LibrePaper serves, take
their inputs from one place: the official TeX Live 2026 texmf release archive,
verified against TUG's signed hash. Not from `texlive.corca.ai`, which is
upstream's CDN and cannot be an input to anything we sign off on.

## Obtaining and verifying it

    mkdir -p vendor/texlive-2026 && cd vendor/texlive-2026
    B=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2026
    curl -O $B/texlive-20260301-texmf.tar.xz.sha512 \
         -O $B/texlive-20260301-texmf.tar.xz.sha512.asc \
         -O https://tug.org/texlive/files/texlive.asc

    # The hash file is signed by the TeX Live distribution key; check that
    # before trusting the hash, and the hash before trusting the archive.
    export GNUPGHOME=$(mktemp -d) && chmod 700 $GNUPGHOME
    gpg -q --import texlive.asc && gpg -q --export > tl.gpg
    gpgv --keyring ./tl.gpg texlive-20260301-texmf.tar.xz.sha512{.asc,}

    curl -C - -O $B/texlive-20260301-texmf.tar.xz
    sha512sum -c texlive-20260301-texmf.tar.xz.sha512
    tar -xJf texlive-20260301-texmf.tar.xz

Verified on 2026-09-08:

| Item | Value |
|---|---|
| Archive | `texlive-20260301-texmf.tar.xz`, 4 963 412 512 bytes |
| sha512 | `0b8f8762…d65d4a6b`, matched |
| Signature | Good, `TeX Live Distribution <tex-live@tug.org>`, key `C78B 82D8 C795 12F7 9CC0 D7C8 0D5E 5D91 06BA B6BC`, signed 2026-03-01 |
| Extracted | `texlive-20260301-texmf/texmf-dist`, 9.1 GB |

The same sha512 appears in `scripts/texlive-mirror-2026-initial.json`, which
came from upstream. It agrees with TUG's signed value — so that file is
corroborated, not trusted.

## The generated font map

`texmf-dist` does not contain `pdftex.map`; `updmap` writes it. Without it a
document typesets and then dies at font embedding. Generate it into a
`texmf-var` tree beside the snapshot:

    T=vendor/texlive-2026/texlive-20260301-texmf/texmf-dist
    V=vendor/texlive-2026/texmf-var
    TEXMFDIST=$T TEXMFMAIN=$T TEXMFVAR=$V TEXMFSYSVAR=$V \
    TEXMFCONFIG=$V TEXMFSYSCONFIG=$V TEXMFHOME=$V \
      updmap --quiet --nohash --cnffile $T/web2c/updmap.cfg

This runs a local TeX Live's `updmap` script, but every input it reads and
every byte it writes comes from the 2026 tree — confirm by size if in doubt:
the 2026 map is 5 541 403 bytes, a 2025 one is not.

## The format built from it

    node tools/build-format.mjs --texmf $T --texmf $V \
      --out wasm-build/dist/wasmtex-pdftex.fmt \
      --evidence receipts/FORMAT-RECEIPT.pdftex-2026.json --smoke

| Item | Value |
|---|---|
| `wasmtex-pdftex.fmt` | 3 633 351 bytes |
| sha256 | `f63bc17a1d809184ebfa880a1a78dd81f5351a8934e8618905ff726d0054c962` |
| Inputs | 238 files, each hashed in the receipt |
| Smoke | compiled a document, 29 911 byte PDF |

This is not upstream's `.fmt` and is not meant to be. Theirs is 3 657 154 bytes
and was dumped in a browser against their CDN on their build date; ours comes
from a tree whose provenance we can demonstrate. See `format-generation.md`.

## Where it lives

`vendor/texlive-2026/`, gitignored. 14 GB: the archive, its hash and
signature, the extracted `texmf-dist`, and the generated `texmf-var`. It sits
in the working tree so a format build needs no path juggling, and stays out of
git because it is third-party distribution data with its own licensing (see
`THIRD_PARTY_NOTICES.md`) and because git has no business with 14 GB of it.
What the repository does keep is the receipt naming exactly what was used and
the hash of every file that went in, so the tree can be rebuilt from the
commands above and checked against it.
