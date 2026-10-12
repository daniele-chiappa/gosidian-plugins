# gosidian-docling: the docling plugin of gosidian, on the CPU, with
# LibreOffice for the office formats docling does not read.
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/hf \
    DOCLING_ARTIFACTS_PATH=/models/docling \
    OMP_NUM_THREADS=4

# LibreOffice turns doc, xls, ppt, rtf and the OpenDocument files into
# docx, xlsx and pptx, which docling reads (about 600 MB more).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-dejavu-core fonts-liberation2 \
 && rm -rf /var/lib/apt/lists/*

# The CPU builds of torch: the CUDA ones are gigabytes the plugin never uses.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.14.0 torchvision==0.29.0
# The rest resolves as PyPI stood on PYPI_BEFORE: the same build every time,
# and no package younger than two weeks at release (rapidocr 3.10.0 broke
# docling 2.130 two days after it came out).
ARG PYPI_BEFORE=2026-09-26T00:00:00Z
COPY requirements.txt /app/requirements.txt
RUN pip install uv==0.12.19 \
 && uv pip install --system --exclude-newer "${PYPI_BEFORE}" -r /app/requirements.txt \
 && pip uninstall -y uv

# The models live in the image: the plugin needs no network at run time.
RUN docling-tools models download -o /models/docling layout tableformer picture_classifier rapidocr \
 && chmod -R a+rX /models

# The licenses of what the image holds (THIRD_PARTY_NOTICES.md), and each
# model's beside it: a model folder renamed by docling fails the build, and
# the notices are checked again.
COPY licenses/ THIRD_PARTY_NOTICES.md /licenses/
RUN cd /models/docling \
 && cp /licenses/CDLA-Permissive-2.0.txt docling-project--docling-models/LICENSE \
 && cp /licenses/Apache-2.0.txt docling-project--docling-layout-heron/LICENSE \
 && cp /licenses/Apache-2.0.txt docling-project--docling-layout-heron-onnx/LICENSE \
 && cp /licenses/MIT.txt docling-project--DocumentFigureClassifier-v2.5/LICENSE \
 && cp /licenses/Apache-2.0.txt RapidOcr/LICENSE

COPY server.py /app/server.py
ARG VERSION=dev
ARG REVISION=
ENV PLUGIN_VERSION=${VERSION}
LABEL org.opencontainers.image.title="gosidian-docling" \
      org.opencontainers.image.description="The docling plugin of gosidian: documents to markdown with their pictures" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/docling" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"]
CMD ["python", "/app/server.py"]
