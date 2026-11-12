import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fork,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

async function runLoad(workers,intervalMs,status=200) {
 const dir=mkdtempSync(join(tmpdir(),'load-test-')),file=join(dir,'codes');
 const starts=[];let active=0,peak=0,completed=0,child;
 const server=createServer((req,res)=>{
  starts.push(performance.now());peak=Math.max(peak,++active);
  setTimeout(()=>{
   if(status===0) res.destroy();else res.writeHead(status).end('test');
   active--;completed++;
   if(completed>=6 && child.connected) child.send('stop');
  },25);
 });
 let exited;
 try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  child=fork(new URL('../scripts/load.mjs',import.meta.url),[file,`http://127.0.0.1:${server.address().port}`],{env:{PATH:process.env.PATH,LOAD_WORKERS:String(workers),LOAD_INTERVAL_MS:String(intervalMs)},stdio:['ignore','ignore','inherit','ipc']});
  exited=once(child,'exit');
  const [code]=await exited;assert.equal(code,0);
  const codes=readFileSync(file,'utf8').trim().split('\n');
  assert.equal(codes.length,completed);
  assert(codes.length>=6);
  assert(codes.every(code=>code===(status===0?'000':String(status))));
  return {peak,starts};
 } finally {
  if(child && child.exitCode===null) {child.kill('SIGTERM');await exited;}
  await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
}

test('load uses one worker and enforces the configured pause between requests',{timeout:10000},async()=>{
 const {peak,starts}=await runLoad(1,40);
 assert.equal(peak,1);
 for(let i=1;i<starts.length;i++) assert(starts[i]-starts[i-1]>=55);
});
test('load runs the requested parallel workers and records HTTP failures',{timeout:10000},async()=>{
 const {peak}=await runLoad(2,0,503);assert.equal(peak,2);
});
test('load preserves transport failures as 000',{timeout:10000},async()=>{await runLoad(1,0,0);});
test('invalid load settings fail before attempting any deployment',()=>{
 for(const [name,value] of [['LOAD_WORKERS','0'],['LOAD_WORKERS','1.5'],['LOAD_INTERVAL_MS','-1'],['LOAD_MAX_SECONDS','NaN']]) {
  const r=spawnSync(process.execPath,['demo/rollout.mjs'],{env:{...process.env,LOAD_WORKERS:'1',LOAD_INTERVAL_MS:'0',LOAD_MAX_SECONDS:'300',LOAD_BASELINE_SECONDS:'20',[name]:value},encoding:'utf8'});
  assert.notEqual(r.status,0);assert(r.stderr.includes(name));
 }
});
