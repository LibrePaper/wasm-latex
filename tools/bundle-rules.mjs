// Rules for grouping texmf-relative paths into delivery bundles.
//
// SPEC-latex.md ("The unit") defines a bundle as one texmf package directory:
// a macro format/package pair (tex/<fmt>/<pkg>), a font family across every
// kind that ships it (fonts/<kind>/<foundry>/<name> -> fonts/<foundry>/<name>),
// or one of a short list of other package-shaped trees (bibtex, makeindex,
// scripts, web2c). This module is pure and dependency-free so both the build
// tool and its test can import the exact same grouping logic without pulling
// in fs or crypto.

// Font "kind" directories that all fold into the same fonts/<foundry>/<name>
// bundle, because a font package's metrics and glyphs are requested together.
const FONT_KINDS = new Set([
  'tfm', 'vf', 'type1', 'afm', 'enc', 'map', 'opentype', 'truetype',
])

// What a browser engine can never read, so is never served. There is no
// Metafont and no mktexpk in the wasm build, so .mf sources and .pk bitmaps
// are dead weight; AFM metrics are fontinst's input, not an engine's; Type 3
// PostScript fonts are dvips's. The top-level trees below belong to tools
// that are not shipped (tex4ht, MetaPost, xindy, Asymptote, ...), or are
// dvips's own headers and configuration. dvipdfmx/ stays: the dvipdfm engine
// reads its configuration from there.
const EXCLUDED_FONT_KINDS = new Set(['source', 'afm', 'pk', 'type3'])
const EXCLUDED_TOP = new Set([
  'doc', 'source', 'tlpkg', 'ls-R',
  'tex4ht', 'metapost', 'dvips', 'xindy', 'asymptote', 'omega', 'metafont',
  'pbibtex', 'texdoctk', 'hbf2gf', 'xdvi', 'chktex', 'texconfig', 'texdoc',
  'mft', 'ttf2pk', 'psutils', 'README',
])

// Returns the bundle name for a texmf-relative path (forward-slash separated,
// no leading slash), or null if the path is never bundled (documentation,
// source, package metadata, and the ls-R database kpathsea rebuilds itself).
export function bundleFor(relPath) {
  const parts = relPath.split('/')
  const top = parts[0]

  if (EXCLUDED_TOP.has(top)) return null

  if (top === 'tex') {
    // tex/<fmt>/<pkg>/... -> tex/<fmt>/<pkg>
    // tex/<fmt>/<file>    -> tex/<fmt>  (no package directory)
    const fmt = parts[1]
    if (fmt === undefined) return null
    if (parts.length <= 2) {
      // tex/<fmt> itself is a file directly under tex/, e.g. tex/plain.tex
      // (degenerate; treat as its own bundle name).
      return `tex/${fmt}`
    }
    if (parts.length === 3) {
      // tex/<fmt>/<name> is a file with no package directory of its own.
      return `tex/${fmt}`
    }
    const pkg = parts[2]
    return `tex/${fmt}/${pkg}`
  }

  if (top === 'fonts') {
    const kind = parts[1]
    if (kind !== undefined && EXCLUDED_FONT_KINDS.has(kind)) return null
    if (kind !== undefined && FONT_KINDS.has(kind)) {
      // fonts/<kind>/<foundry>/<name>/... -> fonts/<foundry>/<name>
      const foundry = parts[2]
      const name = parts[3]
      if (foundry !== undefined && name !== undefined) {
        return `fonts/${foundry}/${name}`
      }
      if (foundry !== undefined) return `fonts/${foundry}`
      return 'fonts'
    }
    // Unknown fonts/<kind>: fall through to the generic two-segment rule.
    return genericBundle(parts)
  }

  if (top === 'bibtex') {
    // bibtex/bst/<pkg>, bibtex/bib/<pkg> -> bibtex/bst/<pkg>, bibtex/bib/<pkg>
    const kind = parts[1]
    const pkg = parts[2]
    if ((kind === 'bst' || kind === 'bib') && pkg !== undefined) {
      return `bibtex/${kind}/${pkg}`
    }
    return genericBundle(parts)
  }

  if (top === 'makeindex') {
    const pkg = parts[1]
    if (pkg !== undefined) return `makeindex/${pkg}`
    return 'makeindex'
  }

  if (top === 'web2c') {
    return 'web2c'
  }

  if (top === 'scripts') {
    // Only Lua is an engine input (LuaTeX's format 51 searches scripts/);
    // the Perl, Python, shell and Java under scripts/ run nowhere in a browser.
    if (!relPath.endsWith('.lua')) return null
    const pkg = parts[1]
    if (pkg !== undefined) return `scripts/${pkg}`
    return 'scripts'
  }

  return genericBundle(parts)
}

// Fallback: everything not covered by an explicit rule above is grouped by
// its first two path segments (or just the first, if there is only one).
function genericBundle(parts) {
  if (parts.length === 1) return parts[0]
  return `${parts[0]}/${parts[1]}`
}

