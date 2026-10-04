// Settlement token (FE-03): config adresi SDK'nın türetmesiyle aynı; miktarlar yuvarlanmadan yazılır;
// token hesabı spl-token'ın kendi düzeniyle kodlanıp çözülür.
import { ACCOUNT_SIZE, AccountLayout, AccountState, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { createPda } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { formatUnits, settlementAccount, tokenAmount, type SettlementToken } from '../src/lib/settlement';
import { escrowConfigAddress } from '../src/lib/idl-pda';

const key = () => Keypair.generate().publicKey;

describe('escrowConfigAddress', () => {
  it('derives the same PDA as the SDK', () => {
    const programIds = { registry: key(), policy: key(), verifier: key(), escrow: key() };
    expect(escrowConfigAddress(programIds.escrow).toBase58()).toBe(createPda(programIds).escrowConfig()[0].toBase58());
  });
});

describe('formatUnits', () => {
  it.each([
    [0n, 6, '0'],
    [1n, 6, '0.000001'],
    [1_500_000n, 6, '1.5'],
    [1_234_500_000n, 6, '1,234.5'],
    [18_446_744_073_709_551_615n, 6, '18,446,744,073,709.551615'],
    [42n, 0, '42'],
  ])('%s with %s decimals → %s', (amount, decimals, text) => {
    expect(formatUnits(amount, decimals)).toBe(text);
  });
});

describe('token account', () => {
  const owner = key();
  const token: SettlementToken = { mint: key(), tokenProgram: TOKEN_PROGRAM_ID, decimals: 6 };
  const address = settlementAccount(owner, token);

  function account(amount: bigint): AccountInfo<Buffer> {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: token.mint,
        owner,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: AccountState.Initialized,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    return { data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 };
  }

  it('reads the amount of an existing account', () => {
    expect(tokenAmount(address, account(2_500_000n), token)).toBe(2_500_000n);
  });

  it('treats a missing or closed account as having no balance account', () => {
    expect(tokenAmount(address, null, token)).toBeNull();
    expect(tokenAmount(address, { ...account(0n), data: Buffer.alloc(0) }, token)).toBeNull();
  });
});
