#!/usr/bin/env node
// What the linker actually put in each engine, and on what terms.
//
// The compliance question for a statically linked GPL binary is not "what does
// the build system mention" but "what is in the artifact". emcc writes a link
// map beside each module naming every archive and object it selected; this
// reads those maps, classifies each against linked-components.json,
// and fails on anything unclassified. An unclassifiable component is a
// component whose redistribution basis nobody has established.
//
//   node tools/link-inventory.mjs --dist wasm-build/dist --family pdftex \
//     --out receipts/LINK-INVENTORY.pdftex.json

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const root = path.resolve(arg('root', '.'))
const distDir = path.resolve(arg('dist', 'wasm-build/dist'))
const family = arg('family', null)
const outPath = arg('out', null)
const quiet = process.argv.includes('--quiet')
const log = (...a) => { if (!quiet) console.error(...a) }

const spec = JSON.parse(fs.readFileSync(path.join(root, 'linked-components.json'), 'utf8'))
if (family === 'latexml') {
  const receiptPath = path.join(distDir, 'latexml.build.json')
  const mapPath = path.join(distDir, 'latexml.map')
  if (!fs.existsSync(receiptPath)) throw new Error(`missing LaTeXML build receipt: ${receiptPath}`)
  if (!fs.existsSync(mapPath)) throw new Error(`missing LaTeXML link map: ${mapPath}`)
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  const map = fs.readFileSync(mapPath, 'utf8')
  const digest = createHash('sha256').update(map).digest('hex')
  if (!receipt.linkMap?.sha256) throw new Error('LaTeXML build receipt has no link-map hash')
  if (receipt.linkMap.sha256 !== digest) throw new Error(`LaTeXML link map hash does not match receipt: ${digest}`)
  if (receipt.toolchain?.emscripten !== '6.0.9') throw new Error('LaTeXML receipt does not identify Emscripten 6.0.9')
  // lld's symbol table also contains names ending in `.a` (for example
  // `.rodata.sqlite3LogEst.a`). Only paths identify archive inputs. The
  // object paths are similarly restricted to paths so symbol names do not
  // inflate the inventory.
  const archives = [...new Set([...map.matchAll(/(?:^|[\s(])([^\s()]+(?:\.a|\.rlib))(?=[\s):]|$)/gm)].map((m) => m[1]).filter((item) => item.includes('/')))]
  const objects = [...new Set([...map.matchAll(/(?:^|[\s(])([^\s()]+\.o)(?=[\s):]|$)/gm)].map((m) => m[1]).filter((item) => item.includes('/')))]
  if (!archives.length && !objects.length) throw new Error('LaTeXML link map contains no archive or object inputs')
  const linked = new Map()
  const dependency = (name) => receipt.dependencies?.find((entry) => entry.name === name)
  const add = (key, item, data) => {
    if (!linked.has(key)) linked.set(key, { ...data, selectedAs: [] })
    const entry = linked.get(key)
    if (item.endsWith('.o')) {
      entry.objectCount = (entry.objectCount ?? 0) + 1
      // Keep representative map evidence without serializing tens of
      // thousands of LTO object paths into the release receipt.
      if (entry.selectedAs.length < 16) entry.selectedAs.push(item)
    } else {
      entry.selectedAs.push(item)
    }
  }
  const classify = (item) => {
    const lower = item.toLowerCase()
    if (lower.includes('libxml2') || lower.includes('/libxml-')) {
      const d = dependency('libxml2')
      return ['libxml2', { kind: 'archive', component: 'libxml2', version: d?.version ?? null, license: d?.license ?? 'MIT', staticLinkObligation: 'notice', source: d?.source ?? 'latexml.build.json', notices: d?.notices ?? ['LICENSES/libxml2-Copyright.txt'] }]
    }
    if (lower.includes('libxslt') || lower.includes('/libxslt-') || lower.includes('libexslt')) {
      const d = dependency('libxslt')
      return ['libxslt', { kind: 'archive', component: 'libxslt/libexslt', version: d?.version ?? null, license: d?.license ?? 'MIT', staticLinkObligation: 'notice', source: d?.source ?? 'latexml.build.json', notices: d?.notices ?? ['LICENSES/libxslt-COPYING.txt'] }]
    }
    if (lower.includes('kpathsea')) {
      const d = dependency('kpathsea')
      return ['kpathsea', { kind: 'archive', component: 'kpathsea', version: d?.version ?? null, license: d?.license ?? 'LGPL-2.1-or-later', staticLinkObligation: 'lgpl-relink', source: d?.source ?? 'texlive-source/texk/kpathsea', notices: d?.notices ?? ['LICENSES/LGPL-2.1.txt'], relink: 'RELINK.md' }]
    }
    if (lower.includes('libmarpa')) {
      const d = dependency('libmarpa-asf-sys')
      return ['libmarpa', { kind: 'archive', component: 'libmarpa 8.6.2 (via libmarpa-asf-sys)', version: d?.version ?? '8.6.2', license: d?.license ?? 'MIT AND LGPL-2.1-or-later AND LGPL-3.0-or-later', staticLinkObligation: 'lgpl-relink', source: d?.source ?? 'latexml-cargo/libmarpa-asf-sys', notices: d?.notices ?? ['LICENSES/libmarpa-COPYING.txt', 'LICENSES/libmarpa-COPYING.LESSER.txt'], relink: 'RELINK.md' }]
    }
    if (lower.includes('sqlite3')) return ['sqlite3', { kind: 'archive', component: 'SQLite3 via libsqlite3-sys', license: 'MIT AND Public domain', staticLinkObligation: 'notice', source: 'latexml-cargo/libsqlite3-sys', notices: ['LICENSES/libsqlite3-sys-MIT.txt', 'THIRD_PARTY_NOTICES.md'] }]
    if (lower.includes('mimalloc')) return ['mimalloc', { kind: 'archive', component: 'mimalloc', license: 'MIT', staticLinkObligation: 'notice', source: 'latexml-cargo/libmimalloc-sys', notices: ['LICENSES/mimalloc-MIT.txt', 'THIRD_PARTY_NOTICES.md'] }]
    if (lower.includes('/emsdk/') || lower.includes('sysroot/')) return ['emscripten', { kind: 'archive', component: 'Emscripten 6.0.9 runtime', license: 'MIT AND University of Illinois/NCSA', staticLinkObligation: 'notice', source: receipt.toolchain.emscriptenImage, notices: ['LICENSES/Emscripten-6.0.9.txt'] }]
    if (lower.includes('latexml-oxide')) return ['latexml-oxide', { kind: 'objects', component: 'latexml-oxide code and embedded resources', license: 'CC0-1.0/public domain', staticLinkObligation: 'notice', source: `${receipt.source?.repository}@${receipt.source?.commit}`, notices: ['LICENSES/CC0-1.0.txt', 'THIRD_PARTY_NOTICES.md'] }]
    if (lower.includes('cargo-target') || lower.includes('/target/') || lower.endsWith('.rlib')) return ['cargo', { kind: 'objects', component: 'Rust/Cargo dependency graph (see latexml.build.json)', license: 'Per-crate licenses recorded in latexml.build.json', staticLinkObligation: 'notice', source: receipt.cargo?.lockfile?.path ?? 'latexml.build.json', notices: ['THIRD_PARTY_NOTICES.md'] }]
    return null
  }
  for (const item of [...archives, ...objects]) {
    // lld often prints archive members as bare object basenames, without the
    // source path that appears for archives. Keep those members under the
    // conservative Cargo/object graph entry; an unknown archive still fails
    // because it identifies a separately linked component.
    const hit = classify(item) ?? (item.endsWith('.o') ? classify(`/build/cargo-target/${item}`) : null)
    if (!hit) throw new Error(`unclassified LaTeXML link-map input: ${item}`)
    add(hit[0], item, hit[1])
  }
  // Emscripten's final LTO map commonly names only the merged Rust object;
  // native archive members are then absent even though the build receipt
  // records the native closure. Add those declared inputs with explicit
  // receipt evidence rather than pretending the map listed their archives.
  const receiptInput = (item, evidence = 'build-receipt') => {
    const hit = classify(item)
    if (!hit || linked.has(hit[0])) return
    add(hit[0], evidence, { ...hit[1], evidence })
  }
  const cargoNames = new Set((receipt.cargo?.packages ?? []).map((entry) => typeof entry === 'string' ? entry : entry.name))
  const declaredInput = (name, item) => { if (dependency(name)) receiptInput(item) }
  declaredInput('libxml2', '/build/latexml/libxml2/libxml2.a')
  declaredInput('libxslt', '/build/latexml/libxslt/libxslt.a')
  declaredInput('kpathsea', '/build/latexml/texlive-source/texk/kpathsea/libkpathsea.a')
  declaredInput('libmarpa-asf-sys', '/build/latexml-cargo/libmarpa/libmarpa.a')
  if (receipt.source?.repository && receipt.source?.commit) receiptInput('/build/latexml-oxide/latexml')
  if (cargoNames.has('libsqlite3-sys')) receiptInput('/build/latexml-cargo/sqlite3/libsqlite3.a')
  if (cargoNames.has('libmimalloc-sys')) receiptInput('/build/latexml-cargo/mimalloc/libmimalloc.a')
  receiptInput('/build/emsdk/sysroot/lib/libc.a')
  if (receipt.cargo) receiptInput('/build/cargo-target/latexml-dependencies.rlib')
  const artifact = (name) => {
    const expected = receipt.artifacts?.[name]
    const file = path.join(distDir, name)
    if (!expected || !fs.existsSync(file)) throw new Error(`LaTeXML receipt/artifact missing: ${name}`)
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (actual !== expected.sha256) throw new Error(`LaTeXML artifact hash does not match receipt: ${name}`)
    return { bytes: fs.statSync(file).size, sha256: actual }
  }
  const artifacts = Object.fromEntries(['latexml.js', 'latexml.wasm', 'latexml.worker.js'].map((name) => [name, artifact(name)]))
  const inventory = {
    schemaVersion: 1, family: 'latexml',
    combinedTerms: spec.families.latexml?.combinedTerms ?? 'CC0-1.0 AND MIT AND LGPL-2.1-or-later AND LGPL-3.0-or-later',
    combinedTermsReason: spec.families.latexml?.combinedTermsReason ?? 'LaTeXML combines CC0 upstream code/resources with permissive native dependencies and statically linked LGPL kpathsea/libmarpa components; the Cargo graph is recorded conservatively in the build receipt.',
    modules: [{ name: 'latexml', wasm: artifacts['latexml.wasm'], archives: archives.length, objects: objects.length, artifacts }],
    linkMap: { name: 'latexml.map', bytes: fs.statSync(mapPath).size, sha256: digest }, cargo: receipt.cargo ?? null,
    linked: [...linked.values()].map((entry) => ({ ...entry, selectedAs: [...new Set(entry.selectedAs)].sort() })).sort((a, b) => a.component.localeCompare(b.component)),
    requiredNotices: [...new Set([...linked.values()].flatMap((entry) => entry.notices))].sort(),
  }
  const missing = inventory.requiredNotices.filter((notice) => !fs.existsSync(path.join(root, notice)))
  if (missing.length) throw new Error(`missing notice file(s) for LaTeXML: ${missing.join(', ')}`)
  if (outPath) { fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(inventory, null, 2) + '\n') }
  log(`family   latexml`); log(`linked   ${inventory.linked.length} components from latexml.map`); if (outPath) log(`written  ${outPath}`)
  process.exit(0)
}
if (family === 'biber') {
  const receipt = JSON.parse(fs.readFileSync(path.join(distDir, 'biber.build.json')))
  for (const [name, expected] of Object.entries({ ...receipt.artifacts, 'biber.map': receipt.linkMap })) {
    const bytes = fs.readFileSync(path.join(distDir, name))
    if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error(`Biber build receipt mismatch: ${name}`)
  }
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(receipt.inventory, null, 2) + '\n')
  log(`Biber: ${receipt.inventory.linked.length} source/runtime components, build and link-map hashes verified`)
  process.exit(0)
}
if (!family || !spec.families[family]) {
  console.error(`usage: node tools/link-inventory.mjs --family <${Object.keys(spec.families).join('|')}> [--dist dir] [--out file]`)
  process.exit(2)
}

