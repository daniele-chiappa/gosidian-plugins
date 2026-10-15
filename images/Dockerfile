# gosidian-images: images converted without loss (PNG optimized, WebP),
# TIFF to PNG, which the vault takes, scaled down on request. Compiled on
# the build platform for the target one (the CI builds amd64): no
# emulation, and nothing runs in the final stage but apk.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY scripts/licenses.sh ./scripts/
ARG TARGETOS=linux
ARG TARGETARCH=amd64
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
      -ldflags "-s -w -X main.version=${VERSION}" -o /out/gosidian-images . \
 && GOOS=$TARGETOS GOARCH=$TARGETARCH sh scripts/licenses.sh /out/licenses

FROM alpine:3.24
ARG VERSION=dev
ARG REVISION=
LABEL org.opencontainers.image.title="gosidian-images" \
      org.opencontainers.image.description="Images converted without loss (PNG optimized, WebP), TIFF to PNG, which gosidian takes, for its pipelines and agents" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/images" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
# libvips reads every format and scales down; oxipng optimizes a PNG; cwebp
# writes WebP without loss. Alpine's packages: every package of the image,
# its version and its license, in /licenses/PROGRAMS.
RUN apk add --no-cache vips-tools libwebp-tools oxipng \
 && mkdir -p /licenses \
 && apk list --installed 2>/dev/null | sort > /licenses/PROGRAMS
COPY --from=build /out/gosidian-images /usr/local/bin/gosidian-images
# The licenses of Go and of the modules in the binary, and what they are.
COPY --from=build /out/licenses /licenses/go-modules
COPY THIRD_PARTY_NOTICES.md /licenses/
# The images are written under /tmp while they are converted: the
# container can run read-only with a tmpfs there. libvips refuses the
# loaders it marks untrusted, not fuzzed for files from anyone (SVG, PPM,
# FITS, OpenEXR, JPEG 2000…): PNG, JPEG, GIF, WebP and TIFF, all the plugin
# reads, are not among them.
ENV HOME=/tmp VIPS_BLOCK_UNTRUSTED=1
USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/gosidian-images", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/gosidian-images"]
