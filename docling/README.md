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
| `office` | `pdf` | documents (and presentations with `slides: false`): through LibreOffice to PDF (`pdf`), or read as docx and pptx (`native`) |
| `slides` | `true` | presentations (pptx, ppt, odp) slide by slide, with their speaker notes; `false`: as `office` says |
| `notes` | `true` | with `slides`: a slide's speaker notes under it |
| `slide_label` | `Slide` | with `slides`: the word before a slide's number in its heading |
| `notes_label` | `Notes` | with `slides`: the word before a slide's speaker notes |

**Office documents** (since 0.3.0): documents (doc, docx, odt, rtf) go
through LibreOffice to PDF, which docling then reads; about a second for a
page. Presentations go slide by slide since 0.4.0 (below), and to PDF too
with `slides: false`. Docling's Word reader takes apart a figure made of a
picture, arrows and labelled boxes (the labels come out as lines of their
own, the picture in pieces), and loses the text of the boxes; the PDF keeps
the figure whole, as the page shows it, and its text is the document's own,
not what a PDF printer drew. Spreadsheets (xls, ods, xlsx) go to xlsx,
which docling reads as tables. `office: native` reads docx (and pptx, with
`slides: false`) as they are and turns the older formats into them. The
image has fonts for Latin, Greek, Cyrillic, Arabic and Hebrew (DejaVu,
Liberation) and for Chinese, Japanese and Korean (Noto CJK, since 0.4.1):
a document in another script (Thai, the Indic ones) comes out of the PDF
with its text right but its page drawn with empty boxes, which the OCR and
the pictures see.

**Presentations** (since 0.4.0): pptx, and ppt and odp turned into pptx by
LibreOffice, are read by docling's pptx reader and written slide by slide,
a section for each:

```markdown
## Slide 2 — Compost results

Three bins were turned weekly.

> **Notes**: Show the photos of the bins.
```

A slide's title is its title placeholder or, without one, its first line
(top to bottom, left to right), which then leaves the slide's text; a first
line longer than 150 characters stays in the text, and the heading has the
number alone. The speaker notes follow, a quote whose paragraphs are the
notes' (`notes: false` leaves them out). `slide_label` and `notes_label`
are the words of the heading and of the notes, `Diapositiva` and `Note del
relatore` for a deck in Italian; empty, the heading is the number and the
title, and the notes have no word before them. A line, or a picture, on
more than half of the slides (of three or more) is a footer or a logo and
is left out, with the footer, date and slide number placeholders; docling
reads neither the layouts nor the masters, so their pictures do not come
out. The slide's own pictures, tables and charts (their data, as a table)
come as in a document; `pages` counts the slides, and a picture's `page` is
its slide. Through PDF the notes were lost, the slides ran on without a
break, and a title not in a title placeholder was not one; a slide whose
figure is drawn with shapes and arrows keeps it whole only through PDF
(`slides: false`). With no models to run, a deck of ten slides takes under
a second where the PDF took two minutes.

**PDF text** (since 0.3.0): read with pypdfium2 by default. docling-parse
reads every letter twice in a PDF that draws its bold as two strokes
(«C CA AR RB BU UR RA AZ ZI IO ON NE»), which some PDF printers do; on 21
procedures it gave 33 such lines, pypdfium2 one, with the same tables and
headings. `pdf_backend: docling` brings docling-parse back for a document.

Output: `markdown` (a picture is `![caption](fig-N.png)`; in a table's
cell, on its line), `title` (of a presentation, its first slide's),
`pages` (of a presentation, its slides), `tables`, `pictures` (`name`,
`page`, `caption`), and from gosidian `files` (`name`, `path`, `mime`,
`markdown`).

## Running it

```yaml
services:
  gosidian-docling:
    image: ghcr.io/daniele-chiappa/gosidian-docling:0.4.1
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

Versions 0.2.0 (`file_refs`, `network`), 0.3.0 (`pdf_backend`,
`office`, the office kinds) and 0.4.0 (`slides`, `notes`, `slide_label`,
`notes_label`) change the manifest: the owner accepts it again, `gosidian
plugin show docling` then `gosidian plugin accept docling <sha>`. The
image of 0.3.0 is about 600 MB larger, for LibreOffice.

## Building

```bash
docker build --build-arg VERSION=0.4.1 -t gosidian-docling:0.4.1 docling/
```

The image is built for amd64 only (about 5 GB: torch on the CPU, the
models and LibreOffice).

## Tests

```bash
sh docling/scripts/test.sh
```

They make decks with python-pptx and read them slide by slide, in
`python:3.12-slim` with docling's pptx reader (`docling-slim`) at the
image's versions, not the image: titles, notes, footers, logos, a chart and
the labels.

## Licenses

The plugin's code is MIT, like gosidian. The image holds docling, its
models, torch, LibreOffice and the rest under their own licenses, among
them the CDLA-Permissive-2.0 of the table model: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The texts are in the
image under `/licenses`, and each model's beside it.
