// Politika taslağı (FE-04, adım 1 ve 5'in kurum tarafı). Taslak, `PolicyDocument`'ın kurumun girdiği
// alanlarıdır; `institution` PDA'sı ve doğrulama ondan türetilir. Tutarlar settlement mint'inin taban
// biriminde, zincirin ve devrenin kullandığı birimle girilir. Politika ve alıcı salt'ları zincire çıkmaz;
// zincire yalnızca commitment, public günlük tavan ve alıcı kökü gider (release-circuit.md §7).
import {
  DAYS_OF_WEEK,
  POLICY_CIRCUIT_LIMITS,
  PolicyDocumentSchema,
  type DayOfWeek,
  type PolicyDocument,
} from '@squaresdk/solana-types';
import { z } from 'zod';
import { isAddress } from './config';

export interface TimeWindowDraft {
  days: DayOfWeek[];
  startHourUtc: number;
  endHourUtc: number;
}

export interface BuyerDraft {
  buyer: string;
  /** Alıcıya özel 32 baytlık salt (hex); `buy_claim` kanıtı için alıcıya verilir. */
  leafSalt: string;
}

export interface PolicyDraft {
  policyId: string;
  version: number;
  maxPerTx: string;
  maxDaily: string;
  dailyCeiling: string;
  tokenWhitelist: string[];
  blockedPayees: string[];
  allowedCategories: string[];
  timeWindow: TimeWindowDraft | null;
  buyers: BuyerDraft[];
}

const HEX32 = /^[0-9a-f]{64}$/;
const U64_MAX = 2n ** 64n - 1n;
/** Alıcı ağacı en fazla 16 seviye (MAX_BUYER_PROOF_DEPTH). */
export const MAX_BUYERS = 2 ** 16;

export const PolicyDraftSchema = z.object({
  policyId: z.string().regex(HEX32),
  version: z.number().int().min(1),
  maxPerTx: z.string(),
  maxDaily: z.string(),
  dailyCeiling: z.string(),
  tokenWhitelist: z.array(z.string()),
  blockedPayees: z.array(z.string()),
  allowedCategories: z.array(z.string()),
  timeWindow: z
    .object({
      days: z.array(z.enum(DAYS_OF_WEEK)),
      startHourUtc: z.number().int(),
      endHourUtc: z.number().int(),
    })
    .nullable(),
  buyers: z.array(z.object({ buyer: z.string(), leafSalt: z.string().regex(HEX32) })),
});

export const bytesToHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('expected lowercase hex');
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** Yeni taslak: politika kimliği rastgele 32 bayt; kurallar boş, kurum doldurur. */
export function newDraft(): PolicyDraft {
  return {
    policyId: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    version: 1,
    maxPerTx: '',
    maxDaily: '',
    dailyCeiling: '',
    tokenWhitelist: [],
    blockedPayees: [],
    allowedCategories: [],
    timeWindow: null,
    buyers: [],
  };
}

export type DraftField =
  | 'maxPerTx'
  | 'maxDaily'
  | 'dailyCeiling'
  | 'tokenWhitelist'
  | 'blockedPayees'
  | 'allowedCategories'
  | 'timeWindow'
  | 'buyers';

export interface DraftCheck {
  /** Belgeyi geçersiz kılan sorunlar; varsa commitment hesaplanmaz. */
  errors: Partial<Record<DraftField, string>>;
  /** Geçerli ama release'leri etkileyen durumlar. */
  warnings: Partial<Record<DraftField, string>>;
}

const utf8Length = (value: string) => new TextEncoder().encode(value).length;
const hasDuplicates = (items: readonly string[]) => new Set(items).size !== items.length;

function amountError(value: string): string | undefined {
  if (value === '') return 'Required.';
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return 'Whole number of base units, without separators.';
  if (BigInt(value) > U64_MAX) return 'Larger than a u64.';
  return undefined;
}

