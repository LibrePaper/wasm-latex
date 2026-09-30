#!/usr/bin/env node
// Reject a mirror before it is deployed or before LibrePaper points at it.
//
// Scoped to what this repository ships: a bundled release only. There is no
// legacy per-file TeX Live snapshot and no bloom filter to check.
//
//   node tools/check-mirror.mjs mirror
//   node tools/check-mirror.mjs https://<configured-mirror-url>/ <release id>
//
// A directory argument is checked in full: it holds exactly the release
// directories it should (each named by the sha256 of the MANIFEST.json inside
// it) and `_headers`, nothing else; each release.json is format 2 and
// consistent with the files on disk, every engine file is present with a
// matching digest and size, bundles.json's own digest matches the release
// entry, and every bundle tar it names is on disk with a matching digest.
// Every path in release.json is relative to its release directory.
//
// An https URL is checked for shape, given the release id LibrePaper pins:
// `<url>/<id>/release.json` parses, is format 2 and names a pdfTeX engine.
// Nothing at a mirror URL is mutable, so there is no cache to bypass. It also
// downloads the single largest engine file and checks that what comes back
// over the wire still hashes to the digest release.json published, which is
// the one thing a deployed mirror can get wrong that a local one cannot:
// Object storage may return a gzip-encoded representation; `fetch` decodes
// Content-Encoding so this confirms the downloaded bytes match release.json.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const base = process.argv[2] || 'mirror'
const isUrl = /^https?:\/\//.test(base)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ID = /^[a-f0-9]{64}$/

function checkShape(release, id) {
  if (release.format !== 2) throw new Error(`unsupported release format: ${release.format}`)
  if (release.id !== id || release.engine_release !== id) throw new Error(`release.json names ${release.id}, not ${id}`)
  if (!release.engines?.pdftex?.worker) throw new Error(`release ${id} has no complete pdfTeX engine`)
  return release
}

/// Download the largest file the release advertises and prove the bytes that
/// arrive are the bytes release.json pins. `fetch` decodes `Content-Encoding`
/// for us, so a body that survives this hashed the same after decoding -- a
/// doubly-encoded response would not.
async function checkEncoding(base, release) {
  const candidates = Object.values(release.files || {})
  if (!candidates.length) throw new Error('release names no files')
  const biggest = candidates.reduce((a, b) => (b.size > a.size ? b : a))
  const url = `${base.replace(/\/$/, '')}/${release.id}/${biggest.url}`
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!response.ok) throw new Error(`${biggest.url} returned HTTP ${response.status}`)
  const encoding = response.headers.get('content-encoding') || 'identity'
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== biggest.size || sha256(bytes) !== biggest.sha256) {
    throw new Error(
      `${biggest.url} does not decode to what release.json published ` +
      `(${bytes.length} bytes, content-encoding ${encoding}, expected ${biggest.size}): ` +
      'the edge is serving a representation this mirror did not build')
  }
  console.log(`  wire:    ${biggest.url.split('/').pop()} ${(biggest.size / 1e6).toFixed(1)} MB, content-encoding ${encoding}, digest matches`)
}

function checkRelease(dir, id) {
  const releaseDir = path.join(dir, id)
  const manifestPath = path.join(releaseDir, 'MANIFEST.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`release ${id} has no MANIFEST.json`)
  if (sha256(fs.readFileSync(manifestPath)) !== id) throw new Error(`release directory ${id} is not the sha256 of its MANIFEST.json`)
  const releasePath = path.join(releaseDir, 'release.json')
  if (!fs.existsSync(releasePath)) throw new Error(`release ${id} has no release.json; build it with tools/build-mirror.mjs`)
  const release = checkShape(JSON.parse(fs.readFileSync(releasePath, 'utf8')), id)
  const inside = (rel) => {
    const resolved = path.resolve(releaseDir, rel)
    if (!resolved.startsWith(path.resolve(releaseDir) + path.sep)) throw new Error(`path escapes the release: ${rel}`)
    return resolved
  }

  // Every file release.json lists is present with matching digest and size.
  for (const [name, info] of Object.entries(release.files || {})) {
    if (info.url !== name) throw new Error(`file ${name}: url ${info.url} is not release-relative`)
    const filePath = inside(info.url)
    if (!fs.existsSync(filePath)) throw new Error(`file missing on disk: ${info.url}`)
    const bytes = fs.readFileSync(filePath)
    if (bytes.length !== info.size || sha256(bytes) !== info.sha256) {
      throw new Error(`digest or size mismatch: ${info.url}`)
    }
  }
  // ... and the release holds no file release.json does not list.
  const listed = new Set([...Object.keys(release.files || {}), 'release.json'])
  for (const entry of fs.readdirSync(releaseDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const rel = path.relative(releaseDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    if (!listed.has(rel)) throw new Error(`release ${id} holds a file release.json does not list: ${rel}`)
  }
  for (const [name, spec] of Object.entries(release.engines)) {
    for (const file of spec.files || []) {
      if (!release.files?.[file]) throw new Error(`engine ${name}: file ${file} is absent from release.json`)
    }
  }

  // Bundles: this repository ships bundles only, so a release with none is a
  // broken build, not a legacy release to tolerate.
  if (!release.bundles) throw new Error(`release ${id} has no bundles; this mirror ships bundled releases only`)
  if (release.bundles.index !== 'bundles/bundles.json') throw new Error(`bundles.index is ${release.bundles.index}, not bundles/bundles.json`)
  const indexPath = inside(release.bundles.index)
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
    const bundlePath = inside(bundleDir + bundle.url)
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
  return { release, bundleCount: bundleNames.length }
}

async function main() {
  if (isUrl) {
    const id = process.argv[3]
    if (!ID.test(id || '')) throw new Error('checking a URL needs the release id: check-mirror.mjs <url> <release id>')
    const response = await fetch(`${base.replace(/\/$/, '')}/${id}/release.json`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`${id}/release.json returned HTTP ${response.status}`)
    const release = checkShape(await response.json(), id)
    await checkEncoding(base, release)
    console.log(`mirror ready: ${base} (${id}, format ${release.format})`)
    return
  }

  const dir = path.resolve(base)
  if (!fs.existsSync(dir)) throw new Error(`no such directory: ${dir}`)
  const names = fs.readdirSync(dir)
  const ids = names.filter((name) => name !== '_headers')
  if (!names.includes('_headers')) throw new Error(`${dir} has no _headers; build it with tools/build-mirror.mjs`)
  if (!ids.length) throw new Error(`${dir} holds no release; build it with tools/build-mirror.mjs`)
  for (const id of ids) {
    if (!ID.test(id) || !fs.statSync(path.join(dir, id)).isDirectory()) {
      throw new Error(`${dir} holds ${id}, which is neither a release directory nor _headers`)
    }
  }
  for (const id of ids) {
    const { release, bundleCount } = checkRelease(dir, id)
    console.log(`mirror ready: ${dir} (${id}, format ${release.format})`)
    console.log(`  engines: ${Object.keys(release.engines).join(', ')}`)
    console.log(`  bundles: ${bundleCount}, ${(release.bundles.bytes / 1e6).toFixed(1)} MB, snapshot ${release.bundles.snapshot}`)
  }
}

main().catch((error) => {
  console.error(`mirror unavailable: ${error.message}`)
  process.exitCode = 1
})
