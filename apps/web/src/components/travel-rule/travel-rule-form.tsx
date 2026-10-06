'use client';

import { useId, type ReactNode } from 'react';
import { Address } from '@/components/ui/address';
import type { PartyForm, PartyKind, TravelRuleForm } from '@/lib/travel-rule';

const inputClass =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text aria-invalid:border-danger-text';

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
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
    </div>
  );
}

const PARTY_TEXT = {
  originator: { legend: 'Originator', caption: 'Your institution, paying from' },
  beneficiary: { legend: 'Beneficiary', caption: 'The agent’s operator, paid at' },
} as const;

type Role = keyof typeof PARTY_TEXT;
type TextKey = Exclude<keyof PartyForm, 'kind'>;

/**
 * Travel Rule formu: originator ve beneficiary. Hesaplar zincirdeki cüzdanlardır, girilmez. Hata, alan
 * doluysa ya da kurum bağlamayı denediyse (`showAll`) gösterilir.
 */
export function TravelRuleFormFields({
  value,
  onChange,
  errors,
  showAll,
  accounts,
  disabled,
}: {
  value: TravelRuleForm;
  onChange(next: TravelRuleForm): void;
  errors: Readonly<Record<string, string>>;
  showAll: boolean;
  accounts: Readonly<Record<Role, string>>;
  disabled?: boolean;
}) {
  const party = (role: Role) => {
    const current = value[role];
    const set = (patch: Partial<PartyForm>) => onChange({ ...value, [role]: { ...current, ...patch } });
    const error = (key: TextKey) => {
      const message = errors[`${role}.${key}`];
      return message && (showAll || current[key].trim() !== '') ? message : null;
    };
    const input = (key: TextKey, label: string, hint?: string, type = 'text') => (
      <Field label={label} hint={hint} error={error(key)}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            type={type}
            className={inputClass}
            value={current[key]}
            onChange={(event) => set({ [key]: event.target.value })}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            autoComplete="off"
            disabled={disabled}
          />
        )}
      </Field>
    );
    const identification = errors[`${role}.identification`];
    return (
      <fieldset key={role} className="grid gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{PARTY_TEXT[role].legend}</legend>
        <p className="flex flex-wrap items-center gap-2 text-caption text-muted">
          {PARTY_TEXT[role].caption} <Address value={accounts[role]} label={`${role} wallet`} />
        </p>
        <Field label="Person type">
          {({ id }) => (
            <select
              id={id}
              className={inputClass}
              value={current.kind}
              onChange={(event) => {
                const kind = event.target.value as PartyKind;
                set(kind === 'legal' ? { kind, dateOfBirth: '', placeOfBirth: '' } : { kind });
              }}
              disabled={disabled}
            >
              <option value="legal">Legal person (company)</option>
              <option value="natural">Natural person</option>
            </select>
          )}
        </Field>
        {input('name', current.kind === 'legal' ? 'Legal name' : 'Full name')}
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          {input('geographicAddress', 'Address', 'Street, city and postal code.')}
          {input('country', 'Country', 'ISO code, e.g. DE.')}
        </div>
        {input(
          'nationalId',
          'National identifier',
          current.kind === 'legal' ? 'LEI or company registration number.' : 'Passport or national ID number.',
        )}
        {current.kind === 'natural' && (
          <div className="grid gap-4 sm:grid-cols-2">
            {input('dateOfBirth', 'Date of birth', undefined, 'date')}
            {input('placeOfBirth', 'Place of birth', 'City and country.')}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {input('vaspName', 'VASP', 'The service provider holding this wallet, or “Self-hosted”.')}
          {input('vaspLei', 'VASP LEI (optional)')}
        </div>
        {identification && showAll && (
          <p role="alert" className="text-sm text-danger-text">
            {identification}
          </p>
        )}
      </fieldset>
    );
  };
  return (
    <div className="grid gap-4">
      {party('originator')}
      {party('beneficiary')}
    </div>
  );
}
