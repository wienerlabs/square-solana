import type { PoolClient } from 'pg';
import * as migration001 from './001_create_compliance_tables.js';
import * as migration002 from './002_add_tx_signature.js';
import * as migration003 from './003_add_proof_tx_signature.js';
import * as migration005 from './005_create_verified_payment_intents.js';
import * as migration006 from './006_create_operator_stripe_credentials.js';
import * as migration007 from './007_create_unattested_payments.js';

export interface Migration {
  readonly name: string;
  readonly up: (client: PoolClient) => Promise<void>;
  readonly down: (client: PoolClient) => Promise<void>;
}

/// Ordered list shared by run.ts and rollback.ts so a rollback always knows
/// every migration the runner can apply.
export const migrations: readonly Migration[] = [
  { name: '001_create_compliance_tables', ...migration001 },
  { name: '002_add_tx_signature', ...migration002 },
  { name: '003_add_proof_tx_signature', ...migration003 },
  { name: '005_create_verified_payment_intents', ...migration005 },
  { name: '006_create_operator_stripe_credentials', ...migration006 },
  { name: '007_create_unattested_payments', ...migration007 },
];