const modules = spec.families[family].modules
const archives = new Map()   // matched spec entry -> [paths]
const groups = new Map()     // matched spec entry -> [object basenames]
const unclassified = []
const perModule = []

for (const name of modules) {
  const mapPath = path.join(distDir, `${name}.map`)
  if (!fs.existsSync(mapPath)) {
    console.error(`missing link map: ${mapPath}`)
    console.error('the map is written beside the module at link time; build the engine first')
    process.exit(1)
  }
  const map = fs.readFileSync(mapPath, 'utf8')

  const seenArchives = new Set()
  for (const m of map.matchAll(/(\/[^\s(]*\.a)\b/g)) seenArchives.add(m[1])
  const seenObjects = new Set()
  for (const m of map.matchAll(/([A-Za-z0-9_.+-]+\.o):/g)) {
    if (!m[1].includes('.a')) seenObjects.add(m[1])
  }

  for (const a of seenArchives) {
    const hit = spec.archives.find((e) => a.includes(e.match))
    if (!hit) { unclassified.push({ module: name, kind: 'archive', item: a }); continue }
    if (!archives.has(hit)) archives.set(hit, new Set())
    archives.get(hit).add(a)
  }
  for (const o of seenObjects) {
    const hit = spec.objectGroups.find((e) => new RegExp(e.match).test(o))
    if (!hit) { unclassified.push({ module: name, kind: 'object', item: o }); continue }
    if (!groups.has(hit)) groups.set(hit, new Set())
    groups.get(hit).add(o)
  }

  const wasm = path.join(distDir, `${name}.wasm`)
  perModule.push({
    name,
    wasm: fs.existsSync(wasm)
      ? { bytes: fs.statSync(wasm).size, sha256: createHash('sha256').update(fs.readFileSync(wasm)).digest('hex') }
      : null,
    archives: seenArchives.size,
    objects: seenObjects.size,
  })
}

// Notices the artifact must ship with, gathered from what was actually linked.
const notices = new Set()
for (const e of [...archives.keys(), ...groups.keys()]) for (const n of e.notices) notices.add(n)
const missingNotices = [...notices].filter((n) => !fs.existsSync(path.join(root, n)))

const inventory = {
  schemaVersion: 1,
  family,
  combinedTerms: spec.families[family].combinedTerms,
  combinedTermsReason: spec.families[family].combinedTermsReason,
  modules: perModule,
  linked: [
    ...[...archives.entries()].map(([e, paths]) => ({
      kind: 'archive', component: e.component, version: e.version ?? null,
      license: e.license, licenseChoice: e.licenseChoice ?? null,
      staticLinkObligation: e.staticLinkObligation, source: e.source,
      notices: e.notices, relink: e.relink ?? null,
      selectedAs: [...paths].sort(),
    })),
    ...[...groups.entries()].map(([e, objs]) => ({
      kind: 'objects', component: e.component, license: e.license,
      staticLinkObligation: e.staticLinkObligation, source: e.source,
      notices: e.notices, objectCount: objs.size,
      selectedAs: [...objs].sort(),
    })),
  ].sort((a, b) => a.component.localeCompare(b.component)),
  requiredNotices: [...notices].sort(),
}

log(`family   ${family}`)
log(`terms    ${inventory.combinedTerms}`)
log(`linked   ${inventory.linked.length} components across ${modules.length} module(s)`)
for (const c of inventory.linked) log(`  ${c.license.padEnd(32)} ${c.component}`)

if (unclassified.length) {
  console.error(`\n${unclassified.length} unclassified item(s) — every one is a component with no recorded`)
  console.error('redistribution basis. Add it to linked-components.json:')
  for (const u of unclassified) console.error(`  ${u.kind}: ${u.item} (in ${u.module})`)
  process.exit(1)
}
if (missingNotices.length) {
  console.error(`\nmissing notice file(s) for linked components: ${missingNotices.join(', ')}`)
  process.exit(1)
}

if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(inventory, null, 2) + '\n')
  log(`written  ${outPath}`)
}
