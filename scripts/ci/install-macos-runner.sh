#!/usr/bin/env bash
set -euo pipefail

repository=${1:-zhuzhu-debuger/claude-code-hub}
runner_directory=${CCH_RUNNER_DIRECTORY:-"$HOME/.local/share/claude-code-hub-runner"}
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
  echo 'This installer requires an Apple Silicon Mac.' >&2
  exit 1
}
if [[ -e "$runner_directory/.runner" ]]; then
  echo "Runner already registered in $runner_directory; leaving it unchanged."
  exit 0
fi
mkdir -p "$runner_directory"
cd "$runner_directory"
release=$(gh api repos/actions/runner/releases/latest)
archive_url=$(printf '%s' "$release" | python3 -c 'import json,sys; print(next(a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if "osx-arm64" in a["name"]))')
archive_digest=$(printf '%s' "$release" | python3 -c 'import json,sys; print(next(a["digest"].removeprefix("sha256:") for a in json.load(sys.stdin)["assets"] if "osx-arm64" in a["name"]))')
curl --fail --location --retry 3 --output runner.tar.gz "$archive_url"
printf '%s  runner.tar.gz\n' "$archive_digest" | shasum -a 256 --check
tar -xzf runner.tar.gz
rm runner.tar.gz
registration_token=$(gh api --method POST "repos/$repository/actions/runners/registration-token" --jq .token)
./config.sh --unattended --url "https://github.com/$repository" --token "$registration_token" \
  --name cch-mac-builder --labels cch-local --work _work
unset registration_token
# Save the interactive shell PATH so launchd can find Docker and Python.
./env.sh
./svc.sh install
./svc.sh start
