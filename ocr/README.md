# gosidian-ocr

A gosidian plugin that reads scans and hard PDFs with an OCR vision model,
[MinerU2.5](https://huggingface.co/opendatalab/MinerU2.5-Pro-2605-1.2B)
(1.2B, Apache-2.0), page by page: headings, text, tables, formulas, and the
pictures as PNG files, as `docling.convert` gives them. The model runs in a
server of its own, on a GPU; the plugin holds its client, draws the pages
and writes the markdown.

It is the second converter beside [docling](../docling/), not its
replacement. On a benchmark of 30 pages of manuals and procedures (text
PDFs, scans, Word and slides turned into PDF) the model read 0.93 of the
text of the scans, against 0.89 for docling with its own OCR, and the
cells of the tables of text PDFs at 1.00 against docling's 0.91; docling
finds the headings and the pictures of a text PDF better (1.00 against
0.61 of the headings), and reads a Word document natively far better than
any reader of its PDF. A pipeline asks
`ocr.inspect` and sends a document to one or the other (below).

## Nodes

**`ocr.convert`**: a PDF or an image (png, jpg, tiff, webp) to markdown.

| Setting | | |
|---|---|---|
| `file` | required | the document, a vault path: an attachment or a file of the IN folder |
| `pages` | all | the pages to read, e.g. `"1-3,7"` |
| `max_pages` | 200 | read the first pages only |
| `dpi` | 200 | the resolution a PDF's page is drawn at for the model, as MinerU draws it |
| `pictures` | `true` | give back the pictures and charts as files |
| `charts` | `image` | `table`: a chart also as the table of its data, read by the model |
| `tables` | `html` | `markdown`: a table whose cells span rows or columns as a markdown grid too, a spanned cell's text in every place it covers |
| `paratext` | `false` | keep the page headers, footers, page numbers and margin notes |

Output: `markdown` (a picture is `![caption](fig-N.png)`), `title`, `pages`
(read), `pages_in_file`, `tables`, `pictures` (`name`, `page`, `caption`),
`engine` (`model`, `server`), `empty_pages` (the pages read that gave
nothing: blank, or with nothing the model found on them), `warnings` (what
the plugin changed in the model's output, by page), `seconds`, and from
gosidian `files` (`name`, `path`, `mime`, `markdown`).

`tables: markdown` is for the models that read the converted text: in a
benchmark of answers on the pages of reports, a 12B model answering from
tables with spanned cells in HTML scored 3.15 out of 10, and 5.48 from the
same tables as grids, against 5.94 from the dataset's own markdown. A
header on two rows becomes two rows of the grid, each column with its
whole heading.

`charts: table` gives the data of a chart as the model estimates it
(`~17.2`), not as the document's table would: in the same benchmark it did
not help the answers on charts.

The model gives each page's blocks in reading order, and the plugin
writes them: `doc_title` as `#`, `title` as `##`, `paragraph_title` as
`###` (the model does not number the levels); a paragraph the model marks
as going on from the one before, across a column's or a page's end, joined
to it, a word cut by a hyphen made whole; a table in markdown, or in HTML
when a cell spans rows or columns (unless `tables: markdown`); a formula
between `$$`; a caption with its picture or table; the page headers,
footers and numbers left out. A blank page is not sent: one with no pixel
darker than 250 but a few specks of dust or noise (at most 32, or one in
100,000 pixels).

A model sometimes repeats itself: the same rows of a table or of a chart's
data, over and over, until its tokens run out. A group of up to 50 rows
coming 4 times in a row or more stays once, the rest goes, and `warnings`
says so for its page (blank rows do not count; a table saying a row three
times keeps it).

**`ocr.inspect`**: which pages of a PDF have no text, and whether the
model's server answers; without a file, the server only. It reads the PDF's
text layer with PDFium, without the model.

Output: `server` (`up`, `down`, `unset`), `server_error`, `model`, `pages`,
`pages_without_text` (a page whose text layer holds fewer than 20 letters
and digits: a scan, a photo), `share_without_text` (0 to 1; an image is 1).

## Choosing between ocr and docling

gosidian's expressions have no operators: a `starlark` node decides, and
the converters run on `when` and `unless`. A document goes to the OCR when
half of its pages or more have no text, or when the pipeline forces it;
when the server is off, docling reads it with its own OCR, and the note
says it is to be read again:

```yaml
nodes:
  - id: inspect
    use: ocr.inspect
    with: {file: "{{ trigger.file }}"}
  - id: route
    use: starlark
    with:
      input: {share: "{{ inspect.share_without_text }}", server: "{{ inspect.server }}"}
      code: |
        scan = input["share"] >= 0.5
        output = {"ocr": scan and input["server"] == "up", "later": scan and input["server"] != "up"}
  - id: ocr
    use: ocr.convert
    with: {file: "{{ trigger.file }}"}
    when: "{{ route.ocr }}"
  - id: docling
    use: docling.convert
    with: {file: "{{ trigger.file }}"}
    after: [route]
    unless: "{{ route.ocr }}"
```

## The model's server

Any OpenAI-compatible server that serves MinerU2.5. With llama.cpp's
`llama-server` (the GGUF made by its `convert_hf_to_gguf.py`, with the
projector):

```sh
llama-server -m MinerU2.5-Pro-2605-1.2B-Q8_0.gguf \
  --mmproj mmproj-MinerU2.5-Pro-2605-1.2B-Q8_0.gguf \
  -ngl 99 -c 32768 -np 4 --special \
  --image-min-tokens 64 --image-max-tokens 2048 --api-key-file keys
```

`--special` is required: without it the layout loses its tokens. When the
model finds no layout on any page of a document, the plugin asks it to lay
out a page of text it draws: if it finds none there either, the conversion
fails and says to check `--special`; if it does, the pages were empty, and
they come back in `empty_pages`. The image token limits
reproduce the model's own preprocessing; llama.cpp's default for this
architecture takes 2.5 times as long. Ollama cannot serve it (it never
passes `--special`). vLLM serves the original weights as they are.

Measured on an NVIDIA RTX 4060 Ti 16 GB: 4.4 s a page with 4 requests at
once, 2.0-2.1 GB of VRAM with 4 slots and 32k of context (1.5 GB with one
slot and 8k); on a CPU (6 cores of a Ryzen 7 5700G) about 100 s a page.

## Running it

```yaml
services:
  gosidian-ocr:
    image: ghcr.io/daniele-chiappa/gosidian-ocr:0.2.0
    restart: unless-stopped
    environment:
      GOSIDIAN_PLUGIN_TOKEN: ${OCR_TOKEN:?}
      OCR_SERVER_URL: http://gpu.lan:8082
      OCR_API_KEY: ${OCR_API_KEY:-}
    read_only: true
    tmpfs: ["/tmp:size=1g"]   # a document fetched by reference waits here
    mem_limit: 2g
```

| Variable | Default | |
|---|---|---|
| `GOSIDIAN_PLUGIN_TOKEN` | empty | the bearer token gosidian sends; empty: none |
| `OCR_SERVER_URL` | empty | the model's server; empty: `inspect` says `unset`, `convert` fails |
| `OCR_API_KEY` | empty | its key, sent as a bearer token |
| `OCR_MODEL` | empty | the model's name on the server; empty: the first it lists |
| `OCR_CONCURRENCY` | 4 | requests to the server at once (its slots) |
| `OCR_TIMEOUT` | 300 | seconds a request may take |
| `OCR_MAX_BYTES` | 20 MiB | the largest file sent in base64 |
| `OCR_MAX_REF_BYTES` | 512 MiB | the largest file fetched by reference (keep `/tmp` larger) |
| `OCR_MAX_PAGES` | 200 | the most pages read |
| `OCR_WORKERS` | 1 | documents read at once |
| `OCR_TEXT_MIN_CHARS` | 20 | the letters and digits that make a page one with text |
| `PORT` | 8000 | MCP at `/mcp`, `GET /health` without a token |

The plugin reads no vault. It calls the gosidian address it is handed for
each file and the model's server, as its manifest says (`"permissions":
{"files": true, "network": ["gosidian", "<the server's host>"]}`): another
server is another manifest, which the owner accepts again, `gosidian
plugin show ocr` then `gosidian plugin accept ocr <sha>`. Set gosidian's
`[pipelines] files_url` to the address the plugin reaches it at, as for
docling.

A page goes to the model as an image of 200 dpi, its longer side at most
4000 pixels, eight pages at a time (twice `OCR_CONCURRENCY`): their images
stay in memory meanwhile, about 12 MB a page of A4.

## Limits

- A table cut by a page's end comes out as two tables: the client's merge
  of such tables needs the MinerU program, which the plugin does not use.
- The heading levels are those of the model's three kinds of title, not
  the document's numbering.
- In a text PDF the model finds few of the pictures docling finds.

## Building

```bash
docker build --build-arg VERSION=0.2.0 -t gosidian-ocr:0.2.0 ocr/
```

The image is built for amd64 (about 300 MB: no model, no torch).

## Tests

```bash
sh ocr/scripts/test.sh
```

They draw pages, each block of the layout a rectangle of its own colour,
and run the plugin against a fake model's server that answers a page's
layout by a mark in its corner and a block's content by its colour: the
markdown of every kind of block, a paragraph across two pages, a table in
markdown and in HTML, a table with spanned cells as a grid, the rows a
model repeats, the pictures cut out, PNG, TIFF and PDF pages, a blank page
and one with specks, a page the model finds nothing on, the server down, a
key refused, a server without `--special`, and `inspect` on a PDF with a
text layer.

## Licenses

The plugin's code is MIT, like gosidian. The image holds the model's client
(mineru-vl-utils, Apache-2.0), PDFium and the rest under their own
licenses: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The model is
not in the image; whoever serves it takes its weights under their license.
