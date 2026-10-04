'use client';

import { useId, useState, type ReactNode } from 'react';
import { generateLeafSalt } from '@squaresdk/solana-policy';
import { DAYS_OF_WEEK, POLICY_CIRCUIT_LIMITS } from '@squaresdk/solana-types';
import { Button } from '@/components/ui/button';
import { bytesToHex, type DraftCheck, type DraftField, type PolicyDraft } from '@/lib/policy-draft';
import { formatUnits, parseUnits, type SettlementToken } from '@/lib/settlement';

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const DAY_LABEL: Record<(typeof DAYS_OF_WEEK)[number], string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function Field({
  id,
  label,
  scope,
  hint,
  check,
  field,
  error: localError,
  children,
}: {
  id: string;
  label: string;
  scope: string;
  hint?: ReactNode;
  check: DraftCheck;
  field: DraftField;
  /** Alanın kendi hatası (ör. ayrıştırma); taslağın denetiminden önce gösterilir. */
  error?: string;
  children: ReactNode;
}) {
  const error = localError ?? check.errors[field];
  const warning = check.warnings[field];
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm font-medium">
        {label}
        <span className="text-caption font-normal text-muted">{scope}</span>
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-caption text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-caption text-danger-text">
          {error}
        </p>
      )}
      {!error && warning && <p className="text-caption text-danger-text">{warning}</p>}
    </div>
  );
}

type AmountField = 'maxPerTx' | 'maxDaily' | 'dailyCeiling';
const AMOUNT_FIELDS: readonly AmountField[] = ['maxPerTx', 'maxDaily', 'dailyCeiling'];
const BASE_UNITS = /^(0|[1-9][0-9]*)$/;

const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm text-text aria-invalid:border-danger-text';

interface Props {
  draft: PolicyDraft;
  check: DraftCheck;
  settlement: SettlementToken | null;
  onChange(draft: PolicyDraft): void;
}

