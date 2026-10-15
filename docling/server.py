"""gosidian-docling: a gosidian plugin that turns documents into markdown.

A plugin is an MCP server (gosidian's docs/plugins.md). This one serves
two tools over Streamable HTTP at /mcp:

- gosidian_manifest: the plugin's manifest, its one node docling.convert;
- convert: a document to markdown with docling, the pictures it holds
  given back as PNG files (embedded resources file:///fig-N.png),
  referenced in the markdown by name. The node takes its file by
  reference (file_refs, gosidian 2.81): {name, mime, size, sha256,
  url}, which it fetches from gosidian while the step runs; a file sent
  the old way ({name, mime, data} in base64) still works.

Documents and presentations (doc, docx, odt, rtf, ppt, pptx, odp) go
through LibreOffice to PDF first, then docling reads the PDF: a figure
made of a picture, arrows and labelled boxes stays whole, as the page
shows it, where docling's Word reader takes it apart, and the text is the
document's own. Spreadsheets go to xlsx, which docling reads as tables.
office: native reads docx, pptx and xlsx as they are, and turns the older
formats into them. A PDF is read with pypdfium2 by default: docling-parse
reads twice the letters of a PDF that draws its bold as two strokes
(pdf_backend chooses).

The plugin reads no vault: gosidian hands it the file, or where to fetch
it, and stores the pictures; it calls nothing but that address. Settings
come from the environment:

GOSIDIAN_PLUGIN_TOKEN  the bearer token gosidian sends ("" for none)
DOCLING_MAX_BYTES      the largest document sent in base64, default 20 MiB
DOCLING_MAX_REF_BYTES  the largest document fetched by reference, default 512 MiB
DOCLING_MAX_PAGES      the most pages converted, default 200
DOCLING_WORKERS        conversions at once, default 1
DOCLING_OFFICE_TIMEOUT seconds LibreOffice may take on a document, default 120
PORT                   default 8000
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import hashlib
import hmac
import io
import logging
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import threading

import anyio
import httpx
import mcp.types as types
import uvicorn
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route

VERSION = os.environ.get("PLUGIN_VERSION", "0.3.1")
TOKEN = os.environ.get("GOSIDIAN_PLUGIN_TOKEN", "")
MAX_BYTES = int(os.environ.get("DOCLING_MAX_BYTES", str(20 << 20)))
MAX_REF_BYTES = int(os.environ.get("DOCLING_MAX_REF_BYTES", str(512 << 20)))
MAX_PAGES = int(os.environ.get("DOCLING_MAX_PAGES", "200"))
WORKERS = max(1, int(os.environ.get("DOCLING_WORKERS", "1")))
OFFICE_TIMEOUT = int(os.environ.get("DOCLING_OFFICE_TIMEOUT", "120"))
PORT = int(os.environ.get("PORT", "8000"))
SOFFICE = shutil.which("soffice")

log = logging.getLogger("gosidian-docling")

# The kinds docling reads, by extension.
KINDS = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "html": "text/html",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
}

# The kinds LibreOffice turns into one docling reads, when it is there:
# to PDF by default (office: pdf), but a spreadsheet, which docling reads
# as tables; to the format of 2007 with office: native.
OFFICE = {
    "doc": ("docx", "application/msword"),
    "rtf": ("docx", "application/rtf"),
    "odt": ("docx", "application/vnd.oasis.opendocument.text"),
    "xls": ("xlsx", "application/vnd.ms-excel"),
    "ods": ("xlsx", "application/vnd.oasis.opendocument.spreadsheet"),
    "ppt": ("pptx", "application/vnd.ms-powerpoint"),
    "odp": ("pptx", "application/vnd.oasis.opendocument.presentation"),
}
if SOFFICE:
    KINDS.update({ext: mime for ext, (_, mime) in OFFICE.items()})

# The kinds that go to PDF with office: pdf, docx and pptx among them.
VIA_PDF = {"doc", "docx", "odt", "rtf", "ppt", "pptx", "odp"}
OFFICE_MODES = ("pdf", "native")

# How a PDF's text is read: pypdfium2, or docling-parse.
PDF_BACKENDS = ("pypdfium", "docling")

PLACEHOLDER = "<!-- gosidian:picture -->"

CONVERT_SETTINGS = {
    "type": "object",
    "required": ["file"],
    "properties": {
        "file": {"type": "string", "description": "The document, a vault path: an attachment of the project, or a file of its IN folder."},
        "ocr": {"type": "boolean", "default": True, "description": "Read the text of scanned pages and pictures."},
        "pictures": {"type": "boolean", "default": True, "description": "Give back the pictures as PNG files."},
        "max_pages": {"type": "integer", "description": f"Convert the first pages only (at most {MAX_PAGES})."},
        "images_scale": {"type": "number", "default": 2.0, "description": "The pictures' scale, 1 = 72 dpi."},
        "pdf_backend": {"type": "string", "enum": list(PDF_BACKENDS), "default": "pypdfium",
                        "description": "How a PDF's text is read: pypdfium (pypdfium2), or docling (docling-parse)."},
        "office": {"type": "string", "enum": list(OFFICE_MODES), "default": "pdf",
                   "description": "Documents and presentations: through LibreOffice to PDF (pdf), or read as docx and pptx (native)."},
    },
}

CONVERT_OUTPUT = {
    "type": "object",
    "properties": {
        "markdown": {"type": "string", "description": "The document; a picture is ![caption](fig-N.png)."},
        "title": {"type": "string"},
        "pages": {"type": "integer"},
        "tables": {"type": "integer"},
        "pictures": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "page": {"type": "integer"}, "caption": {"type": "string"}},
            },
        },
    },
}

MANIFEST = {
    "name": "docling",
    "version": VERSION,
    "gosidian": 1,
    "description": "Documents (" + ", ".join(sorted(k.upper() for k in KINDS if k != "jpeg")) + ") to markdown with docling, with the pictures they hold as PNG files.",
    "nodes": [
        {
            "name": "convert",
            "tool": "convert",
            "description": "A document to markdown; its pictures come back as files (output files), named fig-N.png in the markdown.",
            "files": ["file"],
            "file_refs": True,
            "input_schema": CONVERT_SETTINGS,
            "output_schema": CONVERT_OUTPUT,
        }
    ],
    # It fetches the files it is handed from gosidian, nothing else.
    "permissions": {"files": True, "network": ["gosidian"]},
}

# The convert tool as gosidian calls it: file says where to fetch the
# document (url), or carries it (data).
CONVERT_TOOL_INPUT = {
    "type": "object",
    "required": ["file"],
    "properties": {
        "file": {
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
        },
        "ocr": {"type": "boolean"},
        "pictures": {"type": "boolean"},
        "max_pages": {"type": "integer", "minimum": 1},
        "images_scale": {"type": "number", "minimum": 0.5, "maximum": 4},
        "pdf_backend": {"type": "string", "enum": list(PDF_BACKENDS)},
        "office": {"type": "string", "enum": list(OFFICE_MODES)},
    },
}


class ConvertError(Exception):
    """A document the plugin cannot convert, said to the caller."""


_converters: dict[tuple, object] = {}
_converters_lock = threading.Lock()
_slots = anyio.Semaphore(WORKERS)


def converter(ocr: bool, scale: float, backend: str = "pypdfium"):
    """A docling converter for these options, built once: it loads models."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    key = (ocr, scale, backend)
    with _converters_lock:
        if key not in _converters:
            opts = PdfPipelineOptions()
            opts.do_ocr = ocr
            opts.do_table_structure = True
            opts.generate_picture_images = True
            opts.images_scale = scale
            artifacts = os.environ.get("DOCLING_ARTIFACTS_PATH")
            if artifacts:
                opts.artifacts_path = artifacts
            pdf = {"pipeline_options": opts}
            if backend == "pypdfium":
                from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend

                pdf["backend"] = PyPdfiumDocumentBackend
            _converters[key] = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(**pdf),
                    InputFormat.IMAGE: ImageFormatOption(pipeline_options=opts),
                }
            )
        return _converters[key]


