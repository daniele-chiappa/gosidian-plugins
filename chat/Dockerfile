# gosidian-chat: bots, a chat on the documents of a project, as a widget
# any page loads and as a page of its own, answered by a pipeline of
# gosidian. The widget is TypeScript built here into chat.js; the server is
# Go, compiled on the build platform for the target one (the CI builds
# amd64).
FROM --platform=$BUILDPLATFORM node:24-alpine AS widget
WORKDIR /w
COPY widget/package.json widget/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY widget/tsconfig.json ./
COPY widget/src ./src
RUN npx tsc -p .

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
      -ldflags "-s -w -X main.version=${VERSION}" -o /out/gosidian-chat . \
 && GOOS=$TARGETOS GOARCH=$TARGETARCH sh scripts/licenses.sh /out/licenses

FROM alpine:3.24
ARG VERSION=dev
ARG REVISION=
LABEL org.opencontainers.image.title="gosidian-chat" \
      org.opencontainers.image.description="Bots for gosidian: a chat on the documents of a project, as a widget for any page and a page of its own, answered by a pipeline" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/chat" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN mkdir -p /licenses && apk list --installed 2>/dev/null | sort > /licenses/PROGRAMS
COPY --from=build /out/gosidian-chat /usr/local/bin/gosidian-chat
COPY --from=widget /w/dist/chat.js /usr/share/gosidian-chat/chat.js
# The licenses of Go and of the modules in the binary, and what they are.
COPY --from=build /out/licenses /licenses/go-modules
COPY THIRD_PARTY_NOTICES.md /licenses/
# It keeps nothing on disk: the bots and their secrets live in memory, and
# gosidian hands them again every five minutes. The container can run
# read-only.
USER 65532:65532
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/gosidian-chat", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/gosidian-chat"]
