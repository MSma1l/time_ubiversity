#!/usr/bin/env bash
# Orar Univer — idempotent deploy for a Linux VPS.
#
# Usage: ./deploy/deploy.sh [--pull] [--no-build] [--timeout SECONDS]
#   --pull       git pull --ff-only before deploying
#   --no-build   start with existing images (skip docker compose build)
#   --timeout    seconds to wait for healthy containers (default 180)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PULL=0
BUILD=1
TIMEOUT=180
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull) PULL=1 ;;
    --no-build) BUILD=0 ;;
    --timeout) shift; TIMEOUT="${1:?--timeout needs a value}" ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || { echo "--timeout must be a number of seconds" >&2; exit 2; }

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Read KEY from a dotenv file without sourcing it (last occurrence wins, quotes stripped).
env_get() {
  local file="$1" key="$2" line value
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"; value="${value%\"}"
  value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

require_var() {
  local file="$1" key="$2" value
  value="$(env_get "$file" "$key")"
  [[ -n "$value" ]] || fail "$key is empty in $file"
}

# ---- Prerequisites ----------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin is not installed"

if [[ "$PULL" -eq 1 ]]; then
  log "Updating code (git pull --ff-only)"
  git pull --ff-only
fi

log "Checking configuration"
[[ -f .env ]] || fail "Missing .env — run: cp .env.example .env && edit it"
[[ -f backend/.env ]] || fail "Missing backend/.env — run: cp backend/.env.example backend/.env && edit it"

require_var .env POSTGRES_PASSWORD
pg_password="$(env_get .env POSTGRES_PASSWORD)"
[[ "$pg_password" != "change-me" ]] || fail "POSTGRES_PASSWORD is still the default 'change-me'"
[[ "$pg_password" =~ ^[A-Za-z0-9._~-]+$ ]] || fail "POSTGRES_PASSWORD must be URL-safe (A-Z a-z 0-9 . _ ~ -); try: openssl rand -hex 24"

require_var backend/.env TELEGRAM_BOT_TOKEN
require_var backend/.env MINI_APP_URL
require_var backend/.env ALLOWED_ORIGINS
[[ "$(env_get backend/.env MINI_APP_URL)" == https://* ]] || fail "MINI_APP_URL must start with https:// (Telegram requires HTTPS)"
[[ "$(env_get backend/.env ALLOW_DEV_AUTH)" != "true" ]] || fail "ALLOW_DEV_AUTH=true must not be used in production"

polling="$(env_get backend/.env TELEGRAM_POLLING)"
webhook="$(env_get backend/.env WEBHOOK_URL)"
if [[ "$polling" != "true" && -n "$webhook" ]]; then
  require_var backend/.env TELEGRAM_WEBHOOK_SECRET
fi
chmod 600 .env backend/.env 2>/dev/null || true

docker compose config --quiet || fail "docker compose config is invalid"

# ---- Build & start ------------------------------------------------------------------
if [[ "$BUILD" -eq 1 ]]; then
  log "Building images"
  docker compose build --pull
fi

# The API runs as the unprivileged `node` user. Volumes created by older images
# (running as root) may contain root-owned files; fix ownership idempotently.
log "Ensuring /data volume is owned by the node user"
docker compose run --rm --no-deps -T --user root --entrypoint sh api \
  -c 'find /data ! -user node -exec chown node:node {} + 2>/dev/null; true'

log "Starting stack"
docker compose up -d --remove-orphans

# ---- Wait for health ------------------------------------------------------------------
wait_healthy() {
  local service="$1" id status deadline=$((SECONDS + TIMEOUT))
  while :; do
    id="$(docker compose ps -q "$service" 2>/dev/null || true)"
    status="missing"
    if [[ -n "$id" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo unknown)"
    fi
    case "$status" in
      healthy) log "$service is healthy"; return 0 ;;
      unhealthy|exited|dead) break ;;
    esac
    if (( SECONDS >= deadline )); then break; fi
    sleep 3
  done
  printf '\033[1;31mERROR:\033[0m %s is %s. Last logs:\n' "$service" "$status" >&2
  docker compose logs --tail=60 "$service" >&2 || true
  return 1
}

log "Waiting for services to become healthy (timeout ${TIMEOUT}s)"
failed=0
for service in postgres api web; do
  wait_healthy "$service" || failed=1
done

docker compose ps

if [[ "$failed" -ne 0 ]]; then
  fail "Deploy finished with unhealthy services"
fi

web_bind="$(env_get .env WEB_BIND)"; web_bind="${web_bind:-127.0.0.1}"
if [[ "$web_bind" == "0.0.0.0" ]]; then web_bind="127.0.0.1"; fi
web_port="$(env_get .env WEB_PORT)"; web_port="${web_port:-8083}"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS -o /dev/null "http://${web_bind}:${web_port}/"; then
    log "Mini App responds on http://${web_bind}:${web_port}/"
  else
    fail "Mini App did not respond on http://${web_bind}:${web_port}/"
  fi
fi

docker image prune -f >/dev/null 2>&1 || true
log "Deploy complete. Public URL: $(env_get backend/.env MINI_APP_URL)"
