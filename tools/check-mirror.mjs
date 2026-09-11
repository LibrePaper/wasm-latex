#!/usr/bin/env node
// Reject a mirror before it is deployed or before LibrePaper points at it.
//
// Ported from LibrePaper's latex/tools/check-mirror.mjs, scoped to what this
// repository ships: a bundled release only. There is no legacy per-file TeX
// Live snapshot and no bloom filter to check.
//
//   node tools/check-mirror.mjs mirror
//   node tools/check-mirror.mjs https://librepaper-latex.<account>.workers.dev/
//
// A directory argument is checked in full: the manifest parses, the default
// release has a complete pdfTeX engine, every engine file is on disk with a
// matching digest and size, bundles.json's own digest matches the release
// entry, and every bundle tar it names is on disk with a matching digest.
// An https URL is checked for shape -- manifest.json parses, format is
// supported, a default release with pdfTeX is named -- fetched with
// `no-store` so a stale edge cache cannot pass a check that would fail on
// what a browser actually gets; verifying every asset over the network on
// every check is what the browser smoke test is for, not this. It also
// downloads the single largest engine file and checks that what comes back
// over the wire still hashes to the digest the manifest published, which is
// the one thing a deployed mirror can get wrong that a local one cannot:
// tools/mirror-worker.js hands the edge a pre-encoded body, and an edge that
// re-encoded it instead of passing it through would serve every browser a
// WASM module wrapped in a second layer of compression.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { verify as verifyBrotli } from './mirror-brotli.mjs'

const base = process.argv[2] || 'mirror'
const isUrl = /^https?:\/\//.test(base)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function checkShape(manifest) {
  if (manifest.format !== 1) throw new Error(`unsupported manifest format: ${manifest.format}`)
  const release = manifest.releases?.[manifest.default_release]
  if (!release?.engines?.pdftex?.worker) throw new Error('no default release with a complete pdfTeX engine')
  return release
}

/// Download the largest file the default release advertises and prove the
/// bytes that arrive are the bytes the manifest pins. `fetch` decodes
/// `Content-Encoding` for us, so a body that survives this hashed the same
/// after decoding -- a doubly-encoded response would not.
async function checkEncoding(base, release) {
  const candidates = Object.values(release.files || {})
  if (!candidates.length) throw new Error('release names no files')
  const biggest = candidates.reduce((a, b) => (b.size > a.size ? b : a))
  const url = `${base.replace(/\/$/, '')}/${biggest.url}`
  const response = await fetch(url, { signal: AbortSignal.timeout(300000), cache: 'no-store' })
  if (!response.ok) throw new Error(`${biggest.url} returned HTTP ${response.status}`)
  const encoding = response.headers.get('content-encoding') || 'identity'
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== biggest.size || sha256(bytes) !== biggest.sha256) {
    throw new Error(
      `${biggest.url} does not decode to what the manifest published ` +
      `(${bytes.length} bytes, content-encoding ${encoding}, expected ${biggest.size}): ` +
      'the edge is serving a representation this mirror did not build')
  }
  console.log(`  wire:    ${biggest.url.split('/').pop()} ${(biggest.size / 1e6).toFixed(1)} MB, content-encoding ${encoding}, digest matches`)
}

async function main() {
  let manifest
  if (isUrl) {
    const response = await fetch(`${base.replace(/\/$/, '')}/manifest.json`, {
      signal: AbortSignal.timeout(30000),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`manifest.json returned HTTP ${response.status}`)
    manifest = await response.json()
    const release = checkShape(manifest)
    await checkEncoding(base, release)
    console.log(`mirror ready: ${base} (${manifest.default_release}, format ${manifest.format})`)
    return
  }

  const dir = path.resolve(base)
  if (!fs.existsSync(dir)) throw new Error(`no such directory: ${dir}`)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`${dir} has no manifest.json; build it with tools/build-mirror.mjs`)
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const release = checkShape(manifest)

  // Every engine file present on disk with matching digest and size.
  for (const [name, spec] of Object.entries(release.engines)) {
    for (const file of spec.files || []) {
      const info = release.files?.[file]
      if (!info) throw new Error(`engine ${name}: file ${file} is absent from the manifest`)
      const filePath = path.join(dir, info.url)
      if (!fs.existsSync(filePath)) throw new Error(`engine ${name}: file missing on disk: ${info.url}`)
      const bytes = fs.readFileSync(filePath)
      if (bytes.length !== info.size || sha256(bytes) !== info.sha256) {
        throw new Error(`engine ${name}: digest or size mismatch: ${info.url}`)
      }
    }
  }

  // Bundles: this repository ships bundles only, so a release with none is a
  // broken build, not a legacy release to tolerate.
  if (!release.bundles) throw new Error(`release ${release.id} has no bundles; this mirror ships bundled releases only`)
  const indexPath = path.join(dir, release.bundles.index)
  if (!fs.existsSync(indexPath)) throw new Error(`bundle index missing: ${release.bundles.index}`)
  const indexBytes = fs.readFileSync(indexPath)
  if (sha256(indexBytes) !== release.bundles.sha256) throw new Error(`bundle index digest mismatch: ${release.bundles.index}`)
  const index = JSON.parse(indexBytes.toString('utf8'))
  const bundleDir = release.bundles.index.slice(0, release.bundles.index.lastIndexOf('/') + 1)
  const bundleNames = Object.keys(index.bundles || {})
  if (bundleNames.length !== release.bundles.count) {
    throw new Error(`release.bundles.count is ${release.bundles.count} but the index names ${bundleNames.length}`)
  }
  for (const [name, bundle] of Object.entries(index.bundles || {})) {
    const bundlePath = path.resolve(dir, bundleDir + bundle.url)
    if (!bundlePath.startsWith(path.resolve(dir) + path.sep)) throw new Error(`bundle path escapes the mirror: ${bundle.url}`)
    let bytes
    try {
      bytes = fs.readFileSync(bundlePath)
    } catch {
      throw new Error(`bundle "${name}" missing on disk: ${bundle.url}`)
    }
    if (bytes.length !== bundle.size || sha256(bytes) !== bundle.sha256) {
      throw new Error(`bundle "${name}" digest or size mismatch: ${bundle.url}`)
    }
  }
  for (const bundleName of new Set(Object.values(index.files || {}))) {
    if (!index.bundles?.[bundleName]) throw new Error(`bundles.json names unknown bundle "${bundleName}" in its files map`)
  }

  // Brotli sidecars: a `.br` is served in place of the file it sits beside
  // (tools/mirror-worker.js), so one that does not decompress back to those
  // exact bytes would hand a browser something the manifest never published.
  // It is the only content in the mirror no digest in the manifest covers,
  // which is exactly why it is checked here instead.
  const brotli = verifyBrotli(dir)
  if (brotli.problems.length) {
    throw new Error(`brotli sidecar: ${brotli.problems[0]}${brotli.problems.length > 1 ? ` (+${brotli.problems.length - 1} more)` : ''}`)
  }

  console.log(`mirror ready: ${dir} (${manifest.default_release}, format ${manifest.format})`)
  console.log(`  engines: ${Object.keys(release.engines).join(', ')}`)
  console.log(`  bundles: ${bundleNames.length}, ${(release.bundles.bytes / 1e6).toFixed(1)} MB, snapshot ${release.bundles.snapshot}`)
  console.log(`  brotli:  ${brotli.checked} sidecars verified`)
}

main().catch((error) => {
  console.error(`mirror unavailable: ${error.message}`)
  process.exitCode = 1
})
