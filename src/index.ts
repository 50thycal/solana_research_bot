import fs from 'fs';
import { config, hasCollectConfig } from './config';
import { openDatabase, closeDatabase } from './db/init';
import { markStaleRunsAsFailed } from './db/queries/runs';
import { runCollect } from './collector/collect';
import { startDashboard } from './dashboard/server';

async function main(): Promise<void> {
  console.log(JSON.stringify({
    event: 'startup',
    timestamp: new Date().toISOString(),
  }));

  // RESET_DB=true → wipe the database file before opening.
  // Set this env var in Railway dashboard, deploy, then remove it.
  if (process.env.RESET_DB === 'true') {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = config.dbPath + suffix;
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    console.log(JSON.stringify({
      event: 'database_reset',
      message: 'Database wiped due to RESET_DB=true. Remove this env var now.',
    }));
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

  // Dashboard always starts — it's the main UI
  const server = await startDashboard(db);

  // Collector starts only if Helius credentials are configured
  if (hasCollectConfig()) {
    console.log(JSON.stringify({ event: 'collector_starting' }));
    try {
      await runCollect(db);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'collector_error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  } else {
    console.log(JSON.stringify({
      event: 'collector_skipped',
      reason: 'Helius credentials not configured. Dashboard-only mode.',
    }));
    // Keep the process alive for the dashboard
    await new Promise<void>((resolve) => {
      process.on('SIGTERM', () => {
        server.close();
        resolve();
      });
    });
  }

  server.close();
  closeDatabase(db);
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
