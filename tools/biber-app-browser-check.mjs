// Drive the real LibrePaper controller against a generated release mirror.
// Requires built/mirrored engines, Chromium, and pdftotext. No service deploy.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {browser} from './browser-check-driver.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1]};
const app=path.resolve(arg('app','../librepaper/web'));
const mirror=path.resolve(arg('mirror','mirror'));
const out=path.resolve(arg('out','dist/biber-app-validation'));
fs.mkdirSync(out,{recursive:true});
const requests=[];
const server=createServer((req,res)=>{
 try {
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  requests.push(name);
  if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Biber application check</title>');return;}
  const base=name.startsWith('/app/')?app:name.startsWith('/mirror/')?mirror:null;
  const rel=name.slice(name.startsWith('/app/')?5:8);
  if(!base||!path.resolve(base,rel).startsWith(base+'/')){res.writeHead(404);res.end();return;}
  const file=path.resolve(base,rel);
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');
  res.end(fs.readFileSync(file));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let driver;
try {
 driver=await browser(process.env.CHROMIUM||'chromium',fs.mkdtempSync(path.join(tmpdir(),'biber-app-chromium-')));
 await driver.navigate(`http://127.0.0.1:${server.address().port}/`);
 const input={tex:fs.readFileSync(path.join(root,'wasm-build/biber-fixture/main.tex'),'utf8'),bib:fs.readFileSync(path.join(root,'wasm-build/biber-fixture/refs.bib'),'utf8')};
 const run=async input=>{
  const latex=await import('/app/src/lib/latex.js');
  const status=await import('/app/src/lib/latex/status.js');
  const compile = async tree => {
   let timer;
   try { return await Promise.race([latex.compile(tree), new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Compile timeout: '+JSON.stringify(status.get()))),45000)})]); }
   finally { clearTimeout(timer); }
  };
  latex.at(location.origin+'/mirror/');
  latex.configure({project:'biber-browser-integration',settings:{engine:'pdflatex'}});
  const tree={main:'main.tex',texts:{'main.tex':input.tex,'refs.bib':input.bib},assets:{}};
  const first=await compile(tree);
  if (!first.ok) throw Error(JSON.stringify(first));
  const second=await compile({...tree,texts:{...tree.texts,'main.tex':input.tex.replace('Unicode bibliography:','Edited prose:')}});
  // Nested project paths must not be flattened when sent to Biber.
  latex.configure({project:'biber-nested-integration',settings:{engine:'pdflatex'}});
  const nested=await compile({main:'chapters/main.tex',texts:{'chapters/main.tex':input.tex,'chapters/refs.bib':input.bib},assets:{}});
  // A changed bibliography must invalidate the cached BBL.
  const changed=await compile({main:'chapters/main.tex',texts:{'chapters/main.tex':input.tex,'chapters/refs.bib':input.bib.replace('1974','1975')},assets:{}});
  return {first:{...first,pdf:Array.from(first.pdf||[])},second:{...second,pdf:null},nested:{...nested,pdf:Array.from(nested.pdf||[])},changed:{...changed,pdf:Array.from(changed.pdf||[])}};
 };
 const result=await driver.evaluate(`(${run.toString()})(${JSON.stringify(input)})`);
 for(const name of ['first','second','nested','changed']){
  const r=result[name];
  assert.equal(r.ok,true,`${name}: ${JSON.stringify(r.failure)} ${r.log}`);
  assert.equal(r.provenance.bibliography,'browser-biber',name+': '+JSON.stringify(r.provenance));
  assert.ok(!r.failure,`${name}: unexpected failure ${JSON.stringify(r.failure)}`);
  if(name!=='second'){
   fs.writeFileSync(path.join(out,name+'.pdf'),Buffer.from(r.pdf));
   const text=execFileSync('pdftotext',[path.join(out,name+'.pdf'),'-'],{encoding:'utf8'}).normalize('NFC');
   for(const word of ['Åström','Ecclésiastique','Sallustius','Žižek'])assert.ok(text.includes(word),`${name} PDF missing ${word}`);
   if(name==='changed')assert.ok(text.includes('1975'));
   fs.writeFileSync(path.join(out,name+'.txt'),text);
  }
  delete r.pdf;delete r.synctex;
 }
 assert.ok(!result.second.attempts.some(a=>a.stage==='browser-biber'),'prose edit reran Biber');
 assert.ok(result.changed.attempts.some(a=>a.stage==='browser-biber'),'bibliography edit did not rerun Biber');
 assert.ok(!requests.some(url=>/biber-vm|libv86|v86\.wasm|\/api\/config/.test(url)),'new release used the legacy VM');
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({result,requests},null,2));
 console.log('Application/mirror Biber: PDF, Unicode, nested paths, bibliography invalidation, prose cache reuse, and no VM passed');
}finally{await driver?.close();server.close();}
