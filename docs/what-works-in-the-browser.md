# What works in the browser

The rule is one sentence: the browser compiles anything that is TeX plus data.
Anything that is a program or a font installed on your machine needs the
paired LibrePaper app. This page lists what that means in practice for the
current release. It is written for people and for agents deciding whether a
document can be compiled without pairing.

## Works in the browser

- **pdfLaTeX** with SyncTeX, from the reproducible engine in this repository.
- **Every TeX Live 2026 package** in the macro tree, served on demand as
  bundles (`docs/bundles.md`). A `\usepackage` that exists in TeX Live works
  without anyone pre-recording it.
- **Type 1 fonts** and their map, so font packages embed. Computer Modern,
  Latin Modern, the AMS fonts, Times, Palatino and the rest of the Type 1 set.
- **BibTeX** bibliographies with natbib or the standard styles.
- **BibTeX8** and **makeindex** when their engines are in the release.
- **biblatex with Biber** through the browser Biber VM, which LibrePaper
  starts when a document loads biblatex. Slower than the rest on a cold
  cache, but no pairing.
- Figures as PDF, PNG or JPEG.

## Needs the paired app

- **Shell escape**, in every form: minted and Pygments, epstopdf on EPS
  figures, TikZ externalization, pgfplots with gnuplot, the svg package with
  Inkscape, pythontex, sagetex. The browser has no shell to escape to, and the
  app runs restricted shell escape only, off by default, enabled per project
  by its owner, on the owner's own machine.
- **System fonts by name** under XeTeX and LuaTeX. Fonts you installed live on
  your disk; the browser serves only the OpenType fonts TeX Live ships.
- **XeTeX and LuaTeX** until their engines are in a release. XeTeX's build is
  in this repository and has no SyncTeX yet; LuaTeX's has an undiagnosed
  timeout.
- **Very large or slow documents**, by choice. A book with hundreds of TikZ
  pictures compiles faster natively; the app offers that as a button, not as
  a fallback that fires on its own.

## When the browser stops

The failure message names what was missing: the package file that is not in
the mirror, or the program the document asked for, and shows the one-line
pairing instruction. A package that does not exist in TeX Live fails in under
a second with no request, because the bundle index is the existence check.

## Substitutions that avoid pairing

- `listings` instead of `minted` for code.
- Export figures to PDF or PNG instead of EPS or SVG.
- Give pgfplots a data file instead of a gnuplot expression.
- Use TeX Live's fonts by package (`\usepackage{libertine}`) instead of by
  system name under fontspec.
