# Pump.fun Research Collector — V1 Spec
> **Status:** Approved for implementation
> **Date:** 2026-02-18
> **Repo:** New standalone repo (separate from trading bot)
> **Runtime:** Railway cron job with persistent volume
> **Database:** SQLite (better-sqlite3)
> **Data source:** Helius RPC + WebSocket
---
## Overview
A minimal research system that collects early-window microstructure data from pump.fun token launches, stores structured observations, and labels outcomes — so we can determine whether predictive signal exists before changing the trading bot.
**Core principle:** Optimize for speed of learning, not perfection.
---
## 1. Job Modes and Schedule
### Two script modes, one entry point
The process runs via a single `index.ts` entry point. The mode is selected by environment variable.
```
MODE=collect | label
```
### Mode: `collect`
**Purpose:** Observe new pump.fun tokens for a defined window, collect snapshots, exit.
**Lifecycle:**
1. **Init** — Generate `run_id` (UUIDv4), open SQLite, run migrations, insert `runs` row with status `running`.
2. **Observe** — Connect Helius WebSocket, watch for pump.fun Create instructions. For each new token, insert `tokens` row and begin snapshot tracking. At each snapshot interval (every 10 seconds), batch-fetch bonding curve accounts and transaction signatures for all tracked tokens. Insert `snapshots` rows.
3. **Outcome polling** — After observation window closes, stop watching for new tokens. Continue polling existing tracked tokens for `OUTCOME_WINDOW_MINUTES` at a wider interval (every 30 seconds) to capture price trajectory for labeling.
4. **Finalize** — Update `runs` row with `completed_at`, token count, status `complete`. WAL checkpoint. Exit 0.
**On SIGTERM:** Update `runs` row with status `partial`, checkpoint SQLite, exit 0.
**Environment variables:**
| Variable | Default | Purpose |
|---|---|---|
| `MODE` | `collect` | Script mode |
| `OBSERVATION_WINDOW_MINUTES` | `30` | How long to watch for new tokens |
| `OUTCOME_WINDOW_MINUTES` | `10` | How long to continue polling after observation ends |
| `SNAPSHOT_INTERVAL_MS` | `10000` | Milliseconds between snapshot rounds during observation |
| `OUTCOME_SNAPSHOT_INTERVAL_MS` | `30000` | Milliseconds between snapshot rounds during outcome window |
| `MAX_TOKENS_PER_RUN` | `150` | Safety cap — stop tracking new tokens after this count |
| `HELIUS_API_KEY` | (required) | Helius API key |
| `HELIUS_RPC_URL` | (required) | Helius RPC endpoint |
| `HELIUS_WS_URL` | (required) | Helius WebSocket endpoint |
| `DB_PATH` | `/data/research.db` | SQLite file path (Railway Volume mount) |
**Total run time:** ~42 minutes (30 observe + 10 outcome + ~2 min init/finalize).
### Mode: `label`
**Purpose:** Read snapshots from past runs, apply a parameterized entry definition, compute outcome metrics, write to `outcomes` table. Can be re-run with different parameters on the same data.
**Lifecycle:**
1. **Init** — Open SQLite (read snapshots, write outcomes).
2. **Clear previous labels** — Delete existing `outcomes` rows for the target run(s) (allows re-labeling).
3. **For each token with snapshots:**
   - Walk snapshots in time order.
   - Apply entry condition (parameterized thresholds from env vars).
   - If entry triggers: compute outcome metrics from all post-entry snapshots.
   - Write `outcomes` row.
