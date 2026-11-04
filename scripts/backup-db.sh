#!/usr/bin/env sh
# Daily PostgreSQL backup with 7-day retention (extra safety on top of Neon point-in-time restore).
# Cron (server host): 0 2 * * *  DATABASE_URL="..." BACKUP_DIR=/var/backups/callkaro /app/scripts/backup-db.sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/callkaro}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
STAMP="$(date +%Y-%m-%d_%H%M)"
mkdir -p "$BACKUP_DIR"
pg_dump --format=custom --no-owner --file="$BACKUP_DIR/callkaro_$STAMP.dump" "$DATABASE_URL"
find "$BACKUP_DIR" -name 'callkaro_*.dump' -mtime +"$RETENTION_DAYS" -delete
echo "backup ok: $BACKUP_DIR/callkaro_$STAMP.dump"
# Restore: pg_restore --clean --no-owner -d "$DATABASE_URL" <file>
