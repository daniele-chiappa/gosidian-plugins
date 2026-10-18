# gosidian-ocr: the OCR plugin of gosidian. The model, MinerU2.5, runs in a
# server of its own (a llama-server or vLLM, on a GPU): the image holds its
# client, PDFium to draw the pages, and the plugin.
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

# The packages resolve as PyPI stood on PYPI_BEFORE: the same build every
# time, and no package younger than two weeks at release.
ARG PYPI_BEFORE=2026-10-03T12:00:00Z
COPY requirements.txt /app/requirements.txt
RUN pip install uv==0.12.19 \
 && uv pip install --system --exclude-newer "${PYPI_BEFORE}" -r /app/requirements.txt \
 && pip uninstall -y uv

# The licenses of what the image holds (THIRD_PARTY_NOTICES.md).
COPY licenses/ THIRD_PARTY_NOTICES.md /licenses/

COPY server.py /app/server.py
ARG VERSION=dev
ARG REVISION=
ENV PLUGIN_VERSION=${VERSION}
LABEL org.opencontainers.image.title="gosidian-ocr" \
      org.opencontainers.image.description="The OCR plugin of gosidian: scans and hard PDFs to markdown with an OCR vision model" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/ocr" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
CMD ["python", "/app/server.py"]
