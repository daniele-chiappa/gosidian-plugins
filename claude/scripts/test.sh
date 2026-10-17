#!/bin/sh
# The plugin's type check and tests in a throwaway node:24-alpine, as the
# caller's user (nothing in the repository becomes root's). The tests need
# neither Claude Code nor the API: a fake of each (test/fake-claude.ts,
# test/mock-api.ts) stands in.
#
#   claude/scripts/test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false \
	-v "$DIR":/app -w /app node:24-alpine \
	sh -c 'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run check && npm test'
