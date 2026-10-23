#!/usr/bin/env bash
set -uo pipefail

job_id=$1
for suffix in checks e2e app redis postgres; do
  docker rm -f "$job_id-$suffix" >/dev/null 2>&1 || true
done
docker network rm "$job_id" >/dev/null 2>&1 || true
docker image rm "cch-ci-image:$job_id" "cch-ci-tests:$job_id" >/dev/null 2>&1 || true
