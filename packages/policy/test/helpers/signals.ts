/** Release devresinin public sinyal adları, devre sırasıyla (release-circuit.md §2). */
export const PUBLIC_SIGNAL_NAMES = [
  'refusal_code',
  'policy_commitment',
  'daily_ceiling',
  'payee_high',
  'payee_low',
  'net_amount',
  'mint_high',
  'mint_low',
  'daily_spent_before',
  'current_unix_timestamp',
  'job_high',
  'job_low',
  'stripe_receipt_hash',
] as const;
