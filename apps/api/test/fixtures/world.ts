// Test fixture: indexer'ın yazdığı ayna satırları. Hesap değerleri IDL örneklerinden (Anchor biçimi) üretilip
// SDK'nın `toIdlJson`'uyla JSON'a çevrilir; filtre sütunları aynı JSON'dan alınır. İndexer'ın kendisi
// apps/indexer testlerinde; burada API'nin okuduğu tabloların içeriği kurulur. Zincirden okunan hesaplar
// (PDA çözümü, Squads multisig) fixture RPC'ye de konur.
import type { Idl, Program } from '@anchor-lang/core';
import { BN } from '@anchor-lang/core';
import type { PrismaClient } from '@squaresdk/solana-db';
import { toIdlJson, type IdlJson, type SquareProgramName } from '@squaresdk/solana-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SQUADS_PROGRAM_ID } from '../../src/squads.js';
import type { FixtureRpc } from './rpc.js';
import { sample } from './sample.js';
import { PROGRAM_IDS, type Stack } from './stack.js';

type Json = Record<string, IdlJson>;

export interface Wallet {
  readonly keypair: Keypair;
  readonly address: string;
}

export const wallet = (): Wallet => {
  const keypair = Keypair.generate();
  return { keypair, address: keypair.publicKey.toBase58() };
};

const key = () => Keypair.generate().publicKey;

export class World {
  private slot = 100n;
  readonly programs: Record<SquareProgramName, Program<Idl>>;

  constructor(
    readonly db: PrismaClient,
    readonly rpc: FixtureRpc,
    client: Stack['client'],
  ) {
    this.programs = {
      registry: client.registry.program,
      policy: client.policy.program,
      verifier: client.verifier.program,
      escrow: client.escrow.program,
    } as unknown as Record<SquareProgramName, Program<Idl>>;
  }

  private json(program: SquareProgramName, type: string, value: Record<string, unknown>): Json {
    return toIdlJson(this.programs[program].idl, { defined: { name: type } }, value) as Json;
  }

  private fresh() {
    this.slot += 1n;
    return { slot: this.slot, indexedAt: new Date() };
  }

  /** Hesabı fixture RPC'ye koyar (Anchor kodlamasıyla). */
  async onChain(program: SquareProgramName, type: string, address: PublicKey, value: Record<string, unknown>) {
    const data = await this.programs[program].coder.accounts.encode(type, value);
    this.rpc.setAccount(address.toBase58(), { owner: PROGRAM_IDS[program].toBase58(), data });
  }

  async institution(owner: string, options: { multisig?: PublicKey } = {}) {
    const address = key();
    const account = this.json(
      'policy',
      'institution',
      sample(this.programs.policy.idl, 'institution', {
        ownerKey: new PublicKey(owner),
        name: 'Example Research Ltd',
        multisig: options.multisig ?? null,
        multisigVault: options.multisig ? key() : null,
      }),
    );
    await this.db.institution.create({
      data: {
        address: address.toBase58(),
        ownerKey: owner,
        multisigVault: account.multisigVault as string | null,
        name: 'Example Research Ltd',
        account,
        ...this.fresh(),
      },
    });
    return address.toBase58();
  }

  async policy(institution: string) {
    const address = key();
    const account = this.json(
      'policy',
      'policy',
      sample(this.programs.policy.idl, 'policy', { institution: new PublicKey(institution), active: true }),
    );
    await this.db.policy.create({
      data: {
        address: address.toBase58(),
        institution,
        policyId: account.policyId as string,
        version: account.version as number,
        active: true,
        account,
        ...this.fresh(),
      },
    });
    return address.toBase58();
  }

