import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { selfSignedCertificate, serveOverHttps } from '../src/tls.js';

const dir = mkdtempSync(join(tmpdir(), 'square-services-tls-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function download(url: string, ca?: Buffer): Promise<{ status: number; body: string; type: string | undefined }> {
  return new Promise((resolve, reject) => {
    get(url, ca ? { ca } : {}, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          type: response.headers['content-type'],
        }),
      );
    }).on('error', reject);
  });
}

describe('yerel https sunucusu', () => {
  it('kendinden imzalı sertifikayla yalnızca güvenen istemciye sunar', async () => {
    const certificate = await selfSignedCertificate(dir);
    const server = await serveOverHttps({
      certificate,
      path: '/SDN.XML',
      body: '<sdnList></sdnList>',
      contentType: 'application/xml',
    });
    try {
      expect(server.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/SDN\.XML$/);
      const ca = readFileSync(certificate.certPath);
      expect(await download(server.url, ca)).toEqual({
        status: 200,
        body: '<sdnList></sdnList>',
        type: 'application/xml',
      });
      expect((await download(server.url.replace('/SDN.XML', '/baska'), ca)).status).toBe(404);
      await expect(download(server.url)).rejects.toThrow(/self[- ]signed/i);
      expect(server.requests()).toBe(1);
    } finally {
      await server.close();
    }
  });
});
