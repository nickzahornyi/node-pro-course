import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {up} from './common.mjs';
const profile=process.env.ROLLOUT_PROFILE || 'hardened';
assert(['hardened','broken'].includes(profile));
const dir=mkdtempSync(join(tmpdir(),'hw28-load-')),file=join(dir,'codes.txt');
let load,count=0,done,interrupted=false;
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
 interrupted=true;
 if(load?.connected) load.send('stop');
});
function checkInterrupt() {if(interrupted) throw new Error('Rollout demo interrupted');}
async function stop() {if(load?.connected) load.send('stop');if(done) await done;}
try {
 await up(profile,'baseline-'+randomUUID());
 checkInterrupt();
 if(profile==='broken') await delay(6000); // Stabilize the deliberately unprobed baseline before measurement.
 load=fork(new URL('../scripts/load.mjs',import.meta.url),[file,'http://127.0.0.1:22800/health'],{stdio:['ignore','inherit','inherit','ipc']});
 done=once(load,'exit');load.on('message',m=>{count=m.count;});
 for(let n=0;count<100;n++) {if(n>100 || load.exitCode!==null) throw new Error('Load generator did not start');await delay(100);}
 checkInterrupt();
 const start=performance.now();
 await up(profile,'rollout-'+randomUUID());
 const seconds=(performance.now()-start)/1000;
 checkInterrupt();
 for(let n=0;count<5000;n++) {if(n>600 || load.exitCode!==null) throw new Error('Fewer than 5000 requests');await delay(100);}
 await stop();assert.equal(load.exitCode,0,'Load generator failed');
 const codes=readFileSync(file,'utf8').trim().split('\n');
 assert(codes.every(code=>/^\d{3}$/.test(code)));
 const ok=codes.filter(code=>code==='200').length,failed=codes.length-ok;
 console.log(`profile=${profile==='hardened'?1:0}\nrequests=${codes.length}\nok=${ok}\nfailed=${failed}\nrollout-seconds=${seconds.toFixed(3)}`);
 assert(codes.length>=5000);
 if(profile==='hardened') assert.equal(failed,0);
 else assert(failed>0,'Broken profile must expose failures');
} finally {
 await stop();
 try {if(profile!=='hardened') await up('hardened','restored-'+randomUUID());}
 finally {rmSync(dir,{recursive:true,force:true});}
}
