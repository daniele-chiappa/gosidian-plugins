#!/bin/sh
# The plugin's type check and tests in a throwaway node:24-alpine. The tests
# run the real pi against a fake endpoint (test/mock-llm.ts) and a fake of
# gosidian's MCP (test/mock-mcp.ts), and need git for the repositories:
# the container installs it as root, then gives node_modules back to the
# caller's user.
#
#   pi/scripts/test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
docker run --rm -e npm_config_update_notifier=false -e OWNER="$(id -u):$(id -g)" \
	-v "$DIR":/app -v "$DIR/../agent-kit":/agent-kit -w /app node:24-alpine \
	sh -c 'apk add --no-cache git >/dev/null && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run check && npm test; s=$?; chown -R "$OWNER" /app/node_modules; exit $s'