// Filename-safe slug for a bundle name: '/' -> '-'. Used for the tar's
// on-disk basename (the sha256-keyed directory is what actually
// disambiguates, the slug is just for humans skimming the directory).
export function slugFor(bundleName) {
  return bundleName.replace(/\//g, '-')
}

// Bundles excluded from the index by default. latex-dev is TeX Live's
// bleeding-edge shadow of latex/base and friends; the format build already
// has to rank it below the stable tree, and serving it to the browser
// resolver invites the same "which latex.ltx did we get" mistake at runtime.
// --include-latex-dev re-enables it.
export const EXCLUDED_BUNDLE_PREFIXES = ['tex/latex-dev']

// The "core" list, replacing the spec's guessed starting point with a
// measurement (SPEC-latex.md follow-up item 4, "Trimming it from corpus
// measurement is still open"). Measured 2026-09-09 by resolving four
// documents through tools/build-format.mjs --smoke-doc --smoke-evidence
// against the pdftex format build (238 format inputs), against the vendored
// TeX Live 2026 texmf tree:
//   a) a plain article: amsmath, amssymb, graphicx, hyperref, geometry,
//      natbib-style citations via thebibliography, a booktabs table, itemize
//   b) the same, plus fontenc(T1), inputenc(utf8), lmodern, microtype and
//      babel[french]
//   c) tikz + siunitx + xcolor, one small picture
//   d) beamer, two slides
// Every texmf path each document (and the format build) resolved was mapped
// to its bundle with bundleFor(). The new core is: every bundle the format
// phase touched, plus every bundle both (a) and (b) touched (b, not a alone,
// so a document's own babel language and font choices don't leak into the
// list that ships to everyone) - capped at 20 MB of the actual tar (member
// headers and 512-byte rounding included, not just file bytes) by dropping
// the largest candidates until the rest fits. That drops four bundles:
//   - tex/context/base (44.6 MB in-tar): pulled in by every document that
//     loads graphics-def's pdftex.def (so also by plain graphicx/hyperref
//     use, via \AtBeginDocument{\GPT@LoadSuppPdf}), but only for one file,
//     supp-pdf.mkii; the rest of ConTeXt's base tree just comes along. A
//     finer split of this package (that one file bundled separately) would
//     let it join core cheaply; without that split it stays its own
//     ~45 MB bundle, fetched once per browser and cached from then on.
//   - fonts/pdftex/updmap (15.9 MB): pdftex.map plus font encoding files
//     for every font family updmap knows about, to deliver the few hundred
//     bytes an individual document's fonts actually need from it.
//   - tex/generic/hyph-utf8 (10.0 MB): hyphenation patterns for every
//     language TeX Live ships, to deliver the one or two the format build
//     actually loads.
//   - fonts/public/amsfonts (4.4 MB, the msam/msbm/cmex metrics and glyphs
//     amssymb needs): simply doesn't fit once the three bundles above are
//     also excluded; every document in the corpus that loads amssymb (all
//     four measured here did) pays for this as a separate bundle fetch.
// The first three are exactly the babel-shaped problem the spec called out
// ("every language's .ldf... to be the fat") - several other packages key
// their content by language or font family the same way babel does, and
// package splitting (out of scope here) is the real fix for them, not
// corpus measurement. Each excluded bundle is still just one more bundle
// fetch on a cold cache, inside the spec's "1 to 3 requests" budget for a
// plain article.
// Resulting core: 51 bundles, about 17.0 MB as an actual built core.tar
// (verified 2026-09-09 with tools/build-bundles.mjs against the vendored
// TeX Live 2026 tree: one part, 22384640 bytes before this trim, 17.0 MB
// after dropping fonts/public/amsfonts).
export const DEFAULT_CORE = [
  'fonts/jknappen/ec',
  'fonts/public/cm',
  'fonts/public/latex-fonts',
  'tex/generic/atbegshi',
  'tex/generic/babel',
  'tex/generic/bigintcalc',
  'tex/generic/bitset',
  'tex/generic/config',
  'tex/generic/dehyph',
  'tex/generic/dehyph-exptl',
  'tex/generic/gettitlestring',
  'tex/generic/hyphen',
  'tex/generic/iftex',
  'tex/generic/infwarerr',
  'tex/generic/intcalc',
  'tex/generic/knuth-lib',
  'tex/generic/kvdefinekeys',
  'tex/generic/ltxcmds',
  'tex/generic/pdfescape',
  'tex/generic/pdftex',
  'tex/generic/pdftexcmds',
  'tex/generic/ruhyphen',
  'tex/generic/stringenc',
  'tex/generic/tex-ini-files',
  'tex/generic/ukrhyph',
  'tex/generic/unicode-data',
  'tex/generic/uniquecounter',
  'tex/latex/amsfonts',
  'tex/latex/amsmath',
  'tex/latex/atveryend',
  'tex/latex/base',
  'tex/latex/booktabs',
  'tex/latex/epstopdf-pkg',
  'tex/latex/etoolbox',
  'tex/latex/firstaid',
  'tex/latex/geometry',
  'tex/latex/graphics',
  'tex/latex/graphics-cfg',
  'tex/latex/graphics-def',
  'tex/latex/hycolor',
  'tex/latex/hyperref',
  'tex/latex/kvoptions',
  'tex/latex/kvsetkeys',
  'tex/latex/l3backend',
  'tex/latex/l3kernel',
  'tex/latex/latexconfig',
  'tex/latex/natbib',
  'tex/latex/refcount',
  'tex/latex/rerunfilecheck',
  'tex/latex/tex-ini-files',
  'tex/latex/url',
]
