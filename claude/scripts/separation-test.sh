#!/bin/sh
# Tests the image as it runs in production: root with only SETUID and SETGID,
# a read-only root, /tmp in tmpfs, the versions in a volume. The volume holds
# a fake Claude Code (test/fake-claude.ts) instead of the real one, and a fake
# API stands in for Anthropic's: no credential and no network to the outside.
# The fake runs a shell command that tries to reach what it must not (the
# server's environment, the token, a link to a file of the system) and leaves
# a process behind; then, on a repository the script makes in the container
# with a deploy key only root reads, and with gosidian's MCP (a fake), it
# tries the key, the git folder, a commit and a push of its own, a hard link
# to a file only root reads, the MCP token in a command line; then a hard
# link the server must refuse to commit; then a step that sleeps past its
# max_seconds, which the server must stop at the limit. The script fails if
# any of it works, if the server's commit holds more than the agent's plain
# edit, if the step past its max_seconds runs on, or if a step leaves its
# folder or a process.
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
	docker build -q --build-context kit="$DIR/../agent-kit" -t "$IMAGE" "$DIR" >/dev/null
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
	--read-only --tmpfs /tmp --tmpfs /repos:mode=0755 \
	-e GOSIDIAN_PLUGIN_TOKEN=t0k -e CLAUDE_TEST_TOKEN=sk-ant-oat01-SEPARATION-TEST \
	-v "$NAME":/var/lib/gosidian-claude \
	-v "$DIR/scripts/separation-preset.yaml":/etc/gosidian-claude/preset.yaml:ro \
	"$IMAGE" >/dev/null
# The repository (a.txt on main), its deploy key, and a file only root
# reads on the steps' file system, all root's.
docker exec "$NAME-plugin" sh -c '
	set -e
	g() { git -c user.name=seed -c user.email=seed@example.com -c init.defaultBranch=main "$@"; }
	g init -q --bare /repos/app.git
	g init -q /tmp/seed && echo one > /tmp/seed/a.txt
	g -C /tmp/seed add a.txt && g -C /tmp/seed commit -qm seed && g -C /tmp/seed push -q /repos/app.git main
	rm -rf /tmp/seed
	echo "-----BEGIN OPENSSH PRIVATE KEY----- separation test" > /repos/deploy-key && chmod 600 /repos/deploy-key
	echo root-only > /tmp/root-only && chmod 600 /tmp/root-only'
docker run --rm --name "$NAME-harness" --network "$NAME" --network-alias claude-harness \
	-u "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$DIR":/app:ro -v "$DIR/../agent-kit":/agent-kit:ro -v "$DIR/node_modules":/h/node_modules:ro \
	-v "$DIR/scripts/separation-harness.ts":/h/harness.ts:ro -w /h \
	node:24-alpine node /h/harness.ts
# One branch of a step, with the agent's plain edit only, on main, by the
# preset's author.
repo=$(docker exec "$NAME-plugin" sh -c '
	cd /repos/app.git
	b=$(git for-each-ref --format="%(refname:short)" refs/heads/agent/)
	echo "branches=$(echo $b)"
	[ "$(echo "$b" | wc -l)" = 1 ] && [ -n "$b" ] || exit 0
	echo "files=$(git diff --name-only main "$b" | tr "\n" " ")parent=$(git rev-parse "$b^" | cut -c1-7)/$(git rev-parse main | cut -c1-7) author=$(git log -1 --format=%an "$b")"')
echo "$repo"
case "$repo" in
*"files=a.txt parent="*" author=gosidian agent")
	p=${repo##*parent=}
	p=${p%% *}
	[ "${p%/*}" = "${p#*/}" ] || { echo "FAIL: the step's commit is not on main" >&2; exit 1; }
	echo "ok: the step's branch holds the server's commit of a.txt alone, on main"
	;;
*)
	echo "FAIL: the repository after the steps: $repo" >&2
	exit 1
	;;
esac
left=$(docker exec "$NAME-plugin" sh -c 'ls /tmp/gosidian-claude | wc -l; ps -o user= | grep -c "^agent" || true' | tr '\n' ' ')
case "$left" in
"0 0 ") echo "ok: the step left no folder and no process" ;;
*)
	echo "FAIL: after the step, folders and agent processes: $left" >&2
	docker exec "$NAME-plugin" ps -o pid,user,args >&2
	exit 1
	;;
esac
