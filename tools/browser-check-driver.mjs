import { spawn } from 'node:child_process';

export async function browser(name, directory) {
 const child=spawn(name,['--headless=new','--no-sandbox','--disable-gpu',
  '--disable-dev-shm-usage','--user-data-dir='+directory,'--remote-debugging-port=0','about:blank'],
  {stdio:['ignore','ignore','pipe']});
 let socket;
 try {
  const endpoint=await new Promise((resolve,reject)=>{
   let log='';const timer=setTimeout(()=>reject(Error('Chromium startup timeout')),20000);
   child.once('error',e=>{clearTimeout(timer);reject(e)});
   child.once('exit',code=>{clearTimeout(timer);reject(Error('Chromium exited '+code+' '+log))});
   child.stderr.on('data',chunk=>{log+=chunk;const m=/DevTools listening on (ws:\/\/\S+)/.exec(log);if(m){clearTimeout(timer);resolve(m[1])}});
  });
  socket=new WebSocket(endpoint);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let serial=0;const pending=new Map();
  socket.onmessage=({data})=>{const m=JSON.parse(data),job=pending.get(m.id);if(!job)return;pending.delete(m.id);clearTimeout(job.timer);m.error?job.reject(Error(JSON.stringify(m.error))):job.resolve(m.result)};
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
   const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'))},180000);
   pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));
  });
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  return {
   navigate:url=>send('Page.navigate',{url},sessionId),
   evaluate:async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value},
   close:async()=>{socket.close();child.kill();await new Promise(resolve=>child.once('exit',resolve))},
  };
 }catch(e){socket?.close();child.kill();throw e}
}
