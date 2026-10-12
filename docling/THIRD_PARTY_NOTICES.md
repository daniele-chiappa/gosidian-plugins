# Third-party notices: gosidian-docling

The plugin's own code (`server.py`, the Dockerfile) is MIT-licensed (the
`LICENSE` at the root of this repository). Its image holds the works of
others, unmodified, under their own licenses; the texts this folder adds
are in the image under `/licenses`.

## The models

Downloaded at build time with `docling-tools models download` from
Hugging Face, into `/models/docling`. Each model's folder holds a copy
of its license as `LICENSE`.

| Model | What for | License |
|---|---|---|
| [docling-project/docling-models](https://huggingface.co/docling-project/docling-models) (TableFormer) | tables | CDLA-Permissive-2.0: the text is `licenses/CDLA-Permissive-2.0.txt` |
| [docling-project/docling-layout-heron](https://huggingface.co/docling-project/docling-layout-heron) and its ONNX build | the layout of a page | Apache-2.0 |
| [docling-project/DocumentFigureClassifier-v2.5](https://huggingface.co/docling-project/DocumentFigureClassifier-v2.5) | the kind of a picture | MIT, as its model card declares |
| PP-OCR (PP-OCRv6 detection and recognition, the mobile direction classifier), from [RapidOCR](https://github.com/RapidAI/RapidOCR), from [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | text in pictures and scans | Apache-2.0 |

## Python

Python 3.12 (PSF-2.0), and 114 packages installed with pip. The main ones:

| Package | License |
|---|---|
| docling, docling-core, docling-ibm-models, docling-parse | MIT |
| mcp | MIT |
| torch (CPU build), transformers, huggingface-hub, safetensors, rapidocr | Apache-2.0 |
| torchvision, uvicorn, numpy, scipy | BSD |
| pypdfium2 (with PDFium) | BSD-3-Clause and Apache-2.0 |
| pillow | MIT-CMU |

Each package's license, as it ships it, is in its `*.dist-info` folder
under `/usr/local/lib/python3.12/site-packages`, where `pip show` and
`pip-licenses` read it.

## Debian

The base is `python:3.12-slim`, Debian 13, with:

- **LibreOffice** 25.2 (Writer, Calc and Impress without a GUI), which
  turns the office formats into PDF or XLSX: MPL-2.0;
- the fonts DejaVu (Bitstream Vera and public domain), Liberation 2
  (OFL-1.1) and OpenSymbol;
- the libraries they and Python need.

Each Debian package's license is in `/usr/share/doc/<package>/copyright`.
Their sources are Debian's (`apt-get source <package>`, or
[sources.debian.org](https://sources.debian.org)).
