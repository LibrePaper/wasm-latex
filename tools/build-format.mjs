#!/usr/bin/env node
// Build a pdfTeX or XeTeX format (.fmt) from a built engine and a local texmf tree.
//
// Upstream dumps the format out of a Playwright-driven browser page that imports
// the WasmTex TypeScript host and pulls every input from a CDN over synchronous
// XHR (scripts/extract-format.mjs). That needs a browser, a Vite server, the
// whole application repository, and a network the build has to trust.
//
// None of it is necessary. The engine worker in wasm-build/ is self-contained:
// it speaks a postMessage protocol and asks for TeX files through one function.
// This harness gives it a worker-shaped global environment on top of Node and
// answers those requests from a texmf directory on disk, so a format build is a
// pure function of (engine wasm, texmf tree) with no network and no browser.
//
//   node tools/build-format.mjs --texmf /path/to/texmf-dist --out engine.fmt
//   node tools/build-format.mjs --engine xetex --texmf ... --texmf ... --smoke
//
// Determinism: TeX stamps the dump with the current date, so the clock is
// frozen (SOURCE_DATE_EPOCH, default below). Same inputs, same bytes, any day.
//
// Every resolved file is recorded with its sha256 in the evidence JSON, which
// is what makes the format's inputs auditable without trusting a mirror.
//
// --engine (default pdftex) switches to wasmtex-xetex.{wasm,worker.js}. The two
// engines share one CDN/XHR layout (xetex-worker.js's own header says so: "shares
// pdftex/<format>/<name> with the pdfTeX mirror"), so almost everything below is
// engine-agnostic. Three things are genuinely different for XeTeX and are called
// out at their point of use:
//   1. ICU data: the worker fetches `icudt68l.dat` directly at `<endpoint>` with
//      no `pdftex/<format>/` prefix (ensureIcuData() in xetex-worker.js).
//   2. The format itself is not preloaded via a `loadformat` message (xetex-worker.js
//      has no such command) — it is fetched through the SAME kpse hook as every
//      other file, under the bare name passed to `--fmt=`, kpathsea format 10 (fmt).
//      So a "loaded" format is really just another entry this harness answers.
//   3. Font-by-name (fontspec's \setmainfont{Family Name}) goes through the C
//      fontconfig shim, which itself fetches a by-name font database, kpse format
//      26, name `xetexfontlist.txt` — a file with no counterpart in the texmf tree.
//      This harness generates it from the fonts under fonts/opentype and
//      fonts/truetype using `otfinfo` (build-time only; never runs in the sandbox).

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gzipSync, inflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

// 2026-03-01T00:00:00Z — the TeX Live 2026 release date. Any fixed value works;
// this one keeps the format's internal date stamp meaningful.
const DEFAULT_EPOCH = 1772323200

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const engine = arg('engine', 'pdftex')
if (engine !== 'pdftex' && engine !== 'xetex') {
  console.error(`unsupported --engine ${engine} (pdftex or xetex)`)
  process.exit(2)
}
const engineWasmName = `wasmtex-${engine}.wasm`
const engineWorkerName = `wasmtex-${engine}.worker.js`

const distDir = path.resolve(arg('dist', 'wasm-build/dist'))
// --texmf may be repeated. Order is search order: a name found in an earlier
// tree wins. Two trees are normally needed, because a TeX installation is not
// one directory — texmf-dist holds the distributed files, while updmap writes
// the font map files (pdftex.map and friends) into a generated texmf-var tree,
// and a document cannot embed a font without them.
const texmfDirs = process.argv
  .map((a, i) => (a === '--texmf' ? process.argv[i + 1] : null))
  .filter(Boolean)
  .map((d) => path.resolve(d))
