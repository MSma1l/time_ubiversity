#!/usr/bin/env bash
# Builds the production images of Orar Univer on serverhome (no buildx, docker-compose v1 does
# not build: compose.yaml only references the tags).
#
#   ./build.sh [path/to/repo]     # default: the repository this script lives in
#   PULL=0 ./build.sh             # do not refresh base images (faster, offline)
#   NO_CACHE=1 ./build.sh         # rebuild every layer (picks up Alpine security fixes)
#   BUILD_NETWORK=default ./build.sh  # build steps on the default bridge instead of the host network
#
# Build steps (apk add, npm ci) use the host network by default: on serverhome, containers on
# the default bridge get nameserver 192.168.1.10 (dnsmasq), which they cannot reach, so every
# download fails with "DNS: transient error". User-defined networks (compose) are not affected.
#
# Produces time-university-api:prod and time-university-web:prod. The images currently tagged
# :prod are kept as :prev first, so a bad release can be rolled back (see README.md).
set -euo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
for f in backend/Dockerfile frontend/Dockerfile frontend/nginx.conf; do
  [[ -f "$REPO/$f" ]] || { echo "Missing $REPO/$f" >&2; exit 1; }
done

# Classic builder unless buildx is available (the Dockerfiles use no BuildKit-only syntax).
if [[ -z "${DOCKER_BUILDKIT:-}" ]] && ! docker buildx version >/dev/null 2>&1; then
  export DOCKER_BUILDKIT=0
fi

args=()
[[ "${PULL:-1}" == "1" ]] && args+=(--pull)
[[ "${NO_CACHE:-0}" == "1" ]] && args+=(--no-cache)
args+=(--network "${BUILD_NETWORK:-host}")

keep_previous() {
  local image="$1"
  if docker image inspect "$image:prod" >/dev/null 2>&1; then
    docker tag "$image:prod" "$image:prev"
    echo "    previous $image:prod kept as $image:prev"
  fi
}

build() {
  local context="$1" image="$2"
  echo "==> $image:prod (context $context)"
  keep_previous "$image"
  docker build ${args[@]+"${args[@]}"} -t "$image:prod" "$REPO/$context"
}

build backend time-university-api
build frontend time-university-web

# postgres:16-alpine is pulled here too, so `docker-compose up` does not depend on the registry.
if [[ "${PULL:-1}" == "1" ]]; then docker pull postgres:16-alpine; fi

echo
docker image ls --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | grep -E '^(time-university-(api|web)|postgres):' || true
echo
echo "Images built. Deploy with:"
echo "  $REPO/deploy/serverhome/deploy.sh"
