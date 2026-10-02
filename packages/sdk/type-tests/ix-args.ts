// Derleme zamanı testi: instruction argüman ve hesap tipleri IDL'den eşleniyor (tsc --noEmit).
import type { BN } from '@coral-xyz/anchor';
import type { PublicKey } from '@solana/web3.js';
import type { IxAccounts, IxArgs, JobAccount, SquareEscrowContract, SquareRegistryContract } from '../src/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Anchor argüman demetini `& unknown[]` ile kesiştirir; demetler için karşılıklı atanabilirlik yeterli.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

// create_job(spec_hash: [u8; 32], amount: u64, deadline: i64, challenge_period: u64)
export type CreateJobArgs = Expect<Same<IxArgs<SquareEscrowContract, 'createJob'>, [number[], BN, BN, BN]>>;
// register_agent(agent_id: String, agent_card_uri: String, agent_card_hash: [u8; 32], wallet: Pubkey)
export type RegisterAgentArgs = Expect<Same<IxArgs<SquareRegistryContract, 'registerAgent'>, [string, string, number[], PublicKey]>>;
// Hesap adları IDL'den gelir (camelCase); payer ve institution create_job'da imzacı.
export type CreateJobAccountKeys = Expect<Equal<'payer' extends keyof IxAccounts<SquareEscrowContract, 'createJob'> ? true : false, true>>;
// Zincir hesap tipi IDL düzeniyle: Job.agentWallet bir PublicKey.
export type JobAgentWallet = Expect<Equal<JobAccount['agentWallet'], PublicKey>>;
