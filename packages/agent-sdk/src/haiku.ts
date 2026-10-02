/**
 * Built-in Anthropic handler for quick capability setup.
 *
 * Usage:
 *   import { haiku } from '@squaresdk/solana-agent-sdk';
 *
 *   agent.capability('text.summarize', {
 *     description: 'Summarize Text',
 *     price: { amount: '0.10', token: 'USDC', network: 'solana' },
 *     handler: haiku(
 *       'You are a summarization specialist. Summarize concisely.',
 *       process.env.ANTHROPIC_MODEL,
 *       1024,
 *     ),
 *   });
 */
import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/**
 * Create a capability handler powered by an Anthropic model.
 * @param systemPrompt — Instructions for the model
 * @param model — Anthropic model ID; chosen by the caller, there is no default
 * @param maxTokens — Upper bound on the response length
 */
export function haiku(
  systemPrompt: string,
  model: string,
  maxTokens: number
): (input: string) => Promise<string> {
  if (!model) throw new Error("haiku: model is required");
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("haiku: maxTokens must be a positive integer");
  }
  return async (input: string): Promise<string> => {
    const client = getClient();
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: input }],
    });
    const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    if (text.length === 0) {
      throw new Error(`haiku: model ${model} returned no text content (stop_reason=${response.stop_reason})`);
    }
    return text.join("");
  };
}
