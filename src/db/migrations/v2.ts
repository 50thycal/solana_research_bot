import Database from 'better-sqlite3';

export const v2Migration = {
  version: 2,
  description: 'Add market_cap_sol column to snapshots',
  up(db: Database.Database): void {
    db.exec(`
      ALTER TABLE snapshots ADD COLUMN market_cap_sol REAL;
    `);
  },
};
