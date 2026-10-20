#!/bin/sh
# Tests the image as it runs in production: its user (node, 1000), no
# capabilities, no new privileges, a read-only root, /tmp in tmpfs, the
# state in a volume, the credentials as files mounted read-only, on a
# network with no way out (--internal), beside a real ntfy (deny-all, a
# token, no attachments) and a real Mailpit (a user and a password). The
# harness (separation-harness.ts) fakes Telegram's Bot API and gosidian
# (its resume address, its file tickets), keeps a host outside the preset
# that counts what reaches it, and drives send, ask and cancel through MCP,
# with images by reference; it fails if a destination not in the preset is
# taken, if the plugin calls another host (an image's url among them), if
# a GET or a press of someone not allowed decides, or if a secret is in an
# output. Then, here: no secret, no token of the reply page and no file
# ticket in the plugin's log or its state (the resume key only where the
# answer goes), the state the user's and mode 600, only tini and the server
# running, no capability, the root read-only.
#
#   notify/scripts/separation-test.sh                 build gosidian-notify:test, then test it
#   IMAGE=gosidian-notify:0.1.0 notify/scripts/separation-test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-}
NTFY_IMAGE=binwiederhier/ntfy:v2.28.0
MAILPIT_IMAGE=axllent/mailpit:v1.31.4
NAME=notify-separation-$$
TMP=$(mktemp -d)
cleanup() {
	docker rm -f "$NAME-plugin" "$NAME-harness" "$NAME-ntfy" "$NAME-mailpit" >/dev/null 2>&1 || true
	docker network rm "$NAME" >/dev/null 2>&1 || true
	docker volume rm "$NAME-state" >/dev/null 2>&1 || true
	rm -rf "$TMP"
}
trap cleanup EXIT
if [ -z "$IMAGE" ]; then
	IMAGE=gosidian-notify:test
	docker build -q -t "$IMAGE" "$DIR" >/dev/null
fi
[ -d "$DIR/node_modules" ] || docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$DIR":/app -w /app node:24-alpine npm ci --ignore-scripts --no-audit --no-fund >/dev/null
docker network create --internal "$NAME" >/dev/null
docker volume create "$NAME-state" >/dev/null

# The credentials: values a leak would show, in files the plugin's user reads.
BOT="987654321:SEP-bot-secret-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SMTP_PASS="sep-smtp-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
mkdir -p "$TMP/secrets" "$TMP/out"
chmod 755 "$TMP/secrets"
chmod 777 "$TMP/out"

docker run -d --name "$NAME-ntfy" --network "$NAME" --network-alias ntfy \
	-e NTFY_BASE_URL=http://ntfy -e NTFY_LISTEN_HTTP=:80 -e NTFY_AUTH_FILE=/tmp/auth.db -e NTFY_AUTH_DEFAULT_ACCESS=deny-all \
	"$NTFY_IMAGE" serve >/dev/null
docker run -d --name "$NAME-mailpit" --network "$NAME" --network-alias mailpit \
	-e MP_SMTP_AUTH="notify:$SMTP_PASS" -e MP_SMTP_AUTH_ALLOW_INSECURE=true "$MAILPIT_IMAGE" >/dev/null
for i in $(seq 1 60); do
	docker exec "$NAME-ntfy" ntfy user list >/dev/null 2>&1 && break
	sleep 1
