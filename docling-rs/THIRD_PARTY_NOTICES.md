# Third-party notices: gosidian-docling-rs

The plugin's own code (`server.py`, its tests, the Dockerfile) is
MIT-licensed (the `LICENSE` at the root of this repository). Its image
holds the works of others, unmodified, under their own licenses; the texts
this folder adds are in the image under `/licenses`.

## docling.rs

The `docling-rs` binary (`/usr/local/bin/docling-rs`) is
[docling.rs](https://github.com/docling-project/docling.rs) 2.82.1, MIT,
copied from the project's own image
`ghcr.io/docling-project/docling-rs:2.82.1`. It links ONNX Runtime (MIT)
and the Rust crates its repository lists (`Cargo.lock`), under their own
permissive licenses.

## The models

In `/models`, copied from the same image, each unmodified, with the notice
and the licence texts docling.rs ships beside them (`MODELS_NOTICE.md`,
`models.json`, `LICENSE-*.txt`), which say where each file comes from and
at which revision:

| Model | License |
|---|---|
| RT-DETR layout model (docling-layout-heron), as ONNX and quantized | Apache-2.0 |
| TableFormer (docling-models), as ONNX and quantized | CDLA-Permissive-2.0 and Apache-2.0 |
| DocumentFigureClassifier-v2.5 | MIT |
| PP-OCRv3 and PP-OCRv6 recognition, detection and line orientation (PaddleOCR, as RapidOCR hosts them), with their dictionaries | Apache-2.0 |

The speech and chunking models of docling.rs's image are not in this one.

## Python

Python 3.12 (PSF-2.0), and 59 packages installed with pip. The main ones:

| Package | License |
|---|---|
| docling-core, mcp, python-pptx, pydantic, jsonschema | MIT |
| doclang, requests | Apache-2.0 |
| httpx, starlette, uvicorn, lxml, numpy, pandas | BSD |
| pillow | MIT-CMU |
| certifi | MPL-2.0 |

Each package's license, as it ships it, is in its `*.dist-info` folder
under `/usr/local/lib/python3.12/site-packages`, where `pip show` and
`pip-licenses` read it.

## Debian

The base is `python:3.12-slim`, Debian 13, with the fonts DejaVu
(Bitstream Vera and public domain) and Liberation (OFL-1.1), which
docling.rs draws a PDF's unembedded text with, libgomp, and the libraries
they and Python need.

Each Debian package's license is in `/usr/share/doc/<package>/copyright`.
Their sources are Debian's (`apt-get source <package>`, or
[sources.debian.org](https://sources.debian.org)).
