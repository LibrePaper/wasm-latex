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

// The starting "core" list from SPEC-latex.md ("The core bundle"), adjusted
// to the directory names that actually exist in the vendored TeX Live 2026
// texmf tree (verified against
// vendor/texlive-2026/texlive-20260301-texmf/texmf-dist):
//   - tex/latex/babel does not exist; babel's implementation lives at
//     tex/generic/babel only (tex/latex/babelbib is an unrelated package).
//   - kvsetkeys lives at tex/latex/kvsetkeys, not tex/generic/kvsetkeys.
//   - cm-super is not present in this snapshot at all, so it is omitted
//     (the spec already excludes it from font bundles).
//   - the pdftex.map bundle is named by the same fonts/<foundry>/<name> rule
//     applied to fonts/map/pdftex/updmap/pdftex.map, i.e. fonts/pdftex/updmap.
export const DEFAULT_CORE = [
  'tex/latex/base',
  'tex/latex/l3kernel',
  'tex/latex/l3backend',
  'tex/latex/l3packages',
  'tex/latex/amsmath',
  'tex/latex/amsfonts',
  'tex/latex/graphics',
  'tex/latex/graphics-cfg',
  'tex/latex/graphics-def',
  'tex/latex/hyperref',
  'tex/latex/geometry',
  'tex/latex/tools',
  'tex/generic/babel',
  'tex/latex/kvoptions',
  'tex/generic/iftex',
  'tex/generic/infwarerr',
  'tex/generic/ltxcmds',
  'tex/latex/kvsetkeys',
  'tex/generic/pdftexcmds',
  'tex/latex/auxhook',
  'tex/latex/rerunfilecheck',
  'tex/latex/url',
  'fonts/public/cm',
  'fonts/public/amsfonts',
  'fonts/public/knuth-lib',
  'fonts/public/latex-fonts',
  'fonts/pdftex/updmap',
]
