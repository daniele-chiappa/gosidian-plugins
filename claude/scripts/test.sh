#!/bin/sh
# The plugin's type check and tests in a throwaway node:24-alpine. The
# tests of the repositories need git, which the image lacks: the container
# runs as root to add it, and gives back to the caller's user every file it
# made (nothing in the repository stays root's). The tests need neither
# Claude Code nor the API: a fake of each (test/fake-claude.ts,
# test/mock-api.ts) stands in.
#
#   claude/scripts/test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
docker run --rm -e HOME=/tmp -e npm_config_update_notifier=false -e OWNER="$(id -u):$(id -g)" \
	-v "$DIR":/app -v "$DIR/../agent-kit":/agent-kit -w /app node:24-alpine \
	sh -c 'rc=0
		{ apk add --no-cache git >/dev/null && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run check && npm test; } || rc=$?
		find /app /agent-kit -xdev -user 0 -exec chown -h "$OWNER" {} +
		exit $rc'
