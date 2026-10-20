#!/bin/sh
# The plugin's type check and tests in a throwaway node:24-alpine, beside a
# real ntfy server (access control on: deny-all, a user of the tests and
# its token) and a Mailpit SMTP that asks for a user and a password, each
# in a container of its own on a network of theirs. Telegram and gosidian's
# resume address are fakes of the tests. The tests run as a user of their
# own; in the end the container gives back to the caller's user every file
# it made. NOTIFY_TEST_NO_SERVICES=1 skips the servers (and their tests).
#
#   notify/scripts/test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
# The images: published at least two weeks before they were pinned.
NTFY_IMAGE=binwiederhier/ntfy:v2.28.0
MAILPIT_IMAGE=axllent/mailpit:v1.31.4
NAME=notify-test-$$
cleanup() {
	docker rm -f "$NAME-ntfy" "$NAME-mailpit" >/dev/null 2>&1 || true
	docker network rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$NAME" >/dev/null
NTFY= NTFY_TOKEN= SMTP= MAILPIT=
if [ -z "${NOTIFY_TEST_NO_SERVICES:-}" ]; then
	docker run -d --name "$NAME-ntfy" --network "$NAME" --network-alias ntfy \
		-e NTFY_BASE_URL=http://ntfy -e NTFY_LISTEN_HTTP=:80 -e NTFY_AUTH_FILE=/tmp/auth.db -e NTFY_AUTH_DEFAULT_ACCESS=deny-all \
		"$NTFY_IMAGE" serve >/dev/null
	docker run -d --name "$NAME-mailpit" --network "$NAME" --network-alias mailpit \
		-e MP_SMTP_AUTH="mailer:mailpit-test-pass" -e MP_SMTP_AUTH_ALLOW_INSECURE=true \
		"$MAILPIT_IMAGE" >/dev/null
	for i in $(seq 1 60); do
		docker exec "$NAME-ntfy" ntfy user list >/dev/null 2>&1 && break
		sleep 1
	done
	docker exec -e NTFY_PASSWORD=ntfy-test-pass "$NAME-ntfy" ntfy user add notify-tests >/dev/null
	docker exec "$NAME-ntfy" ntfy access notify-tests 'notify-*' rw >/dev/null
	NTFY_TOKEN=$(docker exec "$NAME-ntfy" ntfy token add notify-tests 2>&1 | grep -o 'tk_[a-z0-9]*' | head -1)
	[ -n "$NTFY_TOKEN" ] || { echo "FAIL: no ntfy token" >&2; docker logs "$NAME-ntfy" >&2; exit 1; }
	NTFY=http://ntfy SMTP=mailpit:1025 MAILPIT=http://mailpit:8025
fi
docker run --rm --network "$NAME" -e HOME=/tmp -e npm_config_update_notifier=false -e OWNER="$(id -u):$(id -g)" \
	-e NOTIFY_TEST_NTFY="$NTFY" -e NOTIFY_TEST_NTFY_TOKEN="$NTFY_TOKEN" -e NOTIFY_TEST_SMTP="$SMTP" -e NOTIFY_TEST_MAILPIT="$MAILPIT" \
	-e NOTIFY_TEST_SMTP_USER=mailer -e NOTIFY_TEST_SMTP_PASS=mailpit-test-pass \
	-v "$DIR":/app -w /app node:24-alpine \
	sh -c 'rc=0
		{ npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run check \
			&& adduser -D -u 19999 tester && su tester -s /bin/sh -c "NOTIFY_TEST_NTFY=$NOTIFY_TEST_NTFY NOTIFY_TEST_NTFY_TOKEN=$NOTIFY_TEST_NTFY_TOKEN NOTIFY_TEST_SMTP=$NOTIFY_TEST_SMTP NOTIFY_TEST_MAILPIT=$NOTIFY_TEST_MAILPIT NOTIFY_TEST_SMTP_USER=$NOTIFY_TEST_SMTP_USER NOTIFY_TEST_SMTP_PASS=$NOTIFY_TEST_SMTP_PASS npm test"; } || rc=$?
		find /app -xdev -user 0 -exec chown -h "$OWNER" {} +
		exit $rc'
