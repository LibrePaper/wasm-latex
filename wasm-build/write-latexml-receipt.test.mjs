import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectKernelDumps } from './latexml-kernel-dumps.mjs'

const root = fs.mkdtempSync(path.join(tmpdir(), 'wasm-latex-kernel-dumps-'))
const dumps = path.join(root, 'resources', 'dumps')
const write = (name, value) => {
  fs.mkdirSync(path.dirname(path.join(dumps, name)), { recursive: true })
  fs.writeFileSync(path.join(dumps, name), value)
}
try {
  write('plain.2023.dump.txt', 'plain-2023\n')
  write('latex.2023.dump.txt', 'latex-2023\n')
  write('texlive.2023.version', 'kpathsea version 6.3.5\n')
  write('plain.2026.dump.txt', 'plain-2026\n')
  write('latex.2026.dump.txt', 'latex-2026\n')
  write('texlive.2026.version', 'kpathsea version 6.3.6\n')
  let result = collectKernelDumps(root)
  assert.deepEqual(result.map((dump) => dump.year), [2026, 2023])
  assert.equal(result[0].plain.name, 'resources/dumps/plain.2026.dump.txt')
  assert.equal(result[0].plain.bytes, Buffer.byteLength('plain-2026\n'))
  assert.match(result[0].plain.sha256, /^[a-f0-9]{64}$/)
  assert.equal(result[0].provenance.kind, 'host-texlive-version-stamp')
  assert.equal(result[0].provenance.version, 'kpathsea version 6.3.6')

  fs.rmSync(path.join(dumps, 'latex.2026.dump.txt'))
  result = collectKernelDumps(root)
  assert.deepEqual(result.map((dump) => dump.year), [2023])
  console.log('latexml-receipt: kernel dump filenames, hashes, provenance, and incomplete-year filtering checked')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
