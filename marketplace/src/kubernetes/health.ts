import type { INestApplication } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../database.service.js';
export function healthRoutes(app: INestApplication) {
  let ready=false;
  const db=app.get(DatabaseService);
  app.use('/healthz',(_req:any,res:any)=>res.status(200).json({status:'alive'}));
  app.use('/readyz',async (_req:any,res:any)=>{
    if(!ready) {res.status(503).json({status:'draining'});return;}
    try {await db.ping();res.status(200).json({status:'ready'});}
    catch {res.status(503).json({status:'database unavailable'});}
  });
  return {
    markReady:()=>{ready=true;},
    async drain(ms:number) {
      ready=false;
      // Keep accepting traffic until EndpointSlice/kube-proxy withdraw this endpoint.
      await delay(ms);
      await app.close();
    },
  };
}
