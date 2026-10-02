# `did:aip` v2 — Solana Profile (CAIP-2)

**Status:** Draft
**Profile of:** [`did:aip` v2.0][v2] (Wiener Labs), which anchors agent identity in ERC-8004 registries on EVM chains
**Replaces, on Solana:** [`did:aip` v1.0][v1], whose identifiers stay resolvable (§9)
**Editors:** Wiener Labs
**Implemented by:** `square_registry` (BC-15) and `@squaresdk/solana-identity` (BE-09) in this repository
**Test vectors:** [`test-vectors.json`](./test-vectors.json)

---

## Abstract

`did:aip` v2 names an agent by the registry that holds it and the agent's identifier in that
registry: `did:aip:{namespace}:{chain}:{registry}:{agent}`. v2 defines this for EVM chains only. This
profile defines the `solana` namespace: the chain is a CAIP-2 Solana reference, the registry is a
Solana program, and the agent is the address of the agent's record account in that program.

Everything the profile does not restate is inherited from v2. Where v2 relies on EVM specifics
(ERC-721 ownership, an Agent URI with no on-chain integrity, secp256k1 accounts), this profile
replaces them with what a Solana program can provide: a program-derived record address, an
Ed25519 owner key, and an on-chain hash of the agent card.

---

## 1. Introduction

### 1.1 Why a Solana profile

v1 anchored `did:aip` in a Solana program. v2 moved the anchor to ERC-8004 and kept v1 resolvable
for continuity. Square, on Solana, needs an agent identity that its programs can reference
directly: the escrow binds a job to the agent that does the work (BC-22), and reputation and
validation records are written to the agent rather than to a wallet (BC-26). That anchor has to
live on Solana, and it should use the v2 shape rather than v1's, so that one resolver contract and
one cross-registration model cover both ecosystems.

### 1.2 What is inherited and what changes

| Topic | v2 (EVM) | This profile (Solana) |
|---|---|---|
| Identifier shape | `did:aip:eip155:{chainId}:{registry}:{agentId}` | `did:aip:solana:{chain-ref}:{registry}:{agent-record}` (§3) |
| Chain | EIP-155 chain id, decimal | CAIP-2 reference: first 32 characters of the base58 genesis hash |
| Registry | ERC-8004 Identity Registry, lowercase hex | registry program id, base58 |
| Agent | ERC-721 `tokenId`, assigned by the registry | AgentRecord address, a PDA derived from the registrant and a slug (§3.4) |
| Owner key | known only as an address | the address **is** the Ed25519 public key, emitted when it is on the curve (§5.2) |
| Agent card | Agent URI, no on-chain integrity | URI **and SHA-256** on-chain; a mismatching card is not used (§5.5) |
| Deactivation | token burned, or `active: false` in the file | registry tombstone, or `active: false` in the card (§5.6) |
| Version discrimination, resolver never throws, cross-registration round trip | v2 §9.1, §6, §8 | unchanged |

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, MAY are to be interpreted as described in
[RFC 2119] and [RFC 8174].

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Cluster** | A Solana network (mainnet-beta, devnet, testnet, or a private cluster), identified by its genesis hash |
| **Chain reference** | The CAIP-2 reference of a cluster: the first 32 characters of its base58 genesis hash ([CAIP-2 Solana][caip2-solana]) |
| **Registry** | A Solana program that keeps AgentRecords and satisfies §4.2. In this repository, `square_registry` |
| **AgentRecord** | The account, owned by the Registry, that holds one agent's on-chain state (§4.1) |
| **Registrant** | The account that signed the registration. Fixed for the life of the record |
| **Owner** | The account that currently controls the record. Starts as the Registrant; transferable |
| **Agent wallet** | Where the agent is paid. Defaults to the Owner |
| **Agent card** | The JSON document the record's card URI resolves to. Its schema is defined by `@squaresdk/solana-identity` (BE-09); this profile reads only `services` and `active` |
| **On the curve** | 32 bytes that decode to a point on edwards25519 ([RFC 8032] §5.1.3). Wallet keys are; PDAs are not |

---

## 3. Method Syntax

### 3.1 Method-specific identifier (Normative)

```abnf
did-aip-solana = "did:aip:solana:" chain-ref ":" registry ":" agent-record

chain-ref      = 32base58char         ; CAIP-2 Solana reference
registry       = 32*44base58char      ; registry program id: 32 bytes, base58
agent-record   = 32*44base58char      ; AgentRecord address: 32 bytes, base58

base58char     = %x31-39 / %x41-48 / %x4A-4E / %x50-5A / %x61-6B / %x6D-7A
               ; 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
```

