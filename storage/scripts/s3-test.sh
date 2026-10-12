#!/bin/sh
# Tests the S3 source of gosidian-storage against a disposable Garage
# (an S3 server; MinIO no longer publishes its images).
# Run by hand: it starts Garage, makes its layout, a bucket and a key,
# runs garage_test.go (-tags garage) beside it, then removes everything.
#
#   storage/scripts/s3-test.sh
#   KEEP=1 storage/scripts/s3-test.sh   leave Garage up afterwards
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${IMAGE:-dxflrs/garage:v2.4.1}
NAME=gos-storage-garage
NET=gos-storage-net
WORK=$(mktemp -d)
chmod 755 "$WORK"
cleanup() {
	if [ "${KEEP:-}" = 1 ]; then
		echo "left $NAME up on the network $NET; remove it with: docker rm -f $NAME; docker network rm $NET"
	else
		docker rm -f "$NAME" >/dev/null 2>&1 || true
		docker network rm "$NET" >/dev/null 2>&1 || true
	fi
	rm -f "${WORK:?}/cred" "${WORK:?}/garage.toml"
	rmdir "${WORK:?}"
}
trap cleanup EXIT
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
cat > "$WORK/garage.toml" <<CONF
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"
CONF
chmod 644 "$WORK/garage.toml"
docker run -d --name "$NAME" --network "$NET" -v "$WORK/garage.toml:/etc/garage.toml:ro" "$IMAGE" >/dev/null
g() { docker exec "$NAME" /garage "$@"; }
i=0
until g status >/dev/null 2>&1; do
	i=$((i + 1))
	if [ "$i" -gt 30 ]; then
		docker logs "$NAME" 2>&1 | tail -20 >&2
		exit 1
	fi
	sleep 1
done
NODE=$(g status 2>/dev/null | awk '/^[0-9a-f]{16}/ {print $1; exit}')
g layout assign -z dc1 -c 1G "$NODE" >/dev/null
g layout apply --version 1 >/dev/null
g bucket create lab >/dev/null
# The key: its id and secret to the credentials file, never on the screen.
(umask 077; g key create lab-key 2>/dev/null | awk '/Key ID:/ {id=$NF} /Secret key:/ {sec=$NF} END {print id; print sec}' > "$WORK/cred")
[ "$(wc -l < "$WORK/cred")" = 2 ] || { echo "no key" >&2; exit 1; }
g bucket allow --read --write --owner lab --key lab-key >/dev/null
chmod 644 "$WORK/cred"
echo "running garage_test.go against $IMAGE"
docker run --rm --cpus=8 --network "$NET" -v "$DIR:/src" -v gosidian-gomod:/go/pkg/mod -v "$WORK/cred:/cred:ro" -w /src \
	-e STORAGE_S3_ENDPOINT="http://$NAME:3900" -e STORAGE_S3_CRED=/cred \
	golang:1.27-alpine sh -c 'CGO_ENABLED=0 go test -count=1 -tags garage -run TestGarage -v . 2>&1 | grep -vE "^(go: downloading)"'
