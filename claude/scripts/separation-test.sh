#!/bin/sh
# Tests the image as it runs in production: root with only SETUID and SETGID,
# a read-only root, /tmp in tmpfs, the versions in a volume. The volume holds
# a fake Claude Code (test/fake-claude.ts) instead of the real one, and a fake
# API stands in for Anthropic's: no credential and no network to the outside.
# The fake runs a shell command that tries to reach what it must not (the
# server's environment, the token, a link to a file of the system) and leaves
# a process behind; the script fails if any of it works, or if the step
# leaves its folder or a process.
#
#   claude/scripts/separation-test.sh                 build gosidian-claude:test, then test it
#   IMAGE=gosidian-claude:0.1.0 claude/scripts/separation-test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-}
NAME=claude-separation-$$
cleanup() {
	docker rm -f "$NAME-plugin" "$NAME-harness" >/dev/null 2>&1 || true
	docker network rm "$NAME" >/dev/null 2>&1 || true
	docker volume rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
if [ -z "$IMAGE" ]; then
	IMAGE=gosidian-claude:test
	docker build -q -t "$IMAGE" "$DIR" >/dev/null
fi
[ -d "$DIR/node_modules" ] || docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$DIR":/app -w /app node:24-alpine npm ci --ignore-scripts --no-audit --no-fund >/dev/null
docker network create "$NAME" >/dev/null
docker volume create "$NAME" >/dev/null
# The fake version 9.9.9, in use, as the plugin would have installed it.
docker run --rm -v "$NAME":/v -v "$DIR/test/fake-claude.ts":/src/fake-claude.ts:ro "$IMAGE" sh -c '
	set -e
	d=/v/versions/9.9.9
	mkdir -p $d
	cp /src/fake-claude.ts $d/fake-claude.mts
	printf "#!/bin/sh\nexec /usr/local/bin/node /var/lib/gosidian-claude/versions/9.9.9/fake-claude.mts --fake-version 9.9.9 \"\$@\"\n" > $d/claude
	chmod 755 $d/claude && chmod 644 $d/fake-claude.mts
	echo "{\"version\":\"9.9.9\",\"bin\":\"claude\",\"installed_at\":\"2026-10-16T00:00:00Z\",\"effort_levels\":[\"low\",\"medium\",\"high\"],\"probe\":{\"at\":\"2026-10-16T00:00:00Z\",\"ok\":true,\"aliases\":{\"haiku\":\"claude-haiku-5-5\"}}}" > $d/meta.json
	echo "{\"current\":\"9.9.9\",\"previous\":null}" > /v/state.json'
docker run -d --name "$NAME-plugin" --network "$NAME" --network-alias claude-plugin \
	--cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true \
	--read-only --tmpfs /tmp \
	-e GOSIDIAN_PLUGIN_TOKEN=t0k -e CLAUDE_TEST_TOKEN=sk-ant-oat01-SEPARATION-TEST \
	-v "$NAME":/var/lib/gosidian-claude \
	-v "$DIR/scripts/separation-preset.yaml":/etc/gosidian-claude/preset.yaml:ro \
	"$IMAGE" >/dev/null
docker run --rm --name "$NAME-harness" --network "$NAME" --network-alias claude-harness \
	-u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$DIR":/app:ro -v "$DIR/node_modules":/h/node_modules:ro \
	-v "$DIR/scripts/separation-harness.ts":/h/harness.ts:ro -w /h \
	node:24-alpine node /h/harness.ts
left=$(docker exec "$NAME-plugin" sh -c 'ls /tmp/gosidian-claude | wc -l; ps -o user= | grep -c "^agent" || true' | tr '\n' ' ')
case "$left" in
"0 0 ") echo "ok: the step left no folder and no process" ;;
*)
	echo "FAIL: after the step, folders and agent processes: $left" >&2
	docker exec "$NAME-plugin" ps -o pid,user,args >&2
	exit 1
	;;
esac
