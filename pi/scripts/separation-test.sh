#!/bin/sh
# Tests the image as it runs in production: root with only SETUID and SETGID,
# a read-only root, /tmp in tmpfs. A fake endpoint has the agent run bash to
# reach what it must not (the server's environment, the key, a link to a
# file of the system) and to leave a process behind; the script fails if
# any of it works, or if the step leaves its folder or a process.
#
#   pi/scripts/separation-test.sh                 build gosidian-pi:test, then test it
#   IMAGE=gosidian-pi:0.1.0 pi/scripts/separation-test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-}
NET=pi-separation-$$
cleanup() {
	docker rm -f pi-plugin-$$ pi-harness-$$ >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
if [ -z "$IMAGE" ]; then
	IMAGE=gosidian-pi:test
	docker build -q -t "$IMAGE" "$DIR" >/dev/null
fi
[ -d "$DIR/node_modules" ] || docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$DIR":/app -w /app node:24-alpine npm ci --ignore-scripts --no-audit --no-fund >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name pi-plugin-$$ --network "$NET" --network-alias pi-plugin \
	--cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true \
	--read-only --tmpfs /tmp \
	-e GOSIDIAN_PLUGIN_TOKEN=t0k -e PI_TEST_KEY=sk-separation-test \
	-v "$DIR/scripts/separation-preset.yaml":/etc/gosidian-pi/preset.yaml:ro \
	"$IMAGE" >/dev/null
docker run --rm --name pi-harness-$$ --network "$NET" --network-alias pi-harness \
	-u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$DIR":/app:ro -v "$DIR/node_modules":/h/node_modules:ro \
	-v "$DIR/scripts/separation-harness.ts":/h/harness.ts:ro -w /h \
	node:24-alpine node /h/harness.ts
left=$(docker exec pi-plugin-$$ sh -c 'ls /tmp/gosidian-pi | wc -l; ps -o user= | grep -c "^agent" || true' | tr '\n' ' ')
case "$left" in
"0 0 ") echo "ok: the step left no folder and no process" ;;
*)
	echo "FAIL: after the step, folders and agent processes: $left" >&2
	docker exec pi-plugin-$$ ps -o pid,user,args >&2
	exit 1
	;;
esac
