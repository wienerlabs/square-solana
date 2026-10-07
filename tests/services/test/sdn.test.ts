import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/options.js';
import { sdnXml } from '../src/sdn.js';

interface SdnList {
  publishDate: string;
  entries: number;
  addresses: ReadonlyMap<string, readonly { uid: string; name: string }[]>;
  invalid: readonly string[];
}

async function screenerParser(): Promise<(xml: string) => SdnList> {
  const module = (await import(pathToFileURL(join(REPO_ROOT, 'apps/screener/dist/sources/ofac.js')).href)) as {
    parseSdnXml: (xml: string) => SdnList;
  };
  return module.parseSdnXml;
}

describe('sentetik SDN listesi', () => {
  it("screener'ın OFAC okuyucusu listeyi kabul eder ve adresi işaretler", async () => {
    const flagged = Keypair.generate().publicKey.toBase58();
    const other = Keypair.generate().publicKey.toBase58();
    const xml = sdnXml(
      [
        { uid: 990_001, name: 'Square & Ortakları <test>', solanaAddress: flagged },
        { uid: 990_011, name: 'İkinci kayıt', solanaAddress: other },
      ],
      new Date(Date.UTC(2026, 9, 7)),
    );
    const list = (await screenerParser())(xml);
    expect(list.publishDate).toBe('10/07/2026');
    expect(list.entries).toBe(2);
    expect(list.invalid).toEqual([]);
    expect(list.addresses.get(flagged)).toEqual([{ uid: '990001', name: 'Square & Ortakları <test>' }]);
    expect(list.addresses.get(other)).toEqual([{ uid: '990011', name: 'İkinci kayıt' }]);
  });

  it('boş liste üretilmez', () => {
    expect(() => sdnXml([], new Date())).toThrow('en az bir kayıt');
  });
});
