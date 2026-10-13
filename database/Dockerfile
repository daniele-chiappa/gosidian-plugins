# gosidian-database: an archive of vectors (PostgreSQL with pgvector,
# Qdrant, SQLite with sqlite-vec) for gosidian's pipelines and agents.
# cgo for SQLite: built for the platform it runs on (amd64).
FROM golang:1.27-alpine AS build
RUN apk add --no-cache gcc musl-dev sqlite-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY scripts/ ./scripts/
# sqlite-vec from its release's amalgamation, checked against its SHA-256.
RUN sh scripts/sqlite-vec.sh /out/sqlite-vec
COPY *.go ./
ARG VERSION=dev
RUN CGO_ENABLED=1 go build -trimpath -tags timetzdata \
      -ldflags "-s -w -X main.version=${VERSION}" -o /out/gosidian-database . \
 && sh scripts/licenses.sh /out/licenses

FROM alpine:3.24
ARG VERSION=dev
ARG REVISION=
LABEL org.opencontainers.image.title="gosidian-database" \
      org.opencontainers.image.description="An archive of vectors (pgvector, Qdrant, SQLite with sqlite-vec) with embeddings from a preset, for gosidian's pipelines and agents" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/database" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=build /out/gosidian-database /usr/local/bin/gosidian-database
COPY --from=build /out/sqlite-vec/vec0.so /usr/local/lib/sqlite-vec/vec0.so
# The licenses of Go, of the modules in the binary and of sqlite-vec.
COPY --from=build /out/licenses /licenses
COPY licenses/sqlite-vec /licenses/sqlite-vec
COPY THIRD_PARTY_NOTICES.md /licenses/
# /data holds SQLite's files, one per project: a volume.
RUN mkdir -p /data && chown 65532:65532 /data
USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/gosidian-database", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/gosidian-database"]
