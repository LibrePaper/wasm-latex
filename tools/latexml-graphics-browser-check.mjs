// Real WASM integration through LibrePaper's adapter; use an assembled mirror.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { browser } from './browser-check-driver.mjs';

const app = path.resolve(process.env.LIBREPAPER_WEB || '../librepaper/web');
const mirror = path.resolve(process.env.MIRROR || 'mirror');
const profile = fs.mkdtempSync(path.join(tmpdir(), 'latexml-graphics-'));
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>'); return; }
  const root = url.pathname.startsWith('/app/') ? app : mirror;
  const relative = url.pathname.slice(url.pathname.startsWith('/app/') ? 5 : 8);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try {
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let tab;
try {
  tab = await browser(process.env.CHROMIUM || 'chromium', profile);
  await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
  const result = await tab.evaluate(`(async () => {
    const {compile} = await import('/app/src/lib/latex/html.js');
    const source = String.raw\`\\documentclass{article}
\\usepackage{graphicx}
\\newcommand{\\picture}{\\includegraphics[width=0.24\\linewidth]{pixel.png}}
\\begin{document}
\\includegraphics[width=0.12\\linewidth]{pixel.png}
\\picture
\\begin{minipage}{0.5\\linewidth}\\picture\\end{minipage}
\\end{document}\`;
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXcAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const output = await compile({main:'main.tex', texts:{'main.tex':source}, assets:{'pixel.png':png}}, {base:location.origin+'/mirror/'});
    if (!output.ok) throw Error(output.log);
    const frame = document.createElement('iframe');
    frame.style.width = '1000px';
    const loaded = new Promise(resolve => frame.onload = resolve);
    frame.srcdoc = output.html;
    document.body.append(frame);
    await loaded;
    const images = [...frame.contentDocument.querySelectorAll('img.ltx_graphics')];
    await Promise.all(images.map(image => image.decode()));
    return images.map(image => ({width:image.getBoundingClientRect().width, height:image.getBoundingClientRect().height, missing:image.classList.contains('ltx_missing_image')}));
  })()`);
  assert.equal(result.length, 3);
  assert.ok(result.every(image => !image.missing && image.width > 1 && image.height > 0), JSON.stringify(result));
  assert.ok(Math.abs(result[1].width - 2 * result[0].width) <= 2, JSON.stringify(result));
  assert.ok(Math.abs(result[2].width - result[0].width) <= 2, JSON.stringify(result));
  console.log('LaTeXML graphics: decoded images, TeX widths, macros and minipage sizing passed', result);
} finally {
  await tab?.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  fs.rmSync(profile, {recursive:true, force:true});
}
