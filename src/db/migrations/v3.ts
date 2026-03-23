import Database from 'better-sqlite3';

export const v3Migration = {
  version: 3,
  description: 'Add sell-pressure columns to snapshots: sell_velocity, sell_acceleration, top_seller_concentration, creator_selling',
  up(db: Database.Database): void {
    db.exec(`
      ALTER TABLE snapshots ADD COLUMN sell_velocity REAL;
      ALTER TABLE snapshots ADD COLUMN sell_acceleration REAL;
      ALTER TABLE snapshots ADD COLUMN top_seller_concentration REAL;
      ALTER TABLE snapshots ADD COLUMN creator_selling INTEGER DEFAULT 0;
    `);
  },
};
