# Third-party notices: gosidian-ocr

The plugin's own code (`server.py`, its tests, the Dockerfile) is
MIT-licensed (the `LICENSE` at the root of this repository). Its image
holds the works of others, unmodified, under their own licenses; the texts
this folder adds are in the image under `/licenses`.

## The model

The image holds no model. The plugin calls a server of the operator's
choice that serves MinerU2.5
([opendatalab/MinerU2.5-Pro-2605-1.2B](https://huggingface.co/opendatalab/MinerU2.5-Pro-2605-1.2B),
Apache-2.0); whoever runs that server takes its weights under their
license. The MinerU program (its own MinerU Open Source License) is
neither in the image nor called.

## Python

Python 3.12 (PSF-2.0), and 38 packages installed with pip:

| Package | License |
|---|---|
| mineru-vl-utils (the model's client), python-multipart, opentelemetry-api, aiofiles | Apache-2.0 |
| mcp, mcp-types, anyio, attrs, annotated-types, h11, httpx-retries, jsonschema, jsonschema-specifications, loguru, pydantic, pydantic-core, PyJWT, referencing, rpds-py, truststore, typing-inspection | MIT |
| pypdfium2 (with PDFium) | BSD-3-Clause and Apache-2.0 |
| httpx, httpx2, httpcore, httpcore2, idna, click, pycparser, sse-starlette, starlette, uvicorn | BSD-3-Clause |
| cryptography | Apache-2.0 or BSD-3-Clause |
| pillow | MIT-CMU |
| cffi | MIT-0 |
| tqdm | MPL-2.0 and MIT |
| certifi | MPL-2.0 |
| typing-extensions | PSF-2.0 |

Each package's license, as it ships it, is in its `*.dist-info` folder
under `/usr/local/lib/python3.12/site-packages`, where `pip show` and
`pip-licenses` read it. certifi and tqdm are under the MPL-2.0, whose
source is that of the packages as published on PyPI, unmodified.

## Debian

The base is `python:3.12-slim`, Debian 13, with its packages under their
licenses in `/usr/share/doc/*/copyright`.

## The texts

`licenses/Apache-2.0.txt` and `licenses/MIT.txt`, in the image as
`/licenses/Apache-2.0.txt` and `/licenses/MIT.txt`.
