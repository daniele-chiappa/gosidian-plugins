"""gosidian-ocr: a gosidian plugin that reads scans and hard PDFs with an OCR
vision model.

A plugin is an MCP server (gosidian's docs/plugins.md). This one serves
three tools over Streamable HTTP at /mcp:

- gosidian_manifest: the plugin's manifest, its nodes ocr.convert and
  ocr.inspect;
- convert: a PDF or an image to markdown, page by page, with the vision
  model MinerU2.5; the pictures and charts it finds come back as PNG files
  (embedded resources file:///fig-N.png), referenced in the markdown by
  name, as docling.convert gives them;
- inspect: which pages of a PDF have no text (a scan, a photo), and whether
  the model's server answers: what a pipeline needs to choose between this
  plugin and docling, or to wait for the server.

The file comes by reference (file_refs): {name, mime, size, sha256, url},
fetched from gosidian while the step runs; the old way ({name, mime, data}
in base64) works too.

The model runs in a server of its own, any OpenAI-compatible endpoint that
serves MinerU2.5: llama.cpp's llama-server (with --special, or the layout
loses its tokens and the markdown comes out empty) or vLLM. The client is
mineru-vl-utils (Apache-2.0): it asks the model for a page's layout, then
for the content of each block; the plugin writes the markdown from the
blocks. The MinerU program itself is not used.

The plugin reads no vault: it calls the gosidian address it is handed for
each file and the model's server, nothing else. Settings come from the
environment:

GOSIDIAN_PLUGIN_TOKEN the bearer token gosidian sends ("" for none)
OCR_SERVER_URL        the model's server, e.g. http://gpu.lan:8082
OCR_API_KEY           its key, sent as a bearer token ("" for none)
OCR_MODEL             the model's name on the server ("": the first it lists)
OCR_CONCURRENCY       requests to the server at once, default 4
OCR_TIMEOUT           seconds a request to the server may take, default 300
OCR_MAX_BYTES         the largest file sent in base64, default 20 MiB
OCR_MAX_REF_BYTES     the largest file fetched by reference, default 512 MiB
OCR_MAX_PAGES         the most pages converted, default 200
OCR_WORKERS           documents converted at once, default 1
OCR_TEXT_MIN_CHARS    a page has text when its text layer holds this many
                      letters and digits, default 20
PORT                  default 8000
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import hashlib
import hmac
import html.parser
import io
import json
import logging
import os
import pathlib
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse

import anyio
import httpx
import jsonschema
import mcp.types as types
import uvicorn
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from PIL import Image
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route

VERSION = os.environ.get("PLUGIN_VERSION", "0.1.0")
TOKEN = os.environ.get("GOSIDIAN_PLUGIN_TOKEN", "")
SERVER_URL = os.environ.get("OCR_SERVER_URL", "").strip().rstrip("/")
API_KEY = os.environ.get("OCR_API_KEY", "").strip()
MODEL = os.environ.get("OCR_MODEL", "").strip()
CONCURRENCY = max(1, int(os.environ.get("OCR_CONCURRENCY", "4")))
TIMEOUT = max(10, int(os.environ.get("OCR_TIMEOUT", "300")))
MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(20 << 20)))
MAX_REF_BYTES = int(os.environ.get("OCR_MAX_REF_BYTES", str(512 << 20)))
MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "200"))
WORKERS = max(1, int(os.environ.get("OCR_WORKERS", "1")))
TEXT_MIN_CHARS = int(os.environ.get("OCR_TEXT_MIN_CHARS", "20"))
PORT = int(os.environ.get("PORT", "8000"))

log = logging.getLogger("gosidian-ocr")

# The kinds the plugin reads, by extension.
KINDS = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "webp": "image/webp",
}

# A page is drawn at dpi (200, as MinerU draws it), its longer side at most
# MAX_SIDE pixels: a poster at 200 dpi would be tens of megapixels.
DPI = 200
MAX_SIDE = 4000
# Pages sent to the model at a time: their images stay in memory meanwhile.
BATCH = max(4, CONCURRENCY * 2)
# A page with no pixel darker than this is blank: it is not sent.
BLANK_LEVEL = 250
# A picture smaller than this on both sides is a speck, not a figure.
PICTURE_MIN_PX = 16

# The blocks of the model (mineru-vl-utils' BlockType), by what the
# markdown does with them.
TITLES = {"doc_title": "#", "title": "##", "paragraph_title": "###"}
TEXTS = {"text", "list_item", "ref_text", "index", "phonetic", "formula_number", "page_footnote"}
VISUALS = {"image", "chart", "image_block"}
CODES = {"code", "algorithm"}
EQUATIONS = {"equation", "equation_block"}
# Captions and notes go with the block they name.
CAPTIONS = {
    "image_caption": VISUALS, "image_footnote": VISUALS,
    "table_caption": {"table"}, "table_footnote": {"table"},
    "code_caption": CODES,
    "caption": VISUALS | {"table"} | CODES, "footnote": VISUALS | {"table"} | CODES,
}
BEFORE = {"table_caption", "code_caption"}  # written above their block
# Page furniture, left out unless paratext: true. A page's footnotes stay.
PARATEXT = {"header", "footer", "page_number", "aside_text"}

CHARTS = ("image", "table")

CONVERT_SETTINGS = {
    "type": "object",
    "required": ["file"],
    "properties": {
        "file": {"type": "string", "description": "The document, a vault path: an attachment of the project, or a file of its IN folder (pdf, png, jpg, tiff, webp)."},
        "pages": {"type": "string", "description": "The pages to read, e.g. \"1-3,7\"; all by default."},
        "max_pages": {"type": "integer", "description": f"Read the first pages only (at most {MAX_PAGES})."},
        "dpi": {"type": "integer", "default": DPI, "description": "The resolution a PDF's page is drawn at for the model."},
        "pictures": {"type": "boolean", "default": True, "description": "Give back the pictures and charts as PNG files."},
        "charts": {"type": "string", "enum": list(CHARTS), "default": "image",
                   "description": "A chart as a picture (image), or also as the table of its data, read by the model (table)."},
        "paratext": {"type": "boolean", "default": False,
                     "description": "Keep the page headers, footers, page numbers and margin notes."},
    },
}

CONVERT_OUTPUT = {
    "type": "object",
    "properties": {
        "markdown": {"type": "string", "description": "The document; a picture is ![caption](fig-N.png)."},
        "title": {"type": "string"},
        "pages": {"type": "integer", "description": "The pages read."},
        "pages_in_file": {"type": "integer"},
        "tables": {"type": "integer"},
        "pictures": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "page": {"type": "integer"}, "caption": {"type": "string"}},
            },
        },
        "engine": {"type": "object", "description": "The model and its server's host."},
        "seconds": {"type": "number"},
    },
}

INSPECT_SETTINGS = {
    "type": "object",
    "properties": {
        "file": {"type": "string", "description": "The document, a vault path; without one, only the server's state."},
    },
}

INSPECT_OUTPUT = {
    "type": "object",
    "properties": {
        "server": {"type": "string", "enum": ["up", "down", "unset"], "description": "Whether the model's server answers."},
        "server_error": {"type": "string"},
        "model": {"type": "string"},
        "pages": {"type": "integer"},
        "pages_without_text": {"type": "array", "items": {"type": "integer"}, "description": "The pages whose text layer holds no text: scans, photos."},
        "share_without_text": {"type": "number", "description": "Their share of the pages, 0 to 1; an image is 1."},
    },
}


def server_host() -> str:
    return (urllib.parse.urlsplit(SERVER_URL).hostname or "") if SERVER_URL else ""


MANIFEST = {
    "name": "ocr",
    "version": VERSION,
    "gosidian": 1,
    "description": "Scans and hard PDFs (" + ", ".join(sorted(k.upper() for k in KINDS if k not in ("jpeg", "tif"))) + ") to markdown with an OCR vision model (MinerU2.5), page by page, with their pictures as PNG files; ocr.inspect says which pages have no text and whether the model's server answers.",
    "nodes": [
        {
            "name": "convert",
            "tool": "convert",
            "description": "A PDF or an image to markdown with the OCR model, page by page: headings, text, tables, formulas; its pictures and charts come back as files (output files), named fig-N.png in the markdown.",
            "files": ["file"],
            "file_refs": True,
            "input_schema": CONVERT_SETTINGS,
            "output_schema": CONVERT_OUTPUT,
        },
        {
            "name": "inspect",
            "tool": "inspect",
            "description": "Which pages of a PDF have no text (scans, photos) and their share, and whether the OCR model's server answers: for a pipeline to choose between ocr.convert and docling.convert.",
            "files": ["file"],
            "file_refs": True,
            "input_schema": INSPECT_SETTINGS,
            "output_schema": INSPECT_OUTPUT,
        },
    ],
    # It fetches the files it is handed from gosidian, and calls the model's server.
    "permissions": {"files": True, "network": ["gosidian"] + ([server_host()] if server_host() else [])},
}

FILE_INPUT = {
    "type": "object",
    "required": ["name"],
    "properties": {
        "name": {"type": "string"},
        "mime": {"type": "string"},
        "url": {"type": "string", "description": "Where to fetch it, while the step runs"},
        "size": {"type": "integer"},
        "sha256": {"type": "string"},
        "data": {"type": "string", "description": "base64, the way before file_refs"},
    },
}

# The tools as gosidian calls them: file says where to fetch the document
# (url), or carries it (data).
CONVERT_TOOL_INPUT = {
    "type": "object",
    "required": ["file"],
    "properties": {
        "file": FILE_INPUT,
        "pages": {"type": "string", "maxLength": 200},
        "max_pages": {"type": "integer", "minimum": 1},
        "dpi": {"type": "integer", "minimum": 72, "maximum": 400},
        "pictures": {"type": "boolean"},
        "charts": {"type": "string", "enum": list(CHARTS)},
        "paratext": {"type": "boolean"},
    },
}

INSPECT_TOOL_INPUT = {"type": "object", "properties": {"file": FILE_INPUT}}


class ConvertError(Exception):
    """A document the plugin cannot convert, said to the caller."""


_slots = anyio.Semaphore(WORKERS)
# PDFium is not thread-safe: one call at a time, whatever the document.
_pdfium = threading.Lock()


# --- the model's server ---------------------------------------------------


def server_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}


def server_status() -> dict:
    """Whether the model's server answers, and the model it serves: its list
    of models, which wants the key."""
    if not SERVER_URL:
        return {"server": "unset", "server_error": "OCR_SERVER_URL is not set"}
    try:
        r = httpx.get(SERVER_URL + "/v1/models", headers=server_headers(), timeout=httpx.Timeout(5.0))
    except httpx.HTTPError as e:
        return {"server": "down", "server_error": f"{server_host()} does not answer ({type(e).__name__})"}
    if r.status_code in (401, 403):
        return {"server": "down", "server_error": f"{server_host()} refuses the key (OCR_API_KEY): {r.status_code}"}
    if r.status_code != 200:
        return {"server": "down", "server_error": f"{server_host()} answered {r.status_code}"}
    try:
        models = [str(m.get("id", "")) for m in r.json().get("data", []) if isinstance(m, dict)]
    except (ValueError, AttributeError):
        return {"server": "down", "server_error": f"{server_host()}: its list of models is not JSON"}
    if MODEL:
        if MODEL not in models:
            return {"server": "down", "server_error": f"{server_host()} does not serve {MODEL} (it serves {', '.join(models) or 'nothing'})"}
        return {"server": "up", "model": MODEL}
    if not models or not models[0]:
        return {"server": "down", "server_error": f"{server_host()} lists no model"}
    return {"server": "up", "model": models[0]}


def new_client(model: str, charts: str):
    """A client of mineru-vl-utils for the server, which asks the model for a
    page's layout, then for each block's content. The model is named, so it
    does not ask the server again."""
    from mineru_vl_utils import MinerUClient

    return MinerUClient(
        backend="http-client",
        server_url=SERVER_URL,
        server_headers=server_headers(),
        model_name=model,
        skip_model_name_checking=True,
        max_concurrency=CONCURRENCY,
        http_timeout=TIMEOUT,
        max_retries=2,
        use_tqdm=False,
        image_analysis=charts == "table",
    )


# --- pages ------------------------------------------------------------------


def page_numbers(spec: str | None, count: int, limit: int) -> list[int]:
    """The pages to read, 1-based: all, or those spec names ("1-3,7"), the
    first limit of them."""
    if count < 1:
        raise ConvertError("the file has no pages")
    if not spec or not spec.strip():
        return list(range(1, min(count, limit) + 1))
    chosen: list[int] = []
    for part in spec.replace(" ", "").split(","):
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", part)
        if not m:
            raise ConvertError(f"pages {spec!r}: page numbers and ranges, as \"1-3,7\"")
        lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
        if lo < 1 or hi < lo or hi > count:
            raise ConvertError(f"pages {spec!r}: the file has {count} page{'s' if count != 1 else ''}")
        chosen.extend(n for n in range(lo, hi + 1) if n not in chosen)
    return chosen[:limit]


def page_count(path: pathlib.Path, ext: str) -> int:
    if ext == "pdf":
        import pypdfium2 as pdfium

        with _pdfium:
            try:
                pdf = pdfium.PdfDocument(str(path))
            except pdfium.PdfiumError as e:
                raise ConvertError(f"{path.name}: not a PDF PDFium can open ({e})") from None
            try:
                return len(pdf)
            finally:
                pdf.close()
    try:
        with Image.open(path) as img:
            return getattr(img, "n_frames", 1)
    except (OSError, Image.DecompressionBombError) as e:
        raise ConvertError(f"{path.name}: not an image Pillow can open ({e})") from None


def render(path: pathlib.Path, ext: str, numbers: list[int], dpi: int) -> list[Image.Image]:
    """The pages as RGB images: a PDF's drawn at dpi, an image's frames as
    they are; the longer side at most MAX_SIDE."""
    out = []
    if ext == "pdf":
        import pypdfium2 as pdfium

        with _pdfium:
            pdf = pdfium.PdfDocument(str(path))
            try:
                for n in numbers:
                    page = pdf[n - 1]
                    w, h = page.get_size()
                    scale = min(dpi / 72, MAX_SIDE / max(w, h, 1))
                    out.append(page.render(scale=scale).to_pil().convert("RGB"))
                    page.close()
            finally:
                pdf.close()
    else:
        with Image.open(path) as img:
            for n in numbers:
                img.seek(n - 1)
                frame = img.convert("RGB")
                if max(frame.size) > MAX_SIDE:
                    frame.thumbnail((MAX_SIDE, MAX_SIDE))
                out.append(frame)
    return out


def text_layer(path: pathlib.Path, ext: str) -> tuple[int, list[int]]:
    """The pages of a file and those without text: a PDF's pages whose text
    layer holds fewer than TEXT_MIN_CHARS letters and digits; every frame of
    an image."""
    if ext != "pdf":
        n = page_count(path, ext)
        return n, list(range(1, n + 1))
    import pypdfium2 as pdfium

    without = []
    with _pdfium:
        try:
            pdf = pdfium.PdfDocument(str(path))
        except pdfium.PdfiumError as e:
            raise ConvertError(f"{path.name}: not a PDF PDFium can open ({e})") from None
        try:
            for i in range(len(pdf)):
                page = pdf[i]
                textpage = page.get_textpage()
                text = textpage.get_text_bounded()
                textpage.close()
                page.close()
                if sum(c.isalnum() for c in text) < TEXT_MIN_CHARS:
                    without.append(i + 1)
            return len(pdf), without
        finally:
            pdf.close()


def blank(img: Image.Image) -> bool:
    """A page with no pixel darker than BLANK_LEVEL."""
    return img.convert("L").getextrema()[0] >= BLANK_LEVEL


# --- markdown -----------------------------------------------------------------


def one_line(text: str) -> str:
    return " ".join((text or "").split())


def md_text(text: str) -> str:
    """A block of text as a markdown paragraph: its lines joined, a bullet
    the model wrote as a character made a list item."""
    lines = [line.strip() for line in (text or "").strip().splitlines() if line.strip()]
    out = []
    for line in lines:
        m = re.match(r"[•·▪◦●○■□➢►▶✓✔]\s*", line)
        if m:
            line = "- " + line[m.end():]
        out.append(line)
    return "\n".join(out)


def joins(prev: str, nxt: str) -> str:
    """Two pieces of a paragraph the model split (a column's or a page's
    end): a word cut by a hyphen joined, Chinese and Japanese without a
    space, the rest with one."""
    if re.search(r"[A-Za-zÀ-ÿ]-$", prev) and nxt[:1].islower():
        return prev[:-1] + nxt
    if re.search(r"[぀-ヿ㐀-䶿一-鿿]$", prev) and re.match(r"[぀-ヿ㐀-䶿一-鿿]", nxt):
        return prev + nxt
    return prev + " " + nxt


class _Table(html.parser.HTMLParser):
    """An HTML table read into rows of cells, each with its spans; the
    pictures in its cells kept by their src."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows: list[list[dict]] = []
        self.cell: dict | None = None
        self.nested = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            self.nested += 1
        elif self.nested > 1:
            return
        elif tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            if not self.rows:
                self.rows.append([])
            span = lambda k: int(a.get(k) or 1) if str(a.get(k) or "1").isdigit() else 1  # noqa: E731
            self.cell = {"text": "", "rowspan": span("rowspan"), "colspan": span("colspan"), "head": tag == "th"}
            self.rows[-1].append(self.cell)
        elif tag == "img" and self.cell is not None:
            self.cell["text"] += f" [[img:{a.get('src', '')}]] "
        elif tag == "br" and self.cell is not None:
            self.cell["text"] += " "

    def handle_endtag(self, tag):
        if tag == "table":
            self.nested -= 1
        elif tag in ("td", "th") and self.nested <= 1:
            self.cell = None

    def handle_data(self, data):
        if self.cell is not None and self.nested <= 1:
            self.cell["text"] += data