if (!texmfDirs.length && process.env.TEXMF_DIST) texmfDirs.push(path.resolve(process.env.TEXMF_DIST))
const outPath = path.resolve(arg('out', path.join(distDir, `wasmtex-${engine}.fmt`)))
const evidencePath = arg('evidence', null)
const epoch = Number(arg('epoch', process.env.SOURCE_DATE_EPOCH ?? DEFAULT_EPOCH))
const verbose = process.argv.includes('--verbose')
const quiet = process.argv.includes('--quiet')
const log = (...a) => { if (!quiet) console.error(...a) }

if (!texmfDirs.length || texmfDirs.some((d) => !fs.existsSync(d))) {
  console.error('usage: node tools/build-format.mjs [--engine pdftex|xetex] --texmf <tree> [--texmf <tree>...] [--out file] [--evidence file]')
  console.error('the texmf trees are the format\'s only input besides the engine; there is no network fallback')
  process.exit(2)
}

// --- kpathsea format ids and search order -------------------------------------
// The engine asks for a file as (format id, bare name). Upstream answered from a
// flat CDN bucket where each name had exactly one file; a real texmf tree holds
// several files per name and kpathsea picks between them by search path, so the
// resolver has to as well. Getting this wrong is quiet: the format still builds,
// it is just built from the wrong latex.ltx.
//
// Each entry lists path prefixes in kpathsea preference order, mirroring the
// TEXINPUTS-style paths pdflatex runs with, e.g.
//   TEXINPUTS = .;$TEXMF/tex/{latex,generic,}//
// which is why tex/latex/base/latex.ltx beats tex/latex-dev/base/latex.ltx, and
// babel's hyphen.cfg beats cslatex's. A file outside every listed prefix is not
// that format's file and is not offered to the engine.
//
// 36 (truetype) and 47 (opentype) are XeTeX-only in practice (pdfTeX never asks
// for them) but cost nothing to list unconditionally.
const FORMAT_SEARCH_ORDER = {
  3: ['fonts/tfm/'],                            // TFM metrics
  4: ['fonts/afm/'],                            // AFM metrics
  6: ['bibtex/bib/'],                           // .bib
  7: ['bibtex/bst/'],                           // .bst
  11: ['fonts/map/'],                           // font maps
  26: ['tex/latex/', 'tex/generic/', 'tex/'],     // .tex .sty .cls .def .cfg .ltx .ini
  28: ['web2c/'],                               // pool files
  32: ['fonts/type1/'],                         // .pfb
  33: ['fonts/vf/'],                            // virtual fonts
  36: ['fonts/truetype/'],                      // .ttf .ttc (XeTeX)
  44: ['fonts/enc/'],                           // encodings
  47: ['fonts/opentype/'],                      // .otf (XeTeX)
  48: ['tex/generic/config/', 'web2c/'],        // pdftex.cfg
  51: ['tex/luatex/', 'tex/generic/', 'scripts/'], // .lua
}

const index = new Map()   // basename -> [{ root, rel }, ...]
let fileCount = 0
// Symlinks are followed (a Nix texmf tree is a farm of them) and each real
// directory is visited once. doc/ and source/ hold no input a format build can
// ask for and are a large share of the tree, so they are skipped.
const SKIP_TOP = new Set(['doc', 'source'])
for (const [root, dir] of texmfDirs.entries()) {
  log(`indexing ${dir}`)
  const seenDirs = new Set()
  ;(function walk(current, depth) {
    const real = fs.realpathSync(current)
    if (seenDirs.has(real)) return
    seenDirs.add(real)
    for (const entry of fs.readdirSync(current)) {
      if (depth === 0 && SKIP_TOP.has(entry)) continue
      const full = path.join(current, entry)
      let st
      try { st = fs.statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full, depth + 1); continue }
      if (!st.isFile()) continue
      fileCount++
      const found = { root, rel: path.relative(dir, full) }
      const list = index.get(entry)
      if (list) list.push(found)
      else index.set(entry, [found])
    }
  })(dir, 0)
}
log(`indexed ${fileCount} files, ${index.size} distinct names, ${texmfDirs.length} tree(s)`)

