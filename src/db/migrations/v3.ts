import Database from 'better-sqlite3';

export const v3Migration = {
  version: 3,
  description: 'Add sell velocity, sell acceleration, top seller concentration, creator selling columns to snapshots',
  up(db: Database.Database): void {
    db.exec(`
      ALTER TABLE snapshots ADD COLUMN sell_velocity REAL;
      ALTER TABLE snapshots ADD COLUMN sell_acceleration REAL;
      ALTER TABLE snapshots ADD COLUMN top_seller_concentration REAL;
      ALTER TABLE snapshots ADD COLUMN creator_selling INTEGER;
    `);
  },
};
