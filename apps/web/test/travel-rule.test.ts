import { readFileSync } from 'node:fs';
import { BorshInstructionCoder, type Idl } from '@anchor-lang/core';
import { Connection, Keypair, PublicKey, type Commitment } from '@solana/web3.js';
import { createSquareClient, SQUARE_IDLS, travelRule } from '@squaresdk/solana-sdk';
import { TravelRuleRecordSchema, type TravelRuleDisclosure, type TravelRuleRecord } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { escrowErrorMessage } from '@/lib/job-wizard';
import { bytesToHex, hexToBytes } from '@/lib/policy-draft';
import {
  checkTravelRuleForm,
  emptyPerson,
  emptyTravelRuleForm,
  isValidLei,
  travelRuleCommitment,
  travelRuleFundBlock,
  travelRuleRequired,
  travelRuleStatus,
  verifyDisclosure,
  type PersonForm,
  type TravelRuleForm,
} from '@/lib/travel-rule';

const key = () => Keypair.generate().publicKey;
const TODAY = '2026-10-06';
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

const institution = key();
const agentWallet = key();
const mint = key();
const context = { originatorAccount: institution, beneficiaryAccount: agentWallet, amount: 1_500_000_000n, mint };

function filled(): TravelRuleForm {
  return {
    originator: {
      ...emptyPerson('legal'),
      primaryIdentifier: 'Example Research GmbH',
      street: 'Hauptstraße 1',
      city: 'Berlin',
      postcode: '10115',
      country: 'de',
      idType: 'RAID',
      idValue: 'HRB 123456',
      idCountry: 'de',
    },
    beneficiary: { ...emptyPerson('natural'), primaryIdentifier: 'Example', secondaryIdentifier: 'Ada' },
    originatingVasp: { name: '', lei: '' },
    beneficiaryVasp: { name: 'Example Custody', lei: GLEIF_LEI },
  };
}

const errorsOf = (form: TravelRuleForm) => {
  const checked = checkTravelRuleForm(form, context, TODAY);
  return checked.ok ? {} : checked.errors;
};

const withOriginator = (patch: Partial<PersonForm>): TravelRuleForm => {
  const form = filled();
  form.originator = { ...form.originator, ...patch };
  return form;
};

