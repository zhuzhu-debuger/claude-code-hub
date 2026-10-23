#!/usr/bin/env bash
# Runs in a disposable source directory on either acer-server or the local host.
set -euo pipefail

mode=$1
platform=$2
version=$3
repository=$4
revision=$5
if [[ -f "$HOME/.config/claude-code-hub/ci.env" ]]; then
  source "$HOME/.config/claude-code-hub/ci.env"
fi
docker_build=(docker buildx build)
if [[ -n "${CCH_BUILD_PROXY:-}" ]]; then
  # Buildx obtains registry authentication tokens in its client process too.
  export HTTP_PROXY="$CCH_BUILD_PROXY" HTTPS_PROXY="$CCH_BUILD_PROXY"
  export http_proxy="$CCH_BUILD_PROXY" https_proxy="$CCH_BUILD_PROXY"
  # A dedicated builder avoids changing the host Docker daemon or other projects.
  if ! docker buildx inspect cch-ci >/dev/null 2>&1; then
    docker buildx create --name cch-ci --driver docker-container \
      --driver-opt network=host \
      --driver-opt "env.HTTP_PROXY=$CCH_BUILD_PROXY" \
      --driver-opt "env.HTTPS_PROXY=$CCH_BUILD_PROXY" \
      --buildkitd-flags '--allow-insecure-entitlement network.host' >/dev/null
  fi
  docker_build+=(--builder cch-ci --network host --allow network.host \
    --build-arg "HTTP_PROXY=$CCH_BUILD_PROXY" --build-arg "HTTPS_PROXY=$CCH_BUILD_PROXY")
fi

ensure_service_image() {
  if ! docker image inspect "$1" >/dev/null 2>&1; then
    # Pull through the project builder so the host daemon needs no proxy changes.
    printf 'FROM %s\n' "$1" | "${docker_build[@]}" --load -t "$1" -f - .
  fi
}

job_id="cch-ci-$(date +%s)-$$"
network=$job_id
test_image="cch-ci-tests:$job_id"
image="cch-ci-image:$job_id"

cleanup() {
  for suffix in checks e2e app redis postgres; do
    docker rm -f "$job_id-$suffix" >/dev/null 2>&1 || true
  done
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$image" "$test_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

mkdir -p output
if [[ "$mode" == smoke ]]; then
  # Exercise the same build, export, transfer and upload path without app dependencies.
  printf 'FROM busybox:1.37\nCMD ["echo", "claude-code-hub CI smoke test"]\n' > Smoke.Dockerfile
  "${docker_build[@]}" --platform "$platform" --load -t "$image" -f Smoke.Dockerfile .
else
  "${docker_build[@]}" --load -t "$test_image" -f scripts/ci/Dockerfile \
    --build-arg "BUN_VERSION=$(cat .bun-version)" \
    --build-arg "NODE_VERSION=$(cat .node-version)" .
  docker network create "$network" >/dev/null
  ensure_service_image postgres:18-alpine
  ensure_service_image redis:7-alpine
  docker run -d --name "$job_id-postgres" --network "$network" --network-alias postgres \
    -e POSTGRES_USER=test_user -e POSTGRES_PASSWORD=test_password \
    -e POSTGRES_DB=claude_code_hub_test postgres:18-alpine >/dev/null
  docker run -d --name "$job_id-redis" --network "$network" --network-alias redis \
    redis:7-alpine >/dev/null
  ready=false
  for ((attempt = 0; attempt < 60; attempt++)); do
    if docker exec "$job_id-postgres" pg_isready -U test_user -d claude_code_hub_test >/dev/null 2>&1 && \
      docker exec "$job_id-redis" redis-cli ping >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 2
  done
  [[ "$ready" == true ]] || { echo 'Test services did not become ready' >&2; exit 1; }
  test_env=(
    --network "$network"
    -e DSN=postgres://test_user:test_password@postgres:5432/claude_code_hub_test
    -e REDIS_URL=redis://redis:6379/1
    -e ADMIN_TOKEN=test-admin-token-for-ci
    -e TEST_ADMIN_TOKEN=test-admin-token-for-ci
    -e AUTH_SESSION_TTL_SECONDS=604800
    -e SESSION_TTL=300
    -e ENABLE_RATE_LIMIT=true
    -e VITEST_MAX_WORKERS=4
    -e VITEST_STATEFUL_MAX_WORKERS=2
    -e VITEST_STATEFUL_MAX_CONCURRENCY=3
  )
  docker run --name "$job_id-checks" "${test_env[@]}" "$test_image"
  "${docker_build[@]}" --platform "$platform" --load -t "$image" -f deploy/Dockerfile \
    --build-arg "APP_VERSION=$version" \
    --label "org.opencontainers.image.version=$version" \
    --label "org.opencontainers.image.revision=$revision" \
    --label "org.opencontainers.image.source=https://github.com/$repository" .
  docker run -d --name "$job_id-app" --network-alias app "${test_env[@]}" \
    -e AUTO_MIGRATE=true -e ENABLE_LEGACY_ACTIONS_API=true "$image" >/dev/null
  ready=false
  for ((attempt = 0; attempt < 90; attempt++)); do
    if docker exec "$job_id-app" curl -fsS http://127.0.0.1:3000/api/v1/health >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    docker logs --tail 100 "$job_id-app"
    exit 1
  fi
  docker run --name "$job_id-e2e" "${test_env[@]}" \
    -e API_BASE_URL=http://app:3000/api/actions \
    -e API_E2E_BASE_URL=http://app:3000/api/v1 \
    -e AUTO_CLEANUP_TEST_DATA=true "$test_image" bun run test:e2e
fi

if [[ "$mode" != check ]]; then
  docker save "$image" | gzip -1 > output/image.tar.gz
  printf '%s\n' "$image" > output/image-reference.txt
fi
