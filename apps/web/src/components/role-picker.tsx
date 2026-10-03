'use client';

import { ROLES, ROLE_INFO, roleSteps } from '@/lib/roles';
import { useRole } from './role-provider';

export function RolePicker() {
  const { address, role, setRole } = useRole();
  return (
    <section aria-labelledby="role-heading" className="rounded-card border border-border bg-surface p-6">
      <h2 id="role-heading" className="text-sm font-medium uppercase tracking-wide text-muted">
        Role
      </h2>
      <p className="mt-2 text-sm text-muted">
        {address
          ? 'Choose how this wallet takes part. The choice is remembered for this wallet in this browser.'
          : 'Connect a wallet to choose a role.'}
      </p>
      <fieldset disabled={!address} className="mt-4 grid gap-3 sm:grid-cols-3">
        <legend className="sr-only">Role for this wallet</legend>
        {ROLES.map((option) => {
          const steps = roleSteps(option);
          return (
            <label
              key={option}
              className="flex cursor-pointer flex-col gap-1.5 rounded-card border border-border p-4 has-checked:border-accent has-checked:bg-surface-muted has-disabled:cursor-not-allowed has-disabled:opacity-60"
            >
              <span className="flex items-center gap-2 font-medium">
                <input
                  type="radio"
                  name="role"
                  value={option}
                  checked={role === option}
                  onChange={() => setRole(option)}
                  className="accent-accent"
                />
                {ROLE_INFO[option].label}
              </span>
              <span className="text-caption text-muted">{ROLE_INFO[option].summary}</span>
              <span className="text-caption text-muted">
                {steps.length === 1 ? 'Step' : 'Steps'} {steps.join(', ')}
              </span>
            </label>
          );
        })}
      </fieldset>
    </section>
  );
}
