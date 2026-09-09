#!/usr/bin/env node
// The gate: may this directory be published?
//
// Upstream had a 27 KB compliance checker that needed its application tree and
// could not run here, which is why it was removed. This is the replacement, at
// the scale of what this repository actually produces. It answers one question
// — is every obligation on these bytes discharged — and it answers it about the
// staged directory, not about the repository, because the staged directory is
// what a recipient gets.
//
//   node tools/check-release.mjs --dir staged/
//
// Exit 0 means: every artifact is accounted for, every linked component has a
// recorded basis and its notice is present, the corresponding source is named
// and hashed, and the formats declare their inputs.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const dir = path.resolve(arg('dir', 'staged'))
const failures = []
const notes = []
const fail = (m) => failures.push(m)
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
const has = (f) => fs.existsSync(path.join(dir, f))
const sha = (f) => createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')

if (!fs.existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(2) }
if (!has('MANIFEST.json')) { console.error(`${dir} has no MANIFEST.json; stage it with tools/stage-release.mjs`); process.exit(2) }
const manifest = read('MANIFEST.json')

// 1. Every artifact present and unmodified since staging.
for (const a of manifest.artifacts) {
  if (!has(a.name)) { fail(`artifact named in the manifest is missing: ${a.name}`); continue }
  if (sha(a.name) !== a.sha256) fail(`artifact changed after staging: ${a.name}`)
}
// ...and nothing shipped that the manifest does not name.
const named = new Set(manifest.artifacts.map((a) => a.name))
for (const f of fs.readdirSync(dir)) {
  if (/\.(wasm|fmt|fmt\.gz)$/.test(f) && !named.has(f)) fail(`unnamed artifact in the directory: ${f}`)
}

// 2. Every linked component classified, with its notice present.
const inventories = fs.readdirSync(dir).filter((f) => f.startsWith('LINK-INVENTORY.'))
if (!inventories.length) fail('no link inventory: nothing records what is inside these binaries')
const familiesSeen = new Set()
for (const inv of inventories) {
  const j = read(inv)
  familiesSeen.add(j.family)
  if (!j.combinedTerms) fail(`${inv}: no combined terms recorded`)
  for (const c of j.linked) {
    if (!c.license) fail(`${inv}: ${c.component} has no license recorded`)
    if (!c.source) fail(`${inv}: ${c.component} has no source location recorded`)
    if (c.staticLinkObligation === 'lgpl-relink' && !has('RELINK.md')) {
      fail(`${inv}: ${c.component} is LGPL and statically linked, but no RELINK.md is shipped`)
    }
  }
  for (const n of j.requiredNotices) {
    if (!has(n)) fail(`${inv}: required notice not shipped: ${n}`)
  }
}
for (const f of manifest.families ?? []) {
  if (!familiesSeen.has(f.family)) fail(`manifest names family ${f.family} with no link inventory`)
}

// 3. A wasm with no inventory covering it is a binary nobody has classified.
const wasms = manifest.artifacts.filter((a) => a.name.endsWith('.wasm'))
const covered = new Set()
for (const inv of inventories) for (const m of read(inv).modules) covered.add(`${m.name}.wasm`)
for (const w of wasms) if (!covered.has(w.name)) fail(`no link inventory covers ${w.name}`)

// 4. Corresponding source: named, hashed, and the hash matches its receipt.
if (!has('SOURCE.md')) fail('no SOURCE.md: recipients are not told where the source is')
if (!/^https:\/\//.test(manifest.correspondingSource?.url || '') ||
    !/^[a-f0-9]{64}$/.test(manifest.correspondingSource?.sha256 || '')) {
  fail('no valid HTTPS corresponding-source URL and SHA-256. A GPL binary may not be distributed without the source;' +
       ' build it with tools/build-corresponding-source.mjs, publish it, and re-stage with --source-url')
} else if (has('SOURCE-RECEIPT.json')) {
  const receipt = read('SOURCE-RECEIPT.json')
  if (receipt.sha256 !== manifest.correspondingSource.sha256) {
    fail('the source hash in MANIFEST.json does not match SOURCE-RECEIPT.json')
  }
  if (receipt.dirty) {
    const paths = (receipt.uncommittedBuildPaths ?? []).join(', ')
    fail('the corresponding source was built with uncommitted changes under a path that feeds ' +
         `the build (${paths}), so it is not the source these binaries came from; commit and rebuild it`)
  }
  const binaries = new Set(receipt.correspondsTo?.map((a) => `${a.name}:${a.sha256}`) ?? [])
  for (const a of manifest.artifacts) {
    if (!/\.fmt(?:\.gz)?$/.test(a.name) && !binaries.has(`${a.name}:${a.sha256}`)) {
      fail(`${a.name} is not the artifact the corresponding source was built for`)
    }
  }
} else {
  fail('a source URL is named but SOURCE-RECEIPT.json is not shipped, so its hash cannot be checked')
}

// 5. Formats declare their inputs.
for (const a of manifest.artifacts.filter((a) => /\.fmt(?:\.gz)?$/.test(a.name))) {
  const receipts = fs.readdirSync(dir).filter((f) => f.startsWith('FORMAT-RECEIPT.'))
  const match = receipts.map((f) => read(f)).find((r) => r.format?.sha256 === a.sha256)
  if (!match) fail(`${a.name}: no FORMAT-RECEIPT names this file; its inputs' licenses are undocumented`)
  else if (!match.inputs?.length) fail(`${a.name}: its receipt records no inputs`)
  else notes.push(`${a.name} declares ${match.inputs.length} inputs`)
}

// 6. Notices a reader can actually follow.
if (!has('THIRD_PARTY_NOTICES.md')) fail('THIRD_PARTY_NOTICES.md is not shipped')
else {
  const text = fs.readFileSync(path.join(dir, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  for (const m of text.matchAll(/\]\((LICENSES\/[A-Za-z0-9._-]+)\)/g)) {
    if (!has(m[1])) fail(`THIRD_PARTY_NOTICES.md links a notice that is not shipped: ${m[1]}`)
  }
}

for (const n of notes) console.error(`  ${n}`)
if (failures.length) {
  console.error(`\n${failures.length} blocker(s) — this directory must not be published:\n`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.error(`\n${path.relative(process.cwd(), dir)}: every obligation this repository can check is discharged.`)
console.error('Checked: artifact integrity, component classification, notices, LGPL relink,')
console.error('corresponding source, and format inputs.')
