import { createServer } from 'node:http';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { storage } from './storage.js';
// Local OAC analogue: only this authenticated SDK client reads the private origin.
export function createEdge() {
  const {s3,bucket}=storage();
  const cache=new Map<string,{body:Buffer;type:string;control:string;until:number}>();
  const server=createServer(async (req,res)=>{
    if(req.method!=='GET') {res.writeHead(405).end();return;}
    let key:string;
    try { key=decodeURIComponent((req.url || '/').split('?')[0].slice(1)); }
    catch {res.writeHead(400).end();return;}
    if(!/^assets\/[a-zA-Z0-9/._-]+$/.test(key)) {res.writeHead(404).end();return;}
    try {
      let entry=cache.get(key); const hit=Boolean(entry && entry.until>Date.now());
      if(!hit) {
        const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:key}));
        const control=object.CacheControl || 'no-store';
        const age=/\bpublic\b/.test(control) && !/no-store|private|no-cache/.test(control) ? Number(control.match(/max-age=(\d+)/)?.[1] || 0) : 0;
        entry={body:Buffer.from(await object.Body!.transformToByteArray()),type:object.ContentType || 'application/octet-stream',control,until:Date.now()+age*1000};
        if(age>0) {if(cache.size>=128) cache.delete(cache.keys().next().value!);cache.set(key,entry);}
      }
      res.writeHead(200,{'Content-Type':entry!.type,'Cache-Control':entry!.control,'X-Cache':hit?'HIT':'MISS','X-Content-Type-Options':'nosniff'}).end(entry!.body);
    } catch(e:any) {res.writeHead(e.$metadata?.httpStatusCode===404?404:502).end();}
  });
  server.on('close',()=>s3.destroy());
  return server;
}
