# Changelog: gosidian-ocr

The changes of the `ocr` plugin, newest first. A tag `ocr/vX.Y.Z`
publishes `ghcr.io/daniele-chiappa/gosidian-ocr:X.Y.Z`, and its release
notes are its section here.

## [0.1.0] — 2026-10-18

The first version: scans and hard PDFs to markdown with an OCR vision
model, MinerU2.5, served apart, beside docling.

### Added
- **`ocr.convert`**: a PDF or an image (png, jpg, tiff, webp) to markdown,
  page by page, with the model's two steps (the page's layout, then each
  block's content) through its client, mineru-vl-utils 2.0.5 (Apache-2.0);
  the MinerU program is not used. Headings, text, lists, tables (markdown,
  or HTML when a cell spans), formulas, code, captions with their picture
  or table; a paragraph cut by a column's or a page's end joined; the
  pictures and charts cut out as PNG files; page headers, footers and
  numbers left out (`paratext` keeps them); blank pages not sent. `pages`,
  `max_pages`, `dpi`, `pictures`, `charts` (`table`: a chart's data too).
- **`ocr.inspect`**: a PDF's pages without text and their share, read from
  its text layer, and whether the model's server answers: for a pipeline
  to choose between ocr and docling, or to wait for the server.
- The model's server is any OpenAI-compatible one that serves MinerU2.5
  (`OCR_SERVER_URL`, `OCR_API_KEY`, `OCR_MODEL`); its host is in the
  manifest's `network`. A server that drops the layout's tokens
  (llama-server without `--special`) is told apart from a page without
  text.
- On the 30 pages of a benchmark of manuals and procedures, the same
  fidelity as the MinerU program on the same model (text 0.90, table cells
  0.91 against 0.94 and 0.92), at 4.4 s a page on a 16 GB GPU.
- The client's logs at debug hold the model's answers, the documents'
  text: only its warnings come through, a line each.