def table_markdown(content: str, picture) -> str:
    """A table of the model, HTML, in markdown: a grid when no cell spans
    rows or columns, its first row the header; the HTML as it is
    otherwise, which a grid cannot say. A picture in a cell (a data URI) is
    handed to picture(bytes) -> its file's name."""
    def pictures_out(text: str, as_md: bool) -> str:
        def one(m):
            name = picture_from_uri(m.group(1), picture)
            if not name:
                return ""
            return f"![]({name})" if as_md else f'<img src="{name}"/>'
        return re.sub(r"\[\[img:([^\]]*)\]\]", one, text)

    t = _Table()
    try:
        t.feed(content)
        t.close()
    except Exception:  # not HTML the parser takes: as it is, pictures named
        t.rows = []
    rows = [r for r in t.rows if r]
    if rows and t.nested <= 0 and all(c["rowspan"] == 1 and c["colspan"] == 1 for r in rows for c in r):
        width = max(len(r) for r in rows)
        cells = [[pictures_out(one_line(c["text"]), True).replace("|", "\\|") for c in r] + [""] * (width - len(r)) for r in rows]
        lines = ["| " + " | ".join(cells[0]) + " |", "|" + "---|" * width]
        lines += ["| " + " | ".join(r) + " |" for r in cells[1:]]
        return "\n".join(lines)
    out = re.sub(r'<img\s+src="([^"]*)"\s*/?>', lambda m: f"[[img:{m.group(1)}]]", content.strip())
    return pictures_out(out, False)


