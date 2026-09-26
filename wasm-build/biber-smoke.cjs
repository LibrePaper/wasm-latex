// Exercise native XS loading and Biber's data processing in fresh instances.
const assert = require('node:assert/strict');
const path = require('node:path');
const buildDir = path.resolve(process.argv[2]);
// Emscripten's Node data loader resolves biber.data against cwd.
process.chdir(buildDir);
const factory = require(path.join(buildDir, 'biber.js'));

async function main() {
  const xs = await factory({ noInitialRun: true });
  assert.equal(xs.callMain(['-e', 'use XML::LibXML; use Text::BibTeX; use Unicode::GCString; print "XS loaded\\n";']), 0);
  const tool = await factory({ noInitialRun: true });
  tool.FS.writeFile('/home/web_user/biber/smoke.bib',
    '@book{unicode, author={García, María}, title={Über Unicode}, year={2026}}\n');
  assert.equal(tool.callMain(['/opt/perl-wasm/bin/biber', '--tool', '--output-format=bibtex', '--nolog', 'smoke.bib']), 0);
  const output = tool.FS.readFile('/home/web_user/biber/smoke_bibertool.bib', { encoding: 'utf8' });
  assert.match(output, /unicode/);
  assert.match(output.normalize('NFC'), /García/);
  assert.match(output.normalize('NFC'), /Über Unicode/);
  console.log('Biber smoke: XS dependencies and Unicode tool output passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
