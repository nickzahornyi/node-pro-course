import { Injectable, BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CreateMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DatabaseService } from '../database.service.js';
import { storage, uploadPlan } from './storage.js';
const types = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/octet-stream':'bin'} as const;
const input = z.object({contentType:z.enum(['image/jpeg','image/png','image/webp','application/octet-stream']),size:z.number().int().positive().max(5*1024**4)});
@Injectable()
export class FilesService {
  constructor(private readonly db: DatabaseService) {}
  private ttl() {
    const ttl = Number(process.env.STORAGE_PRESIGN_SECONDS || 120);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 900) throw new Error('STORAGE_PRESIGN_SECONDS must be 1..900');
    return ttl;
  }
  async intent(owner: string, requestKey: string, body: unknown) {
    const parsed = input.safeParse(body);
    if (!parsed.success || !requestKey || requestKey.length > 128) throw new BadRequestException('Valid contentType, size and Idempotency-Key required');
    const data = parsed.data;
    const {s3,bucket} = storage();
    try {
      const row = await this.db.transaction(async c => {
        // Transaction lock prevents double taps from allocating two multipart uploads.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`files:${owner}:${requestKey}`]);
        const {rows:[old]} = await c.query('SELECT * FROM files WHERE owner_id=$1 AND request_key=$2',[owner,requestKey]);
        if (old) {
          if (Number(old.size)!==data.size || old.content_type!==data.contentType) throw new UnprocessableEntityException('Idempotency-Key body mismatch');
          return old;
        }
        const id = randomUUID(), key = `uploads/${owner}/${id}.${types[data.contentType]}`;
        const plan = uploadPlan(data.size);
        let uploadId: string | undefined;
        if (plan.multipart) uploadId = (await s3.send(new CreateMultipartUploadCommand({Bucket:bucket,Key:key,ContentType:data.contentType}))).UploadId;
        try {
          const {rows:[created]} = await c.query(`INSERT INTO files(id,key,owner_id,size,content_type,upload_id,part_size,request_key)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,key,owner,data.size,data.contentType,uploadId,plan.partSize,requestKey]);
          return created;
        } catch(e) {
          if (uploadId) await s3.send(new AbortMultipartUploadCommand({Bucket:bucket,Key:key,UploadId:uploadId}));
          throw e;
        }
      });
      return await this.signed(row,s3,bucket);
    } finally { s3.destroy(); }
  }
  private async signed(row: any, s3: ReturnType<typeof storage>['s3'], bucket: string) {
    const expiresIn = this.ttl();
    const signer=storage(true).s3;
    try {
      if (row.status==='COMPLETED') return {id:row.id,key:row.key,status:row.status};
      if (!row.upload_id) return {id:row.id,key:row.key,status:row.status,expiresIn,url:await getSignedUrl(signer,new PutObjectCommand({Bucket:bucket,Key:row.key,ContentType:row.content_type,ContentLength:Number(row.size)}),{expiresIn})};
      const existing = [];
      let marker: string | undefined;
      do {
        const page = await s3.send(new ListPartsCommand({Bucket:bucket,Key:row.key,UploadId:row.upload_id,PartNumberMarker:marker}));
        existing.push(...(page.Parts || []));
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while(marker);
      const count = Math.ceil(Number(row.size)/Number(row.part_size));
      const parts = [];
      for(let n=1;n<=count;n++) if (!existing.some(p=>p.PartNumber===n)) parts.push({number:n,
        url:await getSignedUrl(signer,new UploadPartCommand({Bucket:bucket,Key:row.key,UploadId:row.upload_id,PartNumber:n}),{expiresIn})});
      return {id:row.id,key:row.key,status:row.status,uploadId:row.upload_id,partSize:Number(row.part_size),expiresIn,parts,existing:existing.map(p=>({number:p.PartNumber,etag:p.ETag}))};
    } finally {signer.destroy();}
  }
  private async owned(owner:string,id:string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException('Invalid file id');
    const {rows:[row]} = await this.db.query('SELECT * FROM files WHERE id=$1 AND owner_id=$2',[id,owner]);
    if (!row) throw new NotFoundException();
    return row;
  }
  async resume(owner:string,id:string) {
    const row = await this.owned(owner,id), {s3,bucket}=storage();
    try { return await this.signed(row,s3,bucket); } finally { s3.destroy(); }
  }
  async commit(owner:string,id:string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException('Invalid file id');
    const {s3,bucket}=storage();
    try {
      return await this.db.transaction(async c => {
        const {rows:[row]}=await c.query('SELECT * FROM files WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,owner]);
        if (!row) throw new NotFoundException();
        const readHead=async()=>{
          try {return await s3.send(new HeadObjectCommand({Bucket:bucket,Key:row.key}));}
          catch(e:any) {if(e.$metadata?.httpStatusCode===404) return undefined;throw e;}
        };
        // Also recovers a crash after S3 Complete succeeded but before the DB commit.
        let head=await readHead();
        if (!head && row.status!=='COMPLETED' && row.upload_id) {
          const parts=[];let marker:string|undefined;
          do {
            const page=await s3.send(new ListPartsCommand({Bucket:bucket,Key:row.key,UploadId:row.upload_id,PartNumberMarker:marker}));
            parts.push(...(page.Parts || []));marker=page.IsTruncated ? page.NextPartNumberMarker : undefined;
          } while(marker);
          const count=Math.ceil(Number(row.size)/Number(row.part_size));
          if(parts.length!==count || parts.some((p,i)=>p.PartNumber!==i+1 || p.Size!==Math.min(Number(row.part_size),Number(row.size)-i*Number(row.part_size)))) throw new ConflictException('Missing or incorrect parts');
          await s3.send(new CompleteMultipartUploadCommand({Bucket:bucket,Key:row.key,UploadId:row.upload_id,MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.PartNumber,ETag:p.ETag}))}}));
          head=await readHead();
        }
        if(!head) throw new ConflictException('Upload bytes first');
        if(head.ContentLength!==Number(row.size) || head.ContentType!==row.content_type) throw new ConflictException('Object size or type mismatch');
        await c.query("UPDATE files SET status='COMPLETED' WHERE id=$1",[id]);
        return {id,key:row.key,status:'COMPLETED',size:head.ContentLength,etag:head.ETag};
      });
    } finally {s3.destroy();}
  }
}