describe('Travel Rule form', () => {
  it('builds the shared BE-23 record: accounts, amount and mint from the job, empty fields null', () => {
    const checked = checkTravelRuleForm(filled(), context, TODAY);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const expected: TravelRuleRecord = {
      originator: {
        kind: 'legal',
        primaryIdentifier: 'Example Research GmbH',
        secondaryIdentifier: null,
        accountNumber: institution.toBase58(),
        address: { street: 'Hauptstraße 1', city: 'Berlin', postcode: '10115', country: 'DE' },
        nationalIdentification: { type: 'RAID', value: 'HRB 123456', country: 'DE' },
        dateOfBirth: null,
        placeOfBirth: null,
        countryOfResidence: null,
      },
      beneficiary: {
        kind: 'natural',
        primaryIdentifier: 'Example',
        secondaryIdentifier: 'Ada',
        accountNumber: agentWallet.toBase58(),
        address: null,
        nationalIdentification: null,
        dateOfBirth: null,
        placeOfBirth: null,
        countryOfResidence: null,
      },
      originatingVasp: null,
      beneficiaryVasp: { name: 'Example Custody', lei: GLEIF_LEI },
      amount: '1500000000',
      mint: mint.toBase58(),
    };
    expect(checked.record).toEqual(expected);
    expect(TravelRuleRecordSchema.parse(checked.record)).toEqual(expected);
  });

  it('requires a name and a way to identify the originator', () => {
    const errors = errorsOf(emptyTravelRuleForm());
    expect(errors).toMatchObject({
      'originator.primaryIdentifier': 'Give the legal name.',
      'beneficiary.primaryIdentifier': 'Give the legal name.',
      'originator.identification':
        'Give the originator’s address, a national identifier or the date and place of birth.',
    });
    expect(errors['beneficiary.identification']).toBeUndefined();
  });

  it('identifies a natural originator by the date and place of birth', () => {
    const form = filled();
    form.originator = {
      ...emptyPerson('natural'),
      primaryIdentifier: 'Example',
      secondaryIdentifier: 'Grace',
      dateOfBirth: '1980-02-29',
      placeOfBirth: 'Zürich, CH',
    };
    const checked = checkTravelRuleForm(form, context, TODAY);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.record.originator).toMatchObject({ dateOfBirth: '1980-02-29', address: null });
  });

  it('rejects malformed and inconsistent values', () => {
    expect(errorsOf(withOriginator({ country: 'DEU' }))['originator.country']).toBe(
      'Two-letter ISO 3166-1 country code.',
    );
    expect(errorsOf(withOriginator({ city: '' }))['originator.city']).toBe('Give the city of the address.');
    expect(errorsOf(withOriginator({ idType: 'LEIX', idValue: '506700GE1G29325QX364', idCountry: '' }))).toMatchObject({
      'originator.idValue': expect.stringMatching(/Not a valid LEI/),
    });
    expect(errorsOf(withOriginator({ idType: 'LEIX', idValue: GLEIF_LEI, idCountry: 'DE' }))).toMatchObject({
      'originator.idCountry': 'An LEI has no issuing country.',
    });
    expect(errorsOf(withOriginator({ idType: '', idValue: 'x' }))['originator.idType']).toBe(
      'Choose the identifier type.',
    );
    expect(errorsOf(withOriginator({ primaryIdentifier: 'x'.repeat(101) }))['originator.primaryIdentifier']).toMatch(
      /100/,
    );
    const natural = { kind: 'natural' as const, secondaryIdentifier: 'Grace' };
    expect(
      errorsOf(withOriginator({ ...natural, dateOfBirth: '1980-02-30', placeOfBirth: 'Berlin' }))[
        'originator.dateOfBirth'
      ],
    ).toBe('Not a real date.');
    expect(
      errorsOf(withOriginator({ ...natural, dateOfBirth: TODAY, placeOfBirth: 'Berlin' }))['originator.dateOfBirth'],
    ).toBe('The date of birth must be in the past.');
    expect(errorsOf(withOriginator({ ...natural, dateOfBirth: '1980-01-01' }))['originator.placeOfBirth']).toBe(
      'Give the place of birth with the date.',
    );
    const vasp = filled();
    vasp.originatingVasp = { name: '', lei: GLEIF_LEI };
    expect(errorsOf(vasp)['originatingVasp.name']).toBe('Give the name of the VASP with its LEI.');
  });

  it('checks LEI check digits (ISO 7064 MOD 97-10)', () => {
    expect(isValidLei(GLEIF_LEI)).toBe(true);
    expect(isValidLei('506700GE1G29325QX36')).toBe(false);
    expect(isValidLei('506700GE1G29325QX3A3')).toBe(false);
    expect(isValidLei('506700GE1G29325QY363')).toBe(false);
  });
});

describe('commitment and verification', () => {
  const job = key();

  const record = (): TravelRuleRecord => {
    const checked = checkTravelRuleForm(filled(), context, TODAY);
    if (!checked.ok) throw new Error('form');
    return checked.record;
  };

  const disclosure = (salt: Uint8Array, value: TravelRuleRecord = record()): TravelRuleDisclosure => ({
    status: {
      job: job.toBase58(),
      commitment: bytesToHex(travelRuleCommitment(job, salt, value)),
      recordDigest: bytesToHex(travelRule.recordDigest(value)),
      storedBy: institution.toBase58(),
      storedAt: 1_790_000_000,
      retainUntil: 1_950_000_000,
      purgedAt: null,
      chainCommitment: null,
      committed: false,
    },
    record: value,
    salt: bytesToHex(salt),
  });

  it('is the SDK commitment and matches the shared vectors of the on-chain implementation', () => {
    expect(VECTORS.domain).toBe('square/travel-rule/v1');
    expect(VECTORS.vectors.length).toBeGreaterThan(0);
    for (const vector of VECTORS.vectors) {
      const jobKey = new PublicKey(vector.job);
      const salt = hexToBytes(vector.salt);
      expect(bytesToHex(travelRuleCommitment(jobKey, salt, vector.record)), vector.label).toBe(vector.commitment);
    }
  });

  it('recomputes the chain commitment from the record and salt the API discloses', () => {
    const salt = travelRule.generateSalt();
    const opened = disclosure(salt);
    const chain = hexToBytes(opened.status.commitment);
    expect(verifyDisclosure(job, opened, chain)).toEqual({
      state: 'match',
      storedAt: 1_790_000_000,
      retainUntil: 1_950_000_000,
    });
    const other = disclosure(travelRule.generateSalt());
    expect(verifyDisclosure(job, other, chain)).toEqual({ state: 'mismatch', recomputed: other.status.commitment });
    const edited = { ...opened, record: { ...opened.record, amount: '1' } };
    expect(verifyDisclosure(job, edited, chain).state).toBe('mismatch');
    expect(verifyDisclosure(key(), opened, chain).state).toBe('mismatch');
  });
});