def picture_from_uri(uri: str, picture) -> str:
    m = re.match(r"data:image/[\w.+-]+;base64,(.*)", uri, re.S)
    if not m:
        return ""
    try:
        raw = base64.b64decode(m.group(1), validate=False)
        with Image.open(io.BytesIO(raw)) as img:
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="PNG")
    except Exception:
        return ""
    return picture(buf.getvalue(), None)


def equation_markdown(content: str) -> str:
    s = (content or "").strip()
    m = re.fullmatch(r"\\\[(.*)\\\]", s, re.S) or re.fullmatch(r"\$\$(.*)\$\$", s, re.S)
    inner = (m.group(1) if m else s).strip()
    return f"$$\n{inner}\n$$" if inner else ""


def covered(inner, outer, share: float = 0.9) -> bool:
    """Whether the box inner lies within outer, by share of its area."""
    x1, y1 = max(inner[0], outer[0]), max(inner[1], outer[1])
    x2, y2 = min(inner[2], outer[2]), min(inner[3], outer[3])
    area = (inner[2] - inner[0]) * (inner[3] - inner[1])
    return area > 0 and max(0.0, x2 - x1) * max(0.0, y2 - y1) >= share * area


def pair_captions(blocks: list[dict]) -> dict[int, list[int]]:
    """The captions and notes of a page by the block they name: the nearest
    block of their kinds on the page, above or below, overlapping it across;
    a caption with none stays a paragraph."""
    owners: dict[int, list[int]] = {}
    for i, b in enumerate(blocks):
        kinds = CAPTIONS.get(b["type"])
        if not kinds:
            continue
        best = None
        for j, o in enumerate(blocks):
            if o["type"] not in kinds:
                continue
            across = min(b["bbox"][2], o["bbox"][2]) - max(b["bbox"][0], o["bbox"][0])
            if across <= 0:
                continue
            gap = max(b["bbox"][1] - o["bbox"][3], o["bbox"][1] - b["bbox"][3], 0.0)
            if gap <= 0.15 and (best is None or gap < best[0]):
                best = (gap, j)
        if best:
            owners.setdefault(best[1], []).append(i)
    return owners




