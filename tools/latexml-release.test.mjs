import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(tmpdir(), 'wasm-latex-latexml-release-'))
const stage = fileURLToPath(new URL('./stage-release.mjs', import.meta.url))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const css = [
  'LaTeXML-blue.css', 'LaTeXML-marginpar.css', 'LaTeXML-navbar-left.css',
  'LaTeXML-navbar-right.css', 'LaTeXML.css', 'ltx-amsart.css', 'ltx-apj.css',
  'ltx-article.css', 'ltx-book.css', 'ltx-listings.css', 'ltx-report.css',
  'ltx-svjour.css', 'ltx-ulem.css',
]
const artifacts = [
  'latexml.worker.js', 'latexml.js', 'latexml.wasm', 'latexml.css', ...css,
  'kpse-resolve.js', 'bundle-mode.js', 'latexml.build.json',
]
function write(name, content) {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content))
}
function setup() {
  for (const name of artifacts.filter((name) => name !== 'latexml.build.json')) write(`engines/${name}`, `fixture:${name}`)
  const buildArtifacts = Object.fromEntries(artifacts.filter((name) => name !== 'latexml.build.json').map((name) => {
    const bytes = fs.readFileSync(path.join(root, 'engines', name))
    return [name, { bytes: bytes.length, sha256: hash(bytes) }]
  }))
  write('engines/latexml.build.json', {
    schemaVersion: 1,
    family: 'latexml',
    toolchain: {
      emscripten: '6.0.9',
      emscriptenImage: 'emscripten/emsdk:6.0.9@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc',
      rust: 'nightly-2026-08-02',
    },
    source: { repository: 'https://github.com/dginev/latexml-oxide.git', commit: '1ef264a2bb49dcc806fe22aae45fd771e02a52ae' },
    kernelDumps: [{
      year: 2026,
      plain: { name: 'resources/dumps/plain.2026.dump.txt', bytes: 11, sha256: 'a'.repeat(64) },
      latex: { name: 'resources/dumps/latex.2026.dump.txt', bytes: 11, sha256: 'b'.repeat(64) },
      texlive: { name: 'resources/dumps/texlive.2026.version', bytes: 18, sha256: 'c'.repeat(64) },
      provenance: {
        kind: 'host-texlive-version-stamp',
        source: 'latexml-oxide/resources/dumps',
        version: 'pdfTeX 3.141592653-2.6-1.40.27 (TeX Live 2026)',
      },
    }],
    dependencies: [
      { name: 'libxml2', version: '2.13.5', source: 'https://download.gnome.org/sources/libxml2/2.13/libxml2-2.13.5.tar.xz', license: 'MIT', notices: ['LICENSES/libxml2-Copyright.txt'] },
      { name: 'libxslt', version: '1.1.42', source: 'https://download.gnome.org/sources/libxslt/1.1/libxslt-1.1.42.tar.xz', license: 'MIT', notices: ['LICENSES/libxslt-COPYING.txt'] },
      { name: 'kpathsea', version: 'texlive-pinned', source: 'texlive-source/texk/kpathsea', license: 'LGPL-2.1-or-later', notices: ['LICENSES/LGPL-2.1.txt'] },
    ],
    artifacts: buildArtifacts,
  })
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'RELINK.md']) write(name, 'fixture')
  for (const name of ['README.md', 'CC0-1.0.txt', 'libxml2-Copyright.txt', 'libxslt-COPYING.txt', 'LGPL-2.1.txt']) write(`LICENSES/${name}`, 'fixture')
  write('linked-components.json', {})
  write('receipts/LINK-INVENTORY.latexml.json', {
    family: 'latexml', combinedTerms: 'CC0-1.0 AND MIT AND LGPL-2.1-or-later',
    modules: [{ name: 'latexml' }],
    linked: [{ component: 'fixture', license: 'MIT', source: 'fixture/', staticLinkObligation: 'lgpl-relink' }],
    requiredNotices: ['LICENSES/CC0-1.0.txt', 'LICENSES/libxml2-Copyright.txt', 'LICENSES/libxslt-COPYING.txt', 'LICENSES/LGPL-2.1.txt'],
  })
  const sourceArtifacts = artifacts.map((name) => {
    const bytes = fs.readFileSync(path.join(root, 'engines', name))
    return { name, bytes: bytes.length, sha256: hash(bytes) }
  })
  write('receipts/SOURCE-RECEIPT.json', { sha256: 'a'.repeat(64), dirty: false, correspondsTo: sourceArtifacts })
}
function run() {
  return spawnSync(process.execPath, [stage, '--dist', 'engines', '--out', 'staged', '--source-url', 'https://example.org/source.tar.xz'], {
    cwd: root, encoding: 'utf8',
  })
}
try {
  setup()
  let result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'staged/MANIFEST.json'))).releaseGate, 'passed')

  const receiptPath = path.join(root, 'engines/latexml.build.json')
  const validReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  const missingDumpsReceipt = { ...validReceipt, kernelDumps: [] }
  write('engines/latexml.build.json', missingDumpsReceipt)
  result = run()
  assert.equal(result.status, 0, 'staging remains inspectable when the dump gate rejects it')
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(root, 'staged/MANIFEST.json'))).releaseGate, 'passed')
  assert.match(result.stderr, /nonempty plain and LaTeX kernel dumps are required/)
  write('engines/latexml.build.json', validReceipt)

  fs.rmSync(path.join(root, 'engines/ltx-book.css'))
  result = run()
  assert.equal(result.status, 0, 'staging remains inspectable when the gate rejects it')
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(root, 'staged/MANIFEST.json'))).releaseGate, 'passed')
  assert.match(result.stderr, /incomplete LaTeXML family: missing ltx-book\.css/)
  console.log('latexml-release: complete payload and missing stylesheet are gated')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
