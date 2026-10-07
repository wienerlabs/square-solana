import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait } from 'testcontainers';
import type { ObjectStore } from './env.js';
import { sleep } from './wait.js';

export const SEAWEEDFS_IMAGE = 'chrislusf/seaweedfs:4.48';
const S3_PORT = 8333;
const DELIVERY_BUCKET = 'deliveries';
const EVIDENCE_BUCKET = 'evidence';
const BUCKET_ATTEMPTS = 60;

export interface StartedObjectStore extends ObjectStore {
  stop(): Promise<void>;
}

export async function startObjectStore(): Promise<StartedObjectStore> {
  const accessKeyId = `services${randomBytes(6).toString('hex')}`;
  const secretAccessKey = randomBytes(24).toString('base64url');
  const identities = {
    identities: [
      {
        name: 'api',
        credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
        actions: ['Admin', 'Read', 'Write', 'List'],
      },
      { name: 'anonymous', actions: [`Read:${DELIVERY_BUCKET}`] },
    ],
  };
  const container = await new GenericContainer(SEAWEEDFS_IMAGE)
    .withCopyContentToContainer([{ content: JSON.stringify(identities), target: '/etc/seaweedfs/s3.json' }])
    .withCommand(['server', '-s3', '-s3.config=/etc/seaweedfs/s3.json', '-dir=/data', '-master.volumeSizeLimitMB=64'])
    .withExposedPorts(S3_PORT)
    .withWaitStrategy(Wait.forHttp('/', S3_PORT).forStatusCodeMatching(() => true))
    .withStartupTimeout(180_000)
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(S3_PORT)}`;
  const region = 'us-east-1';
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    for (const bucket of [DELIVERY_BUCKET, EVIDENCE_BUCKET]) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: bucket }));
          break;
        } catch (error) {
          if (attempt >= BUCKET_ATTEMPTS) throw error;
          await sleep(1_000);
        }
      }
    }
  } catch (error) {
    await container.stop();
    throw error;
  } finally {
    client.destroy();
  }
  return {
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    deliveryBucket: DELIVERY_BUCKET,
    evidenceBucket: EVIDENCE_BUCKET,
    stop: async () => {
      await container.stop();
    },
  };
}
