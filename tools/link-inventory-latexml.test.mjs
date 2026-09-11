import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(tmpdir(), 'wasm-latex-link-latexml-'))
const tool = fileURLToPath(new URL('./link-inventory.mjs', import.meta.url))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const write = (name, value) => {
  const target = path.join(root, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
}
try {
  const wasm = Buffer.from('latexml-wasm-fixture')
  const map = [
    '/build/latexml/libxml/prefix/lib/libxml2.a',
    '/build/latexml/libxml/prefix/lib/libxslt.a',
    '/build/latexml/libxml/prefix/lib/libexslt.a',
    '/build/latexml/texlive-source/texk/kpathsea/.libs/libkpathsea.a',
    '/build/cargo-target/libmarpa-8.6.2.a',
    '/build/cargo-target/libsqlite3.a',
    '/build/cargo-target/libmimalloc.a',
    '/emsdk/upstream/emscripten/cache/sysroot/lib/wasm32-emscripten/libc.a',
    '/build/cargo-target/liblatexml.rlib',
    '/build/cargo-target/object.o',
  ].join('\n') + '\n'
  write('engines/latexml.wasm', wasm)
  const js = Buffer.from('latexml-js-fixture')
  const worker = Buffer.from('latexml-worker-fixture')
  write('engines/latexml.js', js)
  write('engines/latexml.worker.js', worker)
  write('engines/latexml.map', map)
  write('engines/latexml.build.json', {
    schemaVersion: 1, family: 'latexml',
    toolchain: { emscripten: '6.0.9', emscriptenImage: 'emscripten/emsdk:6.0.9@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc', rust: 'nightly-2026-08-02' },
    source: { repository: 'https://github.com/dginev/latexml-oxide.git', commit: '1ef264a2bb49dcc806fe22aae45fd771e02a52ae' },
    dependencies: [
      { name: 'libxml2', version: '2.13.5', source: 'libxml2', license: 'MIT', notices: ['LICENSES/libxml2-Copyright.txt'] },
      { name: 'libxslt', version: '1.1.42', source: 'libxslt', license: 'MIT', notices: ['LICENSES/libxslt-COPYING.txt'] },
      { name: 'kpathsea', version: 'kpse', source: 'kpathsea', license: 'LGPL-2.1-or-later', notices: ['LICENSES/LGPL-2.1.txt'] },
      { name: 'libmarpa-asf-sys', version: '0.3.0', source: 'libmarpa', license: 'MIT AND LGPL-2.1-or-later AND LGPL-3.0-or-later', notices: ['LICENSES/libmarpa-COPYING.txt', 'LICENSES/libmarpa-COPYING.LESSER.txt'] },
    ],
    artifacts: {
      'latexml.js': { bytes: js.length, sha256: hash(js) },
      'latexml.wasm': { bytes: wasm.length, sha256: hash(wasm) },
      'latexml.worker.js': { bytes: worker.length, sha256: hash(worker) },
    },
    linkMap: { name: 'latexml.map', bytes: Buffer.byteLength(map), sha256: hash(map) },
    cargo: {
      lockfile: { path: 'repo/wasm-build/latexml-wasm/Cargo.lock', sha256: 'a'.repeat(64) },
      packages: [{ name: 'libsqlite3-sys' }, { name: 'libmimalloc-sys' }],
    },
  })
  write('linked-components.json', { schemaVersion: 1, families: { latexml: { modules: ['latexml'], combinedTerms: 'CC0-1.0 AND MIT AND LGPL-2.1-or-later AND LGPL-3.0-or-later', combinedTermsReason: 'fixture' } } })
  for (const name of ['LICENSES/libxml2-Copyright.txt', 'LICENSES/libxslt-COPYING.txt', 'LICENSES/LGPL-2.1.txt', 'LICENSES/libmarpa-COPYING.txt', 'LICENSES/libmarpa-COPYING.LESSER.txt', 'LICENSES/libsqlite3-sys-MIT.txt', 'LICENSES/mimalloc-MIT.txt', 'LICENSES/Emscripten-6.0.9.txt', 'LICENSES/CC0-1.0.txt', 'THIRD_PARTY_NOTICES.md']) write(name, 'fixture')
  const out = path.join(root, 'receipts/LINK-INVENTORY.latexml.json')
  let result = spawnSync(process.execPath, [tool, '--root', root, '--dist', path.join(root, 'engines'), '--family', 'latexml', '--out', out], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const inventory = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(inventory.family, 'latexml')
  assert.ok(inventory.linked.some((entry) => entry.component === 'libxml2'))
  assert.ok(inventory.linked.some((entry) => entry.component.includes('libmarpa')))
  // A release link map may contain only the merged Rust LTO object. The
  // receipt still supplies the native closure, with that provenance visible.
  const ltoMap = '/build/latexml-sdk6/cargo-target/latexml_wasm.rcgu.o\n'
  fs.writeFileSync(path.join(root, 'engines/latexml.map'), ltoMap)
  const ltoReceipt = JSON.parse(fs.readFileSync(path.join(root, 'engines/latexml.build.json'), 'utf8'))
  ltoReceipt.linkMap = { name: 'latexml.map', bytes: Buffer.byteLength(ltoMap), sha256: hash(ltoMap) }
  write('engines/latexml.build.json', ltoReceipt)
  result = spawnSync(process.execPath, [tool, '--root', root, '--dist', path.join(root, 'engines'), '--family', 'latexml', '--out', out], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const ltoInventory = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(ltoInventory.modules[0].archives, 0)
  assert.ok(ltoInventory.linked.some((entry) => entry.component.startsWith('SQLite3') && entry.evidence === 'build-receipt'))
  assert.ok(ltoInventory.linked.some((entry) => entry.component === 'mimalloc' && entry.evidence === 'build-receipt'))
  const badMap = `${map}/unclassified/libfoo.a\n`
  fs.writeFileSync(path.join(root, 'engines/latexml.map'), badMap)
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'engines/latexml.build.json'), 'utf8'))
  receipt.linkMap = { name: 'latexml.map', bytes: Buffer.byteLength(badMap), sha256: hash(badMap) }
  write('engines/latexml.build.json', receipt)
  result = spawnSync(process.execPath, [tool, '--root', root, '--dist', path.join(root, 'engines'), '--family', 'latexml'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unclassified LaTeXML link-map input/)
  console.log('link-inventory: LaTeXML map classification and unknown-input rejection checked')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
