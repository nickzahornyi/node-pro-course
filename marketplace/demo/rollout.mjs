import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {up,json,kubectl} from './common.mjs';
import {loadConfig} from '../scripts/load-config.mjs';
const config=loadConfig();
const baseline=process.argv.includes('--baseline');
const profile=process.env.ROLLOUT_PROFILE || 'hardened';
assert(['hardened','broken'].includes(profile));
if(baseline) assert.equal(profile,'hardened','demo:baseline requires ROLLOUT_PROFILE=hardened');
const dir=mkdtempSync(join(tmpdir(),'hw28-load-')),file=join(dir,'codes.txt');
let load,count=0,done,interrupted=false;
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
 interrupted=true;
 if(load?.connected) load.send('stop');
});
function checkInterrupt() {if(interrupted) throw new Error('Rollout demo interrupted');}
async function stop() {if(load?.connected) load.send('stop');if(done) await done;}
try {
 if(baseline) {
  const deployment=json(['get','deployment','marketplace']);
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable,0,'Baseline requires hardened deployment');
  kubectl(['rollout','status','deployment/marketplace','--timeout=180s']);
 } else await up(profile,'baseline-'+randomUUID());
 checkInterrupt();
 if(!baseline && profile==='broken') await delay(6000); // Stabilize the deliberately unprobed baseline before measurement.
 load=fork(new URL('../scripts/load.mjs',import.meta.url),[file,'http://127.0.0.1:22800/health'],{stdio:['ignore','inherit','inherit','ipc']});
 done=once(load,'exit');load.on('message',m=>{count=m.count;});
 for(let n=0;count<1;n++) {if(n>100 || load.exitCode!==null) throw new Error('Load generator did not start');await delay(100);}
 checkInterrupt();
 const start=performance.now();
 if(baseline) await delay(config.baselineSeconds*1000);
 else await up(profile,'rollout-'+randomUUID());
 const seconds=(performance.now()-start)/1000;
 checkInterrupt();
 const fillDeadline=performance.now()+config.maxSeconds*1000;
 while(count<5000) {
  checkInterrupt();
  if(performance.now()>fillDeadline || load.exitCode!==null || load.signalCode!==null) throw new Error('Fewer than 5000 requests within LOAD_MAX_SECONDS');
  await delay(100);
 }
 await stop();assert.equal(load.exitCode,0,'Load generator failed');
 const codes=readFileSync(file,'utf8').trim().split('\n');
 assert(codes.every(code=>/^\d{3}$/.test(code)));
 const elapsed=baseline?(performance.now()-start)/1000:seconds;
 const ok=codes.filter(code=>code==='200').length,failed=codes.length-ok;
 console.log(`baseline=${Number(baseline)}\nload-workers=${config.workers}\nload-interval-ms=${config.intervalMs}\nprofile=${profile==='hardened'?1:0}\nrequests=${codes.length}\nok=${ok}\nfailed=${failed}\n${baseline?'baseline-seconds':'rollout-seconds'}=${elapsed.toFixed(3)}`);
 assert(codes.length>=5000);
 if(baseline || profile==='hardened') assert.equal(failed,0);
 else assert(failed>0,'Broken profile must expose failures');
} finally {
 await stop();
 try {if(!baseline && profile!=='hardened') await up('hardened','restored-'+randomUUID());}
 finally {rmSync(dir,{recursive:true,force:true});}
}
