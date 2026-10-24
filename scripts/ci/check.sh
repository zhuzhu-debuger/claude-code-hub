#!/usr/bin/env bash
set -euo pipefail

bun run lint
bun run format:check
bun run typecheck
bun run validate:migrations
bun run openapi:check
bun run openapi:lint
# Unit tests must not accidentally share the integration database.
DSN= REDIS_URL= ADMIN_TOKEN=admin-token TEST_ADMIN_TOKEN=admin-token AUTO_CLEANUP_TEST_DATA=false bun run test
DSN= REDIS_URL= ADMIN_TOKEN=admin-token TEST_ADMIN_TOKEN=admin-token AUTO_CLEANUP_TEST_DATA=false bun run test:v1
bun run db:migrate
bun run test:integration
