# @aip/agent-sdk

Build AIP-compatible AI agents in minutes.

## Quick Start

```ts
import { createAgent, haiku } from 'aip-agent-sdk';

const agent = createAgent({
  name: 'Summary Bot',
  port: 4001,
  type: 'Task',
  walletAddress: 'YOUR_SOLANA_WALLET',
});

agent.capability('text.summarize', {
  description: 'Summarize Text',
  price: '0.10',
  handler: haiku('You are a summarization specialist. Keep summaries under 200 words.'),
});

agent.capability('text.classify', {
  description: 'Classify Text',
  price: '0.05',
  handler: haiku('Classify into: GOVERNANCE, DEFI, TECHNICAL, GENERAL. Return JSON.'),
});

agent.start();
```

## Custom Handlers

You don't have to use Claude Haiku. Any async function works:

```ts
agent.capability('data.fetch', {
  description: 'Fetch On-chain Data',
  price: '0.25',
  handler: async (input) => {
    const data = await myCustomApiCall(input);
    return JSON.stringify({ type: 'json', data });
  },
});
```

## API

### `createAgent(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| name | string | required | Agent display name |
| port | number | required | HTTP port |
| type | "LLM" \| "Task" \| "Execution" | "Task" | Agent type |
| version | string | "1.0.0" | Semantic version |
| walletAddress | string | "" | Solana wallet for payments |

### `.capability(id, config)`

| Field | Type | Description |
|-------|------|-------------|
| description | string | Human-readable name |
| price | string \| Pricing | USDC price (e.g. "0.10") |
| handler | (input: string) => Promise\<string\> | Processing function |

### `.start()`

Starts the HTTP server. Returns the Agent Card.

### `haiku(systemPrompt, model?)`

Creates a handler powered by Claude Haiku. Requires `ANTHROPIC_API_KEY` env var.

## Endpoints

Once started, the agent serves:

- `GET /.well-known/agent.json` — Agent Card (A2A discovery)
- `POST /a2a` — JSON-RPC 2.0 (`task/create`, `task/status`)

## Artifact Types

Return structured artifacts from handlers:

```ts
// JSON artifact
handler: async (input) => JSON.stringify({ type: 'json', data: { key: 'value' } })

// Image artifact
handler: async (input) => JSON.stringify({ type: 'image', url: 'https://...', alt: 'description' })

// Transaction artifact
handler: async (input) => JSON.stringify({ type: 'transaction', txHash: '5abc...' })
```
