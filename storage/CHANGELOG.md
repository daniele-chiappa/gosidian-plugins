# Changelog: gosidian-storage

The changes of the `storage` plugin, newest first. A tag
`storage/vX.Y.Z` publishes `ghcr.io/daniele-chiappa/gosidian-storage:X.Y.Z`,
and its release notes are its section here.

## [0.2.1] — 2026-10-12

The first public release: 0.2.0 with gRPC's fix. Needs gosidian 2.82 or
later (2.84 for the native Google documents).

### Security
- **google.golang.org/grpc** to `v1.84.0-dev.0.20260825144003-d5a41119e0e3`
  ([GHSA-2v4p-qf9q-27wj](https://github.com/advisories/GHSA-2v4p-qf9q-27wj),
  a crash of an xDS server on a request without `:authority` and `Host`).
  The plugin runs no gRPC server: the module comes with the Google
  clients.

## [0.2.0] — 2026-10-12

S3 and Google Drive besides WebDAV and local folders.

### Added
- **S3** (`kind: s3`: AWS, Cloudflare R2, Backblaze B2, Wasabi, Garage…):
  the bucket and a prefix as the source's root, the access key and secret
  in a credentials file. `open` gives a **presigned URL of S3**, so
  gosidian reads the bytes from S3 itself; the manifest names S3's host in
  `permissions.source_hosts`. With `presign: false` the bytes go through
  the plugin. A refused key waits 5 minutes, as on WebDAV.
- **Google Drive** (`kind: drive`): a service account's JSON key, a folder
  shared with it (`root_folder_id`) or a shared drive (`team_drive`).
  Native Google documents come as PDF (Docs, Slides) or XLSX (Sheets),
  exported when opened so their size is known. A refused key waits 5
  minutes after a 401 (Google's 403 is also a rate limit). **Not tried
  yet against a real Drive**: try it on a test folder first.
- On S3 and Drive a file's etag is the MD5 the store keeps, so a move
  does not make it new; Drive gives the SHA-256 too.
- The image for **amd64 and arm64**, with the licenses of Go and of every
  module in the binary under `/licenses` (THIRD_PARTY_NOTICES.md), and
  the OCI labels of its source, version and license.

### Changed
- The base image is Alpine 3.24, and nothing runs in it at build time.

## [0.1.0] — 2026-10-12

### Added
- The plugin, with no nodes: the **sources** of gosidian 2.82, read with
  rclone v1.75.1 inside the process. A WebDAV folder (Nextcloud,
  ownCloud, SharePoint, Fastmail…) or a local folder, listed in
  `storage.yaml`, with each WebDAV source's user and password in a file of
  its own that never leaves the plugin.
- The list is paged from one full walk; a file's etag is its size and
  time, which a move keeps.
- `open` gives a URL of the plugin that reads the file from its source a
  range at a time; moves of files and folders stay inside the source.
- A source that refuses its credentials is not asked again for 5
  minutes.
