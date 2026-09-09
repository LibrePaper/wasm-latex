#!/usr/bin/env node
// Assemble a directory that can be published as-is.
//
// Obligations travel with artifacts, not with this repository. A .wasm served
// from a website is distribution, and the recipient must get the notices, the
// terms, and a way to the corresponding source — from where the binary is, not
// from a repository they have never heard of. This copies the engine files
// together with exactly the notices its link inventory says are required, the
// receipts describing what went in, and a SOURCE.md pointing at the archive.
//
//   node tools/stage-release.mjs --dist wasm-build/dist --out staged/ \
//     --source-url https://example.org/librepaper-wasm-latex-<rev>-source.tar.xz

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const distDir = path.resolve(arg('dist', 'wasm-build/dist'))
const outDir = path.resolve(arg('out', 'staged'))
const sourceUrl = arg('source-url', null)
const bundlesDir = arg('bundles', null) ? path.resolve(arg('bundles', null)) : null
const log = (...a) => console.error(...a)

// icudt68l.dat.gz is XeTeX's ICU data: not an engine, but the worker cannot find
// a font by name without it, and with bundles the endpoint no longer serves it
// by name, so the host inflates it and hands it over (loadicudata). Shipped
// gzipped because the raw file is 27 MiB and a static asset may not exceed 25.
const ARTIFACTS =
  /\.(wasm|fmt|fmt\.gz)$|^(pdftex|xetex|dvipdfm|bibtex|bibtex8|makeindex|luatex)(-checkpoint|-resolver-evidence)?(\.worker)?\.js$|^(kpse-resolve|bundle-mode)\.js$|^icudt[0-9]+[lb]\.dat\.gz$/
const files = fs.readdirSync(distDir).filter((f) => ARTIFACTS.test(f) && !f.endsWith('.map')).sort()
if (!files.length) { console.error(`no engine artifacts in ${distDir}`); process.exit(1) }

const inventories = fs.readdirSync('receipts').filter((f) => f.startsWith('LINK-INVENTORY.'))
if (!inventories.length) {
  console.error('no link inventories in receipts/ — run tools/link-inventory.mjs first.')
  console.error('Publishing without one means shipping components whose terms nobody checked.')
  process.exit(1)
}

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const staged = []
for (const f of files) {
  const data = fs.readFileSync(path.join(distDir, f))
  fs.writeFileSync(path.join(outDir, f), data)
  staged.push({ name: f, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
}

// Notices: the union of what every linked component requires, plus the terms
// covering the format's own inputs.
const required = new Set(['THIRD_PARTY_NOTICES.md', 'LICENSE'])
const families = []
for (const inv of inventories) {
  const j = JSON.parse(fs.readFileSync(path.join('receipts', inv), 'utf8'))
  families.push({ family: j.family, combinedTerms: j.combinedTerms, inventory: inv })
  for (const n of j.requiredNotices) required.add(n)
  fs.copyFileSync(path.join('receipts', inv), path.join(outDir, inv))
}
for (const f of fs.readdirSync('receipts').filter((f) => f.startsWith('FORMAT-RECEIPT.'))) {
  fs.copyFileSync(path.join('receipts', f), path.join(outDir, f))
  required.add('LICENSES/README.md')
}
if (fs.existsSync('receipts/SOURCE-RECEIPT.json')) {
  fs.copyFileSync('receipts/SOURCE-RECEIPT.json', path.join(outDir, 'SOURCE-RECEIPT.json'))
}

const missing = [...required].filter((n) => !fs.existsSync(n))
if (missing.length) { console.error(`missing required notice(s): ${missing.join(', ')}`); process.exit(1) }
for (const n of required) {
  const dest = path.join(outDir, n)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(n, dest)
}
// The notices reference the whole LICENSES set; ship it whole rather than
// leaving a reader with dangling links.
for (const f of fs.readdirSync('LICENSES')) {
  fs.copyFileSync(path.join('LICENSES', f), path.join(outDir, 'LICENSES', f))
}
fs.copyFileSync('RELINK.md', path.join(outDir, 'RELINK.md'))
fs.copyFileSync('linked-components.json', path.join(outDir, 'linked-components.json'))

// Bundles: package delivery for the browser tier (SPEC-latex.md, "Hosting").
// Copied verbatim into out/bundles/ so bundles.json's relative "b/<sha256>/..."
// URLs keep resolving after the copy, then recorded on the manifest so the
// importer can verify the index the same way it verifies engine artifacts.
let bundlesInfo = null
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else fs.copyFileSync(from, to)
  }
}
if (bundlesDir) {
  for (const required of ['bundles.json', 'RECEIPT-FILES.json.gz', 'b']) {
    if (!fs.existsSync(path.join(bundlesDir, required))) {
      console.error(`--bundles ${bundlesDir} has no ${required}; run tools/build-bundles.mjs first`)
      process.exit(1)
    }
  }
  const bundlesOut = path.join(outDir, 'bundles')
  fs.mkdirSync(bundlesOut, { recursive: true })
  fs.copyFileSync(path.join(bundlesDir, 'bundles.json'), path.join(bundlesOut, 'bundles.json'))
  fs.copyFileSync(path.join(bundlesDir, 'RECEIPT-FILES.json.gz'), path.join(bundlesOut, 'RECEIPT-FILES.json.gz'))
  copyTree(path.join(bundlesDir, 'b'), path.join(bundlesOut, 'b'))

  const bundlesIndexBytes = fs.readFileSync(path.join(bundlesOut, 'bundles.json'))
  const bundlesIndex = JSON.parse(bundlesIndexBytes)
  const bundleNames = Object.keys(bundlesIndex.bundles ?? {})
  const bytes = bundleNames.reduce((sum, name) => sum + (bundlesIndex.bundles[name].size ?? 0), 0)

  // The receipt lives beside the format receipts in receipts/, written by
  // build-bundles.mjs --evidence. The one the manifest names is the one whose
  // recorded index hash is the index being staged; any other is a different build.
  const indexSha = createHash('sha256').update(bundlesIndexBytes).digest('hex')
  const bundleReceipts = fs.readdirSync('receipts').filter((f) => f.startsWith('BUNDLE-RECEIPT.'))
  const receiptFile = bundleReceipts.find((f) => {
    try { return JSON.parse(fs.readFileSync(path.join('receipts', f), 'utf8')).index?.sha256 === indexSha } catch { return false }
  })
  if (!receiptFile) {
    console.error(`no receipts/BUNDLE-RECEIPT.*.json records the index in ${bundlesDir}; run tools/build-bundles.mjs --evidence`)
    process.exit(1)
  }
  fs.copyFileSync(path.join('receipts', receiptFile), path.join(outDir, receiptFile))

  bundlesInfo = {
    index: 'bundles/bundles.json',
    sha256: indexSha,
    snapshot: bundlesIndex.snapshot,
    count: bundleNames.length,
    bytes,
    receipt: receiptFile,
  }
}

