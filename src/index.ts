import { config, validateCollectConfig } from './config';
import { openDatabase, closeDatabase } from './db/init';
import { markStaleRunsAsFailed } from './db/queries/runs';
import { runCollect } from './collector/collect';
import { startDashboard } from './dashboard/server';

async function main(): Promise<void> {
  console.log(JSON.stringify({
    event: 'startup',
    timestamp: new Date().toISOString(),
  }));

  validateCollectConfig();

  const db = openDatabase(config.dbPath);

  process.on('exit', () => {
    if (db.open) {
      try { closeDatabase(db); } catch { /* best-effort checkpoint */ }
    }
  });

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

  // Start dashboard server in background — always available
  const server = await startDashboard(db);

  try {
    // Run collector (blocks until SIGTERM)
    await runCollect(db);
  } finally {
    server.close();
    closeDatabase(db);
  }
}

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
