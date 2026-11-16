"""Tests of the plugin around docling-rs, with a binary made here that
answers as docling-rs does: python -m unittest test_convert (scripts/test.sh
runs them). The fake writes a DoclingDocument the test built with
docling-core, so they need the server's packages, not the image's binary
and models."""

import asyncio
import base64
import io
import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = tempfile.mkdtemp(prefix="docling-rs-test-")
FAKE = os.path.join(WORK, "docling-rs")
DOC_JSON = os.path.join(WORK, "document.json")
ARGV = os.path.join(WORK, "argv.json")
MODE = os.path.join(WORK, "mode")

# The stand-in: --version, or a conversion that copies the prepared JSON to
# --output-file and leaves its arguments for the test to read. The file
# `mode` makes it fail, or write something that is no document.
with open(FAKE, "w", encoding="utf-8") as f:
    f.write(f"""#!{sys.executable}
import json, shutil, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("docling-rs 9.9.9 (chunking, mcp); ONNX Runtime 1.31")
    sys.exit(0)
json.dump(args, open({ARGV!r}, "w"))
mode = open({MODE!r}).read().strip()
if mode == "fail":
    sys.stderr.write("error: the file is not a PDF\\n")
    sys.exit(2)
out = args[args.index("--output-file") + 1]
if mode == "garbage":
    open(out, "w").write("{{}}")
else:
    shutil.copy({DOC_JSON!r}, out)
""")
os.chmod(FAKE, os.stat(FAKE).st_mode | stat.S_IXUSR)
os.environ["DOCLING_RS_BIN"] = FAKE

sys.path.insert(0, HERE)
import server  # noqa: E402

from docling_core.types.doc import (  # noqa: E402
    BoundingBox,
    ContentLayer,
    DocItemLabel,
    DoclingDocument,
    ImageRef,
    ProvenanceItem,
    Size,
    TableCell,
    TableData,
)


def prov(page, l, t, r, b, n=1):
    return ProvenanceItem(page_no=page, bbox=BoundingBox(l=l, t=t, r=r, b=b), charspan=(0, n))


def picture(color="red", mode="RGB"):
    return ImageRef.from_pil(Image.new(mode, (60, 40), color), dpi=72)


def page_document() -> DoclingDocument:
    """A page as docling.rs lays it out: a heading, a paragraph, a picture
    with four labels inside it, a table."""
    doc = DoclingDocument(name="page")
    doc.add_page(page_no=1, size=Size(width=600, height=800))
    doc.add_heading("Pruning the hedge", prov=prov(1, 50, 50, 300, 70))
    doc.add_text(DocItemLabel.TEXT, "Cut after the first frost.", prov=prov(1, 50, 80, 400, 95))
    pic = doc.add_picture(image=picture(), prov=prov(1, 50, 120, 400, 400))
    for k, word in enumerate(("Top shoot", "Side branch", "Old wood", "Root collar")):
        doc.add_text(DocItemLabel.TEXT, word, parent=pic, prov=prov(1, 60, 140 + 40 * k, 200, 155 + 40 * k))
    cells = [TableCell(text=t, start_row_offset_idx=r, end_row_offset_idx=r + 1, start_col_offset_idx=c, end_col_offset_idx=c + 1,
                       column_header=(r == 0))
             for r, row in enumerate((("Month", "Job"), ("March", "Feed"))) for c, t in enumerate(row)]
    doc.add_table(TableData(num_rows=2, num_cols=2, table_cells=cells), prov=prov(1, 50, 420, 400, 480))
    return doc


def prepare(doc: DoclingDocument, mode="ok", version=None):
    data = json.loads(doc.model_dump_json())
    if version:
        data["version"] = version
    with open(DOC_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f)
    with open(MODE, "w") as f:
        f.write(mode)


def convert(name, doc=None, mode="ok", version=None, **kw):
    if doc is not None:
        prepare(doc, mode, version)
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / name
        path.write_bytes(kw.pop("data", b"%PDF-1.4 not read by the fake"))
        args = dict(ocr=True, pictures=True, max_pages=200, scale=2.0, into=tmp, slides=None, picture_text=True)
        args.update(kw)
        return server.convert_sync(name, path, **args)


def argv():
    with open(ARGV) as f:
        return json.load(f)


