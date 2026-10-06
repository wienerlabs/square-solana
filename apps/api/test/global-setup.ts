// Test fixture: test dosyalarının paylaştığı konteynerler. Postgres (migration'lar uygulanmış, db/testing) ve
// S3 uyumlu nesne deposu SeaweedFS (Apache-2.0). Depoda API'nin anahtarıyla yazan bir kimlik ve teslimat
// kovasını herkese açık okuyan anonim kimlik vardır (üretimdeki kova ayarı). Dosyalar sırayla koşar
// (vitest.config: fileParallelism false) ve her dosya veritabanını boşaltarak başlar.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startIsolatedDatabase } from '@squaresdk/solana-db/testing';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

/** SeaweedFS sürümü sabit; S3 uç noktası 8333. */
const SEAWEEDFS_IMAGE = 'chrislusf/seaweedfs:4.48';
const S3_PORT = 8333;
export const DELIVERY_BUCKET = 'deliveries';
/** Dispute kanıtları: anonim okuma yok. */
export const EVIDENCE_BUCKET = 'evidence';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    s3: { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string; evidenceBucket: string };
    /** Paketin `build` adımıyla aynı derleme: sözleşmenin tek dosyalık JSON'u. */
    openapiPath: string;
  }
}

export default async function setup(project: TestProject) {
  const accessKeyId = `test${randomBytes(6).toString('hex')}`;
  const secretAccessKey = randomBytes(24).toString('base64url');
  const s3Config = {
    identities: [
      {
        name: 'api',
        credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
        actions: ['Admin', 'Read', 'Write', 'List'],
      },
      { name: 'anonymous', actions: [`Read:${DELIVERY_BUCKET}`] },
    ],
  };
  const [database, seaweed] = await Promise.all([
    startIsolatedDatabase(),
    new GenericContainer(SEAWEEDFS_IMAGE)
      .withCopyContentToContainer([{ content: JSON.stringify(s3Config), target: '/etc/seaweedfs/s3.json' }])
      .withCommand(['server', '-s3', '-s3.config=/etc/seaweedfs/s3.json', '-dir=/data', '-master.volumeSizeLimitMB=64'])
      .withExposedPorts(S3_PORT)
      .withWaitStrategy(Wait.forHttp('/', S3_PORT).forStatusCodeMatching(() => true))
      .withStartupTimeout(120_000)
      .start(),
  ]);
  const endpoint = `http://${seaweed.getHost()}:${seaweed.getMappedPort(S3_PORT)}`;
  const s3 = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  // Filer ve volume sunucusu hazır olana kadar kova oluşturma tekrar denenir.
  for (const bucket of [DELIVERY_BUCKET, EVIDENCE_BUCKET]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
  const openapiPath = join(mkdtempSync(join(tmpdir(), 'square-api-openapi-')), 'openapi.json');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  execFileSync(
    join(root, 'node_modules/.bin/redocly'),
    ['bundle', 'docs/api/openapi.yaml', '--ext', 'json', '-o', openapiPath],
    {
      cwd: root,
      stdio: 'ignore',
    },
  );
  project.provide('openapiPath', openapiPath);
  project.provide('databaseUrl', database.url);
  project.provide('s3', {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket: DELIVERY_BUCKET,
    evidenceBucket: EVIDENCE_BUCKET,
  });
  return async () => {
    await database.stop();
    await seaweed.stop();
  };
}
