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
  return parsed;
}

function envFloat(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) throw new Error(`Invalid float for ${key}: ${raw}`);
  return parsed;
}

export const config = {
  mode: envStr('MODE', 'collect') as 'collect' | 'label',

  // Helius
  heliusApiKey: envStr('HELIUS_API_KEY', ''),
  heliusRpcUrl: envStr('HELIUS_RPC_URL', ''),
  heliusWsUrl: envStr('HELIUS_WS_URL', ''),

  // Database
  dbPath: envStr('DB_PATH', '/data/research.db'),

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

/** JSON snapshot of config for storing in runs table */
export function configSnapshot(): string {
  return JSON.stringify(config);
}