class Page(unittest.TestCase):
    def test_markdown_pictures_and_counts(self):
        result, files = convert("hedge.pdf", page_document())
        md = result["markdown"]
        self.assertIn("## Pruning the hedge", md)
        self.assertIn("![](fig-1.png)", md)
        self.assertEqual([n for n, _ in files], ["fig-1.png"])
        self.assertEqual(Image.open(io.BytesIO(files[0][1])).size, (60, 40))
        self.assertEqual((result["pages"], result["tables"], result["title"]), (1, 1, "Pruning the hedge"))
        self.assertEqual(result["pictures"], [{"name": "fig-1.png", "page": 1, "caption": ""}])
        self.assertEqual(result["engine"], "docling-rs 9.9.9")
        self.assertIn("| Month", md)

    def test_the_text_inside_a_picture_comes_under_it(self):
        md = convert("hedge.pdf", page_document())[0]["markdown"]
        at = md.index("fig-1.png")
        for word in ("Top shoot", "Side branch", "Old wood", "Root collar"):
            self.assertGreater(md.index(word), at, word)
        self.assertLess(md.index("Root collar"), md.index("| Month"))
        without = convert("hedge.pdf", page_document(), picture_text=False)[0]["markdown"]
        self.assertNotIn("Side branch", without)
        # An office document's pictures are not pages laid out: nothing under them.
        self.assertNotIn("Side branch", convert("hedge.docx", page_document())[0]["markdown"])

    def test_what_docling_rs_is_asked(self):
        convert("hedge.pdf", page_document(), ocr=False, max_pages=7, scale=1.5)
        got = argv()
        self.assertEqual(got[:4], ["--to", "json", "--images", "embedded"])
        self.assertIn("--no-ocr", got)
        self.assertEqual(got[got.index("--pages") + 1], "1-7")
        self.assertEqual(got[got.index("--images-scale") + 1], "1.5")
        self.assertTrue(got[-1].endswith("/hedge.pdf"))
        convert("hedge.docx", page_document())
        got = argv()
        self.assertNotIn("--no-ocr", got)
        self.assertNotIn("--pages", got)  # only a PDF is cut to its first pages

    def test_no_picture_files_when_not_asked(self):
        result, files = convert("hedge.pdf", page_document(), pictures=False)
        self.assertEqual((files, result["pictures"]), ([], []))
        self.assertIn("Side branch", result["markdown"])

    def test_a_schema_one_step_ahead_is_read(self):
        ours = DoclingDocument.model_fields["version"].default
        major, minor, _ = (int(x) for x in ours.split("."))
        result, _ = convert("hedge.pdf", page_document(), version=f"{major}.{minor + 1}.0")
        self.assertIn("Pruning the hedge", result["markdown"])

    def test_a_cmyk_picture_becomes_a_png(self):
        doc = DoclingDocument(name="p")
        doc.add_page(page_no=1, size=Size(width=600, height=800))
        # A CMYK JPEG, as a Word document stores a print-ready photo.
        buf = io.BytesIO()
        Image.new("CMYK", (30, 20), (0, 200, 200, 0)).save(buf, format="JPEG")
        uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
        doc.add_picture(image=ImageRef(mimetype="image/jpeg", dpi=72, size=Size(width=30, height=20), uri=uri), prov=prov(1, 10, 10, 100, 80))
        _, files = convert("photo.docx", doc)
        self.assertEqual(Image.open(io.BytesIO(files[0][1])).mode, "RGB")

    def test_a_picture_pillow_does_not_read_leaves_the_document(self):
        doc = DoclingDocument(name="p")
        doc.add_page(page_no=1, size=Size(width=600, height=800))
        doc.add_text(DocItemLabel.TEXT, "Before the drawing.")
        # A metafile's bytes under a picture's name, as an old drawing comes.
        uri = "data:image/png;base64," + base64.b64encode(b"\x01\x00\x00\x00 not a picture Pillow knows").decode()
        doc.add_picture(image=ImageRef(mimetype="image/png", dpi=72, size=Size(width=30, height=20), uri=uri))
        with self.assertLogs(server.log, "WARNING"):
            result, files = convert("drawing.docx", doc)
        self.assertEqual(files, [])
        self.assertIn("Before the drawing.", result["markdown"])

    def test_headings_past_the_sixth_level_come_up(self):
        doc = DoclingDocument(name="p")
        doc.add_heading("Deep", level=8)
        md = convert("deep.docx", doc)[0]["markdown"]
        self.assertIn("###### Deep", md)
        self.assertNotIn("####### ", md)


