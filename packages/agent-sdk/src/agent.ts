/**
 * @squaresdk/solana-agent-sdk — Agent builder with fluent API.
 *
 * Usage:
 *   const agent = createAgent({
 *     name: 'My Bot',
 *     port: Number(process.env.PORT),
 *     publicUrl: process.env.AGENT_PUBLIC_URL,
 *     type: 'Task',
 *     version: '1.2.0',
 *     walletAddress: process.env.AGENT_WALLET,
 *   });
 *   agent.capability('text.summarize', {
 *     description: 'Summarize Text',
 *     price: { amount: '0.10', token: 'USDC', network: 'solana' },
 *     handler: async (input) => summarize(input),
 *   });
 *   agent.start();
 */
import { randomUUID } from "node:crypto";
import express from "express";
import type { Express } from "express";
import type { AgentOptions, AgentCard, CapabilityConfig, Pricing } from "./types";

interface InternalTask {
  id: string;
  status: "WORKING" | "COMPLETED" | "FAILED";
  artifact?: string;
  error?: string;
}

function jsonRpcOk(id: string | number, result: unknown) {
  return { jsonrpc: "2.0", result, id };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id };
}


/** Solana base58 pubkey: 32–44 chars from the Bitcoin alphabet (no 0OIl). */
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AGENT_ID_RE = /^[a-z0-9_-]{1,32}$/;

function sanitizeAgentId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** Agent returned by createAgent (explicit so the emitted .d.ts is portable under pnpm). */
export interface Agent {
  capability(id: string, config: CapabilityConfig): Agent;
  start(): AgentCard;
  getCard(): AgentCard;
  app: Express;
}

export function createAgent(options: AgentOptions): Agent {
  if (!options.walletAddress || !SOLANA_PUBKEY_RE.test(options.walletAddress)) {
    throw new Error(
      `createAgent: walletAddress must be a base58 Solana public key (32–44 chars). ` +
      `Got: ${JSON.stringify(options.walletAddress)}. ` +
      `As of @aip/agent-sdk 0.2.0 this field is required so the agent's DID can be ` +
      `derived from the canonical did:aip format (spec §3.2).`
    );
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(options.publicUrl);
  } catch (err) {
    throw new Error(
      `createAgent: publicUrl must be an absolute URL. Got: ${JSON.stringify(options.publicUrl)}.`,
      { cause: err },
    );
  }
  const a2aEndpoint = `${publicUrl.toString().replace(/\/+$/, "")}/a2a`;

  const agentId = options.agentId ?? sanitizeAgentId(options.name);
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `createAgent: agentId must match /^[a-z0-9_-]{1,32}$/. ` +
      `Resolved agentId="${agentId}" from options.agentId=${JSON.stringify(options.agentId)} ` +
      `or fallback from options.name=${JSON.stringify(options.name)}.`
    );
  }

  const app = express();
  app.use(express.json());

  const tasks = new Map<string, InternalTask>();
  const capabilities = new Map<string, { config: CapabilityConfig; pricing: Pricing }>();

  const walletAddress = options.walletAddress;
  const did = options.did ?? `did:aip:${walletAddress}:${agentId}`;

  /** Register a capability with its handler */
  function capability(id: string, config: CapabilityConfig) {
    const pricing: Pricing = { ...config.price };
    capabilities.set(id, { config, pricing });
    return api; // fluent chaining
  }

  /** Build Agent Card from registered capabilities */
  function getCard(): AgentCard {
    return {
      did,
      name: options.name,
      version: options.version,
      endpoint: a2aEndpoint,
      type: options.type,
      walletAddress,
      capabilities: Array.from(capabilities.entries()).map(([id, { config, pricing }]) => ({
        id,
        description: config.description,
        pricing,
      })),
    };
  }

  // ---- Agent Card endpoint ----
  app.get("/.well-known/agent.json", (_req, res) => {
    res.json(getCard());
  });

  // ---- JSON-RPC 2.0 endpoint ----
  app.post("/a2a", async (req, res) => {
    const { jsonrpc, method, params, id } = req.body ?? {};

    if (jsonrpc !== "2.0" || !method || id === undefined) {
      return res.json(jsonRpcError(id ?? null, -32600, "Invalid JSON-RPC request"));
    }

    if (method === "task/create") {
      const { capability: capId, input, taskId } = params ?? {};
      if (!capId || !input) {
        return res.json(jsonRpcError(id, -32602, "Missing capability or input"));
      }

      const cap = capabilities.get(capId);
      if (!cap) {
        return res.json(jsonRpcError(id, -32602, `Unsupported capability: ${capId}`));
      }

      const agentTaskId = taskId || `atask_${randomUUID()}`;
      tasks.set(agentTaskId, { id: agentTaskId, status: "WORKING" });

      res.json(jsonRpcOk(id, { taskId: agentTaskId, status: "WORKING" }));

      // Execute handler in background
      try {
        const artifact = await cap.config.handler(input);
        tasks.set(agentTaskId, { id: agentTaskId, status: "COMPLETED", artifact });
        options.logger?.info(`[${options.name}] Task ${agentTaskId} completed`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        tasks.set(agentTaskId, { id: agentTaskId, status: "FAILED", error: message });
        options.logger?.error(`[${options.name}] Task ${agentTaskId} failed: ${message}`);
      }
      return;
    }

    if (method === "task/status") {
      const { taskId } = params ?? {};
      if (!taskId) return res.json(jsonRpcError(id, -32602, "Missing taskId"));

      const task = tasks.get(taskId);
      if (!task) return res.json(jsonRpcError(id, -32001, `Task not found: ${taskId}`));

      return res.json(jsonRpcOk(id, {
        taskId: task.id,
        status: task.status,
        ...(task.artifact ? { artifact: task.artifact } : {}),
        ...(task.error ? { error: task.error } : {}),
      }));
    }

    return res.json(jsonRpcError(id, -32601, `Unknown method: ${method}`));
  });

  /** Start the agent HTTP server */
  function start() {
    const card = getCard();
    app.listen(options.port, () => {
      options.logger?.info(
        `[${options.name}] listening on port ${options.port}; DID ${did}; A2A ${a2aEndpoint}; ` +
          `capabilities: ${Array.from(capabilities.keys()).join(", ")}`,
      );
    });
    return card;
  }

  const api: Agent = { capability, start, getCard, app };
  return api;
}
