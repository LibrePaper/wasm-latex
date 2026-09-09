import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(tmpdir(), 'wasm-latex-stage-'))
const stage = fileURLToPath(new URL('./stage-release.mjs', import.meta.url))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function write(name, content) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  const data = Buffer.isBuffer(content) || typeof content === 'string' ? content : JSON.stringify(content)
  fs.writeFileSync(path.join(root, name), data)
}
function run(source = true, bundles = null) {
  const args = [stage, '--dist', 'engines', '--out', 'staged']
  if (source) args.push('--source-url', 'https://example.org/source.tar.xz')
  if (bundles) args.push('--bundles', bundles)
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  return { result, manifest: JSON.parse(fs.readFileSync(path.join(root, 'staged/MANIFEST.json'))) }
}
function runOk(source = true, bundles = null) {
  const { result, manifest } = run(source, bundles)
  assert.equal(result.status, 0, result.stderr)
  return manifest
}
const check = fileURLToPath(new URL('./check-release.mjs', import.meta.url))
function writeBundleFixture(dir, { snapshot = 'texlive-test', phantom = false } = {}) {
  const coreBytes = Buffer.from('core-tar-fixture-bytes')
  const tikzBytes = Buffer.from('tikz-tar-fixture-bytes')
  const coreSha = hash(coreBytes)
  const tikzSha = hash(tikzBytes)
  write(`${dir}/b/${coreSha}/core.tar`, coreBytes)
  write(`${dir}/b/${tikzSha}/tex-latex-tikz.tar`, tikzBytes)
  const bundles = {
    core: { url: `b/${coreSha}/core.tar`, size: coreBytes.length, sha256: coreSha, files: 2 },
    'tex/latex/tikz': { url: `b/${tikzSha}/tex-latex-tikz.tar`, size: tikzBytes.length, sha256: tikzSha, files: 1 },
  }
  // A bundle the index promises but that build-bundles never produced a file
  // for — the release gate must catch this, not the importer.
  if (phantom) {
    bundles['fonts/public/phantom'] = {
      url: 'b/' + 'f'.repeat(64) + '/fonts-public-phantom.tar', size: 100, sha256: 'f'.repeat(64), files: 1,
    }
  }
  const index = {
    schemaVersion: 1,
    snapshot,
    sourceDateEpoch: 1234567890,
    bundles,
    files: {
      'tex/latex/base/latex.ltx': 'core',
      'tex/latex/tikz/tikz.sty': 'tex/latex/tikz',
    },
  }
  const indexBytes = Buffer.from(JSON.stringify(index))
  write(`${dir}/bundles.json`, indexBytes)
  write(`${dir}/RECEIPT-FILES.json`, { files: { 'tex/latex/base/latex.ltx': coreSha } })
  write(`receipts/BUNDLE-RECEIPT.${snapshot}.json`, {
    procedure: 'node tools/build-bundles.mjs',
    texmf: ['fixture-texmf'],
    sourceDateEpoch: 1234567890,
    excluded: [],
    core: ['tex/latex/base'],
    index: { bytes: indexBytes.length, sha256: hash(indexBytes) },
    bundles: [
      { name: 'core', url: `b/${coreSha}/core.tar`, size: coreBytes.length, sha256: coreSha, files: 2 },
      { name: 'tex/latex/tikz', url: `b/${tikzSha}/tex-latex-tikz.tar`, size: tikzBytes.length, sha256: tikzSha, files: 1 },
    ],
    totals: { bundles: 2, files: 3, bytes: coreBytes.length + tikzBytes.length },
  })
  return { coreSha, tikzSha, index }
}
try {
  const binary = { name: 'wasmtex-pdftex.wasm', bytes: 6, sha256: hash('binary') }
  write('engines/' + binary.name, 'binary')
  write('engines/wasmtex-pdftex.fmt', 'format')
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/GPL.txt', 'RELINK.md']) write(name, 'fixture')
  write('linked-components.json', {})
  write('LICENSES/README.md', 'fixture')
  write('receipts/LINK-INVENTORY.pdftex.json', {
    family: 'pdftex', combinedTerms: 'GPL-2.0-only', modules: [{ name: 'wasmtex-pdftex' }],
    linked: [{ component: 'fixture', license: 'GPL-2.0-only', source: 'source/' }],
    requiredNotices: ['LICENSES/GPL.txt'],
  })
  write('receipts/FORMAT-RECEIPT.pdftex.json', { format: { sha256: hash('format') }, inputs: [{ name: 'latex.ltx' }] })
  write('receipts/SOURCE-RECEIPT.json', { sha256: 'a'.repeat(64), dirty: false, correspondsTo: [binary] })
  let manifest = runOk()
  assert.equal(manifest.releaseGate, 'passed')
  for (const name of ['LICENSES/GPL.txt', 'SOURCE.md', 'SOURCE-RECEIPT.json', binary.name]) {
    const spec = manifest.files.find((file) => file.name === name)
    assert.ok(spec, name)
    const bytes = fs.readFileSync(path.join(root, 'staged', name))
    assert.equal(spec.sha256, hash(bytes))
    assert.equal(spec.bytes, bytes.length)
  }
  assert.ok(!manifest.files.some(({ name }) => name === 'MANIFEST.json'))
  manifest = runOk(false)
  assert.equal(manifest.releaseGate, undefined, 'missing source cannot yield a consumable release')
  write('receipts/SOURCE-RECEIPT.json', { sha256: 'a'.repeat(64), dirty: true, correspondsTo: [binary] })
  manifest = runOk()
  assert.equal(manifest.releaseGate, undefined, 'a failed source gate cannot yield a consumable release')
  write('receipts/SOURCE-RECEIPT.json', { sha256: null, dirty: false, correspondsTo: [binary] })
  manifest = runOk()
  assert.equal(manifest.releaseGate, undefined, 'null source hash cannot yield a consumable release')
  fs.rmSync(path.join(root, 'receipts/SOURCE-RECEIPT.json'))
  manifest = runOk()
  assert.equal(manifest.releaseGate, undefined, 'missing source receipt cannot yield a consumable release')
  console.log('stage-release: complete payload hashes and release gate status checked')

  // Restore a valid source receipt for the bundle scenarios below.
  write('receipts/SOURCE-RECEIPT.json', { sha256: 'a'.repeat(64), dirty: false, correspondsTo: [binary] })

  // --bundles: a bundle directory produced by tools/build-bundles.mjs is
  // copied into staged/bundles/, its index and receipt are recorded on the
  // manifest, and the tars land in manifest.files like any other payload.
  const { coreSha, tikzSha } = writeBundleFixture('bundle-src')
  manifest = runOk(true, 'bundle-src')
  assert.equal(manifest.releaseGate, 'passed')
  assert.equal(manifest.bundles.count, 2)
  assert.equal(manifest.bundles.index, 'bundles/bundles.json')
  assert.equal(manifest.bundles.snapshot, 'texlive-test')
  assert.equal(manifest.bundles.receipt, 'BUNDLE-RECEIPT.texlive-test.json')
  for (const [tarPath, sha256] of [
    ['bundles/b/' + coreSha + '/core.tar', coreSha],
    ['bundles/b/' + tikzSha + '/tex-latex-tikz.tar', tikzSha],
  ]) {
    const spec = manifest.files.find((file) => file.name === tarPath)
    assert.ok(spec, tarPath)
    assert.equal(spec.sha256, sha256)
    const bytes = fs.readFileSync(path.join(root, 'staged', tarPath))
    assert.equal(spec.bytes, bytes.length)
  }

  // Corrupting a staged tar in place must fail check-release and name the bundle.
  const corePath = path.join(root, 'staged/bundles/b', coreSha, 'core.tar')
  const bytes = fs.readFileSync(corePath)
  bytes[0] = bytes[0] ^ 0xff
  fs.writeFileSync(corePath, bytes)
  const corrupted = spawnSync(process.execPath, [check, '--dir', path.join(root, 'staged')], { encoding: 'utf8' })
  assert.notEqual(corrupted.status, 0, 'a corrupted bundle tar must fail the release gate')
  assert.match(corrupted.stderr, /core/, 'the failure must name the corrupted bundle')

  // An index naming a bundle whose file was never produced must not pass.
  writeBundleFixture('bundle-src-missing', { phantom: true })
  manifest = runOk(true, 'bundle-src-missing')
  assert.notEqual(manifest.releaseGate, 'passed', 'a bundle index naming a missing file must not pass the gate')

  console.log('stage-release: bundle staging, verification, and corruption detection checked')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
