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

const mode = envStr('MODE', 'collect') as 'collect' | 'dashboard';

export const config = {
  mode,

  // Helius (required for collect mode)
  heliusApiKey: envStr('HELIUS_API_KEY', ''),
  heliusRpcUrl: envStr('HELIUS_RPC_URL', ''),
  heliusWsUrl: envStr('HELIUS_WS_URL', ''),

  // Database
  dbPath: envStr('DB_PATH', './data/research.db'),

  // Collect mode — single-token tracking
  /** How long to track each token (seconds). Default: 300 (5 minutes) */
  trackingDurationSeconds: envInt('TRACKING_DURATION_SECONDS', 300),
  /** Snapshot interval (seconds). Default: 5 */
  snapshotIntervalSeconds: envInt('SNAPSHOT_INTERVAL_SECONDS', 5),
  /** Max transactions to sample per snapshot for buy/sell classification */
  maxTxSamplePerSnapshot: envInt('MAX_TX_SAMPLE_PER_SNAPSHOT', 10),

  // Dashboard
  /** Port for the dashboard web server */
  dashboardPort: envInt('PORT', 3000),
} as const;

/** Validate that required Helius credentials are set for collect mode */
export function validateCollectConfig(): void {
  const missing: string[] = [];
  if (!config.heliusApiKey) missing.push('HELIUS_API_KEY');
  if (!config.heliusRpcUrl) missing.push('HELIUS_RPC_URL');
  if (!config.heliusWsUrl) missing.push('HELIUS_WS_URL');
  if (missing.length > 0) {
    throw new Error(
      `Collect mode requires the following environment variables: ${missing.join(', ')}`
    );
  }
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
