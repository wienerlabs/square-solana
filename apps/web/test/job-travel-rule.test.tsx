// @vitest-environment jsdom
import { requests } from './helpers/record-requests';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { useState } from 'react';
import { Connection, Keypair, type PublicKey } from '@solana/web3.js';
import { createApiClient, createSquareClient, travelRule } from '@squaresdk/solana-sdk';
import type { TravelRuleDisclosure, TravelRuleRecord } from '@squaresdk/solana-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClientState } from '@/components/api-client';
import { JobTravelRule, type TravelRuleJob } from '@/components/jobs/job-travel-rule';
import { Providers } from '@/components/providers';
import type { EscrowSetup } from '@/lib/job-wizard';
import { bytesToHex } from '@/lib/policy-draft';
import { apiErrorText } from '@/lib/square-api';
import type { TravelRuleVerification } from '@/lib/travel-rule';

const RPC = 'http://127.0.0.1:9';
const API = 'https://api.square.test';
const key = () => Keypair.generate().publicKey;
const escrow = key();
const institution = key();
const jobKey = key();
const CONFIG = { cluster: 'devnet', rpcUrl: RPC, programIds: { escrow: escrow.toBase58() }, apiUrl: API } as const;

const setup: EscrowSetup = {
  client: createSquareClient({
    connection: new Connection(RPC),
    commitment: 'confirmed',
    programIds: { registry: key(), policy: key(), verifier: key(), escrow },
  }),
  registryProgram: key(),
  policyProgram: key(),
  minChallengePeriod: 60n,
  maxChallengePeriod: 604_800n,
  travelRuleThreshold: 1_000_000_000n,
  keeperFeeBps: 50,
};

const openJob = (commitment = new Uint8Array(32)): TravelRuleJob => ({
  status: 'open',
  amount: 1_500_000_000n,
  mint: key(),
  agentWallet: key(),
  commitment,
});

const recordOf = (job: TravelRuleJob): TravelRuleRecord => ({
  originator: {
    kind: 'legal',
    primaryIdentifier: 'Grace Research GmbH',
    secondaryIdentifier: null,
    accountNumber: institution.toBase58(),
    address: { street: null, city: 'Berlin', postcode: null, country: 'DE' },
    nationalIdentification: null,
    dateOfBirth: null,
    placeOfBirth: null,
    countryOfResidence: null,
  },
  beneficiary: {
    kind: 'legal',
    primaryIdentifier: 'Agent Operator Ltd',
    secondaryIdentifier: null,
    accountNumber: job.agentWallet.toBase58(),
    address: null,
    nationalIdentification: null,
    dateOfBirth: null,
    placeOfBirth: null,
    countryOfResidence: null,
  },
  originatingVasp: null,
  beneficiaryVasp: null,
  amount: job.amount.toString(),
  mint: job.mint.toBase58(),
});

function disclosureOf(job: TravelRuleJob, salt: Uint8Array): TravelRuleDisclosure {
  const record = recordOf(job);
  return {
    status: {
      job: jobKey.toBase58(),
      commitment: bytesToHex(travelRule.commitment({ job: jobKey, salt, record })),
      recordDigest: bytesToHex(travelRule.recordDigest(record)),
      storedBy: institution.toBase58(),
      storedAt: 1_790_000_000,
      retainUntil: 1_950_000_000,
      purgedAt: null,
      chainCommitment: null,
      committed: true,
    },
    record,
    salt: bytesToHex(salt),
  };
}

const meta = { requestId: 'test', page: null, limit: null, total: null };

function client(answer: () => Response): ApiClientState {
  const api = createApiClient({
    baseUrl: API,
    auth: { session: 'sqs_test' },
    fetch: async () => answer(),
  });
  return {
    configured: true,
    publicApi: null,
    api,
    session: { token: 'sqs_test', wallet: institution.toBase58(), expiresAt: 1_950_000_000 },
    canSignIn: true,
    unavailable: null,
    signingIn: false,
    error: null,
    signIn: async () => undefined,
    signOut: async () => undefined,
    report: (error) => apiErrorText(error),
  };
}

