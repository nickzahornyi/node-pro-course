import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
export const MiB = 1024 * 1024;
export const immutable = 'public, max-age=31536000, immutable';
export function storage(presign = false) {
  const { STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY, STORAGE_BUCKET, STORAGE_ENDPOINT } = process.env;
  if (!STORAGE_ACCESS_KEY || !STORAGE_SECRET_KEY || !STORAGE_BUCKET) throw new Error('Storage credentials and bucket are required');
  return { bucket: STORAGE_BUCKET, s3: new S3Client({region: process.env.STORAGE_REGION || 'us-east-1',
    endpoint: (presign ? process.env.STORAGE_PUBLIC_ENDPOINT || STORAGE_ENDPOINT : STORAGE_ENDPOINT) || undefined, forcePathStyle: Boolean(STORAGE_ENDPOINT),
    credentials: {accessKeyId: STORAGE_ACCESS_KEY, secretAccessKey: STORAGE_SECRET_KEY},
    requestChecksumCalculation: 'WHEN_REQUIRED'}) };
}
export function uploadPlan(size: number) {
  // Three minimum-sized parts justify multipart: below this the coordination costs more.
  const threshold = 3 * 5 * MiB;
  const partSize = Math.max(5 * MiB, Math.ceil(size / 10000 / MiB) * MiB);
  return {multipart: size >= threshold, partSize, count: Math.ceil(size / partSize)};
}
export async function publishAsset(body: Buffer, namespace = 'assets') {
  const {s3,bucket} = storage();
  const key = `${namespace}/app.${createHash('sha256').update(body).digest('hex')}.css`;
  try { await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentType:'text/css',CacheControl:immutable})); }
  finally { s3.destroy(); }
  return key;
}
