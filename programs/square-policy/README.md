# Aperture Policy Registry

Anchor program for on-chain policy management. Operators register their compliance policies as Merkle roots on Solana, enabling verifiable policy lookups.

## Instructions

| Instruction | Description |
|-------------|-------------|
| `initialize_operator` | Create operator account (PDA seeded by authority) |
| `register_policy` | Register new policy with Merkle root and data hash |
| `update_policy` | Update existing policy, increment version |
| `deactivate_policy` | Mark policy as inactive |
| `register_policy_multisig` | Register via Squads multisig authority |
| `update_policy_multisig` | Update via Squads multisig authority |

## Account Structure

**OperatorAccount**: authority, name, policy_count, multisig (optional), created_at
**PolicyAccount**: operator, policy_id, merkle_root, policy_data_hash, version, active, timestamps

## Squads Multisig

Operators can assign a Squads Protocol multisig address to their operator account. Once set, the multisig variants of register/update instructions validate that the signer matches the authorized multisig.

## Build & Test

```bash
anchor build -p policy_registry
anchor test
```

## Deploy

```bash
anchor deploy --program-name policy_registry --provider.cluster devnet
```