class Writer:
    """The markdown's parts, and which one is the last paragraph of text: a
    block the model marks as going on from it (merge_prev) is joined to it,
    across a column's end or a page's, when nothing but page furniture came
    in between."""

    def __init__(self):
        self.parts: list[str] = []
        self.text_at: int | None = None

    def add(self, part: str, text: bool = False):
        if part:
            self.parts.append(part)
            self.text_at = len(self.parts) - 1 if text else None

    def go_on(self, text: str) -> bool:
        if self.text_at is None:
            return False
        self.parts[self.text_at] = joins(self.parts[self.text_at], text)
        return True


def page_markdown(w: Writer, blocks: list[dict], crop, picture, paratext: bool, charts: str) -> tuple[int, str]:
    """A page's blocks, in the model's reading order, written to w: the
    tables it holds and its first title. crop(bbox, caption) saves a part
    of the page as a picture, picture(png, caption) a picture of a table's
    cell; each gives the file's name, or "" for none."""
    tables = 0
    title = ""
    owners = pair_captions(blocks)
    owned = {i for v in owners.values() for i in v}
    groups = [b["bbox"] for b in blocks if b["type"] == "image_block"]

    def captions(j: int, kinds: set[str]) -> list[str]:
        return [md_text(blocks[i].get("content") or "") for i in owners.get(j, [])
                if blocks[i]["type"] in kinds and (blocks[i].get("content") or "").strip()]

    for j, b in enumerate(blocks):
        kind, content = b["type"], b.get("content") or ""
        if j in owned:
            continue  # written with its block
        if kind in PARATEXT:
            if paratext and content.strip():
                w.add(md_text(content))
            continue
        if kind in TITLES:
            if content.strip():
                w.add(f"{TITLES[kind]} {one_line(content)}")
                title = title or one_line(content)
        elif kind in TEXTS or kind in CAPTIONS:
            text = md_text(content)
            if text and not (kind == "text" and b.get("merge_prev") and w.go_on(text)):
                w.add(text, text=kind == "text")
        elif kind == "table":
            body = table_markdown(content, picture) if content.strip() else ""
            tables += bool(body)
            for part in captions(j, {"table_caption", "caption"}) + [body] + captions(j, {"table_footnote", "footnote"}):
                w.add(part)
        elif kind in EQUATIONS:
            w.add(equation_markdown(content))
        elif kind in CODES:
            body = content.strip("\n")
            for part in captions(j, {"code_caption", "caption"}) + [f"```\n{body}\n```" if body.strip() else ""] + captions(j, {"footnote"}):
                w.add(part)
        elif kind in VISUALS:
            if kind != "image_block" and any(covered(b["bbox"], g) for g in groups):
                continue  # a picture of a group: the group is the picture
            caps = captions(j, {"image_caption", "caption"})
            caption = one_line(" ".join(caps))
            name = crop(b["bbox"], caption)
            if name:
                w.add(f"![{caption.replace('[', '(').replace(']', ')')}]({name})")
            for part in caps:
                w.add(part)
            if kind == "chart" and charts == "table" and content.strip():
                w.add(table_markdown(content, picture) if "<table" in content.lower() else content.strip())
            for part in captions(j, {"image_footnote", "footnote"}):
                w.add(part)
        elif content.strip():  # a kind of block the plugin does not know: its text
            w.add(md_text(content))
    return tables, title


