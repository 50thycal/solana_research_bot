#!/usr/bin/env bash
#
# Railway deployment setup for pump.fun research collector.
#
# Prerequisites:
#   1. Install Railway CLI: npm i -g @railway/cli
#   2. Authenticate: railway login
#   3. Set HELIUS_API_KEY in your environment (or pass interactively)
#
# Usage:
#   chmod +x scripts/setup-railway.sh
#   ./scripts/setup-railway.sh
#
# What this script does:
#   - Creates a Railway project
#   - Creates a persistent volume at /data
#   - Creates two cron services (collect + label) from the same Dockerfile
#   - Sets all required environment variables
#   - Links the repo for automatic deploys
#
# After running this script, verify in the Railway dashboard:
#   - Both services are listed under the project
#   - The volume is attached to both services
#   - Cron schedules are set correctly
#   - Environment variables are populated
#
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*" >&2; }

# ─── Preflight checks ───────────────────────────────────────────────
if ! command -v railway &>/dev/null; then
  err "Railway CLI not found. Install with: npm i -g @railway/cli"
  exit 1
fi

if ! railway whoami &>/dev/null 2>&1; then
  err "Not logged in to Railway. Run: railway login"
  exit 1
fi

info "Railway CLI authenticated."

# ─── Gather Helius API key ──────────────────────────────────────────
if [[ -z "${HELIUS_API_KEY:-}" ]]; then
  echo ""
  read -rp "Enter your Helius API key: " HELIUS_API_KEY
  if [[ -z "$HELIUS_API_KEY" ]]; then
    err "HELIUS_API_KEY is required."
    exit 1
  fi
fi

HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}"
HELIUS_WS_URL="wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}"

ok "Helius credentials set."

# ─── Create project ─────────────────────────────────────────────────
PROJECT_NAME="pumpfun-research-collector"

info "Creating Railway project: ${PROJECT_NAME}"
railway init --name "$PROJECT_NAME" 2>/dev/null || warn "Project may already exist, continuing..."
ok "Project initialized."

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  The Railway CLI has initialized the project locally."
echo ""
echo "  The remaining setup requires the Railway dashboard:"
echo ""
echo "  1. VOLUME SETUP"
echo "     - Go to your project in the Railway dashboard"
echo "     - Click '+ New' → 'Volume'"
echo "     - Set mount path: /data"
echo "     - This volume will be shared by both services"
echo ""
echo "  2. CREATE COLLECT SERVICE"
echo "     - Click '+ New' → 'Service' → connect your GitHub repo"
echo "     - Name: collect"
echo "     - Settings → Cron Schedule: 0 */4 * * *"
echo "     - Attach the /data volume"
echo "     - Set environment variables (listed below)"
echo ""
echo "  3. CREATE LABEL SERVICE"
echo "     - Click '+ New' → 'Service' → connect same GitHub repo"
echo "     - Name: label"
echo "     - Settings → Cron Schedule: 30 3 * * *"
echo "     - Attach the SAME /data volume"
echo "     - Set environment variables (listed below)"
echo ""
echo "  4. ENVIRONMENT VARIABLES"
echo ""
echo "     ── Collect service ──"
echo "     MODE=collect"
echo "     HELIUS_API_KEY=${HELIUS_API_KEY}"
echo "     HELIUS_RPC_URL=${HELIUS_RPC_URL}"
echo "     HELIUS_WS_URL=${HELIUS_WS_URL}"
echo "     DB_PATH=/data/research.db"
echo "     OBSERVATION_WINDOW_MINUTES=30"
echo "     EARLY_SNAPSHOT_INTERVAL_MS=5000"
echo "     SNAPSHOT_INTERVAL_MS=10000"
echo "     OUTCOME_SNAPSHOT_INTERVAL_MS=30000"
echo "     MAX_TRACK_MINUTES=50"
echo "     MAX_TOKENS_PER_RUN=150"
echo "     MAX_TX_SAMPLE_PER_TOKEN=10"
echo "     MAX_TX_SAMPLE_PER_ROUND=200"
echo ""
echo "     ── Label service ──"
echo "     MODE=label"
echo "     DB_PATH=/data/research.db"
echo "     LABEL_RUN_ID=all"
echo "     ENTRY_MIN_BUY_COUNT=5"
echo "     ENTRY_MIN_UNIQUE_BUYERS=3"
echo "     ENTRY_MIN_BUY_VELOCITY=0.25"
echo "     ENTRY_MAX_SELL_RATIO=0.20"
echo "     ENTRY_MAX_SECONDS=120"
echo "     OUTCOME_WINDOW_SECONDS=600"
echo ""
echo "  5. MANUAL TEST"
echo "     - In the Railway dashboard, manually trigger each service"
echo "     - Check logs for successful startup and completion"
echo "     - Verify the SQLite database was created at /data/research.db"
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo ""
ok "Setup script complete. Follow the dashboard steps above to finish deployment."
