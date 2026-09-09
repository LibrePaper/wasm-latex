#!/usr/bin/env node
// What the linker actually put in each engine, and on what terms.
//
// The compliance question for a statically linked GPL binary is not "what does
// the build system mention" but "what is in the artifact". emcc writes a link
// map beside each module naming every archive and object it selected; this
// reads those maps, classifies each against licensing/linked-components.json,
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

const spec = JSON.parse(fs.readFileSync(path.join(root, 'licensing/linked-components.json'), 'utf8'))
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
  console.error('redistribution basis. Add it to licensing/linked-components.json:')
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
