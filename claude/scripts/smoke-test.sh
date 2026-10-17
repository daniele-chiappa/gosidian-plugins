#!/bin/sh
# A live test of the image with the real Claude Code and a real credential:
# the plugin installs the newest Claude Code into a throwaway volume, probes
# the preset's aliases, and answers run (haiku), version and usage through
# MCP. It runs as in production (root with only SETUID and SETGID, a
# read-only root, /tmp in memory), plus DAC_READ_SEARCH to read a token file
# that root does not own. It spends a few requests of the subscription. The
# token is never printed: the script counts its occurrences in the plugin's
# logs, which must be none.
#
#   TOKEN_FILE=…/claude-oauth-token claude/scripts/smoke-test.sh
#   IMAGE=gosidian-claude:0.1.0 TOKEN_FILE=… claude/scripts/smoke-test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-gosidian-claude:lab}
TOKEN_FILE=${TOKEN_FILE:?the file of a subscription token (claude setup-token)}
NAME=claude-smoke-$$
cleanup() {
	docker rm -f "$NAME" >/dev/null 2>&1 || true
	docker network rm "$NAME" >/dev/null 2>&1 || true
	docker volume rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
[ -d "$DIR/node_modules" ] || docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$DIR":/app -w /app node:24-alpine npm ci --ignore-scripts --no-audit --no-fund >/dev/null
docker network create "$NAME" >/dev/null
docker volume create "$NAME" >/dev/null
docker run -d --name "$NAME" --network "$NAME" --network-alias claude-plugin \
	--cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add DAC_READ_SEARCH \
	--security-opt no-new-privileges:true --read-only --tmpfs /tmp:size=512m \
	-e GOSIDIAN_PLUGIN_TOKEN=t0k \
	-v "$NAME":/var/lib/gosidian-claude \
	-v "$TOKEN_FILE":/run/secrets/claude-oauth-token:ro \
	-v "$DIR/scripts/smoke-preset.yaml":/etc/gosidian-claude/preset.yaml:ro \
	"$IMAGE" >/dev/null
status=0
docker run --rm --network "$NAME" -u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$DIR":/app:ro -w /app node:24-alpine node scripts/smoke.ts || status=$?
left=$(docker exec "$NAME" sh -c 'ls /tmp/gosidian-claude | wc -l; ps -o user= | grep -c "^agent" || true' | tr '\n' ' ')
echo "after the steps, folders and agent processes: $left"
[ "$left" = "0 0 " ] || status=1
# The token in the plugin's logs: counted inside a throwaway container, never printed.
leaks=$(docker logs "$NAME" 2>&1 | docker run --rm -i -u "$(id -u):$(id -g)" -v "$TOKEN_FILE":/t:ro alpine:3.20 \
	sh -c 't=$(tr -d " \r\n" </t); [ -n "$t" ] && grep -c -F -- "$t" || true')
echo "the token in the plugin's logs: ${leaks:-0} times"
[ "${leaks:-0}" = "0" ] || status=1
if [ "${leaks:-0}" = "0" ]; then
	echo "--- the plugin's log"
	docker logs "$NAME" 2>&1 | tail -40
fi
exit "$status"
