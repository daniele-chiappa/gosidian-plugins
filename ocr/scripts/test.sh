#!/bin/sh
# test.sh [unittest flags]: the tests of the plugin (test_ocr.py), in
# Python 3.12 with the server's packages, as PyPI stood on the image's
# PYPI_BEFORE. A fake model's server answers in the tests: no GPU, no model.
set -eu
cd "$(dirname "$0")/.."
PYPI_BEFORE=$(sed -n 's/^ARG PYPI_BEFORE=//p' Dockerfile)
NEWER=$(sed -n 's/^ARG PYPI_NEWER="\(.*\)"$/\1/p' Dockerfile | sed 's/[^ ][^ ]*/--exclude-newer-package &/g')
docker run --rm -v "$PWD:/src:ro" -w /src -e PYTHONDONTWRITEBYTECODE=1 -e PIP_DISABLE_PIP_VERSION_CHECK=1 python:3.12-slim sh -c "
  pip install -q --root-user-action=ignore uv==0.12.19 &&
  uv pip install -q --system --exclude-newer '$PYPI_BEFORE' $NEWER -r requirements.txt &&
  python -m unittest ${*:--v} test_ocr"
