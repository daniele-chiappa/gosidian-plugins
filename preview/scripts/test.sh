#!/bin/sh
# The plugin's type check and tests in a throwaway node:24-alpine, beside a
# Playwright server of the version of playwright-core (package.json) in a
# container of Microsoft's image, on a network of their own: the browser
# reaches the tests' HTTP servers at the name "tests". The tests run as a
# user of their own; in the end the container gives back to the caller's
# user every file it made. PREVIEW_TEST_NO_PLAYWRIGHT=1 skips the browser
# (and its tests).
#
#   preview/scripts/test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
PW=$(sed -n 's/.*"playwright-core": "\([0-9.]*\)".*/\1/p' "$DIR/package.json")
NAME=preview-test-$$
cleanup() {
	docker rm -f "$NAME-pw" >/dev/null 2>&1 || true
	docker network rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$NAME" >/dev/null
WS=
if [ -z "${PREVIEW_TEST_NO_PLAYWRIGHT:-}" ]; then
	docker run -d --name "$NAME-pw" --network "$NAME" --network-alias pw --init --shm-size=1g -e HOME=/tmp -e npm_config_update_notifier=false \
		"mcr.microsoft.com/playwright:v$PW-noble" npx -y "playwright@$PW" run-server --port 3000 --host 0.0.0.0 >/dev/null
	for i in $(seq 1 180); do
		docker logs "$NAME-pw" 2>&1 | grep -q "Listening on" && break
		[ "$(docker inspect -f '{{.State.Running}}' "$NAME-pw")" = true ] || break
		sleep 1
	done
	docker logs "$NAME-pw" 2>&1 | grep -q "Listening on" || { echo "FAIL: the Playwright server $PW did not start" >&2; docker logs "$NAME-pw" >&2; exit 1; }
	WS=ws://pw:3000/
fi
docker run --rm --network "$NAME" --network-alias tests -e HOME=/tmp -e npm_config_update_notifier=false -e OWNER="$(id -u):$(id -g)" \
	-e PREVIEW_TEST_PLAYWRIGHT_WS="$WS" -e PREVIEW_TEST_HOST=tests \
	-v "$DIR":/app -w /app node:24-alpine \
	sh -c 'rc=0
		{ npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run check \
			&& adduser -D -u 19999 tester && su tester -s /bin/sh -c "PREVIEW_TEST_PLAYWRIGHT_WS=$PREVIEW_TEST_PLAYWRIGHT_WS PREVIEW_TEST_HOST=$PREVIEW_TEST_HOST npm test"; } || rc=$?
		find /app -xdev -user 0 -exec chown -h "$OWNER" {} +
		exit $rc'
