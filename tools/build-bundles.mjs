#!/usr/bin/env node
// Build the delivery bundles the browser resolver fetches, from the same
// vendored texmf trees the format build takes.
//
// SPEC-latex.md ("Package delivery: bundles, not files") explains why: the
// worker's per-file XHR model makes one request per .sty/.tfm/.map, which
// blows both Cloudflare's request quota and the Workers static-asset file
// count on a full TeX Live tree. Grouping the tree into one tar per texmf
// package directory (tools/bundle-rules.mjs decides the grouping) cuts a
// cold compile to a handful of requests and a warm one to zero, and the
// bundle count comfortably clears the 20,000-file static-asset cap.
//
//   node tools/build-bundles.mjs --texmf <texmf-dist> [--texmf <texmf-var>] \
//     --out <dir> [--evidence <file>] [--epoch N] [--core <file>] \
//     [--include-latex-dev] [--split-bytes N] [--quiet] \
//     [--extra <texmf-relative-path>=<file> ...]
//
// --extra adds a file from outside the texmf trees to the index under the
// given texmf-relative path, as if it were one more file the trees walk had
// found: it goes through bundleFor() for grouping, the core merge, the
// receipt and RECEIPT-FILES.json.gz, and the same determinism and idempotence
// as any tree file. A path also present in a texmf tree is a fatal collision,
// same as a collision between two trees. Repeatable. Used to add
// xetexfontlist.txt (built by tools/xetex-fontlist.mjs, which has no
// counterpart in TeX Live) to the index under
// tex/xetex/fontlist/xetexfontlist.txt.
//
// Determinism: every tar is ustar with members sorted by path, mode 0644,
// uid/gid 0, mtime fixed at SOURCE_DATE_EPOCH, and no compression (the HTTP
// layer compresses in flight). Same input trees, same bytes, every time -
// which is what makes the receipt's digests mean anything. The build is
// idempotent too: a bundle whose digested output path already exists is not
// rewritten.
//
// Memory: bundles are built one at a time and written straight to a temp
// file while hashing, then renamed to <out>/b/<sha256>/<slug>.tar. The whole
// tree (millions of files across ~4 GB) is never held in memory at once.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { bundleFor, slugFor, DEFAULT_CORE, EXCLUDED_BUNDLE_PREFIXES } from './bundle-rules.mjs'

// 2026-03-01T00:00:00Z, same fixed epoch build-format.mjs uses.
const DEFAULT_EPOCH = 1772323200
// A static asset may not exceed 25 MiB. Split at 20 MiB of *tar* bytes, headers
// and padding included, so no part gets near the limit however the members fall.
const DEFAULT_SPLIT_BYTES = 20 * 1024 * 1024

function argAll(name) {
  const out = []
  process.argv.forEach((a, i) => { if (a === `--${name}`) out.push(process.argv[i + 1]) })
  return out
}
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const texmfDirs = argAll('texmf').filter(Boolean).map((d) => path.resolve(d))
const extraArgs = argAll('extra').filter(Boolean)
const outDir = path.resolve(arg('out', 'wasm-build/dist/bundles'))
const evidencePath = arg('evidence', null)
const epoch = Number(arg('epoch', process.env.SOURCE_DATE_EPOCH ?? DEFAULT_EPOCH))
const includeLatexDev = process.argv.includes('--include-latex-dev')
const quiet = process.argv.includes('--quiet')
const splitBytes = Number(arg('split-bytes', DEFAULT_SPLIT_BYTES))
const corePath = arg('core', null)
const log = (...a) => { if (!quiet) console.error(...a) }

if (!texmfDirs.length || texmfDirs.some((d) => !fs.existsSync(d))) {
  console.error('usage: node tools/build-bundles.mjs --texmf <dir> [--texmf <dir>...] --out <dir> [--evidence file] [--extra <relpath>=<file>...]')
  process.exit(2)
}

const extras = extraArgs.map((spec) => {
  const eq = spec.indexOf('=')
  if (eq <= 0) {
    console.error(`fatal: --extra must be <texmf-relative-path>=<file>, got: ${spec}`)
    process.exit(2)
  }
  const rel = spec.slice(0, eq)
  const abs = path.resolve(spec.slice(eq + 1))
  if (!fs.existsSync(abs)) {
    console.error(`fatal: --extra file not found: ${abs}`)
    process.exit(1)
  }
  return { rel, abs }
})

const coreList = corePath
  ? JSON.parse(fs.readFileSync(corePath, 'utf8'))
  : DEFAULT_CORE
const coreSet = new Set(coreList)

