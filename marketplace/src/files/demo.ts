import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { CreateBucketCommand, HeadBucketCommand, DeleteObjectCommand, HeadObjectCommand, ListMultipartUploadsCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import db from '../data-source.js';
import { passwordHash } from '../auth/auth.service.js';
import { storage, publishAsset, MiB } from './storage.js';
import { createEdge } from './edge.js';
const mode=process.argv[2];assert(['upload','multipart','cdn'].includes(mode));
const {s3,bucket}=storage();
const objects=new Set<string>(), children=new Set<ChildProcess>();
let edge:ReturnType<typeof createEdge>|undefined;
let userId:string|undefined;
let api:ChildProcess|undefined, base='', token='';
let cleaning:Promise<void>|undefined;
function check(key:string,value:number,expected:number) {console.log(`${key}=${value}`);assert.equal(value,expected,key);}
async function stop(child:ChildProcess) {
  if(child.exitCode!==null || child.signalCode!==null) return;
  const done=once(child,'exit'); child.kill('SIGTERM');
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000).unref();
  await done;clearTimeout(timer);children.delete(child);
}
async function cleanup() {
  return cleaning ??= (async()=>{
    for(const child of children) await stop(child);
    if(edge?.listening) await new Promise<void>(r=>edge!.close(()=>r()));
    if(userId) {
      const rows=await db.query('SELECT key,upload_id FROM files WHERE owner_id=$1',[userId]);
      for(const row of rows) {
        objects.add(row.key);
        if(row.upload_id) await s3.send(new AbortMultipartUploadCommand({Bucket:bucket,Key:row.key,UploadId:row.upload_id})).catch(e=>{if(e.$metadata?.httpStatusCode!==404) throw e;});
      }
      await db.query('DELETE FROM users WHERE id=$1',[userId]);
    }
    for(const key of objects) await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));
    s3.destroy();if(db.isInitialized) await db.destroy();
  })();
}
for(const sig of ['SIGINT','SIGTERM'] as const) process.once(sig,()=>void cleanup().finally(()=>process.exit(1)));
async function start() {
  api=fork(new URL('./api-main.js',import.meta.url),[],{env:{...process.env,...(mode==='upload'?{STORAGE_PRESIGN_SECONDS:'3'}:{})},stdio:['ignore','ignore','inherit','ipc']});children.add(api);
  base=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('API startup timed out')),15000);
    api!.once('message',(msg:any)=>{clearTimeout(timer);resolve(msg.base);});
    api!.once('exit',code=>{clearTimeout(timer);reject(new Error(`API exit ${code}`));});
  });
}
async function request(path:string,body:unknown,key?:string) {
  const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  return {status:response.status,data:await response.json() as any};
}
async function intent(size:number,key=randomUUID()) {
  const r=await request('/uploads/intent',{size,contentType:'application/octet-stream',filename:'../../etc/passwd'},key);
  assert.equal(r.status,200,JSON.stringify(r.data));objects.add(r.data.key);return r;
}
async function client(parts:any[],crashAfter?:number,resume?:unknown) {
  const child=fork(new URL('./client-main.js',import.meta.url),[],{env:{PATH:process.env.PATH},stdio:['ignore','ignore','inherit','ipc']});children.add(child);
  let result:any;child.on('message',m=>result=m);
  const done=once(child,'exit');child.send({parts,crashAfter,resume});
  const [code]=await done;children.delete(child);
  assert.equal(code,crashAfter?17:0);return result;
}
async function head(key:string) {
  try {const h=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));return {status:200,data:h};}
  catch(e:any) {return {status:e.$metadata?.httpStatusCode,data:undefined};}
}
try {
  try {await s3.send(new HeadBucketCommand({Bucket:bucket}));}
  catch(e:any) {if(e.$metadata?.httpStatusCode!==404) throw e;await s3.send(new CreateBucketCommand({Bucket:bucket}));}
  await db.initialize();await db.runMigrations();
  // Every run uses an isolated owner/keys, so stale data cannot satisfy any assertion.
  // Also abort leftovers in this demo's namespace when reusing its keys.
  const email=`hw26-${randomUUID()}@example.test`,password=randomUUID();
  const [user]=await db.query("INSERT INTO users(email,display_name,role,password_hash) VALUES($1,'HW26 demo','buyer',$2) RETURNING id",[email,passwordHash(password)]);userId=user.id;
  await start();
  const login=await request('/auth/login',{email,password});assert.equal(login.status,200);token=login.data.access_token;
  if(mode==='upload') {
    const body=Buffer.from('direct upload');const key=randomUUID();const first=await intent(body.length,key);check('intent',first.status,200);
    const f=first.data;
    check('key-from-server',Number(new RegExp(`^uploads/${userId}/[a-f0-9-]{36}\\.bin$`).test(f.key) && !f.key.includes('passwd')),1);
    const replay=await intent(body.length,key);assert.equal(replay.data.id,f.id);
    assert.equal((await request('/uploads/intent',{size:1,contentType:'text/html'},randomUUID())).status,400);
    const empty=await intent(3);const missing=await request('/uploads/commit',{id:empty.data.id});
    console.log(`commit-without-bytes=${missing.status}`);assert(missing.status>=400&&missing.status<500);
    const exp=(await intent(4)).data.url;
    const port=new URL(base).port;await stop(api!);
    const alive=await new Promise<number>(resolve=>{const socket=connect(Number(port),'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(1);});socket.once('error',()=>resolve(0));});check('api-alive',alive,0);
    const uploaded=await client([{url:f.url,size:body.length}]);check('put-offline',uploaded.status,200);
    const tampered=new URL(f.url);tampered.pathname=tampered.pathname.replace(/\.bin$/,'.other.bin');
    const bad=await fetch(tampered,{method:'PUT',body:Buffer.alloc(body.length)});await bad.arrayBuffer();check('tampered',bad.status,403);
    // Same capability issued by intent, tested after its real TTL has elapsed.
    await delay(4100);const expired=await fetch(exp,{method:'PUT',body:'late'});await expired.arrayBuffer();check('expired',expired.status,403);
    await start();assert.notEqual(new URL(base).port,port);
    check('commit',(await request('/uploads/commit',{id:f.id})).status,200);
  } else if(mode==='multipart') {
    const size=15*MiB;const f=(await intent(size)).data;assert.equal(f.parts.length,3);
    // Ensure there is no object or unfinished upload from a previous run for this key.
    await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:f.key}));
    const pending=await s3.send(new ListMultipartUploadsCommand({Bucket:bucket,Prefix:f.key}));
    for(const u of pending.Uploads || []) if(u.UploadId!==f.uploadId) await s3.send(new AbortMultipartUploadCommand({Bucket:bucket,Key:u.Key,UploadId:u.UploadId}));
    const part=(p:any)=>({...p,size:Math.min(f.partSize,size-(p.number-1)*f.partSize)});
    await client(f.parts.slice(0,2).map(part),2);
    check('head-before-complete',(await head(f.key)).status,404);
    assert.equal((await request('/uploads/commit',{id:f.id})).status,409);
    const resume=await request('/uploads/resume',{id:f.id});assert.equal(resume.status,200);assert.equal(resume.data.existing.length,2);
    const second=await client([],undefined,{base,token,id:f.id,size});check('resumed-parts',second.count,1);
    const complete=await request('/uploads/commit',{id:f.id});check('complete',complete.status,200);
    const h=(await head(f.key)).data!;check('size-match',Number(h.ContentLength===size),1);check('etag-multipart',Number(/-3"?$/.test(h.ETag!)),1);
  } else {
    const namespace=`assets/demo-${randomUUID()}`;
    const oldBody=Buffer.from('body{color:blue}'),newBody=Buffer.from('body{color:green}');
    const oldKey=await publishAsset(oldBody,namespace);objects.add(oldKey);
    const direct=await fetch(`${process.env.STORAGE_ENDPOINT}/${bucket}/${oldKey}`);await direct.arrayBuffer();check('direct',direct.status,403);
    edge=createEdge();await new Promise<void>(r=>edge!.listen(0,'127.0.0.1',r));
    const edgeBase=`http://127.0.0.1:${(edge.address() as any).port}/`;
    const miss=await fetch(edgeBase+oldKey);check('edge-miss',miss.status,200);assert.equal(miss.headers.get('x-cache'),'MISS');assert.equal(await miss.text(),oldBody.toString());
    const hit=await fetch(edgeBase+oldKey);check('edge-hit',hit.status,200);check('cache-hit',Number(hit.headers.get('x-cache')==='HIT'),1);await hit.text();
    const newKey=await publishAsset(newBody,namespace);objects.add(newKey);check('new-name',Number(newKey!==oldKey),1);
    const next=await fetch(edgeBase+newKey);check('new-url',next.status,200);check('content-changed',Number(await next.text()===newBody.toString()),1);
    const still=await fetch(edgeBase+oldKey);assert.equal(still.headers.get('x-cache'),'HIT');assert.equal(await still.text(),oldBody.toString());
  }
} finally {await cleanup();}
