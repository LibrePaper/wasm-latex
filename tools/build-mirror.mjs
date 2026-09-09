#!/usr/bin/env node
// Build the mirror LibrePaper serves, from a staged release this repository
// produced (`tools/stage-release.mjs`) and the reviewed digest of its
// MANIFEST.json.
//
// This is the repository-owned replacement for the release-import half of
// LibrePaper's `latex/tools/wasmtex.mjs` (`mirrorRelease`, `bundlesEntry`,
// `bibliographyIdentity`): LibrePaper used to build and hold the mirror
// itself; now this repository builds it and LibrePaper just points a URL at
// it (SPEC-latex.md, "Hosting"). The layout and manifest shape are unchanged
// from what that importer wrote, so LibrePaper's `configure()` worker code
// (`web/src/lib/latex/worker.js`) needs no change to read it -- with one
// addition, a top-level `"format": 1` on manifest.json, and one omission:
// this repository ships bundles only, so there is no legacy per-file
// `texlive` snapshot section and no bloom filter. `bibliographyIdentity`
// used to fetch `biblatex.sty` from the WasmTex CDN at import time; here it
// is read straight out of the bundle tar the release already staged, so
// building the mirror needs no network at all.
//
//   node tools/build-mirror.mjs --staged staged --sha256 <manifest digest> --out mirror
//
// Idempotent: re-running with the same staged input and the same --out
// changes nothing on disk. Older releases already in --out are kept --
// `manifest.releases` only grows, and `default_release` moves to the new one
// -- exactly as the importer it replaces did.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTar } from '../wasm-build/kpse-resolve.cjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/* ------------------------------------------------------------- ENGINE_FILE_SETS */
// Copied verbatim from LibrePaper's latex/tools/release.mjs. Every worker
// importScripts() both wasmtex-kpse-resolve.js (the resolver core) and
// wasmtex-bundle-mode.js (the loadbundleindex/preloadbundle handlers)
// unconditionally, so an engine missing either fails at importScripts before
// it can even answer `configure`. An engine whose complete file set is not
// in the staged release's artifacts is not advertised -- see readRelease
// below -- which is the mechanism that keeps luatex (unbuilt here, so never
// complete) out of `engines` without special-casing it.
export const ENGINE_FILE_SETS = {
  pdftex: {
    worker: 'wasmtex-pdftex.worker.js',
    format: 'wasmtex-pdftex.fmt',
    files: [
      'wasmtex-pdftex.worker.js',
      'wasmtex-pdftex.js',
      'wasmtex-pdftex.wasm',
      'wasmtex-pdftex-resolver-evidence.js',
      'wasmtex-kpse-resolve.js',
      'wasmtex-bundle-mode.js',
      'wasmtex-pdftex.fmt',
    ],
  },
  xetex: {
    worker: 'wasmtex-xetex.worker.js',
    format: 'wasmtex-xetex.fmt.gz',
    // XeTeX also needs its ICU data table decompressed and sent over
    // loadicudata before a bundled compile: without it, in bundle mode, the
    // worker would try to fetch icudt68l.dat by name from the endpoint and
    // fail, and font-by-name lookups would fail too.
    icu: 'icudt68l.dat.gz',
    files: [
      'wasmtex-xetex.worker.js',
      'wasmtex-xetex.js',
      'wasmtex-xetex.wasm',
      'wasmtex-xetex-resolver-evidence.js',
      'wasmtex-kpse-resolve.js',
      'wasmtex-bundle-mode.js',
      'wasmtex-xetex.fmt.gz',
      'icudt68l.dat.gz',
    ],
  },
  dvipdfm: {
    worker: 'wasmtex-dvipdfm.worker.js',
    files: [
      'wasmtex-dvipdfm.worker.js',
      'wasmtex-dvipdfm.js',
      'wasmtex-dvipdfm.wasm',
      'wasmtex-kpse-resolve.js',
      'wasmtex-bundle-mode.js',
    ],
  },
  luatex: {
    worker: 'wasmtex-luatex.worker.js',
    format: 'wasmtex-luatex.fmt.gz',
    files: [
      'wasmtex-luatex.worker.js',
      'wasmtex-luatex.js',
      'wasmtex-luatex.wasm',
      'wasmtex-luatex-resolver-evidence.js',
      'wasmtex-kpse-resolve.js',
      'wasmtex-bundle-mode.js',
      'wasmtex-luatex.fmt.gz',
    ],
  },
  bibtex: {
    worker: 'wasmtex-bibtex.worker.js',
    files: [
      'wasmtex-bibtex.worker.js',
      'wasmtex-bibtex.js',
      'wasmtex-bibtex.wasm',
      'wasmtex-kpse-resolve.js',
      'wasmtex-bundle-mode.js',
    ],
  },
  bibtex8: {
    worker: 'wasmtex-bibtex8.worker.js',
    files: [
      'wasmtex-bibtex8.worker.js',
      'wasmtex-bibtex8.js',
      'wasmtex-bibtex8.wasm',
      'wasmtex-kpse-resolve.js',
      'wasmtex-bundle-mode.js',
    ],
  },
  makeindex: {
    worker: 'wasmtex-makeindex.worker.js',
    files: [
      'wasmtex-makeindex.worker.js',
      'wasmtex-makeindex.js',
      'wasmtex-makeindex.wasm',
      'wasmtex-kpse-resolve.js',
      'wasmtex-bundle-mode.js',
    ],
  },
}

