#!/usr/bin/env node
// Remove tars the index no longer names. build-bundles.mjs never rewrites an
// existing tar, so after a rule change the directory holds both the new set and
// whatever the old rules produced; check-release refuses a tar the index does
// not name, and this is what makes the directory match the index again.
//
//   node tools/prune-bundles.mjs --dir wasm-build/dist/bundles
import fs from 'node:fs'
import path from 'node:path'

const i = process.argv.indexOf('--dir')
const dir = path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1] : 'wasm-build/dist/bundles')
const index = JSON.parse(fs.readFileSync(path.join(dir, 'bundles.json'), 'utf8'))
const keep = new Set(Object.values(index.bundles).map((b) => b.url))
let removed = 0
const b = path.join(dir, 'b')
for (const d of fs.readdirSync(b)) {
  const sub = path.join(b, d)
  for (const f of fs.readdirSync(sub)) {
    if (!keep.has(`b/${d}/${f}`)) { fs.rmSync(path.join(sub, f)); removed++ }
  }
  if (!fs.readdirSync(sub).length) fs.rmdirSync(sub)
}
console.error(`pruned ${removed} tar(s) not named by ${path.relative(process.cwd(), path.join(dir, 'bundles.json'))}`)