  /** Agent kaydı; `address` verilmezse rastgele (PDA gerektirmeyen testler). */
  async agent(owner: string, agentWallet: string, options: { agentCardHash?: string; address?: string } = {}) {
    const address = options.address ? new PublicKey(options.address) : key();
    const agentCardHash = options.agentCardHash;
    const value = sample(this.programs.registry.idl, 'agentRecord', {
      creator: new PublicKey(owner),
      owner: new PublicKey(owner),
      wallet: new PublicKey(agentWallet),
      status: { active: {} },
      ...(agentCardHash ? { agentCardHash: Array.from(Buffer.from(agentCardHash, 'hex')) } : {}),
    });
    const account = this.json('registry', 'agentRecord', value);
    await this.db.agent.create({
      data: {
        address: address.toBase58(),
        creator: owner,
        owner,
        wallet: agentWallet,
        agentId: account.agentId as string,
        status: 'active',
        agentCardUri: account.agentCardUri as string,
        agentCardHash: account.agentCardHash as string,
        account,
        ...this.fresh(),
      },
    });
    return address.toBase58();
  }

  async screening(walletAddress: string, expiresAt: number) {
    const address = key();
    const account = this.json(
      'registry',
      'screeningRecord',
      sample(this.programs.registry.idl, 'screeningRecord', {
        wallet: new PublicKey(walletAddress),
        status: { clear: {} },
        expiresAt: new BN(expiresAt),
      }),
    );
    await this.db.screening.create({
      data: {
        address: address.toBase58(),
        wallet: walletAddress,
        status: 'clear',
        screenedAt: BigInt(account.screenedAt as number),
        expiresAt: BigInt(expiresAt),
        sourceHash: account.sourceHash as string,
        account,
        ...this.fresh(),
      },
    });
  }

  /**
   * Job: ayna satırı ve (PDA çözümü için) zincirdeki hesap. `disputed` ise dispute satırı da; `dispute` dispute
   * alanlarını (Anchor biçimi), `status` job durumunu değiştirir.
   */
  async job(params: {
    institution: string;
    agentRecord: string;
    agentWallet: string;
    disputed?: boolean;
    status?: string;
    amount?: bigint;
    dispute?: Record<string, unknown>;
  }) {
    const address = key();
    const status = (params.status ?? (params.disputed ? 'disputed' : 'accepted')) as 'disputed';
    const value = sample(this.programs.escrow.idl, 'job', {
      institution: new PublicKey(params.institution),
      agentRecord: new PublicKey(params.agentRecord),
      agentWallet: new PublicKey(params.agentWallet),
      status: { [status]: {} },
      ...(params.amount === undefined ? {} : { amount: new BN(params.amount.toString()) }),
      dispute: sample(this.programs.escrow.idl, 'disputeInfo', {
        raisedAt: new BN(params.disputed ? 1_790_000_500 : 0),
        resolution: { pending: {} },
        lapsed: false,
        ...params.dispute,
      }),
    });
    const account = this.json('escrow', 'job', value);
    const row = this.fresh();
    await this.db.job.create({
      data: {
        address: address.toBase58(),
        institution: params.institution,
        agentRecord: params.agentRecord,
        agentWallet: params.agentWallet,
        policy: account.policy as string | null,
        mint: account.mint as string,
        amount: account.amount as string,
        specHash: account.specHash as string,
        status,
        createdAt: BigInt(account.createdAt as number),
        deadline: BigInt(account.deadline as number),
        challengeEnd: BigInt(account.challengeEnd as number),
        account,
        ...row,
      },
    });
    if (params.disputed) {
      const dispute = account.dispute as Json;
      await this.db.dispute.create({
        data: {
          job: address.toBase58(),
          institution: params.institution,
          agentRecord: params.agentRecord,
          jobStatus: status,
          challenger: dispute.challenger as string,
          bond: dispute.bond as string,
          reasonHash: dispute.reasonHash as string,
          raisedAt: BigInt(dispute.raisedAt as number),
          deadline: BigInt(dispute.deadline as number),
          decidedAt: BigInt(dispute.decidedAt as number),
          closedAt: BigInt(dispute.closedAt as number),
          resolution: (dispute.resolution as { kind: 'pending' }).kind,
          lapsed: dispute.lapsed as boolean,
          approvalMask: dispute.approvalMask as number,
          approvalCount: dispute.approvalCount as number,
          arbitratorSetVersion: BigInt(dispute.arbitratorSetVersion as number),
          ...row,
        },
      });
    }
    await this.onChain('escrow', 'job', address, value);
    return { address: address.toBase58(), specHash: account.specHash as string };
  }