/* -------------------------------------------------------------- readRelease */
// Ported from LibrePaper's latex/tools/release.mjs readRelease: verify the
// staged MANIFEST.json against its reviewed digest, then verify every payload
// file against the manifest before returning any of it.
export function readRelease(directory, expectedDigest) {
  if (!directory || !/^[a-f0-9]{64}$/.test(expectedDigest || '')) {
    throw new Error('build-mirror: --staged needs a staged wasm-latex directory and --sha256 its reviewed MANIFEST.json digest')
  }
  const raw = fs.readFileSync(path.join(directory, 'MANIFEST.json'))
  if (sha256(raw) !== expectedDigest) throw new Error('build-mirror: staged release manifest digest mismatch')
  const manifest = JSON.parse(raw)
  if (manifest.schemaVersion !== 1 || manifest.releaseGate !== 'passed' ||
      !Array.isArray(manifest.files) || !manifest.files.length ||
      !Array.isArray(manifest.artifacts) || !Array.isArray(manifest.families)) {
    throw new Error('build-mirror: stage this release with tools/stage-release.mjs and resolve its release gate failures first')
  }
  if (!/^https:\/\//.test(manifest.correspondingSource?.url || '') ||
      !/^[a-f0-9]{64}$/.test(manifest.correspondingSource?.sha256 || '')) {
    throw new Error('build-mirror: release must name and hash its published corresponding source')
  }
  const files = new Map()
  for (const spec of manifest.files) {
    if (typeof spec.name !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(spec.name) ||
        spec.name.split('/').some((part) => !part || part === '.' || part === '..') || files.has(spec.name)) {
      throw new Error('build-mirror: invalid or duplicate release file path')
    }
    const bytes = fs.readFileSync(path.join(directory, spec.name))
    if (bytes.length !== spec.bytes || sha256(bytes) !== spec.sha256) {
      throw new Error(`build-mirror: release file size or digest mismatch: ${spec.name}`)
    }
    files.set(spec.name, bytes)
  }
  for (const artifact of manifest.artifacts || []) {
    const bytes = files.get(artifact.name)
    if (!bytes || bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`build-mirror: artifact is not in the verified payload: ${artifact.name}`)
    }
  }
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'SOURCE.md', 'SOURCE-RECEIPT.json', 'RELINK.md']) {
    if (!files.has(name)) throw new Error(`build-mirror: release is missing ${name}`)
  }
  const artifacts = new Set(manifest.artifacts.map((file) => file.name))
  const engines = {}
  for (const [name, spec] of Object.entries(ENGINE_FILE_SETS)) {
    if (spec.files.every((file) => artifacts.has(file))) engines[name] = { ...spec }
  }
  if (!engines.pdftex) throw new Error('build-mirror: release has no complete pdfTeX engine and format')
  files.set('MANIFEST.json', raw)
  return { manifest, files, digest: expectedDigest, engines }
}

