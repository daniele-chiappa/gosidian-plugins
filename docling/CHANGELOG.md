# Changelog: gosidian-docling

The changes of the `docling` plugin, newest first. A tag
`docling/vX.Y.Z` publishes `ghcr.io/daniele-chiappa/gosidian-docling:X.Y.Z`,
and its release notes are its section here.

## [0.4.1] — 2026-10-17

The fonts for Chinese, Japanese and Korean: an office document in these
languages that goes through PDF now shows its characters on the page. The
manifest is the same but for the version.

### Fixed
- **Chinese, Japanese and Korean drawn as empty boxes**: the image had no
  font for them, so LibreOffice drew every character of a doc, docx or
  pptx going to PDF as a box. The text docling read from the PDF was
  right, but the OCR and the pictures saw boxes, and the pages broke
  elsewhere (one manual took 30 pages instead of 35). The image now holds
  the Noto CJK fonts (OFL-1.1, about 170 MB); the build fails if Chinese,
  Japanese, Korean, Arabic, Greek, Cyrillic or Hebrew has no font. Thai
  and the Indic scripts still have none.

## [0.4.0] — 2026-10-17

Presentations slide by slide, with their titles and speaker notes, which
the way through PDF lost. The other formats come out as with 0.3.1, byte
for byte. The manifest changes (four settings), and the owner accepts it
again.

### Added
- **`slides`** (on by default): a presentation (pptx, and ppt and odp,
  which LibreOffice turns into pptx) is read by docling's pptx reader and
  written a section per slide, `## Slide N — title`. The title is the
  slide's title placeholder or, without one, its first line, top to bottom
  and left to right; a first line longer than 150 characters stays in the
  slide. `slides: false` sends a presentation the way `office` says, as
  before.
- **`notes`** (on by default): a slide's speaker notes under it, a quote
  that starts with `**Notes**:`. Through PDF they were lost.
- **`slide_label`** and **`notes_label`**: the words of the heading and of
  the notes, `Slide` and `Notes` by default (`Diapositiva` and `Note del
  relatore` for a deck in Italian).
- A line or a picture on more than half of the slides (a footer drawn as
  a text box, a logo pasted on each) is left out, and so are the footer,
  date and slide number placeholders. docling reads neither the layouts nor
  the masters, so their pictures do not come out either.
- The tests of the slides (`scripts/test.sh`, in the check of every PR):
  decks made with python-pptx, read with docling-slim's pptx reader.

### Changed
- A presentation no longer goes through LibreOffice to PDF by default:
  `office` concerns it only with `slides: false`. Its `title` is its first
  slide's.

## [0.3.1] — 2026-10-15

docling 2.132.0, for its security fixes; nothing else changes, and the
manifest is the same but for the version.

### Security
- docling 2.130.0 → 2.132.0, which fixes, among others: an SSRF guard
  that DNS rebinding could get around when it fetches a document's remote
  resources, and the HTTP headers it sent to every remote image host; a
  TikZ rendering that could read and write files; a document's JSON that
  could embed local image files; plugin entry points imported before the
  check that allows them; table spans and archive members that could
  exhaust the CPU or the memory.
- The packages resolve as PyPI stood on 2026-10-01 (they were on
  2026-09-26), still none younger than two weeks at release.

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
