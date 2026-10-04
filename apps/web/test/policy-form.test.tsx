// @vitest-environment jsdom
// Politika formunun tutar alanları (FE-04): settlement mint'i biliniyorsa USDC olarak, mint'in ondalığıyla
// girilir ve taslağa taban birim yazılır; bilinmiyorsa taban birim. Form gerçek bileşendir; sarmalayıcı
// yalnızca taslağı tutar ve denetimi her değişiklikte yeniden hesaplar.
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PolicyForm } from '@/components/policy/policy-form';
import { checkDraft, newDraft, type PolicyDraft } from '@/lib/policy-draft';
import type { SettlementToken } from '@/lib/settlement';

afterEach(cleanup);

const token = (decimals: number): SettlementToken => ({
  mint: Keypair.generate().publicKey,
  tokenProgram: TOKEN_PROGRAM_ID,
  decimals,
});

function mount(settlement: SettlementToken | null, initial: Partial<PolicyDraft> = {}) {
  const drafts: PolicyDraft[] = [];
  function Harness() {
    const [draft, setDraft] = useState<PolicyDraft>({ ...newDraft(), ...initial });
    const check = checkDraft(draft, settlement?.mint.toBase58() ?? null);
    return (
      <PolicyForm
        draft={draft}
        check={check}
        settlement={settlement}
        onChange={(next) => {
          drafts.push(next);
          setDraft(next);
        }}
      />
    );
  }
  render(<Harness />);
  const field = screen.getByLabelText(/Per-transaction limit/) as HTMLInputElement;
  const type = (value: string) => fireEvent.change(field, { target: { value } });
  return { drafts, field, type, last: () => drafts.at(-1)! };
}

describe('amounts with a known settlement mint', () => {
  it('takes USDC and stores base units, with the base-unit amount alongside', () => {
    const { type, last } = mount(token(6));
    type('250.5');
    expect(last().maxPerTx).toBe('250500000');
    expect(screen.getByText('In USDC; the mint has 6 decimal places. = 250500000 base units')).toBeTruthy();
  });

  it('uses the decimals of the mint, not a fixed six', () => {
    const { type, last } = mount(token(9));
    type('1.5');
    expect(last().maxPerTx).toBe('1500000000');
  });

  it('refuses more decimal places than the mint has and leaves the draft incomplete', () => {
    const { type, last, field } = mount(token(6));
    type('1.0000001');
    expect(screen.getByText("At most 6 decimal places: the mint's precision.")).toBeTruthy();
    expect(last().maxPerTx).toBe('');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.value).toBe('1.0000001');
  });

  it('shows a stored base-unit amount in USDC', () => {
    const { field } = mount(token(6), { maxPerTx: '1250500000' });
    expect(field.value).toBe('1250.5');
  });
});

describe('amounts without a known mint', () => {
  it('stays in base units', () => {
    const { type, last } = mount(null);
    expect(screen.getAllByText('In base units of the settlement mint; its decimals are not known yet.')).toHaveLength(
      3,
    );
    type('250500000');
    expect(last().maxPerTx).toBe('250500000');
    type('1.5');
    expect(last().maxPerTx).toBe('1.5');
    expect(screen.getByText('Whole number of base units, without separators.')).toBeTruthy();
  });
});
