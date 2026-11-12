import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,statSync,openSync,readSync,closeSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'hw28-image-')),image=process.env.IMAGE || 'marketplace:hw28';
const token='hw28-bait-'+randomBytes(32).toString('hex');
const occurrences=text=>text.split(token).length-1;
function check(name,value,test) {console.log(`${name}=${value}`);assert(test(value),name);}
try {
 const secret=join(dir,'token');writeFileSync(secret,token,{mode:0o600});
 execFileSync('bash',['scripts/image-build.sh','--no-cache'],{env:{...process.env,NPM_TOKEN_FILE:secret},stdio:'inherit'});
 check('stages',(readFileSync('docker/Dockerfile','utf8').match(/^FROM\s/gmi)||[]).length,v=>v>=2);
 const shell=spawnSync('docker',['run','--rm','--entrypoint','sh',image,'-c','exit 0'],{encoding:'utf8'});
 if(shell.error) throw shell.error;
 check('shell-inside',Number(shell.status===0),v=>v===0);
 const uid=Number(execFileSync('docker',['run','--rm',image,'-e','console.log(process.getuid())'],{encoding:'utf8'}).trim());
 check('runtime-uid',uid,v=>Number.isInteger(v)&&v>0);
 check('token-in-history',occurrences(execFileSync('docker',['history','--no-trunc',image],{encoding:'utf8',maxBuffer:32*1024**2})),v=>v===0);
 check('token-in-config',occurrences(execFileSync('docker',['image','inspect',image],{encoding:'utf8'})),v=>v===0);
 const archive=join(dir,'image.tar');execFileSync('docker',['save','-o',archive,image]);
 execFileSync('tar',['-xf',archive,'-C',dir]);
 // Scan every saved blob (including removed files in lower layers), never just final FS.
 let found=0;const needle=Buffer.from(token);
 function walk(path) {
  for(const item of readdirSync(path)) {
   const file=join(path,item);if(file===archive || file===secret) continue;
   if(statSync(file).isDirectory()) {walk(file);continue;}
   const fd=openSync(file,'r'),buffer=Buffer.alloc(1024*1024);let previous=Buffer.alloc(0),length;
   try {while((length=readSync(fd,buffer,0,buffer.length,null))>0) {
    const bytes=Buffer.concat([previous,buffer.subarray(0,length)]);
    if(bytes.includes(needle)) found++;
    previous=bytes.subarray(Math.max(0,bytes.length-needle.length+1));
   }} finally {closeSync(fd);}
  }
 }
 walk(dir);check('token-in-layers',found,v=>v===0);
} finally {rmSync(dir,{recursive:true,force:true});}
