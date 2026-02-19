#!/usr/bin/env bash
#
# SQLite database backup script for pump.fun research collector.
#
# Creates timestamped backups of the research database.
# Designed to run on the Railway volume after a collect run completes.
#
# Usage:
#   chmod +x scripts/backup-db.sh
#   ./scripts/backup-db.sh                    # uses defaults
#   DB_PATH=/data/research.db ./scripts/backup-db.sh
#
# Backup strategy (from spec):
#   - Copies the SQLite file to a backups directory on the same volume
#   - Prunes backups older than 7 days
#   - WAL is checkpointed before copy to ensure consistency
#
set -euo pipefail

DB_PATH="${DB_PATH:-/data/research.db}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

if [[ ! -f "$DB_PATH" ]]; then
  echo '{"event":"backup_skip","reason":"database file not found","path":"'"$DB_PATH"'"}'
  exit 0
fi

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Checkpoint WAL to ensure backup consistency
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true

# Create timestamped backup
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/research_${TIMESTAMP}.db"

cp "$DB_PATH" "$BACKUP_FILE"

BACKUP_SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo "unknown")

echo '{"event":"backup_created","file":"'"$BACKUP_FILE"'","size_bytes":'"$BACKUP_SIZE"',"timestamp":"'"$(date -u +"%Y-%m-%dT%H:%M:%SZ")"'"}'

# Prune old backups
PRUNED=0
if command -v find &>/dev/null; then
  while IFS= read -r old_file; do
    rm -f "$old_file"
    PRUNED=$((PRUNED + 1))
  done < <(find "$BACKUP_DIR" -name "research_*.db" -type f -mtime +"$RETENTION_DAYS" 2>/dev/null)
fi

if [[ $PRUNED -gt 0 ]]; then
  echo '{"event":"backup_pruned","files_removed":'"$PRUNED"',"retention_days":'"$RETENTION_DAYS"'}'
fi

# Count remaining backups
REMAINING=$(find "$BACKUP_DIR" -name "research_*.db" -type f 2>/dev/null | wc -l)
echo '{"event":"backup_summary","total_backups":'"$REMAINING"',"backup_dir":"'"$BACKUP_DIR"'"}'
