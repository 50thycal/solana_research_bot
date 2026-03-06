import { config, validateCollectConfig } from './config';
import { openDatabase, closeDatabase } from './db/init';
import { markStaleRunsAsFailed } from './db/queries/runs';
import { runCollect } from './collector/collect';
import { runDashboard } from './dashboard/server';

async function main(): Promise<void> {
  console.log(JSON.stringify({
    event: 'startup',
    mode: config.mode,
    timestamp: new Date().toISOString(),
  }));

  if (config.mode === 'collect') {
    validateCollectConfig();
  }

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

  try {
    if (config.mode === 'collect') {
      console.log(JSON.stringify({ event: 'collect_start' }));
      await runCollect(db);
    } else if (config.mode === 'dashboard') {
      console.log(JSON.stringify({ event: 'dashboard_start' }));
      await runDashboard(db);
    } else {
      throw new Error(`Unknown mode: ${config.mode}`);
    }
  } finally {
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