function addressListError(values: readonly string[], max: number, min: number, noun: string): string | undefined {
  if (values.length < min) return `Add at least ${min} ${noun}.`;
  if (values.length > max) return `At most ${max} ${noun}s (circuit slots).`;
  const invalid = values.find((value) => !isAddress(value));
  if (invalid !== undefined) return `Not a Solana address: ${invalid}`;
  if (hasDuplicates(values)) return `Each ${noun} can be listed once.`;
  return undefined;
}

/**
 * Taslağı devrenin sınırlarıyla denetler (`POLICY_CIRCUIT_LIMITS`, `PolicyDocumentSchema`).
 * `settlementMint` biliniyorsa whitelist'te olup olmadığı da bildirilir: escrow yalnızca o mint'le öder.
 */
export function checkDraft(draft: PolicyDraft, settlementMint: string | null): DraftCheck {
  const errors: DraftCheck['errors'] = {};
  const warnings: DraftCheck['warnings'] = {};
  const set = (field: DraftField, message: string | undefined) => {
    if (message) errors[field] = message;
  };

  set('maxPerTx', amountError(draft.maxPerTx));
  set('maxDaily', amountError(draft.maxDaily));
  set('dailyCeiling', amountError(draft.dailyCeiling));
  if (!errors.dailyCeiling && BigInt(draft.dailyCeiling) === 0n) {
    warnings.dailyCeiling = 'A ceiling of 0 refuses every release (fail closed).';
  }
  if (!errors.maxPerTx && !errors.maxDaily && BigInt(draft.maxPerTx) > BigInt(draft.maxDaily)) {
    warnings.maxPerTx = 'Higher than the private daily limit, so the daily limit decides.';
  }

  set('tokenWhitelist', addressListError(draft.tokenWhitelist, POLICY_CIRCUIT_LIMITS.tokenWhitelist, 1, 'mint'));
  if (!errors.tokenWhitelist && settlementMint && !draft.tokenWhitelist.includes(settlementMint)) {
    warnings.tokenWhitelist = 'The settlement mint is not listed, so every release will be refused.';
  }
  set('blockedPayees', addressListError(draft.blockedPayees, POLICY_CIRCUIT_LIMITS.blockedPayees, 0, 'address'));

  const categories = draft.allowedCategories;
  const bytes = POLICY_CIRCUIT_LIMITS.categoryBytes;
  if (categories.length === 0)
    set('allowedCategories', 'Add at least one category; an empty list refuses every release.');
  else if (categories.length > POLICY_CIRCUIT_LIMITS.allowedCategories)
    set('allowedCategories', `At most ${POLICY_CIRCUIT_LIMITS.allowedCategories} categories (circuit slots).`);
  else if (categories.some((c) => utf8Length(c) < 1 || utf8Length(c) > bytes))
    set('allowedCategories', `Each category is 1–${bytes} bytes of UTF-8.`);
  else if (hasDuplicates(categories)) set('allowedCategories', 'Each category can be listed once.');

  const window = draft.timeWindow;
  if (window) {
    if (window.days.length === 0) set('timeWindow', 'Pick at least one day.');
    else if (window.startHourUtc > window.endHourUtc)
      set('timeWindow', 'The window cannot cross midnight UTC: the start hour must not be after the end hour.');
  }

  set(
    'buyers',
    draft.buyers.length > MAX_BUYERS
      ? `At most ${MAX_BUYERS} buyers.`
      : addressListError(
          draft.buyers.map((b) => b.buyer),
          MAX_BUYERS,
          0,
          'buyer',
        ),
  );
  return { errors, warnings };
}

/** Taslak geçerliyse kurumun `PolicyDocument`'ı; değilse null. */
export function draftDocument(draft: PolicyDraft, institution: string): PolicyDocument | null {
  const result = PolicyDocumentSchema.safeParse({
    institution,
    policyId: draft.policyId,
    version: draft.version,
    dailyCeiling: draft.dailyCeiling,
    maxDaily: draft.maxDaily,
    maxPerTx: draft.maxPerTx,
    tokenWhitelist: draft.tokenWhitelist,
    blockedPayees: draft.blockedPayees,
    allowedCategories: draft.allowedCategories,
    timeWindow: draft.timeWindow,
  });
  return result.success ? result.data : null;
}