def office_convert(path: pathlib.Path, into: str, target: str) -> pathlib.Path:
    """Turns an office document into target (pdf, docx, xlsx, pptx), which
    docling reads, with LibreOffice, in the folder into."""
    out = pathlib.Path(into) / "office"
    out.mkdir(exist_ok=True)
    # A profile of its own: two conversions at once do not share one.
    profile = pathlib.Path(into) / "lo-profile"
    try:
        r = subprocess.run(
            [SOFFICE, f"-env:UserInstallation={profile.as_uri()}", "--headless", "--norestore", "--convert-to", target, "--outdir", str(out), str(path)],
            capture_output=True, text=True, timeout=OFFICE_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        raise ConvertError(f"{path.name}: LibreOffice took more than {OFFICE_TIMEOUT} s") from None
    got = out / (path.stem + "." + target)
    if not got.is_file():
        raise ConvertError(f"{path.name}: LibreOffice could not turn it into {target} ({(r.stderr or r.stdout).strip()[-200:]})")
    return got


def convert_sync(name: str, source, size_cap: int, ocr: bool, pictures: bool, max_pages: int, scale: float, backend: str = "pypdfium") -> tuple[dict, list[tuple[str, bytes]]]:
    """Converts one document, its bytes or a file named as it: the structured result and the picture files."""
    from docling.datamodel.base_models import DocumentStream
    from docling_core.types.doc import ImageRefMode, PictureItem, TableItem

    if isinstance(source, bytes):
        source = DocumentStream(name=name, stream=io.BytesIO(source))
    result = converter(ocr, scale, backend).convert(source, max_num_pages=max_pages, max_file_size=size_cap, raises_on_error=False)
    doc = result.document
    if doc is None or (result.status.name not in ("SUCCESS", "PARTIAL_SUCCESS")):
        errors = "; ".join(str(e.error_message) for e in (result.errors or [])) or result.status.name
        raise ConvertError(f"docling could not convert {name}: {errors}")

    md = doc.export_to_markdown(image_mode=ImageRefMode.PLACEHOLDER, image_placeholder=PLACEHOLDER)
    files: list[tuple[str, bytes]] = []
    shown: list[dict] = []
    tables = 0
    parts = md.split(PLACEHOLDER)
    out = [parts[0]]
    n = 0
    for item, _level in doc.iterate_items():
        if isinstance(item, TableItem):
            tables += 1
        if not isinstance(item, PictureItem):
            continue
        if n + 1 >= len(parts):
            break  # a picture the markdown does not show
        n += 1
        caption = item.caption_text(doc) or ""
        ref = ""
        img = item.get_image(doc) if pictures else None
        if img is not None:
            fname = f"fig-{len(files) + 1}.png"
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            files.append((fname, buf.getvalue()))
            page = item.prov[0].page_no if item.prov else None
            shown.append({"name": fname, "page": page, "caption": caption})
            alt = caption.replace("[", "(").replace("]", ")").replace("\n", " ")
            done = "".join(out)
            if done[done.rfind("\n") + 1 :].lstrip().startswith("|"):
                # In a table's cell: on its line, or the table breaks.
                ref = f" ![{alt}]({fname}) "
            else:
                # A picture is a block of its own, not the tail of a list item.
                ref = f"\n\n![{alt}]({fname})\n\n"
        out.append(ref)
        out.append(parts[n])
    out.extend(parts[n + 1 :])

    title = None
    for item, _level in doc.iterate_items():
        label = getattr(item, "label", None)
        if label is not None and str(getattr(label, "value", label)) in ("title", "section_header"):
            title = getattr(item, "text", None)
            break
    return {
        "markdown": re.sub(r"\n{3,}", "\n\n", "".join(out)).strip() + "\n",
        "title": title or "",
        "pages": len(doc.pages),
        "tables": tables,
        "pictures": shown,
    }, files


def file_name(f) -> str:
    """The document's name, its kind checked."""
    if not isinstance(f, dict):
        raise ConvertError("file is {name, mime, url} (or data): gosidian sends it for a node's file setting")
    name = os.path.basename(str(f.get("name", "")).replace("\\", "/")) or "document"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in KINDS:
        raise ConvertError(f"{name}: docling reads {', '.join(sorted(KINDS))}")
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


def decode_file(args: dict) -> tuple[str, bytes]:
    f = args.get("file")
    name = file_name(f)
    try:
        data = base64.b64decode(str(f.get("data", "")), validate=True)
    except (binascii.Error, ValueError) as e:
        raise ConvertError(f"{name}: data is not base64 ({e})") from None
    if not data:
        raise ConvertError(f"{name} is empty")
    if len(data) > MAX_BYTES:
        raise ConvertError(f"{name} is {len(data)} bytes, at most {MAX_BYTES}")
    return name, data


app = Server("gosidian-docling", version=VERSION)


@app.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(name="gosidian_manifest", description="The manifest of this gosidian plugin.", inputSchema={"type": "object"}),
        types.Tool(
            name="convert",
            description="A document to markdown with docling; its pictures come back as embedded PNG resources (file:///fig-N.png).",
            inputSchema=CONVERT_TOOL_INPUT,
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "gosidian_manifest":
        return MANIFEST
    if name != "convert":
        raise ValueError(f"no tool {name}")
    tmp = None
    try:
        f = arguments.get("file")
        if isinstance(f, dict) and f.get("url"):
            fname = file_name(f)
            tmp = tempfile.mkdtemp(prefix="docling-")
            source = await anyio.to_thread.run_sync(fetch_file, f, fname, tmp)
            cap = MAX_REF_BYTES
        else:
            fname, source = decode_file(arguments)
            cap = MAX_BYTES
        max_pages = min(int(arguments.get("max_pages") or MAX_PAGES), MAX_PAGES)
        ocr = bool(arguments.get("ocr", True))
        pictures = bool(arguments.get("pictures", True))
        scale = float(arguments.get("images_scale") or 2.0)
        backend = str(arguments.get("pdf_backend") or "pypdfium")
        if backend not in PDF_BACKENDS:
            raise ConvertError(f"pdf_backend {backend!r}: {' or '.join(PDF_BACKENDS)}")
        async with _slots:
            ext = fname.rsplit(".", 1)[-1].lower()
            office = str(arguments.get("office") or "pdf")
            if office not in OFFICE_MODES:
                raise ConvertError(f"office {office!r}: {' or '.join(OFFICE_MODES)}")
            target = None
            if office == "pdf" and ext in VIA_PDF and SOFFICE:
                target = "pdf"
            elif ext in OFFICE:
                target = OFFICE[ext][0]
            if target:
                if tmp is None:
                    tmp = tempfile.mkdtemp(prefix="docling-")
                if isinstance(source, bytes):
                    path = pathlib.Path(tmp) / fname
                    path.write_bytes(source)
                    source = path
                source = await anyio.to_thread.run_sync(office_convert, pathlib.Path(source), tmp, target)
            result, files = await anyio.to_thread.run_sync(convert_sync, fname, source, cap, ocr, pictures, max_pages, scale, backend)
    except ConvertError as e:
        return types.CallToolResult(content=[types.TextContent(type="text", text=str(e))], isError=True)
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
    log.info("converted %s: %d pages, %d pictures", fname, result["pages"], len(files))
    content: list[types.ContentBlock] = [types.TextContent(type="text", text=result["markdown"])]
    for fn, blob in files:
        content.append(
            types.EmbeddedResource(
                type="resource",
                resource=types.BlobResourceContents(uri=f"file:///{fn}", mimeType="image/png", blob=base64.b64encode(blob).decode()),
            )
        )
    return types.CallToolResult(content=content, structuredContent=result)


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
    return JSONResponse({"status": "ok", "plugin": "docling", "version": VERSION})


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


@contextlib.asynccontextmanager
async def lifespan(_app):
    async with sessions.run():
        # Load the models now, not at the first document.
        await anyio.to_thread.run_sync(converter, True, 2.0)
        log.info("gosidian-docling %s ready on :%d (token %s)", VERSION, PORT, "on" if TOKEN else "off")
        yield


asgi = BearerAuth(
    Starlette(routes=[Route("/health", health), Route("/mcp", endpoint=MCPEndpoint())], lifespan=lifespan),
    TOKEN,
)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(asgi, host="0.0.0.0", port=PORT, log_level="info")
