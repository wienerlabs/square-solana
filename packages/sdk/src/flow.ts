// 8 adımın SDK tarafı (BE-08). Her adım hesapları açıkça verir (`accountsStrict`): PDA'lar
// `SquarePda`'dan, payee / mint / rent ödeyicisi zincirdeki job ve alacak kaydından, token programı
// mint hesabının sahibinden. Token hesabı gereken alıcı tarafların ATA'sı aynı tx'te idempotent
// olarak açılır. Program adresleri yapılandırmadan gelir (BC-09). Çağıran compute unit sınırı vermezse
// tx türünün profil sınırı eklenir (BC-28); dispute talimatlarının profili BC-32 / BC-33'te.
import type { Program } from '@anchor-lang/core';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { SystemProgram, type Connection, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { computeUnitLimitFor, withComputeProfile } from './budget.js';
import { CCTP_RECEIVE_COMPUTE_UNITS, cctpMintedAmount, decodeCctpMessage, receiveMessageInstruction } from './cctp.js';
import type { SquareFlow } from './client.js';
import type { SquarePda } from './pda.js';
import type { SquareIdls, SquareProgramIds } from './programs.js';
import { specHashing } from './spec.js';
import type { BuildOptions, BuiltTx, ClaimListingAccount, JobAccount } from './types.js';

export interface FlowDeps {
  connection: Connection;
  programIds: SquareProgramIds;
  pda: SquarePda;
  registry: Program<SquareIdls['registry']>;
  policy: Program<SquareIdls['policy']>;
  escrow: Program<SquareIdls['escrow']>;
  buildTx(instructions: readonly TransactionInstruction[], options: BuildOptions): Promise<BuiltTx>;
}

const u64 = (value: bigint, label: string): BN => {
  if (value < 0n || value >= 2n ** 64n) throw new Error(`${label} u64 aralığı dışında: ${value}`);
  return new BN(value.toString());
};
const i64 = (value: number, label: string): BN => {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} güvenli tamsayı değil: ${value}`);
  return new BN(value);
};
const bytes32 = (value: Uint8Array, label: string): number[] => {
  if (value.length !== 32) throw new Error(`${label} 32 bayt olmalı, ${value.length} bayt`);
  return Array.from(value);
};

export function createFlow(deps: FlowDeps): SquareFlow {
  const { connection, pda, programIds } = deps;

  async function job(address: PublicKey): Promise<JobAccount> {
    const account = await deps.escrow.account.job.fetchNullable(address);
    if (!account) throw new Error(`job bulunamadı: ${address.toBase58()}`);
    return account;
  }

  const claim = (address: PublicKey): Promise<ClaimListingAccount | null> =>
    deps.escrow.account.claimListing.fetchNullable(pda.claimListing(address)[0]);

  /** Mint'in token programı (SPL Token ya da Token-2022); başka sahipli mint reddedilir. */
  async function tokenProgram(mint: PublicKey): Promise<PublicKey> {
    const info = await connection.getAccountInfo(mint);
    if (!info) throw new Error(`mint bulunamadı: ${mint.toBase58()}`);
    if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) return info.owner;
    throw new Error(`mint bir token programına ait değil: ${mint.toBase58()} (${info.owner.toBase58()})`);
  }

  /** Sahibinin ATA'sı ve onu (yoksa) açan idempotent instruction; sahip PDA olabilir (Squads vault). */
  function ata(owner: PublicKey, mint: PublicKey, program: PublicKey, payer: PublicKey) {
    const address = getAssociatedTokenAddressSync(mint, owner, true, program);
    return {
      address,
      create: createAssociatedTokenAccountIdempotentInstruction(payer, address, owner, mint, program),
    };
  }

  /** `fund_job`: kurumun token hesabından vault'a; iki tarafın screening kaydı okunur. */
  async function fundJobInstruction(params: {
    institution: PublicKey;
    job: PublicKey;
    institutionTokenAccount: PublicKey;
  }): Promise<TransactionInstruction> {
    const account = await job(params.job);
    return deps.escrow.methods
      .fundJob()
      .accountsStrict({
        institution: params.institution,
        config: pda.escrowConfig()[0],
        job: params.job,
        vault: pda.vault(params.job)[0],
        institutionTokenAccount: params.institutionTokenAccount,
        mint: account.mint,
        institutionScreening: pda.screeningRecord(params.institution)[0],
        agentScreening: pda.screeningRecord(account.agentWallet)[0],
        tokenProgram: await tokenProgram(account.mint),
      })
      .instruction();
  }

  /** Payee: alacak satılmışsa alıcı, değilse job'daki agent cüzdanı (program-interface.md §6). */
  function payeeOf(account: JobAccount, listing: ClaimListingAccount | null): PublicKey {
    return listing && 'bought' in listing.status ? listing.buyer : account.agentWallet;
  }

  /** İspat kapısı hesapları: job bir politikaya bağlıysa verifier hesapları, değilse hepsi boş. */
  async function releaseGate(address: PublicKey, account: JobAccount) {
    if (!account.policy) {
      return { releaseProof: null, operatorState: null, verifierConfig: null, verifierProgram: null };
    }
    const policy = await deps.policy.account.policy.fetchNullable(account.policy);
    if (!policy) throw new Error(`job'un politikası bulunamadı: ${account.policy.toBase58()}`);
    return {
      releaseProof: pda.releaseProof(address)[0],
      operatorState: pda.operatorState(policy.institution)[0],
      verifierConfig: pda.verifierConfig()[0],
      verifierProgram: programIds.verifier,
    };
  }

  /** finalize_payment ve execute_resolution'ın ortak settlement hesapları. */
  async function settlement(address: PublicKey, payer: PublicKey) {
    const account = await job(address);
    const listing = await claim(address);
    const program = await tokenProgram(account.mint);
    const payee = ata(payeeOf(account, listing), account.mint, program, payer);
    const institution = ata(account.institution, account.mint, program, payer);
    const gate = await releaseGate(address, account);
    return {
      account,
      listing,
      prepend: [payee.create, institution.create],
      accounts: {
        config: pda.escrowConfig()[0],
        job: address,
        vault: pda.vault(address)[0],
        claimListing: pda.claimListing(address)[0],
        payeeTokenAccount: payee.address,
        institutionTokenAccount: institution.address,
        mint: account.mint,
        payeeScreening: pda.screeningRecord(payeeOf(account, listing))[0],
        ...gate,
        escrowAuthority: pda.escrowAuthority()[0],
        agentReputation: pda.agentReputation(account.agentRecord)[0],
        validationRecord: pda.validationRecord(address)[0],
        rentPayer: account.rentPayer,
        tokenProgram: program,
        systemProgram: SystemProgram.programId,
      },
    };
  }

  return {
    async registerAgent(params, options) {
      const agentRecord = pda.agentRecord(params.owner, params.agentId)[0];
      const ix = await deps.registry.methods
        .registerAgent(
          params.agentId,
          params.agentCardUri,
          bytes32(params.agentCardHash, 'agentCardHash'),
          params.wallet,
        )
        .accountsStrict({
          payer: options.feePayer,
          owner: params.owner,
          agentRecord,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      return { ...(await deps.buildTx([ix], withComputeProfile(options, 'registerAgent'))), agentRecord };
    },

    async createJob(params, options) {
      const specHash = specHashing.specHash(params.spec);
      const address = pda.job(params.institution, specHash)[0];
      const config = await deps.escrow.account.escrowConfig.fetchNullable(pda.escrowConfig()[0]);
      if (!config) throw new Error('escrow config bulunamadı');
      let policyInstitution: PublicKey | null = null;
      if (params.policy) {
        const policy = await deps.policy.account.policy.fetchNullable(params.policy);
        if (!policy) throw new Error(`politika bulunamadı: ${params.policy.toBase58()}`);
        policyInstitution = policy.institution;
      }
      const ix = await deps.escrow.methods
        .createJob(
          Array.from(specHash),
          u64(params.amount, 'amount'),
          i64(params.deadline, 'deadline'),
          u64(params.challengePeriod, 'challengePeriod'),
        )
        .accountsStrict({
          payer: options.feePayer,
          institution: params.institution,
          config: pda.escrowConfig()[0],
          agentRecord: params.agentRecord,
          policy: params.policy ?? null,
          policyInstitution,
          job: address,
          vault: pda.vault(address)[0],
          mint: config.settlementMint,
          tokenProgram: await tokenProgram(config.settlementMint),
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      return { ...(await deps.buildTx([ix], withComputeProfile(options, 'createJob'))), job: address, specHash };
    },

    async commitTravelRule(params, options) {
      const ix = await deps.escrow.methods
        .commitTravelRule(bytes32(params.commitment, 'commitment'))
        .accountsStrict({ institution: params.institution, job: params.job })
        .instruction();
      return deps.buildTx([ix], withComputeProfile(options, 'commitTravelRule'));
    },

    async fundJob(params, options) {
      return deps.buildTx([await fundJobInstruction(params)], withComputeProfile(options, 'fundJob'));
    },

    async receiveAndFundJob(params, options) {
      const message = decodeCctpMessage(params.message);
      const account = await job(params.job);
      const program = await tokenProgram(account.mint);
      if (!account.mint.equals(params.cctp.usdcMint)) {
        throw new Error(`job'un mint'i (${account.mint.toBase58()}) CCTP'nin mint ettiği USDC değil`);
      }
      // Mint kurumun token hesabına yapılır, fonlama o hesaptan çeker: ikisi aynı hesap olmalı.
      const institutionTokenAccount = getAssociatedTokenAddressSync(account.mint, params.institution, true, program);
      if (!message.burn.mintRecipient.equals(institutionTokenAccount)) {
        throw new Error(
          `mesajın mint alıcısı ${message.burn.mintRecipient.toBase58()}, kurumun USDC hesabı ${institutionTokenAccount.toBase58()}`,
        );
      }
      const receive = receiveMessageInstruction({
        context: { ...params.cctp, tokenProgram: program },
        message: params.message,
        attestation: params.attestation,
        payer: options.feePayer,
        caller: params.institution,
      });
      const fund = await fundJobInstruction({
        institution: params.institution,
        job: params.job,
        institutionTokenAccount,
      });
      const built = await deps.buildTx(
        [receive, fund],
        options.computeUnitLimit !== undefined
          ? options
          : { ...options, computeUnitLimit: computeUnitLimitFor(['fundJob']) + CCTP_RECEIVE_COMPUTE_UNITS },
      );
      return { ...built, minted: cctpMintedAmount(message) };
    },

    async acceptJob(params, options) {
      const account = await job(params.job);
      const ix = await deps.escrow.methods
        .acceptJob(account.specHash)
        .accountsStrict({ agent: params.agent, job: params.job, agentRecord: account.agentRecord })
        .instruction();
      return deps.buildTx([ix], withComputeProfile(options, 'acceptJob'));
    },

    async submitWork(params, options) {
      const account = await job(params.job);
      const ix = await deps.escrow.methods
        .submitWork(bytes32(params.workHash, 'workHash'), params.deliveryUri)
        .accountsStrict({ agent: params.agent, job: params.job, agentRecord: account.agentRecord })
        .instruction();
      return deps.buildTx([ix], withComputeProfile(options, 'submitWork'));
    },

    async listClaim(params, options) {
      const ix = await deps.escrow.methods
        .listClaim(u64(params.price, 'price'))
        .accountsStrict({
          payer: options.feePayer,
          agent: params.agent,
          job: params.job,
          claimListing: pda.claimListing(params.job)[0],
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      return deps.buildTx([ix], withComputeProfile(options, 'listClaim'));
    },

    async buyClaim(params, options) {
      const account = await job(params.job);
      const listing = await claim(params.job);
      if (!listing) throw new Error(`job için alacak listelemesi yok: ${params.job.toBase58()}`);
      const program = await tokenProgram(account.mint);
      const seller = ata(listing.seller, account.mint, program, options.feePayer);
      const ix = await deps.escrow.methods
        .buyClaim(
          u64(params.price, 'price'),
          bytes32(params.leafSalt, 'leafSalt'),
          params.merkleProof.map((node, index) => bytes32(node, `merkleProof[${index}]`)),
        )
        .accountsStrict({
          buyer: params.buyer,
          config: pda.escrowConfig()[0],
          job: params.job,
          claimListing: pda.claimListing(params.job)[0],
          policy: account.policy,
          buyerScreening: pda.screeningRecord(params.buyer)[0],
          buyerTokenAccount: params.buyerTokenAccount,
          sellerTokenAccount: seller.address,
          mint: account.mint,
          tokenProgram: program,
        })
        .instruction();
      return deps.buildTx([seller.create, ix], withComputeProfile(options, 'buyClaim'));
    },

    async cancelClaim(params, options) {
      const listing = await claim(params.job);
      if (!listing) throw new Error(`job için alacak listelemesi yok: ${params.job.toBase58()}`);
      const ix = await deps.escrow.methods
        .cancelClaim()
        .accountsStrict({
          seller: params.seller,
          claimListing: pda.claimListing(params.job)[0],
          rentPayer: listing.rentPayer,
        })
        .instruction();
      return deps.buildTx([ix], withComputeProfile(options, 'cancelClaim'));
    },

    async finalizePayment(params, options) {
      const { prepend, accounts } = await settlement(params.job, params.keeper);
      const ix = await deps.escrow.methods
        .finalizePayment()
        .accountsStrict({ keeper: params.keeper, keeperTokenAccount: params.keeperTokenAccount, ...accounts })
        .instruction();
      return deps.buildTx([...prepend, ix], withComputeProfile(options, 'finalizePayment'));
    },

    async raiseDispute(params, options) {
      const account = await job(params.job);
      const ix = await deps.escrow.methods
        .raiseDispute(bytes32(params.reasonHash, 'reasonHash'), u64(params.bond, 'bond'))
        .accountsStrict({
          payer: options.feePayer,
          institution: params.institution,
          config: pda.escrowConfig()[0],
          job: params.job,
          bondVault: pda.bondVault(params.job)[0],
          institutionTokenAccount: params.institutionTokenAccount,
          mint: account.mint,
          tokenProgram: await tokenProgram(account.mint),
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      return deps.buildTx([ix], options);
    },

    async resolveDispute(params, options) {
      const ix = await deps.escrow.methods
        .resolveDispute(params.resolution)
        .accountsStrict({ arbitrator: params.arbitrator, config: pda.escrowConfig()[0], job: params.job })
        .instruction();
      return deps.buildTx([ix], options);
    },

    async executeResolution(params, options) {
      const { account, prepend, accounts } = await settlement(params.job, params.caller);
      const ix = await deps.escrow.methods
        .executeResolution()
        .accountsStrict({
          payer: params.caller,
          ...accounts,
          bondVault: account.dispute.bond.isZero() ? null : pda.bondVault(params.job)[0],
        })
        .instruction();
      return deps.buildTx([...prepend, ix], options);
    },

    async cancelJob(params, options) {
      const account = await job(params.job);
      const ix = await deps.escrow.methods
        .cancelJob()
        .accountsStrict({
          institution: params.institution,
          job: params.job,
          vault: pda.vault(params.job)[0],
          institutionTokenAccount: params.institutionTokenAccount,
          mint: account.mint,
          rentPayer: account.rentPayer,
          tokenProgram: await tokenProgram(account.mint),
        })
        .instruction();
      return deps.buildTx([ix], withComputeProfile(options, 'cancelJob'));
    },
  };
}