4. **Summary** — Log counts: tokens processed, entries triggered, 2x hits, rugs.
5. **Exit 0.**
**Label-specific environment variables:**
| Variable | Default | Purpose |
|---|---|---|
| `LABEL_RUN_ID` | `all` | Which run(s) to label. `all` = all unlabeled runs |
| `ENTRY_MIN_BUY_COUNT` | `5` | Minimum buy transactions for entry |
| `ENTRY_MIN_UNIQUE_BUYERS` | `3` | Minimum distinct wallets |
| `ENTRY_MIN_BUY_VELOCITY` | `0.25` | Minimum buys per second |
| `ENTRY_MAX_SELL_RATIO` | `0.20` | Maximum sell proportion |
| `ENTRY_MAX_SECONDS` | `120` | Entry must occur within this window |
| `OUTCOME_WINDOW_SECONDS` | `600` | Measure outcomes for this long after entry |
**Does NOT use Helius.** All data comes from SQLite. Can run on any machine with the database file.
### Recommended cron cadence
| Job | Schedule | Rationale |
|---|---|---|
| `collect` | `0 */4 * * *` (every 4 hours) | 6 runs/day, covers diverse market windows |
| `label` | `30 3 * * *` (daily at 3:30 AM UTC) | Once per day, labels all complete runs from previous day |
Collect and label are separate Railway cron services pointing at the same Railway Volume.
Rotate the cron offset periodically (e.g., change from `0 */4` to `30 */4` weekly) to avoid time-of-day sampling bias.
---
## 2. SQLite Schema (v1)
### Table: `runs`
Tracks every collector invocation for data integrity.
```sql
CREATE TABLE runs (
    run_id          TEXT PRIMARY KEY,
    mode            TEXT NOT NULL,                -- 'collect' or 'label'
    started_at      INTEGER NOT NULL,             -- unix ms
    completed_at    INTEGER,                      -- unix ms, NULL if incomplete
    tokens_observed INTEGER DEFAULT 0,
    entries_triggered INTEGER DEFAULT 0,          -- populated by label mode
    status          TEXT NOT NULL DEFAULT 'running', -- 'running','complete','partial','failed'
    config_json     TEXT                          -- snapshot of env config for reproducibility
);
```
No indexes needed beyond primary key. Low row count.
### Table: `tokens`
Registry of every token observed.
```sql
CREATE TABLE tokens (
    mint                    TEXT PRIMARY KEY,
    creator                 TEXT NOT NULL,
    name                    TEXT,
    symbol                  TEXT,
    created_at              INTEGER NOT NULL,     -- on-chain timestamp, unix seconds
    first_seen_at           INTEGER NOT NULL,     -- collector timestamp, unix ms
    initial_virtual_sol     REAL,                 -- starting bonding curve SOL reserves
    initial_virtual_token   REAL,                 -- starting bonding curve token reserves
    initial_price_sol       REAL,                 -- derived: initial_virtual_sol / initial_virtual_token
    run_id                  TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX idx_tokens_run ON tokens(run_id);
CREATE INDEX idx_tokens_creator ON tokens(creator);
```
**All columns mandatory except:** `name`, `symbol` (some tokens have empty metadata). `initial_virtual_sol`, `initial_virtual_token`, `initial_price_sol` are mandatory in practice but nullable in schema to handle edge cases where the first bonding curve fetch fails.
### Table: `snapshots`
One row per token per observation interval. Primary analytical table.
```sql
CREATE TABLE snapshots (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    mint                    TEXT NOT NULL,
    run_id                  TEXT NOT NULL,
    snapshot_at             INTEGER NOT NULL,     -- unix ms
    seconds_since_creation  REAL NOT NULL,        -- elapsed from token created_at
    phase                   TEXT NOT NULL,         -- 'observe' or 'outcome'
    -- Bonding curve state (directly observed)
    virtual_sol_reserves    REAL,
    virtual_token_reserves  REAL,
    real_sol_reserves       REAL,
    real_token_reserves     REAL,
    price_sol               REAL,                 -- derived: virtual_sol / virtual_token
    -- Transaction counts (from getSignaturesForAddress, approximate)
    total_tx_count          INTEGER,              -- total signatures since creation
    tx_count_delta          INTEGER,              -- new txs since last snapshot
    -- Buy/sell breakdown (from sampled transaction parsing)
    buy_count               INTEGER,              -- estimated cumulative buys
    sell_count              INTEGER,              -- estimated cumulative sells
    unique_buyers           INTEGER,              -- estimated distinct buy wallets
    unique_sellers          INTEGER,              -- estimated distinct sell wallets
    sample_size             INTEGER,              -- how many txs were parsed to estimate buy/sell
    sample_total            INTEGER,              -- total txs available when sample was taken
    -- Derived features (computed at insert time from current + prior snapshots)
    buy_velocity            REAL,                 -- buy_count / seconds_since_creation
    volume_velocity_sol     REAL,                 -- approx volume / seconds_since_creation
    buyer_tx_ratio          REAL,                 -- unique_buyers / buy_count (NULL if buy_count=0)
    sell_ratio              REAL,                 -- sell_count / (buy_count + sell_count) (NULL if 0 txs)
    FOREIGN KEY (mint) REFERENCES tokens(mint),
    FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX idx_snapshots_mint_time ON snapshots(mint, seconds_since_creation);
CREATE INDEX idx_snapshots_run ON snapshots(run_id);
```
**Mandatory columns:** `mint`, `run_id`, `snapshot_at`, `seconds_since_creation`, `phase`.
**All other columns nullable.** If an RPC call fails for a specific snapshot, we insert the row with NULLs for the fields we couldn't fetch rather than skipping the row entirely. This preserves the time series and makes gaps visible.
**Why `sample_size` and `sample_total`:** Since buy/sell/unique counts come from sampling transactions (not parsing all of them), we record the sample parameters so analysis can account for estimation uncertainty.
### Table: `outcomes`
One row per token per labeling pass. Written by `label` mode only.
```sql
CREATE TABLE outcomes (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    mint                TEXT NOT NULL,
    label_run_id        TEXT NOT NULL,            -- which label run produced this
    collect_run_id      TEXT NOT NULL,            -- which collect run the data came from
    -- Entry point (determined by parameterized entry condition)
    entry_triggered     INTEGER NOT NULL,         -- boolean: 0 or 1
    entry_price_sol     REAL,                     -- NULL if no entry triggered
    entry_seconds       REAL,                     -- seconds after creation when entry fired
    entry_snapshot_id   INTEGER,                  -- FK to the snapshot that triggered entry
    -- Outcome metrics (NULL if no entry triggered)
    max_price_sol       REAL,
    max_price_seconds   REAL,                     -- seconds after creation
    min_price_after_entry REAL,
    final_price_sol     REAL,
    max_gain_pct        REAL,                     -- (max - entry) / entry * 100
    max_drawdown_pct    REAL,                     -- (min_after - entry) / entry * 100
    final_gain_pct      REAL,                     -- (final - entry) / entry * 100
    hit_2x              INTEGER,                  -- boolean
    time_to_2x_seconds  REAL,                     -- NULL if never hit 2x
    time_to_peak_seconds REAL,                    -- seconds from entry to max price
    -- Entry parameters used (for reproducibility)
    entry_config_json   TEXT,                     -- JSON snapshot of ENTRY_* env vars
    FOREIGN KEY (mint) REFERENCES tokens(mint)
);
CREATE INDEX idx_outcomes_mint ON outcomes(mint);
CREATE INDEX idx_outcomes_collect_run ON outcomes(collect_run_id);
CREATE INDEX idx_outcomes_label_run ON outcomes(label_run_id);
```
**No categorical labels stored in this table.** Labels like `moon`, `pump_dump`, `rug` are derived at analysis time from the continuous metrics. This lets us change label definitions without re-running the labeler.
**`entry_config_json`:** Stores the exact threshold parameters used, so when you look at outcomes months later you know exactly what entry definition produced them.
---
## 3. Feature Scope (v1)
### Tier 1 — Cheap, reliable, always collected
These come from a single `getAccountInfo` call on the bonding curve PDA (batchable via `getMultipleAccounts`).
| Feature | Source | Cost | Reliability |
|---|---|---|---|
| `virtual_sol_reserves` | Bonding curve account data | 1 RPC call per batch | High — direct on-chain read |
| `virtual_token_reserves` | Bonding curve account data | (same call) | High |
| `real_sol_reserves` | Bonding curve account data | (same call) | High |
| `real_token_reserves` | Bonding curve account data | (same call) | High |
| `price_sol` | Derived: `virtual_sol / virtual_token` | No call | Exact |
### Tier 2 — Moderate cost, approximate
| Feature | Source | Cost | Reliability |
|---|---|---|---|
| `total_tx_count` | `getSignaturesForAddress` on bonding curve | 1 call per token per snapshot | High (count is exact) |
| `tx_count_delta` | Diff from previous snapshot | No call | Exact |
### Tier 3 — Expensive, sampled, explicitly approximate
| Feature | Source | Cost | Reliability |
|---|---|---|---|
| `buy_count` | Parse sampled transactions | N `getTransaction` calls per token | **Approximate** — extrapolated from sample |
| `sell_count` | Parse sampled transactions | (same calls) | **Approximate** |
| `unique_buyers` | Parse sampled transactions | (same calls) | **Approximate** — undercount guaranteed |
| `unique_sellers` | Parse sampled transactions | (same calls) | **Approximate** |
### Sampling strategy for Tier 3
At each snapshot interval, for each tracked token:
1. Call `getSignaturesForAddress` on the bonding curve → get full signature list.
2. Take the **most recent 10 signatures** that haven't been parsed yet.
3. Call `getTransaction` on each (batchable).
4. Parse each transaction to classify as buy or sell (check if SOL moved to or from the curve).
5. Extract wallet addresses.
6. Maintain a running in-memory set of wallets per token across snapshots.
7. Record `sample_size` (how many txs parsed this snapshot) and `sample_total` (total available).
**Why most recent 10:** Recent transactions are more indicative of current momentum. We accept undercounting for total accuracy in exchange for credit efficiency.
**Explicit approximation acknowledgment:** `unique_buyers` will be an undercount because we don't parse every transaction. `buy_count` and `sell_count` are extrapolated: `estimated_buys = (buys_in_sample / sample_size) * total_tx_count`. This is documented in the schema and must be accounted for in analysis.
### Derived features (computed at insert, not fetched)
| Feature | Formula | Notes |
|---|---|---|
| `buy_velocity` | `buy_count / seconds_since_creation` | Smoothed by cumulative nature |
| `volume_velocity_sol` | Approximate: price change * tx count as proxy | Rough estimate, not precise volume |
| `buyer_tx_ratio` | `unique_buyers / buy_count` | Low ratio = one wallet buying repeatedly |
| `sell_ratio` | `sell_count / (buy_count + sell_count)` | Early sell pressure indicator |
### What we are NOT collecting in v1
- Full wallet distribution / top-N holder analysis (too many RPC calls)
- Token metadata content analysis (name/symbol patterns — available from creation event, not from RPC)
- Social link validity checks
- Cross-token creator analysis (do later on stored `creator` field)
- Precise SOL volume (would require parsing every transaction amount)
---
## 4. Outcome Definition (v1)
### Entry condition (parameterized, applied at label time)
A hypothetical entry triggers at the **first snapshot** where ALL of the following are true:
| Condition | Default threshold | Env var |
|---|---|---|
| Cumulative buy count | >= 5 | `ENTRY_MIN_BUY_COUNT` |
| Unique buyer wallets | >= 3 | `ENTRY_MIN_UNIQUE_BUYERS` |
| Buy velocity (buys/sec) | >= 0.25 | `ENTRY_MIN_BUY_VELOCITY` |
| Sell ratio | <= 0.20 | `ENTRY_MAX_SELL_RATIO` |
| Time since creation | <= 120s | `ENTRY_MAX_SECONDS` |
**Entry price:** `price_sol` from the snapshot that triggered entry.
**If no snapshot meets all conditions:** `entry_triggered = 0`, all outcome fields NULL. Token is still in the dataset — the absence of entry is data.
### Outcome measurement
**Anchor:** Entry price at entry time.
**Window:** `OUTCOME_WINDOW_SECONDS` (default 600 = 10 minutes) measured from entry time, not token creation.
From all snapshots after entry and within the outcome window, compute:
| Metric | Definition |
|---|---|
| `max_price_sol` | Highest `price_sol` in any post-entry snapshot |
| `max_price_seconds` | `seconds_since_creation` of the max price snapshot |
| `min_price_after_entry` | Lowest `price_sol` in any post-entry snapshot |
| `final_price_sol` | `price_sol` of the last snapshot within the outcome window |
| `max_gain_pct` | `(max_price - entry_price) / entry_price * 100` |
| `max_drawdown_pct` | `(min_price_after_entry - entry_price) / entry_price * 100` |
| `final_gain_pct` | `(final_price - entry_price) / entry_price * 100` |
| `hit_2x` | 1 if `max_price >= entry_price * 2`, else 0 |
| `time_to_2x_seconds` | `max_price_seconds - entry_seconds` if hit_2x, else NULL |
| `time_to_peak_seconds` | `max_price_seconds - entry_seconds` |
### Categorical labels (NOT stored, derived at analysis time)
For convenience during analysis, apply these as SQL views or in-query CASE statements:
| Label | Condition |
|---|---|
| `moon` | `max_gain_pct >= 100 AND final_gain_pct >= 50` |
| `pump_dump` | `max_gain_pct >= 50 AND final_gain_pct <= 0` |
| `rug` | `max_drawdown_pct <= -80 AND` drawdown occurs within 120s of entry |
| `slow_bleed` | `max_gain_pct < 50 AND final_gain_pct < -30` |
| `flat` | Everything else |
These definitions WILL change. That's why they're not in the schema.
---
## 5. Helius Cost Control Plan
### Calls used by mode
| Mode | Helius calls | Notes |
|---|---|---|
| `collect` | WebSocket subscription, `getMultipleAccounts`, `getSignaturesForAddress`, `getTransaction` | All Helius usage happens here |
| `label` | **None** | Reads SQLite only |
### Per-snapshot-round cost breakdown (during observation phase)
Assuming N tokens currently tracked:
| Call | Count | Purpose |
|---|---|---|
| `getMultipleAccounts` | `ceil(N / 100)` | Batch-fetch bonding curve states (max 100 per call) |
| `getSignaturesForAddress` | `N` | Get tx signature list per token |
| `getTransaction` | `min(N * 10, TX_SAMPLE_CAP)` | Parse sampled transactions |
### Per-run cost estimate
**Assumptions:** 100 tokens observed, 30-minute observation (180 snapshot rounds at 10s interval), 10-minute outcome phase (20 rounds at 30s interval).
| Phase | Rounds | getMultipleAccounts | getSignatures | getTransaction | Total calls |
|---|---|---|---|---|---|
| Observe (ramp up) | 180 | ~100 | ~5,400 | ~5,400 | ~10,900 |
| Outcome | 20 | ~20 | ~2,000 | 0 (skip sampling) | ~2,020 |
| **Total** | | | | | **~12,920** |
*Note: getSignatures and getTransaction counts are upper bounds. Early in a run, few tokens are tracked so actual call count is lower. The ramp-up is gradual — token count goes from 0 to N over 30 minutes.*
**Revised realistic estimate:** ~6,000-8,000 calls per run, accounting for the ramp.
### Safety limits
| Limit | Value | Purpose |
|---|---|---|
| `MAX_TOKENS_PER_RUN` | 150 | Stop adding new tokens after this count |
| `MAX_TX_SAMPLE_PER_TOKEN` | 10 | Max transactions parsed per token per snapshot |
| `MAX_TX_SAMPLE_PER_ROUND` | 200 | Cap total getTransaction calls per snapshot round |
| Outcome phase sampling | Disabled | Only fetch bonding curve + signature count during outcome phase |
| Per-call delay | 50ms | Minimum delay between individual RPC calls to avoid rate limiting |
| Batch delay | 200ms | Delay between snapshot rounds for different token batches |
### Credit budget per day (6 runs)
- Estimated: ~48,000-78,000 calls/day
- Helius free tier: 100,000 credits/day
- **Headroom: ~22-52k credits** — sufficient buffer for retries and bursts
### If approaching limits
1. Reduce `MAX_TX_SAMPLE_PER_TOKEN` from 10 to 5.
2. Increase `SNAPSHOT_INTERVAL_MS` from 10s to 15s.
3. Reduce `MAX_TOKENS_PER_RUN` from 150 to 100.
4. Skip Tier 3 features (buy/sell classification) entirely and rely on tx count + bonding curve state only.
---
## 6. Failure Handling and Data Integrity
### Run status tracking
| Status | Meaning | When set |
|---|---|---|
| `running` | Job is active | On init |
| `complete` | Job finished all phases | After finalize |
| `partial` | Job was interrupted (SIGTERM, timeout) | On SIGTERM handler |
| `failed` | Job hit an unrecoverable error | On uncaught exception handler |
Every analysis query should filter to `status = 'complete'` by default. Partial runs are kept for debugging but excluded from labeling unless explicitly included.
### SQLite integrity on Railway Volume
1. **WAL mode enabled** at database open: `PRAGMA journal_mode=WAL;`
2. **Synchronous = NORMAL**: `PRAGMA synchronous=NORMAL;` — balances durability with performance. Full sync is unnecessary for research data.
3. **Checkpoint on exit**: `PRAGMA wal_checkpoint(TRUNCATE);` — forces WAL contents into main DB file before exit. Prevents WAL file growth across runs.
4. **SIGTERM handler**: The handler has 10 seconds (Railway's grace period) to checkpoint and close. This is more than enough for SQLite.
5. **Busy timeout**: `PRAGMA busy_timeout=5000;` — prevents immediate failures if two processes briefly contend (shouldn't happen with cron spacing, but defensive).
### Crash recovery
If a run crashes without executing the SIGTERM handler:
- The `runs` row will have status `running` with no `completed_at`.
- On next startup, the job checks for any `running` rows and updates them to `failed`.
- WAL mode ensures the SQLite database is not corrupted even on unclean shutdown. This is a core SQLite guarantee.
### Backup recommendation (optional but advised)
After each `complete` run, copy the SQLite file to Railway's ephemeral storage or an external location:
- **Minimal approach:** At end of each run, `cp /data/research.db /data/backups/research-{run_id}.db`. Railway Volume has enough space for this. Prune backups older than 7 days.
- **Better approach:** Upload to an S3-compatible store (Cloudflare R2, Backblaze B2 — both have free tiers). One upload per day, not per run.
- **v1 acceptable approach:** Just use the Railway Volume and accept the risk. If the volume fails, you lose data and re-collect. The data has no monetary value until patterns are proven.
---
## 7. Implementation Checklist
### Phase 1: Project scaffold
- [ ] Create new repo `pumpfun-research-collector`
- [ ] Initialize TypeScript project with `tsconfig.json`, `package.json`
- [ ] Add dependencies: `better-sqlite3`, `@solana/web3.js`, `uuid`, `dotenv`
- [ ] Add dev dependencies: `typescript`, `@types/better-sqlite3`, `tsx`
- [ ] Create `.env.example` with all env vars from this spec
- [ ] Create `Dockerfile` for Railway (Node 20 base, build TS, run compiled JS)
- [ ] Create `.gitignore` (node_modules, .env, *.db)
### Phase 2: Database layer
- [ ] Implement SQLite initialization with WAL mode and pragmas
- [ ] Implement schema migration system (version-based, same pattern as trading bot)
- [ ] Create v1 migration with all 4 tables (`runs`, `tokens`, `snapshots`, `outcomes`)
- [ ] Implement `runs` CRUD (insert on start, update on complete/fail)
- [ ] Implement `tokens` insert
- [ ] Implement `snapshots` insert
- [ ] Implement `outcomes` insert/delete (for re-labeling)
- [ ] Add crash recovery check (mark stale `running` rows as `failed`)
### Phase 3: Data collection — bonding curve + token detection
- [ ] Duplicate minimal pump.fun parsing logic from trading bot:
  - Bonding curve account deserialization (layout + decode)
  - Price derivation from reserves
  - Program ID and account constants
- [ ] Implement Helius WebSocket connection for pump.fun Create events
  - Connection, subscription, reconnection with 5s backoff
  - Parse Create instruction to extract mint, creator, name, symbol, bonding curve PDA
- [ ] Implement bonding curve state fetcher (`getMultipleAccounts` batched)
- [ ] Implement snapshot loop:
  - Timer-based (setInterval at SNAPSHOT_INTERVAL_MS)
  - Batch-fetch all tracked bonding curves
  - Compute price, insert snapshot row
### Phase 4: Data collection — transaction sampling
- [ ] Implement `getSignaturesForAddress` caller for bonding curve PDAs
  - Returns total tx count
  - Returns most recent N signatures
- [ ] Implement `getTransaction` batch caller for sampled signatures
  - Parse transaction to classify buy vs sell (SOL direction)
  - Extract wallet addresses
- [ ] Implement running wallet set (in-memory, per token, across snapshots)
- [ ] Compute and insert Tier 3 features: buy_count, sell_count, unique_buyers, unique_sellers
- [ ] Respect safety caps: MAX_TX_SAMPLE_PER_TOKEN, MAX_TX_SAMPLE_PER_ROUND
- [ ] Add per-call delays for rate limiting
### Phase 5: Job lifecycle (collect mode)
- [ ] Implement main collect loop:
  1. Init phase (run_id, DB, config)
  2. Observation phase (WebSocket + snapshot loop for N minutes)
  3. Outcome phase (snapshot loop only, wider interval, no new tokens)
  4. Finalize (update run, WAL checkpoint, exit)
- [ ] Implement SIGTERM handler (partial status, checkpoint, exit)
- [ ] Implement MAX_TOKENS_PER_RUN cap
- [ ] Implement WebSocket reconnection
- [ ] Add structured logging (JSON lines to stdout — Railway captures this)
### Phase 6: Labeling (label mode)
- [ ] Implement entry condition evaluator
  - Walk snapshots for a token in time order
  - Check all threshold conditions at each snapshot
  - Return first snapshot that satisfies all conditions (or null)
- [ ] Implement outcome metric calculator
  - Given entry snapshot + all post-entry snapshots within window
  - Compute max_gain_pct, max_drawdown_pct, final_gain_pct, hit_2x, time metrics
- [ ] Implement label run:
  - Read all tokens for target collect run(s)
  - Clear existing outcomes for those runs if re-labeling
  - Process each token
  - Insert outcomes
  - Update runs table with entries_triggered count
- [ ] Log summary statistics at end of label run
### Phase 7: Railway deployment
- [ ] Create Railway project
- [ ] Create Railway Volume, mount at `/data`
- [ ] Create `collect` cron service (schedule: `0 */4 * * *`, uses Dockerfile)
- [ ] Create `label` cron service (schedule: `30 3 * * *`, same Dockerfile, MODE=label)
- [ ] Set environment variables in Railway dashboard
- [ ] Test manual trigger from phone
- [ ] Verify SQLite persistence across runs (run collect, check data, run label, check outcomes)
### Phase 8: Validation
- [ ] Run 3 consecutive collect cycles, verify data in SQLite
- [ ] Run label pass, verify outcomes are computed
- [ ] Spot-check 5 tokens manually: compare collector data to on-chain reality
- [ ] Verify SIGTERM handling (cancel a Railway job mid-run, check status = partial)
- [ ] Verify credit usage is within budget
---
## Non-Goals (v1)
Explicitly NOT doing these in v1:
- **No dashboard or UI.** Analysis is done by querying SQLite directly (DB Browser for SQLite, or a script).
- **No automated signal generation.** V1 is data collection and labeling only.
- **No integration with the trading bot.** The trading bot is not touched.
- **No shared packages or monorepo.** Pump.fun parsing logic is duplicated.
- **No Postgres.** SQLite only.
- **No external data sources.** No Dune, no Birdeye, no Jupiter. Helius + RPC only.
- **No real-time streaming.** Job-based collection only.
- **No ML or model training.** V1 produces a labeled dataset. Statistical analysis is manual.
- **No wallet clustering or sybil detection.** Accept that unique_buyers is approximate.
- **No creator profiling or cross-token analysis.** Data is stored to enable this later, but v1 doesn't implement it.
- **No alerting or notifications.** Check Railway logs from your phone.
- **No tests.** Speed of learning over code quality. Tests come in v1.1 if the data shows signal.
- **No historical backfill.** We start collecting from now, forward only.
---
## Success Criteria
V1 is successful if, after 2 weeks of collection (~84 runs, ~1,000+ tokens with snapshots):
1. The SQLite database is populated with clean, queryable data.
2. Labeling produces outcomes for a meaningful subset of observed tokens.
3. We can answer basic questions like:
   - What percentage of tokens that trigger our entry condition hit 2x?
   - Is there a difference in `unique_buyers` at T+30s between tokens that moon vs rug?
   - Does `sell_ratio` at T+60s predict anything?
4. We have enough data to decide whether to invest in v1.1 (refined features, more collection, pattern extraction) or pivot the approach.
**The goal is not to find the pattern. The goal is to collect enough structured data to determine whether looking for patterns is worth the effort.**
