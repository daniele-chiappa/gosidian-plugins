#!/bin/sh
# The plugin's type check and tests in a throwaway node:24-alpine. The tests
# run real scripts and need bash, git, GNU tar and ssh (a fake ssh stands in
# for the hosts; sshd, when present, for a real one): the container runs as
# root to add them, then runs the tests as a user of their own. A step's
# ulimit -u counts the processes and threads of its user in the whole user
# namespace, and root inside a container (an LXC's, or a CI runner's) is
# not exempt from it: as root, a step could not fork. In the end the
# container gives back to the caller's user every file it made.
#
#   exec/scripts/test.sh
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
docker run --rm -e HOME=/tmp -e npm_config_update_notifier=false -e OWNER="$(id -u):$(id -g)" \
	-v "$DIR":/app -v "$DIR/../agent-kit":/agent-kit -w /app node:24-alpine \
	sh -c 'rc=0
		{ apk add --no-cache bash git tar openssh-client openssh-server >/dev/null && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run check \
			&& adduser -D -u 19999 tester && su tester -s /bin/sh -c "npm test"; } || rc=$?
		find /app /agent-kit -xdev -user 0 -exec chown -h "$OWNER" {} +
		exit $rc'