This extends the `namespace` production of v2 §3.2 with `"solana"`. The string
`"solana:" chain-ref ":" registry` is the agent's `agentRegistry` (§3.5), so the identifier keeps
v2's structure: `did:aip:` + `agentRegistry` + `:` + agent identifier.

### 3.2 Validation (Normative)

A conforming implementation MUST reject, with `invalidDid`, a DID in the `solana` namespace where:

- the method-specific identifier does not have exactly four colon-separated segments;
- `chain-ref` is not exactly 32 base58 characters;
- `registry` or `agent-record` is not between 32 and 44 base58 characters, **or does not decode to
  exactly 32 bytes**. The length check alone is not enough: a 43-character string can decode to 31
  bytes, and a leading `1` adds a zero byte, so `1` followed by a valid 43-character address is 44
  characters long and decodes to 33.

Base58 is case-sensitive; no segment is normalised. Because an encoding of exactly 32 bytes is
unique, the rules above make the DID string canonical: two DIDs name the same agent if and only if
they are equal as strings, as DID Core requires.

`namespace` is case-sensitive: `Solana` is rejected. A syntactically valid `chain-ref` that the
resolver has no endpoint for is **not** a syntax error; it is reported as `unsupportedChain` (§6.3).

A resolver that implements v2 but not this profile rejects these DIDs under v2 §3.2. Such a
resolver SHOULD report `unsupportedChain` instead, because the identifier is well-formed under the
method.

### 3.3 Examples

```
did:aip:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:4sAy8cfTmn581JQLCzqHpQDhkKNutvTBamvX8UqqGKCK:4VqS6uu2WPDR6EjpXDBKZxs9tjwc4WtksjXziWXcd6zk
did:aip:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:4sAy8cfTmn581JQLCzqHpQDhkKNutvTBamvX8UqqGKCK:4VqS6uu2WPDR6EjpXDBKZxs9tjwc4WtksjXziWXcd6zk
```

The first is on devnet, the second on mainnet-beta. The registry is a test program id from the test
vectors, not a deployed program. Both name a record derived from the same registrant and slug: a
PDA depends only on the program id and the seeds, so the address is the same on every cluster, and
only `chain-ref` tells the two agents apart.

