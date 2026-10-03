import { Address } from './address';
import { StatusBadge, type Tone } from './status-badge';

/**
 * Bir işlemin yaşam döngüsü. `processed` / `confirmed` / `finalized` Solana'nın commitment
 * seviyeleridir (getSignatureStatuses.confirmationStatus).
 */
export type TxStage = 'signing' | 'sending' | 'processed' | 'confirmed' | 'finalized' | 'failed';

export const TX_STAGES: Readonly<Record<TxStage, { label: string; tone: Tone }>> = {
  signing: { label: 'Waiting for signature', tone: 'neutral' },
  sending: { label: 'Sending', tone: 'info' },
  processed: { label: 'Processed', tone: 'info' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  finalized: { label: 'Finalized', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

const PROGRESS: TxStage[] = ['processed', 'confirmed', 'finalized'];

export function TxConfirmation({ stage, signature, error }: { stage: TxStage; signature?: string; error?: string }) {
  const { label, tone } = TX_STAGES[stage];
  const reached = PROGRESS.indexOf(stage);
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusBadge tone={tone}>{label}</StatusBadge>
        {signature && <Address value={signature} label="signature" />}
      </div>
      {stage !== 'failed' && (
        <ol aria-label="Commitment" className="grid grid-cols-3 gap-2 text-caption">
          {PROGRESS.map((level, index) => (
            <li key={level} className={index <= reached ? 'text-text' : 'text-muted'}>
              <span
                aria-hidden="true"
                className={`mb-1 block h-1 rounded-full ${index <= reached ? 'bg-accent' : 'bg-surface-muted'}`}
              />
              {TX_STAGES[level].label}
              <span className="sr-only">{index <= reached ? ', reached' : ', pending'}</span>
            </li>
          ))}
        </ol>
      )}
      {stage === 'failed' && error && <p className="text-sm text-danger-text">{error}</p>}
    </div>
  );
}
