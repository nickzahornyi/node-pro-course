import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {up,budgetReady,kubectl,json,context,namespace} from './common.mjs';
await up('hardened');
const pdb=await budgetReady();
console.log(`healthy=${pdb.status.currentHealthy}\nminAvailable=${pdb.spec.minAvailable}`);
const pods=json(['get','pods','-l','app=marketplace-api']).items.filter(p=>!p.metadata.deletionTimestamp);
assert.equal(pods.length,2);
const proxy=spawn('kubectl',['--context',context,'proxy','--port=0'],{stdio:['ignore','pipe','inherit']});
try {
 const base=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('kubectl proxy timed out')),15000);
  proxy.stdout.on('data',chunk=>{const match=chunk.toString().match(/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve('http://'+match[0]);}});
  proxy.on('exit',()=>{clearTimeout(timer);reject(new Error('Proxy exited'));});
 });
 async function evict(pod) {
  const response=await fetch(`${base}/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}/eviction`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({apiVersion:'policy/v1',kind:'Eviction',metadata:{name:pod.metadata.name,namespace},deleteOptions:{preconditions:{uid:pod.metadata.uid}}})});
  await response.arrayBuffer();return response.status;
 }
 const first=await evict(pods[0]);console.log(`evict-1=${first}`);assert.equal(first,201);
 const second=await evict(pods[1]);console.log(`evict-2=${second}`);assert.equal(second,429);
} finally {
 proxy.kill('SIGTERM');
 // Read-only rollout status, then wait for replacement readiness to restore the budget.
 kubectl(['rollout','status','deployment/marketplace','--timeout=180s']);
 await budgetReady();
}
