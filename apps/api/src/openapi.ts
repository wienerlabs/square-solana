// Yayımlanan OpenAPI belgesi (`GET /openapi.json`): sözleşmenin (docs/api/openapi.yaml) tek dosyaya
// derlenmiş hali; IDL şemaları (`schemas/idl.json`) içine alınmıştır. Derleme paketin `build` adımıdır
// (`redocly bundle`, dist/openapi.json). Sunucu adresi spec'te sabitlenmez (redocly.yaml); yayımlanan belgeye
// yapılandırmadaki dış adres yazılır.
import { readFileSync } from 'node:fs';

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly version: string };
  readonly paths: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export function loadOpenApi(path: URL | string, publicBaseUrl: string): OpenApiDocument {
  const document = JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument;
  if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.1')) {
    throw new Error(`OpenAPI belgesi 3.1 değil: ${String(path)}`);
  }
  const serialized = JSON.stringify(document);
  if (/"\$ref":"(?!#)/.test(serialized)) throw new Error('OpenAPI belgesinde çözülmemiş dış $ref var (redocly bundle)');
  return Object.freeze({ ...document, servers: [{ url: publicBaseUrl }] });
}
