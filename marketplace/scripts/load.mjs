import {appendFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from './load-config.mjs';
const config=loadConfig();
const pacing=new AbortController();
const [file,url]=process.argv.slice(2);
writeFileSync(file,'');
let running=true,count=0;
function stop() {running=false;pacing.abort();}
process.on('message',m=>{if(m==='stop') stop();});
for(const sig of ['SIGTERM','SIGINT']) process.on(sig,stop);
async function worker() {
 while(running) {
  let code='000';
  try {
   const r=await fetch(url,{headers:{connection:'close'},signal:AbortSignal.timeout(2000)});
   await r.arrayBuffer();code=String(r.status);
  } catch {}
  appendFileSync(file,code+'\n');count++;
  if(count===1 || count%100===0) process.send?.({count});
  if(running && config.intervalMs>0) await delay(config.intervalMs,undefined,{signal:pacing.signal}).catch(error=>{if(error.name!=='AbortError') throw error;});
 }
}
await Promise.all(Array.from({length:config.workers},worker));
process.send?.({count});process.disconnect?.();
