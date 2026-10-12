# Third-party notices: gosidian-storage

gosidian-storage is MIT-licensed (the `LICENSE` at the root of this
repository). Its image holds one binary, compiled from this folder with
the Go modules it links, on an Alpine Linux base.

## In the binary

- **Go**, its standard library: BSD-3-Clause.
- **[rclone](https://github.com/rclone/rclone)** v1.75.1, which reads the
  stores: MIT.
- About a hundred other Go modules, rclone's and the plugin's (the AWS
  and Google SDKs, the MCP library, YAML…). Their licenses are Apache-2.0,
  MIT, BSD-2-Clause and BSD-3-Clause, and:
  - **MPL-2.0**: `github.com/hashicorp/go-cleanhttp` and
    `github.com/hashicorp/go-retryablehttp`, used unmodified; their source
    is at the versions `/licenses/INDEX` names;
  - **CC0-1.0**: `github.com/zeebo/blake3`.

The image carries the license file of each module, as the build found it
in the module, under `/licenses/<module path>/`, and `/licenses/INDEX`
lists the modules with their versions. `scripts/licenses.sh` makes them
at each build, from the modules the binary links, and stops the build if
one has no license file.

## The base image

[Alpine Linux](https://alpinelinux.org) 3.24, unmodified: busybox,
apk-tools and alpine-baselayout (GPL-2.0), musl (MIT), OpenSSL
(Apache-2.0), zlib, and the CA certificates (MPL-2.0). `apk list -I` in
the image names each package with its license; their sources are
Alpine's ([aports](https://gitlab.alpinelinux.org/alpine/aports), the
3.24 branch).
