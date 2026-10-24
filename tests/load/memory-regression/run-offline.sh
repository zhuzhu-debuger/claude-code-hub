#!/usr/bin/env bash
set -euo pipefail

fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$fixture_dir/../../.." && pwd)"
cd -- "$repo_dir"

# Keep tests/setup.ts from loading service URLs from a developer's .env file.
# All service dependencies in the selected suites are mocked.
export DSN=""
export REDIS_URL=""
export AUTO_CLEANUP_TEST_DATA=false
export NODE_ENV=test

bunx vitest run \
  --config tests/configs/session-monitoring-memory.config.mts \
  --configLoader bundle --coverage
bunx vitest run \
  --config tests/configs/proxy-response-memory.config.mts \
  --configLoader bundle --coverage
bunx vitest run \
  src/app/v1/_lib/proxy/client-abort-metering.test.ts \
  src/app/v1/_lib/proxy/detached-stream-budget.test.ts \
  tests/unit/proxy/stream-gate-ttft-regression.test.ts \
  tests/unit/proxy/response-handler-nonstream-terminal.test.ts \
  tests/unit/proxy/memory-aware-lifetime.test.ts \
  tests/unit/proxy/memory-aware-response-owner.test.ts \
  --configLoader bundle

node tests/load/memory-regression/sse-buffer-retention.mjs "$@"
