# gosidian-plugins

Plugins for the pipelines of [gosidian](https://github.com/daniele-chiappa/gosidian):
MCP servers whose nodes a pipeline uses as `<plugin>.<node>`, or whose
sources the owner binds to a project's IN folder. Each folder
is one plugin with its own image. The contract (the manifest, how a node
is called, the files it gives back) is gosidian's
[`docs/plugins.md`](https://github.com/daniele-chiappa/gosidian/blob/main/docs/plugins.md).

| Plugin | What it does | Image |
|---|---|---|
| [docling](docling/) | `docling.convert`: PDF, DOCX, XLSX, PPTX, HTML, images and the older office formats to markdown, the pictures as files | `ghcr.io/daniele-chiappa/gosidian-docling` (amd64) |
| [pi](pi/) | `<agent>.run`: a pi agent (pi.dev) on a task and its files, in several turns with tools, answering with text or JSON; one container per agent and preset (a local GPU, OpenRouter…) | `ghcr.io/daniele-chiappa/gosidian-pi` (amd64) |
| [storage](storage/) | no nodes: sources for the IN folders (gosidian 2.82), a WebDAV folder (Nextcloud), an S3 bucket, a Google Drive folder or a local one, read with rclone | `ghcr.io/daniele-chiappa/gosidian-storage` (amd64, arm64) |

## Using a plugin

1. Run its container beside gosidian, on a network gosidian reaches.
2. Register it in gosidian's `config.toml` and keep its token in a
   sealed secret:

   ```toml
   [[pipelines.plugins]]
   name = "docling"
   url = "http://gosidian-docling:8000/mcp"
   token_secret = "docling-token"
   ```

   ```bash
   openssl rand -hex 32 | docker exec -i gosidian gosidian secret set docling-token
   ```

   The same token goes to the plugin as `GOSIDIAN_PLUGIN_TOKEN`.
3. Read and accept its manifest:

   ```bash
   docker exec gosidian gosidian plugin show docling
   docker exec gosidian gosidian plugin accept docling <sha>
   ```

## Releases

Each plugin has its own versions and its own `CHANGELOG.md`. A tag
`<plugin>/vX.Y.Z` builds that plugin's image, tries it, pushes it to GHCR
as `:X.Y.Z` and `:latest`, and makes a release whose notes are the
version's section of the changelog.

## Licenses and security

The code is MIT ([LICENSE](LICENSE)). The images hold the works of others
under their own licenses: each plugin's `THIRD_PARTY_NOTICES.md` says
which, and the image carries the texts under `/licenses`.

A security issue goes to a private advisory, not an issue: see
[SECURITY.md](SECURITY.md).
