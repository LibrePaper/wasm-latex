// Run inside the Biber build container after the source archive is assembled.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [build, out] = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const info = name => { const data = fs.readFileSync(path.join(out, name)); return { bytes: data.length, sha256: sha(data) }; };
const map = fs.readFileSync(path.join(out, 'biber.map'), 'utf8');
const archives = [...new Set([...map.matchAll(/([^\s()]+\.a)\(/g)]
  .map(m => path.resolve(build, 'src/perl', m[1])))].sort();
if (!archives.some(a => a.endsWith('/libperl.a'))) throw new Error('Biber map has no libperl.a');
const unknown = archives.filter(a => !a.startsWith(`${build}/src/perl/`) && !a.startsWith('/emsdk/upstream/emscripten/cache/sysroot/'));
if (unknown.length) throw new Error(`Unclassified Biber archives: ${unknown.join(', ')}`);
const notice = 'biber-notices/NOTICE';
const linked = [];
function component(name, license, source, selectedAs = []) {
  linked.push({ component: name, license, source: `BIBER-SOURCE.tar.gz:biber/${source}`,
    staticLinkObligation: 'source-and-notices', notices: [notice], selectedAs });
}
const licenses = { perl_5: 'GPL-1.0-or-later OR Artistic-1.0-Perl', artistic_2: 'Artistic-2.0', apache_2_0: 'Apache-2.0', mit: 'MIT' };
const modules = fs.readFileSync('/src/texlyre-biber/biber/modules.txt', 'utf8').trim().split('\n');
for (const line of modules) {
  const [name, version] = line.trim().split(/\s+/);
  const dir = name.replaceAll('::', '-');
  const meta = JSON.parse(fs.readFileSync(`${build}/src/${dir}/META.json`));
  // Sort::Key's META says unknown; its README explicitly grants Perl's terms.
  const license = name === 'Sort::Key' ? licenses.perl_5 : licenses[meta.license?.[0]];
  if (!license) throw new Error(`Unclassified CPAN license: ${name}`);
  const suffix = `/auto/${name.replaceAll('::', '/')}/${name.split('::').at(-1)}.a`;
  const selected = archives.filter(a => a.endsWith(suffix));
  if (!selected.length) throw new Error(`Expected XS archive missing from Biber map: ${name}`);
  component(`${name} ${version}`, license, `src/${dir}`, selected);
}
component('Perl 5.38.2, core extensions, Unicode tables and emperl', licenses.perl_5,
  'src/perl', archives.filter(a => a.startsWith(`${build}/src/perl/`) && !linked.some(c => c.selectedAs.includes(a))));
component('Biber 2.22', 'Artistic-2.0', 'src/biber');
component('libxml2 (merged into XML::LibXML)', 'MIT', 'src/libxml2');
component('sombok (merged into Unicode::LineBreak)', licenses.perl_5, 'src/Unicode-LineBreak/sombok');
component('TeXlyre Perl patches and browser pre-run', 'AGPL-3.0-only', 'repo/third-party/texlyre-biber');
component('Emscripten runtime, libc, compiler-rt and LZ4', 'LicenseRef-Emscripten-runtime-notices',
  'emscripten', archives.filter(a => a.startsWith('/emsdk/')));
component('Packaged pure Perl dependencies and data (per-file terms retained)', 'LicenseRef-Packaged-Perl-notices', 'host-perl5');
const constants = fs.readFileSync(`${build}/src/biber/lib/Biber/Constants.pm`, 'utf8');
const controlFile = /\$BCF_VERSION\s*=\s*'([^']+)'/.exec(constants)?.[1];
if (!controlFile) throw new Error('Biber control-file version not found');
const artifacts = Object.fromEntries(['biber.js', 'biber.wasm', 'biber.data'].map(name => [name, info(name)]));
const inventory = {
  schemaVersion: 1, family: 'biber', combinedTerms: 'AGPL-3.0-only AND LicenseRef-Packaged-Perl-notices AND LicenseRef-Emscripten-runtime-notices',
  combinedTermsReason: 'TeXlyre runtime modifications retain AGPL-3.0; Perl-licensed code permits GPLv3. Individual runtime/dependency notices and their preferred source are shipped in full.',
  modules: [{ name: 'biber', wasm: artifacts['biber.wasm'], archives: archives.length }],
  linked, requiredNotices: [notice, 'third-party/texlyre-biber/LICENSE'],
};
fs.writeFileSync(path.join(out, 'biber.build.json'), JSON.stringify({
  schemaVersion: 1, version: '2.22', controlFile, artifacts, linkMap: info('biber.map'),
  sourceArchive: info('BIBER-SOURCE.tar.gz'), inventory,
}, null, 2) + '\n');
