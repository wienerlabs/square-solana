// Settlement token (FE-03): config adresi SDK'nın türetmesiyle aynı; miktarlar yuvarlanmadan yazılır;
// token hesabı spl-token'ın kendi düzeniyle kodlanıp çözülür.
import { ACCOUNT_SIZE, AccountLayout, AccountState, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { createPda } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { formatUnits, parseUnits, settlementAccount, tokenAmount, type SettlementToken } from '../src/lib/settlement';
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

describe('parseUnits', () => {
  it.each([
    ['0', 6, 0n],
    ['1', 6, 1_000_000n],
    ['1.5', 6, 1_500_000n],
    ['0.000001', 6, 1n],
    ['1250.50', 6, 1_250_500_000n],
    ['18446744073709.551615', 6, 18_446_744_073_709_551_615n],
    ['42', 0, 42n],
  ])('%s with %s decimals → %s base units', (text, decimals, value) => {
    expect(parseUnits(text, decimals)).toEqual({ ok: true, value });
  });

  it('refuses more decimal places than the mint has, instead of rounding', () => {
    expect(parseUnits('1.0000001', 6)).toEqual({ ok: false, error: "At most 6 decimal places: the mint's precision." });
    expect(parseUnits('1.5', 0)).toEqual({ ok: false, error: 'The mint has no decimal places.' });
  });

  it.each(['', '1,000', '1.', '.5', '01', '-1', '1e6', '1.2.3', ' 1'])('rejects %j', (text) => {
    expect(parseUnits(text, 6)).toMatchObject({ ok: false });
  });

  it('reads back what formatUnits writes without grouping', () => {
    for (const amount of [0n, 1n, 999_999n, 1_000_000n, 123_456_789_012n, 18_446_744_073_709_551_615n]) {
      const text = formatUnits(amount, 6, { grouping: false });
      expect(text).not.toContain(',');
      expect(parseUnits(text, 6)).toEqual({ ok: true, value: amount });
    }
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
