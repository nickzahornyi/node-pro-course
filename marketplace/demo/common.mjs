import {execFileSync,spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
export const namespace='marketplace-hw28';
export const context='kind-'+(process.env.KIND_CLUSTER_NAME || 'hw28');
export function kubectl(args) {return execFileSync('kubectl',['--context',context,'-n',namespace,...args],{encoding:'utf8',maxBuffer:16*1024**2});}
export function json(args) {return JSON.parse(kubectl([...args,'-o','json']));}
export function pulumi(args) {return execFileSync('pulumi',[...args,'--cwd','infra','--non-interactive'],{stdio:'inherit'});}
export async function up(profile='hardened',revision) {
 await new Promise((resolve,reject)=>{
  const child=spawn('bash',['scripts/pulumi.sh','up'],{env:{...process.env,DEPLOY_PROFILE:profile,...(revision?{DEPLOY_REVISION:revision}:{})},stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('pulumi up failed')));
 });
 kubectl(['rollout','status','deployment/marketplace','--timeout=180s']);
}
export async function budgetReady() {
 for(let n=0;n<90;n++) {
  const pdb=json(['get','pdb','marketplace']);
  if(pdb.status?.currentHealthy===2 && pdb.status?.disruptionsAllowed>=1) return pdb;
  await delay(1000);
 }
 throw new Error('PDB never acquired a disruption budget');
}
