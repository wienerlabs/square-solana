// Travel Rule (FE-18): formun doğrulaması, kaydın kurulması, commitment'ın SDK ve zincirdeki uygulamayla
// aynılığı (ortak vektörler), fonlama kapısı, yerel kayıtla doğrulama ve `commit_travel_rule` tx'inde
// kişisel veri olmaması. Ağ kullanılmaz: tx'in kurulması için yalnızca blockhash verilir.
import { readFileSync } from 'node:fs';
import { BorshInstructionCoder, type Idl } from '@anchor-lang/core';
import { Connection, Keypair, PublicKey, type Commitment } from '@solana/web3.js';
import { createSquareClient, SQUARE_IDLS, travelRule } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { escrowErrorMessage } from '@/lib/job-wizard';
import { bytesToHex, hexToBytes } from '@/lib/policy-draft';
import {
  buildTravelRuleRecord,
  checkTravelRuleForm,
  createTravelRuleEntry,
  emptyParty,
  emptyTravelRuleForm,
  isValidLei,
  recomputeCommitment,
  travelRuleCommitment,
  travelRuleFundBlock,
  travelRuleRequired,
  travelRuleStatus,
  verifyTravelRule,
  type TravelRuleForm,
} from '@/lib/travel-rule';

const key = () => Keypair.generate().publicKey;
const TODAY = '2026-10-06';
// GLEIF'in kendi LEI'si (ISO 17442 kontrol haneleri geçerli).
const GLEIF_LEI = '506700GE1G29325QX363';

const VECTORS = JSON.parse(
  readFileSync(
    new URL('../../../crates/square-common/tests/fixtures/travel-rule-vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  domain: string;
  vectors: { label: string; job: string; salt: string; record: unknown; commitment: string }[];
};

function filled(): TravelRuleForm {
  return {
    originator: {
      ...emptyParty('legal'),
      name: 'Example Research GmbH',
      geographicAddress: 'Hauptstraße 1, 10115 Berlin',
      country: 'de',
      nationalId: 'HRB 123456',
      vaspName: 'Self-hosted',
    },
    beneficiary: { ...emptyParty('natural'), name: 'Ada Example', vaspName: 'Example Custody', vaspLei: GLEIF_LEI },
  };
}

describe('Travel Rule form', () => {
  it('accepts the IVMS 101 minimum and normalises the codes', () => {
    const checked = checkTravelRuleForm(filled(), TODAY);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.originator.country).toBe('DE');
  });

  it('requires names, the VASP and a way to identify the originator', () => {
    const checked = checkTravelRuleForm(emptyTravelRuleForm(), TODAY);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.errors).toMatchObject({
      'originator.name': 'Required.',
      'beneficiary.name': 'Required.',
      'originator.vaspName': 'Required. For a self-hosted wallet write “Self-hosted”.',
      'originator.identification':
        'Give the originator’s address, a national identifier or the date and place of birth.',
    });
    // Beneficiary için ad, hesap ve VASP yeter (FATF Tavsiye 16).
    expect(checked.errors['beneficiary.identification']).toBeUndefined();
  });

  it('identifies a natural originator by the date and place of birth', () => {
    const form = filled();
    form.originator = {
      ...emptyParty('natural'),
      name: 'Grace Example',
      dateOfBirth: '1980-02-29',
      placeOfBirth: 'Zürich, CH',
      vaspName: 'Self-hosted',
    };
    expect(checkTravelRuleForm(form, TODAY).ok).toBe(true);
  });

  it('rejects malformed and inconsistent values', () => {
    const errorsOf = (patch: Partial<TravelRuleForm['originator']>) => {
      const form = filled();
      form.originator = { ...form.originator, ...patch };
      const checked = checkTravelRuleForm(form, TODAY);
      return checked.ok ? {} : checked.errors;
    };
    expect(errorsOf({ country: 'DEU' })['originator.country']).toBe('Two-letter ISO 3166-1 country code.');
    expect(errorsOf({ country: '' })['originator.country']).toBe('Give the country of the address.');
    expect(errorsOf({ vaspLei: '506700GE1G29325QX364' })['originator.vaspLei']).toMatch(/Not a valid LEI/);
    expect(errorsOf({ name: 'x'.repeat(101) })['originator.name']).toBe('At most 100 characters.');
    expect(errorsOf({ dateOfBirth: '1980-01-01', placeOfBirth: 'Berlin' })['originator.dateOfBirth']).toBe(
      'Only a natural person has a date and place of birth.',
    );
    const natural = { kind: 'natural' as const };
    expect(errorsOf({ ...natural, dateOfBirth: '1980-02-30', placeOfBirth: 'Berlin' })['originator.dateOfBirth']).toBe(
      'Not a real date.',
    );
    expect(errorsOf({ ...natural, dateOfBirth: TODAY, placeOfBirth: 'Berlin' })['originator.dateOfBirth']).toBe(
      'The date of birth must be in the past.',
    );
    expect(errorsOf({ ...natural, dateOfBirth: '1980-01-01' })['originator.placeOfBirth']).toBe(
      'Give the place of birth with the date.',
    );
  });

  it('checks LEI check digits (ISO 7064 MOD 97-10)', () => {
    expect(isValidLei(GLEIF_LEI)).toBe(true);
    expect(isValidLei('506700GE1G29325QX36')).toBe(false);
    expect(isValidLei('506700GE1G29325QX3A3')).toBe(false);
    expect(isValidLei('506700GE1G29325QY363')).toBe(false);
  });
});