/* ------------------------------------------------------------ canonicalDigest */
// sha256 of a JSON object's canonical form: keys sorted at every level, so
// the digest depends on content and not on insertion order or formatting.
// Same construction as LibrePaper's wasmtex.mjs, so a release entry's digest
// means the same thing on both sides.
function canonicalDigest(value) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon)
    if (v && typeof v === 'object') {
      const out = {}
      for (const key of Object.keys(v).sort()) out[key] = canon(v[key])
      return out
    }
    return v
  }
  return sha256(Buffer.from(JSON.stringify(canon(value))))
}

/* ----------------------------------------------------------------- manifest */

function readManifest(outDir) {
  const p = path.join(outDir, 'manifest.json')
  if (!fs.existsSync(p)) return { format: 1, version: 1, releases: {} }
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function writeManifest(outDir, manifest) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}

function sizeOf(files, names) {
  return names.reduce((sum, name) => sum + (files[name]?.size || 0), 0)
}

/* --------------------------------------------------------------- bundlesEntry */
// Ported from LibrePaper's wasmtex.mjs bundlesEntry: reshapes
// staged.bundles ({ index, sha256, snapshot, count, bytes, receipt }, already
// verified byte-for-byte by readRelease above since bundles/bundles.json is
// one of manifest.files) into what the mirror manifest keeps per release --
// the index's own mirror-relative URL, so worker.js can resolve it against
// `base` the same way it resolves every other release file.
export function bundlesEntry(staged, files) {
  if (staged.bundles == null) return null
  const { index, sha256: digest, snapshot, count, bytes } = staged.bundles
  const fileEntry = typeof index === 'string' ? files[index] : null
  if (!fileEntry) throw new Error('build-mirror: release names manifest.bundles.index but it is not in its files')
  if (fileEntry.sha256 !== digest) {
    throw new Error('build-mirror: manifest.bundles.sha256 does not match the hashed bundles.json payload')
  }
  if (typeof snapshot !== 'string' || !snapshot ||
      !Number.isInteger(count) || count < 0 ||
      !Number.isInteger(bytes) || bytes < 0) {
    throw new Error('build-mirror: release manifest.bundles has the wrong shape')
  }
  return { index: fileEntry.url, sha256: digest, snapshot, count, bytes }
}

/* ---------------------------------------------------------- bibliographyIdentity */
// Ported from LibrePaper's wasmtex.mjs bibliographyIdentity, changed to need
// no network: the WasmTex CDN fetch of biblatex.sty is replaced by reading
// tex/latex/biblatex/biblatex.sty straight out of the bundle tar the release
// already staged, found via bundles.json's own `files` map (readTar comes
// from wasm-build/kpse-resolve.cjs, the same reader the browser resolver
// uses).
//
// payload: the Map readRelease returned (manifest-relative name -> bytes).
export function bibliographyIdentity(payload) {
  const indexBytes = payload.get('bundles/bundles.json')
  if (!indexBytes) throw new Error('build-mirror: release has no bundles/bundles.json; cannot read bibliography identity')
  const index = JSON.parse(indexBytes.toString('utf8'))
  const target = 'tex/latex/biblatex/biblatex.sty'
  const bundleName = index.files?.[target]
  if (!bundleName) throw new Error(`build-mirror: bundle index has no entry for ${target}`)
  const bundle = index.bundles?.[bundleName]
  if (!bundle) throw new Error(`build-mirror: bundle index names unknown bundle "${bundleName}" for ${target}`)
  const tarBytes = payload.get(`bundles/${bundle.url}`)
  if (!tarBytes) throw new Error(`build-mirror: bundle tar not in the staged payload: bundles/${bundle.url}`)
  let styBytes = null
  readTar(tarBytes, (name, data) => {
    if (name === target) styBytes = data
  })
  if (!styBytes) throw new Error(`build-mirror: ${target} not found inside bundle "${bundleName}"'s tar`)
  const text = Buffer.from(styBytes).toString('utf8')
  const bcf = /\\def\\blx@bcfversion\{([^}]+)\}/.exec(text)?.[1] ?? null
  const version = /\\def\\abx@version\{([^}]+)\}/.exec(text)?.[1] ?? null
  const date = /\\def\\abx@date\{([^}]+)\}/.exec(text)?.[1] ?? null
  if (!bcf || !version) {
    throw new Error('build-mirror: could not read \\blx@bcfversion/\\abx@version out of the bundled biblatex.sty')
  }
  // biblatex's documented pairing is bcf-version to bcf-version, not
  // package-version to package-version -- see the same note in the ported
  // original: this is an inference from an unchanged control-file version,
  // not an independently re-verified CTAN pairing for this exact point
  // release.
  const compatible = bcf === '3.11' ? ['2.21'] : []
  const incompatible_hint =
    bcf === '3.11'
      ? `biblatex ${version} (bcf ${bcf}) is inferred compatible with Biber 2.21 (the documented pairing for` +
        ' bcf 3.11, biblatex 3.21) because the control-file version did not change; not independently' +
        ' re-verified against a CTAN changelog for this exact biblatex point release.'
      : `biblatex ${version} uses control file ${bcf}, not the 3.11 this pinning was checked against; ` +
        're-derive the Biber pairing before trusting it.'
  return { bibtex: '0.99e', biblatex: version, control_file: bcf, biber: { compatible, incompatible_hint }, biblatex_date: date }
}

