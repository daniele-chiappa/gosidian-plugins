#!/bin/sh
# Tests the image as it runs in production: its user (node, 1000), no
# capabilities, no new privileges, a read-only root, /tmp in tmpfs, the
# previews in a volume; two of them, connect open and connect self, beside a
# Playwright server of the version of playwright-core. The harness
# (separation-harness.ts) publishes previews of two projects through MCP,
# zips that must be refused (a link to /etc/passwd, a path out of the
# folder) and one with code that would write a file if anything ran it;
# then, in Chromium, Firefox and WebKit, looks for what a preview must not
# reach: its storage and its cookies, another preview's page (in a popup, in
# a frame), the credentials of its host, another host with connect self.
# It prints what each browser did, and fails if something leaked. In the
# end: no process but the server's in the plugin's container, nothing of a
# zip run, no executable file in the store.
#
#   preview/scripts/separation-test.sh                 build gosidian-preview:test, then test it
#   IMAGE=gosidian-preview:0.1.0 preview/scripts/separation-test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-}
PW=$(sed -n 's/.*"playwright-core": "\([0-9.]*\)".*/\1/p' "$DIR/package.json")
NAME=preview-separation-$$
TMP=$(mktemp -d)
cleanup() {
	docker rm -f "$NAME-open" "$NAME-self" "$NAME-pw" "$NAME-harness" >/dev/null 2>&1 || true
	docker network rm "$NAME" >/dev/null 2>&1 || true
	docker volume rm "$NAME-open" "$NAME-self" >/dev/null 2>&1 || true
	rm -rf "$TMP"
}
trap cleanup EXIT
if [ -z "$IMAGE" ]; then
	IMAGE=gosidian-preview:test
	docker build -q -t "$IMAGE" "$DIR" >/dev/null
fi
[ -d "$DIR/node_modules" ] || docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$DIR":/app -w /app node:24-alpine npm ci --ignore-scripts --no-audit --no-fund >/dev/null
docker network create "$NAME" >/dev/null
docker volume create "$NAME-open" >/dev/null
docker volume create "$NAME-self" >/dev/null

docker run -d --name "$NAME-pw" --network "$NAME" --network-alias pw --init --shm-size=1g -e HOME=/tmp -e npm_config_update_notifier=false \
	"mcr.microsoft.com/playwright:v$PW-noble" npx -y "playwright@$PW" run-server --port 3000 --host 0.0.0.0 >/dev/null

printf 'name: preview-self\nconnect: self\nlimits: {ttl: 1h}\n' >"$TMP/self.yaml"
chmod 644 "$TMP/self.yaml"
run_plugin() { # name alias preset-args...
	n=$1
	alias=$2
	shift 2
	docker run -d --name "$n" --network "$NAME" --network-alias "$alias" \
		--cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp:mode=1777 --pids-limit 256 \
		-e GOSIDIAN_PLUGIN_TOKEN=t0k-separation -e PREVIEW_PUBLIC_URL="http://$alias:8080" -e PREVIEW_PLAYWRIGHT_WS=ws://pw:3000/ \
		"$@" "$IMAGE" >/dev/null
}
run_plugin "$NAME-open" preview-open -v "$NAME-open":/var/lib/gosidian-preview
run_plugin "$NAME-self" preview-self -v "$NAME-self":/var/lib/gosidian-preview -v "$TMP/self.yaml":/etc/gosidian-preview/preset.yaml:ro

for i in $(seq 1 180); do
	docker logs "$NAME-pw" 2>&1 | grep -q "Listening on" && break
	sleep 1
done
docker logs "$NAME-pw" 2>&1 | grep -q "Listening on" || { echo "FAIL: the Playwright server $PW did not start" >&2; docker logs "$NAME-pw" >&2; exit 1; }

docker run --rm --name "$NAME-harness" --network "$NAME" --network-alias harness \
	-u "$(id -u):$(id -g)" -e HOME=/tmp -v "$DIR":/app:ro -w /app \
	node:24-alpine node /app/scripts/separation-harness.ts

fail=0
for p in open self; do
	c="$NAME-$p"
	# The processes: tini (1), the server its only child, and nothing below
	# the server. docker exec's own processes have no parent in the
	# container (0).
	procs=$(docker exec "$c" ps -o pid=,ppid=,user=,args=)
	node_pid=$(echo "$procs" | awk '$2 == 1 {print $1}')
	others=$(echo "$procs" | awk -v n="$node_pid" '$1 != 1 && $1 != n && $2 != 0 {print}')
	if [ "$(echo "$node_pid" | wc -w)" != 1 ] || [ -n "$others" ]; then
		echo "FAIL ($p): processes besides tini and the server:" >&2
		echo "$procs" >&2
		fail=1
	else
		echo "ok ($p): only tini and the server run: $(echo "$procs" | awk -v n="$node_pid" '$1 == 1 || $1 == n {$2 = ""; printf "%s; ", $0}')"
	fi
	uid=$(docker exec "$c" sh -c 'id -u')
	[ "$uid" = 1000 ] || { echo "FAIL ($p): the server's user is $uid" >&2; fail=1; }
	left=$(docker exec "$c" sh -c 'ls -A /tmp; find /var/lib/gosidian-preview -type f -perm /111; find /var/lib/gosidian-preview ! -user 1000; find /var/lib/gosidian-preview -type l' | tr '\n' ' ')
	if [ -n "$left" ]; then
		echo "FAIL ($p): in /tmp, executables, files of another user or links in the store: $left" >&2
		fail=1
	else
		echo "ok ($p): nothing of the zips ran (no file in /tmp), no executable, link or file of another user in the store"
	fi
	docker exec "$c" sh -c 'touch /app/x 2>/dev/null' && { echo "FAIL ($p): the root is writable" >&2; fail=1; }
	grep_caps=$(docker exec "$c" sh -c 'grep -E "^Cap(Eff|Prm)" /proc/1/status' | awk '{print $2}' | sort -u | tr '\n' ' ')
	[ "$grep_caps" = "0000000000000000 " ] || { echo "FAIL ($p): capabilities $grep_caps" >&2; fail=1; }
done
[ "$fail" = 0 ] || { docker logs "$NAME-open" >&2; exit 1; }
echo "ok: the image as in production: user 1000, no capabilities, a read-only root, nothing run of the zips"
