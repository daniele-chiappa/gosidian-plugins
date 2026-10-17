#!/bin/sh
# test.sh [unittest flags]: the tests of the slides (test_slides.py) and of
# the Word documents and the text inside pictures (test_office.py), in
# Python 3.12 with docling's pptx and docx readers (docling-slim[
# convert-core,format-pptx,format-docx]) and the server's packages, at the
# image's versions and as PyPI stood on its PYPI_BEFORE: not the image, 5 GB
# with its models and LibreOffice, which the tests do not need.
set -eu
cd "$(dirname "$0")/.."
PYPI_BEFORE=$(sed -n 's/^ARG PYPI_BEFORE=//p' Dockerfile)
DOCLING=$(sed -n 's/^docling==//p' requirements.txt)
docker run --rm -v "$PWD:/src:ro" -w /src -e PYTHONDONTWRITEBYTECODE=1 -e PIP_DISABLE_PIP_VERSION_CHECK=1 python:3.12-slim sh -c "
  pip install -q --root-user-action=ignore uv==0.12.19 &&
  uv pip install -q --system --exclude-newer '$PYPI_BEFORE' 'docling-slim[convert-core,format-pptx,format-docx]==$DOCLING' \$(grep -v -e '^docling==' -e '^#' requirements.txt) &&
  python -m unittest ${*:--v} test_slides test_office"
