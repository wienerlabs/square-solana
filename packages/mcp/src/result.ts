// Araç sonucu: model JSON metni okur; hata `isError` ile döner, sunucu düşmez.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

export const fail = (error: unknown): CallToolResult => ({
  content: [{ type: 'text', text: `Square: ${error instanceof Error ? error.message : String(error)}` }],
  isError: true,
});

/** Aracın gövdesi; atılan hata `fail` olur. */
export const guarded =
  <A>(handler: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(error);
    }
  };