export function PolicyForm({ draft, check, settlement, onChange }: Props) {
  const id = useId();
  // Liste alanları satır satır düzenlenir; boş satırlar yazarken kaybolmasın diye metin ayrıca tutulur.
  const [texts, setTexts] = useState({
    tokenWhitelist: draft.tokenWhitelist.join('\n'),
    blockedPayees: draft.blockedPayees.join('\n'),
    allowedCategories: draft.allowedCategories.join('\n'),
    buyers: draft.buyers.map((b) => b.buyer).join('\n'),
  });

  const setList = (field: 'tokenWhitelist' | 'blockedPayees' | 'allowedCategories', text: string) => {
    setTexts((t) => ({ ...t, [field]: text }));
    onChange({ ...draft, [field]: lines(text) });
  };

  const setBuyers = (text: string) => {
    setTexts((t) => ({ ...t, buyers: text }));
    // Var olan alıcının salt'ı korunur; yeni alıcıya yeni salt üretilir.
    const salts = new Map(draft.buyers.map((b) => [b.buyer, b.leafSalt]));
    onChange({
      ...draft,
      buyers: lines(text).map((buyer) => ({ buyer, leafSalt: salts.get(buyer) ?? bytesToHex(generateLeafSalt()) })),
    });
  };

  // Settlement mint'i biliniyorsa tutarlar USDC olarak girilir (ondalık mint hesabından); taslakta her zaman
  // taban birim durur. Mint bilinmiyorsa alanlar taban birimdedir.
  const [amounts, setAmounts] = useState(
    () =>
      Object.fromEntries(
        AMOUNT_FIELDS.map((field) => {
          const value = draft[field];
          return [
            field,
            settlement && BASE_UNITS.test(value)
              ? formatUnits(BigInt(value), settlement.decimals, { grouping: false })
              : value,
          ];
        }),
      ) as Record<AmountField, string>,
  );
  const [amountErrors, setAmountErrors] = useState<Partial<Record<AmountField, string>>>(() =>
    settlement
      ? Object.fromEntries(
          AMOUNT_FIELDS.filter((f) => draft[f] !== '' && !BASE_UNITS.test(draft[f])).map((f) => [
            f,
            'Re-enter the amount in USDC.',
          ]),
        )
      : {},
  );

  const setAmount = (field: AmountField, raw: string) => {
    const text = raw.trim();
    setAmounts((a) => ({ ...a, [field]: text }));
    if (!settlement || text === '') {
      setAmountErrors((e) => ({ ...e, [field]: undefined }));
      onChange({ ...draft, [field]: text });
      return;
    }
    const parsed = parseUnits(text, settlement.decimals);
    setAmountErrors((e) => ({ ...e, [field]: parsed.ok ? undefined : parsed.error }));
    onChange({ ...draft, [field]: parsed.ok ? parsed.value.toString() : '' });
  };

  const addSettlementMint = () => {
    if (!settlement) return;
    setList('tokenWhitelist', [...draft.tokenWhitelist, settlement.mint.toBase58()].join('\n'));
  };

  const amount = (field: AmountField, label: string, scope: string) => {
    const error = amountErrors[field] ?? check.errors[field];
    const unit = settlement
      ? `In USDC; the mint has ${settlement.decimals} decimal places.`
      : 'In base units of the settlement mint; its decimals are not known yet.';
    return (
      <Field
        id={`${id}-${field}`}
        label={label}
        scope={scope}
        check={check}
        field={field}
        error={amountErrors[field]}
        hint={settlement && !error ? `${unit} = ${draft[field]} base units` : unit}
      >
        <input
          id={`${id}-${field}`}
          inputMode={settlement ? 'decimal' : 'numeric'}
          autoComplete="off"
          value={amounts[field]}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={`${id}-${field}-hint${error ? ` ${id}-${field}-error` : ''}`}
          onChange={(event) => setAmount(field, event.currentTarget.value)}
          className={inputClass}
        />
      </Field>
    );
  };

  const list = (
    field: 'tokenWhitelist' | 'blockedPayees' | 'allowedCategories',
    label: string,
    scope: string,
    hint: ReactNode,
  ) => (
    <Field id={`${id}-${field}`} label={label} scope={scope} check={check} field={field} hint={hint}>
      <textarea
        id={`${id}-${field}`}
        rows={3}
        spellCheck={false}
        value={texts[field]}
        aria-invalid={Boolean(check.errors[field]) || undefined}
        aria-describedby={`${id}-${field}-hint${check.errors[field] ? ` ${id}-${field}-error` : ''}`}
        onChange={(event) => setList(field, event.currentTarget.value)}
        className={inputClass}
      />
    </Field>
  );

  const window = draft.timeWindow;
  const settlementMint = settlement?.mint.toBase58();

  return (
    <div className="grid gap-5">
      <div className="grid gap-5 sm:grid-cols-3">
        {amount('maxPerTx', 'Per-transaction limit', 'Private · rule 1')}
        {amount('maxDaily', 'Daily limit', 'Private · rule 2')}
        {amount('dailyCeiling', 'Public daily ceiling', 'On chain · rule 7')}
      </div>
      {list(
        'tokenWhitelist',
        'Token whitelist',
        'Private · rule 3',
        <>
          One mint address per line, up to {POLICY_CIRCUIT_LIMITS.tokenWhitelist}.{' '}
          {settlementMint && !draft.tokenWhitelist.includes(settlementMint) && (
            <Button size="sm" variant="ghost" onClick={addSettlementMint}>
              Add the settlement mint
            </Button>
          )}
        </>,
      )}
      {list(
        'blockedPayees',
        'Blocked payees',
        'Private · rule 4',
        `Wallets that may never be paid, one per line, up to ${POLICY_CIRCUIT_LIMITS.blockedPayees}.`,
      )}
      {list(
        'allowedCategories',
        'Allowed payment categories',
        'Private · rule 5',
        `One per line, up to ${POLICY_CIRCUIT_LIMITS.allowedCategories}; each 1–${POLICY_CIRCUIT_LIMITS.categoryBytes} bytes.`,
      )}

      <fieldset className="flex flex-col gap-3">
        <legend className="flex w-full flex-wrap items-baseline justify-between gap-2 text-sm font-medium">
          Time window
          <span className="text-caption font-normal text-muted">Private · rule 6</span>
        </legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={window !== null}
            onChange={(event) =>
              onChange({
                ...draft,
                timeWindow: event.currentTarget.checked ? { days: [], startHourUtc: 0, endHourUtc: 23 } : null,
              })
            }
            className="accent-accent"
          />
          Only release inside a weekly window (UTC)
        </label>
        {window && (
          <div className="flex flex-col gap-3 pl-6">
            <div role="group" aria-label="Days" className="flex flex-wrap gap-2">
              {DAYS_OF_WEEK.map((day) => (
                <label
                  key={day}
                  className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={window.days.includes(day)}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        timeWindow: {
                          ...window,
                          days: event.currentTarget.checked
                            ? DAYS_OF_WEEK.filter((d) => d === day || window.days.includes(d))
                            : window.days.filter((d) => d !== day),
                        },
                      })
                    }
                    className="accent-accent"
                  />
                  {DAY_LABEL[day]}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {(['startHourUtc', 'endHourUtc'] as const).map((edge) => (
                <label key={edge} className="flex items-center gap-2">
                  {edge === 'startHourUtc' ? 'From' : 'To the end of'}
                  <select
                    value={window[edge]}
                    onChange={(event) =>
                      onChange({ ...draft, timeWindow: { ...window, [edge]: Number(event.currentTarget.value) } })
                    }
                    className="rounded-lg border border-border bg-surface px-2 py-1 font-mono"
                  >
                    {HOURS.map((hour) => (
                      <option key={hour} value={hour}>
                        {String(hour).padStart(2, '0')}:00
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <span className="text-caption text-muted">UTC, both hours included</span>
            </div>
          </div>
        )}
        {check.errors.timeWindow && <p className="text-caption text-danger-text">{check.errors.timeWindow}</p>}
      </fieldset>

      <Field
        id={`${id}-buyers`}
        label="Approved buyers"
        scope="Root on chain · step 5"
        check={check}
        field="buyers"
        hint="Wallets that may buy this policy's receivables, one per line. Leave empty to allow any buyer."
      >
        <textarea
          id={`${id}-buyers`}
          rows={3}
          spellCheck={false}
          value={texts.buyers}
          aria-invalid={Boolean(check.errors.buyers) || undefined}
          aria-describedby={`${id}-buyers-hint${check.errors.buyers ? ` ${id}-buyers-error` : ''}`}
          onChange={(event) => setBuyers(event.currentTarget.value)}
          className={inputClass}
        />
      </Field>
    </div>
  );
}