const resolved = []        // successful lookups, with hashes
const missing = []         // requests no file satisfied
const unknownFormats = new Set()

function resolveFile(format, name) {
  const candidates = index.get(name)
  if (!candidates) return null
  const order = FORMAT_SEARCH_ORDER[format]
  if (!order) unknownFormats.add(format)
  // Rank by position in the search order, then by tree, then by depth, then by
  // name, so the answer never depends on directory iteration order.
  const ranked = candidates
    .map((c) => ({ ...c, rank: order ? order.findIndex((pre) => c.rel.startsWith(pre)) : 0 }))
    .filter((c) => c.rank >= 0)
    .sort((a, b) => a.rank - b.rank ||
                    a.root - b.root ||
                    a.rel.split('/').length - b.rel.split('/').length ||
                    a.rel.localeCompare(b.rel))
  if (!ranked.length) return null
  const best = ranked[0]
  const full = path.join(texmfDirs[best.root], best.rel)
  return { rel: best.rel, root: texmfDirs[best.root], full, data: fs.readFileSync(full) }
}

// --- XeTeX only: xetexfontlist.txt, the by-name font database ----------------
// fontconfig-shim.c's FcFontList() answers XeTeX's font manager entirely from
// this file (kpse format 26, name "xetexfontlist.txt") — there is no per-font
// filesystem scan under the on-demand WASM model. No such file ships in TeX
// Live; it is generated here, at build time, from every OpenType/TrueType font
// in the texmf trees, using `otfinfo` (a build-machine tool — this never runs
// inside the engine sandbox). Format is documented in fontconfig-shim.c: one
// font per record, one field per line:
//   fontId / file / index / N family-lines / N style-lines / N fullname-lines /
//   psName / subFamily / weight / width / slant / isReg / isBold / isItalic /
//   designSize / minSize / maxSize / subFamilyID / subFamilyID(dup)
// weight/width/slant use the fontconfig integer scale the shim's header defines
// (FC_WEIGHT_REGULAR=80/FC_WEIGHT_BOLD=200, FC_WIDTH_NORMAL=100,
// FC_SLANT_ROMAN=0/FC_SLANT_ITALIC=100) — good enough for XeTeX's matcher to
// pick the right shape when a family has regular/bold/italic/bolditalic members.
function buildXetexFontList() {
  const fontFiles = []
  for (const [root, dir] of texmfDirs.entries()) {
    for (const kind of ['opentype', 'truetype']) {
      const base = path.join(dir, 'fonts', kind)
      if (!fs.existsSync(base)) continue
      ;(function walk(current) {
        let entries
        try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          const full = path.join(current, e.name)
          if (e.isDirectory()) { walk(full); continue }
          if (!e.isFile()) continue
          if (!/\.(otf|ttf|ttc)$/i.test(e.name)) continue
          fontFiles.push({ root, full, rel: path.relative(dir, full), base: e.name })
        }
      })(base)
    }
  }
  fontFiles.sort((a, b) => a.rel.localeCompare(b.rel))

  const lines = []
  let fontId = 0
  let ok = 0
  let skipped = 0
  for (const f of fontFiles) {
    let info
    try {
      info = execFileSync('otfinfo', ['-i', f.full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      skipped++
      continue
    }
    const get = (label) => {
      const m = new RegExp(`^${label}:\\s*(.+)$`, 'm').exec(info)
      return m ? m[1].trim() : null
    }
    const family = get('Family')
    const subfamily = get('Subfamily') || 'Regular'
    const fullname = get('Full name')
    const psName = get('PostScript name') || ''
    const prefFamily = get('Preferred family')
    const prefSubfamily = get('Preferred subfamily')
    if (!family) { skipped++; continue }

    const families = [...new Set([family, prefFamily].filter(Boolean))]
    const styles = [...new Set([subfamily, prefSubfamily].filter(Boolean))]
    const fullnames = [...new Set([fullname, psName].filter(Boolean))]

    const lower = `${subfamily} ${prefSubfamily || ''}`.toLowerCase()
    const isBold = /bold/.test(lower)
    const isItalic = /italic|oblique/.test(lower)
    const weight = isBold ? 200 : 80        // FC_WEIGHT_BOLD / FC_WEIGHT_REGULAR
    const width = 100                       // FC_WIDTH_NORMAL
    const slant = isItalic ? 100 : 0        // FC_SLANT_ITALIC / FC_SLANT_ROMAN

    lines.push(
      String(fontId++),
      f.base,                 // file: bare name, resolved later via kpse by extension
      '0',                    // index (no .ttc face selection here)
      String(families.length), ...families,
      String(styles.length), ...styles,
      String(fullnames.length), ...fullnames,
      psName,
      subfamily,
      String(weight), String(width), String(slant),
      isBold || isItalic ? '0' : '1',   // isReg
      isBold ? '1' : '0',               // isBold
      isItalic ? '1' : '0',             // isItalic
      '10', '0', '0',                   // designSize, minSize, maxSize (unused by the shim's matcher)
      '0', '0',                         // subFamilyID, subFamilyID(dup)
    )
    ok++
  }
  log(`xetexfontlist ${ok} fonts indexed, ${skipped} skipped (no otfinfo metadata), ${fontFiles.length} font files found`)
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

// --- The engine's file requests arrive as synchronous XHR --------------------
// URL shape is <endpoint>pdftex/<format>/<name>; the endpoint is a sentinel
// here, since nothing leaves the machine. `extraFiles` answers requests that
// have no on-disk counterpart in the texmf tree: the just-built format itself
// (XeTeX fetches it through the same kpse hook as everything else, under
// whatever bare name follows --fmt=) and, for XeTeX, xetexfontlist.txt.
const ENDPOINT = 'texmf-local:/'
const ICU_DATA_FILE = 'icudt68l.dat'
const extraFiles = new Map() // `${format}/${name}` -> Buffer

class XMLHttpRequestShim {
  constructor() {
    this.status = 0
    this.response = null
    this.responseText = ''
    this.responseType = ''
    this.timeout = 0
  }
  open(_method, url, async) {
    if (async) throw new Error('this harness implements only synchronous requests')
    this._url = url
  }
  setRequestHeader() {}
  getResponseHeader() { return null }
  send() {
    const rest = this._url.startsWith(ENDPOINT) ? this._url.slice(ENDPOINT.length) : this._url

    // XeTeX only: ensureIcuData() in xetex-worker.js fetches this with NO
    // pdftex/<format>/ prefix — just the bare filename appended to the endpoint.
    if (engine === 'xetex' && rest === ICU_DATA_FILE) {
      const icuPath = path.join(distDir, ICU_DATA_FILE)
      if (!fs.existsSync(icuPath)) { this.status = 404; return }
      const data = fs.readFileSync(icuPath)
      this.status = 200
      const copy = new Uint8Array(data.length)
      copy.set(data)
      this.response = this.responseType === 'arraybuffer' ? copy.buffer : copy
      this.responseText = this.responseType === 'arraybuffer' ? '' : data.toString('utf8')
      if (verbose) log(`  hit  icu ${ICU_DATA_FILE} (${data.length} bytes)`)
      return
    }

    const m = /^pdftex\/(\d+)\/(.+)$/.exec(rest)
    if (!m) { this.status = 404; return }
    const format = Number(m[1])
    const name = decodeURIComponent(m[2])

    const extra = extraFiles.get(`${format}/${name}`)
    if (extra) {
      this.status = 200
      const copy = new Uint8Array(extra.length)
      copy.set(extra)
      this.response = this.responseType === 'arraybuffer' ? copy.buffer : copy
      this.responseText = this.responseType === 'arraybuffer' ? '' : extra.toString('utf8')
      if (verbose) log(`  hit  ${format}/${name} -> (generated)`)
      return
    }

    const hit = resolveFile(format, name)
    if (!hit) {
      this.status = 404
      missing.push({ format, name })
      if (verbose) log(`  miss ${format}/${name}`)
      return
    }
    this.status = 200
    resolved.push({
      format,
      name,
      path: hit.full,
      bytes: hit.data.length,
      sha256: createHash('sha256').update(hit.data).digest('hex'),
    })
    if (verbose) log(`  hit  ${format}/${name} -> ${hit.rel}`)
    const copy = new Uint8Array(hit.data.length)
    copy.set(hit.data)
    this.response = this.responseType === 'arraybuffer' ? copy.buffer : copy
    this.responseText = this.responseType === 'arraybuffer' ? '' : hit.data.toString('utf8')
  }
}

// --- PDF text search, including inside compressed cross-reference/object streams ---
// xdvipdfmx writes PDF 1.5+ object streams by default, so the font dictionaries
// (BaseFont names) that would prove embedding are Flate-compressed inside an
// /ObjStm and never appear as literal bytes in the file. A plain
// `buf.includes(needle)` therefore always misses, even for a correctly embedded
// font. Fall back to inflating every `stream`...`endstream` region and searching
// the decompressed bytes too.
function pdfIncludesText(buf, needle) {
  if (buf.includes(needle)) return true
  const streamRe = /stream\r?\n/g
  let m
  while ((m = streamRe.exec(buf.toString('latin1'))) !== null) {
    const start = m.index + m[0].length
    const end = buf.indexOf('endstream', start)
    if (end < 0) continue
    let body = buf.subarray(start, end)
    // Trim a trailing EOL before "endstream", per the PDF spec.
    if (body.at(-1) === 0x0a) body = body.subarray(0, body.length - (body.at(-2) === 0x0d ? 2 : 1))
    try {
      if (inflateSync(body).includes(needle)) return true
    } catch {}
  }
  return false
}

// --- A frozen clock, so the dump is reproducible ------------------------------
const frozenMs = epoch * 1000
class FrozenDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(frozenMs)
    else super(...args)
  }
  static now() { return frozenMs }
}