const excludedPrefixes = includeLatexDev ? [] : EXCLUDED_BUNDLE_PREFIXES

function isExcluded(bundleName) {
  return excludedPrefixes.some((p) => bundleName === p || bundleName.startsWith(`${p}/`))
}

// --- walk the trees -----------------------------------------------------------
// entries: relPath (texmf-relative, forward-slash) -> { absPath, treeIndex }
const SKIP_TOP = new Set(['doc', 'source', 'tlpkg'])

function walkTree(root, treeIndex, onlyFontsMap, visit) {
  const seenDirs = new Set()
  ;(function walk(current, relParts) {
    let real
    try {
      real = fs.realpathSync(current)
    } catch {
      return
    }
    if (seenDirs.has(real)) return
    seenDirs.add(real)
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (relParts.length === 0 && SKIP_TOP.has(entry.name)) continue
      if (relParts.length === 0 && entry.name === 'ls-R') continue
      const abs = path.join(current, entry.name)
      const rel = [...relParts, entry.name]
      if (onlyFontsMap) {
        // Second-and-later trees contribute only fonts/map/.
        if (rel.length === 1 && entry.name !== 'fonts') continue
        if (rel.length === 2 && rel[0] === 'fonts' && entry.name !== 'map') continue
      }
      let st
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(abs, rel)
      } else if (st.isFile()) {
        visit(rel.join('/'), abs, st.size)
      }
    }
  })(root, [])
}

log(`walking ${texmfDirs.length} tree(s)`)
const relToAbs = new Map() // relPath -> absPath
const relOwnerTree = new Map() // relPath -> treeIndex, for collision error messages

texmfDirs.forEach((root, treeIndex) => {
  const onlyFontsMap = treeIndex > 0
  log(`  [${treeIndex}] ${root}${onlyFontsMap ? ' (fonts/map/ only)' : ''}`)
  walkTree(root, treeIndex, onlyFontsMap, (rel, abs) => {
    if (relToAbs.has(rel)) {
      // The one expected overlap: texmf-dist ships its own baked-in
      // fonts/map/*/updmap/* files (e.g. pdftex.map) alongside the ones
      // updmap-sys regenerated into texmf-var beside it. Per the spec,
      // texmf-var exists specifically to supply the "generated map problem"
      // files, so its copy is the authoritative one and overrides the
      // dist copy here - this is not a real conflict, it is what a second
      // tree is for. Any other collision (same relative path from two
      // trees for a reason other than this) is still a hard error.
      if (treeIndex > 0 && rel.startsWith('fonts/map/')) {
        relToAbs.set(rel, abs)
        relOwnerTree.set(rel, treeIndex)
        return
      }
      const prevTree = texmfDirs[relOwnerTree.get(rel)]
      console.error(`fatal: path collision across trees: ${rel}`)
      console.error(`  first seen in ${prevTree}`)
      console.error(`  again in       ${root}`)
      process.exit(1)
    }
    relToAbs.set(rel, abs)
    relOwnerTree.set(rel, treeIndex)
  })
})
log(`indexed ${relToAbs.size} files`)

if (extras.length) {
  log(`adding ${extras.length} extra file(s)`)
  for (const { rel, abs } of extras) {
    if (relToAbs.has(rel)) {
      console.error(`fatal: --extra path collides with a texmf tree path: ${rel}`)
      process.exit(1)
    }
    relToAbs.set(rel, abs)
    log(`  + ${rel} (extra, ${abs})`)
  }
}

// --- group into bundles --------------------------------------------------------
// bundleName -> array of relPaths (unsorted at this point)
const bundleMembers = new Map()
const excludedFiles = []

for (const rel of relToAbs.keys()) {
  const raw = bundleFor(rel)
  if (raw === null) continue
  if (isExcluded(raw)) {
    excludedFiles.push(rel)
    continue
  }
  const name = coreSet.has(raw) ? 'core' : raw
  if (!bundleMembers.has(name)) bundleMembers.set(name, [])
  bundleMembers.get(name).push(rel)
}

// Sort each bundle's members by plain byte order on the path string.
function byteOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}
for (const members of bundleMembers.values()) members.sort(byteOrder)