class Slides(unittest.TestCase):
    def deck(self) -> DoclingDocument:
        doc = DoclingDocument(name="deck")
        for n in (1, 2, 3):
            doc.add_page(page_no=n, size=Size(width=960, height=540))
            doc.add_title(f"Bed {n}", prov=prov(n, 40, 30, 900, 80))
            doc.add_text(DocItemLabel.TEXT, f"Sow row {n} in April.", prov=prov(n, 40, 120, 900, 160))
            doc.add_text(DocItemLabel.TEXT, "Allotment Society", prov=prov(n, 40, 500, 400, 520))
            doc.add_text(DocItemLabel.TEXT, f"Mention the frost on bed {n}.\nThen the netting.", prov=prov(n, 0, 0, 1, 1),
                         content_layer=ContentLayer.NOTES)
        return doc

    def test_a_section_per_slide_with_its_notes(self):
        slides = {"notes": True, "slide_label": "Slide", "notes_label": "Notes"}
        result, _ = convert("beds.pptx", self.deck(), slides=slides, data=b"not a deck python-pptx opens")
        md = result["markdown"]
        self.assertIn("## Slide 2 — Bed 2", md)
        self.assertIn("Sow row 2 in April.", md)
        self.assertIn("> **Notes**: Mention the frost on bed 2.\n>\n> Then the netting.", md)
        self.assertNotIn("Allotment Society", md)  # on every slide: a footer
        self.assertEqual((result["title"], result["pages"]), ("Bed 1", 3))

    def test_without_notes_and_with_other_words(self):
        slides = {"notes": False, "slide_label": "Diapositiva", "notes_label": "Note"}
        md = convert("beds.pptx", self.deck(), slides=slides, data=b"x")[0]["markdown"]
        self.assertIn("## Diapositiva 3 — Bed 3", md)
        self.assertNotIn("frost", md)


class Failures(unittest.TestCase):
    def test_docling_rs_fails(self):
        with self.assertRaises(server.ConvertError) as e:
            convert("broken.pdf", page_document(), mode="fail")
        self.assertIn("exit 2", str(e.exception))
        self.assertIn("the file is not a PDF", str(e.exception))

    def test_what_it_wrote_is_no_document(self):
        with self.assertRaises(server.ConvertError) as e:
            convert("odd.pdf", page_document(), mode="garbage")
        self.assertIn("not a document docling-core reads", str(e.exception))

    def test_a_kind_it_does_not_take(self):
        with self.assertRaises(server.ConvertError):
            server.file_name({"name": "movie.mp4"})
        self.assertEqual(server.file_name({"name": "dir/old.DOC"}), "old.DOC")


class Tool(unittest.TestCase):
    def call(self, name, arguments):
        return asyncio.run(server.call_tool(name, arguments))

    def test_the_manifest(self):
        m = self.call("gosidian_manifest", {})
        self.assertEqual((m["name"], m["gosidian"], [n["name"] for n in m["nodes"]]), ("docling-rs", 1, ["convert"]))
        self.assertEqual(m["permissions"], {"files": True, "network": ["gosidian"]})
        settings = m["nodes"][0]["input_schema"]["properties"]
        self.assertNotIn("pdf_backend", settings)
        self.assertNotIn("office", settings)

    def test_a_document_in_base64_comes_back_with_its_pictures(self):
        prepare(page_document())
        data = base64.b64encode(b"%PDF-1.4").decode()
        result = self.call("convert", {"file": {"name": "hedge.pdf", "data": data}, "max_pages": 3})
        self.assertFalse(result.is_error)
        self.assertEqual(result.structured_content["pages"], 1)
        self.assertEqual([c.type for c in result.content], ["text", "resource"])
        self.assertEqual(str(result.content[1].resource.uri), "file:///fig-1.png")
        self.assertEqual(argv()[argv().index("--pages") + 1], "1-3")

    def test_a_failure_is_a_tool_error(self):
        prepare(page_document(), mode="fail")
        result = self.call("convert", {"file": {"name": "hedge.pdf", "data": base64.b64encode(b"x").decode()}})
        self.assertTrue(result.is_error)
        self.assertIn("docling-rs could not convert hedge.pdf", result.content[0].text)
        self.assertTrue(self.call("convert", {"file": {"name": "movie.mp4", "data": "eA=="}}).is_error)


if __name__ == "__main__":
    unittest.main()