// --- Worker-shaped global environment ----------------------------------------
// Factored into a function because the XeTeX smoke test needs a SECOND engine
// session (dvipdfm, to turn the .xdv into a .pdf) sharing the same texmf index
// and XHR shim but with its own isolated worker state (messages/cursor/heap).
const traceMessages = process.argv.includes('--trace-messages')

function bootEngine(workerName, wasmName) {
  const messages = []
  let notify = () => {}
  let cursor = 0
  const deliver = (msg) => {
    if (traceMessages) log(`  <- ${msg.cmd ?? '(ready)'} ${msg.result ?? ''}`)
    messages.push(msg)
    notify()
  }

  const sandbox = {
    WebAssembly, TextDecoder, TextEncoder, URL, URLSearchParams, console,
    Date: FrozenDate, Math, JSON, performance, setTimeout, clearTimeout,
    setInterval, clearInterval, queueMicrotask, crypto, Promise, Error,
    Object, Array, ArrayBuffer, DataView, Function, String, Number, Boolean,
    Symbol, Map, Set, WeakMap, WeakSet, Proxy, Reflect, RegExp,
    Uint8Array, Int8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array,
    BigUint64Array, isNaN, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
    XMLHttpRequest: XMLHttpRequestShim,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    location: { href: `file://${distDir}/${workerName}`, search: '' },
    postMessage: deliver,
    close: () => {},
    importScripts: (...names) => {
      for (const name of names) {
        const file = path.join(distDir, name)
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file })
      }
    },
  }
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)

  // One cursor per engine session: the worker answers several commands with the
  // same {cmd:'compile'} shape, so a per-call cursor would let a later wait
  // re-match an earlier reply and report the format dump as a compiled PDF.
  function waitFor(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      // settled has to stop the poll chain: a waiter left running past its own
      // resolution keeps draining the shared cursor and eats the reply the next
      // wait is looking for.
      let settled = false
      const check = () => {
        if (settled) return
        while (cursor < messages.length) {
          const msg = messages[cursor++]
          if (predicate(msg)) { settled = true; return resolve(msg) }
        }
        if (Date.now() > deadline) { settled = true; return reject(new Error(`timed out waiting for ${what}`)) }
        setTimeout(check, 25)
      }
      notify = () => setImmediate(check)
      check()
    })
  }

  // The worker takes the engine binary from this global rather than fetching it.
  sandbox.__wasmtexWasmBinary = new Uint8Array(fs.readFileSync(path.join(distDir, wasmName)))
  vm.runInContext(
    fs.readFileSync(path.join(distDir, workerName), 'utf8'),
    ctx,
    { filename: path.join(distDir, workerName) },
  )
  return { sandbox, waitFor }
}