def page_pictures(img: Image.Image, number: int, files: list, shown: list, on: bool):
    """crop and picture for page_markdown: the files named fig-N.png in the
    order they come, each listed in shown with its page and caption."""

    def picture(blob: bytes, caption: str | None) -> str:
        if not on:
            return ""
        name = f"fig-{len(files) + 1}.png"
        files.append((name, blob))
        shown.append({"name": name, "page": number, "caption": caption or ""})
        return name

    def crop(bbox, caption: str) -> str:
        if not on:
            return ""
        w, h = img.size
        box = (int(bbox[0] * w), int(bbox[1] * h), -int(-bbox[2] * w), -int(-bbox[3] * h))
        if box[2] - box[0] < PICTURE_MIN_PX and box[3] - box[1] < PICTURE_MIN_PX:
            return ""
        buf = io.BytesIO()
        img.crop(box).save(buf, format="PNG")
        return picture(buf.getvalue(), caption)

    return crop, picture


async def convert_document(path: pathlib.Path, name: str, ext: str, args: dict) -> tuple[dict, list[tuple[str, bytes]]]:
    """Reads a document with the model, BATCH pages at a time (their images
    stay in memory only meanwhile): the structured result and the picture
    files."""
    started = time.monotonic()
    count = await anyio.to_thread.run_sync(page_count, path, ext)
    limit = min(int(args.get("max_pages") or MAX_PAGES), MAX_PAGES)
    numbers = page_numbers(args.get("pages"), count, limit)
    dpi = int(args.get("dpi") or DPI)
    charts = str(args.get("charts") or "image")
    if charts not in CHARTS:
        raise ConvertError(f"charts {charts!r}: {' or '.join(CHARTS)}")
    pictures = args.get("pictures") is not False
    paratext = args.get("paratext") is True
    status = await anyio.to_thread.run_sync(server_status)
    if status["server"] != "up":
        raise ConvertError(f"the OCR model's server is not available: {status['server_error']}")
    client = new_client(status["model"], charts)

    w = Writer()
    files: list[tuple[str, bytes]] = []
    shown: list[dict] = []
    tables, title, inked, laid_out = 0, "", 0, 0
    for at in range(0, len(numbers), BATCH):
        batch = numbers[at:at + BATCH]
        images = await anyio.to_thread.run_sync(render, path, ext, batch, dpi)
        todo = [(n, img) for n, img in zip(batch, images) if not blank(img)]
        inked += len(todo)
        results = []
        if todo:
            try:
                results = await client.aio_concurrent_two_step_extract([img for _, img in todo])
            except Exception as e:
                pages = f"{todo[0][0]}" if len(todo) == 1 else f"{todo[0][0]}-{todo[-1][0]}"
                raise ConvertError(f"{name}: the model's server failed on page {pages}: {type(e).__name__}: {one_line(str(e))[:300]}") from None
        for (n, img), blocks in zip(todo, results):
            blocks = [dict(b) for b in blocks]
            laid_out += bool(blocks)
            crop, picture = page_pictures(img, n, files, shown, pictures)
            t, first = page_markdown(w, blocks, crop, picture, paratext, charts)
            tables += t
            title = title or first
        del images, todo, results
    if inked and not laid_out:
        raise ConvertError(f"{name}: the model found no layout on any of its {inked} pages. A llama-server must run "
                           "with --special, or the layout's tokens are dropped and nothing comes back")
    markdown = re.sub(r"\n{3,}", "\n\n", "\n\n".join(w.parts)).strip()
    return {
        "markdown": markdown + "\n" if markdown else "",
        "title": title,
        "pages": len(numbers),
        "pages_in_file": count,
        "tables": tables,
        "pictures": shown,
        "engine": {"model": status["model"], "server": server_host()},
        "seconds": round(time.monotonic() - started, 1),
    }, files


