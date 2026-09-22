#!/usr/bin/env bash
# Orar Univer — backup PostgreSQL (pg_dump) and SQLite (online .backup) from the running stack.
#
# Usage: ./deploy/backup.sh
# Env/.env: BACKUP_DIR (default ./backups), BACKUP_RETENTION_DAYS (default 14)
#
# Cron example (daily 03:15):
#   mkdir -p /opt/orar-univer/backups   # once, before adding the cron line
#   15 3 * * * cd /opt/orar-univer && ./deploy/backup.sh >> backups/backup.log 2>&1
#
# Restore:
#   PostgreSQL: docker compose exec -T postgres pg_restore -U orar -d orar --clean --if-exists < backups/<ts>/postgres.dump
#   SQLite:     docker compose stop api
#               (--cap-add CHOWN: the api service drops all capabilities)
#               docker compose run --rm --no-deps -T --user root --cap-add CHOWN \
#                 -v "$PWD/backups/<ts>:/restore:ro" --entrypoint sh api \
#                 -c 'gunzip -c /restore/orar.sqlite.gz > /data/orar.sqlite && rm -f /data/orar.sqlite-wal /data/orar.sqlite-shm && chown node:node /data/orar.sqlite'
#               docker compose start api
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

env_get() {
  local file="$1" key="$2" line value
  [[ -f "$file" ]] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

BACKUP_DIR="${BACKUP_DIR:-$(env_get .env BACKUP_DIR)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-$(env_get .env BACKUP_RETENTION_DAYS)}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
PG_USER="$(env_get .env POSTGRES_USER)"; PG_USER="${PG_USER:-orar}"
PG_DB="$(env_get .env POSTGRES_DB)"; PG_DB="${PG_DB:-orar}"

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || fail "BACKUP_RETENTION_DAYS must be a number"
command -v docker >/dev/null 2>&1 || fail "docker is not installed"

[[ -n "$(docker compose ps -q --status running postgres 2>/dev/null)" ]] || fail "postgres container is not running"
[[ -n "$(docker compose ps -q --status running api 2>/dev/null)" ]] || fail "api container is not running"

umask 077
timestamp="$(date +%Y-%m-%d_%H%M%S)"
target="${BACKUP_DIR%/}/${timestamp}"
mkdir -p "$target"

completed=0
# Written inside the /data volume, not /tmp: /tmp in the api container is a tmpfs
# (see docker-compose.yml) and `docker compose cp` cannot read from a tmpfs mount.
tmp_in_container="/data/.backup-${timestamp}.sqlite"
cleanup() {
  if [[ "$completed" -ne 1 ]]; then
    log "Backup failed, removing incomplete $target"
    rm -rf "$target"
    docker compose exec -T api rm -f "$tmp_in_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---- PostgreSQL ------------------------------------------------------------------------
log "Dumping PostgreSQL database '$PG_DB'"
docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom --no-owner > "$target/postgres.dump"
[[ -s "$target/postgres.dump" ]] || fail "pg_dump produced an empty file"

# ---- SQLite (consistent online backup via better-sqlite3, safe with WAL) ---------------
log "Backing up SQLite database"
docker compose exec -T -e BACKUP_TARGET="$tmp_in_container" api node -e '
const Database = require("better-sqlite3");
const db = new Database(process.env.DATABASE_PATH, { fileMustExist: true });
db.backup(process.env.BACKUP_TARGET)
  .then(() => { db.close(); })
  .catch((error) => { console.error(error); process.exit(1); });
'
docker compose cp "api:${tmp_in_container}" "$target/orar.sqlite"
docker compose exec -T api rm -f "$tmp_in_container"
[[ -s "$target/orar.sqlite" ]] || fail "SQLite backup is empty"
gzip -9 "$target/orar.sqlite"

# ---- Checksums & retention -------------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then sha256=(sha256sum); else sha256=(shasum -a 256); fi
( cd "$target" && "${sha256[@]}" postgres.dump orar.sqlite.gz > SHA256SUMS )
completed=1
log "Backup written to $target ($(du -sh "$target" | cut -f1))"

log "Removing backups older than ${RETENTION_DAYS} days"
find "${BACKUP_DIR%/}" -mindepth 1 -maxdepth 1 -type d -name '20??-??-??_??????' -mtime "+${RETENTION_DAYS}" -print -exec rm -rf {} +

log "Done"