// --- split oversized bundles ----------------------------------------------------
// name -> array of { partName, members }
const finalBundles = new Map()
for (const [name, members] of [...bundleMembers.entries()].sort((a, b) => byteOrder(a[0], b[0]))) {
  let total = 1024 // the two zero blocks that end every tar
  for (const rel of members) total += tarSize(rel)
  if (total <= splitBytes) {
    finalBundles.set(name, members)
    continue
  }
  let part = 1
  let cur = []
  let curBytes = 0
  for (const rel of members) {
    const sz = tarSize(rel)
    if (curBytes > 0 && curBytes + sz + 1024 > splitBytes) {
      finalBundles.set(`${name}.part${part}`, cur)
      part += 1
      cur = []
      curBytes = 0
    }
    cur.push(rel)
    curBytes += sz
  }
  if (cur.length) finalBundles.set(`${name}.part${part}`, cur)
}

function relSize(rel) {
  return fs.statSync(relToAbs.get(rel)).size
}

// What a member costs inside the tar: a 512-byte header, a second header plus
// a padded name block when the path needs a GNU long-name entry, and the data
// padded to a 512-byte boundary.
function tarSize(rel) {
  const size = relSize(rel)
  const nameBytes = Buffer.byteLength(rel, 'utf8')
  const longName = nameBytes >= 100 ? 512 + Math.ceil((nameBytes + 1) / 512) * 512 : 0
  return longName + 512 + Math.ceil(size / 512) * 512
}

// --- tar writer -----------------------------------------------------------------
// Minimal ustar writer: regular files only, GNU long-name ('L') entries for
// paths >= 100 bytes (the prefix field is deliberately left zeroed - long
// names go through the GNU extension instead, which every reader, including
// the thirty-line one this project will ship, already knows how to handle).

function octal(num, len) {
  // len includes the trailing NUL; ustar octal fields are zero-padded ASCII.
  const s = num.toString(8)
  const buf = Buffer.alloc(len)
  buf.write(s.padStart(len - 1, '0'), 0, 'ascii')
  buf[len - 1] = 0
  return buf
}

function buildHeader({ name, size, mtime, typeflag }) {
  const buf = Buffer.alloc(512)
  buf.write(name.slice(0, 100), 0, 'utf8') // name (0-100), truncated names go through 'L' entries instead
  octal(0o644, 8).copy(buf, 100) // mode
  octal(0, 8).copy(buf, 108) // uid
  octal(0, 8).copy(buf, 116) // gid
  octal(size, 12).copy(buf, 124) // size
  octal(mtime, 12).copy(buf, 136) // mtime
  buf.write('        ', 148, 8, 'ascii') // checksum placeholder: 8 spaces while summing
  buf[156] = typeflag.charCodeAt(0) // typeflag
  // linkname (157-257), uname/gname (265-297/297-329), devmajor/devminor,
  // and prefix (345-500) are all left zeroed - no prefix field usage, empty
  // uname/gname as the spec asks for.
  buf.write('ustar\0', 257, 6, 'ascii') // magic "ustar\0"
  buf.write('00', 263, 2, 'ascii') // version

  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  // Standard ustar checksum form: 6 octal digits, then NUL, then space.
  const csum = sum.toString(8).padStart(6, '0')
  buf.write(csum, 148, 6, 'ascii')
  buf[154] = 0
  buf[155] = 0x20
  return buf
}

function longNameHeader(name) {
  const nameBuf = Buffer.from(`${name}\0`, 'utf8')
  const header = buildHeader({ name: '././@LongLink', size: nameBuf.length, mtime: 0, typeflag: 'L' })
  const blocks = Math.ceil(nameBuf.length / 512)
  const body = Buffer.alloc(blocks * 512)
  nameBuf.copy(body, 0)
  return Buffer.concat([header, body])
}

function fileEntry(relPath, absPath, mtime) {
  const size = fs.statSync(absPath).size
  const chunks = []
  if (Buffer.byteLength(relPath, 'utf8') >= 100) {
    chunks.push(longNameHeader(relPath))
  }
  chunks.push(buildHeader({ name: relPath, size, mtime, typeflag: '0' }))
  const data = fs.readFileSync(absPath)
  chunks.push(data)
  const pad_ = (512 - (data.length % 512)) % 512
  if (pad_) chunks.push(Buffer.alloc(pad_))
  return Buffer.concat(chunks)
}

// --- write bundles ----------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true })
const bDir = path.join(outDir, 'b')
fs.mkdirSync(bDir, { recursive: true })
const tmpDir = path.join(outDir, '.tmp')
fs.mkdirSync(tmpDir, { recursive: true })

const bundlesIndex = {}
const filesIndex = {}
let splitCount = 0
let totalBytes = 0
let totalFiles = 0
const evidenceBundles = []