async def inspect_document(path: pathlib.Path | None, ext: str) -> dict:
    out = await anyio.to_thread.run_sync(server_status)
    if path is not None:
        count, without = await anyio.to_thread.run_sync(text_layer, path, ext)
        out.update(pages=count, pages_without_text=without, share_without_text=round(len(without) / count, 3) if count else 0.0)
    return out


# --- the file -------------------------------------------------------------


def file_name(f) -> str:
    """The document's name, its kind checked."""
    if not isinstance(f, dict):
        raise ConvertError("file is {name, mime, url} (or data): gosidian sends it for a node's file setting")
    name = os.path.basename(str(f.get("name", "")).replace("\\", "/")) or "document"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in KINDS:
        raise ConvertError(f"{name}: the OCR plugin reads {', '.join(sorted(KINDS))}")
    return name


def fetch_file(f: dict, name: str, into: str) -> pathlib.Path:
    """Fetches a document handed by reference into the folder into, under its
    name, checked against the size and the SHA-256 gosidian gave."""
    url = str(f.get("url", ""))
    if not url.startswith(("http://", "https://")):
        raise ConvertError(f"{name}: url {url!r} is not an http(s) address")
    size = int(f.get("size") or 0)
    if size > MAX_REF_BYTES:
        raise ConvertError(f"{name} is {size} bytes, at most {MAX_REF_BYTES}")
    want = str(f.get("sha256", "")).lower()
    path = pathlib.Path(into) / name
    h = hashlib.sha256()
    got = 0
    try:
        with open(path, "wb") as out, httpx.stream("GET", url, timeout=httpx.Timeout(60.0, read=300.0), follow_redirects=False) as r:
            if r.status_code != 200:
                raise ConvertError(f"{name}: fetching it answered {r.status_code}")
            for chunk in r.iter_bytes(1 << 20):
                got += len(chunk)
                if got > MAX_REF_BYTES:
                    raise ConvertError(f"{name} is more than {MAX_REF_BYTES} bytes")
                h.update(chunk)
                out.write(chunk)
    except httpx.HTTPError as e:
        raise ConvertError(f"{name}: fetching it failed ({e})") from None
    if not got:
        raise ConvertError(f"{name} is empty")
    if want and h.hexdigest() != want:
        raise ConvertError(f"{name}: what came is not the file gosidian named (its SHA-256 differs)")
    return path


