import Database from 'better-sqlite3';

export const v1Migration = {
  version: 1,
  description: 'Create initial schema: runs, tokens, token_runs, snapshots, outcomes',
  up(db: Database.Database): void {
    db.exec(`
      CREATE TABLE runs (
        run_id              TEXT PRIMARY KEY,
        mode                TEXT NOT NULL,
        started_at          INTEGER NOT NULL,
        completed_at        INTEGER,
        tokens_observed     INTEGER DEFAULT 0,
        entries_triggered   INTEGER DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'running',
        ws_disconnect_count INTEGER DEFAULT 0,
        ws_disconnect_ms    INTEGER DEFAULT 0,
        config_json         TEXT
      );

      CREATE TABLE tokens (
        mint                    TEXT PRIMARY KEY,
        creator                 TEXT NOT NULL,
        name                    TEXT,
        symbol                  TEXT,
        created_at              INTEGER NOT NULL,
        initial_virtual_sol     REAL,
        initial_virtual_token   REAL,
        initial_price_sol       REAL,
        bonding_curve_pda       TEXT NOT NULL
      );
      CREATE INDEX idx_tokens_creator ON tokens(creator);

      CREATE TABLE token_runs (
        run_id          TEXT NOT NULL,
        mint            TEXT NOT NULL,
        first_seen_at   INTEGER NOT NULL,
        PRIMARY KEY (run_id, mint),
        FOREIGN KEY (run_id) REFERENCES runs(run_id),
        FOREIGN KEY (mint) REFERENCES tokens(mint)
      );
      CREATE INDEX idx_token_runs_mint ON token_runs(mint);

      CREATE TABLE snapshots (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        mint                    TEXT NOT NULL,
        run_id                  TEXT NOT NULL,
        snapshot_at             INTEGER NOT NULL,
        seconds_since_creation  REAL NOT NULL,
        phase                   TEXT NOT NULL,
        virtual_sol_reserves    REAL,
        virtual_token_reserves  REAL,
        real_sol_reserves       REAL,
        real_token_reserves     REAL,
        price_sol               REAL,
        total_tx_count          INTEGER,
        tx_count_delta          INTEGER,
        buy_count               INTEGER,
        sell_count              INTEGER,
        unique_buyers           INTEGER,
        unique_sellers          INTEGER,
        sample_size             INTEGER,
        sample_total            INTEGER,
        sample_method           TEXT,
        buy_velocity            REAL,
        volume_velocity_sol     REAL,
        buyer_tx_ratio          REAL,
        sell_ratio              REAL,
        FOREIGN KEY (mint) REFERENCES tokens(mint),
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
      CREATE INDEX idx_snapshots_mint_time ON snapshots(mint, seconds_since_creation);
      CREATE INDEX idx_snapshots_run ON snapshots(run_id);

      CREATE TABLE outcomes (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        mint                TEXT NOT NULL,
        label_run_id        TEXT NOT NULL,
        collect_run_id      TEXT NOT NULL,
        entry_triggered     INTEGER NOT NULL,
        entry_price_sol     REAL,
        entry_seconds       REAL,
        entry_snapshot_id   INTEGER,
        max_price_sol       REAL,
        max_price_seconds   REAL,
        min_price_after_entry REAL,
        final_price_sol     REAL,
        max_gain_pct        REAL,
        max_drawdown_pct    REAL,
        final_gain_pct      REAL,
        hit_2x              INTEGER,
        time_to_2x_seconds  REAL,
        time_to_peak_seconds REAL,
        entry_config_json   TEXT,
        FOREIGN KEY (mint) REFERENCES tokens(mint)
      );
      CREATE INDEX idx_outcomes_mint ON outcomes(mint);
      CREATE INDEX idx_outcomes_collect_run ON outcomes(collect_run_id);
      CREATE INDEX idx_outcomes_label_run ON outcomes(label_run_id);
    `);
  },
};
