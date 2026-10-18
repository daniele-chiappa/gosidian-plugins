"""Tests of the OCR plugin against a fake model's server.

The pages are drawn here: white, with a coloured mark in the top left corner
that names the page, and a block of the layout as a rectangle of its own
colour. The fake server answers the layout request of a page by its mark,
and the content request of a block by the colour at its middle, as the
model would answer with its text: no GPU and no model, and nothing of a
real document.
"""

from __future__ import annotations

import base64
import http.server
import io
import json
import os
import socket
import threading
import unittest

import anyio
from PIL import Image, ImageDraw


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


W, H = 1000, 1400

# The pages: their mark's colour, and their blocks: kind, box (0-1000 of the
# page), colour, and what the model says of it ("" for a picture: the model
# is not asked).
PAGES = {
    "one": {
        "mark": (255, 0, 0),
        "blocks": [
            ("header", (100, 20, 900, 40), (200, 200, 0), "Manual of the pump"),
            ("doc_title", (100, 60, 900, 100), (0, 0, 200), "Pump maintenance"),
            ("text", (100, 120, 900, 180), (0, 120, 0), "The pump must be checked every week."),
            ("image", (100, 200, 500, 400), (120, 0, 120), ""),
            ("image_caption", (100, 405, 500, 425), (0, 120, 120), "Figure 1: the pump"),
            ("table_caption", (100, 450, 900, 470), (90, 60, 30), "Table 1: parts"),
            ("table", (100, 480, 900, 600), (30, 60, 90),
             "<table><tr><td>Part</td><td>Count</td></tr><tr><td>Valve | inlet</td><td>2</td></tr></table>"),
            ("text", (100, 620, 900, 680), (60, 90, 30), "The check takes ten minu-"),
            ("page_number", (480, 960, 520, 980), (150, 150, 150), "1"),
        ],
    },
    "two": {
        "mark": (0, 255, 0),
        "blocks": [
            ("header", (100, 20, 900, 40), (200, 200, 0), "Manual of the pump"),
            ("text", (100, 60, 900, 100), (100, 30, 60), "tes and needs no tools.", "contd"),
            ("title", (100, 120, 900, 150), (30, 100, 60), "Safety"),
            ("text", (100, 160, 900, 200), (60, 30, 100), "• Wear gloves."),
            ("equation", (100, 220, 900, 260), (10, 80, 160), "E = m c^2"),
            ("table", (100, 280, 900, 400), (160, 80, 10),
             '<table><tr><td colspan="2">Torque</td></tr><tr><td>M8</td><td>25 Nm</td></tr></table>'),
            ("footer", (100, 960, 900, 980), (180, 120, 60), "Rev. 2"),
        ],
    },
}

PALETTE = {}
for _key, _page in PAGES.items():
    for _b in _page["blocks"]:
        PALETTE[_b[2]] = _b[3]
MARKS = {p["mark"]: k for k, p in PAGES.items()}


def draw(key: str) -> Image.Image:
    page = PAGES[key]
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, 40, 40), fill=page["mark"])
    for b in page["blocks"]:
        x1, y1, x2, y2 = b[1]
        d.rectangle((x1 * W / 1000, y1 * H / 1000, x2 * W / 1000 - 1, y2 * H / 1000 - 1), fill=b[2])
    return img


def layout(key: str) -> str:
    out = ""
    for b in PAGES[key]["blocks"]:
        x1, y1, x2, y2 = b[1]
        tail = "<|txt_contd_tgt|>" if len(b) > 4 else ""
        out += f"<|box_start|>{x1:03d} {y1:03d} {x2:03d} {y2:03d}<|box_end|><|ref_start|>{b[0]}<|ref_end|><|rotate_up|>{tail}\n"
    return out


def nearest(colour, choices):
    return min(choices, key=lambda c: sum((a - b) ** 2 for a, b in zip(c, colour)))