  async claim(job: string, seller: string) {
    const address = key();
    const account = this.json(
      'escrow',
      'claimListing',
      sample(this.programs.escrow.idl, 'claimListing', {
        job: new PublicKey(job),
        seller: new PublicKey(seller),
        buyer: PublicKey.default,
        status: { listed: {} },
      }),
    );
    await this.db.claim.create({
      data: {
        address: address.toBase58(),
        job,
        seller,
        buyer: null,
        status: 'listed',
        price: account.price as string,
        faceValue: account.faceValue as string,
        account,
        ...this.fresh(),
      },
    });
  }

  async event(job: string) {
    const data = this.json(
      'escrow',
      'jobFunded',
      sample(this.programs.escrow.idl, 'jobFunded', { job: new PublicKey(job) }),
    );
    await this.db.chainEvent.create({
      data: {
        signature: Keypair.generate().publicKey.toBase58().repeat(2).slice(0, 88),
        slot: this.fresh().slot,
        blockTime: 1_790_000_000n,
        instructionIndex: 0,
        eventIndex: 0,
        program: 'escrow',
        name: 'JobFunded',
        job,
        payload: { program: 'escrow', name: 'JobFunded', data },
      },
    });
  }

  /** Escrow event'i (`chain_events`); `data` Anchor biçimindedir. Satırın kimliği döner. */
  async chainEvent(job: string, name: string, data: Record<string, unknown>, slot?: bigint): Promise<bigint> {
    const type = name.charAt(0).toLowerCase() + name.slice(1);
    const json = this.json('escrow', type, {
      ...sample(this.programs.escrow.idl, type),
      job: new PublicKey(job),
      ...data,
    });
    const row = await this.db.chainEvent.create({
      data: {
        signature: Keypair.generate().publicKey.toBase58().repeat(2).slice(0, 88),
        slot: slot ?? this.fresh().slot,
        blockTime: 1_790_000_000n,
        instructionIndex: 0,
        eventIndex: 0,
        program: 'escrow',
        name,
        job,
        payload: { program: 'escrow', name, data: json },
      },
    });
    return row.id;
  }

  /** Zincirdeki escrow config'i: aktif arbitrator seti, eşik ve set sürümü. */
  async escrowConfig(arbitrators: readonly string[], threshold: number, version: number, pda: PublicKey) {
    const value = sample(this.programs.escrow.idl, 'escrowConfig');
    const slots = Array.from({ length: 7 }, (_, i) =>
      arbitrators[i] ? new PublicKey(arbitrators[i]) : PublicKey.default,
    );
    await this.onChain('escrow', 'escrowConfig', pda, {
      ...value,
      arbitrators: slots,
      arbitratorCount: arbitrators.length,
      threshold,
      arbitratorSetVersion: version,
    });
  }

  async keeperAction(job: string, outcome: 'skipped' | 'confirmed') {
    await this.db.keeperAction.create({
      data: {
        job,
        action: 'finalizePayment',
        outcome,
        reason: outcome === 'skipped' ? 'challengeOpen' : null,
        signature: null,
        keeperFee: outcome === 'confirmed' ? '2500' : null,
        nextAttemptAt: outcome === 'skipped' ? new Date('2026-10-07T00:00:00Z') : null,
      },
    });
  }

  /** Squads v4 multisig hesabı (fixture RPC'de): üyeler ve izin maskeleri. */
  squadsMultisig(members: readonly { key: string; permissions: number }[]): PublicKey {
    const address = key();
    const discriminator = Buffer.from([224, 116, 121, 186, 68, 161, 79, 236]);
    const header = Buffer.alloc(32 + 32 + 2 + 4 + 8 + 8);
    header.writeUInt16LE(2, 64);
    const count = Buffer.alloc(4);
    count.writeUInt32LE(members.length);
    const body = members.map((member) =>
      Buffer.concat([new PublicKey(member.key).toBuffer(), Buffer.from([member.permissions])]),
    );
    // rent_collector: None (0), bump.
    const data = Buffer.concat([discriminator, header, Buffer.from([0, 254]), count, ...body]);
    this.rpc.setAccount(address.toBase58(), { owner: SQUADS_PROGRAM_ID.toBase58(), data });
    return address;
  }
}
