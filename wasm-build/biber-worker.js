// SPDX-License-Identifier: MIT
// One isolated Biber job. The host supplies all runtime bytes after verifying
// them against the release manifest; this worker fetches no runtime or project files.
'use strict';

function projectPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') ||
      /[\\\x00-\x1f\x7f]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Invalid project path: ${value}`);
  }
  return value;
}

self.onmessage = async ({ data: job }) => {
  const logs = [];
  let glueURL;
  try {
    const stem = projectPath(job.stem);
    for (const name of Object.keys(job.files || {})) projectPath(name);
    glueURL = URL.createObjectURL(new Blob([job.glue], { type: 'text/javascript' }));
    importScripts(glueURL);
    const module = await self.biber({
      noInitialRun: true,
      // Bypass Emscripten's independently cached data: these bytes have already
      // been verified by the application's release cache.
      getPreloadedPackage: () => job.data,
      instantiateWasm(imports, done) {
        const instance = new WebAssembly.Instance(job.wasm, imports);
        done(instance, job.wasm);
        return instance.exports;
      },
      print: line => logs.push(line),
      printErr: line => logs.push(line),
    });
    const root = '/home/web_user/biber';
    const write = (name, bytes) => {
      const filename = `${root}/${projectPath(name)}`;
      module.FS.mkdirTree(filename.slice(0, filename.lastIndexOf('/')));
      module.FS.writeFile(filename, bytes);
    };
    for (const [name, bytes] of Object.entries(job.files || {})) write(name, bytes);
    write(`${stem}.bcf`, job.bcf);
    // Match TeX's project-root working directory and retain nested paths.
    // --input-directory also allows resources relative to a nested main file.
    const parent = stem.includes('/') ? stem.slice(0, stem.lastIndexOf('/')) : '.';
    const args = ['/opt/perl-wasm/bin/biber', '--input-directory', `${root}/${parent}`,
      '--output-file', `${root}/${stem}.bbl`, `${root}/${stem}.bcf`];
    let status;
    try { status = module.callMain(args); }
    catch (error) { if (typeof error.status !== 'number') throw error; status = error.status; }
    const blg = logs.join('\n');
    if (status !== 0) {
      self.postMessage({ ok: false, status, blg, error: blg || `Biber exited ${status}`,
        incompatible: /control file version/i.test(blg) });
      return;
    }
    const bbl = module.FS.readFile(`${root}/${stem}.bbl`);
    self.postMessage({ ok: true, bbl, blg }, [bbl.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, infrastructure: true, error: String(error?.stack || error), blg: logs.join('\n') });
  } finally {
    if (glueURL) URL.revokeObjectURL(glueURL);
  }
};