describe('record and commitment', () => {
  const institution = key();
  const agentWallet = key();
  const mint = key();
  const job = key();

  const record = () => {
    const checked = checkTravelRuleForm(filled(), TODAY);
    if (!checked.ok) throw new Error('form');
    return buildTravelRuleRecord(checked.value, {
      originatorAccount: institution,
      beneficiaryAccount: agentWallet,
      amount: 1_500_000_000n,
      asset: mint,
    });
  };

  it('takes the accounts, amount and asset from the job and leaves out empty fields', () => {
    expect(record()).toEqual({
      originator: {
        type: 'legal',
        name: 'Example Research GmbH',
        account: institution.toBase58(),
        geographicAddress: { address: 'Hauptstraße 1, 10115 Berlin', country: 'DE' },
        nationalIdentification: 'HRB 123456',
        vasp: { name: 'Self-hosted' },
      },
      beneficiary: {
        type: 'natural',
        name: 'Ada Example',
        account: agentWallet.toBase58(),
        vasp: { name: 'Example Custody', lei: GLEIF_LEI },
      },
      amount: '1500000000',
      asset: mint.toBase58(),
    });
  });

  it('is the SDK commitment and matches the shared vectors of the on-chain implementation', () => {
    expect(VECTORS.domain).toBe('square/travel-rule/v1');
    expect(VECTORS.vectors.length).toBeGreaterThan(0);
    for (const vector of VECTORS.vectors) {
      const jobKey = new PublicKey(vector.job);
      const salt = hexToBytes(vector.salt);
      const commitment = travelRuleCommitment(jobKey, salt, vector.record);
      expect(bytesToHex(commitment), vector.label).toBe(vector.commitment);
      expect(commitment).toEqual(travelRule.commitment({ job: jobKey, salt, record: vector.record }));
    }
  });

  it('draws a fresh salt per entry and binds the commitment to the job', () => {
    const now = 1_790_000_000;
    const a = createTravelRuleEntry({ job, record: record(), now });
    const b = createTravelRuleEntry({ job, record: record(), now });
    expect(a.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(a.salt).not.toBe(b.salt);
    expect(a.commitment).not.toBe(b.commitment);
    expect(a.commitment).toBe(bytesToHex(travelRule.commitment({ job, salt: hexToBytes(a.salt), record: a.record })));
    expect(recomputeCommitment(a)).toBe(a.commitment);
    // Aynı kayıt ve salt başka bir işte başka bir commitment verir.
    const other = createTravelRuleEntry({ job: key(), record: record(), now, salt: hexToBytes(a.salt) });
    expect(other.commitment).not.toBe(a.commitment);
  });

  it('verifies the chain commitment by recomputing it from the record and salt', () => {
    const jobAddress = job.toBase58();
    const old = createTravelRuleEntry({ job, record: record(), now: 1 });
    const current = createTravelRuleEntry({ job, record: record(), now: 2 });
    const chain = hexToBytes(current.commitment);
    expect(verifyTravelRule([old, current], jobAddress, chain)).toEqual({ state: 'match', entry: current });
    expect(verifyTravelRule([], jobAddress, chain)).toEqual({ state: 'noRecord' });
    expect(verifyTravelRule([old], key().toBase58(), chain)).toEqual({ state: 'noRecord' });
    expect(verifyTravelRule([old], jobAddress, new Uint8Array(32))).toEqual({ state: 'notBound' });
    expect(verifyTravelRule([old], jobAddress, chain)).toEqual({ state: 'mismatch', local: old.commitment });
    // Saklanan commitment'a güvenilmez: kayıt değiştirilmişse yeniden hesaplanan tutmaz.
    const edited = { ...current, record: { ...current.record, amount: '1' } };
    expect(verifyTravelRule([edited], jobAddress, chain).state).toBe('mismatch');
  });
});

describe('funding gate', () => {
  const job = key();
  const entry = createTravelRuleEntry({
    job,
    record: {
      originator: { type: 'legal', name: 'A', account: key().toBase58(), vasp: { name: 'Self-hosted' } },
      beneficiary: { type: 'legal', name: 'B', account: key().toBase58(), vasp: { name: 'Self-hosted' } },
      amount: '1000',
      asset: key().toBase58(),
    },
    now: 1,
  });
  const bound = hexToBytes(entry.commitment);
  const none = new Uint8Array(32);

  it('follows the escrow rule: threshold on, amount at or above it', () => {
    expect(travelRuleRequired(1_000n, 1_000n)).toBe(true);
    expect(travelRuleRequired(1_001n, 1_000n)).toBe(true);
    expect(travelRuleRequired(999n, 1_000n)).toBe(false);
    expect(travelRuleRequired(10n ** 15n, 0n)).toBe(false);
  });

  it('blocks funding above the threshold until the bound commitment matches the local record', () => {
    expect(travelRuleFundBlock({ required: true, chainCommitment: none, verification: null })).toMatch(
      /need a Travel Rule commitment before funding/,
    );
    expect(travelRuleFundBlock({ required: true, chainCommitment: bound, verification: null })).toMatch(
      /Unlock the Travel Rule records/,
    );
    const verify = (entries: (typeof entry)[]) => verifyTravelRule(entries, job.toBase58(), bound);
    expect(travelRuleFundBlock({ required: true, chainCommitment: bound, verification: verify([]) })).toMatch(
      /no record in this browser/,
    );
    const other = createTravelRuleEntry({ job, record: entry.record, now: 2 });
    expect(travelRuleFundBlock({ required: true, chainCommitment: bound, verification: verify([other]) })).toMatch(
      /does not match your record/,
    );
    expect(travelRuleFundBlock({ required: true, chainCommitment: bound, verification: verify([entry]) })).toBeNull();
    expect(travelRuleFundBlock({ required: false, chainCommitment: none, verification: null })).toBeNull();
  });

  it('describes the status of a job', () => {
    const status = (s: string, amount: bigint, commitment: Uint8Array, threshold = 1_000n) =>
      travelRuleStatus({ status: s, amount, commitment, threshold });
    expect(status('open', 1_000n, none)).toBe('pending');
    expect(status('open', 999n, none)).toBe('notRequired');
    expect(status('open', 1_000n, none, 0n)).toBe('notRequired');
    expect(status('funded', 1_000n, bound)).toBe('bound');
    expect(status('open', 10n, bound)).toBe('bound');
    expect(status('funded', 1_000n, none)).toBe('missing');
  });

  it('explains the escrow refusal', () => {
    expect(escrowErrorMessage(new Error('custom program error: 0x179f'))).toBe(
      'Travel Rule commitment required above the threshold (TravelRuleCommitmentRequired, 6047). The job stays open: bind the Travel Rule commitment, then fund it.',
    );
  });
});

describe('commit_travel_rule transaction', () => {
  // Yalnızca blockhash: tx kurulur, gönderilmez.
  class BlockhashOnly extends Connection {
    override async getLatestBlockhash(_commitment?: Commitment) {
      return { blockhash: key().toBase58(), lastValidBlockHeight: 1 };
    }
  }
  const escrow = key();
  const client = createSquareClient({
    connection: new BlockhashOnly('http://127.0.0.1:9'),
    commitment: 'confirmed',
    programIds: { registry: key(), policy: key(), verifier: key(), escrow },
  });

  it('carries only the 32-byte commitment, no personal data', async () => {
    const institution = key();
    const job = key();
    const entry = createTravelRuleEntry({
      job,
      record: {
        originator: {
          type: 'natural',
          name: 'Grace Example',
          account: institution.toBase58(),
          dateAndPlaceOfBirth: { date: '1980-02-29', place: 'Zürich, CH' },
          vasp: { name: 'Self-hosted' },
        },
        beneficiary: { type: 'legal', name: 'Example Agent Operator', account: key().toBase58(), vasp: { name: 'X' } },
        amount: '1500000000',
        asset: key().toBase58(),
      },
      now: 1,
    });
    const built = await client.flow.commitTravelRule(
      { institution, job, commitment: hexToBytes(entry.commitment) },
      { feePayer: institution },
    );
    const message = built.transaction.message;
    const escrowIndex = message.staticAccountKeys.findIndex((k) => k.equals(escrow));
    const [ix] = message.compiledInstructions.filter((i) => i.programIdIndex === escrowIndex);
    // 8 baytlık Anchor discriminator ve 32 baytlık commitment; hesaplar yalnızca kurum ve job.
    expect(ix!.data.length).toBe(8 + 32);
    expect(bytesToHex(ix!.data.slice(8))).toBe(entry.commitment);
    expect(ix!.accountKeyIndexes.map((i) => message.staticAccountKeys[i]!.toBase58())).toEqual([
      institution.toBase58(),
      job.toBase58(),
    ]);
    const decoded = new BorshInstructionCoder(SQUARE_IDLS.escrow as unknown as Idl).decode(Buffer.from(ix!.data));
    expect(decoded?.name).toBe('commit_travel_rule');

    // Serileştirilmiş tx'te kaydın hiçbir alanı, salt'ı ya da özeti yok.
    const wire = Buffer.from(built.transaction.serialize());
    for (const secret of ['Grace Example', 'Zürich', '1980-02-29', 'Example Agent Operator', 'Self-hosted']) {
      expect(wire.includes(Buffer.from(secret, 'utf8')), secret).toBe(false);
    }
    expect(wire.includes(Buffer.from(entry.salt, 'hex'))).toBe(false);
    expect(wire.includes(Buffer.from(travelRule.recordDigest(entry.record)))).toBe(false);
  });
});
