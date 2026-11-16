# Changelog: gosidian-docling-rs

The changes of the `docling-rs` plugin, newest first. A tag
`docling-rs/vX.Y.Z` publishes
`ghcr.io/daniele-chiappa/gosidian-docling-rs:X.Y.Z`, and its release notes
are its section here.

## [0.1.1] — 2026-11-16

### Changed
- **docling.rs 2.82.1** (from 2.80.1). A figure drawn in pieces at the top
  of a PDF page keeps its place in the reading order, and the bullets and
  marks of the Symbol and ZapfDingbats fonts come out as their characters
  (`·`, `→`, `✓`) instead of being dropped or read as private-use codes or
  digits. On our benchmark two documents of 44 change and no figure of the
  table in the README moves.

## [0.1.0] — 2026-11-16

The first version: [docling.rs](https://github.com/docling-project/docling.rs)
2.80.1, the Rust port of docling, as a second converter beside the docling
plugin.

### Added
- **`docling-rs.convert`**: a document (pdf, docx, doc, rtf, odt, xlsx,
  xls, ods, pptx, ppt, odp, html, png, jpg) to markdown, its pictures as
  PNG files. The settings and the output are those of `docling.convert`,
  without `pdf_backend` and `office`, with `engine` in the output: a
  pipeline changes converter by changing the plugin's name.
- What the docling plugin adds to docling's markdown, added the same way
  on docling.rs's document: a presentation slide by slide with its speaker
  notes, the text inside a picture of a page under it (`picture_text`),
  the headings past the sixth level.
- The image: the `docling-rs` binary and its layout, table and OCR models
  from docling.rs's image, by version and digest; Python with docling-core
  for the markdown. About 1.2 GB, no torch, no LibreOffice.

### Known limits
- An old `.doc` gives fewer of its pictures than through LibreOffice, a
  Word figure with drawings over it is not sent through PDF, and a
  metafile (EMF, WMF) comes out without its file: the docling plugin is
  the one for those.
