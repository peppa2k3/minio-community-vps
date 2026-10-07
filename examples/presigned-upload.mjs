// npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
// Import these helpers into an existing Express app; use its real authentication and DB.
import { createHash, randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const required = ['S3_PUBLIC_ENDPOINT', 'S3_INTERNAL_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

const credentials = {
  accessKeyId: process.env.S3_ACCESS_KEY,
  secretAccessKey: process.env.S3_SECRET_KEY,
};
const common = { region: process.env.S3_REGION || 'us-east-1', credentials, forcePathStyle: true };
const publicSigner = new S3Client({ ...common, endpoint: process.env.S3_PUBLIC_ENDPOINT });
const internalClient = new S3Client({ ...common, endpoint: process.env.S3_INTERNAL_ENDPOINT });
const Bucket = process.env.S3_BUCKET;
const maxBytes = 20 * 1024 * 1024;
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

export async function createUploadUrl({ userId, contentType, declaredSize }) {
  if (!userId) throw new Error('Unauthenticated');
  if (!allowedTypes.has(contentType)) throw new Error('Unsupported content type');
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maxBytes) {
    throw new Error('Invalid file size');
  }

  const owner = createHash('sha256').update(String(userId)).digest('hex');
  const key = `users/${owner}/${randomUUID()}`;
  const uploadUrl = await getSignedUrl(
    publicSigner,
    new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }),
    { expiresIn: 300 },
  );
  // Persist pending upload {owner, key, declaredSize, contentType, expiry} in your DB.
  return { uploadUrl, key, expiresIn: 300, method: 'PUT', headers: { 'Content-Type': contentType } };
}

export async function verifyUpload({ userId, key, expectedContentType }) {
  if (!userId) throw new Error('Unauthenticated');
  const owner = createHash('sha256').update(String(userId)).digest('hex');
  if (typeof key !== 'string' || !key.startsWith(`users/${owner}/`)) throw new Error('Forbidden');
  // First check this key is a still-pending upload owned by this user in your DB.
  const head = await internalClient.send(new HeadObjectCommand({ Bucket, Key: key }));
  const size = head.ContentLength;
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes || head.ContentType !== expectedContentType) {
    await internalClient.send(new DeleteObjectCommand({ Bucket, Key: key }));
    throw new Error('Uploaded object failed validation');
  }
  // Atomically mark the pending row complete; save key, MIME, size; never save a signed URL.
  // File bytes must be independently inspected/scanned for sensitive use cases.
  return { key, size, contentType: head.ContentType };
}

export async function createDownloadUrl({ key }) {
  // Check the caller's permission against your DB record BEFORE calling this helper.
  return getSignedUrl(publicSigner, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: 300 });
}