| Cluster | Chain reference | Genesis hash |
|---|---|---|
| mainnet-beta | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` |
| devnet | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| testnet | `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` | `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY` |

### 3.4 The agent identifier is the record address

The last segment is the address of the AgentRecord account:

```
agent-record = find_program_address(["agent", registrant, agent_id], registry).address
```

where `registrant` is the 32-byte key of the account that signed the registration and `agent_id` is
an owner-chosen slug, `[A-Za-z0-9_-]{1,32}`, as UTF-8 bytes. These are the seeds of the v1 registry,
kept so that a v1 operator recognises them.

The slug alone is not an identifier: it is unique only per registrant, and two registrants may both
own a `scribe`. Putting both the registrant and the slug in the DID would need five segments and
break v2's segment-count discrimination (v2 §9.1). The record address carries both, in one segment,
and it is also the key the escrow and reputation programs use to refer to the agent. So the DID
names the agent by the same 32 bytes the rest of Square does.

### 3.5 `agentRegistry` and the agent identifier outside the DID

Where an ERC-8004-style pair is needed (v2 §8, the agent card's `registrations[]`):

| | Value |
|---|---|
| `agentRegistry` | `solana:{chain-ref}:{registry}`, the CAIP-2 chain followed by the program id |
| `agentId` | the AgentRecord address, base58, as a **string** |

The mapping to a DID is `did:aip:` + `agentRegistry` + `:` + `agentId`, and it is total and
injective in both directions, as in v2 §1.3.

---

## 4. The AgentRecord

### 4.1 Logical view (Normative)

A resolver reads the following fields. Their byte layout is the registry's IDL (BC-15, BC-44); this
profile fixes their meaning, not their encoding.

| Field | Type | Meaning |
|---|---|---|
| `registrant` | 32 bytes | Signer of the registration. PDA seed. Immutable |
| `agent_id` | string, `[A-Za-z0-9_-]{1,32}` | Owner-chosen slug. PDA seed. Immutable |
| `bump` | u8 | Canonical bump of the record PDA |
| `owner` | 32 bytes | Current controller |
| `agent_wallet` | 32 bytes | Payment destination; MAY equal `owner` |
| `agent_card_uri` | string | MAY be empty |
| `agent_card_hash` | 32 bytes | SHA-256 of the agent card's bytes; all zero when the URI is empty |
| `status` | `active` \| `deactivated` | §5.6 |
| `registered_at`, `updated_at` | i64, Unix seconds | Cluster time of creation and of the last change |

### 4.2 Registry requirements (Normative)

A program is a Registry under this profile only if all of the following hold. Resolution relies on
each of them.

1. **No DID string on-chain.** The registry MUST NOT accept or store a DID string. The DID is a
   function of the cluster, the program id and the record address, and a program cannot read its
   cluster's genesis hash, so it could not check a supplied string anyway. Events carry the record
   address; indexers and clients derive the DID.
2. **Fixed seeds.** The record address MUST be derived as in §3.4 and MUST NOT change for the life
   of the record. `registrant` and `agent_id` MUST NOT change.
3. **No reuse.** The registry MUST NOT close an AgentRecord. Deregistration sets `status` to
   `deactivated` and leaves the account in place, permanently: a deactivated record MUST NOT become
   active again. Otherwise a closed record could be registered again at the same address and its
   DID would name a different agent, which v1 allowed (v1 §5.4) and this profile does not.
4. **Card and hash move together.** `agent_card_uri` and `agent_card_hash` MUST be written in the
   same instruction. An empty URI MUST come with an all-zero hash.
5. **Transfer resets the wallet.** An ownership transfer MUST set `agent_wallet` to the new owner,
   as ERC-8004 does on transfer (v2 §4.4). Payments then never follow an identity to a wallet its
   new owner did not choose.
6. **Only the owner mutates.** Update, transfer and deregistration MUST require the owner's
   signature. The owner may be a program-derived address that signs through its own program, for
   example a Squads vault.

---

## 5. DID Document Construction

### 5.1 Properties (Normative)

| Property | Value |
|---|---|
| `@context` | `["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/ed25519-2020/v1"]` |
| `id` | The DID, byte-identical to the input after §3.2 validation |
| `controller` | `did:pkh:solana:{chain-ref}:{owner}` (§5.3) |
| `verificationMethod` | §5.2 |
| `authentication` | `["{did}#owner"]` when `#owner` exists, otherwise `[]` |
| `capabilityInvocation` | `["{did}#owner"]` when `#owner` exists, otherwise `[]` |
| `assertionMethod` | `#owner` and `#agent-wallet`, each when it exists, in that order |
| `service` | §5.4 |

Every property above is present in every document, with empty arrays where nothing applies, so
that documents compare deterministically.

### 5.2 Verification methods

A Solana address that is on the curve is an Ed25519 public key, so unlike v2 the key itself can be
published, not only the account. For `owner` and for `agent_wallet`, each independently, when the
address is on the curve the resolver MUST emit:

```json
{
  "id": "{did}#owner",
  "type": "Ed25519VerificationKey2020",
  "controller": "{did}",
  "publicKeyMultibase": "z{base58btc(0xed 0x01 || address bytes)}"
}
```

with `#agent-wallet` for the agent wallet. `publicKeyMultibase` is the multicodec `ed25519-pub` form
(`z6Mk…`), the same value as the method-specific identifier of the key's `did:key`.

When the address is **not** on the curve (a PDA, such as a Squads vault or another program's
account), it has no private key and nothing can be verified against it. The resolver MUST NOT emit
a verification method for it. The address remains visible in `didDocumentMetadata.owner` or
`didDocumentMetadata.agentWallet` (§6.2). An agent whose owner is a PDA therefore has empty
`authentication` and `capabilityInvocation`: its control is exercised on-chain through the owning
program, and an off-chain verifier has no key to check.

`#agent-wallet` is referenced from `assertionMethod` only, for the reason v2 §4.4 gives: control of
a payment destination is not authority over the identity. When the two addresses are equal, both
methods are emitted (v2 §4.6).

### 5.3 `controller`

`controller` is the current owner as a [`did:pkh`][did-pkh] DID, as in v2 §4.3:
`did:pkh:` followed by the owner's [CAIP-10][caip10-solana] account id. It follows the owner across
transfers; the DID does not change. The `did:pkh` draft's Solana example uses an older chain
reference (`4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ`); this profile always uses the CAIP-2 reference of
§3.3.

