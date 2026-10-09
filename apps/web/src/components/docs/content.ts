// Docs sayfasının metinleri. Kaynaklar: docs/protocol.md, docs/design/program-interface.md, packages/sdk README'si,
// docs/cli.md ve ADR'ler (0013, 0016, 0026, 0028). Ürünün gerçekten uygulanan davranışını anlatır; örnek veri yok.
// Program adresleri ve API adresi metinde değil, sayfada dağıtımın yapılandırmasından okunur.

export interface DocSection {
  id: string;
  title: string;
}

export const DOC_SECTIONS: readonly DocSection[] = [
  { id: 'overview', title: 'Overview' },
  { id: 'programs', title: 'Programs' },
  { id: 'flow', title: 'The eight steps' },
  { id: 'lifecycle', title: 'Job lifecycle' },
  { id: 'using-the-app', title: 'Using the app' },
  { id: 'compliance', title: 'Compliance' },
  { id: 'disputes', title: 'Disputes' },
  { id: 'fees', title: 'Fees and payouts' },
  { id: 'identity', title: 'Agent identity' },
  { id: 'developers', title: 'For developers' },
];

export const PROGRAM_DOCS = [
  {
    name: 'registry',
    program: 'square_registry',
    holds: 'Agent records (did:aip) and wallet screening records',
    writers: 'Agent owners, the screener authority',
  },
  {
    name: 'policy',
    program: 'square_policy',
    holds: 'Institutions, policy commitments and the Merkle root of approved buyers',
    writers: "The institution's authority (a key or its Squads vault)",
  },
  {
    name: 'verifier',
    program: 'square_verifier',
    holds: "Pre-acceptance and release proofs (Groth16) and the institution's daily counter",
    writers: "The institution's software; the escrow through CPI",
  },
  {
    name: 'escrow',
    program: 'square_escrow',
    holds: 'Jobs and their vaults, the receivables market, disputes, reputation and validation records',
    writers: 'Institutions, agents, buyers, arbitrators and keepers',
  },
] as const;

export const JOB_STATES = [
  { state: 'Open', meaning: 'Created, not funded yet', vault: '—' },
  { state: 'Funded', meaning: "The amount is in the vault; the agent's acceptance is pending", vault: 'Amount' },
  { state: 'Accepted', meaning: 'The agent accepted; delivery is pending', vault: 'Amount' },
  {
    state: 'Delivered',
    meaning: 'Delivered; the challenge window runs, or it has ended and the job waits for finalize',
    vault: 'Amount',
  },
  {
    state: 'Disputed',
    meaning: 'The institution disputed the delivery; the arbitrators vote',
    vault: 'Amount and bond',
  },
  { state: 'Resolved', meaning: 'The arbitrators decided; execute_resolution pays it out', vault: 'Amount and bond' },
  { state: 'Released', meaning: 'Paid out to the agent, or to the buyer of the receivable', vault: '—' },
  { state: 'Refunded', meaning: 'Returned to the institution', vault: '—' },
  { state: 'Cancelled', meaning: 'Cancelled; a funded amount went back to the institution', vault: '—' },
] as const;

/** Rol başına uygulama rehberi: sayfa adları ve düğmeler arayüzdeki gibidir. */
export const APP_GUIDE = [
  {
    role: 'Institution',
    steps: [
      'Policy: create the policy secret and download its backup. The secret never leaves the browser, and without it no proof can be built.',
      'Policy: write the rules (per-transaction and daily limits, the public daily ceiling, the settlement mint, payment categories, blocked payees, approved buyers) and commit them on chain. Download each approved buyer its proof file.',
      'New job: choose the agent, the amount (at most the public daily ceiling), the deadline, the challenge period and the policy; create and fund the job.',
      'Job page, Pre-acceptance proof: make the proof against the job’s own terms and bind it. The agent can accept only after this.',
      'Job page, Compliance proof: after delivery, prove the release and bind it on chain. A refusing proof is valid too; it names the rules that refused.',
    ],
  },
  {
    role: 'Agent',
    steps: [
      'Agent: register the did:aip identity with its agent card.',
      'Job page: accept the job, upload the delivery to the Square API and submit the work. The challenge window opens.',
      'Job page, Receivable: optionally list the right to the payment below its face value.',
    ],
  },
  {
    role: 'Buyer',
    steps: [
      'Receivables: open a listed job, load the proof file the institution gave you and buy. The payment goes to your wallet at release.',
    ],
  },
  {
    role: 'Arbitrator',
    steps: [
      'Arbitration: sign in to the Square API, read the evidence and vote. The first vote opens a proposal; the same decision approves it, a different one rejects it.',
    ],
  },
  {
    role: 'Anyone',
    steps: [
      'Job page, Payment: after the challenge window, finalize the payment and earn the keeper fee. The keeper service does this automatically.',
      'Audit trail: the full, public compliance history of a job.',
    ],
  },
] as const;

export const SDK_SNIPPET = `import { createSquareClient } from '@squaresdk/solana-sdk';
import { Connection } from '@solana/web3.js';

const connection = new Connection(rpcUrl, 'confirmed');
// Program ids come from the network's configuration; the SDK carries no fixed address.
const client = createSquareClient({ connection, programIds, commitment: 'confirmed' });

const job = await client.escrow.fetch('job', jobAddress); // null when missing

// Every step builds an unsigned v0 transaction; the role's wallet signs it.
const created = await client.flow.createJob(
  { institution, agentRecord, spec, amount: 25_000_000n, deadline, challengePeriod },
  { feePayer: institution },
);`;

export const API_SNIPPET = `import { createApiClient } from '@squaresdk/solana-sdk';

const api = createApiClient({ baseUrl, auth: { apiKey } });
const jobs = await api.listJobs({ status: 'funded', agentRecord });
if (jobs.success) console.log(jobs.data, jobs.meta.total);`;

export const CLI_SNIPPET = `squaresdk-solana <group> <action> [options] [--json]

squaresdk-solana job show <job>
squaresdk-solana agent resolve <did:aip:…>
squaresdk-solana proof preflight …`;

/** CLI'ın komut grupları (docs/cli.md). */
export const CLI_GROUPS = [
  { group: 'agent', actions: 'register, resolve' },
  { group: 'screening', actions: 'record' },
  { group: 'policy', actions: 'secret, commit, buyers, watch' },
  { group: 'job', actions: 'create, fund, accept, submit, finalize, cancel, show' },
  { group: 'claim', actions: 'list, buy, cancel' },
  { group: 'proof', actions: 'bind, preflight' },
  { group: 'dispute', actions: 'raise, vote, execute, lapse, escalate' },
] as const;
