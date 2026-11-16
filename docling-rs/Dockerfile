# gosidian-docling-rs: the docling.rs plugin of gosidian, on the CPU. The
# reader is the docling-rs binary of the project's own image, with its
# models; the plugin around it is Python, with docling-core for the
# markdown. No torch, no LibreOffice.

# docling.rs, by version and digest. Its speech and chunking models go: the
# plugin converts documents.
FROM ghcr.io/docling-project/docling-rs:2.82.1@sha256:bd44e858da69f7c378fa75842e123b021196cdf4f35737580891ef325d1504c0 AS engine
USER root
RUN rm -rf /app/.models/asr /app/.models/chunk \
 && /usr/local/bin/docling-rs --version

FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    DOCLING_RS_MODELS_DIR=/models \
    DOCLING_RS_SYSTEM_FONTS=0 \
    DOCLING_RS_FONT_DIRS=/usr/share/fonts/truetype/liberation:/usr/share/fonts/truetype/dejavu

# Debian's security fixes the base image does not have yet, and the fonts
# docling.rs draws a PDF's unembedded text with, as its own image has them.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-dejavu-mono fonts-liberation libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# The packages resolve as PyPI stood on PYPI_BEFORE: the same build every
# time, and no package younger than two weeks at release.
ARG PYPI_BEFORE=2026-10-12T07:00:00Z
# Packages taken newer than PYPI_BEFORE, each as PyPI stood just after its
# release: Pillow 13 and certifi for their advisories, and the docling-core
# that allows Pillow 13. Python's own copy of pip for new virtual
# environments goes: the plugin makes none, and its pip is an old one.
ARG PYPI_NEWER="pillow=2026-10-16T22:20:00Z certifi=2026-10-23T11:45:00Z doclang=2026-10-15T14:55:00Z docling-core=2026-10-22T14:05:00Z"
COPY requirements.txt /app/requirements.txt
RUN pip install uv==0.12.19 \
 && uv pip install --system --exclude-newer "${PYPI_BEFORE}" \
      $(for p in ${PYPI_NEWER}; do printf -- '--exclude-newer-package %s ' "$p"; done) -r /app/requirements.txt \
 && pip uninstall -y uv \
 && rm -f /usr/local/lib/python3.12/ensurepip/_bundled/pip-*.whl

# The binary and the models, with the notices and the licence texts
# docling.rs ships beside them (MODELS_NOTICE.md, models.json, LICENSE-*).
COPY --from=engine /usr/local/bin/docling-rs /usr/local/bin/docling-rs
COPY --from=engine /app/.models /models

# The licenses of what the image holds (THIRD_PARTY_NOTICES.md).
COPY licenses/ THIRD_PARTY_NOTICES.md /licenses/

COPY server.py /app/server.py
ARG VERSION=dev
ARG REVISION=
ENV PLUGIN_VERSION=${VERSION}
LABEL org.opencontainers.image.title="gosidian-docling-rs" \
      org.opencontainers.image.description="The docling.rs plugin of gosidian: documents to markdown with their pictures, with the Rust port of docling" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/docling-rs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

USER 65532:65532
WORKDIR /tmp
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
CMD ["python", "/app/server.py"]
