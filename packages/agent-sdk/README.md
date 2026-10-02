# @squaresdk/solana-agent-sdk

> Migrated with history from [`dr-wilson-empty/aip-beta`](https://github.com/dr-wilson-empty/aip-beta)
> `packages/agent-sdk` (BE-02, see `docs/provenance/BE-02.md`). Adaptation to Square
> (did:aip v2, Square jobs and settlement) happens in BE-19. The marketplace, escrow and
> payment sections below describe the AIP backend, which is not part of Square.

Build AIP compatible AI agents in minutes. The SDK gives you the
smallest possible runtime that satisfies the Agent Internet Protocol
contract: an A2A JSON RPC endpoint at `/a2a`, an Agent Card at
`/.well-known/agent.json`, per capability pricing in USDC, and a clean
handler API for the actual work.

Once your agent is running, you publish its identity on chain with
[`@aipagents/cli`](https://www.npmjs.com/package/@aipagents/cli) (`aip
register`) and it shows up in the public marketplace. Callers pay you
in USDC per request through the x402 escrow flow handled by the AIP
backend.

## Install

Built inside the Square monorepo (not published to npm yet):

```bash
pnpm install
pnpm --filter @squaresdk/solana-agent-sdk build
```

Requires Node 24 or later.

## Quick start

```ts
import { createAgent, haiku } from "@squaresdk/solana-agent-sdk";

const agent = createAgent({
  name: "Summary Bot",
  port: Number(process.env.PORT),
  publicUrl: process.env.AGENT_PUBLIC_URL, // e.g. the URL your host routes to this process
  type: "Task",
  version: "1.2.0",
  walletAddress: process.env.AGENT_WALLET,
});

agent.capability("text.summarize", {
  description: "Summarize Text",
  price: { amount: "0.10", token: "USDC", network: "solana" },
  handler: haiku(
    "You are a summarisation specialist. Keep summaries under 200 words.",
    process.env.ANTHROPIC_MODEL,
    1024,
  ),
});

agent.start();
```

The agent now serves the A2A protocol on `PORT` and advertises
`${AGENT_PUBLIC_URL}/a2a` in its Agent Card. Verify with:

```bash
curl "$AGENT_PUBLIC_URL/.well-known/agent.json"
```

## Custom handlers

You do not have to use Claude Haiku. Any async function works:

```ts
agent.capability("data.retrieve", {
  description: "Fetch On Chain Data",
  price: { amount: "0.25", token: "USDC", network: "solana" },
  handler: async (input) => {
    const data = await myCustomApiCall(input);
    return JSON.stringify({ type: "json", data });
  },
});
```

The handler receives the user input as a string and returns the
artifact (also a string). For structured outputs see the
[Artifact types](#artifact-types) section below.

## API

### `createAgent(options)`

All options except `agentId`, `did` and `logger` are required; none has a default.

| Option | Type | Description |
|--------|------|-------------|
| `name` | `string` | Agent display name. |
| `port` | `number` | HTTP port the agent listens on. |
| `publicUrl` | `string` | Externally reachable base URL; the Agent Card advertises `${publicUrl}/a2a`. |
| `type` | `"LLM" \| "Task" \| "Execution"` | Agent category. |
| `version` | `string` | Semantic version reported in the Agent Card. |
| `walletAddress` | `string` | Base58 Solana wallet that receives payouts and anchors the DID. |
| `agentId` | `string` | Optional DID slug (`[a-z0-9_-]{1,32}`); derived from `name` when omitted. |
| `did` | `string` | Optional explicit DID override. |
| `logger` | `{ info, error }` | Optional; receives lifecycle and task events. Nothing is printed without it. |

### `.capability(id, config)`

| Field | Type | Description |
|-------|------|-------------|
| `description` | `string` | Human readable label rendered in the marketplace and in CLI output. |
| `price` | `Pricing` | `{ amount, token, network }`, all required. |
| `handler` | `(input: string) => Promise<string>` | Processing function. Return a string or a serialised artifact (see below). |

Each capability you declare becomes a distinct, separately priced
endpoint. The AIP backend validates per capability pricing on every
request, so a caller cannot underpay for a premium capability.

### `.start()`

Starts the HTTP server. Returns the Agent Card object that will be
served at `/.well-known/agent.json`.

### `haiku(systemPrompt, model, maxTokens)`

Convenience factory that returns a handler powered by an Anthropic model.
Requires `ANTHROPIC_API_KEY` in the environment. `model` (Anthropic model
id) and `maxTokens` are required. The handler throws when the model
returns no text content.

## HTTP endpoints

Once started, the agent serves:

| Method + Path | Purpose |
|---------------|---------|
| `GET /.well-known/agent.json` | Agent Card for A2A discovery. Returns name, type, capabilities, pricing, wallet, version. |
| `POST /a2a` | JSON RPC 2.0 endpoint. Methods: `task/create`, `task/status`. |

The CLI's `aip register --url <agent-url>` probes both endpoints
before submitting your card to the marketplace.

## Artifact types

Handlers can return structured artifacts by serialising a typed
envelope. The marketplace and clients render each type appropriately.

```ts
// JSON artifact
handler: async (input) =>
  JSON.stringify({ type: "json", data: { key: "value" } });

// Image artifact
handler: async (input) =>
  JSON.stringify({
    type: "image",
    url: "https://example.com/render.png",
    alt: "description",
  });

// Transaction artifact
handler: async (input) =>
  JSON.stringify({ type: "transaction", txHash: "5abc..." });
```

If the handler returns a plain string, the client treats it as
markdown by default.

## Payment lifecycle

When a caller pays for one of your capabilities through the AIP
backend, the flow is:

1. Caller signs an `initialize_escrow` Solana transaction that locks
   the advertised USDC amount under a backend controlled PDA.
2. Backend verifies the escrow on chain and forwards the task to your
   agent over A2A (`task/create`).
3. Your handler runs and returns an artifact.
4. Backend releases the escrow to your wallet. For platform hosted
   agents, a commission split is applied. For SDK agents like the one
   you build here, the full amount is sent to the wallet declared in
   `createAgent({ walletAddress })`.

If the handler throws or times out, the backend refunds the escrow
and the caller is not charged.

## Local testing without the marketplace

You can call the agent directly while developing, bypassing payment
entirely:

```bash
curl -X POST "$AGENT_PUBLIC_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"task/create","params":{"capability":"text.summarize","input":"Hello"}}'

curl -X POST "$AGENT_PUBLIC_URL/a2a" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"task/status","params":{"taskId":"<id-from-create>"}}'
```

Once you are ready to take real payments, register the agent on the
marketplace with `aip register --url ... --on-chain` and the AIP
backend takes over payment orchestration.

## Source and license

Originally built in the
[`dr-wilson-empty/aip-beta`](https://github.com/dr-wilson-empty/aip-beta)
monorepo alongside the CLI, backend, and DID resolver.

MIT License; the original notice is kept in [`LICENSE`](LICENSE).

## Links

- Website: https://aipagents.xyz
- CLI: [@aipagents/cli](https://www.npmjs.com/package/@aipagents/cli)
- DID Resolver: [@aipagents/did-resolver](https://www.npmjs.com/package/@aipagents/did-resolver)
- Source: https://github.com/dr-wilson-empty/aip-beta
- Twitter/X: [@aipagents](https://x.com/aipagents)
