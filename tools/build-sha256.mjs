// Build the SHA-256 wasm module and embed it in wasm-build/kpse-resolve.cjs.
// Usage: node tools/build-sha256.mjs [--check]
// --check rebuilds and exits non-zero when the embedded bytes differ.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = path.join(root, 'wasm-build/sha256/Cargo.toml');
const wasmFile = path.join(root, 'wasm-build/sha256/target/wasm32-unknown-unknown/release/sha256_wasm.wasm');
const target = path.join(root, 'wasm-build/kpse-resolve.cjs');
const BEGIN = '// BEGIN GENERATED SHA256 WASM';
const END = '// END GENERATED SHA256 WASM';
const check = process.argv.includes('--check');

execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest], {stdio: 'inherit'});
const b64 = fs.readFileSync(wasmFile).toString('base64');

const src = fs.readFileSync(target, 'utf8');
const start = src.indexOf(BEGIN);
const stop = src.indexOf(END);
if (start < 0 || stop < start) {
  console.error('build-sha256: markers missing in ' + target);
  process.exit(1);
}
const next = src.slice(0, start + BEGIN.length) + '\nvar SHA256_WASM_BASE64 = "' + b64 + '";\n' + src.slice(stop);

if (check) {
  if (next !== src) {
    console.error('build-sha256: embedded wasm is out of date; run: node tools/build-sha256.mjs');
    process.exit(1);
  }
  console.log('build-sha256: embedded wasm is current');
} else {
  fs.writeFileSync(target, next);
  console.log('build-sha256: embedded ' + b64.length + ' base64 characters');
}