### 5.4 Services

The `service` array is built in this order:

1. If `agent_card_uri` is non-empty, `{"id": "{did}#agent-card", "type": "AIPAgentCard",
   "serviceEndpoint": agent_card_uri}`. This entry comes from on-chain state and is emitted whether
   or not the card can be read.
2. If the card is `verified` (§5.5), one entry per element of its `services` array, by the rule of
   v2 §4.5: `id` is `{did}#{name-slug}`, `type` is `name`, `serviceEndpoint` is `endpoint`. A `DID`
   entry whose endpoint is the DID being resolved is omitted. `#agent-card` counts as already used
   when suffixes are assigned, so a card service named `Agent Card` becomes `#agent-card-2`.

The A2A endpoint is the card service named `A2A`, so it appears as `{did}#a2a`.

### 5.5 Agent card integrity (Normative)

The resolver dereferences `agent_card_uri` and computes SHA-256 over the **exact bytes** received
(after transport decoding such as gzip). Then:

| Outcome | `didDocumentMetadata.agentCard` | Warning code | Card services |
|---|---|---|---|
| URI empty | `absent` | — | none |
| URI could not be dereferenced, or the scheme is not supported | `unavailable` | `agentCardUnreachable` | none |
| Hash differs from `agent_card_hash` | `unverified` | `agentCardHashMismatch` | none |
| Hash matches, but the bytes are not a valid card | `invalid` | `agentCardInvalid` | none |
| Hash matches and the card is valid | `verified` | — | §5.4 |

For resolution, a card is valid when it is a JSON object; `services`, if present, is an array of
objects each with a string `name` and a string `endpoint`; and `active`, if present, is a boolean.
Validity is all-or-nothing: a card with one malformed service is invalid as a whole, so that two
resolvers never emit different subsets of it.

None of these outcomes is a resolution error. On-chain state is authoritative for identity and the
card only enriches it (v2 §5).

The hash makes the card a commitment, which v2 cannot offer (v2 §10.3): an `https` card can no
longer change without an on-chain update, and a resolver that sees a different file says so. For an
`ipfs://` URI with a CIDv1 of the `raw` codec and a `sha2-256` multihash, the CID's digest equals
`agent_card_hash`, so the two commitments can be checked against each other.

Resolvers MUST support `https`, SHOULD support `ipfs` (through a gateway they choose), and SHOULD
bound the size of the response. `didDocumentMetadata.agentCardUriScheme` reports the URI's scheme,
lowercase, whenever the URI is non-empty.

### 5.6 Deactivation (Normative)

| Source | Authority | Document | Metadata |
|---|---|---|---|
| `status = deactivated` | On-chain, final (§4.2.3) | `verificationMethod`, `authentication`, `capabilityInvocation`, `assertionMethod` and `service` are empty; the card is not fetched | `deactivated: true`, `deactivation: "registry"` |
| Verified card with `active: false` | Owner's claim, reversible | Unchanged | `deactivated: true`, `deactivation: "agentCard"` |

As in v2 §7.4, the two MUST be distinguished: a consumer deciding whether to pay an agent needs to
know whether the identity is gone or merely parked. `deactivated` is absent when neither applies.

### 5.7 Example

