// Delegasyonun Claude tool'u (`square_delegate_job`): yalnızca `delegation: true` olan capability'ye verilir.
// Claude'un girdisi güvenilmez kabul edilir: şemayla doğrulanır ve politika kapısı Claude'dan bağımsız olarak
// delegator'da uygulanır; Claude'un yazdığı tutar ya da agent kuralları aşamaz. Sonuç ve ret sebebi Claude'a JSON
// olarak döner.
import { Address, U64 } from '@squaresdk/solana-types';
import { z } from 'zod';
import type { Delegator } from './delegation.js';
import type { LocalTool } from './tools.js';

export const DELEGATE_TOOL_NAME = 'square_delegate_job';

const InputSchema = z
  .object({
    agentRecord: Address,
    spec: z.record(z.string(), z.unknown()),
    amount: U64,
    category: z.string().min(1).optional(),
    deadline: z.number().int().positive().optional(),
  })
  .strict();

const json = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));

export function delegateTool(delegator: Delegator): LocalTool {
  return {
    definition: {
      name: DELEGATE_TOOL_NAME,
      description: [
        "Open and fund a Square job for another agent on behalf of the institution. The institution's spending",
        'policy is enforced before any transaction: per-transaction cap, daily caps, allowed categories, mint,',
        'blocked payees, time window and the list of allowed agents. A refused delegation returns the violated',
        'rules and nothing is sent. The same spec always maps to the same job; calling again continues it.',
      ].join(' '),
      input_schema: {
        type: 'object',
        properties: {
          agentRecord: { type: 'string', description: 'AgentRecord address of the agent to hire.' },
          spec: {
            type: 'object',
            description: 'Job spec as a JSON object (capability, input, ...); its hash identifies the job.',
          },
          amount: { type: 'string', description: 'Escrow amount in base units of the settlement mint (u64).' },
          category: { type: 'string', description: 'Payment category (default: the configured category).' },
          deadline: {
            type: 'integer',
            description: 'Delivery deadline, unix seconds (default and latest: now + configured offset).',
          },
        },
        required: ['agentRecord', 'spec', 'amount'],
        additionalProperties: false,
      },
    },
    async call(input) {
      const parsed = InputSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { agentRecord, spec, amount, category, deadline } = parsed.data;
      const outcome = await delegator.delegate({
        agentRecord,
        spec,
        amount: BigInt(amount),
        ...(category !== undefined && { category }),
        ...(deadline !== undefined && { deadline }),
      });
      return { content: json(outcome), isError: outcome.status === 'refused' };
    },
  };
}