const disclosed = (value: TravelRuleDisclosure) => () =>
  Response.json({ success: true, data: value, error: null, meta });
const notFound = () =>
  Response.json(
    {
      success: false,
      data: null,
      error: { code: 'not_found', message: 'job’un Travel Rule kaydı yok', programError: null, details: null },
      meta,
    },
    { status: 404 },
  );

function Section({ job, viewer, api }: { job: TravelRuleJob; viewer: PublicKey | null; api: ApiClientState }) {
  const [verification, setVerification] = useState<TravelRuleVerification | null>(null);
  return (
    <JobTravelRule
      setup={setup}
      jobAddress={jobKey.toBase58()}
      job={job}
      institution={viewer}
      api={api}
      verification={verification}
      onVerification={setVerification}
      formatAmount={(base) => `${base} base units`}
    />
  );
}

const mount = (job: TravelRuleJob, viewer: PublicKey | null, api: ApiClientState) =>
  render(
    <Providers config={CONFIG}>
      <main>
        <Section job={job} viewer={viewer} api={api} />
      </main>
    </Providers>,
  );

const axeViolations = async (container: HTMLElement) =>
  (
    await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
  ).violations.map((v) => `${v.id}: ${v.help}`);

beforeEach(() => {
  requests.length = 0;
});
afterEach(cleanup);

describe('Travel Rule section', () => {
  it('shows only the status to someone other than the institution', () => {
    mount(openJob(), null, client(notFound));
    expect(screen.getByText('Waiting for the commitment')).toBeTruthy();
    expect(screen.getByText(/cannot be funded until the institution binds the commitment/)).toBeTruthy();
    expect(screen.queryByLabelText('Legal name')).toBeNull();
    expect(screen.queryByRole('button', { name: /Store/ })).toBeNull();
  });

  it('needs the Square API: without it the record is neither stored nor checked', () => {
    mount(openJob(), institution, { ...client(notFound), configured: false, api: null, session: null });
    expect(screen.getByText(/stored encrypted by the Square API, and SQUARE_API_URL is not set/)).toBeTruthy();
    expect(screen.queryAllByLabelText('Legal name')).toHaveLength(0);
  });

  it('keeps the form in the page until the record is stored: nothing is sent while typing', async () => {
    const { container } = mount(openJob(), institution, client(notFound));
    const store = () =>
      screen.getByRole('button', { name: 'Store the record and bind the commitment' }) as HTMLButtonElement;
    fireEvent.change(screen.getAllByLabelText('Legal name')[0]!, { target: { value: 'Grace Research GmbH' } });
    fireEvent.change(screen.getAllByLabelText('City')[0]!, { target: { value: 'Berlin' } });
    fireEvent.change(screen.getAllByLabelText('Country')[0]!, { target: { value: 'DE' } });
    expect(store().disabled).toBe(true);
    expect(requests.some((request) => request.includes('Grace') || request.includes('Berlin'))).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  it('recomputes the bound commitment from the record and salt the Square API discloses', async () => {
    const job = openJob();
    const opened = disclosureOf(job, travelRule.generateSalt());
    const bound = Uint8Array.from(Buffer.from(opened.status.commitment, 'hex'));
    const { container } = mount({ ...job, commitment: bound }, institution, client(disclosed(opened)));
    expect(screen.getByText('Commitment bound')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check against the stored record' }));
    await waitFor(() => expect(screen.getByText('Matches')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Store a new record and bind it' })).toBeTruthy();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('reports a commitment that the stored record does not explain, and a job with no stored record', async () => {
    const job = { ...openJob(new Uint8Array(32).fill(7)), status: 'funded' };
    mount(job, institution, client(disclosed(disclosureOf(job, travelRule.generateSalt()))));
    fireEvent.click(screen.getByRole('button', { name: 'Check against the stored record' }));
    await waitFor(() => expect(screen.getByText('Does not match')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Store/ })).toBeNull();
    cleanup();
    mount(job, institution, client(notFound));
    fireEvent.click(screen.getByRole('button', { name: 'Check against the stored record' }));
    await waitFor(() => expect(screen.getByText('No record')).toBeTruthy());
  });
});
