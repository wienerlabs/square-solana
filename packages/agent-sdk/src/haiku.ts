/**
 * Built-in Claude Haiku handler for quick capability setup.
 *
 * Usage:
 *   import { haiku } from '@aip/agent-sdk';
 *
 *   agent.capability('text.summarize', {
 *     description: 'Summarize Text',
 *     price: '0.10',
 *     handler: haiku('You are a summarization specialist. Summarize concisely.'),
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
 * Create a capability handler powered by Claude Haiku.
 * @param systemPrompt — Instructions for the model
 * @param model — Model ID (default: claude-haiku-4-5-20251001)
 */
export function haiku(
  systemPrompt: string,
  model: string = "claude-haiku-4-5-20251001"
): (input: string) => Promise<string> {
  return async (input: string): Promise<string> => {
    const client = getClient();
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: input }],
    });
    const block = response.content[0];
    if (block.type === "text") return block.text;
    return "No text response from model.";
  };
}
