import { randomBytes } from 'node:crypto';
import { BN } from '@anchor-lang/core';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { createSquareClient } from '../src/client.js';
import { createPda } from '../src/pda.js';
import { TestChain } from './helpers/chain.js';
import { PROGRAM_IDS } from './helpers/ids.js';

const pda = createPda(PROGRAM_IDS);
const key = () => Keypair.generate().publicKey;
const client = createSquareClient({ connection: new TestChain().connection(), programIds: PROGRAM_IDS });

/** program-interface.md §5'teki seed tablosu, metin olarak (IDL sabitlerinden bağımsız denetim). */
const seed = (text: string) => Buffer.from(text, 'utf8');
const derive = (program: PublicKey, seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];

describe('createPda', () => {
  it('sözleşmedeki seed tablosuyla aynı adresleri üretir', () => {
    const [creator, wallet, owner, institution, job, agentRecord] = [key(), key(), key(), key(), key(), key()];
    const policyId = randomBytes(32);
    const specHash = randomBytes(32);
    const cases: [PublicKey, PublicKey][] = [
      [pda.registryConfig()[0], derive(PROGRAM_IDS.registry, [seed('registry_config')])],
      [
        pda.agentRecord(creator, 'summary-bot')[0],
        derive(PROGRAM_IDS.registry, [seed('agent'), creator.toBytes(), seed('summary-bot')]),
      ],
      [pda.screeningRecord(wallet)[0], derive(PROGRAM_IDS.registry, [seed('screening'), wallet.toBytes()])],
      [pda.institution(owner)[0], derive(PROGRAM_IDS.policy, [seed('institution'), owner.toBytes()])],
      [
        pda.policy(institution, policyId)[0],
        derive(PROGRAM_IDS.policy, [seed('policy'), institution.toBytes(), policyId]),
      ],
      [pda.verifierConfig()[0], derive(PROGRAM_IDS.verifier, [seed('verifier_config')])],
      [
        pda.operatorState(institution)[0],
        derive(PROGRAM_IDS.verifier, [seed('operator_state'), institution.toBytes()]),
      ],
      [pda.releaseProof(job)[0], derive(PROGRAM_IDS.verifier, [seed('release_proof'), job.toBytes()])],
      [pda.preflightProof(job)[0], derive(PROGRAM_IDS.verifier, [seed('preflight_proof'), job.toBytes()])],
      [pda.escrowConfig()[0], derive(PROGRAM_IDS.escrow, [seed('config')])],
      [pda.job(institution, specHash)[0], derive(PROGRAM_IDS.escrow, [seed('job'), institution.toBytes(), specHash])],
      [pda.vault(job)[0], derive(PROGRAM_IDS.escrow, [seed('escrow_token'), job.toBytes()])],
      [pda.bondVault(job)[0], derive(PROGRAM_IDS.escrow, [seed('bond'), job.toBytes()])],
      [pda.claimListing(job)[0], derive(PROGRAM_IDS.escrow, [seed('claim'), job.toBytes()])],
      [pda.agentReputation(agentRecord)[0], derive(PROGRAM_IDS.escrow, [seed('reputation'), agentRecord.toBytes()])],
      [pda.validationRecord(job)[0], derive(PROGRAM_IDS.escrow, [seed('validation'), job.toBytes()])],
      [pda.escrowAuthority()[0], derive(PROGRAM_IDS.escrow, [seed('escrow_authority')])],
    ];
    for (const [actual, expected] of cases) expect(actual.toBase58()).toBe(expected.toBase58());
  });

  it("Anchor'ın IDL seed bilgisinden çözdüğü adreslerle aynı", async () => {
    const owner = key();
    const institution = key();
    const specHash = Array.from(randomBytes(32));
    const job = pda.job(institution, Uint8Array.from(specHash))[0];
    const register = await client.registry.program.methods
      .registerAgent('summary-bot', 'https://agents.square.test/card.json', specHash, key())
      .accountsPartial({ payer: owner, owner })
      .pubkeys();
    expect(register.agentRecord?.toBase58()).toBe(pda.agentRecord(owner, 'summary-bot')[0].toBase58());

    const wallet = key();
    const screening = await client.registry.program.methods
      .recordScreening(wallet, { clear: {} }, specHash)
      .accountsPartial({ payer: owner, screenerAuthority: owner })
      .pubkeys();
    expect(screening.config?.toBase58()).toBe(pda.registryConfig()[0].toBase58());
    expect(screening.screeningRecord?.toBase58()).toBe(pda.screeningRecord(wallet)[0].toBase58());

    const create = await client.escrow.program.methods
      .createJob(specHash, new BN(1), new BN(1), new BN(1))
      .accountsPartial({
        payer: owner,
        institution,
        agentRecord: key(),
        policy: null,
        policyInstitution: null,
        mint: key(),
        tokenProgram: key(),
      })
      .pubkeys();
    expect(create.job?.toBase58()).toBe(job.toBase58());
    expect(create.vault?.toBase58()).toBe(pda.vault(job)[0].toBase58());
    expect(create.config?.toBase58()).toBe(pda.escrowConfig()[0].toBase58());

    const policyId = Array.from(randomBytes(32));
    const setPolicy = await client.policy.program.methods
      .setPolicy(policyId, specHash, new BN(1))
      .accountsPartial({ payer: owner, authority: owner, institution })
      .pubkeys();
    expect(setPolicy.policy?.toBase58()).toBe(pda.policy(institution, Uint8Array.from(policyId))[0].toBase58());

    const init = await client.policy.program.methods
      .initInstitution('Square')
      .accountsPartial({ payer: owner, authority: owner })
      .pubkeys();
    expect(init.institution?.toBase58()).toBe(pda.institution(owner)[0].toBase58());
  });

  it('geçersiz seed uzunluklarını reddeder', () => {
    expect(() => pda.agentRecord(key(), '')).toThrow(/agentId/);
    expect(() => pda.agentRecord(key(), 'x'.repeat(33))).toThrow(/agentId/);
    expect(() => pda.agentRecord(key(), 'ç'.repeat(17))).toThrow(/34 bayt/);
    expect(() => pda.job(key(), new Uint8Array(31))).toThrow(/specHash/);
    expect(() => pda.policy(key(), new Uint8Array(33))).toThrow(/policyId/);
  });
});
