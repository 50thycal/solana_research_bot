import Database from 'better-sqlite3';
import { v1Migration } from './v1';
import { v2Migration } from './v2';

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  v1Migration,
  v2Migration,
];

/**
 * Version-based migration runner.
 * Tracks applied migrations in a `_migrations` meta table.
 */
export function runMigrations(db: Database.Database): void {
  // Create the migrations tracking table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);

  const currentVersion = db.prepare(
    'SELECT COALESCE(MAX(version), 0) as version FROM _migrations'
  ).get() as { version: number };

  const pending = migrations.filter(m => m.version > currentVersion.version);

  if (pending.length === 0) return;

  for (const migration of pending) {
    console.log(JSON.stringify({
      event: 'migration_applying',
      version: migration.version,
      description: migration.description,
    }));

    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.description, Date.now());
    });

    applyMigration();

    console.log(JSON.stringify({
      event: 'migration_applied',
      version: migration.version,
    }));
  }
}
