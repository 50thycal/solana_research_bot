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

function envFloat(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) throw new Error(`Invalid float for ${key}: ${raw}`);
  if (parsed < 0) throw new Error(`${key} must be non-negative, got: ${parsed}`);
  return parsed;
}

const mode = envStr('MODE', 'collect') as 'collect' | 'label' | 'validate';

export const config = {
  mode,

  // Helius (required for collect mode, validated at startup)
  heliusApiKey: envStr('HELIUS_API_KEY', ''),
  heliusRpcUrl: envStr('HELIUS_RPC_URL', ''),
  heliusWsUrl: envStr('HELIUS_WS_URL', ''),

  // Database
  dbPath: envStr('DB_PATH', './data/research.db'),

  // Collect mode
  observationWindowMinutes: envInt('OBSERVATION_WINDOW_MINUTES', 30),
  earlySnapshotIntervalMs: envInt('EARLY_SNAPSHOT_INTERVAL_MS', 5000),
  snapshotIntervalMs: envInt('SNAPSHOT_INTERVAL_MS', 10000),
  outcomeSnapshotIntervalMs: envInt('OUTCOME_SNAPSHOT_INTERVAL_MS', 30000),
  maxTrackMinutes: envInt('MAX_TRACK_MINUTES', 50),
  maxTokensPerRun: envInt('MAX_TOKENS_PER_RUN', 150),
  maxTxSamplePerToken: envInt('MAX_TX_SAMPLE_PER_TOKEN', 10),
  maxTxSamplePerRound: envInt('MAX_TX_SAMPLE_PER_ROUND', 200),

  // Label mode
  labelRunId: envStr('LABEL_RUN_ID', 'all'),
  entryMinBuyCount: envInt('ENTRY_MIN_BUY_COUNT', 5),
  entryMinUniqueBuyers: envInt('ENTRY_MIN_UNIQUE_BUYERS', 3),
  entryMinBuyVelocity: envFloat('ENTRY_MIN_BUY_VELOCITY', 0.25),
  entryMaxSellRatio: envFloat('ENTRY_MAX_SELL_RATIO', 0.20),
  entryMaxSeconds: envInt('ENTRY_MAX_SECONDS', 120),
  outcomeWindowSeconds: envInt('OUTCOME_WINDOW_SECONDS', 600),
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
