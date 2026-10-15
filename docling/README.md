# gosidian-docling

A gosidian plugin that converts documents to markdown with
[docling](https://github.com/docling-project/docling), on the CPU. Its
one node, `docling.convert`, takes a file of the pipeline's project (an
attachment, or a file of its IN folder) and gives back its markdown; the
pictures come back as PNG files, which gosidian stores as attachments.

The node takes its file by reference (`file_refs`, gosidian 2.81): gosidian
hands it `{name, mime, size, sha256, url}`, and the plugin fetches the
file from that address while the step runs, checking its size and its
SHA-256. A document of any size up to `DOCLING_MAX_REF_BYTES` goes this
way, a file of the IN folder too. A gosidian before 2.81 sends the file in
base64, which works as before, up to `DOCLING_MAX_BYTES`.

| Setting | | |
|---|---|---|
| `file` | required | the document, a vault path: an attachment or a file of the IN folder (pdf, docx, xlsx, pptx, html, png, jpg, doc, xls, ppt, rtf, odt, ods, odp) |
| `ocr` | `true` | read the text of scanned pages and pictures |
| `pictures` | `true` | give back the pictures as files |
| `max_pages` | 200 | convert the first pages only |
| `images_scale` | 2 | the pictures' scale (1 = 72 dpi) |
| `pdf_backend` | `pypdfium` | how a PDF's text is read: `pypdfium` (pypdfium2) or `docling` (docling-parse) |
| `office` | `pdf` | documents and presentations: through LibreOffice to PDF (`pdf`), or read as docx and pptx (`native`) |

**Office documents** (since 0.3.0): documents and presentations (doc,
docx, odt, rtf, ppt, pptx, odp) go through LibreOffice to PDF, which
docling then reads; about a second for a page. Docling's Word reader takes
apart a figure made of a picture, arrows and labelled boxes (the labels
come out as lines of their own, the picture in pieces), and loses the text
of the boxes; the PDF keeps the figure whole, as the page shows it, and its
text is the document's own, not what a PDF printer drew. Spreadsheets
(xls, ods, xlsx) go to xlsx, which docling reads as tables.
`office: native` reads docx and pptx as they are and turns the older
formats into them.

**PDF text** (since 0.3.0): read with pypdfium2 by default. docling-parse
reads every letter twice in a PDF that draws its bold as two strokes
(«C CA AR RB BU UR RA AZ ZI IO ON NE»), which some PDF printers do; on 21
procedures it gave 33 such lines, pypdfium2 one, with the same tables and
headings. `pdf_backend: docling` brings docling-parse back for a document.

Output: `markdown` (a picture is `![caption](fig-N.png)`; in a table's
cell, on its line), `title`,
`pages`, `tables`, `pictures` (`name`, `page`, `caption`), and from
gosidian `files` (`name`, `path`, `mime`, `markdown`).

## Running it

```yaml
services:
  gosidian-docling:
    image: ghcr.io/daniele-chiappa/gosidian-docling:0.3.1
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${DOCLING_TOKEN:?}
    read_only: true
    tmpfs: ["/tmp:size=1g"]   # a document fetched by reference, and LibreOffice's work, wait here
    mem_limit: 6g
```

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | empty | the bearer token gosidian sends; empty: none |
| `DOCLING_MAX_BYTES` | 20 MiB | the largest document sent in base64 |
| `DOCLING_MAX_REF_BYTES` | 512 MiB | the largest document fetched by reference (keep `/tmp` larger) |
| `DOCLING_MAX_PAGES` | 200 | the most pages converted |
| `DOCLING_WORKERS` | 1 | documents converted at once (each takes 2-4 GB of memory) |
| `DOCLING_OFFICE_TIMEOUT` | 120 | seconds LibreOffice may take on a document |
| `PORT` | 8000 | MCP at `/mcp`, `GET /health` without a token |

The models are in the image. The plugin reads no vault and calls nothing
but the gosidian address it is handed for each file, as its manifest says
(`"permissions": {"files": true, "network": ["gosidian"]}`). On the network
of a compose file, set gosidian's `[pipelines] files_url` (or
`GOSIDIAN_PIPELINES_FILES_URL`) to the address the plugin reaches it at,
`http://gosidian:8080`: the files then go straight from one container to
the other, not through a proxy in front of gosidian.

Versions 0.2.0 (`file_refs`, `network`) and 0.3.0 (`pdf_backend`,
`office`, the office kinds) change the manifest: the owner accepts it again, `gosidian
plugin show docling` then `gosidian plugin accept docling <sha>`. The
image of 0.3.0 is about 600 MB larger, for LibreOffice.

## Building

```bash
docker build --build-arg VERSION=0.3.1 -t gosidian-docling:0.3.1 docling/
```

The image is built for amd64 only (about 5 GB: torch on the CPU, the
models and LibreOffice).

## Licenses

The plugin's code is MIT, like gosidian. The image holds docling, its
models, torch, LibreOffice and the rest under their own licenses, among
them the CDLA-Permissive-2.0 of the table model: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The texts are in the
image under `/licenses`, and each model's beside it.
