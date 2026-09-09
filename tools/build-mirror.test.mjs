import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(tmpdir(), 'wasm-latex-mirror-'))
const stage = fileURLToPath(new URL('./stage-release.mjs', import.meta.url))
const buildMirror = fileURLToPath(new URL('./build-mirror.mjs', import.meta.url))
const checkMirror = fileURLToPath(new URL('./check-mirror.mjs', import.meta.url))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function write(name, content) {
  const p = path.join(root, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const data = Buffer.isBuffer(content) || typeof content === 'string' ? content : JSON.stringify(content)
  fs.writeFileSync(p, data)
}

// --- a minimal ustar writer, just enough for one small file per bundle -------

function octal(num, len) {
  const s = num.toString(8)
  const buf = Buffer.alloc(len)
  buf.write(s.padStart(len - 1, '0'), 0, 'ascii')
  buf[len - 1] = 0
  return buf
}

function tarHeader({ name, size, mtime, typeflag }) {
  const buf = Buffer.alloc(512)
  buf.write(name.slice(0, 100), 0, 'utf8')
  octal(0o644, 8).copy(buf, 100)
  octal(0, 8).copy(buf, 108)
  octal(0, 8).copy(buf, 116)
  octal(size, 12).copy(buf, 124)
  octal(mtime, 12).copy(buf, 136)
  buf.write('        ', 148, 8, 'ascii')
  buf[156] = typeflag.charCodeAt(0)
  buf.write('ustar\0', 257, 6, 'ascii')
  buf.write('00', 263, 2, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  const csum = sum.toString(8).padStart(6, '0')
  buf.write(csum, 148, 6, 'ascii')
  buf[154] = 0
  buf[155] = 0x20
  return buf
}

/// Builds an uncompressed ustar tar with one regular-file member, matching
/// what wasm-build/kpse-resolve.cjs's readTar expects (and what
/// tools/build-bundles.mjs actually writes): a header, the data padded to a
/// 512-byte boundary, and a zero-block trailer.
function makeTar(entries) {
  const chunks = []
  for (const [name, data] of entries) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    chunks.push(tarHeader({ name, size: bytes.length, mtime: 0, typeflag: '0' }))
    chunks.push(bytes)
    const pad = (512 - (bytes.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

const BIBLATEX_STY = [
  '\\def\\blx@bcfversion{3.11}',
  '\\def\\abx@version{3.22}',
  '\\def\\abx@date{2026/01/01}',
  '',
].join('\n')

/// Writes a bundle-src/ directory shaped like tools/build-bundles.mjs's
/// output: bundles.json, RECEIPT-FILES.json.gz, b/<sha256>/<slug>.tar, and a
/// receipts/BUNDLE-RECEIPT.<snapshot>.json naming the index's own hash --
/// the same fixture shape stage-release.test.mjs uses, with a `core` bundle
/// that actually contains tex/latex/biblatex/biblatex.sty so
/// bibliographyIdentity has something real to read.
function writeBundleFixture(dir, { snapshot = 'texlive-test' } = {}) {
  const coreTar = makeTar([
    ['tex/latex/base/latex.ltx', 'core-fixture'],
    ['tex/latex/biblatex/biblatex.sty', BIBLATEX_STY],
  ])
  const tikzTar = makeTar([['tex/latex/tikz/tikz.sty', 'tikz-fixture']])
  const coreSha = hash(coreTar)
  const tikzSha = hash(tikzTar)
  write(`${dir}/b/${coreSha}/core.tar`, coreTar)
  write(`${dir}/b/${tikzSha}/tex-latex-tikz.tar`, tikzTar)
  const bundles = {
    core: { url: `b/${coreSha}/core.tar`, size: coreTar.length, sha256: coreSha, files: 2 },
    'tex/latex/tikz': { url: `b/${tikzSha}/tex-latex-tikz.tar`, size: tikzTar.length, sha256: tikzSha, files: 1 },
  }
  const index = {
    schemaVersion: 1,
    snapshot,
    sourceDateEpoch: 1234567890,
    bundles,
    files: {
      'tex/latex/base/latex.ltx': 'core',
      'tex/latex/biblatex/biblatex.sty': 'core',
      'tex/latex/tikz/tikz.sty': 'tex/latex/tikz',
    },
  }
  const indexBytes = Buffer.from(JSON.stringify(index))
  write(`${dir}/bundles.json`, indexBytes)
  write(`${dir}/RECEIPT-FILES.json.gz`, Buffer.from('fixture'))
  write(`receipts/BUNDLE-RECEIPT.${snapshot}.json`, {
    procedure: 'node tools/build-bundles.mjs',
    texmf: ['fixture-texmf'],
    sourceDateEpoch: 1234567890,
    excluded: [],
    core: ['tex/latex/base'],
    index: { bytes: indexBytes.length, sha256: hash(indexBytes) },
    bundles: [
      { name: 'core', url: `b/${coreSha}/core.tar`, size: coreTar.length, sha256: coreSha, files: 2 },
      { name: 'tex/latex/tikz', url: `b/${tikzSha}/tex-latex-tikz.tar`, size: tikzTar.length, sha256: tikzSha, files: 1 },
    ],
    totals: { bundles: 2, files: 3, bytes: coreTar.length + tikzTar.length },
  })
  return { coreSha, tikzSha }
}

function runStage(bundlesDir) {
  const args = [stage, '--dist', 'engines', '--out', 'staged', '--source-url', 'https://example.org/source.tar.xz']
  if (bundlesDir) args.push('--bundles', bundlesDir)
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'staged/MANIFEST.json')))
  assert.equal(manifest.releaseGate, 'passed', result.stderr)
  return { manifest, digest: hash(fs.readFileSync(path.join(root, 'staged/MANIFEST.json'))) }
}

function runBuildMirror(digest, out = 'mirror') {
  const args = [buildMirror, '--staged', 'staged', '--sha256', digest, '--out', out]
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
}

function runCheckMirror(target = 'mirror') {
  return spawnSync(process.execPath, [checkMirror, target], { cwd: root, encoding: 'utf8' })
}

try {
  // A two-engine fixture: pdfTeX complete (every ENGINE_FILE_SETS.pdftex
  // file present), xetex deliberately incomplete (its .fmt.gz and icu data
  // are missing), so the "advertised only when every file is present" rule
  // has something to actually distinguish.
  const jsNames = [
    'pdftex.worker.js',
    'pdftex.js',
    'pdftex-resolver-evidence.js',
    'kpse-resolve.js',
    'bundle-mode.js',
    // xetex worker present but its format/icu are not, so it must not be
    // advertised as a complete engine.
    'xetex.worker.js',
  ]
  const jsArtifacts = jsNames.map((name) => {
    const bytes = Buffer.from(`fixture:${name}`)
    write(`engines/${name}`, bytes)
    return { name, bytes: bytes.length, sha256: hash(bytes) }
  })
  const binary = { name: 'pdftex.wasm', bytes: Buffer.byteLength('binary'), sha256: hash('binary') }
  write('engines/pdftex.wasm', 'binary')
  write('engines/pdftex.fmt', 'format')

  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/GPL.txt', 'RELINK.md']) write(name, 'fixture')
  write('linked-components.json', {})
  write('LICENSES/README.md', 'fixture')
  write('receipts/LINK-INVENTORY.pdftex.json', {
    family: 'pdftex', combinedTerms: 'GPL-2.0-only', modules: [{ name: 'pdftex' }],
    linked: [{ component: 'fixture', license: 'GPL-2.0-only', source: 'source/' }],
    requiredNotices: ['LICENSES/GPL.txt'],
  })
  write('receipts/FORMAT-RECEIPT.pdftex.json', { format: { sha256: hash('format') }, inputs: [{ name: 'latex.ltx' }] })
  write('receipts/SOURCE-RECEIPT.json', { sha256: 'a'.repeat(64), dirty: false, correspondsTo: [binary, ...jsArtifacts] })

  writeBundleFixture('bundle-src')
  const { manifest: staged, digest } = runStage('bundle-src')
  assert.ok(staged.bundles, 'staged release must carry bundles')

  const built = runBuildMirror(digest)
  assert.equal(built.status, 0, built.stderr)

  const mirror = JSON.parse(fs.readFileSync(path.join(root, 'mirror/manifest.json'), 'utf8'))
  assert.equal(mirror.format, 1, 'manifest.format must be 1')
  const releaseId = mirror.default_release
  const entry = mirror.releases[releaseId]
  assert.ok(entry, 'default_release must resolve to a release entry')

  // Engines: pdftex advertised, xetex withheld because its file set is
  // incomplete.
  assert.ok(entry.engines.pdftex, 'a complete pdftex file set must be advertised')
  assert.ok(!entry.engines.xetex, 'an incomplete xetex file set must not be advertised')

  // No legacy texlive/snapshot fields.
  assert.equal(entry.snapshot, undefined)
  assert.equal(entry.texlive_base, undefined)
  assert.equal(mirror.texlive, undefined)

  // Bundles entry rewritten to the mirror URL, under engines/<engineRelease>/.
  assert.ok(entry.bundles, 'release must carry a bundles entry')
  assert.equal(entry.bundles.index, `${entry.base}bundles/bundles.json`)
  const indexPath = path.join(root, 'mirror', entry.bundles.index)
  assert.ok(fs.existsSync(indexPath), 'bundles.json must be written into the mirror')
  assert.equal(hash(fs.readFileSync(indexPath)), entry.bundles.sha256)

  // Bibliography identity read out of the bundle tar, not the network.
  assert.equal(entry.bibliography.control_file, '3.11')
  assert.equal(entry.bibliography.biblatex, '3.22')
  assert.deepEqual(entry.bibliography.biber.compatible, ['2.21'])

  console.log('build-mirror: manifest shape, engine advertisement, bundles rewrite, and bibliography identity checked')

  // A tampered payload file must be rejected.
  const tamperPath = path.join(root, 'staged', 'pdftex.wasm')
  const original = fs.readFileSync(tamperPath)
  const tampered = Buffer.from(original)
  tampered[0] = tampered[0] ^ 0xff
  fs.writeFileSync(tamperPath, tampered)
  const rejected = runBuildMirror(digest, 'mirror-tampered')
  assert.notEqual(rejected.status, 0, 'a tampered payload file must be rejected')
  fs.writeFileSync(tamperPath, original)
  console.log('build-mirror: tampered payload file rejected')

  // Idempotent: a second run over the same input changes nothing.
  const before = fs.readdirSync(path.join(root, 'mirror', entry.base), { recursive: true }).sort()
  const beforeBytes = fs.readFileSync(indexPath)
  const rerun = runBuildMirror(digest)
  assert.equal(rerun.status, 0, rerun.stderr)
  const after = fs.readdirSync(path.join(root, 'mirror', entry.base), { recursive: true }).sort()
  assert.deepEqual(before, after, 'a second run must not add or remove files')
  assert.deepEqual(beforeBytes, fs.readFileSync(indexPath), 'a second run must not change existing bytes')
  const mirrorAfter = JSON.parse(fs.readFileSync(path.join(root, 'mirror/manifest.json'), 'utf8'))
  assert.deepEqual(mirrorAfter, mirror, 'a second run must produce an identical manifest')
  console.log('build-mirror: idempotent re-run checked')

  // check-mirror.mjs passes on the built mirror.
  const passing = runCheckMirror('mirror')
  assert.equal(passing.status, 0, passing.stderr)
  console.log('check-mirror: passes on a well-formed mirror')

  // ... and fails on a corrupted bundle tar.
  const corePath = path.join(root, 'mirror', entry.base, 'bundles', 'b')
  const coreDigestDir = fs.readdirSync(corePath)[0]
  const coreTarPath = path.join(corePath, coreDigestDir, 'core.tar')
  const coreBytes = fs.readFileSync(coreTarPath)
  const corrupted = Buffer.from(coreBytes)
  corrupted[0] = corrupted[0] ^ 0xff
  fs.writeFileSync(coreTarPath, corrupted)
  const failing = runCheckMirror('mirror')
  assert.notEqual(failing.status, 0, 'a corrupted bundle tar must fail check-mirror')
  assert.match(failing.stderr, /core/, 'the failure must name the corrupted bundle')
  fs.writeFileSync(coreTarPath, coreBytes)
  console.log('check-mirror: fails on a corrupted bundle tar')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
