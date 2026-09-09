// Full browser pdfTeX → Biber → pdfTeX check. Requires Chromium, pdftotext,
// built pdfTeX/format/bundles and experimental Biber artifacts.
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

// Standalone Chromium/CDP driver; Node 22+ supplies WebSocket.
import { browser } from '../tools/browser-check-driver.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'dist/biber-validation/browser');
fs.mkdirSync(out,{recursive:true});
const server=createServer((req,res)=>{
 try {
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Biber validation</title>');return;}
  let base,rel;
  for(const [prefix,dir] of [['/biber/','dist/biber-experimental'],['/tex/','wasm-build/dist'],['/bundles/','wasm-build/dist/bundles']]){
   if(name.startsWith(prefix)){base=path.resolve(root,dir);rel=name.slice(prefix.length);break;}
  }
  if(!base || path.resolve(base,rel).startsWith(base+'/')===false) {res.writeHead(404);res.end();return;}
  const file=path.resolve(base,rel);
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');
  res.end(fs.readFileSync(file));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let driver;
async function run(input){
 const tex=new Worker('/tex/pdftex.worker.js');
 const queue=[];let wake;
 tex.onmessage=e=>{queue.push(e.data);wake?.();};
 tex.onerror=e=>{queue.push({error:e.message});wake?.();};
 async function next(cmd){
  const until=performance.now()+120000;
  while(performance.now()<until){
   const i=queue.findIndex(m=>m.error||(cmd?m.cmd===cmd:!m.cmd));
   if(i>=0){const m=queue.splice(i,1)[0];if(m.error||m.result==='failed')throw Error(JSON.stringify(m));return m;}
   await new Promise(r=>{wake=r;setTimeout(r,50)});
  } throw Error('Timeout: '+cmd);
 }
 async function send(data,reply=data.cmd){tex.postMessage(data);return next(reply);}
 const phases=[];
 const ready=await next();
 tex.postMessage({cmd:'settexliveurl',url:location.origin+'/bundles/'});
 await send({cmd:'loadbundleindex',data:await (await fetch('/bundles/bundles.json')).text(),msgId:1});
 await send({cmd:'loadformat',data:await (await fetch('/tex/pdftex.fmt')).arrayBuffer()});
 await send({cmd:'writefile',url:'main.tex',src:input.tex});
 await send({cmd:'writefile',url:'refs.bib',src:input.bib});
 tex.postMessage({cmd:'setmainfile',url:'main.tex'});
 let t=performance.now();
 const first=await send({cmd:'compilelatex'},'compile');phases.push({phase:'tex-first',ms:performance.now()-t,log:first.log});
 const bcf=(await send({cmd:'readfile',url:'main.bcf'})).data;
 const workerSource=`importScripts(${JSON.stringify(location.origin+'/biber/biber.js')});
 onmessage=async e=>{try {
  const start=performance.now(); const logs=[];
  const m=await biber({noInitialRun:true,locateFile:p=>${JSON.stringify(location.origin+'/biber/')}+p,print:s=>logs.push(s),printErr:s=>logs.push(s)});
  const loaded=performance.now();
  for(const [name,text] of Object.entries(e.data))m.FS.writeFile('/home/web_user/biber/'+name,text);
  const status=m.callMain(['/opt/perl-wasm/bin/biber','main']);
  if(status)throw Error('exit '+status+' '+logs.join('\\n'));
  postMessage({bbl:m.FS.readFile('/home/web_user/biber/main.bbl',{encoding:'utf8'}),loadMs:loaded-start,runMs:performance.now()-loaded,logs});
 }catch(e){postMessage({error:e.stack||String(e)})}};`;
 const url=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));
 const bibWorker=new Worker(url);
 async function bibliography(){return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Biber timeout')),120000);
  bibWorker.onmessage=e=>{clearTimeout(timer);e.data.error?reject(Error(e.data.error)):resolve(e.data)};
  bibWorker.onerror=e=>{clearTimeout(timer);reject(Error(e.message))};
  bibWorker.postMessage({'main.bcf':bcf,'refs.bib':input.bib});
 });}
 const cold=await bibliography();const warm=await bibliography();
 if(cold.bbl!==warm.bbl)throw Error('Cold/warm Biber output differs');
 await send({cmd:'writefile',url:'main.bbl',src:cold.bbl});
 let result;
 for(let pass=2;pass<=3;pass++){t=performance.now();result=await send({cmd:'compilelatex'},'compile');phases.push({phase:'tex-'+pass,ms:performance.now()-t,log:result.log});}
 const pdf=Array.from(new Uint8Array(result.pdf));
 tex.terminate();bibWorker.terminate();URL.revokeObjectURL(url);
 return {bcf,bbl:cold.bbl,cold,warm,phases,pdf};
}
try{
 driver=await browser(process.env.CHROMIUM || 'chromium',fs.mkdtempSync(path.join(tmpdir(),'biber-chromium-')));
 await driver.navigate(`http://127.0.0.1:${server.address().port}/`);
 const input={tex:fs.readFileSync(path.join(root,'wasm-build/biber-fixture/main.tex'),'utf8'),bib:fs.readFileSync(path.join(root,'wasm-build/biber-fixture/refs.bib'),'utf8')};
 const result=await driver.evaluate(`(${run.toString()})(${JSON.stringify(input)})`);
 fs.writeFileSync(path.join(out,'main.bcf'),result.bcf);
 fs.writeFileSync(path.join(out,'main.bbl'),result.bbl);
 fs.writeFileSync(path.join(out,'main.pdf'),Buffer.from(result.pdf));
 assert.equal(Buffer.from(result.pdf).subarray(0,5).toString(),'%PDF-');
 assert.doesNotMatch(result.phases.at(-1).log,/undefined references|Citation .* undefined|Please.*Biber|Empty bibliography/i);
 const text=execFileSync('pdftotext',[path.join(out,'main.pdf'),'-'],{encoding:'utf8'}).normalize('NFC');
 for(const word of ['Åström','Ecclésiastique','Sallustius','Žižek','References'])assert.ok(text.includes(word),'PDF missing '+word);
 fs.writeFileSync(path.join(out,'main.txt'),text);
 const nativeIndex=process.argv.indexOf('--native-bbl');
 if(nativeIndex>=0)assert.deepEqual(Buffer.from(result.bbl),fs.readFileSync(path.resolve(process.argv[nativeIndex+1])),'native/WASM BBL mismatch');
 result.nativeBblCompared=nativeIndex>=0;
 result.artifactHashes=Object.fromEntries(['biber.js','biber.wasm','biber.data'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(root,'dist/biber-experimental',name))).digest('hex')]));
 delete result.pdf;
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({coldMs:{load:result.cold.loadMs,run:result.cold.runMs},warmMs:{load:result.warm.loadMs,run:result.warm.runMs},tex:result.phases.map(p=>({phase:p.phase,ms:p.ms})),bblBytes:Buffer.byteLength(result.bbl)}));
}finally{await driver?.close();server.close();}
