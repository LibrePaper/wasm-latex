#!/usr/bin/env node
// Precompressed brotli representations for the mirror's engine payload.
//
// Cloudflare already compresses these responses on the fly, but at the low
// brotli quality it can afford per request: measured against the deployed
// mirror, latexml.wasm is 21.7 MB identity, 6.11 MB gzip, 5.81 MB with the
// edge's own brotli, and 4.21 MB at brotli quality 11. Compressing once at
// release time and serving the result is worth 1.6 MB on the single largest
// file a browser has to fetch before it can run LaTeXML.
//
// The sidecar sits beside its file as `<name>.br` and is NOT named in
// MANIFEST.json or in the mirror manifest: it is a transport representation
// of a file the manifest already pins, not a payload file of its own. That
// is also what makes it safe -- `verify()` below re-derives the original
// bytes from the sidecar, so a sidecar can never disagree with the digest
// the manifest published without failing `make mirror`.
//
// tools/mirror-worker.js is what actually serves these; see the note there
// about why the Worker cannot do the content negotiation itself.

import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

// Quality 11 with a 16 MB window. ~30 s for the 21.7 MB latexml.wasm, paid
// once per release (re-runs skip any sidecar that already round-trips), in
// exchange for ~27% off every cold engine load for the life of that release.
const QUALITY = 11
const WINDOW = 24

/// Already-compressed containers: the bundle tars (11k of them, 7 GB) are
/// left to the edge, and re-compressing a .gz or a .br only makes it bigger.
const SKIP_EXTENSIONS = new Set(['.br', '.gz', '.tar', '.tgz', '.zip', '.woff', '.woff2', '.png', '.jpg'])

// Below this a sidecar costs a round trip's worth of nothing; the edge's own
// compression is entirely adequate for a 2 KB stylesheet.
const MIN_BYTES = 4096

// A sidecar must earn its place: if brotli cannot beat 90% of the original
// the file is effectively incompressible and the edge can have it.
const MAX_RATIO = 0.9

/// Whether `name` (a mirror-relative path) should get a `.br` sidecar.
export function compressible(name, size) {
  if (size < MIN_BYTES) return false
  if (SKIP_EXTENSIONS.has(path.extname(name).toLowerCase())) return false
  return true
}

export function compress(bytes) {
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: WINDOW,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  })
}

/// Write `<dest>.br` beside `dest` when it is worth writing, and return the
/// sidecar's size (or 0 when none was written). Idempotent: an existing
/// sidecar that decompresses back to `bytes` is left exactly as it is, so a
/// re-run neither rewrites nor re-times the expensive compression.
export function writeSidecar(dest, bytes) {
  const sidecar = `${dest}.br`
  if (!compressible(dest, bytes.length)) {
    // A file that stopped qualifying (it shrank, or its extension moved into
    // SKIP_EXTENSIONS) must not keep a stale sidecar around to be served.
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar)
    return 0
  }
  if (fs.existsSync(sidecar)) {
    try {
      if (brotliDecompressSync(fs.readFileSync(sidecar)).equals(bytes)) return fs.statSync(sidecar).size
    } catch {
      // Unreadable or truncated: fall through and write it again.
    }
  }
  const encoded = compress(bytes)
  if (encoded.length > bytes.length * MAX_RATIO) {
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar)
    return 0
  }
  fs.writeFileSync(sidecar, encoded)
  return encoded.length
}

/// Check every `.br` under `dir` against the file it claims to represent.
/// Called by tools/check-mirror.mjs: a sidecar that does not decompress to
/// the exact published bytes would serve a browser something other than what
/// the manifest's digest promises, which is the one failure mode worth
/// gating a deploy on.
export function verify(dir) {
  const problems = []
  let checked = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.br')) {
        const plain = full.slice(0, -3)
        const relative = path.relative(dir, full)
        if (!fs.existsSync(plain)) {
          problems.push(`${relative} has no file to represent`)
          continue
        }
        let decoded
        try {
          decoded = brotliDecompressSync(fs.readFileSync(full))
        } catch (error) {
          problems.push(`${relative} is not readable brotli: ${error.message}`)
          continue
        }
        if (!decoded.equals(fs.readFileSync(plain))) {
          problems.push(`${relative} does not decompress to ${path.relative(dir, plain)}`)
          continue
        }
        checked++
      }
    }
  }
  walk(dir)
  return { checked, problems }
}
