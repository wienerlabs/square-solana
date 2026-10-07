import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Certificate {
  readonly certPath: string;
  readonly keyPath: string;
}

export async function selfSignedCertificate(dir: string, host = '127.0.0.1'): Promise<Certificate> {
  const certPath = join(dir, 'tls-cert.pem');
  const keyPath = join(dir, 'tls-key.pem');
  try {
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${host}`,
      '-addext',
      `subjectAltName=IP:${host}`,
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ]);
  } catch (error) {
    throw new Error(`openssl ile sertifika üretilemedi (openssl PATH'te olmalı): ${(error as Error).message}`, {
      cause: error,
    });
  }
  return { certPath, keyPath };
}

export interface StaticHttpsServer {
  readonly url: string;
  readonly requests: () => number;
  close(): Promise<void>;
}

export function serveOverHttps(params: {
  certificate: Certificate;
  path: string;
  body: string;
  contentType: string;
}): Promise<StaticHttpsServer> {
  let served = 0;
  const server = createServer(
    { cert: readFileSync(params.certificate.certPath), key: readFileSync(params.certificate.keyPath) },
    (request, response) => {
      if (request.url !== params.path) {
        response.writeHead(404).end();
        return;
      }
      served += 1;
      response.writeHead(200, { 'content-type': params.contentType }).end(params.body);
    },
  );
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `https://127.0.0.1:${port}${params.path}`,
        requests: () => served,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
