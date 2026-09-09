// Verify the selected upstream snapshot without fetching anything.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../third-party/texlyre-biber/', import.meta.url));
const pin = JSON.parse(readFileSync(`${root}/UPSTREAM.json`, 'utf8'));
assert.match(pin.commit, /^[a-f0-9]{40}$/);
const actual = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => `${entry.parentPath}/${entry.name}`.slice(root.length).replace(/^\//, ''))
  .filter(name => name !== 'UPSTREAM.json').sort();
assert.deepEqual(actual, Object.keys(pin.files).sort(), 'vendored file inventory changed');
for (const [name, hash] of Object.entries(pin.files)) {
  const actualHash = createHash('sha256').update(readFileSync(`${root}/${name}`)).digest('hex');
  assert.equal(actualHash, hash, `upstream file changed: ${name}`);
}
console.log(`Biber vendor: ${actual.length} files match ${pin.commit}`);
