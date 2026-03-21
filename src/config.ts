import dotenv from 'dotenv';
dotenv.config();

function envStr(key: string, defaultValue?: string): string {
  const val = process.env[key] ?? defaultValue;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function envInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Invalid integer for ${key}: ${raw}`);
  if (parsed <= 0) throw new Error(`${key} must be a positive integer, got: ${parsed}`);
  return parsed;
}

export const config = {
  // Helius
  heliusApiKey: envStr('HELIUS_API_KEY', ''),
  heliusRpcUrl: envStr('HELIUS_RPC_URL', ''),
  heliusWsUrl: envStr('HELIUS_WS_URL', ''),
  /** Enhanced WS (Atlas) URL for transactionSubscribe. Auto-derived from API key if not set. */
  heliusEnhancedWsUrl: envStr(
    'HELIUS_ENHANCED_WS_URL',
    process.env.HELIUS_API_KEY
      ? `wss://atlas-mainnet.helius-rpc.com?api-key=${process.env.HELIUS_API_KEY}`
      : '',
  ),

  // Database
  dbPath: envStr('DB_PATH', './data/research.db'),

  // Collect mode
  /** Max tokens to track concurrently. Default: 3 */
  maxConcurrentTokens: envInt('MAX_CONCURRENT_TOKENS', 3),
  /** How long to track each token (seconds). Default: 300 (5 minutes) */
  trackingDurationSeconds: envInt('TRACKING_DURATION_SECONDS', 300),
  /** Snapshot interval (seconds). Default: 5 */
  snapshotIntervalSeconds: envInt('SNAPSHOT_INTERVAL_SECONDS', 5),
  /** Max transactions to sample per snapshot for buy/sell classification */
  maxTxSamplePerSnapshot: envInt('MAX_TX_SAMPLE_PER_SNAPSHOT', 10),
  /** Minimum tx count required after early check — tokens below this are rejected as dead */
  minTxToKeep: envInt('MIN_TX_TO_KEEP', 10),
  /** Number of snapshots before checking if the token is dead */
  earlyExitAfterSnapshots: envInt('EARLY_EXIT_AFTER_SNAPSHOTS', 6),

  // Dashboard
  /** Port for the dashboard web server */
  dashboardPort: envInt('PORT', 3000),
} as const;

/** Check whether Helius credentials are configured for collection */
export function hasCollectConfig(): boolean {
  return !!(config.heliusApiKey && config.heliusRpcUrl && (config.heliusEnhancedWsUrl || config.heliusWsUrl));
}

/** JSON snapshot of config for storing in runs table.
 *  Helius credentials are redacted — the API key must not be persisted
 *  in the database where it could be extracted via DB exports or backups.
 */
export function configSnapshot(): string {
  const { heliusApiKey: _k, heliusRpcUrl: _r, heliusWsUrl: _w, ...rest } = config;
  return JSON.stringify({
    ...rest,
    heliusApiKey: '[REDACTED]',
    heliusRpcUrl: '[REDACTED]',
    heliusWsUrl: '[REDACTED]',
  });
}
