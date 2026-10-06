'use client';

import { useId, type ReactNode } from 'react';
import { Address } from '@/components/ui/address';
import {
  IDENTIFIER_LABELS,
  IDENTIFIER_TYPES,
  type PersonForm,
  type PersonKind,
  type PersonRole,
  type TravelRuleForm,
  type VaspForm,
  type VaspRole,
} from '@/lib/travel-rule';

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

const PERSON_TEXT: Readonly<Record<PersonRole, { legend: string; caption: string }>> = {
  originator: { legend: 'Originator', caption: 'Your institution, paying from' },
  beneficiary: { legend: 'Beneficiary', caption: 'The agent’s operator, paid at' },
};

const VASP_TEXT: Readonly<Record<VaspRole, { legend: string; hint: string }>> = {
  originatingVasp: {
    legend: 'Originating VASP (optional)',
    hint: 'The service provider holding the paying wallet. Leave empty for a self-hosted wallet.',
  },
  beneficiaryVasp: {
    legend: 'Beneficiary VASP (optional)',
    hint: 'The service provider holding the paid wallet. Leave empty for a self-hosted wallet.',
  },
};

type PersonText = Exclude<keyof PersonForm, 'kind' | 'idType'>;

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
  accounts: Readonly<Record<PersonRole, string>>;
  disabled?: boolean;
}) {
  const shown = (path: string, filled: boolean) => {
    const message = errors[path];
    return message && (showAll || filled) ? message : null;
  };

  const person = (role: PersonRole) => {
    const current = value[role];
    const set = (patch: Partial<PersonForm>) => onChange({ ...value, [role]: { ...current, ...patch } });
    const input = (key: PersonText, label: string, hint?: string, type = 'text') => (
      <Field label={label} hint={hint} error={shown(`${role}.${key}`, current[key].trim() !== '')}>
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
    const natural = current.kind === 'natural';
    const identification = errors[`${role}.identification`];
    return (
      <fieldset key={role} className="grid gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{PERSON_TEXT[role].legend}</legend>
        <p className="flex flex-wrap items-center gap-2 text-caption text-muted">
          {PERSON_TEXT[role].caption} <Address value={accounts[role]} label={`${role} wallet`} />
        </p>
        <Field label="Person type">
          {({ id }) => (
            <select
              id={id}
              className={inputClass}
              value={current.kind}
              onChange={(event) => {
                const kind = event.target.value as PersonKind;
                set(kind === 'legal' ? { kind, secondaryIdentifier: '', dateOfBirth: '', placeOfBirth: '' } : { kind });
              }}
              disabled={disabled}
            >
              <option value="legal">Legal person (company)</option>
              <option value="natural">Natural person</option>
            </select>
          )}
        </Field>
        {natural ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {input('primaryIdentifier', 'Last name')}
            {input('secondaryIdentifier', 'First names')}
          </div>
        ) : (
          input('primaryIdentifier', 'Legal name')
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {input('street', 'Street and number')}
          {input('city', 'City')}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {input('postcode', 'Postal code')}
          {input('country', 'Country', 'ISO code, e.g. DE.')}
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_8rem]">
          <Field label="Identifier type" error={shown(`${role}.idType`, current.idType !== '')}>
            {({ id, describedBy, invalid }) => (
              <select
                id={id}
                className={inputClass}
                value={current.idType}
                onChange={(event) =>
                  set({
                    idType: event.target.value as PersonForm['idType'],
                    ...(event.target.value === 'LEIX' && { idCountry: '' }),
                  })
                }
                aria-describedby={describedBy}
                aria-invalid={invalid}
                disabled={disabled}
              >
                <option value="">None</option>
                {IDENTIFIER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {IDENTIFIER_LABELS[type]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {input('idValue', 'Identifier')}
          {current.idType !== 'LEIX' && input('idCountry', 'Issued in', 'ISO code.')}
        </div>
        {natural && (
          <div className="grid gap-4 sm:grid-cols-2">
            {input('dateOfBirth', 'Date of birth', undefined, 'date')}
            {input('placeOfBirth', 'Place of birth', 'City and country.')}
          </div>
        )}
        {input('countryOfResidence', 'Country of residence (optional)', 'ISO code.')}
        {identification && showAll && (
          <p role="alert" className="text-sm text-danger-text">
            {identification}
          </p>
        )}
      </fieldset>
    );
  };

  const provider = (role: VaspRole) => {
    const current = value[role];
    const set = (patch: Partial<VaspForm>) => onChange({ ...value, [role]: { ...current, ...patch } });
    const input = (key: keyof VaspForm, label: string) => (
      <Field label={label} error={shown(`${role}.${key}`, current[key].trim() !== '')}>
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
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
    return (
      <fieldset key={role} className="grid gap-4 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{VASP_TEXT[role].legend}</legend>
        <p className="text-caption text-muted">{VASP_TEXT[role].hint}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {input('name', 'Name')}
          {input('lei', 'LEI')}
        </div>
      </fieldset>
    );
  };

  return (
    <div className="grid gap-4">
      {person('originator')}
      {provider('originatingVasp')}
      {person('beneficiary')}
      {provider('beneficiaryVasp')}
    </div>
  );
}
