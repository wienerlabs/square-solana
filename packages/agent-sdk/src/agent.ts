/**
 * @aip/agent-sdk — Agent builder with fluent API.
 *
 * Usage:
 *   const agent = createAgent({ name: 'My Bot', port: 4001 });
 *   agent.capability('text.summarize', {
 *     description: 'Summarize Text',
 *     price: '0.10',
 *     handler: async (input) => `Summary: ${input}`,
 *   });
 *   agent.start();
 */
import express from "express";
import type { AgentOptions, AgentCard, AgentType, CapabilityConfig, Pricing } from "./types";

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

function normalizePricing(price: string | Pricing): { amount: string; token: string; network: string } {
  if (typeof price === "string") return { amount: price, token: "USDC", network: "solana" };
  return { amount: price.amount, token: price.token ?? "USDC", network: price.network ?? "solana" };
}

export function createAgent(options: AgentOptions) {
  const app = express();
  app.use(express.json());

  const tasks = new Map<string, InternalTask>();
  const capabilities = new Map<string, { config: CapabilityConfig; pricing: { amount: string; token: string; network: string } }>();

  const agentType: AgentType = options.type ?? "Task";
  const version = options.version ?? "1.0.0";
  const walletAddress = options.walletAddress ?? "";
  const did = options.did ?? `did:aip:sdk:${options.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;

  /** Register a capability with its handler */
  function capability(id: string, config: CapabilityConfig) {
    const pricing = normalizePricing(config.price);
    capabilities.set(id, { config, pricing });
    return api; // fluent chaining
  }

  /** Build Agent Card from registered capabilities */
  function getCard(): AgentCard {
    return {
      did,
      name: options.name,
      version,
      endpoint: `http://localhost:${options.port}/a2a`,
      type: agentType,
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

      const agentTaskId = taskId || `atask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      tasks.set(agentTaskId, { id: agentTaskId, status: "WORKING" });

      res.json(jsonRpcOk(id, { taskId: agentTaskId, status: "WORKING" }));

      // Execute handler in background
      try {
        const artifact = await cap.config.handler(input);
        tasks.set(agentTaskId, { id: agentTaskId, status: "COMPLETED", artifact });
        console.log(`  [${options.name}] Task ${agentTaskId} completed`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        tasks.set(agentTaskId, { id: agentTaskId, status: "FAILED", error: message });
        console.error(`  [${options.name}] Task ${agentTaskId} failed:`, message);
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
      console.log(`[${options.name}] listening on http://localhost:${options.port}`);
      console.log(`  Agent Card: http://localhost:${options.port}/.well-known/agent.json`);
      console.log(`  A2A:        http://localhost:${options.port}/a2a`);
      console.log(`  Capabilities: ${Array.from(capabilities.keys()).join(", ")}`);
    });
    return card;
  }

  const api = { capability, start, getCard, app };
  return api;
}
