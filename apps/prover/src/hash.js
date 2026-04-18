import bs58 from 'bs58';
import { buildPoseidon } from 'circomlibjs';

let poseidonInstance = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

// Split a 32-byte buffer into two field elements. BN254 elements are ~254 bits,
// so a 256-bit value cannot fit into a single element. Splitting into 16-byte
// halves keeps both halves safely under the prime.
function splitBytes(buffer) {
  if (buffer.length !== 32) {
    throw new Error(`Expected 32-byte buffer, got ${buffer.length}`);
  }
  const high = BigInt('0x' + buffer.subarray(0, 16).toString('hex'));
  const low = BigInt('0x' + buffer.subarray(16, 32).toString('hex'));
  return [high, low];
}

// Decode a base58-encoded Solana pubkey or mint into a single BN254 field
// element by Poseidon-hashing the two halves of its 32 raw bytes. The return
// type matches what the Circom circuit expects as `payment_token`,
// `payment_recipient`, etc.
export async function hashSolanaAddress(base58String) {
  const raw = Buffer.from(bs58.decode(base58String));
  if (raw.length !== 32) {
    throw new Error(
      `Address must decode to 32 bytes, got ${raw.length}: ${base58String}`,
    );
  }
  const [high, low] = splitBytes(raw);
  const poseidon = await getPoseidon();
  const hash = poseidon([high, low]);
  return poseidon.F.toString(hash);
}

// Hash an ASCII category string (e.g., "compute", "storage") into a field
// element. Categories are short so we right-pad to 32 bytes before splitting.
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
