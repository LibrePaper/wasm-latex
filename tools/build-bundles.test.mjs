// Tests for tools/build-bundles.mjs against a synthetic texmf tree.
//
// Builds a small texmf-dist plus texmf-var pair in a tmpdir covering the
// cases the real tree exercises at scale: a macro package, a font family
// split across tfm/vf/type1, a map file that only exists in the second tree,
// latex-dev (must be excluded by default), doc/ (must be excluded always), a
// path long enough to require a GNU long-name tar entry, and a bundle forced
// over the split threshold with the test-only --split-bytes flag. Runs the
// builder twice to check byte-for-byte determinism and idempotent writes.
//
// Run with: node tools/build-bundles.test.mjs

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const builder = path.join(here, 'build-bundles.mjs')

function mkTree(root) {
  const w = (rel, content) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }

  // A macro package.
  w('tex/latex/amsmath/amsmath.sty', '% amsmath\n')
  w('tex/latex/amsmath/amsopn.sty', '% amsopn\n')
  // base, so we can exercise the core merge.
  w('tex/latex/base/latex.ltx', '% latex.ltx\n')
  // latex-dev, must be excluded by default.
  w('tex/latex-dev/base/latex.ltx', '% dev latex.ltx\n')
  // A font family across three kinds.
  w('fonts/tfm/public/lm/lmroman10-regular.tfm', 'TFMDATA')
  w('fonts/vf/public/lm/lmroman10-regular.vf', 'VFDATA')
  w('fonts/type1/public/lm/lmroman10-regular.pfb', 'PFBDATA')
  // doc/ and source/, always excluded.
  w('doc/latex/amsmath/README', 'readme\n')
  w('source/latex/amsmath/amsmath.dtx', 'dtx\n')
  // tlpkg, always excluded.
  w('tlpkg/tlpobj/amsmath.tlpobj', 'tlpobj\n')
  // ls-R, always excluded.
  w('ls-R', '% ls-R\n')
  // A file with a path >= 100 bytes to force a GNU long-name entry.
  const longPkg = 'a'.repeat(80)
  const longRel = `tex/latex/${longPkg}/${longPkg}-really-long-filename-for-testing.sty`
  assert.ok(Buffer.byteLength(longRel, 'utf8') >= 100, 'fixture path must be >= 100 bytes')
  w(longRel, '% long path file\n')

  // texmf-dist's own copy of a generated map file, which the texmf-var
  // tree also ships (a real overlap in the vendored TeX Live 2026 trees:
  // dist bakes in its own pdftex.map, updmap-sys regenerates another into
  // texmf-var). texmf-var's copy must win.
  w('fonts/map/pdftex/updmap/pdftex.map', '% pdftex.map (dist, stale)\n')

  // A bundle forced over the test split threshold (400 bytes each, well
  // above --split-bytes below, while core's few small files stay under it).
  w('tex/latex/bigpkg/a.sty', '0123456789'.repeat(40))
  w('tex/latex/bigpkg/b.sty', '0123456789'.repeat(40))
  w('tex/latex/bigpkg/c.sty', '0123456789'.repeat(40))

  return { longRel }
}

function mkVarTree(root) {
  const w = (rel, content) => {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  w('fonts/map/pdftex/updmap/pdftex.map', '% pdftex.map (var, regenerated)\n')
  // Non-fonts/map content in the second tree must be ignored.
  w('web2c/updmap.log', 'log\n')
  w('ls-R', '% ls-R\n')
}

function runBuilder(texmfDist, texmfVar, outDir, extraArgs = []) {
  const args = [
    builder,
    '--texmf', texmfDist,
    '--texmf', texmfVar,
    '--out', outDir,
    '--epoch', '1700000000',
    '--split-bytes', '1000',
    '--quiet',
    ...extraArgs,
  ]
  const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' })
  return stdout.trim()
}

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function listFilesRecursive(dir) {
  const out = []
  ;(function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name)
      if (entry.isDirectory()) walk(abs)
      else out.push(abs)
    }
  })(dir)
  return out.sort()
}

// --- a tiny tar reader for round-trip verification ------------------------------
// 512-byte headers; handles GNU 'L' long-name entries. Good enough to check
// what build-bundles.mjs itself writes, not a general-purpose tar reader.
function readTar(buf) {
  const entries = []
  let offset = 0
  let pendingLongName = null
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break // end-of-archive zero block
    offset += 512
    const typeflag = String.fromCharCode(header[156])
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8)
    const dataBlocks = Math.ceil(size / 512)
    const data = buf.subarray(offset, offset + size)
    offset += dataBlocks * 512

    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    const name = pendingLongName ?? rawName
    pendingLongName = null
    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      entries.push({ name, data: Buffer.from(data) })
    }
  }
  return entries
}

