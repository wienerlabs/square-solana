import bs58 from 'bs58';

export type ServiceEnv = Readonly<Record<string, string>>;

export interface HttpPorts {
  readonly port: number;
  readonly metricsPort: number;
}

export interface ObjectStore {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly deliveryBucket: string;
  readonly evidenceBucket: string;
}

export const LOCAL_ORIGIN = 'http://127.0.0.1';
export const KEEPER_MINT_UNITS_PER_SOL = 1_000_000n;

export const observabilityEnv = (): ServiceEnv => ({
  LOG_LEVEL: 'info',
  HEALTH_CHECK_TIMEOUT_MS: '5000',
  ALERT_EVALUATION_SECONDS: '60',
});

const rpcEnv = (prefix: string, rpcUrl: string): ServiceEnv => ({
  [`${prefix}_RPC_URLS`]: rpcUrl,
  [`${prefix}_RPC_TIMEOUT_MS`]: '10000',
  [`${prefix}_RPC_COOLDOWN_MS`]: '1000',
});

export function indexerEnv(params: {
  databaseUrl: string;
  rpcUrl: string;
  ports: HttpPorts;
  reconcileIntervalSeconds: number;
}): ServiceEnv {
  return {
    ...observabilityEnv(),
    DATABASE_URL: params.databaseUrl,
    ...rpcEnv('INDEXER', params.rpcUrl),
    INDEXER_PORT: String(params.ports.port),
    INDEXER_METRICS_PORT: String(params.ports.metricsPort),
    INDEXER_POLL_INTERVAL_MS: '500',
    INDEXER_SIGNATURE_PAGE_SIZE: '100',
    INDEXER_RECONCILE_INTERVAL_SECONDS: String(params.reconcileIntervalSeconds),
    INDEXER_ALERT_STALL_SECONDS: '600',
    INDEXER_ALERT_LAG_SLOTS: '1000',
    INDEXER_ALERT_DRIFT: '0',
    INDEXER_ALERT_ERRORS: '1000',
    INDEXER_ALERT_ERROR_WINDOW_SECONDS: '60',
  };
}

export function keeperEnv(params: {
  databaseUrl: string;
  rpcUrl: string;
  ports: HttpPorts;
  secretKey: Uint8Array;
}): ServiceEnv {
  return {
    ...observabilityEnv(),
    DATABASE_URL: params.databaseUrl,
    ...rpcEnv('KEEPER', params.rpcUrl),
    KEEPER_SECRET_KEY: bs58.encode(params.secretKey),
    KEEPER_PORT: String(params.ports.port),
    KEEPER_METRICS_PORT: String(params.ports.metricsPort),
    KEEPER_POLL_INTERVAL_MS: '500',
    KEEPER_CONFIRM_POLL_MS: '250',
    KEEPER_BATCH_SIZE: '20',
    KEEPER_BACKOFF_BASE_SECONDS: '1',
    KEEPER_BACKOFF_MAX_SECONDS: '4',
    KEEPER_MINT_UNITS_PER_SOL: String(KEEPER_MINT_UNITS_PER_SOL),
    KEEPER_MIN_MARGIN_BPS: '0',
    KEEPER_PRIORITY_FEE_PERCENTILE: '50',
    KEEPER_MAX_COMPUTE_UNIT_PRICE: '1000',
    KEEPER_ALERT_MIN_BALANCE_LAMPORTS: '1',
    KEEPER_ALERT_STALL_SECONDS: '600',
    KEEPER_ALERT_DUE_SECONDS: '600',
    KEEPER_ALERT_ERRORS: '1000',
    KEEPER_ALERT_ERROR_WINDOW_SECONDS: '60',
  };
}

export function proverEnv(params: {
  ports: HttpPorts;
  apiKeySha256: string;
  artifacts: { manifest: string; wasm: string; zkey: string };
}): ServiceEnv {
  return {
    ...observabilityEnv(),
    PROVER_SERVICE_PORT: String(params.ports.port),
    PROVER_METRICS_PORT: String(params.ports.metricsPort),
    CORS_ORIGINS: LOCAL_ORIGIN,
    PROVER_API_KEY_SHA256: params.apiKeySha256,
    PROVER_MAX_CONCURRENT: '1',
    PROVER_MAX_QUEUE: '4',
    PROVER_QUEUE_TIMEOUT_MS: '120000',
    PROVER_MANIFEST_PATH: params.artifacts.manifest,
    PROVER_WASM_PATH: params.artifacts.wasm,
    PROVER_ZKEY_PATH: params.artifacts.zkey,
    PROVER_ALERT_QUEUE_DEPTH: '10',
    PROVER_ALERT_QUEUE_SECONDS: '60',
    PROVER_ALERT_FAILURES: '10',
    PROVER_ALERT_FAILURE_WINDOW_SECONDS: '60',
  };
}

