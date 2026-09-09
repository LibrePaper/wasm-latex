#!/usr/bin/env node
// Build a pdfTeX format (.fmt) from the built engine and a local texmf tree.
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
//
// Determinism: TeX stamps the dump with the current date, so the clock is
// frozen (SOURCE_DATE_EPOCH, default below). Same inputs, same bytes, any day.
//
// Every resolved file is recorded with its sha256 in the evidence JSON, which
// is what makes the format's inputs auditable without trusting a mirror.

import { createHash } from 'node:crypto'
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
const outPath = path.resolve(arg('out', path.join(distDir, 'wasmtex-pdftex.fmt')))
const evidencePath = arg('evidence', null)
const epoch = Number(arg('epoch', process.env.SOURCE_DATE_EPOCH ?? DEFAULT_EPOCH))
const verbose = process.argv.includes('--verbose')
const quiet = process.argv.includes('--quiet')
const log = (...a) => { if (!quiet) console.error(...a) }

if (!texmfDirs.length || texmfDirs.some((d) => !fs.existsSync(d))) {
  console.error('usage: node tools/build-format.mjs --texmf <tree> [--texmf <tree>...] [--out file] [--evidence file]')
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
  36: ['fonts/truetype/'],
  44: ['fonts/enc/'],                           // encodings
  47: ['fonts/opentype/'],
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

// --- The engine's file requests arrive as synchronous XHR --------------------
// URL shape is <endpoint>pdftex/<format>/<name>; the endpoint is a sentinel
// here, since nothing leaves the machine.
const ENDPOINT = 'texmf-local:/'

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
    const m = /^pdftex\/(\d+)\/(.+)$/.exec(rest)
    if (!m) { this.status = 404; return }
    const format = Number(m[1])
    const name = decodeURIComponent(m[2])
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
const messages = []
let notify = () => {}
const traceMessages = process.argv.includes('--trace-messages')
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
  location: { href: `file://${distDir}/wasmtex-pdftex.worker.js`, search: '' },
  postMessage: deliver,
  close: () => {},
  importScripts: (...names) => {
    for (const name of names) {
      const file = path.join(distDir, name)
      vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file })
    }
  },
}
sandbox.self = sandbox
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)

// One cursor for the whole session: the worker answers several commands with
// the same {cmd:'compile'} shape, so a per-call cursor would let a later wait
// re-match an earlier reply and report the format dump as a compiled PDF.
let cursor = 0
function nextMessage(predicate, timeoutMs, what) {
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
sandbox.__wasmtexWasmBinary = new Uint8Array(fs.readFileSync(path.join(distDir, 'wasmtex-pdftex.wasm')))

log(`engine   ${path.relative(process.cwd(), distDir)}`)
for (const [i, d] of texmfDirs.entries()) log(`texmf${i === 0 ? "    " : "+   "} ${d}`)
log(`clock    frozen at ${new Date(frozenMs).toISOString()} (epoch ${epoch})`)
vm.runInContext(
  fs.readFileSync(path.join(distDir, 'wasmtex-pdftex.worker.js'), 'utf8'),
  context,
  { filename: path.join(distDir, 'wasmtex-pdftex.worker.js') },
)

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

log(`format   ${path.relative(process.cwd(), outPath)}`)
log(`bytes    ${fmt.length}`)
log(`sha256   ${sha}`)
log(`built in ${seconds}s from ${formatInputs.length} texmf files (${formatMissing.length} requests unsatisfied)`)
if (unknownFormats.size) {
  log(`note: kpathsea format ids with no subtree mapping: ${[...unknownFormats].sort((a, b) => a - b).join(', ')}`)
}

// --- Smoke: the only proof that matters is that the format typesets ----------
// A format that dumps cleanly can still be built from the wrong inputs. This
// loads the bytes we just wrote back into the same engine and compiles a
// document with them, so a broken format fails here rather than in a browser.
if (process.argv.includes("--smoke")) {
  const doc = [
    "\\documentclass{article}",
    "\\begin{document}",
    "Format smoke test. $E = mc^2$",
    "\\end{document}",
    "",
  ].join("\n")
  sandbox.onmessage({ data: { cmd: "loadformat", data: new Uint8Array(fmt).buffer } })
  await nextMessage((m) => m.cmd === "loadformat", 30000, "the format to load")
  sandbox.onmessage({ data: { cmd: "writefile", url: "main.tex", src: doc } })
  await nextMessage((m) => m.cmd === "writefile", 30000, "the document to be written")
  sandbox.onmessage({ data: { cmd: "setmainfile", url: "main.tex" } })
  sandbox.onmessage({ data: { cmd: "compilelatex" } })
  const run = await nextMessage((m) => m.cmd === "compile", 5 * 60 * 1000, "the smoke compile")
  const pdf = run.pdf ? Buffer.from(run.pdf) : null
  if (run.result !== "ok" || !pdf || pdf.subarray(0, 5).toString() !== "%PDF-") {
    console.error(run.log ?? "")
    console.error("\nsmoke compile failed: the format does not typeset")
    process.exit(1)
  }
  log(`smoke    compiled a document with this format, ${pdf.length} byte PDF`)
}

if (evidencePath) {
  fs.writeFileSync(evidencePath, JSON.stringify({
    procedure: 'node tools/build-format.mjs',
    engine: 'pdftex',
    texmf: texmfDirs,
    sourceDateEpoch: epoch,
    format: { name: path.basename(outPath), bytes: fmt.length, sha256: sha },
    inputs: formatInputs.sort((a, b) => a.path.localeCompare(b.path)),
    unsatisfied: formatMissing,
  }, null, 2) + '\n')
  log(`evidence ${path.relative(process.cwd(), evidencePath)}`)
}
console.log(sha)
