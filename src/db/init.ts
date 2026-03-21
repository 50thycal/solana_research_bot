import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { runMigrations } from './migrations/runner';
import { logError } from '../logger';

/**
 * Open SQLite database with WAL mode and recommended pragmas.
 * Creates parent directories if they don't exist.
 * Runs all pending migrations.
 */
export function openDatabase(dbPath: string): Database.Database {
  // Ensure the directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Set pragmas per spec Section 6
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  // Run migrations
  runMigrations(db);

  return db;
}

/**
 * Gracefully close the database with WAL checkpoint.
 */
export function closeDatabase(db: Database.Database): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    logError({
      event: 'wal_checkpoint_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  db.close();
}