log(`engine   ${engine} (${path.relative(process.cwd(), distDir)})`)
for (const [i, d] of texmfDirs.entries()) log(`texmf${i === 0 ? "    " : "+   "} ${d}`)
log(`clock    frozen at ${new Date(frozenMs).toISOString()} (epoch ${epoch})`)

// XeTeX only: build xetexfontlist.txt before the worker boots, so it is ready
// the moment fontconfig-shim.c asks for it (kpse format 26).
if (engine === 'xetex') {
  extraFiles.set('26/xetexfontlist.txt', buildXetexFontList())
}

const { sandbox, waitFor: nextMessage } = bootEngine(engineWorkerName, engineWasmName)

// The module's postRun posts a bare {result:'ok'} once the runtime is up.
await nextMessage((m) => m.result === 'ok' && m.cmd === undefined, 120000, 'the engine to boot')
log('engine booted')

sandbox.onmessage({ data: { cmd: 'settexliveurl', url: ENDPOINT } })

const started = Date.now()
sandbox.onmessage({ data: { cmd: 'compileformat' } })
const done = await nextMessage((m) => m.cmd === 'compile', 30 * 60 * 1000, 'the format build')
const seconds = ((Date.now() - started) / 1000).toFixed(1)

if (done.result !== 'ok') {
  console.error(done.log ?? '')
  console.error(`\nformat build failed with status ${done.status} after ${seconds}s`)
  console.error(`${resolved.length} files resolved, ${missing.length} requests unsatisfied`)
  process.exit(1)
}

