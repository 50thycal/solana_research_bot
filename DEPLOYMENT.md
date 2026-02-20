# Deployment & Setup Guide

## What This Project Is

A batch data collection system for pump.fun token launches on Solana. It has three modes:

- **collect** — Connects to Solana via Helius WebSocket, watches for new pump.fun token creates, takes periodic snapshots of bonding curve state and trading activity for ~50 minutes, then exits.
- **label** — Reads collected data from SQLite, evaluates entry conditions, computes outcome metrics (gain %, drawdown, 2x hit, etc.), writes results back to the DB.
- **validate** — Health check that queries the DB and prints data quality stats.

It is NOT a web server. It runs as a cron job on Railway.

---

## Prerequisites

- A [Helius](https://helius.dev) account with an API key (free tier: 100k credits/day)
- A [Railway](https://railway.app) account
- Node.js 20+ (for local testing only)
- Git + GitHub repo (Railway deploys from GitHub)

---

## Step 1: Get a Helius API Key

1. Go to [helius.dev](https://helius.dev) and create an account
2. Create a new API key (free tier gives 100,000 credits/day — enough for ~6 collect runs/day)
3. Save your API key

---

## Step 2: Install the Railway CLI

```bash
npm i -g @railway/cli
railway login
```

---

## Step 3: Push Code to GitHub

Railway deploys from a GitHub repo:

```bash
git remote add origin https://github.com/YOUR_USERNAME/solana_research_bot.git
git push -u origin main
```

---

## Step 4: Create the Railway Project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Name it `pumpfun-research-collector`

---

## Step 5: Create a Service and Attach a Volume

> **Important:** Railway does NOT support sharing a volume between two services.
> Since both collect and label modes need to read/write the same SQLite database,
> we use a **single service**. You switch between modes by changing the `MODE`
> environment variable and manually triggering the service, or use the cron
> schedule for automated collect runs.

### Create the service

1. In your project, click **+ New** → **Service** → connect your GitHub repo
2. Name the service: `collector`
3. Railway will auto-detect the Dockerfile — no build config needed

### Add the volume

Volumes are added **per-service**, not at the project level:

1. Click on your `collector` service to open it
2. Go to the **Settings** tab (or use `Cmd+K` / `Ctrl+K` → search "volume")
3. Scroll to the **Volume** section and click **Add Volume** (or **+ Mount**)
4. Set the mount path to: `/data`
5. Click **Save** / **Add**

This creates a persistent directory at `/data` inside the container. The SQLite database will live at `/data/research.db`. Data persists across deployments and cron runs.

### Set the cron schedule (for automated collect runs)

1. Still in **Settings**, find **Cron Schedule**
2. Set it to: `0 */4 * * *` (every 4 hours)

This will automatically run a collect job every 4 hours.

---

## Step 6: Set Environment Variables

1. Click on your `collector` service
2. Go to the **Variables** tab
3. You can paste these in using Railway's **RAW Editor** (click the toggle)

### For collect mode (default cron operation)

Copy this JSON into Railway's RAW Editor:

```json
{
  "MODE": "collect",
  "HELIUS_API_KEY": "YOUR_HELIUS_API_KEY_HERE",
  "HELIUS_RPC_URL": "https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY_HERE",
  "HELIUS_WS_URL": "wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY_HERE",
  "DB_PATH": "/data/research.db",
  "OBSERVATION_WINDOW_MINUTES": "30",
  "EARLY_SNAPSHOT_INTERVAL_MS": "5000",
  "SNAPSHOT_INTERVAL_MS": "10000",
  "OUTCOME_SNAPSHOT_INTERVAL_MS": "30000",
  "MAX_TRACK_MINUTES": "50",
  "MAX_TOKENS_PER_RUN": "150",
  "MAX_TX_SAMPLE_PER_TOKEN": "10",
  "MAX_TX_SAMPLE_PER_ROUND": "200"
}
```

> Replace all 3 instances of `YOUR_HELIUS_API_KEY_HERE` with your actual Helius API key.

### For label mode (when you want to run labeling)

Temporarily change these variables and manually trigger the service:

```json
{
  "MODE": "label",
  "DB_PATH": "/data/research.db",
  "LABEL_RUN_ID": "all",
  "ENTRY_MIN_BUY_COUNT": "5",
  "ENTRY_MIN_UNIQUE_BUYERS": "3",
  "ENTRY_MIN_BUY_VELOCITY": "0.25",
  "ENTRY_MAX_SELL_RATIO": "0.20",
  "ENTRY_MAX_SECONDS": "120",
  "OUTCOME_WINDOW_SECONDS": "600"
}
```

### For validate mode (health check)

```json
{
  "MODE": "validate",
  "DB_PATH": "/data/research.db"
}
```

---

## Step 7: Test It

### First test — collect mode

1. Make sure `MODE=collect` and your Helius variables are set
2. In the Railway dashboard, **manually trigger** the service (click the 3-dot menu → **Trigger Deploy** or **Run**)
3. Watch the logs for JSON output:
   - `{"event":"run_start","run_id":"...","mode":"collect"}`
   - `{"event":"ws_connected"}`
   - `{"event":"create_detected","mint":"..."}`
   - Snapshot events over ~50 minutes
   - `{"event":"run_complete"}`

### Second test — label mode

1. After a successful collect run, change `MODE` to `label` in the Variables tab
2. Add the label-specific variables (entry thresholds, outcome window)
3. Manually trigger the service
4. Watch logs for labeling output
5. **Change `MODE` back to `collect`** so the cron schedule runs the right thing

### Third test — validate mode

1. Change `MODE` to `validate`, manually trigger, check health output
2. **Change `MODE` back to `collect`** when done

---

## Running Locally (for testing)

```bash
# Install dependencies
npm install

# Copy env template and fill in your Helius key
cp .env.example .env
# Edit .env:
#   - Set HELIUS_API_KEY to your key
#   - Set HELIUS_RPC_URL to https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
#   - Set HELIUS_WS_URL to wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
#   - Change DB_PATH to ./data/research.db (local path)

# Create local data directory
mkdir -p data

# Run collect mode (dev, no build needed — uses tsx)
npm run dev:collect

# After it completes (~50 min), run label mode
npm run dev:label

# Check data health
npm run dev:validate
```

For production builds locally:

```bash
npm run build
MODE=collect npm start
```

---

## Key Details

### Database

SQLite with WAL mode. No external database service to provision — it's a file on the Railway volume. The schema (5 tables) is auto-created on first run via built-in migrations.

### Cost

Each collect run makes ~8,000–12,000 Helius RPC calls. At 6 runs/day that's ~50–72k calls, within the free tier's 100k/day limit.

### Run Duration

A collect run takes ~50 minutes (30 min observation window + ~20 min outcome tracking). The every-4-hours cron gives plenty of buffer.

### Crash Recovery

If a run crashes, the next startup automatically marks stale "running" records as "failed" in the DB.

### Backups

`scripts/backup-db.sh` creates timestamped copies of the SQLite file and prunes backups older than 7 days. To use it, add `sqlite3` to the Dockerfile's `apt-get install` line.

### Logs

All output is JSON-formatted to stdout. View in Railway's service logs dashboard.

### Why One Service Instead of Two?

Railway [does not support sharing a volume between services](https://docs.railway.com/reference/volumes). Since both collect and label modes need to access the same SQLite file at `/data/research.db`, they must run on the same service. You switch modes by changing the `MODE` env var.

---

## Environment Variable Quick Reference

### Required for collect mode (minimum viable deploy)

| Variable | Purpose |
|---|---|
| `MODE` | Set to `collect` |
| `HELIUS_API_KEY` | Your Helius API key |
| `HELIUS_RPC_URL` | `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` |
| `HELIUS_WS_URL` | `wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY` |
| `DB_PATH` | `/data/research.db` |

Everything else has sensible defaults. You can deploy with just these 5 variables and the collector will work.

### All collect mode variables

| Variable | Default | Purpose |
|---|---|---|
| `OBSERVATION_WINDOW_MINUTES` | `30` | How long to watch for new token launches |
| `EARLY_SNAPSHOT_INTERVAL_MS` | `5000` | Snapshot frequency for tokens < 120s old |
| `SNAPSHOT_INTERVAL_MS` | `10000` | Standard snapshot frequency |
| `OUTCOME_SNAPSHOT_INTERVAL_MS` | `30000` | Snapshot frequency during outcome tracking |
| `MAX_TRACK_MINUTES` | `50` | Hard cap on total run duration |
| `MAX_TOKENS_PER_RUN` | `150` | Stop accepting new tokens after this count |
| `MAX_TX_SAMPLE_PER_TOKEN` | `10` | Max transactions sampled per token per round |
| `MAX_TX_SAMPLE_PER_ROUND` | `200` | Cap on total getTransaction calls per round |

### All label mode variables

| Variable | Default | Purpose |
|---|---|---|
| `LABEL_RUN_ID` | `all` | Which collect run(s) to label (`all` or a specific run UUID) |
| `ENTRY_MIN_BUY_COUNT` | `5` | Min buy transactions to trigger entry |
| `ENTRY_MIN_UNIQUE_BUYERS` | `3` | Min distinct buyer wallets |
| `ENTRY_MIN_BUY_VELOCITY` | `0.25` | Min buys per second |
| `ENTRY_MAX_SELL_RATIO` | `0.20` | Max sell ratio (sells / total) |
| `ENTRY_MAX_SECONDS` | `120` | Entry must occur within this window |
| `OUTCOME_WINDOW_SECONDS` | `600` | Duration to measure outcomes after entry |
