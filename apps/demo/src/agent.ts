import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Commitment, Connection, Keypair } from '@solana/web3.js';
import { createApiKeyAuthenticator, type Authenticator, type TaskStore } from '@squaresdk/solana-a2a';
import {
  createAgent,
  type Agent,
  type AgentLogger,
  type ApiKeyGrant,
  type ClaimListing,
  type TxOptions,
} from '@squaresdk/solana-agent-sdk';
import type { SquareProgramIds } from '@squaresdk/solana-sdk';
import type { DemoAgentSettings } from './demo-config.js';
import { basePathOf, createDeliveryStore, type DeliveryStore } from './delivery.js';
import { createMemoryTaskStore } from './memory-store.js';
import { accountReportCapability, accountReportHandler, reportSpecError } from './report.js';

export interface DemoAgentParams {
  settings: DemoAgentSettings;
  signer: Keypair;
  connection: Connection;
  commitment: Commitment;
  programIds: SquareProgramIds;
  callers: readonly ApiKeyGrant[];
  tx: TxOptions;
  store?: TaskStore;
  logger?: AgentLogger;
  onError?: (error: unknown) => void;
  onClaimListed?: (listing: ClaimListing) => void;
}

export interface DemoAgent {
  agent: Agent;
  deliveries: DeliveryStore;
  basePath: string;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

export interface RunningAgent {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const denyAll: Authenticator = () => null;

export function callerGrants(apiKey: string | null, institutions: readonly string[]): ApiKeyGrant[] {
  if (apiKey === null) return [];
  if (apiKey.trim().length < 16) throw new Error('A2A anahtarı en az 16 karakter olmalı');
  if (institutions.length === 0) throw new Error('A2A anahtarı için en az bir kurum adresi gerekli');
  return [{ keySha256: sha256Hex(apiKey), institutions: [...institutions] }];
}

export async function createDemoAgent(params: DemoAgentParams): Promise<DemoAgent> {
  const { settings } = params;
  const deliveries = createDeliveryStore(settings.publicUrl);
  const agent = await createAgent({
    name: settings.name,
    description: settings.description,
    version: settings.version,
    publicUrl: settings.publicUrl,
    agentId: settings.agentId,
    capabilities: [accountReportCapability(settings.price)],
    handler: accountReportHandler({ reader: params.connection, programIds: params.programIds }),
    admit: ({ spec }) => reportSpecError(spec),
    signer: params.signer,
    connection: params.connection,
    commitment: params.commitment,
    programIds: params.programIds,
    delivery: deliveries,
    store: params.store ?? createMemoryTaskStore(),
    authenticate: params.callers.length > 0 ? createApiKeyAuthenticator({ keys: params.callers }) : denyAll,
    tx: params.tx,
    ...(settings.autoListClaimBps === undefined ? {} : { autoListClaim: { discountBps: settings.autoListClaimBps } }),
    ...(params.onClaimListed ? { onClaimListed: params.onClaimListed } : {}),
    ...(params.logger ? { logger: params.logger } : {}),
    ...(params.onError ? { onError: params.onError } : {}),
  });
  return {
    agent,
    deliveries,
    basePath: basePathOf(settings.publicUrl),
    async handle(request, response) {
      if (deliveries.handle(request, response)) return;
      await agent.handle(request, response);
    },
  };
}

export async function serveDemoAgent(
  demo: DemoAgent,
  options: { port: number; host: string; onError?: (error: unknown) => void },
): Promise<RunningAgent> {
  await demo.agent.resume();
  const server = createServer((request, response) => {
    demo.handle(request, response).catch((error: unknown) => {
      options.onError?.(error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'iç hata' }));
      } else {
        response.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `http://${host}:${port}${demo.basePath}`,
    server,
    async close() {
      await demo.agent.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
