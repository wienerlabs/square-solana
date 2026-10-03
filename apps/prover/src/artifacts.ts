// Release devresinin artefaktları: wasm (witness hesaplayıcı) ve zkey (ispat anahtarı). İkisinin de
// SHA-256'sı BC-20 manifest'iyle (`circuits/payment-compliance/artifacts/manifest.json`)
// karşılaştırılır; uymazsa servis açılmaz. Artefakt sürümü zkey'in SHA-256'sıdır.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { zKey, type VerificationKey } from 'snarkjs';
import { z } from 'zod';
import type { ArtifactPaths } from './config.js';
import { errorMessage } from './errors.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const ManifestSchema = z.object({
  circuit: z.string().min(1),
  wasm: z.object({ sha256: Sha256 }),
  zkey: z.object({ sha256: Sha256 }),
});

export interface Artifacts {
  readonly circuit: string;
  readonly wasm: Uint8Array;
  readonly zkey: Uint8Array;
  readonly verificationKey: VerificationKey;
  /** zkey'in SHA-256'sı (hex); istekteki `artifactVersion` bununla eşleşmeli. */
  readonly version: string;
}

export class ArtifactError extends Error {
  override readonly name = 'ArtifactError';
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function read(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    throw new ArtifactError(`${what} okunamadı (${path}): ${errorMessage(error)}`);
  }
}

export async function loadArtifacts(paths: ArtifactPaths): Promise<Artifacts> {
  const manifestBytes = await read(paths.manifestPath, 'manifest');
  let manifest: z.infer<typeof ManifestSchema>;
  try {
    manifest = ManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  } catch (error) {
    throw new ArtifactError(`manifest geçersiz (${paths.manifestPath}): ${errorMessage(error)}`);
  }
  const [wasm, zkey] = await Promise.all([read(paths.wasmPath, 'wasm'), read(paths.zkeyPath, 'zkey')]);
  const wasmHash = sha256Hex(wasm);
  if (wasmHash !== manifest.wasm.sha256) {
    throw new ArtifactError(`wasm manifest'le uyuşmuyor: ${wasmHash} ≠ ${manifest.wasm.sha256}`);
  }
  const version = sha256Hex(zkey);
  if (version !== manifest.zkey.sha256) {
    throw new ArtifactError(`zkey manifest'le uyuşmuyor: ${version} ≠ ${manifest.zkey.sha256}`);
  }
  const verificationKey = await zKey.exportVerificationKey({ type: 'mem', data: zkey });
  return Object.freeze({ circuit: manifest.circuit, wasm, zkey, verificationKey, version });
}