def save_file(f: dict, name: str, into: str) -> pathlib.Path:
    """A document sent in base64, written into the folder into."""
    try:
        data = base64.b64decode(str(f.get("data", "")), validate=True)
    except (binascii.Error, ValueError) as e:
        raise ConvertError(f"{name}: data is not base64 ({e})") from None
    if not data:
        raise ConvertError(f"{name} is empty")
    if len(data) > MAX_BYTES:
        raise ConvertError(f"{name} is {len(data)} bytes, at most {MAX_BYTES}")
    path = pathlib.Path(into) / name
    path.write_bytes(data)
    return path


async def take_file(f, into: str) -> tuple[pathlib.Path, str, str]:
    name = file_name(f)
    if f.get("url"):
        path = await anyio.to_thread.run_sync(fetch_file, f, name, into)
    else:
        path = save_file(f, name, into)
    return path, name, name.rsplit(".", 1)[-1].lower()


# --- MCP ------------------------------------------------------------------

TOOLS = [
    types.Tool(name="gosidian_manifest", description="The manifest of this gosidian plugin.", input_schema={"type": "object"}),
    types.Tool(
        name="convert",
        description="A PDF or an image to markdown with the OCR model; its pictures come back as embedded PNG resources (file:///fig-N.png).",
        input_schema=CONVERT_TOOL_INPUT,
    ),
    types.Tool(
        name="inspect",
        description="Which pages of a PDF have no text, and whether the OCR model's server answers.",
        input_schema=INSPECT_TOOL_INPUT,
    ),
]


