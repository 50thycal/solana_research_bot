import { config } from './config';
import { openDatabase, closeDatabase } from './db/init';
import { markStaleRunsAsFailed } from './db/queries/runs';

async function main(): Promise<void> {
  console.log(JSON.stringify({
    event: 'startup',
    mode: config.mode,
    timestamp: new Date().toISOString(),
  }));

  // Initialize database and run migrations
  const db = openDatabase(config.dbPath);

  // Crash recovery: mark any stale 'running' rows as 'failed'
  const staleCount = markStaleRunsAsFailed(db);
  if (staleCount > 0) {
    console.log(JSON.stringify({
      event: 'crash_recovery',
      staleRunsMarkedFailed: staleCount,
    }));
  }

  try {
    if (config.mode === 'collect') {
      // Phase 3+ will implement the collect logic
      console.log(JSON.stringify({ event: 'collect_start' }));
      throw new Error('Collect mode not yet implemented');
    } else if (config.mode === 'label') {
      // Phase 6 will implement the label logic
      console.log(JSON.stringify({ event: 'label_start' }));
      throw new Error('Label mode not yet implemented');
    } else {
      throw new Error(`Unknown mode: ${config.mode}`);
    }
  } finally {
    closeDatabase(db);
  }
}

// Handle SIGTERM for graceful shutdown
process.on('SIGTERM', () => {
  console.log(JSON.stringify({ event: 'sigterm_received' }));
  // Phase 5 will implement proper SIGTERM handling with partial status + checkpoint
  process.exit(0);
});

main().catch((err) => {
  console.error(JSON.stringify({
    event: 'fatal_error',
    error: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