For the first DID of §3.3, with owner and agent wallet both the on-curve key
`uRBJTVBUYM4H5dQHSUWSU5VaxJK8ApMBAQdHm1fDCuM` and a verified card that lists `A2A`, `MCP` and its own
DID (`{did}` abbreviates the DID; the full document is case `active-verified-card` of the test
vectors):

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1"
  ],
  "id": "{did}",
  "controller": "did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:uRBJTVBUYM4H5dQHSUWSU5VaxJK8ApMBAQdHm1fDCuM",
  "verificationMethod": [
    {
      "id": "{did}#owner",
      "type": "Ed25519VerificationKey2020",
      "controller": "{did}",
      "publicKeyMultibase": "z6MkfMgDthjcp5qXPaU6y1SMHZdVQXaAY44hsBKZ82yg8Rgj"
    },
    {
      "id": "{did}#agent-wallet",
      "type": "Ed25519VerificationKey2020",
      "controller": "{did}",
      "publicKeyMultibase": "z6MkfMgDthjcp5qXPaU6y1SMHZdVQXaAY44hsBKZ82yg8Rgj"
    }
  ],
  "authentication": ["{did}#owner"],
  "capabilityInvocation": ["{did}#owner"],
  "assertionMethod": ["{did}#owner", "{did}#agent-wallet"],
  "service": [
    { "id": "{did}#agent-card", "type": "AIPAgentCard", "serviceEndpoint": "https://scribe.example/.well-known/aip-card.json" },
    { "id": "{did}#a2a", "type": "A2A", "serviceEndpoint": "https://scribe.example/a2a" },
    { "id": "{did}#mcp", "type": "MCP", "serviceEndpoint": "https://scribe.example/mcp" }
  ]
}
```

---

## 6. Resolution (Normative)

### 6.1 Algorithm

```
resolve(did):
  1. Parse per v2 §9.1: two segments → v1 (§9.2); four segments with namespace "eip155" → v2;
     four segments with namespace "solana" → continue; anything else → error "invalidDid".
  2. Validate per §3.2. On failure → error "invalidDid".
  3. Select an RPC endpoint for chain-ref. None configured → error "unsupportedChain".
     Before using it, getGenesisHash MUST start with chain-ref; re-check after any failover.
  4. If the resolver keeps a registry allowlist and registry is not on it → error "registryNotAllowed".
  5. getAccountInfo(agent-record) at commitment "confirmed" or stronger.
     The RPC call fails → error "networkError".
     No account → error "notFound".
  6. The account's owner program is not registry, or its data does not start with the
     AgentRecord discriminator of the registry's IDL → error "notFound".
  7. Decode the record per the IDL. Failure → error "internalError".
  8. create_program_address(["agent", registrant, agent_id, [bump]], registry) MUST equal
     agent-record. Otherwise → error "notFound".
  9. If status = deactivated → build the document of §5.6 and go to 12.
 10. If agent_card_uri is non-empty → fetch and classify the card per §5.5.
 11. Build the document per §5.
 12. Return it with the metadata of §6.2.
```

Steps 5 and 10 are the only network operations; step 5 is one RPC call. A resolver MUST NOT throw:
every failure is reported in `didResolutionMetadata.error`, as in v2 §6.

Step 8 is not redundant with step 6. The owner check proves the registry wrote the account; the
derivation check proves the account is the one §3.4 names, so a registry bug that wrote a record at
an unexpected address cannot produce a DID that resolves.

### 6.2 Resolution metadata

| Field | Value |
|---|---|
| `didResolutionMetadata.contentType` | `application/did+ld+json` |
| `didResolutionMetadata.warnings` | `[{code, message}]`, present when non-empty: the codes of §5.5 |
| `didDocumentMetadata.versionId` | The slot the account was read at (`context.slot` of the RPC response), as a decimal string |
| `didDocumentMetadata.created`, `.updated` | `registered_at`, `updated_at` as UTC date-times without fractional seconds (`2026-09-21T14:13:20Z`) |
| `didDocumentMetadata.deactivated`, `.deactivation` | §5.6 |
| `didDocumentMetadata.agentRegistry` | `solana:{chain-ref}:{registry}` (§3.5) |
| `didDocumentMetadata.owner` | The owner's CAIP-10 account id, present whether or not it is on the curve |
| `didDocumentMetadata.agentWallet` | The agent wallet's CAIP-10 account id, likewise |
| `didDocumentMetadata.agentCard` | `absent` \| `unavailable` \| `unverified` \| `invalid` \| `verified` (§5.5); the field is omitted for a registry-deactivated record, whose card is not fetched |
| `didDocumentMetadata.agentCardUriScheme` | §5.5 |
| `didDocumentMetadata.crossRegistrations` | As v2 §6.1, with §8 |

`versionId` is a slot for the reason v2 gives for using a block number: it identifies the state
exactly. A consumer authorising a payment SHOULD read at commitment `finalized`.

### 6.3 Errors

`invalidDid`, `notFound`, `internalError` and `representationNotSupported` are those of DID
Resolution. `unsupportedVersion`, `unsupportedChain`, `registryNotAllowed` and `networkError` are
v2's. A deactivated DID is not an error.

---

## 7. DID Operations (Normative)

Like v2, this method has no operations of its own: each is an instruction of the Registry. The
instruction names below are descriptive; the registry's IDL (BC-15, BC-44) gives the real ones.

### 7.1 Create

The registrant signs a registration with `agent_id`, and optionally `agent_wallet`,
`agent_card_uri` and `agent_card_hash`. The registry creates the AgentRecord at the address of
§3.4 with `owner = registrant`, `status = active`, and `agent_wallet = owner` unless given.

The DID can be computed before the transaction: the seeds include the registrant's key, so no one
else can create that record, and if the record already exists the transaction fails. Still, a
creator MUST NOT treat the DID as existing until the transaction is confirmed (v2 §7.1).

A natural choice of `agent_card_hash` is to publish the card first, hash it, and register with
both, so the card is verified from the first resolution.

### 7.2 Read

§6.

### 7.3 Update

The owner may change `agent_wallet`, and `agent_card_uri` together with `agent_card_hash`. The DID
does not change; `updated_at` does.

### 7.4 Transfer

The owner may transfer the record to a new owner. The DID does not change, because it derives from
the registrant, not from the owner. `controller` and `#owner` follow the new owner, and
`agent_wallet` is reset to it (§4.2.5). See §10.2.

