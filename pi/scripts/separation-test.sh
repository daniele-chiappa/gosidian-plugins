#!/bin/sh
# Tests the image as it runs in production: root with only SETUID and SETGID,
# a read-only root, /tmp in tmpfs. A fake endpoint has the agent run bash to
# reach what it must not (the server's environment, the key, a link to a
# file of the system, gosidian's token where it does not belong, the deploy
# key and the git folder of a repository, a push of its own) and to leave a
# process behind, then to run a command past the step's max_seconds; the
# script fails if any of it works, if a hard link in the repository is
# committed, if the step past its max_seconds is not stopped at the limit,
# or if a step leaves its folder or a process. A
# git server over SSH (sshd and git-shell, a deploy key made here) holds the
# repository.
#
#   pi/scripts/separation-test.sh                 build gosidian-pi:test, then test it
#   IMAGE=gosidian-pi:0.1.0 pi/scripts/separation-test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-}
NET=pi-separation-$$
TMP=$(mktemp -d)
cleanup() {
	docker rm -f pi-plugin-$$ pi-harness-$$ pi-git-$$ >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
	# The deploy key is root's.
	docker run --rm -v "$TMP":/t --entrypoint rm "$IMAGE" -f /t/deploy_key /t/deploy_key.pub >/dev/null 2>&1 || true
	rm -rf "$TMP"
}
trap cleanup EXIT
if [ -z "$IMAGE" ]; then
	IMAGE=gosidian-pi:test
	docker build -q --build-context kit="$DIR/../agent-kit" -t "$IMAGE" "$DIR" >/dev/null
fi
[ -d "$DIR/node_modules" ] || docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$DIR":/app -w /app node:24-alpine npm ci --ignore-scripts --no-audit --no-fund >/dev/null
docker network create "$NET" >/dev/null
chmod 755 "$TMP"
mkdir "$TMP/out"

# The repository's deploy key, root's and readable by root only, as a
# preset's key_file is; and a git server that takes it.
docker run --rm -v "$TMP":/k --entrypoint ssh-keygen "$IMAGE" -q -t ed25519 -N "" -C deploy -f /k/deploy_key
docker run -d --name pi-git-$$ --network "$NET" --network-alias git-server -v "$TMP/deploy_key.pub":/keys/deploy_key.pub:ro \
	--entrypoint sh "$IMAGE" -c '
	set -e
	apk add --no-cache openssh-server >/dev/null
	ssh-keygen -A >/dev/null
	adduser -D -s /usr/bin/git-shell git
	sed -i "s/^git:!:/git:*:/" /etc/shadow
	mkdir -p /home/git/.ssh
	cp /keys/deploy_key.pub /home/git/.ssh/authorized_keys
	git init -q --bare -b main /home/git/app.git
	d=$(mktemp -d) && cd "$d" && git init -q -b main && echo one > a.txt && git add a.txt
	git -c user.name=t -c user.email=t@t commit -qm seed && git push -q /home/git/app.git main
	chown -R git:git /home/git && chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys
	exec /usr/sbin/sshd -D -e' >/dev/null
ready=
for i in $(seq 1 120); do
	if docker exec pi-git-$$ sh -c 'netstat -ltn | grep -q ":22 "' 2>/dev/null; then
		ready=1
		break
	fi
	sleep 1
done
[ -n "$ready" ] || { echo "FAIL: the git server did not start" >&2; docker logs pi-git-$$ >&2; exit 1; }
hostkey=$(docker exec pi-git-$$ cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)
{
	cat "$DIR/scripts/separation-preset.yaml"
	cat <<EOF
mcp: [read]
repos:
  - name: app
    url: git@git-server:app.git
    key_file: /etc/gosidian-pi/deploy_key
    known_hosts: "git-server $hostkey"
EOF
} >"$TMP/preset.yaml"
chmod 644 "$TMP/preset.yaml"

docker run -d --name pi-plugin-$$ --network "$NET" --network-alias pi-plugin \
	--cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true \
	--read-only --tmpfs /tmp \
	-e GOSIDIAN_PLUGIN_TOKEN=t0k -e PI_TEST_KEY=sk-separation-test \
	-v "$TMP/preset.yaml":/etc/gosidian-pi/preset.yaml:ro \
	-v "$TMP/deploy_key":/etc/gosidian-pi/deploy_key:ro \
	"$IMAGE" >/dev/null
docker run --rm --name pi-harness-$$ --network "$NET" --network-alias pi-harness \
	-u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$DIR":/app:ro -v "$DIR/../agent-kit":/agent-kit:ro -v "$DIR/node_modules":/h/node_modules:ro \
	-v "$DIR/scripts/separation-harness.ts":/h/harness.ts:ro -v "$TMP/out":/out -w /h \
	node:24-alpine node /h/harness.ts
left=$(docker exec pi-plugin-$$ sh -c 'ls /tmp/gosidian-pi | wc -l; ps -o user= | grep -c "^agent" || true' | tr '\n' ' ')
case "$left" in
"0 0 ") echo "ok: the steps left no folder and no process" ;;
*)
	echo "FAIL: after the steps, folders and agent processes: $left" >&2
	docker exec pi-plugin-$$ ps -o pid,user,args >&2
	exit 1
	;;
esac
# On the git server: main as it was, the branch of the step with its one
# file, nothing the agent pushed, nothing of the step with a hard link.
branch=$(cat "$TMP/out/branch")
refs=$(docker exec pi-git-$$ git --git-dir=/home/git/app.git for-each-ref --format='%(refname:short)' refs/heads | sort | tr '\n' ' ')
files=$(docker exec pi-git-$$ git --git-dir=/home/git/app.git show --name-only --format= "$branch" | tr '\n' ' ')
mainlog=$(docker exec pi-git-$$ git --git-dir=/home/git/app.git rev-list --count main)
if [ "$refs" = "$branch main " ] && [ "$files" = "b.txt " ] && [ "$mainlog" = 1 ]; then
	echo "ok: the git server has main and the step's branch, with b.txt alone"
else
	echo "FAIL: on the git server, branches: $refs; files of $branch: $files; commits on main: $mainlog" >&2
	exit 1
fi