/* --------------------------------------------------------------- buildMirror */

export function buildMirror({ stagedDir, expectedDigest, outDir }) {
  const { manifest: staged, files: payload, digest, engines } = readRelease(stagedDir, expectedDigest)
  const engineRelease = `librepaper-${digest}`
  // No texlive snapshot travels with a bundled release, so the release id is
  // just the engine release -- unlike LibrePaper's `<engineRelease>+<snapshot>`,
  // which named a per-file TeX Live pin this repository does not ship.
  const releaseId = engineRelease
  const releaseDir = `wasmtex/${engineRelease}`

  const files = {}
  for (const [name, bytes] of payload) {
    const url = `${releaseDir}/${name}`
    const dest = path.join(outDir, url)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (!fs.existsSync(dest) || sha256(fs.readFileSync(dest)) !== sha256(bytes)) fs.writeFileSync(dest, bytes)
    files[name] = { url, sha256: sha256(bytes), size: bytes.length }
  }

  const bibliography = bibliographyIdentity(payload)
  const bundles = bundlesEntry(staged, files)

  const entry = {
    id: releaseId,
    engine_release: engineRelease,
    base: `${releaseDir}/`,
    engines,
    files,
    bibliography,
    bundles,
    vm: null,
    source: {
      corresponding_source: staged.correspondingSource,
      manifest: files['MANIFEST.json'],
      build_receipts: [...payload.keys()].filter((name) => /^(BUILD|FORMAT|SOURCE)-RECEIPT/.test(name)),
      reproduced: false,
    },
    licences: {
      ...Object.fromEntries(staged.families.map(({ family, combinedTerms }) => [family, combinedTerms])),
      notices: `${releaseDir}/`,
    },
    sizes: {
      ...Object.fromEntries(Object.entries(engines).map(([name, spec]) => [name, sizeOf(files, spec.files)])),
    },
  }

  const manifest = readManifest(outDir)
  manifest.format = 1
  manifest.version = 1
  manifest.releases ||= {}
  const previous = manifest.releases[releaseId]
  if (previous?.vm) entry.vm = previous.vm
  entry.digest = canonicalDigest({ ...entry, digest: undefined })
  manifest.releases[releaseId] = entry
  manifest.default_release = releaseId
  writeManifest(outDir, manifest)
  return { releaseId, entry, manifest }
}

/* --------------------------------------------------------------------- run */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function main() {
  const stagedDir = path.resolve(arg('staged', 'staged'))
  const expectedDigest = arg('sha256', null)
  const outDir = path.resolve(arg('out', 'mirror'))
  const { releaseId, entry } = buildMirror({ stagedDir, expectedDigest, outDir })
  console.log(`build-mirror: release ${releaseId} written to ${path.relative(process.cwd(), outDir)}`)
  console.log(`build-mirror: engines ${Object.keys(entry.engines).join(', ')}`)
  if (entry.bundles) {
    console.log(`build-mirror: bundles ${entry.bundles.count}, ${(entry.bundles.bytes / 1e6).toFixed(1)} MB, snapshot ${entry.bundles.snapshot}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('build-mirror.mjs')) {
  main()
}
