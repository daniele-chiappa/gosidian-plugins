#!/bin/sh
# Tests the WebDAV source of gosidian-storage against a disposable
# Nextcloud of the version it is tried with (34). Run by hand: it
# starts the Nextcloud container (SQLite), makes a user and its folder,
# seeds files with their times, runs nextcloud_test.go (-tags nextcloud)
# beside it, then removes everything.
#
#   storage/scripts/nextcloud-test.sh
#   KEEP=1 storage/scripts/nextcloud-test.sh   leave the Nextcloud up afterwards
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-nextcloud:34.0.2-apache}
NAME=gos-storage-nc
NET=gos-storage-net
USER_NAME=storage
WORK=$(mktemp -d)
ADMIN_PASS=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
USER_PASS=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
cleanup() {
	if [ "${KEEP:-}" = 1 ]; then
		echo "left $NAME up on the network $NET; remove it with: docker rm -f $NAME; docker network rm $NET"
	else
		docker rm -f "$NAME" >/dev/null 2>&1 || true
		docker network rm "$NET" >/dev/null 2>&1 || true
	fi
	rm -f "${WORK:?}/cred"
	rmdir "${WORK:?}"
}
trap cleanup EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
docker run -d --name "$NAME" --network "$NET" -e SQLITE_DATABASE=nextcloud \
	-e NEXTCLOUD_ADMIN_USER=admin -e NEXTCLOUD_ADMIN_PASSWORD="$ADMIN_PASS" \
	-e NEXTCLOUD_TRUSTED_DOMAINS="$NAME localhost" "$IMAGE" >/dev/null
echo "waiting for $IMAGE to install"
i=0
until docker exec "$NAME" curl -s localhost/status.php 2>/dev/null | grep -q '"installed":true'; do
	i=$((i + 1))
	if [ "$i" -gt 90 ]; then
		echo "Nextcloud did not come up:" >&2
		docker logs "$NAME" 2>&1 | tail -20 >&2
		exit 1
	fi
	sleep 2
done
# The user of the plugin, its password from the environment (never on a
# command line), and the folder the source reads.
docker exec -u www-data -e OC_PASS="$USER_PASS" "$NAME" php occ user:add --password-from-env "$USER_NAME" >/dev/null
DAV="http://localhost/remote.php/dav/files/$USER_NAME"
put() { # put <path> <content> [mtime]
	printf '%s' "$2" | docker exec -i -e P="$USER_PASS" "$NAME" sh -c \
		"curl -sf -u $USER_NAME:\"\$P\" ${3:+-H 'X-OC-Mtime: $3'} -T - '$DAV/lab/$1' >/dev/null"
}
mkcol() {
	docker exec -e P="$USER_PASS" "$NAME" sh -c "curl -sf -u $USER_NAME:\"\$P\" -X MKCOL '$DAV/lab/$1' >/dev/null"
}
mkcol ""
mkcol 2024
mkcol archivio
mkcol archivio/2023
put 2024/fattura_T1.pdf "%PDF-1.4 fattura T1
" 1709287200
put 2024/fattura_T2.pdf "%PDF-1.4 fattura T2
"
put leggimi.txt "Il banco di gosidian-storage.
"
put archivio/2023/nota.txt "una nota del 2023
"
put "con%20spazio%20%C3%A8.txt" "un nome con uno spazio e una lettera accentata
"
(umask 077; printf '%s\n%s\n' "$USER_NAME" "$USER_PASS" > "$WORK/cred")
echo "running nextcloud_test.go against $IMAGE"
docker run --rm --cpus=8 --network "$NET" -v "$DIR:/src" -v gosidian-gomod:/go/pkg/mod -v "$WORK/cred:/cred:ro" -w /src \
	-e STORAGE_TEST_URL="http://$NAME/remote.php/dav/files/$USER_NAME/lab/" -e STORAGE_TEST_CRED=/cred \
	golang:1.27-alpine sh -c 'CGO_ENABLED=0 go test -count=1 -tags nextcloud -run TestNextcloud -v . 2>&1 | grep -vE "^(go: downloading)"'