describe('funding gate', () => {
  const bound = new Uint8Array(32).fill(7);
  const none = new Uint8Array(32);

  it('follows the escrow rule: threshold on, amount at or above it', () => {
    expect(travelRuleRequired(1_000n, 1_000n)).toBe(true);
    expect(travelRuleRequired(1_001n, 1_000n)).toBe(true);
    expect(travelRuleRequired(999n, 1_000n)).toBe(false);
    expect(travelRuleRequired(10n ** 15n, 0n)).toBe(false);
  });

  it('blocks funding above the threshold until the bound commitment is checked against the stored record', () => {
    const gate = (
      chainCommitment: Uint8Array,
      verification: Parameters<typeof travelRuleFundBlock>[0]['verification'],
    ) => travelRuleFundBlock({ required: true, chainCommitment, verification });
    expect(gate(none, null)).toMatch(/need a Travel Rule commitment before funding/);
    expect(gate(bound, null)).toMatch(/Check the bound Travel Rule commitment/);
    expect(gate(bound, { state: 'missing', reason: 'The Square API has no Travel Rule record for this job.' })).toMatch(
      /no Travel Rule record for this job\. Store the record/,
    );
    expect(gate(bound, { state: 'mismatch', recomputed: 'ab'.repeat(32) })).toMatch(/does not match the record/);
    expect(gate(bound, { state: 'match', storedAt: 1, retainUntil: 2 })).toBeNull();
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
    const job = key();
    const form = filled();
    form.originator = {
      ...emptyPerson('natural'),
      primaryIdentifier: 'Example',
      secondaryIdentifier: 'Grace',
      dateOfBirth: '1980-02-29',
      placeOfBirth: 'Zürich, CH',
    };
    const checked = checkTravelRuleForm(form, context, TODAY);
    if (!checked.ok) throw new Error('form');
    const salt = travelRule.generateSalt();
    const commitment = travelRuleCommitment(job, salt, checked.record);
    const built = await client.flow.commitTravelRule({ institution, job, commitment }, { feePayer: institution });
    const message = built.transaction.message;
    const escrowIndex = message.staticAccountKeys.findIndex((k) => k.equals(escrow));
    const [ix] = message.compiledInstructions.filter((i) => i.programIdIndex === escrowIndex);
    expect(ix!.data.length).toBe(8 + 32);
    expect(bytesToHex(ix!.data.slice(8))).toBe(bytesToHex(commitment));
    expect(ix!.accountKeyIndexes.map((i) => message.staticAccountKeys[i]!.toBase58())).toEqual([
      institution.toBase58(),
      job.toBase58(),
    ]);
    const decoded = new BorshInstructionCoder(SQUARE_IDLS.escrow as unknown as Idl).decode(Buffer.from(ix!.data));
    expect(decoded?.name).toBe('commit_travel_rule');
    const wire = Buffer.from(built.transaction.serialize());
    for (const secret of ['Example', 'Grace', 'Zürich', '1980-02-29', 'Example Custody']) {
      expect(wire.includes(Buffer.from(secret, 'utf8')), secret).toBe(false);
    }
    expect(wire.includes(Buffer.from(salt))).toBe(false);
    expect(wire.includes(Buffer.from(travelRule.recordDigest(checked.record)))).toBe(false);
  });
});
