import bs58 from 'bs58';
import { buildPoseidon } from 'circomlibjs';

let poseidonInstance = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

// Split a 32-byte buffer into two BN254 field elements. BN254 elements are
// ~254 bits, so a 256-bit value cannot fit into a single element. Splitting
// into 16-byte halves (high || low) keeps both halves safely under the prime.
export function splitBytes(buffer) {
  if (buffer.length !== 32) {
    throw new Error(`Expected 32-byte buffer, got ${buffer.length}`);
  }
  const high = BigInt('0x' + buffer.subarray(0, 16).toString('hex'));
  const low = BigInt('0x' + buffer.subarray(16, 32).toString('hex'));
  return [high, low];
}

// Decode a base58-encoded Solana pubkey or mint into a 32-byte raw Buffer.
export function decodeAddress32(base58String) {
  const raw = Buffer.from(bs58.decode(base58String));
  if (raw.length !== 32) {
    throw new Error(
      `Address must decode to 32 bytes, got ${raw.length}: ${base58String}`,
    );
  }
  return raw;
}

// Poseidon-hash a base58 Solana pubkey into a single BN254 field. Used for
// list-membership entries (token_whitelist[i], blocked_addresses[i]) and for
// the operator_id_field input the circuit folds into policy_data_hash.
export async function hashSolanaAddress(base58String) {
  const raw = decodeAddress32(base58String);
  const [high, low] = splitBytes(raw);
  const poseidon = await getPoseidon();
  const hash = poseidon([high, low]);
  return poseidon.F.toString(hash);
}

// Poseidon-hash an ASCII category string. Categories are short so we right-
// pad to 32 bytes before splitting.
export async function hashCategory(categoryString) {
  const utf8 = Buffer.from(categoryString, 'utf8');
  if (utf8.length > 32) {
    throw new Error(`Category too long (>32 bytes): ${categoryString}`);
  }
  const padded = Buffer.alloc(32);
  utf8.copy(padded);
  const [high, low] = splitBytes(padded);
  const poseidon = await getPoseidon();
  const hash = poseidon([high, low]);
  return poseidon.F.toString(hash);
}

// Poseidon-hash a UUID v4 string into a single field. The UUID is 16 raw
// bytes; we pad to 32 (high half = uuid bytes, low half = zeros) before
// splitting so the circuit sees the same shape any other 32-byte value uses.
export async function hashUuid(uuidString) {
  const cleaned = uuidString.replace(/-/g, '');
  if (cleaned.length !== 32 || !/^[0-9a-f]+$/i.test(cleaned)) {
    throw new Error(`Invalid UUID: ${uuidString}`);
  }
  const raw16 = Buffer.from(cleaned, 'hex');
  const padded = Buffer.alloc(32);
  raw16.copy(padded, 0);
  const [high, low] = splitBytes(padded);
  const poseidon = await getPoseidon();
  const hash = poseidon([high, low]);
  return poseidon.F.toString(hash);
}

// Pad a string list to `maxLength` by hashing each entry and zero-padding the
// tail. Returns both the hashed array and a matching mask array (1 for active
// slots, 0 for padding).
async function padList(values, maxLength, hasher) {
  if (values.length > maxLength) {
    throw new Error(
      `List of size ${values.length} exceeds circuit max of ${maxLength}`,
    );
  }
  const hashed = [];
  const mask = [];
  for (const value of values) {
    hashed.push(await hasher(value));
    mask.push('1');
  }
  while (hashed.length < maxLength) {
    hashed.push('0');
    mask.push('0');
  }
  return { values: hashed, mask };
}

export async function padAddressList(addresses, maxLength) {
  return padList(addresses, maxLength, hashSolanaAddress);
}

export async function padCategoryList(categories, maxLength) {
  return padList(categories, maxLength, hashCategory);
}

// Map a list of weekday names ("monday".."sunday") to the 7-bit mask the
// circuit consumes. Throws on unknown names so the prover never silently
// downgrades a restriction.
const DAY_INDEX = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

export function daysToBitmask(days) {
  let mask = 0;
  for (const d of days) {
    const idx = DAY_INDEX[String(d).toLowerCase()];
    if (idx === undefined) throw new Error(`Unknown day name: ${d}`);
    mask |= 1 << idx;
  }
  return mask;
}
