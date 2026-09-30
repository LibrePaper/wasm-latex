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
  // Large and highly compressible, exercising preservation of the payload
  // bytes an HTTP server may compress when serving the object.
  const FMT = Buffer.from('format '.repeat(2000))
  write('engines/pdftex.fmt', FMT)

  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/GPL.txt', 'RELINK.md']) write(name, 'fixture')
  write('linked-components.json', {})
  write('LICENSES/README.md', 'fixture')
  write('receipts/LINK-INVENTORY.pdftex.json', {
    family: 'pdftex', combinedTerms: 'GPL-2.0-only', modules: [{ name: 'pdftex' }],
    linked: [{ component: 'fixture', license: 'GPL-2.0-only', source: 'source/' }],
    requiredNotices: ['LICENSES/GPL.txt'],
  })
  write('receipts/FORMAT-RECEIPT.pdftex.json', { format: { sha256: hash(FMT) }, inputs: [{ name: 'latex.ltx' }] })
  write('receipts/SOURCE-RECEIPT.json', { sha256: 'a'.repeat(64), dirty: false, correspondsTo: [binary, ...jsArtifacts] })

  writeBundleFixture('bundle-src')
  const { manifest: staged, digest } = runStage('bundle-src')
  assert.ok(staged.bundles, 'staged release must carry bundles')

  const built = runBuildMirror(digest)
  assert.equal(built.status, 0, built.stderr)

  // Exactly one release directory plus _headers; no top-level manifest, no
  // engines/ level.
  assert.deepEqual(fs.readdirSync(path.join(root, 'mirror')).sort(), [digest, '_headers'].sort())
  const releaseId = digest
  const releaseRoot = path.join(root, 'mirror', releaseId)
  assert.deepEqual(fs.readFileSync(path.join(releaseRoot, 'MANIFEST.json')), fs.readFileSync(path.join(root, 'staged/MANIFEST.json')))
  const headers = fs.readFileSync(path.join(root, 'mirror/_headers'), 'utf8')
  assert.match(headers, /immutable/)
  assert.doesNotMatch(headers, /no-store|no-cache/)
  const entry = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'release.json'), 'utf8'))
  assert.equal(entry.format, 2, 'release.json format must be 2')
  assert.equal(entry.id, releaseId)
  assert.equal(entry.base, undefined, 'paths are release-relative; there is no base')

  // Engines: pdftex advertised, xetex withheld because its file set is
  // incomplete.
  assert.ok(entry.engines.pdftex, 'a complete pdftex file set must be advertised')
  assert.ok(!entry.engines.xetex, 'an incomplete xetex file set must not be advertised')

  // No legacy texlive/snapshot fields.
  assert.equal(entry.snapshot, undefined)
  assert.equal(entry.texlive_base, undefined)

  // Every file url is its release-relative name.
  for (const [name, info] of Object.entries(entry.files)) assert.equal(info.url, name)

  // Bundles entry is release-relative.
  assert.ok(entry.bundles, 'release must carry a bundles entry')
  assert.equal(entry.bundles.index, 'bundles/bundles.json')
  const indexPath = path.join(releaseRoot, entry.bundles.index)
  assert.ok(fs.existsSync(indexPath), 'bundles.json must be written into the release')
  assert.equal(hash(fs.readFileSync(indexPath)), entry.bundles.sha256)

  // Bibliography identity read out of the bundle tar, not the network.
  assert.equal(entry.bibliography.control_file, '3.11')
  assert.equal(entry.bibliography.biblatex, '3.22')
  assert.deepEqual(entry.bibliography.biber.compatible, ['2.21'])

  const fmtPath = path.join(releaseRoot, entry.files['pdftex.fmt'].url)
  assert.deepEqual(fs.readFileSync(fmtPath), FMT, 'the mirror must preserve original payload bytes')

  console.log('build-mirror: layout, release.json shape, engine advertisement, bundles path, and bibliography identity checked')

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
  const before = fs.readdirSync(path.join(root, 'mirror'), { recursive: true }).sort()
  const beforeBytes = fs.readFileSync(indexPath)
  const beforeRelease = fs.readFileSync(path.join(releaseRoot, 'release.json'))
  const rerun = runBuildMirror(digest)
  assert.equal(rerun.status, 0, rerun.stderr)
  const after = fs.readdirSync(path.join(root, 'mirror'), { recursive: true }).sort()
  assert.deepEqual(before, after, 'a second run must not add or remove files')
  assert.deepEqual(beforeBytes, fs.readFileSync(indexPath), 'a second run must not change existing bytes')
  assert.deepEqual(beforeRelease, fs.readFileSync(path.join(releaseRoot, 'release.json')), 'a second run must produce an identical release.json')
  console.log('build-mirror: idempotent re-run checked')

  // The out directory is owned by the build: stale layout is cleared.
  write('mirror/manifest.json', '{}')
  write(`mirror/engines/${releaseId}/stale.js`, 'stale')
  write(`mirror/${'0'.repeat(64)}/release.json`, '{}')
  assert.equal(runBuildMirror(digest).status, 0)
  assert.deepEqual(fs.readdirSync(path.join(root, 'mirror')).sort(), [digest, '_headers'].sort(), 'a rebuild must clear stale content')
  console.log('build-mirror: stale layout cleared on rebuild')

  // check-mirror.mjs passes on the built mirror.
  const passing = runCheckMirror('mirror')
  assert.equal(passing.status, 0, passing.stderr)
  console.log('check-mirror: passes on a well-formed mirror')

  // ... and rejects a stray top-level file, an unlisted file in the release,
  // and a directory that is not the sha256 of its MANIFEST.json.
  write('mirror/manifest.json', '{}')
  assert.notEqual(runCheckMirror('mirror').status, 0, 'a top-level manifest.json must fail check-mirror')
  fs.rmSync(path.join(root, 'mirror/manifest.json'))
  write(`mirror/${releaseId}/extra.txt`, 'unlisted')
  assert.notEqual(runCheckMirror('mirror').status, 0, 'an unlisted file must fail check-mirror')
  fs.rmSync(path.join(root, `mirror/${releaseId}/extra.txt`))
  fs.renameSync(path.join(root, 'mirror', releaseId), path.join(root, 'mirror', 'a'.repeat(64)))
  assert.notEqual(runCheckMirror('mirror').status, 0, 'a misnamed release directory must fail check-mirror')
  fs.renameSync(path.join(root, 'mirror', 'a'.repeat(64)), path.join(root, 'mirror', releaseId))
  assert.equal(runCheckMirror('mirror').status, 0)
  console.log('check-mirror: fails on stray files and a misnamed release directory')

  // ... and fails on a corrupted bundle tar.
  const corePath = path.join(releaseRoot, 'bundles', 'b')
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

  // Biber is a complete release family: glue, worker, WASM, data and build
  // identity must all survive staging and be discoverable from the mirror.
  const biberNames = ['biber.worker.js', 'biber.js', 'biber.wasm', 'biber.data']
  const biberArtifacts = biberNames.map(name => {
    const bytes = Buffer.from(`fixture:${name}`)
    write(`engines/${name}`, bytes)
    return { name, bytes: bytes.length, sha256: hash(bytes) }
  })
  const biberBuild = {
    version: '2.22', controlFile: '3.11', sourceArchive: { sha256: 'b'.repeat(64) },
    artifacts: Object.fromEntries(biberArtifacts.map(a => [a.name, a])),
  }
  write('engines/biber.build.json', biberBuild)
  const buildBytes = fs.readFileSync(path.join(root, 'engines/biber.build.json'))
  biberArtifacts.push({ name: 'biber.build.json', bytes: buildBytes.length, sha256: hash(buildBytes) })
  for (const name of ['LICENSE', 'NOTICE', 'UPSTREAM.json']) write(`third-party/texlyre-biber/${name}`, 'fixture')
  write('engines/biber-notices/NOTICE', 'fixture')
  write('receipts/LINK-INVENTORY.biber.json', {
    family: 'biber', combinedTerms: 'AGPL-3.0-only', modules: [{ name: 'biber' }],
    linked: [{ component: 'Biber fixture', license: 'AGPL-3.0-only', source: 'fixture/' }],
    requiredNotices: ['biber-notices/NOTICE'],
  })
  const sourceReceipt = { sha256: 'a'.repeat(64), dirty: false,
    biberSource: biberBuild.sourceArchive, correspondsTo: [binary, ...jsArtifacts, ...biberArtifacts] }
  write('receipts/SOURCE-RECEIPT.json', sourceReceipt)
  const biberStage = runStage('bundle-src')
  assert.equal(runBuildMirror(biberStage.digest, 'biber-mirror').status, 0)
  const bm = JSON.parse(fs.readFileSync(path.join(root, 'biber-mirror', biberStage.digest, 'release.json')))
  const br = bm
  assert.deepEqual(br.engines.biber.files, [...biberNames, 'biber.build.json'])
  assert.equal(br.files['biber.data'].sha256, biberArtifacts.find(a => a.name === 'biber.data').sha256)
  assert.equal(br.bibliography.biber.version, '2.22')
  assert.deepEqual(br.bibliography.biber.compatible, ['2.22'])
  assert.equal(runCheckMirror('biber-mirror').status, 0)

  // A BCF mismatch must fail mirror creation even when all payload hashes
  // are otherwise valid; it cannot silently advertise an incompatible tool.
  biberBuild.controlFile = '99.0'
  write('engines/biber.build.json', biberBuild)
  const changedBuild = fs.readFileSync(path.join(root, 'engines/biber.build.json'))
  sourceReceipt.correspondsTo.find(a => a.name === 'biber.build.json').sha256 = hash(changedBuild)
  write('receipts/SOURCE-RECEIPT.json', sourceReceipt)
  const badPair = runStage('bundle-src')
  const refusedPair = runBuildMirror(badPair.digest, 'bad-pair')
  assert.notEqual(refusedPair.status, 0)
  assert.match(refusedPair.stderr, /requires BCF/)

  fs.unlinkSync(path.join(root, 'engines/biber.data'))
  const incomplete = spawnSync(process.execPath, [stage, '--dist', 'engines', '--out', 'incomplete', '--source-url', 'https://example.org/source.tar.xz'], { cwd: root, encoding: 'utf8' })
  assert.equal(incomplete.status, 0, incomplete.stderr)
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(root, 'incomplete/MANIFEST.json'))).releaseGate, 'passed')
  console.log('Biber: complete artifacts, source receipt, notices, version pairing, and missing-data rejection checked')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