class Fake:
    key = "k"
    mode = "ok"  # "nospecial": the layout without its tokens, as llama-server without --special
    requests = 0


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self) -> bool:
        if self.headers.get("Authorization") != f"Bearer {Fake.key}":
            self.reply(401, {"error": "invalid api key"})
            return False
        return True

    def do_GET(self):
        if self.path == "/v1/models" and self.authorized():
            self.reply(200, {"object": "list", "data": [{"id": "MinerU-test", "object": "model"}]})
        elif self.path != "/v1/models":
            self.reply(404, {})

    def do_POST(self):
        if not self.authorized():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Fake.requests += 1
        texts, image = [], None
        for m in body["messages"]:
            parts = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
            for p in parts:
                if p.get("type") == "text":
                    texts.append(p["text"])
                elif p.get("type") == "image_url":
                    image = Image.open(io.BytesIO(base64.b64decode(p["image_url"]["url"].split(",", 1)[1]))).convert("RGB")
        prompt = " ".join(texts)
        if "Layout Detection" in prompt:
            key = MARKS[nearest(image.getpixel((2, 2)), MARKS)]
            text = layout(key) if Fake.mode == "ok" else "Pump maintenance\nThe pump must be checked every week."
        else:
            text = PALETTE[nearest(image.getpixel((image.width // 2, image.height // 2)), PALETTE)]
        self.reply(200, {"id": "x", "object": "chat.completion", "model": body.get("model"),
                         "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text + "<|im_end|>"}}]})


PORT = free_port()
_httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=_httpd.serve_forever, daemon=True).start()
os.environ["OCR_SERVER_URL"] = f"http://127.0.0.1:{PORT}"
os.environ["OCR_API_KEY"] = Fake.key
os.environ.pop("OCR_MODEL", None)

import server  # noqa: E402  (reads its settings from the environment)


def as_file(name: str, data: bytes) -> dict:
    return {"name": name, "data": base64.b64encode(data).decode()}


def png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def call(tool: str, args: dict):
    return anyio.run(server.call_tool, tool, args)


def tiny_pdf(texts: list[str | None]) -> bytes:
    """A PDF whose pages hold these lines of text in its text layer (None:
    an empty page)."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for t in texts:
        stream = f"BT /F1 12 Tf 72 720 Td ({t}) Tj ET" if t else ""
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {len(objs)} 0 R >>")
        kids.append(len(objs))
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"
    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{o}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


class Base(unittest.TestCase):
    def setUp(self):
        Fake.mode, Fake.requests = "ok", 0
        self.url, self.key = server.SERVER_URL, server.API_KEY

    def tearDown(self):
        server.SERVER_URL, server.API_KEY = self.url, self.key

    def convert(self, name: str, data: bytes, **settings):
        r = call("convert", {"file": as_file(name, data), **settings})
        self.assertFalse(r.is_error, r.content[0].text if r.content else r)
        files = {c.resource.uri.rsplit("/", 1)[-1]: base64.b64decode(c.resource.blob) for c in r.content[1:]}
        return r.structured_content, files

    def error(self, tool: str, args: dict) -> str:
        r = call(tool, args)
        self.assertTrue(r.is_error)
        return r.content[0].text


class ManifestTest(Base):
    def test_the_manifest(self):
        m = call("gosidian_manifest", {})
        self.assertEqual(m["name"], "ocr")
        self.assertEqual([n["name"] for n in m["nodes"]], ["convert", "inspect"])
        self.assertTrue(all(n["file_refs"] and n["files"] == ["file"] for n in m["nodes"]))
        self.assertEqual(m["permissions"], {"files": True, "network": ["gosidian", "127.0.0.1"]})


class ConvertTest(Base):
    def test_a_page(self):
        out, files = self.convert("page.png", png(draw("one")))
        md = out["markdown"]
        self.assertTrue(md.startswith("# Pump maintenance\n\nThe pump must be checked every week.\n\n![Figure 1: the pump](fig-1.png)\n\nFigure 1: the pump\n\nTable 1: parts\n\n| Part | Count |\n|---|---|\n| Valve \\| inlet | 2 |\n"), md)
        self.assertNotIn("Manual of the pump", md)  # the header
        self.assertNotIn("\n1\n", md)  # the page number
        self.assertEqual((out["pages"], out["pages_in_file"], out["tables"], out["title"]), (1, 1, 1, "Pump maintenance"))
        self.assertEqual(out["pictures"], [{"name": "fig-1.png", "page": 1, "caption": "Figure 1: the pump"}])
        self.assertEqual(out["engine"], {"model": "MinerU-test", "server": "127.0.0.1"})
        fig = Image.open(io.BytesIO(files["fig-1.png"]))
        self.assertEqual(fig.size, (400, 280))
        self.assertEqual(fig.convert("RGB").getpixel((200, 140)), (120, 0, 120))

    def test_the_furniture_on_request(self):
        out, _ = self.convert("page.png", png(draw("one")), paratext=True)
        self.assertTrue(out["markdown"].startswith("Manual of the pump\n\n# Pump maintenance"), out["markdown"])

    def test_pages_of_a_tiff(self):
        buf = io.BytesIO()
        draw("one").save(buf, format="TIFF", save_all=True, append_images=[draw("two")])
        out, files = self.convert("scan.tiff", buf.getvalue())
        md = out["markdown"]
        # The paragraph cut at the page's end, its word joined.
        self.assertIn("\n\nThe check takes ten minutes and needs no tools.\n\n## Safety\n\n- Wear gloves.\n\n$$\nE = m c^2\n$$\n\n<table>", md)
        self.assertIn('<td colspan="2">Torque</td>', md)  # a merged cell: the HTML kept
        self.assertNotIn("Rev. 2", md)
        self.assertEqual((out["pages"], out["tables"], len(files)), (2, 2, 1))

    def test_a_pdf_of_scans_and_a_page_of_it(self):
        buf = io.BytesIO()
        draw("one").save(buf, format="PDF", save_all=True, append_images=[draw("two")], resolution=100)
        out, _ = self.convert("scan.pdf", buf.getvalue())
        self.assertIn("The check takes ten minutes and needs no tools.", out["markdown"])
        self.assertEqual(out["pages"], 2)
        out, files = self.convert("scan.pdf", buf.getvalue(), pages="2")
        self.assertTrue(out["markdown"].startswith("tes and needs no tools.\n\n## Safety"), out["markdown"])
        self.assertEqual((out["pages"], out["pages_in_file"], files), (1, 2, {}))

    def test_without_pictures(self):
        out, files = self.convert("page.png", png(draw("one")), pictures=False)
        self.assertEqual((files, out["pictures"]), ({}, []))
        self.assertIn("pump must be checked every week.\n\nFigure 1: the pump\n\nTable 1", out["markdown"])

    def test_a_blank_page_is_not_sent(self):
        out, _ = self.convert("blank.png", png(Image.new("RGB", (W, H), "white")))
        self.assertEqual((out["markdown"], Fake.requests), ("", 0))

    def test_a_server_without_special(self):
        Fake.mode = "nospecial"
        text = self.error("convert", {"file": as_file("page.png", png(draw("one")))})
        self.assertIn("--special", text)

    def test_the_server_down(self):
        server.SERVER_URL = f"http://127.0.0.1:{free_port()}"
        text = self.error("convert", {"file": as_file("page.png", png(draw("one")))})
        self.assertIn("server is not available", text)
        self.assertIn("does not answer", text)

    def test_a_key_refused(self):
        server.API_KEY = "wrong"
        text = self.error("convert", {"file": as_file("page.png", png(draw("one")))})
        self.assertIn("refuses the key", text)

    def test_pages_out_of_the_file(self):
        self.assertIn("the file has 1 page", self.error("convert", {"file": as_file("page.png", png(draw("one"))), "pages": "2"}))
        self.assertIn("page numbers and ranges", self.error("convert", {"file": as_file("page.png", png(draw("one"))), "pages": "two"}))

    def test_a_kind_it_does_not_read(self):
        self.assertIn("the OCR plugin reads", self.error("convert", {"file": as_file("notes.docx", b"PK")}))

    def test_settings_out_of_the_schema(self):
        self.assertIn("Input validation error", anyio.run(server.on_call_tool, None, _Params("convert", {"file": as_file("p.png", b"x"), "dpi": 1000})).content[0].text)


class _Params:
    def __init__(self, name, arguments):
        self.name, self.arguments = name, arguments


class InspectTest(Base):
    def test_a_pdf_with_a_text_page_and_an_empty_one(self):
        out = call("inspect", {"file": as_file("mixed.pdf", tiny_pdf(["Ten words of text on the first page of this file", None]))})
        self.assertEqual(out, {"server": "up", "model": "MinerU-test", "pages": 2, "pages_without_text": [2], "share_without_text": 0.5})

    def test_an_image_has_no_text(self):
        out = call("inspect", {"file": as_file("page.png", png(draw("one")))})
        self.assertEqual((out["pages"], out["pages_without_text"], out["share_without_text"]), (1, [1], 1.0))

    def test_the_server_only(self):
        self.assertEqual(call("inspect", {}), {"server": "up", "model": "MinerU-test"})
        server.SERVER_URL = f"http://127.0.0.1:{free_port()}"
        out = call("inspect", {})
        self.assertEqual(out["server"], "down")
        server.SERVER_URL = ""
        self.assertEqual(call("inspect", {})["server"], "unset")


class MarkdownTest(unittest.TestCase):
    def test_joins(self):
        self.assertEqual(server.joins("ten minu-", "tes"), "ten minutes")
        self.assertEqual(server.joins("well-", "Known"), "well- Known")
        self.assertEqual(server.joins("中文", "测试"), "中文测试")
        self.assertEqual(server.joins("end of", "line"), "end of line")

    def test_a_table_with_a_picture_in_a_cell(self):
        dot = base64.b64encode(png(Image.new("RGB", (8, 8), (1, 2, 3)))).decode()
        named = []
        md = server.table_markdown(f'<table><tr><td>Icon</td><td><img src="data:image/png;base64,{dot}"/></td></tr></table>',
                                   lambda blob, caption: named.append(blob) or f"fig-{len(named)}.png")
        self.assertEqual(md, "| Icon | ![](fig-1.png) |\n|---|---|")
        self.assertEqual(len(named), 1)

    def test_captions_go_to_the_nearest_block(self):
        blocks = [
            {"type": "image", "bbox": [0.1, 0.1, 0.5, 0.3]},
            {"type": "image", "bbox": [0.1, 0.6, 0.5, 0.8]},
            {"type": "image_caption", "bbox": [0.1, 0.81, 0.5, 0.83]},
            {"type": "image_caption", "bbox": [0.6, 0.95, 0.9, 0.97]},  # under nothing: a paragraph
        ]
        self.assertEqual(server.pair_captions(blocks), {1: [2]})


if __name__ == "__main__":
    unittest.main()
