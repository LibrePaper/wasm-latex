#!/usr/bin/env node
// Verify that the pins the build depends on are present, well-formed, and agree
// with each other.
//
// Two pins decide what the engines are: the TeX Live source commit and the
// Emscripten image. Each is written down in more than one place — the ref file
// and the Dockerfile's build-arg contract, the Dockerfile's FROM and the
// manifest the source archive publishes — and a disagreement between any two
// means a receipt names inputs the build did not use.
//
//   node tools/check-pins.mjs

import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message); return ok }
const report = []

// --- TeX Live source ---------------------------------------------------------
const refFile = 'wasm-build/texlive-source-2026.ref'
const ref = read(refFile).trim()
check(/^[a-f0-9]{40}$/.test(ref), `${refFile}: not a 40-character commit`)
report.push(['TeX Live source', ref])

const dockerfile = read('wasm-build/Dockerfile')
check(
  /ARG TEXLIVE_REF\b/.test(dockerfile) && /test -n "\$\{TEXLIVE_REF\}"/.test(dockerfile),
  'wasm-build/Dockerfile: TEXLIVE_REF must be a required build-arg, not a default',
)
check(
  !/ARG TEXLIVE_REF=/.test(dockerfile),
  'wasm-build/Dockerfile: TEXLIVE_REF has a default, so a build can silently use the wrong tree',
)

// --- Emscripten --------------------------------------------------------------
const from = dockerfile.match(/^FROM (emscripten\/emsdk:[^\s@]+@sha256:[a-f0-9]{64})/m)
check(from, 'wasm-build/Dockerfile: FROM must pin emscripten/emsdk by sha256 digest')
if (from) report.push(['Emscripten image', from[1]])

const builder = 'tools/build-corresponding-source.mjs'
const declared = read(builder).match(/dockerImage: '(emscripten\/emsdk:[^']+)'/)
check(declared, `${builder}: does not declare the Emscripten image for the manifest`)
if (from && declared) {
  check(
    declared[1] === from[1],
    `${builder} names ${declared[1]}\n  but wasm-build/Dockerfile builds with ${from[1]}\n` +
    '  The published manifest would name an image the binaries were not built with.',
  )
}

// --- Result ------------------------------------------------------------------
if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f}`)
  process.exit(1)
}
for (const [what, value] of report) console.log(`${what.padEnd(17)}${value}`)
console.log('\npins agree')
