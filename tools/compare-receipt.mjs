#!/usr/bin/env node
// Compares a directory of built engine files against an upstream build
// receipt: for every file the receipt names, the size and sha256 of what we
// built beside what upstream published. Exit status is non-zero on any
// mismatch, so the reproduction is a check and not a report.
//
//   node tools/compare-receipt.mjs <BUILD-RECEIPT.pdftex.json> wasm-build/dist
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [receiptPath, distDir] = process.argv.slice(2);
if (!receiptPath || !distDir) {
  console.error("usage: compare-receipt.mjs <BUILD-RECEIPT.json> <dist dir>");
  process.exit(2);
}
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
let failures = 0;
console.log(`${receipt.family} ${receipt.texliveYear}  source ${receipt.sourceRevision.slice(0, 12)}  emscripten ${receipt.toolchain.emscriptenVersion}`);
for (const file of receipt.files) {
  const path = join(distDir, file.name);
  if (!existsSync(path)) {
    console.log(`MISSING   ${file.name}`);
    failures++;
    continue;
  }
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const same = sha256 === file.sha256 && bytes.length === file.bytes;
  if (!same) failures++;
  const size = same ? `${bytes.length}` : `${bytes.length} vs ${file.bytes}`;
  console.log(`${same ? "MATCH    " : "MISMATCH "} ${file.name}  ${size}  ${same ? "" : `${sha256.slice(0, 12)} vs ${file.sha256.slice(0, 12)}`}`);
}
console.log(failures ? `${failures} file(s) differ` : "all files reproduce");
process.exit(failures ? 1 : 0);