test('build-bundles: end-to-end determinism and grouping', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'))
  const texmfDist = path.join(tmp, 'texlive-2026-texmf', 'texmf-dist')
  const texmfVar = path.join(tmp, 'texmf-var')
  const out1 = path.join(tmp, 'out1')
  const out2 = path.join(tmp, 'out2')

  const { longRel } = mkTree(texmfDist)
  mkVarTree(texmfVar)

  const sha1 = runBuilder(texmfDist, texmfVar, out1)
  const sha2 = runBuilder(texmfDist, texmfVar, out2)

  assert.equal(sha1, sha2, 'index sha256 must be identical across runs')

  const index1 = JSON.parse(fs.readFileSync(path.join(out1, 'bundles.json'), 'utf8'))
  const index2 = JSON.parse(fs.readFileSync(path.join(out2, 'bundles.json'), 'utf8'))
  assert.deepEqual(index1, index2, 'index contents must be identical across runs')

  // Schema shape.
  assert.equal(index1.schemaVersion, 1)
  assert.equal(typeof index1.snapshot, 'string')
  assert.equal(index1.sourceDateEpoch, 1700000000)
  assert.ok(index1.bundles && typeof index1.bundles === 'object')
  assert.ok(index1.files && typeof index1.files === 'object')
  for (const [name, b] of Object.entries(index1.bundles)) {
    assert.equal(typeof b.url, 'string', name)
    assert.match(b.url, /^b\/[0-9a-f]{64}\/.+\.tar$/)
    assert.equal(typeof b.size, 'number')
    assert.match(b.sha256, /^[0-9a-f]{64}$/)
    assert.equal(typeof b.files, 'number')
  }
  // Keys sorted.
  assert.deepEqual(Object.keys(index1.bundles), [...Object.keys(index1.bundles)].sort())
  assert.deepEqual(Object.keys(index1.files), [...Object.keys(index1.files)].sort())

  // latex-dev excluded by default.
  assert.ok(!('tex/latex-dev/base/latex.ltx' in index1.files), 'latex-dev must be excluded by default')
  for (const name of Object.keys(index1.bundles)) {
    assert.ok(!name.startsWith('tex/latex-dev'), `bundle ${name} should not be a latex-dev bundle`)
  }

  // doc/ and source/ excluded entirely.
  for (const rel of Object.keys(index1.files)) {
    assert.ok(!rel.startsWith('doc/'), `doc/ leaked in: ${rel}`)
    assert.ok(!rel.startsWith('source/'), `source/ leaked in: ${rel}`)
    assert.ok(!rel.startsWith('tlpkg/'), `tlpkg/ leaked in: ${rel}`)
    assert.notEqual(rel, 'ls-R')
  }

  // The map file from texmf-var joins core, alongside tex/latex/base and
  // amsmath (which is in DEFAULT_CORE), overriding dist's own stale copy.
  assert.equal(index1.files['fonts/map/pdftex/updmap/pdftex.map'], 'core')
  assert.equal(index1.files['tex/latex/base/latex.ltx'], 'core')
  assert.equal(index1.files['tex/latex/amsmath/amsmath.sty'], 'core')
  // web2c/updmap.log from the second tree must NOT appear (only fonts/map/
  // is taken from texmf-var).
  assert.ok(!('web2c/updmap.log' in index1.files))

  // Font family bundle groups tfm/vf/type1 together.
  const fontBundle = index1.files['fonts/tfm/public/lm/lmroman10-regular.tfm']
  assert.equal(fontBundle, 'fonts/public/lm')
  assert.equal(index1.files['fonts/vf/public/lm/lmroman10-regular.vf'], fontBundle)
  assert.equal(index1.files['fonts/type1/public/lm/lmroman10-regular.pfb'], fontBundle)

  // Split bundle: bigpkg is 30 bytes > --split-bytes 25, so it must be split.
  const bigpkgParts = Object.keys(index1.bundles).filter((n) => n.startsWith('tex/latex/bigpkg'))
  assert.ok(bigpkgParts.length >= 2, `expected bigpkg to be split, got: ${bigpkgParts.join(', ')}`)
  assert.ok(bigpkgParts.every((n) => /^tex\/latex\/bigpkg(\.part\d+)?$/.test(n)))
  for (const rel of ['tex/latex/bigpkg/a.sty', 'tex/latex/bigpkg/b.sty', 'tex/latex/bigpkg/c.sty']) {
    assert.ok(bigpkgParts.includes(index1.files[rel]), `${rel} should map to one of the split parts`)
  }

  // Idempotent write: second run must not rewrite any tar (mtimes preserved).
  const files1 = listFilesRecursive(path.join(out1, 'b'))
  const statsBefore = new Map(files1.map((f) => [f, fs.statSync(f).mtimeMs]))
  runBuilder(texmfDist, texmfVar, out1) // third run, same out dir
  for (const [f, mtime] of statsBefore) {
    assert.equal(fs.statSync(f).mtimeMs, mtime, `tar should not be rewritten: ${f}`)
  }

  // Every tar under out1/b matches its digest and parses; round-trip content.
  const relPathToContent = new Map()
  for (const rel of Object.keys(index1.files)) {
    // amsmath merges into core so it is not attempted to be read straight
    // from an "amsmath" bundle - just verify by reading from the source tree.
  }
  const allTars = listFilesRecursive(path.join(out1, 'b')).filter((f) => f.endsWith('.tar'))
  assert.ok(allTars.length > 0)
  const memberContents = new Map()
  for (const tarPath of allTars) {
    const digest = path.basename(path.dirname(tarPath))
    assert.equal(sha256File(tarPath), digest, `tar filename directory must match its sha256: ${tarPath}`)
    const buf = fs.readFileSync(tarPath)
    assert.equal(buf.length % 512, 0, 'tar length must be a multiple of 512')
    const entries = readTar(buf)
    for (const e of entries) memberContents.set(e.name, e.data)
  }

  // Round-trip: every original file's content matches what came out of its tar.
  const originalRelPaths = [
    'tex/latex/amsmath/amsmath.sty',
    'tex/latex/amsmath/amsopn.sty',
    'tex/latex/base/latex.ltx',
    'fonts/tfm/public/lm/lmroman10-regular.tfm',
    'fonts/vf/public/lm/lmroman10-regular.vf',
    'fonts/type1/public/lm/lmroman10-regular.pfb',
    'tex/latex/bigpkg/a.sty',
    'tex/latex/bigpkg/b.sty',
    'tex/latex/bigpkg/c.sty',
    longRel,
  ]
  for (const rel of originalRelPaths) {
    assert.ok(memberContents.has(rel), `tar members should include ${rel}`)
    const original = fs.readFileSync(path.join(texmfDist, rel))
    assert.deepEqual(memberContents.get(rel), original, `content mismatch for ${rel}`)
  }
  // The long path in particular, since it exercises the GNU 'L' entry path.
  assert.ok(Buffer.byteLength(longRel, 'utf8') >= 100)
  assert.deepEqual(memberContents.get(longRel), fs.readFileSync(path.join(texmfDist, longRel)))

  // texmf-var's pdftex.map must have overridden texmf-dist's stale copy.
  assert.deepEqual(
    memberContents.get('fonts/map/pdftex/updmap/pdftex.map'),
    fs.readFileSync(path.join(texmfVar, 'fonts/map/pdftex/updmap/pdftex.map')),
  )

  // RECEIPT-FILES.json sanity.
  const receipt = JSON.parse(fs.readFileSync(path.join(out1, 'RECEIPT-FILES.json'), 'utf8'))
  assert.ok(Array.isArray(receipt))
  const receiptPaths = receipt.map((r) => r.path)
  assert.deepEqual(receiptPaths, [...receiptPaths].sort())
  for (const r of receipt) {
    assert.equal(typeof r.bundle, 'string')
    assert.equal(typeof r.bytes, 'number')
    assert.match(r.sha256, /^[0-9a-f]{64}$/)
  }

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('build-bundles: --include-latex-dev re-enables latex-dev', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-dev-'))
  const texmfDist = path.join(tmp, 'texmf-dist')
  const texmfVar = path.join(tmp, 'texmf-var')
  const out = path.join(tmp, 'out')
  mkTree(texmfDist)
  mkVarTree(texmfVar)

  runBuilder(texmfDist, texmfVar, out, ['--include-latex-dev'])
  const index = JSON.parse(fs.readFileSync(path.join(out, 'bundles.json'), 'utf8'))
  assert.ok('tex/latex-dev/base/latex.ltx' in index.files)

  fs.rmSync(tmp, { recursive: true, force: true })
})