### 7.5 Deactivate

The owner sets `status = deactivated` (§4.2.3, §5.6). This is final. To pause an agent reversibly,
the owner sets `"active": false` in the card instead.

---

## 8. Cross-chain Registrations

v2 §8 applies unchanged, with §3.5 defining the Solana form of a registration:

```json
"registrations": [
  {
    "agentId": "4VqS6uu2WPDR6EjpXDBKZxs9tjwc4WtksjXziWXcd6zk",
    "agentRegistry": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:4sAy8cfTmn581JQLCzqHpQDhkKNutvTBamvX8UqqGKCK"
  }
]
```

A Solana `agentId` is a base58 string, never a number. An agent card schema that restricts
`agentRegistry` to `eip155` (as Arc's does) has to be widened to accept this form; BE-09 defines the
schema for this repository.

---

## 9. Versions, v1 and Legacy Identifiers

### 9.1 Discrimination

By segment count, as v2 §9.1: two segments are v1, four are v2. In v2, the namespace segment then
selects `eip155` (v2) or `solana` (this profile).

### 9.2 v1 resolution

A resolver of this profile SHOULD support v1, because v1 DIDs exist only on Solana. It resolves
them per the [v1 specification][v1] and MUST set `didDocumentMetadata.deprecated = true` (v2 §9.2).

Facts a v1 implementation needs and the v1 specification does not give:

- The only v1 deployment is program `CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc` on **devnet**.
  v1 identifiers carry no network qualifier (v1 §6.3), so the resolver MUST use devnet for them.
- The live account layout is that of [`dr-wilson-empty/aip-beta` at c427872][v1-registry]: 1366-byte
  accounts with structured `capabilities` and `price_per_task`. The program was last deployed in
  slot 463520728 (2026-05-19T20:21:52Z), minutes before that commit. The copy in
  `wienerlabs/aip-beta` (9655c15) has an older 1048-byte layout with `capabilities_json`, which
  matches no live account; a decoder built from it fails on every record.
- At slot 506742046 there were 15 records. All re-derive from `["agent", owner, agent_id]`, and each
  stores the canonical v1 DID in its `did` field.
- The v1 program's upgrade authority is `33qU3JFkrehB2HkgdHzcpj9gDkFk8c2okQC51REWhjKh`, outside
  Wiener Labs' control. What a v1 DID resolves to can change with a program upgrade nobody here
  approves (v1 §7.6).

### 9.3 `did:key`

Agents built with the Covenant and AIP SDKs were identified by `did:key:z6Mk…`. That is a different
method. A `did:aip` resolver MUST reject it as `invalidDid`; a multi-method resolver dispatches it to
`did:key`.

When an agent's `did:key` key is the owner of a `did:aip` record, the record's `#owner`
`publicKeyMultibase` equals the `did:key` identifier after `did:key:`. That is a verifiable link
between keys, not an equivalence of identities: one key may own many agents.

A `did:key` decoder MUST strip the multibase prefix `z` before base58-decoding, then check and drop
the `0xed01` multicodec prefix. Decoding `z6Mk…` whole and dropping two bytes, as
`covenant/app/lib/aip/did.ts` does (`did.slice(8)`), returns a different, valid-looking key; the
test vectors include the case.

### 9.4 Legacy AIP identifiers

The AIP application used three strings in `did:aip:` form that were never anchored on-chain:
`did:aip:{first 8 characters of the owner}:{agent_id}` (hosted agents), `did:aip:hosted:{id}` and
`did:aip:platform:{id}`. They are not DIDs under this method, and a resolver MUST reject them as
`invalidDid`: the owner segment is not a 32-byte key.

An implementation MAY offer, **outside** `resolve`, a lookup from the 8-character form to the v1
DIDs whose owner starts with that prefix and whose `agent_id` matches. It MUST return every match,
and a caller MUST NOT treat a single match as the agent's identity: a chosen 8-character base58
prefix takes about 58⁸ ≈ 2⁴⁷ key generations to grind, which is within reach, so a prefix match is
an impersonation primitive. No live v1 record stores this form (§9.2).

### 9.5 Migration from v1

An operator moving a v1 agent to this profile SHOULD follow v2 §9.3: register in the Registry,
publish the new DID in the v1 agent card, list the v1 DID as a `DID` service in the new card, and
keep the v1 record rather than closing it.

Unlike a v1 → EVM migration, both anchors here use Ed25519 keys. When the new record's registrant is
the v1 record's owner, a consumer can check that the same key controls both. That is evidence of a
common operator, not of a common identity, and neither DID inherits the other's reputation.

---

## 10. Security Considerations

### 10.1 The registry is part of the identifier

As v2 §10.1: anyone can deploy a program that writes records in this shape. The `registry` segment
is what makes a DID meaningful, and resolving successfully proves only that the named program holds
the record. Consumers SHOULD keep an allowlist of registry program ids.

### 10.2 Ownership and wallet mutability

Owner and agent wallet change under the DID (§7.3, §7.4), as in v2 §10.2. Anything that authorises a
payment or accepts a signature MUST re-resolve, or check against the slot in `versionId`. This is a
deliberate departure from v1, where ownership could not be transferred: Square needs institutions to
move agents between operational keys and smart accounts.

### 10.3 Upgrade authority

What every DID of a registry means is defined by that program's code. Square deploys its registry
with a 2-of-3 Squads multisig as upgrade authority (BC-09), and on mainnet only after an external
audit (M9). Until then, the guarantees of §4.2 hold only as far as the deployed program implements
them.

### 10.4 Cluster confusion

`chain-ref` selects the cluster. An RPC endpoint for the wrong cluster returns another cluster's
account at the same address, and, because PDAs are the same on every cluster (§3.3), possibly a
real record of a different agent. Step 3 of §6.1 is therefore mandatory, and is the counterpart of
v2 §10.4.

### 10.5 Commitment

A record read at `confirmed` can, rarely, be rolled back. Resolution at `confirmed` is acceptable for
display and discovery; payment decisions SHOULD use `finalized` (§6.2).

### 10.6 Agent card trust

The card hash proves which file the owner committed to, not that its endpoints are honest. As v2
§10.3: endpoints carry exactly the owner's trust, and endpoint authenticity needs a separate
challenge (v1 §7.5).

### 10.7 Program-derived keys

An off-curve owner or wallet yields no verification method (§5.2). A consumer that falls back to
"verify against the owner address" for such an agent will never succeed, which is correct: there is
no key, and authority is exercised on-chain.

---

## 11. Privacy Considerations

All AgentRecord fields are public. The DID contains only the record address, but the record
contains the registrant and owner, so every agent of one registrant is linkable with a single
filtered `getProgramAccounts` query. Operators wanting unlinkable agents SHOULD register each from a
fresh key, and note that a smart-account owner links the agents it owns just the same.

The agent wallet appears in the agent's payment graph (v2 §11). Fetching an agent card reveals the
resolver's interest to the card's host; resolvers handling third-party DIDs SHOULD fetch through a
cache or gateway they operate.

---

## 12. Conformance to DID Core 1.0

| Requirement | Status |
|---|---|
| Method name is a lowercase ASCII string | ✅ `aip` |
| Method-specific identifier syntax is defined in ABNF | ✅ §3.1 |
| DID Documents are DID Core 1.0 conformant | ✅ §5 |
| `id` matches the resolved DID | ✅ §5.1 |
| Verification method types are registered | ✅ `Ed25519VerificationKey2020` |
| CRUD operations are specified | ✅ §7 |
| Resolution is specified | ✅ §6 |
| Security considerations | ✅ §10 |
| Privacy considerations | ✅ §11 |

The profile defines no new JSON-LD terms. `AIPAgentCard` is a service type string; DID Core does
not require service types to be registered.

---

## 13. Notes for This Repository

| Item | Consequence |
|---|---|
| BC-15 `square_registry` | Implements §4.2: no DID field, `["agent", registrant, agent_id]` seeds, tombstone instead of close, card URI and hash written together, wallet reset on transfer |
| BC-44 program interface | The registry's PDA table and account layout take §3.4 and §4.1 |
| BC-16 events | Registry events carry the record address; the DID is derived, not emitted |
| BE-09 `@squaresdk/solana-identity` | Implements §6 and §9 and consumes `test-vectors.json`; the v1 path decodes the c427872 layout (§9.2) |
| BC-07 registry import | The code actually deployed as v1 is `dr-wilson-empty/aip-beta` c427872, not the `wienerlabs/aip-beta` copy (§9.2) |
| W3C registry | [w3c/did-extensions#750][w3c-750], still open, changes the method's `verifiableDataRegistry` from Solana to ERC-8004. With this profile both apply, and the entry should say so |

---

## 14. References

### 14.1 Normative

- [DID Core 1.0](https://www.w3.org/TR/did-core/)
- [DID Resolution](https://w3c-ccg.github.io/did-resolution/)
- [`did:aip` v2.0][v2]
- [CAIP-2 for Solana][caip2-solana], [CAIP-10 for Solana][caip10-solana]
- [Ed25519 Signature 2020](https://w3c-ccg.github.io/lds-ed25519-2020/)
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) (Ed25519, point decoding)
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)

### 14.2 Informative

- [`did:aip` v1.0][v1] and [the v1 registry program at c427872][v1-registry]
- [`did:pkh`][did-pkh], [`did:key`](https://w3c-ccg.github.io/did-key-spec/)
- [Solana program derived addresses](https://solana.com/docs/core/pda)
- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)

---

## Appendix A — Test Vectors (Informative)

The machine-readable vectors are in [`test-vectors.json`](./test-vectors.json). Everything except
`v1.records` is synthetic and needs no network: keys are derived from fixed labels, record
addresses come from `solana find-program-derived-address`, and card hashes are SHA-256 over the exact
bytes of `agentCardBody`. The `registry` is a test program id, not a deployed program.

| Section | Contents |
|---|---|
| `chains` | CAIP-2 references of mainnet-beta, devnet and testnet (§3.3) |
| `keys` | Addresses with their on-curve status; for on-curve keys, `publicKeyMultibase` and `did:key` |
| `didKeyDecoding` | The `did:key` decoding pitfall of §9.3, with the wrong result it produces |
| `derivation` | `(registry, registrant, agent_id)` → record address, bump, DID; including a 32-character slug and a PDA registrant |
| `parse.valid` | Solana-profile, v2 (`eip155`) and v1 DIDs with their parsed parts |
| `parse.rejected` | 18 identifiers rejected as `invalidDid`, each with the rule it breaks (§3.2, §9.3, §9.4) |
| `parse.agentRegistry` | The `(agentRegistry, agentId)` ⇄ DID mapping of §3.5 |
| `documents` | Nine resolution cases with an inline record and card: verified card, off-curve wallet and service-id collision, hash mismatch, unreachable card, invalid card, off-curve owner without a card, registry deactivation, card `active: false`, transferred owner |
| `v1` | The derivation the v1 specification's Appendix A.1 names without a value, and two live devnet records (a snapshot at slot 506742046, not fixtures) with their v1 DID Documents |

[v1]: https://github.com/dr-wilson-empty/aip-beta/blob/5689708a8f9eefba5ca57724adf0478e762b3ee3/standards/did-aip-method-spec.md
[v1-registry]: https://github.com/dr-wilson-empty/aip-beta/blob/c4278721d612b2bc287f5819fec04995e40c705a/programs/aip-escrow/programs/aip-registry/src/lib.rs
[v2]: https://github.com/wienerlabs/square/blob/dc0157f1a737d8d9a5e603dce49aa3f3ab15b2d4/docs/did-aip/method-spec-v2.md
[caip2-solana]: https://github.com/ChainAgnostic/namespaces/blob/main/solana/caip2.md
[caip10-solana]: https://github.com/ChainAgnostic/namespaces/blob/main/solana/caip10.md
[did-pkh]: https://github.com/w3c-ccg/did-pkh/blob/main/did-pkh-method-draft.md
[w3c-750]: https://github.com/w3c/did-extensions/pull/750
[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174
[RFC 8032]: https://www.rfc-editor.org/rfc/rfc8032
