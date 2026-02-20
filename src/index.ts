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

  // Ensure WAL is checkpointed even when the process is killed via process.exit().
  // The try/finally block below handles normal termination; this covers SIGTERM paths
  // where collect mode calls process.exit() after its 5-second grace period.
  // better-sqlite3's db.open property guards against double-close.
  process.on('exit', () => {
    if (db.open) {
      try { closeDatabase(db); } catch { /* ignore — best-effort checkpoint */ }
    }
  });

  // Crash recovery: mark any stale 'running' rows as 'failed'.
  // NOTE: Do not manually trigger collect and label/validate services concurrently
  // against the same database — this recovery step will mark the collect run as
  // 'failed' even if it is still genuinely in progress.
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
