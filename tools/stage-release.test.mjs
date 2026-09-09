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
  fs.writeFileSync(path.join(root, name), typeof content === 'string' ? content : JSON.stringify(content))
}
function run(source = true) {
  const args = [stage, '--dist', 'engines', '--out', 'staged']
  if (source) args.push('--source-url', 'https://example.org/source.tar.xz')
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(fs.readFileSync(path.join(root, 'staged/MANIFEST.json')))
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
  let manifest = run()
  assert.equal(manifest.releaseGate, 'passed')
  for (const name of ['LICENSES/GPL.txt', 'SOURCE.md', 'SOURCE-RECEIPT.json', binary.name]) {
    const spec = manifest.files.find((file) => file.name === name)
    assert.ok(spec, name)
    const bytes = fs.readFileSync(path.join(root, 'staged', name))
    assert.equal(spec.sha256, hash(bytes))
    assert.equal(spec.bytes, bytes.length)
  }
  assert.ok(!manifest.files.some(({ name }) => name === 'MANIFEST.json'))
  manifest = run(false)
  assert.equal(manifest.releaseGate, undefined, 'missing source cannot yield a consumable release')
  write('receipts/SOURCE-RECEIPT.json', { sha256: 'a'.repeat(64), dirty: true, correspondsTo: [binary] })
  manifest = run()
  assert.equal(manifest.releaseGate, undefined, 'a failed source gate cannot yield a consumable release')
  write('receipts/SOURCE-RECEIPT.json', { sha256: null, dirty: false, correspondsTo: [binary] })
  manifest = run()
  assert.equal(manifest.releaseGate, undefined, 'null source hash cannot yield a consumable release')
  fs.rmSync(path.join(root, 'receipts/SOURCE-RECEIPT.json'))
  manifest = run()
  assert.equal(manifest.releaseGate, undefined, 'missing source receipt cannot yield a consumable release')
  console.log('stage-release: complete payload hashes and release gate status checked')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
