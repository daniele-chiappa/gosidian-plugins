#!/bin/sh
# licenses.sh <dir>: copies the license files of what is compiled into
# gosidian-storage, Go and the modules the binary links, to <dir>/<module
# path>/, and lists them in <dir>/INDEX (module, version, files). Run at
# build time in the plugin's folder, after go mod download; a module with
# no license file stops the build.
set -eu
OUT=${1:?the folder to write the licenses to}
mkdir -p "$OUT/go"
cp "$(go env GOROOT)/LICENSE" "$OUT/go/"
echo "go $(go env GOVERSION) LICENSE" > "$OUT/INDEX"
go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}} {{.Dir}}{{end}}{{end}}' . | sort -u |
while read -r path ver dir; do
	files=$(ls "$dir" | grep -iE '^(licen[cs]e|copying|notice|patents)' || true)
	if [ -z "$files" ]; then
		echo "licenses.sh: no license file in $path $ver" >&2
		exit 1
	fi
	mkdir -p "$OUT/$path"
	for f in $files; do
		cp "$dir/$f" "$OUT/$path/"
	done
	echo "$path $ver" $files >> "$OUT/INDEX"
done
