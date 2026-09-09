# Generating the pdfTeX format

A `.fmt` file is LaTeX precompiled into an engine memory image: the kernel, the
class-independent macro layer, and the hyphenation tries, dumped by INITEX so
the browser does not rebuild them on every page load. It is a build output like
the `.wasm`, and it has to be produced from inputs we control.

## How it runs

The invocation is in the README. No network, no browser, no TypeScript host:
the harness runs `wasm-build/dist/wasmtex-pdftex.worker.js` on Node, gives it
the worker-shaped globals it expects (`self`, `importScripts`, synchronous
`XMLHttpRequest`, `performance`), hands the engine its `.wasm` through
`__wasmtexWasmBinary`, and drives the worker's own protocol: `settexliveurl`,
then `compileformat`. The format bytes come back on a `postMessage`. A build
takes about five seconds after the texmf tree is indexed.

Flags worth knowing:

- `--texmf` may be repeated; the trees are searched in the order given.
- `--smoke` loads the format back into the same engine and compiles a document
  with it, so a format built from the wrong inputs fails here.
- `--evidence` writes the input manifest described below.
- `--epoch` (or `SOURCE_DATE_EPOCH`) sets the frozen clock.
- `--verbose` logs every lookup; `--trace-messages` logs the worker protocol.

## Why the inputs need two trees

A TeX installation is not one directory. `texmf-dist` holds the distributed
files, but the font map files — `pdftex.map` above all — are *generated* by
`updmap` into `texmf-var`, and are in no release archive. Without the map the
format still builds and LaTeX still typesets, and then pdfTeX fails at font
embedding with `cannot open font map file`, falls back to `mktexpk`, and dies.
Whatever tree we build a format against must therefore include a generated
map, which means running `updmap-sys` once when the snapshot is made.

## Resolution is kpathsea's job, and the harness has to do it

The engine asks for a file as a (kpathsea format id, bare name) pair. Upstream
answered those from a flat CDN bucket where each name mapped to exactly one
file. A real texmf tree has several: `latex.ltx` exists in both `tex/latex/base`
and `tex/latex-dev/base`, and `hyphen.cfg` in babel, cslatex, and antomega.

`FORMAT_SEARCH_ORDER` in the harness lists, per format id, the path prefixes in
kpathsea's preference order, mirroring the search paths pdflatex runs with
(`TEXINPUTS = .;$TEXMF/tex/{latex,generic,}//`). Candidates are ranked by that
order, then by which `--texmf` tree they came from, then by depth and name, so
the result never depends on directory iteration order. A name found only
outside its format's subtrees is not that format's file and is not offered.

This matters more than it looks. Picking `latex-dev`'s kernel and cslatex's
`hyphen.cfg` produced a format that dumped without complaint and was 1.4 MB
short of a correct one, because it had loaded two languages' patterns instead
of every language's.

## Determinism

TeX stamps the dump with the current date. The harness freezes the clock at
`SOURCE_DATE_EPOCH` (default 2026-03-01) so the same engine and the same texmf
tree always produce the same bytes — verified across repeated runs. Without
this the format is a new file every day and no receipt means anything.

## Evidence

`--evidence` writes the format's complete input manifest: the texmf roots, the
frozen epoch, the format's own size and sha256, every file the build resolved
with its absolute path, size and sha256, and every request nothing satisfied.
Unsatisfied requests are normal — kpathsea probes for names that do not exist
(`nul:`, extension variants) — but the list is worth reading when a format
looks wrong, because a genuinely missing input shows up there first.

The inputs recorded are the format build's only; the `--smoke` compile runs
after the manifest is closed and its own font lookups are not mixed in.
