#!/usr/bin/env bash
# Orar Univer on serverhome — backup PostgreSQL (pg_dump) and SQLite (online backup) from the
# running containers into $APP_DIR/backups/<timestamp>/.
#
#   /srv/apps/time-university/src/deploy/serverhome/backup.sh
#   APP_DIR (default /srv/apps/time-university), BACKUP_RETENTION_DAYS (default: .env or 14)
#
# Cron for deea (daily 03:15):
#   15 3 * * * /srv/apps/time-university/src/deploy/serverhome/backup.sh >> /srv/apps/time-university/backups/backup.log 2>&1
#
# Restore: see README.md ("Backup / restaurare").
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/apps/time-university}"
DB_CONTAINER=time-university-db
API_CONTAINER=time-university-api

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

env_get() {
  local line value
  [[ -r "$APP_DIR/.env" ]] || return 0
  line="$(grep -E "^[[:space:]]*$1=" "$APP_DIR/.env" | tail -n 1 || true)"
  value="${line#*=}"; value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"; value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-$(env_get BACKUP_RETENTION_DAYS)}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_RETENTION_DAYS must be a number"

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
running() { [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }
running "$DB_CONTAINER" || fail "$DB_CONTAINER is not running"
running "$API_CONTAINER" || fail "$API_CONTAINER is not running"
[[ -d "$APP_DIR/data/sqlite" ]] || fail "$APP_DIR/data/sqlite not found"

umask 077
timestamp="$(date +%Y-%m-%d_%H%M%S)"
backup_root="$APP_DIR/backups"
target="$backup_root/$timestamp"
mkdir -p "$target"

# The SQLite copy is written into the bind-mounted /data (uid 1000 = deea on the host), then
# moved out. /tmp in the container is a tmpfs, which `docker cp` cannot read.
tmp_name=".backup-${timestamp}.sqlite"
completed=0
cleanup() {
  rm -f "$APP_DIR/data/sqlite/$tmp_name"
  if [[ "$completed" -ne 1 ]]; then
    log "Backup failed, removing incomplete $target"
    rm -rf "$target"
  fi
}
trap cleanup EXIT

# ---- PostgreSQL (credentials come from the container's own environment) --------------------
log "Dumping PostgreSQL"
docker exec "$DB_CONTAINER" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$target/postgres.dump"
[[ -s "$target/postgres.dump" ]] || fail "pg_dump produced an empty file"

# ---- SQLite (consistent online backup via better-sqlite3, safe with WAL) --------------------
log "Backing up SQLite"
docker exec -e BACKUP_TARGET="/data/$tmp_name" -w /app "$API_CONTAINER" node -e '
const Database = require("better-sqlite3");
const db = new Database(process.env.DATABASE_PATH, { fileMustExist: true });
db.backup(process.env.BACKUP_TARGET)
  .then(() => db.close())
  .catch((error) => { console.error(error); process.exit(1); });
'
[[ -s "$APP_DIR/data/sqlite/$tmp_name" ]] || fail "SQLite backup is empty"
mv "$APP_DIR/data/sqlite/$tmp_name" "$target/orar.sqlite"
gzip -9 "$target/orar.sqlite"

( cd "$target" && sha256sum postgres.dump orar.sqlite.gz > SHA256SUMS )
completed=1
log "Backup written to $target ($(du -sh "$target" | cut -f1))"

log "Removing backups older than ${RETENTION_DAYS} days"
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_??????' -mtime "+${RETENTION_DAYS}" -print -exec rm -rf {} +
log "Done"
