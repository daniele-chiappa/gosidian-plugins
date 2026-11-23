# gosidian-office: the office of a team of agents, a page gosidian opens in
# a window of its own for the notes type: team. The page is TypeScript and
# three.js, built here with Vite (its tests run first); the server is Go,
# compiled on the build platform for the target one (the CI builds amd64).
FROM --platform=$BUILDPLATFORM node:24-alpine AS page
WORKDIR /w
COPY web/package.json web/package-lock.json ./
# No install scripts: none of the page's packages needs one.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
COPY web/public ./public
COPY web/scripts ./scripts
COPY web/test ./test
RUN npx vitest run \
 && npm run build \
 && node scripts/licenses.mjs /out/licenses

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
      -ldflags "-s -w -X main.version=${VERSION}" -o /out/gosidian-office . \
 && GOOS=$TARGETOS GOARCH=$TARGETARCH sh scripts/licenses.sh /out/licenses

FROM alpine:3.24
# The base's packages at their latest fixes: an image tag lags the Alpine
# repository (on 2026-11-20 alpine:3.24 still had zlib 1.3.2-r1, the repository 1.4-r0).
RUN apk upgrade --no-cache
ARG VERSION=dev
ARG REVISION=
LABEL org.opencontainers.image.title="gosidian-office" \
      org.opencontainers.image.description="The office of a team of agents for gosidian: a map in a window of gosidian, for the notes type: team" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/office" \
      org.opencontainers.image.licenses="MIT AND CC0-1.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN mkdir -p /licenses && apk list --installed 2>/dev/null | sort > /licenses/PROGRAMS
COPY --from=build /out/gosidian-office /usr/local/bin/gosidian-office
COPY --from=page /w/dist /usr/share/gosidian-office/site
# The licenses of Go and of the modules in the binary, of the packages the
# page bundles, and of the 3D models; the references' page reads them.
COPY --from=build /out/licenses /licenses/go-modules
COPY --from=page /out/licenses /licenses/web
COPY assets/ASSETS.tsv assets/LICENSE-KayKit-Furniture-Bits.txt assets/LICENSE-Kenney-Mini-Characters.txt /licenses/assets/
COPY THIRD_PARTY_NOTICES.md /licenses/
# It keeps nothing: it serves the page's files, read-only. The container
# can run read-only.
USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/gosidian-office", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/gosidian-office"]
