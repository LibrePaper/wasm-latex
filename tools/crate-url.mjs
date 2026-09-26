// Canonical immutable archive URL for a crates.io registry package.
// Receipts from older builds may still contain the API redirect URL; source
// staging normalizes that spelling at fetch time while retaining the receipt
// checksum as the trust decision.
export function normalizeCrateArchiveUrl(value) {
  if (typeof value !== 'string') return value
  const match = value.match(/^https:\/\/crates\.io\/api\/v1\/crates\/([^/]+)\/([^/]+)\/download$/)
  if (!match) return value
  const [, name, version] = match
  return `https://static.crates.io/crates/${name}/${name}-${version}.crate`
}
