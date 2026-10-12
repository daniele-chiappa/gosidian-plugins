# Changelog: gosidian-docling

The changes of the `docling` plugin, newest first. A tag
`docling/vX.Y.Z` publishes `ghcr.io/daniele-chiappa/gosidian-docling:X.Y.Z`,
and its release notes are its section here.

## [0.3.0] — 2026-10-12

The first public release. Needs gosidian 2.81 or later for files by
reference (2.83 for the pictures linked in the note); the manifest
changes, and the owner accepts it again.

### Added
- **The older office formats** (doc, xls, ppt, rtf, odt, ods, odp) go
  through LibreOffice, headless, with a profile of its own per document.
- **`office`**: documents and presentations (doc, docx, odt, rtf, ppt,
  pptx, odp) go through LibreOffice to PDF by default (`pdf`), which keeps
  a figure made of a picture, arrows and labelled boxes whole; docling's
  Word reader took it apart. Spreadsheets go to xlsx, read as tables.
  `office: native` brings back the docx and pptx readers.
- **`pdf_backend`**: a PDF's text is read with pypdfium2 by default.
  docling-parse read every letter twice in a PDF that draws its bold as
  two strokes; `pdf_backend: docling` brings it back.
- The licenses of the models and of the rest of the image under
  `/licenses` (THIRD_PARTY_NOTICES.md), each model's beside it, and the
  OCI labels of its source, version and license.

### Fixed
- A picture in a table's cell stays on its line: the markdown table no
  longer breaks.

### Notes
- The image is about 600 MB larger, for LibreOffice.

## [0.2.0] — 2026-10-11

### Added
- **The file by reference** (`file_refs`, gosidian 2.81): gosidian hands
  `{name, mime, size, sha256, url}`, and the plugin fetches the file into
  a temporary file while the step runs, up to `DOCLING_MAX_REF_BYTES`
  (512 MiB), checking its size and SHA-256. A file sent in base64, by a
  gosidian before 2.81, works as before up to `DOCLING_MAX_BYTES`.
- The manifest says `file_refs`, and `network: gosidian`, the only address
  the plugin calls.

## [0.1.0] — 2026-10-10

### Added
- The plugin and its node `docling.convert`: PDF, DOCX, XLSX, PPTX, HTML
  and images to markdown with docling on the CPU, the pictures given back
  as PNG files, which gosidian stores as attachments. OCR of scanned pages
  and pictures, a page limit, the pictures' scale.
- The models in the image: no network at run time.
