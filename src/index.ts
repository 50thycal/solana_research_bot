import { config, validateCollectConfig } from './config';
import { openDatabase, closeDatabase } from './db/init';
import { markStaleRunsAsFailed } from './db/queries/runs';
import { runCollect } from './collector/collect';
import { runLabel } from './labeler/label';
import { runValidate } from './validate';

async function main(): Promise<void> {
  console.log(JSON.stringify({
    event: 'startup',
    mode: config.mode,
    timestamp: new Date().toISOString(),
  }));

  // Validate Helius credentials before opening the database in collect mode
  if (config.mode === 'collect') {
    validateCollectConfig();
  }

  // Initialize database and run migrations
  const db = openDatabase(config.dbPath);

  // Crash recovery: mark any stale 'running' rows as 'failed'
  try {
    const staleCount = markStaleRunsAsFailed(db);
    if (staleCount > 0) {
      console.log(JSON.stringify({
        event: 'crash_recovery',
        staleRunsMarkedFailed: staleCount,
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: 'crash_recovery_error',
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  try {
    if (config.mode === 'collect') {
      console.log(JSON.stringify({ event: 'collect_start' }));
      await runCollect(db);
    } else if (config.mode === 'label') {
      console.log(JSON.stringify({ event: 'label_start' }));
      await runLabel(db);
    } else if (config.mode === 'validate') {
      console.log(JSON.stringify({ event: 'validate_start' }));
      await runValidate(db);
    } else {
      throw new Error(`Unknown mode: ${config.mode}`);
    }
  } finally {
    closeDatabase(db);
  }
}

// Handle SIGTERM for graceful shutdown
// Note: collect mode installs its own SIGTERM handler that handles partial status + checkpoint.
// This is a fallback for label mode or pre-init SIGTERM.
process.on('SIGTERM', () => {
  console.log(JSON.stringify({ event: 'sigterm_received' }));
  process.exit(0);
});

main().catch((err) => {
  console.error(JSON.stringify({
    event: 'fatal_error',
    error: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
