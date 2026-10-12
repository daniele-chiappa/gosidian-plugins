# gosidian-storage: remote stores as sources of gosidian's IN folders,
# read with rclone in the process.
# Compiled on the build platform for the target one (amd64, arm64): no
# emulation, and nothing runs in the final stage.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY scripts/licenses.sh ./scripts/
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
# timetzdata: the time zones inside the binary, for an image without tzdata.
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -tags timetzdata \
      -ldflags "-s -w -X main.version=${VERSION}" -o /out/gosidian-storage . \
 && GOOS=$TARGETOS GOARCH=$TARGETARCH sh scripts/licenses.sh /out/licenses

FROM alpine:3.24
ARG VERSION=dev
ARG REVISION=
LABEL org.opencontainers.image.title="gosidian-storage" \
      org.opencontainers.image.description="Remote stores (WebDAV, S3, Google Drive, local folders) as sources of gosidian's IN folders" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/storage" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
COPY --from=build /out/gosidian-storage /usr/local/bin/gosidian-storage
# The licenses of Go and of the modules in the binary, and what they are.
COPY --from=build /out/licenses /licenses
COPY THIRD_PARTY_NOTICES.md /licenses/
# HOME for rclone, which may look for a cache there; the container can run
# read-only with a tmpfs on /tmp.
ENV HOME=/tmp
USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/gosidian-storage", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/gosidian-storage"]
