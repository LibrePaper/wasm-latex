import assert from 'node:assert/strict'
import { normalizeCrateArchiveUrl } from './crate-url.mjs'

assert.equal(
  normalizeCrateArchiveUrl('https://crates.io/api/v1/crates/libmarpa-asf-sys/0.3.0/download'),
  'https://static.crates.io/crates/libmarpa-asf-sys/libmarpa-asf-sys-0.3.0.crate',
)
assert.equal(
  normalizeCrateArchiveUrl('https://static.crates.io/crates/libmarpa-asf-sys/libmarpa-asf-sys-0.3.0.crate'),
  'https://static.crates.io/crates/libmarpa-asf-sys/libmarpa-asf-sys-0.3.0.crate',
)
assert.equal(normalizeCrateArchiveUrl('https://example.test/archive.tar.xz'), 'https://example.test/archive.tar.xz')
console.log('crate-url: legacy API URLs normalize to immutable static archives')