export function screenerEnv(params: {
  databaseUrl: string;
  rpcUrl: string;
  ports: HttpPorts;
  apiKeySha256: string;
  authorityKeyPath: string;
  ofacUrl: string;
  caCertPath: string;
}): ServiceEnv {
  return {
    ...observabilityEnv(),
    DATABASE_URL: params.databaseUrl,
    SCREENER_PORT: String(params.ports.port),
    SCREENER_METRICS_PORT: String(params.ports.metricsPort),
    SCREENER_API_KEY_SHA256: params.apiKeySha256,
    SCREENER_JSON_MAX_BYTES: '65536',
    SCREENER_RATE_LIMIT_WINDOW_SECONDS: '60',
    SCREENER_RATE_LIMIT_SCREEN: '1000',
    SCREENER_RATE_LIMIT_READ: '10000',
    ...rpcEnv('SCREENER', params.rpcUrl),
    SCREENER_COMPUTE_UNIT_PRICE: '1000',
    SCREENER_CONFIRM_POLL_MS: '250',
    SCREENER_AUTHORITY_KEYPAIR_PATH: params.authorityKeyPath,
    SCREENER_OFAC_SDN_URL: params.ofacUrl,
    SCREENER_OFAC_REFRESH_SECONDS: '3600',
    SCREENER_OFAC_MAX_AGE_SECONDS: '7200',
    SCREENER_OFAC_TIMEOUT_MS: '10000',
    SCREENER_OFAC_MAX_BYTES: '1048576',
    SCREENER_RENEW_INTERVAL_SECONDS: '3600',
    SCREENER_RENEW_MARGIN_SECONDS: '3600',
    SCREENER_RENEW_BATCH: '10',
    SCREENER_RENEW_RETRY_SECONDS: '600',
    SCREENER_ALERT_ERRORS: '1000',
    SCREENER_ALERT_ERROR_WINDOW_SECONDS: '60',
    SCREENER_ALERT_MIN_BALANCE_LAMPORTS: '1',
    NODE_EXTRA_CA_CERTS: params.caCertPath,
  };
}

export function apiEnv(params: {
  databaseUrl: string;
  rpcUrl: string;
  ports: HttpPorts;
  store: ObjectStore;
  prover: { url: string; apiKey: string };
  lookupTable: string | null;
  keyRings: { travelRule: string; webhook: string };
}): ServiceEnv {
  const { store } = params;
  return {
    ...observabilityEnv(),
    DATABASE_URL: params.databaseUrl,
    API_PORT: String(params.ports.port),
    API_METRICS_PORT: String(params.ports.metricsPort),
    API_PUBLIC_BASE_URL: 'https://api.square.test',
    CORS_ORIGINS: LOCAL_ORIGIN,
    API_TRUST_PROXY_HOPS: '0',
    API_JSON_MAX_BYTES: '1048576',
    ...rpcEnv('API', params.rpcUrl),
    API_AUTH_DOMAIN: 'localhost',
    API_AUTH_CHALLENGE_TTL_SECONDS: '300',
    API_SESSION_TTL_SECONDS: '3600',
    API_RATE_LIMIT_WINDOW_SECONDS: '60',
    API_RATE_LIMIT_READ: '100000',
    API_RATE_LIMIT_WRITE: '10000',
    API_DELIVERY_S3_ENDPOINT: store.endpoint,
    API_DELIVERY_S3_REGION: store.region,
    API_DELIVERY_S3_BUCKET: store.deliveryBucket,
    API_DELIVERY_S3_ACCESS_KEY_ID: store.accessKeyId,
    API_DELIVERY_S3_SECRET_ACCESS_KEY: store.secretAccessKey,
    API_DELIVERY_S3_FORCE_PATH_STYLE: 'true',
    API_DELIVERY_PUBLIC_BASE_URL: `${store.endpoint}/${store.deliveryBucket}`,
    API_DELIVERY_MAX_BYTES: '1048576',
    API_EVIDENCE_S3_BUCKET: store.evidenceBucket,
    API_EVIDENCE_MAX_BYTES: '1048576',
    API_ARBITRATOR_CACHE_SECONDS: '60',
    API_WEBHOOK_SECRET_KEYS: `webhook-1:${params.keyRings.webhook}`,
    API_WEBHOOK_SECRET_ACTIVE_KEY_ID: 'webhook-1',
    API_NOTIFY_INTERVAL_MS: '1000',
    API_NOTIFY_BATCH_SIZE: '10',
    API_NOTIFY_TIMEOUT_MS: '5000',
    API_NOTIFY_MAX_ATTEMPTS: '3',
    API_NOTIFY_BACKOFF_BASE_SECONDS: '1',
    API_NOTIFY_BACKOFF_MAX_SECONDS: '10',
    API_NOTIFY_DEADLINE_WARNING_SECONDS: '60',
    API_NOTIFY_ALLOW_INSECURE: 'false',
    ...(params.lookupTable ? { API_LOOKUP_TABLE: params.lookupTable } : {}),
    API_COMPUTE_UNIT_PRICE: '1000',
    API_PROVER_URL: params.prover.url,
    API_PROVER_API_KEY: params.prover.apiKey,
    API_PROVER_TIMEOUT_MS: '180000',
    API_TRAVEL_RULE_KEYS: `travel-rule-1:${params.keyRings.travelRule}`,
    API_TRAVEL_RULE_ACTIVE_KEY_ID: 'travel-rule-1',
    API_TRAVEL_RULE_RETENTION_DAYS: '30',
    API_TRAVEL_RULE_MAINTENANCE_INTERVAL_SECONDS: '3600',
    API_ALERT_ERRORS: '1000',
    API_ALERT_ERROR_WINDOW_SECONDS: '60',
  };
}

export const SERVICE_NAMES = ['prover', 'indexer', 'keeper', 'screener', 'api'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];