async def on_list_tools(_ctx, _params) -> types.ListToolsResult:
    return types.ListToolsResult(tools=TOOLS)


def tool_error(text: str) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=True)


async def on_call_tool(_ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
    """A tools/call: the arguments checked against the tool's schema, a dict
    given as JSON text and structured content, a failure as a tool error
    with its message (the SDK would give a bare "Internal server error")."""
    arguments = params.arguments or {}
    tool = next((t for t in TOOLS if t.name == params.name), None)
    if tool is not None:
        try:
            jsonschema.validate(instance=arguments, schema=tool.input_schema)
        except jsonschema.ValidationError as e:
            return tool_error(f"Input validation error: {e.message}")
    try:
        result = await call_tool(params.name, arguments)
    except Exception as e:
        return tool_error(str(e))
    if isinstance(result, dict):
        return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(result, indent=2))], structured_content=result)
    return result


async def call_tool(name: str, arguments: dict):
    if name == "gosidian_manifest":
        return MANIFEST
    if name not in ("convert", "inspect"):
        raise ValueError(f"no tool {name}")
    tmp = tempfile.mkdtemp(prefix="ocr-")
    try:
        if name == "inspect":
            f = arguments.get("file")
            if not f:
                return await inspect_document(None, "")
            path, _fname, ext = await take_file(f, tmp)
            return await inspect_document(path, ext)
        path, fname, ext = await take_file(arguments.get("file"), tmp)
        async with _slots:
            result, files = await convert_document(path, fname, ext, arguments)
    except ConvertError as e:
        return tool_error(str(e))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    log.info("converted a .%s: %d of %d pages, %d pictures, %d tables, %.0f s", ext, result["pages"], result["pages_in_file"], len(files), result["tables"], result["seconds"])
    content: list[types.ContentBlock] = [types.TextContent(type="text", text=result["markdown"])]
    for fn, blob in files:
        content.append(
            types.EmbeddedResource(
                type="resource",
                resource=types.BlobResourceContents(uri=f"file:///{fn}", mime_type="image/png", blob=base64.b64encode(blob).decode()),
            )
        )
    return types.CallToolResult(content=content, structured_content=result)


app = Server("gosidian-ocr", version=VERSION, on_list_tools=on_list_tools, on_call_tool=on_call_tool)

sessions = StreamableHTTPSessionManager(
    app=app,
    json_response=True,
    stateless=True,
    # The bearer token guards the plugin; the Host header differs by network.
    security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    # A 20 MiB document is 27 MiB in base64.
    max_request_body_size=MAX_BYTES * 4 // 3 + (1 << 20),
)


class MCPEndpoint:
    async def __call__(self, scope, receive, send):
        await sessions.handle_request(scope, receive, send)


async def health(_request):
    return JSONResponse({"status": "ok", "plugin": "ocr", "version": VERSION})


class BearerAuth:
    """Wants the token on everything but /health."""

    def __init__(self, inner, token: str):
        self.inner, self.token = inner, token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and self.token and scope.get("path") != "/health":
            got = dict(scope.get("headers") or []).get(b"authorization", b"").decode("latin-1")
            if not hmac.compare_digest(got.encode(), f"Bearer {self.token}".encode()):
                await PlainTextResponse("unauthorized", status_code=401)(scope, receive, send)
                return
        await self.inner(scope, receive, send)


def quiet_client_log():
    """mineru-vl-utils logs with loguru, at debug the model's raw answers:
    the documents' text. Only its warnings come through, a line each,
    short."""
    from loguru import logger

    logger.remove()
    logger.add(lambda m: log.warning("client: %s", one_line(m.record["message"])[:160]), level="WARNING", format="{message}")


quiet_client_log()


@contextlib.asynccontextmanager
async def lifespan(_app):
    async with sessions.run():
        status = await anyio.to_thread.run_sync(server_status)
        said = f"model {status['model']} on {server_host()}" if status["server"] == "up" else status["server_error"]
        log.info("gosidian-ocr %s ready on :%d (token %s); %s", VERSION, PORT, "on" if TOKEN else "off", said)
        yield


asgi = BearerAuth(
    Starlette(routes=[Route("/health", health), Route("/mcp", endpoint=MCPEndpoint())], lifespan=lifespan),
    TOKEN,
)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout)
    # A line for every request to the model's server, four or more a page: only their failures.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    uvicorn.run(asgi, host="0.0.0.0", port=PORT, log_level="info")
