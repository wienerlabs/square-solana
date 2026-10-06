// `multipart/form-data` gövdesinden tek dosya (`file` alanı), boyut sınırıyla akış halinde okunur: sınırı aşan
// gövde belleğe alınmadan reddedilir. Başka alan ya da ikinci dosya geçersizdir.
import busboy from 'busboy';
import type { Request } from 'express';
import { badRequest } from './http.js';

export interface UploadedFile {
  readonly content: Buffer;
  /** İstemcinin bildirdiği içerik tipi. */
  readonly mimeType: string;
}

export function readUpload(req: Request, maxBytes: number): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 0 } });
    } catch {
      reject(badRequest('gövde multipart/form-data olmalı'));
      return;
    }
    let file: UploadedFile | null = null;
    let failure: Error | null = null;
    const fail = (error: Error) => {
      failure ??= error;
    };
    parser.on('file', (name, stream, info) => {
      if (name !== 'file') {
        fail(badRequest(`beklenmeyen dosya alanı: ${name}`));
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => fail(badRequest(`dosya ${maxBytes} bayt sınırını aşıyor`)));
      stream.on('close', () => {
        if (!failure) file = { content: Buffer.concat(chunks), mimeType: info.mimeType };
      });
    });
    parser.on('field', (name) => fail(badRequest(`beklenmeyen alan: ${name}`)));
    for (const event of ['filesLimit', 'fieldsLimit'] as const) {
      parser.on(event, () => fail(badRequest('gövde yalnızca tek bir file alanı içermeli')));
    }
    parser.on('error', (error: Error) => reject(badRequest(`multipart gövdesi okunamadı: ${error.message}`)));
    parser.on('close', () => {
      if (failure) reject(failure);
      else if (!file) reject(badRequest('multipart gövdesinde file alanı gerekli'));
      else resolve(file);
    });
    req.pipe(parser);
  });
}
