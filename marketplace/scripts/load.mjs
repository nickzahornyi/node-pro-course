import {appendFileSync,writeFileSync} from 'node:fs';
const [file,url]=process.argv.slice(2);
writeFileSync(file,'');
let running=true,count=0;
process.on('message',m=>{if(m==='stop') running=false;});
for(const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>{running=false;});
async function worker() {
 while(running) {
  let code='000';
  try {
   const r=await fetch(url,{headers:{connection:'close'},signal:AbortSignal.timeout(2000)});
   await r.arrayBuffer();code=String(r.status);
  } catch {}
  appendFileSync(file,code+'\n');count++;
  if(count%100===0) process.send?.({count});
 }
}
await Promise.all(Array.from({length:16},worker));
process.send?.({count});process.disconnect?.();
