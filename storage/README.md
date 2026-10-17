# gosidian-storage

A gosidian plugin whose **sources** are remote stores: a WebDAV folder
(Nextcloud, ownCloud, a NAS), an S3 bucket (AWS, Cloudflare R2, Backblaze
B2, Wasabi, Garage…), a Google Drive folder, or a folder of its own disk,
read with [rclone](https://rclone.org) inside the process. The owner binds a source
to a project's IN folder, and its files show there: gosidian lists them,
batches them, hands them to the `in` pipelines and to the plugins by
reference, and reads their bytes, a range at a time, from the URLs this
plugin gives. Nothing lands on gosidian's disk. The contract is
gosidian's `docs/plugins.md`, «Sources», from gosidian 2.82.

The sources and their credentials are in the plugin, never in gosidian:
`storage.yaml` lists the sources, and each WebDAV source names a file of
its own with its user and password. Neither appears in the manifest, the
logs or the answers.

## Sources

```yaml
sources:
  - name: nextcloud              # lower-case letters, digits and _
    kind: webdav
    description: Nextcloud, the folder Fatture
    url: http://nextcloud.lan/remote.php/dav/files/gosidian-storage/Fatture/
    vendor: nextcloud            # nextcloud, owncloud, sharepoint, fastmail, other…
    credentials: /run/secrets/nextcloud   # two lines: the user, the password
    move: true                   # gosidian may move files inside it (done/)
  - name: archive
    kind: s3
    provider: Cloudflare          # AWS (no endpoint), Cloudflare, Wasabi, Ceph, Other…
    endpoint: https://<account>.r2.cloudflarestorage.com
    region: auto
    bucket: archive
    prefix: fatture/2024          # the source's root inside the bucket
    path_style: false
    credentials: /run/secrets/r2  # two lines: the access key, the secret
    presign: true                 # the default: gosidian reads S3 itself
  - name: shared
    kind: drive
    credentials: /run/secrets/drive.json   # a service account's JSON key
    root_folder_id: 1AbC…         # a folder shared with the service account
    # team_drive: 0AbC…           # or a shared drive
    move: true
  - name: scans
    kind: local
    path: /data/scans
```

- **Nextcloud**: the user of the plugin is best a user of its own, with an
  **app password** (with two-factor authentication, a login password
  fails). In the LAN, the server's own address keeps the files off a
  tunnel or a proxy that caps their size.
- **Moves**: with `move: true` and a binding with `--write`, a pipeline
  moves the files it worked on inside the source (`done/` is the source's
  `done/`); the plugin deletes nothing.
- **A refused login**: after a 401 or a 403 (a 401 for Google, whose 403
  is also a rate limit) the source is not asked again for 5 minutes, as a
  server slows down an address after failed logins.

### S3

`open` gives a **presigned URL of S3**, valid as long as a file's link (10
minutes): gosidian reads the bytes from S3 itself, a range at a time, not
through the plugin. The manifest names S3's host in
`permissions.source_hosts` (`<bucket>.<endpoint>`, or the endpoint with
`path_style: true`), which the owner accepts with it; gosidian reads no
file from another host. With `presign: false` the bytes go through the
plugin, as for WebDAV. A file's etag is its MD5 as S3 keeps it, so a move
(on S3 a copy, then a delete) does not make it new.

### Google Drive

> **Not tried yet** (since 0.2.0): the Drive connector is written and its
> configuration tested, but it has not run against a real Drive. Try it
> on a test folder first.

A **service account** of a Google Cloud project reads the folder shared
with its address (`…@….iam.gserviceaccount.com`), or a shared drive it is
a member of; with `move: true` it may move files there (scope `drive`,
else `drive.readonly`). Drive gives each file's MD5 and SHA-256, which
gosidian takes as its version. The **native Google documents** have no
bytes: Docs and Slides come as PDF, which docling reads best, Sheets as
XLSX, as tables. Their size is known only once exported: the list gives
`size: -1`, `open` exports the document to the plugin's `/tmp` (512 MiB at
most, kept while its link lasts) and gives its size (gosidian 2.84).

To make the service account:

1. In the Google Cloud console, a project (or one there is), with the
   **Google Drive API** enabled.
2. *IAM & Admin → Service accounts → Create*: no role is needed. Then
   *Keys → Add key → JSON*: that file is the source's `credentials`.
3. In Drive, share the folder with the service account's address, as
   *Viewer* (or *Editor* for `move: true`). Its ID is the end of its
   address, `…/folders/<ID>`: `root_folder_id`.

## How gosidian reads it

| Tool | |
|---|---|
| `gosidian_manifest` | the sources, by name; `permissions.network`: the hosts of the WebDAV sources |
| `gosidian_source_list` | a page of the files, by path: `path`, `size`, `modified`, `etag` (size and time, which a move keeps). The first page lists the source in full; the pages after it come from that list, kept 10 minutes |
| `gosidian_source_open` | a URL of the plugin, `/files/<ticket>`, for 10 minutes (`STORAGE_LINK_TTL`): a `GET`, ranges too, reads the file from its source as it is read |
| `gosidian_source_move` | a file, or a folder, moved inside the source |

The plugin gives no changes from a cursor: gosidian lists the source in
full at each check (`--every` of the binding, 2 minutes is a good start
for a Nextcloud folder or a Drive folder).

## Running it

```yaml
services:
  gosidian-storage:
    image: ghcr.io/daniele-chiappa/gosidian-storage:0.2.2
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${STORAGE_TOKEN:?}
      STORAGE_PUBLIC_URL: http://gosidian-storage:8000
    volumes:
      - ./storage.yaml:/etc/gosidian-storage/storage.yaml:ro
      - ./secrets/nextcloud:/run/secrets/nextcloud:ro
    read_only: true
    tmpfs: ["/tmp"]
```

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | empty | the bearer token gosidian sends on `/mcp`; empty: none |
| `STORAGE_CONFIG` | `/etc/gosidian-storage/storage.yaml` | the sources |
| `STORAGE_PUBLIC_URL` | `http://gosidian-storage:<port>` | the plugin's address as gosidian reaches it: the URLs of the files start with it, and gosidian reads files only from the plugin's registered host |
| `STORAGE_LINK_TTL` | `10m` | how long a file's URL lasts |
| `PORT` | 8000 | MCP at `/mcp`, the files at `/files/`, `GET /health` without a token |

The image runs as uid 65532: a credentials file of another user (mode
600) wants the container to run as that user (`user:` in the compose
file), or a secret it can read.

Then, in gosidian (2.82 or later):

```toml
[[pipelines.plugins]]
name = "storage"
url = "http://gosidian-storage:8000/mcp"
token_secret = "storage-token"
```

```bash
gosidian plugin show storage
gosidian plugin accept storage <sha>
gosidian plugin bind storage nextcloud archive --as fatture --write --every 2m
```

## Building and testing

```bash
docker build --build-arg VERSION=0.2.2 -t gosidian-storage:0.2.2 storage/
docker run --rm -v "$PWD/storage:/src" -w /src golang:1.27-alpine go test .   # WebDAV, S3 (gofakes3) and a local folder, in-process
storage/scripts/nextcloud-test.sh                                            # against a disposable Nextcloud 34
storage/scripts/s3-test.sh                                                   # against a disposable Garage 2.4 (S3)
```

The image is built for amd64 and arm64 (`docker buildx build --platform
linux/amd64,linux/arm64`), compiled on the build platform without
emulation.

## Licenses

MIT, like gosidian. The image holds the licenses of Go and of every
module compiled into the binary, under `/licenses`: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