const sortedBundleNames = [...finalBundles.keys()].sort(byteOrder)
for (const name of sortedBundleNames) {
  const members = finalBundles.get(name)
  const slug = slugFor(name)
  const tmpPath = path.join(tmpDir, `${slug}-${process.pid}-${Math.random().toString(36).slice(2)}.tar`)
  const ws = fs.createWriteStream(tmpPath)
  const hash = createHash('sha256')
  let size = 0

  await new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('open', async () => {
      try {
        for (const rel of members) {
          const abs = relToAbs.get(rel)
          const entry = fileEntry(rel, abs, epoch)
          hash.update(entry)
          size += entry.length
          if (!ws.write(entry)) await new Promise((r) => ws.once('drain', r))
        }
        const trailer = Buffer.alloc(1024)
        hash.update(trailer)
        size += trailer.length
        ws.end(trailer, () => resolve())
      } catch (e) {
        reject(e)
      }
    })
  })

  const digest = hash.digest('hex')
  const destDir = path.join(bDir, digest)
  const destPath = path.join(destDir, `${slug}.tar`)
  if (fs.existsSync(destPath)) {
    fs.rmSync(tmpPath, { force: true })
    log(`  = ${name} (unchanged, ${digest.slice(0, 12)})`)
  } else {
    fs.mkdirSync(destDir, { recursive: true })
    fs.renameSync(tmpPath, destPath)
    log(`  + ${name} (${size} bytes, ${digest.slice(0, 12)})`)
  }

  const url = `b/${digest}/${slug}.tar`
  bundlesIndex[name] = { url, size, sha256: digest, files: members.length }
  for (const rel of members) filesIndex[rel] = name
  totalBytes += size
  totalFiles += members.length
  if (name.includes('.part')) splitCount += 1
  evidenceBundles.push({ name, url, size, sha256: digest, files: members.length })
}
fs.rmSync(tmpDir, { recursive: true, force: true })

// --- write bundles.json --------------------------------------------------------

function sortedObject(obj) {
  const out = {}
  for (const k of Object.keys(obj).sort(byteOrder)) out[k] = obj[k]
  return out
}

// The snapshot is the release archive's name. The first tree is normally the
// archive's texmf-dist/ directory, whose own basename says nothing.
const snapshot = path.basename(texmfDirs[0]) === 'texmf-dist'
  ? path.basename(path.dirname(texmfDirs[0]))
  : path.basename(texmfDirs[0])
const index = {
  schemaVersion: 1,
  snapshot,
  sourceDateEpoch: epoch,
  bundles: sortedObject(bundlesIndex),
  files: sortedObject(filesIndex),
}
const indexJson = `${JSON.stringify(index, null, 2)}\n`
const indexPath = path.join(outDir, 'bundles.json')
fs.writeFileSync(indexPath, indexJson)
const indexSha = createHash('sha256').update(indexJson).digest('hex')

// --- RECEIPT-FILES.json.gz ------------------------------------------------------
// Every member of every bundle with its hash: an audit record, read by nobody
// at runtime, and over 25 MiB as plain JSON, which a static asset may not be.
// Shipped gzipped; zlib writes no timestamp, so the bytes are reproducible.

const fileRecords = []
for (const rel of [...relToAbs.keys()].sort(byteOrder)) {
  const bundle = filesIndex[rel]
  if (bundle === undefined) continue // excluded (doc/, source/, latex-dev, etc.)
  const abs = relToAbs.get(rel)
  const data = fs.readFileSync(abs)
  fileRecords.push({
    path: rel,
    bundle,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  })
}
fs.writeFileSync(
  path.join(outDir, 'RECEIPT-FILES.json.gz'),
  gzipSync(Buffer.from(`${JSON.stringify(fileRecords, null, 2)}\n`), { level: 9 }),
)
fs.rmSync(path.join(outDir, 'RECEIPT-FILES.json'), { force: true })

// --- evidence -------------------------------------------------------------------

if (evidencePath) {
  const evidence = {
    procedure: 'node tools/build-bundles.mjs',
    texmf: texmfDirs.map((d) => path.relative(process.cwd(), d)),
    sourceDateEpoch: epoch,
    excluded: excludedPrefixes,
    core: coreList,
    index: { bytes: Buffer.byteLength(indexJson), sha256: indexSha },
    bundles: evidenceBundles.sort((a, b) => byteOrder(a.name, b.name)),
    totals: { bundles: evidenceBundles.length, files: totalFiles, bytes: totalBytes },
  }
  fs.mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true })
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  log(`evidence -> ${evidencePath}`)
}

log(`${evidenceBundles.length} bundles, ${totalFiles} files, ${totalBytes} bytes, ${splitCount} split part(s)`)
console.log(indexSha)