// Everything resolved so far belongs to the format; the smoke compile below
// asks for fonts of its own, which are not format inputs.
const formatInputs = resolved.splice(0, resolved.length)
const formatMissing = missing.splice(0, missing.length)

const fmt = Buffer.from(done.pdf)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, fmt)
const sha = createHash('sha256').update(fmt).digest('hex')

// XeTeX only: no `loadformat` message exists in xetex-worker.js — the engine
// fetches its own format through the ordinary kpse hook, under the bare name
// given to `--fmt=` in xetex-entry.c's compileLaTeX() ("wasmtex-xetex"), as
// kpathsea format 10 (fmt). Register the bytes we just dumped under every name
// the request could plausibly arrive as, so the smoke compile below (and any
// later compile in this same process) is served from memory, not the disk.
let engineFmtGz = null
if (engine === 'xetex') {
  // xetex-entry.c hardcodes `--fmt=wasmtex-xetex` regardless of --out; that is
  // the bare name kpathsea (format 10, fmt) will ask for, with or without the
  // .fmt extension depending on how the request reaches kpse_find_file_impl.
  const base = `wasmtex-${engine}`
  for (const name of [base, `${base}.fmt`]) extraFiles.set(`10/${name}`, fmt)
  engineFmtGz = gzipSync(fmt)
  const gzPath = `${outPath}.gz`
  fs.writeFileSync(gzPath, engineFmtGz)
}