const sourceReceipt = fs.existsSync('receipts/SOURCE-RECEIPT.json')
  ? JSON.parse(fs.readFileSync('receipts/SOURCE-RECEIPT.json', 'utf8'))
  : null

fs.writeFileSync(path.join(outDir, 'SOURCE.md'), `# Source for these engines

These files are compiled programs. Some of them are covered by the GNU General
Public License, version 2, which permits distribution only together with the
complete corresponding source.

${sourceUrl
  ? `The corresponding source is at:\n\n    ${sourceUrl}\n\n${sourceReceipt ? `SHA-256 of that archive:\n\n    ${sourceReceipt.sha256}\n` : ''}`
  : `**This release is not distributable yet: no source location has been set.**\nBuild the archive with \`tools/build-corresponding-source.mjs\`, publish it\nalongside these files, and re-stage with \`--source-url\`.\n`}
It contains this repository's build layer and the exact TeX Live source tree the
binaries were compiled from, with instructions to rebuild (\`REBUILD.md\`) and to
substitute a modified LGPL library and relink (\`RELINK.md\`, also beside this file).

## Terms

${families.map((f) => `- **${f.family}** — \`${f.combinedTerms}\`, per \`${f.inventory}\``).join('\n')}

Every statically linked component, its license and its source location are listed
in \`linked-components.json\` and the link inventories. Retained notices for all of
them are in \`LICENSES/\`, and \`THIRD_PARTY_NOTICES.md\` explains what applies where.

Format files (\`.fmt\`) are not engine code: they are compiled dumps of TeX Live
inputs and carry those inputs' terms. Every input is listed with its hash in the
\`FORMAT-RECEIPT.*.json\` beside this file.

Bundles under \`bundles/\` (\`bundles.json\` and the tar files it indexes) are TeX
Live package files, not engine code: macros, fonts, and metrics with their own
terms, LPPL and others, as TeX Live records for each package. Every member of
every bundle is listed with its hash in \`bundles/RECEIPT-FILES.json.gz\`.
`)

// Hash the entire payload, including notices and receipts.
function payload(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = prefix + entry.name
    const location = path.join(dir, entry.name)
    if (entry.isDirectory()) return payload(location, name + '/')
    const bytes = fs.readFileSync(location)
    return [{ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
  })
}

const manifest = {
  schemaVersion: 1,
  producedBy: 'tools/stage-release.mjs',
  stagedAt: null,
  families,
  artifacts: staged,
  files: payload(outDir),
  correspondingSource: sourceUrl ? { url: sourceUrl, sha256: sourceReceipt?.sha256 ?? null } : null,
  bundles: bundlesInfo,
}
fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')

// Incomplete staging remains inspectable, but cannot be consumed.
const gate = spawnSync(process.execPath, [fileURLToPath(new URL('./check-release.mjs', import.meta.url)), '--dir', outDir], { encoding: 'utf8' })
if (gate.error) throw gate.error
if (gate.status === 0) {
  manifest.releaseGate = 'passed'
  fs.writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
  log('manifest SHA-256: ' + createHash('sha256').update(fs.readFileSync(path.join(outDir, 'MANIFEST.json'))).digest('hex'))
} else {
  log(gate.stderr || 'release gate failed')
}

log(`staged   ${staged.length} artifact(s) to ${path.relative(process.cwd(), outDir)}`)
for (const f of families) log(`  ${f.family.padEnd(8)} ${f.combinedTerms}`)
log(`notices  LICENSES/ (${fs.readdirSync('LICENSES').length} files), THIRD_PARTY_NOTICES.md, LICENSE, RELINK.md`)
if (bundlesInfo) {
  log(`bundles  ${bundlesInfo.count} bundle(s), ${(bundlesInfo.bytes / 1e6).toFixed(1)} MB, snapshot ${bundlesInfo.snapshot}`)
}
if (!sourceUrl) {
  log('\nNo --source-url given: SOURCE.md says so, and tools/check-release.mjs will')
  log('refuse this directory. Publish the source archive first.')
}