done
docker exec -e NTFY_PASSWORD="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" "$NAME-ntfy" ntfy user add notify-plugin >/dev/null
docker exec "$NAME-ntfy" ntfy access notify-plugin 'notify-*' rw >/dev/null
NTFY_TOKEN=$(docker exec "$NAME-ntfy" ntfy token add notify-plugin 2>&1 | grep -o 'tk_[a-z0-9]*' | head -1)
[ -n "$NTFY_TOKEN" ] || { echo "FAIL: no ntfy token" >&2; exit 1; }
printf '%s\n' "$BOT" >"$TMP/secrets/telegram-bot-token"
printf '%s\n' "$NTFY_TOKEN" >"$TMP/secrets/ntfy-token"
printf 'notify\n' >"$TMP/secrets/smtp-user"
printf '%s\n' "$SMTP_PASS" >"$TMP/secrets/smtp-password"
chmod 444 "$TMP/secrets"/*
cat >"$TMP/preset.yaml" <<YAML
name: notify
public_url: http://notify:8080
gosidian_url: http://harness:8082
time_zone: Europe/Rome
channels:
  telegram: {token_file: /run/secrets/telegram-bot-token, api_url: "http://harness:8081", poll_timeout: 2}
  ntfy: {server: "http://ntfy", token_file: /run/secrets/ntfy-token}
  email: {host: mailpit, port: 1025, security: none, user_file: /run/secrets/smtp-user, password_file: /run/secrets/smtp-password, from: "Notify <notify@example.com>"}
people:
  alice: {telegram: 111111111, ntfy: notify-sep-alice, email: alice@example.com}
  bob: {telegram: 222222222, ntfy: notify-sep-bob, email: bob@example.com}
  carol: {telegram: 333333333}
rooms:
  team:
    telegram: {chat: -1001234567890, topics: {agents: 15}}
    ntfy: notify-sep-team
YAML
chmod 644 "$TMP/preset.yaml"

docker run -d --name "$NAME-harness" --network "$NAME" --network-alias harness \
	-u "$(id -u):$(id -g)" -e HOME=/tmp -e SEP_BOT="$BOT" -e SEP_NTFY_TOKEN="$NTFY_TOKEN" -e SEP_SMTP_PASS="$SMTP_PASS" -e SEP_KEY="$KEY" \
	-v "$DIR":/app:ro -v "$TMP/out":/out -w /app node:24-alpine node /app/scripts/separation-harness.ts >/dev/null
docker run -d --name "$NAME-plugin" --network "$NAME" --network-alias notify \
	--cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp:mode=1777 --pids-limit 256 \
	-e GOSIDIAN_PLUGIN_TOKEN=t0k-separation \
	-v "$NAME-state":/var/lib/gosidian-notify -v "$TMP/secrets":/run/secrets:ro -v "$TMP/preset.yaml":/etc/gosidian-notify/preset.yaml:ro \
	"$IMAGE" >/dev/null

rc=$(docker wait "$NAME-harness")
docker logs "$NAME-harness"
fail=0
[ "$rc" = 0 ] || fail=1

c="$NAME-plugin"
logs=$(docker logs "$c" 2>&1)
state=$(docker exec "$c" cat /var/lib/gosidian-notify/state.json)
leaks=""
for s in "$BOT" "${BOT#*:}" "$NTFY_TOKEN" "$SMTP_PASS" "$KEY" $(cat "$TMP/out/tokens" 2>/dev/null); do
	printf '%s' "$logs" | grep -qF -- "$s" && leaks="$leaks log:${s%"${s#????}"}…"
	[ "$s" = "$KEY" ] && continue
	printf '%s' "$state" | grep -qF -- "$s" && leaks="$leaks state:${s%"${s#????}"}…"
done
# The resume key is kept only where the answer goes.
docker exec -e KEY="$KEY" "$c" node -e '
	const s = JSON.parse(require("fs").readFileSync("/var/lib/gosidian-notify/state.json", "utf8"));
	for (const q of Object.values(s.questions)) delete q.resume;
	process.exit(JSON.stringify(s).includes(process.env.KEY) ? 1 : 0)' || leaks="$leaks state:the-resume-key-outside-resume"
if [ -n "$leaks" ]; then
	echo "FAIL: secrets in the log or the state:$leaks" >&2
	fail=1
else
	echo "ok: no credential, resume key, reply-page token or file ticket in the plugin's log ($(printf '%s\n' "$logs" | wc -l) lines) or its state (the key only where the answer goes)"
fi
[ "$(printf '%s' "$state" | grep -c '"tokens":{"[0-9a-f]\{64\}"')" -ge 1 ] && echo "ok: the reply page's tokens kept as SHA-256 hashes" || { echo "FAIL: no hashed token in the state" >&2; fail=1; }
perm=$(docker exec "$c" stat -c '%u %a' /var/lib/gosidian-notify/state.json)
[ "$perm" = "1000 600" ] && echo "ok: the state is the user's, mode 600" || { echo "FAIL: the state is $perm" >&2; fail=1; }
# The processes: tini (1), the server its only child, and nothing below the
# server. docker exec's own processes have no parent in the container (0).
procs=$(docker exec "$c" ps -o pid=,ppid=,user=,args=)
node_pid=$(echo "$procs" | awk '$2 == 1 {print $1}')
others=$(echo "$procs" | awk -v n="$node_pid" '$1 != 1 && $1 != n && $2 != 0 {print}')
if [ "$(echo "$node_pid" | wc -w)" != 1 ] || [ -n "$others" ]; then
	echo "FAIL: processes besides tini and the server:" >&2
	echo "$procs" >&2
	fail=1
else
	echo "ok: only tini and the server run: $(echo "$procs" | awk -v n="$node_pid" '$1 == 1 || $1 == n {$2 = ""; printf "%s; ", $0}')"
fi
uid=$(docker exec "$c" sh -c 'id -u')
[ "$uid" = 1000 ] || { echo "FAIL: the server's user is $uid" >&2; fail=1; }
docker exec "$c" sh -c 'touch /app/x 2>/dev/null' && { echo "FAIL: the root is writable" >&2; fail=1; }
caps=$(docker exec "$c" sh -c 'grep -E "^Cap(Eff|Prm)" /proc/1/status' | awk '{print $2}' | sort -u | tr '\n' ' ')
[ "$caps" = "0000000000000000 " ] || { echo "FAIL: capabilities $caps" >&2; fail=1; }
[ "$fail" = 0 ] || { echo "--- the plugin's log:" >&2; echo "$logs" >&2; exit 1; }
echo "ok: the image as in production: user 1000, no capabilities, a read-only root, no way out of its network, no secret in its outputs, log or state"