log(`format   ${path.relative(process.cwd(), outPath)}`)
log(`bytes    ${fmt.length}`)
log(`sha256   ${sha}`)
if (engineFmtGz) log(`gz       ${path.relative(process.cwd(), `${outPath}.gz`)} (${engineFmtGz.length} bytes)`)
log(`built in ${seconds}s from ${formatInputs.length} texmf files (${formatMissing.length} requests unsatisfied)`)
if (unknownFormats.size) {
  log(`note: kpathsea format ids with no subtree mapping: ${[...unknownFormats].sort((a, b) => a - b).join(', ')}`)
}

// --- Smoke: the only proof that matters is that the format typesets ----------
// A format that dumps cleanly can still be built from the wrong inputs. This
// compiles a document with the format we just built, in the same engine
// session, so a broken format fails here rather than in a browser.
if (process.argv.includes('--smoke')) {
  if (engine === 'pdftex') {
    const doc = [
      '\\documentclass{article}',
      '\\begin{document}',
      'Format smoke test. $E = mc^2$',
      '\\end{document}',
      '',
    ].join('\n')
    sandbox.onmessage({ data: { cmd: 'loadformat', data: new Uint8Array(fmt).buffer } })
    await nextMessage((m) => m.cmd === 'loadformat', 30000, 'the format to load')
    sandbox.onmessage({ data: { cmd: 'writefile', url: 'main.tex', src: doc } })
    await nextMessage((m) => m.cmd === 'writefile', 30000, 'the document to be written')
    sandbox.onmessage({ data: { cmd: 'setmainfile', url: 'main.tex' } })
    sandbox.onmessage({ data: { cmd: 'compilelatex' } })
    const run = await nextMessage((m) => m.cmd === 'compile', 5 * 60 * 1000, 'the smoke compile')
    const pdf = run.pdf ? Buffer.from(run.pdf) : null
    if (run.result !== 'ok' || !pdf || pdf.subarray(0, 5).toString() !== '%PDF-') {
      console.error(run.log ?? '')
      console.error('\nsmoke compile failed: the format does not typeset')
      process.exit(1)
    }
    log(`smoke    compiled a document with this format, ${pdf.length} byte PDF`)
  } else {
    // XeTeX: no loadformat — the format is served via the kpse hook (see above).
    // fontVariant selects \setmainfont{Latin Modern Roman} (by-name, through
    // xetexfontlist.txt) or \setmainfont{lmroman10-regular.otf} (by file name,
    // straight through kpse format 47) — both are run when --smoke-both is given;
    // otherwise --font-variant name|file picks one (default: name).
    const variants = process.argv.includes('--smoke-both')
      ? ['name', 'file']
      : [arg('font-variant', 'name')]
    for (const variant of variants) {
      const fontArg = variant === 'file' ? 'lmroman10-regular.otf' : 'Latin Modern Roman'
      const doc = [
        '\\documentclass{article}',
        '\\usepackage{fontspec}',
        `\\setmainfont{${fontArg}}`,
        '\\begin{document}',
        'Smoke: $E=mc^2$ and some text in Latin Modern.',
        '\\end{document}',
        '',
      ].join('\n')
      sandbox.onmessage({ data: { cmd: 'writefile', url: 'main.tex', src: doc } })
      await nextMessage((m) => m.cmd === 'writefile', 30000, 'the document to be written')
      sandbox.onmessage({ data: { cmd: 'setmainfile', url: 'main.tex' } })
      sandbox.onmessage({ data: { cmd: 'compilelatex' } })
      const run = await nextMessage((m) => m.cmd === 'compile', 5 * 60 * 1000, `the smoke compile (${variant})`)
      const xdv = run.pdf ? Buffer.from(run.pdf) : null
      if (run.result !== 'ok' || !xdv || xdv.length === 0) {
        console.error(run.log ?? '')
        console.error(`\nsmoke compile (${variant}) failed: the format does not typeset with \\setmainfont{${fontArg}}`)
        process.exit(1)
      }
      if (verbose) log(run.log ?? '')
      log(`smoke    (${variant}) compiled ${xdv.length} byte XDV with \\setmainfont{${fontArg}}`)
      const synctexPresent = !!run.synctex
      log(`smoke    (${variant}) synctex field ${synctexPresent ? `present, ${Buffer.from(run.synctex).length} bytes` : 'ABSENT'}`)
      if (arg('xdv-out', null)) {
        const xdvOut = path.resolve(arg('xdv-out', null)).replace(/(\.xdv)?$/, variant === 'file' ? '.byfile.xdv' : '.byname.xdv')
        fs.writeFileSync(xdvOut, xdv)
        log(`smoke    (${variant}) xdv written to ${path.relative(process.cwd(), xdvOut)}`)
      }

      // dvipdfmx stage: turn the .xdv into a .pdf, in a second, isolated engine
      // session sharing this same texmf index/XHR shim. Skippable with
      // --no-smoke-pdf for a build machine that has not built dvipdfm.
      if (!process.argv.includes('--no-smoke-pdf')) {
        const dvipdfm = bootEngine('wasmtex-dvipdfm.worker.js', 'wasmtex-dvipdfm.wasm')
        await dvipdfm.waitFor((m) => m.result === 'ok' && m.cmd === undefined, 120000, 'dvipdfm to boot')
        dvipdfm.sandbox.onmessage({ data: { cmd: 'settexliveurl', url: ENDPOINT } })
        dvipdfm.sandbox.onmessage({ data: { cmd: 'writefile', url: 'main.xdv', src: xdv } })
        await dvipdfm.waitFor((m) => m.cmd === 'writefile', 30000, 'the xdv to be written')
        dvipdfm.sandbox.onmessage({ data: { cmd: 'setmainfile', url: 'main.xdv' } })
        dvipdfm.sandbox.onmessage({ data: { cmd: 'compilepdf' } })
        const pdfRun = await dvipdfm.waitFor((m) => m.cmd === 'compile', 60000, `dvipdfm (${variant})`)
        const pdfBuf = pdfRun.pdf ? Buffer.from(pdfRun.pdf) : null
        if (pdfRun.result !== 'ok' || !pdfBuf || pdfBuf.subarray(0, 5).toString() !== '%PDF-') {
          console.error(pdfRun.log ?? '')
          console.error(`\ndvipdfm (${variant}) failed: no PDF produced from the xdv`)
          process.exit(1)
        }
        const embedsLM = pdfIncludesText(pdfBuf, 'LMRoman')
        log(`smoke    (${variant}) dvipdfm produced a ${pdfBuf.length} byte PDF, embeds LMRoman: ${embedsLM}`)
        if (arg('pdf-out', null)) {
          const pdfOut = path.resolve(arg('pdf-out', null)).replace(/(\.pdf)?$/, variant === 'file' ? '.byfile.pdf' : '.byname.pdf')
          fs.writeFileSync(pdfOut, pdfBuf)
          log(`smoke    (${variant}) pdf written to ${path.relative(process.cwd(), pdfOut)}`)
        }
        if (!embedsLM) {
          console.error(`\ndvipdfm (${variant}) produced a PDF that does not embed an LM font`)
          process.exit(1)
        }
      }
    }
  }
}

if (evidencePath) {
  fs.writeFileSync(evidencePath, JSON.stringify({
    procedure: 'node tools/build-format.mjs',
    engine,
    texmf: texmfDirs,
    sourceDateEpoch: epoch,
    format: { name: path.basename(outPath), bytes: fmt.length, sha256: sha },
    inputs: formatInputs.sort((a, b) => a.path.localeCompare(b.path)),
    unsatisfied: formatMissing,
  }, null, 2) + '\n')
  log(`evidence ${path.relative(process.cwd(), evidencePath)}`)
}
console.log(sha)
