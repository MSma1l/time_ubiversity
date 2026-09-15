#!/usr/bin/env bash
# Orar Univer on serverhome — (re)start the stack from prebuilt images.
#
#   ~/.../src/deploy/serverhome/deploy.sh [--timeout SECONDS]
#   APP_DIR=/srv/apps/time-university (default)
#
# Syncs compose.yaml, .env.example and README.md from this directory into APP_DIR, validates .env
# (must exist, mode 600, required values set), creates data/ and backups/, runs
# `docker-compose up -d`, waits for healthy containers and checks web -> api proxying.
# Build the images first with build.sh. Never uses sudo.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/srv/apps/time-university}"
TIMEOUT=180
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) shift; TIMEOUT="${1:?--timeout needs a value}" ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || { echo "--timeout must be a number of seconds" >&2; exit 2; }

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Read KEY from a dotenv file without sourcing it (last occurrence wins, quotes stripped).
env_get() {
  local line value
  line="$(grep -E "^[[:space:]]*$1=" "$APP_DIR/.env" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}
require_var() { [[ -n "$(env_get "$1")" ]] || fail "$1 is empty in $APP_DIR/.env"; }

# ---- Prerequisites -----------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
command -v docker-compose >/dev/null 2>&1 || fail "docker-compose (v1) is not installed"
[[ -d "$APP_DIR" && -w "$APP_DIR" ]] || fail "$APP_DIR is missing or not writable. Once, as admin:
  sudo mkdir -p $APP_DIR && sudo chown -R $(id -un): $APP_DIR"
docker network inspect shared-network >/dev/null 2>&1 || fail "Docker network shared-network does not exist (start /srv/proxy first)"
for image in time-university-api:prod time-university-web:prod; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "Image $image is missing — run $SRC_DIR/build.sh"
done

# ---- Sync project files ------------------------------------------------------------------------
log "Syncing compose.yaml, .env.example, README.md into $APP_DIR"
for f in compose.yaml .env.example README.md; do
  if [[ -f "$APP_DIR/$f" ]] && ! cmp -s "$SRC_DIR/$f" "$APP_DIR/$f"; then
    cp -p "$APP_DIR/$f" "$APP_DIR/$f.bak"
    log "  $f changed (previous copy: $f.bak)"
  fi
  cp "$SRC_DIR/$f" "$APP_DIR/$f"
done

# ---- Validate .env --------------------------------------------------------------------------------
log "Checking $APP_DIR/.env"
[[ -f "$APP_DIR/.env" ]] || fail "Missing .env — run: cp $APP_DIR/.env.example $APP_DIR/.env && chmod 600 $APP_DIR/.env && edit it"
mode="$(stat -c '%a' "$APP_DIR/.env")"
[[ "$mode" == "600" ]] || fail ".env has mode $mode — run: chmod 600 $APP_DIR/.env"

require_var POSTGRES_PASSWORD
pg_password="$(env_get POSTGRES_PASSWORD)"
[[ "$pg_password" != "change-me" ]] || fail "POSTGRES_PASSWORD is still 'change-me'"
[[ "$pg_password" =~ ^[A-Za-z0-9._~-]+$ ]] || fail "POSTGRES_PASSWORD must be URL-safe (A-Z a-z 0-9 . _ ~ -); try: openssl rand -hex 24"
require_var TELEGRAM_BOT_TOKEN
require_var MINI_APP_URL
require_var ALLOWED_ORIGINS
[[ "$(env_get MINI_APP_URL)" == https://* ]] || fail "MINI_APP_URL must start with https://"
[[ "$(env_get ALLOW_DEV_AUTH)" != "true" ]] || fail "ALLOW_DEV_AUTH=true is not allowed in production"
if [[ "$(env_get TELEGRAM_POLLING)" != "true" ]]; then
  if [[ -n "$(env_get WEBHOOK_URL)" ]]; then
    require_var TELEGRAM_WEBHOOK_SECRET
  else
    printf '\033[1;33mWARNING:\033[0m neither TELEGRAM_POLLING=true nor WEBHOOK_URL is set: the bot will not receive commands\n' >&2
  fi
fi

# ---- Directories -------------------------------------------------------------------------------------
cd "$APP_DIR"
mkdir -p data/sqlite data/postgres backups
chmod 700 backups
# The API runs as uid 1000 (`node`); a root-created directory would make SQLite read-only.
owner="$(stat -c '%u' data/sqlite)"
[[ "$owner" == "1000" ]] || fail "data/sqlite is owned by uid $owner; it must be uid 1000 (the container's node user)"

docker-compose config --quiet || fail "compose.yaml / .env is invalid (docker-compose config)"

# ---- Start ----------------------------------------------------------------------------------------------
log "Starting stack"
docker-compose up -d --remove-orphans

wait_healthy() {
  local name="$1" status deadline=$((SECONDS + TIMEOUT))
  while :; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$status" in
      healthy) log "$name is healthy"; return 0 ;;
      unhealthy|exited|dead) break ;;
    esac
    (( SECONDS >= deadline )) && break
    sleep 3
  done
  printf '\033[1;31mERROR:\033[0m %s is %s. Last logs:\n' "$name" "$status" >&2
  docker logs --tail 60 "$name" >&2 || true
  return 1
}

log "Waiting for containers to become healthy (timeout ${TIMEOUT}s)"
failed=0
for name in time-university-db time-university-api time-university-web; do
  wait_healthy "$name" || failed=1
done

docker-compose ps
[[ "$failed" -eq 0 ]] || fail "Deploy finished with unhealthy containers"

log "Checking web -> api proxying"
if health="$(docker exec time-university-web wget -qO- http://127.0.0.1/api/health 2>/dev/null)"; then
  log "/api/health: $health"
else
  fail "time-university-web could not reach the API through /api/health"
fi

log "Deploy complete. Public URL (after the proxy vhost is active): $(env_get MINI_APP_URL)"
