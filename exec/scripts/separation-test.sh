#!/bin/sh
# Tests the image as it runs in production: root with only SETUID and SETGID,
# no new privileges, a read-only root, /tmp in tmpfs (exec: the steps run
# what they build), the cache in a volume, two slots. The harness
# (separation-harness.ts) runs scripts that try to reach what they must not
# (the server's environment, the plugin's token, a host's key only root
# reads, the cache's key, another slot's folder), leave processes behind,
# fork until the limit stops them, write a file beyond its size; builds a
# Go and a C program and a Python venv as the slot's user; checks out a
# repository at a tag; and runs steps on a host over SSH: a throwaway sshd
# with a key made here, files in and out, its timeout, a forged host key.
# The script fails if any of it works, or if a step leaves its folder or a
# process, here or on the host.
#
#   exec/scripts/separation-test.sh                 build gosidian-exec:test, then test it
#   IMAGE=gosidian-exec:0.1.0 exec/scripts/separation-test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-}
NAME=exec-separation-$$
TMP=$(mktemp -d)
cleanup() {
	docker rm -f "$NAME-plugin" "$NAME-harness" "$NAME-box" >/dev/null 2>&1 || true
	docker network rm "$NAME" >/dev/null 2>&1 || true
	docker volume rm "$NAME-cache" >/dev/null 2>&1 || true
	# The keys are root's.
	[ -z "$IMAGE" ] || docker run --rm -v "$TMP":/t --entrypoint sh "$IMAGE" -c 'rm -f /t/box_key /t/box_key.pub /t/other /t/other.pub' >/dev/null 2>&1 || true
	rm -rf "$TMP"
}
trap cleanup EXIT
if [ -z "$IMAGE" ]; then
	IMAGE=gosidian-exec:test
	docker build -q --build-context kit="$DIR/../agent-kit" -t "$IMAGE" "$DIR" >/dev/null
fi
[ -d "$DIR/node_modules" ] || docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$DIR":/app -w /app node:24-alpine npm ci --ignore-scripts --no-audit --no-fund >/dev/null
docker network create "$NAME" >/dev/null
docker volume create "$NAME-cache" >/dev/null
chmod 755 "$TMP"

# The plugin's key for the host, root's and readable by root only, as a
# preset's key_file is; another key, whose public half is a forged host key.
docker run --rm -v "$TMP":/k --entrypoint sh "$IMAGE" -c \
	'ssh-keygen -q -t ed25519 -N "" -C box -f /k/box_key && ssh-keygen -q -t ed25519 -N "" -C other -f /k/other'

# The host: sshd, a user deploy who takes the key.
docker run -d --name "$NAME-box" --network "$NAME" --network-alias box -v "$TMP/box_key.pub":/keys/box_key.pub:ro \
	--entrypoint sh "$IMAGE" -c '
	set -e
	apk add --no-cache openssh-server >/dev/null
	ssh-keygen -A >/dev/null
	adduser -D -s /bin/sh deploy
	sed -i "s/^deploy:!:/deploy:*:/" /etc/shadow
	mkdir -p /home/deploy/.ssh
	cp /keys/box_key.pub /home/deploy/.ssh/authorized_keys
	chown -R deploy:deploy /home/deploy && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
	exec /usr/sbin/sshd -D -e' >/dev/null
ready=
for i in $(seq 1 120); do
	if docker exec "$NAME-box" sh -c 'netstat -ltn | grep -q ":22 "' 2>/dev/null; then
		ready=1
		break
	fi
	sleep 1
done
[ -n "$ready" ] || { echo "FAIL: the host's sshd did not start" >&2; docker logs "$NAME-box" >&2; exit 1; }
hostkey=$(docker exec "$NAME-box" cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)
forged=$(cut -d' ' -f1,2 "$TMP/other.pub")
{
	cat "$DIR/scripts/separation-preset.yaml"
	cat <<EOF
hosts:
  - name: box
    host: box
    user: deploy
    key_file: /etc/gosidian-exec/box_key
    known_hosts: "box $hostkey"
  - name: forged
    host: box
    user: deploy
    key_file: /etc/gosidian-exec/box_key
    known_hosts: "box $forged"
EOF
} >"$TMP/preset.yaml"
chmod 644 "$TMP/preset.yaml"

docker run -d --name "$NAME-plugin" --network "$NAME" --network-alias exec-plugin \
	--cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true \
	--read-only --tmpfs /tmp:exec,mode=1777 --tmpfs /repos:mode=0755 \
	-e GOSIDIAN_PLUGIN_TOKEN=t0k-separation -e EXEC_WORKERS=2 \
	-v "$NAME-cache":/var/cache/gosidian-exec \
	-v "$TMP/preset.yaml":/etc/gosidian-exec/preset.yaml:ro \
	-v "$TMP/box_key":/etc/gosidian-exec/box_key:ro \
	"$IMAGE" >/dev/null
# The repository: a.txt on main, tagged v1, then a second commit.
docker exec "$NAME-plugin" sh -c '
	set -e
	g() { git -c user.name=seed -c user.email=seed@example.com -c init.defaultBranch=main "$@"; }
	g init -q --bare /repos/app.git
	g init -q /tmp/seed && echo one > /tmp/seed/a.txt
	g -C /tmp/seed add a.txt && g -C /tmp/seed commit -qm seed && g -C /tmp/seed tag v1
	echo two > /tmp/seed/a.txt && g -C /tmp/seed commit -qam two
	g -C /tmp/seed push -q /repos/app.git main v1
	rm -rf /tmp/seed'
docker run --rm --name "$NAME-harness" --network "$NAME" --network-alias exec-harness \
	-u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$DIR":/app:ro -v "$DIR/../agent-kit":/agent-kit:ro -v "$DIR/node_modules":/h/node_modules:ro \
	-v "$DIR/scripts/separation-harness.ts":/h/harness.ts:ro -w /h \
	node:24-alpine node /h/harness.ts
sleep 1
left=$(docker exec "$NAME-plugin" sh -c 'ls -A /tmp/gosidian-exec | wc -l; ps -o user= | grep -c "^exec" || true' | tr '\n' ' ')
case "$left" in
"0 0 ") echo "ok: the steps left no folder and no process" ;;
*)
	echo "FAIL: after the steps, folders and slots' processes: $left" >&2
	docker exec "$NAME-plugin" ps -o pid,user,args >&2
	exit 1
	;;
esac
left=$(docker exec "$NAME-box" sh -c 'ls -A /tmp/gosidian-exec 2>/dev/null | wc -l; ps -o user=,args= | grep -c "^deploy" || true' | tr '\n' ' ')
case "$left" in
"0 0 ") echo "ok: on the host, no step's folder and no process left" ;;
*)
	echo "FAIL: on the host, folders and processes of deploy: $left" >&2
	docker exec "$NAME-box" ps -o pid,user,args >&2
	exit 1
	;;
esac
