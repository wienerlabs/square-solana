// BC-13: Programların sözleşmeye (idl/*_contract.json, program arayüzü) göre durumu. Program CI'ı bu
// listeden okur:
// - `contract`: program sözleşmeyle yazıldı. Derlenen IDL'i sözleşme IDL'iyle aynı olmalı
//   (`idl-conformance.mjs`); crate'i `cargo fmt --check` ve `cargo clippy -D warnings`'ten geçmeli
//   (`rust-lint.mjs`). Sözleşmenin henüz yazılmamış öğeleri `pending`'de, yazacak issue'yla listelenir:
//   listelenen öğe programda olmamalı, listelenmeyen her öğe sözleşmeyle aynı olmalı.
// - `legacy`: program henüz kaynak projenin arayüzünde. Derlenmeli ve testleri geçmeli; IDL farkları ve
//   lint uyarıları bildirilir, CI'ı düşürmez. Sözleşmeye geçiren ilk issue (`migratedBy`) programı
//   `contract`'a alır.
//
// `name` Anchor.toml [programs.localnet] anahtarı ve `anchor build`'in yazdığı target/idl/<name>.json'dur.

/**
 * @typedef {'instructions' | 'accounts' | 'types' | 'events' | 'errors' | 'constants'} Section
 * @typedef {{ issue: string } & Partial<Record<Section, string[]>>} Pending
 * @typedef {{
 *   name: string,
 *   crate: string,
 *   contract: string,
 *   status: 'contract' | 'legacy',
 *   pending?: Pending[],
 *   migratedBy?: string,
 * }} Program
 */

/** @type {readonly Section[]} */
export const SECTIONS = Object.freeze(['instructions', 'accounts', 'types', 'events', 'errors', 'constants']);

/** @type {readonly Program[]} */
export const PROGRAMS = Object.freeze([
  { name: 'square_policy', crate: 'square-policy', contract: 'square_policy_contract', status: 'contract' },
  { name: 'square_registry', crate: 'square-registry', contract: 'square_registry_contract', status: 'contract' },
  {
    name: 'square_verifier',
    crate: 'square-verifier',
    contract: 'square_verifier_contract',
    status: 'contract',
    pending: [{ issue: 'BC-37 (#78)', instructions: ['verify_mpp_payment_proof', 'update_mpp_authority'] }],
  },
  {
    name: 'square_escrow',
    crate: 'square-escrow',
    contract: 'square_escrow_contract',
    status: 'contract',
    pending: [
      {
        issue: 'BC-25 (#33)',
        instructions: ['list_claim', 'buy_claim', 'cancel_claim'],
        accounts: ['ClaimListing'],
        types: ['ClaimListing', 'ClaimStatus'],
      },
      {
        issue: 'BC-32 (#69)',
        instructions: ['raise_dispute', 'resolve_dispute', 'execute_resolution', 'update_arbitrators'],
      },
      { issue: 'BC-33 (#70)', instructions: ['lapse_dispute', 'escalate_missing_proof'] },
      { issue: 'BC-34 (#71)', instructions: ['commit_travel_rule'] },
    ],
  },
]);
