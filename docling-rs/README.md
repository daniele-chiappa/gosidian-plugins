# gosidian-docling-rs

A gosidian plugin that turns documents into markdown with
[docling.rs](https://github.com/docling-project/docling.rs), the Rust port
of docling: PDF, Word, Excel, PowerPoint, the older `doc`, `xls` and `ppt`,
RTF, OpenDocument, HTML and images, with the pictures they hold as PNG
files, as `docling.convert` gives them.

It is a second converter beside [docling](../docling/), to choose in a
pipeline, not its replacement. It has the same node, the same settings but
two, and the same output: a pipeline changes converter by changing
`docling.convert` into `docling-rs.convert`. What the docling plugin adds
to docling's markdown is added here the same way: a presentation slide by
slide with its speaker notes, the text inside a picture of a page right
under it, the headings past markdown's sixth level.

Why a second one: the image is about 1.2 GB against docling's 5 GB, with no
torch and no LibreOffice, and a document takes a fraction of the time. On
our benchmark of 30 pages and 14 office documents (manuals and procedures:
text PDFs, scans, Word, Excel and slides) the whole run took 60 s against
303 s, at most 1.3 GB of memory (1.7 GB with OCR), and read:

| | docling-rs 0.1.1 (docling.rs 2.82.1) | docling 0.5.6 (docling 2.138) |
|---|---|---|
| text PDFs: text / tables | 0.96 / 0.83 | 0.97 / 0.88 |
| scans, with OCR: text | 0.94 | 0.89 |
| Word read as a file: text / headings / tables | 0.98 / 0.81 / 0.98 | 0.99 / 0.81 / 1.00 |
| old `.doc` read as a file: headings / pictures found | 0.90 / 0.40 | 0.74 / 0.83 |
| slides: speaker notes | 1.00 | 1.00 |
| Excel: cells | 0.94 | 0.94 |

1 is the reference page. The figures are means over few pages, a guide
rather than a guarantee.

## Where docling is still the one to use

- **Old `.doc` files with many pictures.** docling.rs reads a `.doc`
  itself and finds fewer of its pictures than LibreOffice does (the row
  above). The docling plugin turns it into docx first.
- **Word figures with drawings over them** (arrows, callouts, text boxes on
  a picture). The docling plugin sends such a document through PDF, which
  keeps the figure whole (`office: auto`); this plugin has no LibreOffice,
  and reads the document as it is.
- **Metafiles** (EMF, WMF) inside an office document come out without their
  file: the document is converted, the picture is not.

docling.rs is a young project that moves fast; the plugin pins one version
of it, and each new one is measured before the plugin takes it.

## The node

**`docling-rs.convert`**: a document to markdown.

| Setting | | |
|---|---|---|
| `file` | required | the document, a vault path: an attachment or a file of the IN folder |
| `ocr` | `true` | read the text of scanned pages and pictures |
| `pictures` | `true` | give back the pictures as PNG files |
| `max_pages` | 200 | a PDF: convert the first pages only |
| `images_scale` | 2.0 | the pictures' scale, 1 = 72 dpi |
| `picture_text` | `true` | the text found inside a picture of a page (pictograms and their labels, a diagram's words) right under it |
| `slides` | `true` | presentations slide by slide: a section per slide, titled, with its speaker notes; footers and pictures on more than half the slides left out |
| `notes` | `true` | with `slides`: a slide's speaker notes under it |
| `slide_label`, `notes_label` | `Slide`, `Notes` | with `slides`: the words before a slide's number and before its notes |

The docling plugin's `pdf_backend` and `office` are not here: docling.rs
has one PDF reader, which reads a text drawn twice for its shadow once, and
there is no LibreOffice to choose a way through.

Output: `markdown` (a picture is `![caption](fig-N.png)`), `title`,
`pages`, `tables`, `pictures` (`name`, `page`, `caption`), `engine` (the
docling-rs that read it), and from gosidian `files` (`name`, `path`,
`mime`, `markdown`).

Formats: pdf, docx, doc, rtf, odt, xlsx, xls, ods, pptx, ppt, odp, html,
png, jpg.

## How it works

The image holds the `docling-rs` binary and its models (layout,
TableFormer, PP-OCR), copied from docling.rs's own image at a pinned
version and digest. For each document the plugin runs one `docling-rs`
process, which writes docling's JSON, a `DoclingDocument`; the plugin loads
it with docling-core and writes the markdown from it. The process ends with
the document: its memory goes back, and a document that breaks the reader
breaks nothing else. Nothing is fetched at run time but the document, from
gosidian.

## Running it

```yaml
services:
  docling-rs:
    image: ghcr.io/daniele-chiappa/gosidian-docling-rs:0.1.1
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${DOCLING_RS_TOKEN}
    read_only: true
    tmpfs: ["/tmp:size=2g"]
    mem_limit: 4g
```

and in gosidian's `config.toml`:

```toml
[[pipelines.plugins]]
name = "docling-rs"
url = "http://docling-rs:8000/mcp"
token_secret = "docling-rs-token"
timeout = "30m"
```

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | none | the bearer token gosidian sends |
| `CONVERT_MAX_BYTES` | 20 MiB | the largest document sent in base64 |
| `CONVERT_MAX_REF_BYTES` | 512 MiB | the largest document fetched by reference |
| `CONVERT_MAX_PAGES` | 200 | the most pages of a PDF converted |
| `CONVERT_WORKERS` | 1 | conversions at once |
| `CONVERT_TIMEOUT` | 900 | seconds docling-rs may take on a document |
| `PORT` | 8000 | |

docling-rs reads its own variables too (its README lists them): the image
sets the models' folder and the fonts.

## Tests

`sh scripts/test.sh` runs `test_convert.py` in `python:3.12-slim` with the
server's packages: a stand-in made by the tests answers as docling-rs does,
with documents built with docling-core, so they need neither the binary nor
the models.

## Licenses

The plugin is MIT. What its image holds, docling.rs and its models among
them, is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
