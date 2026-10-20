# gosidian-exec: a gosidian plugin whose node runs a script or a command in
# its sandbox, with the toolchains (git, Node, Go, Python, a C compiler), or
# on a host of its preset over SSH. Node runs the TypeScript sources as they
# are (type stripping): there is no build step.

# Go from its official image: Alpine's go is older than the projects need.
FROM golang:1.27-alpine AS go

FROM node:24-alpine
COPY --from=go /usr/local/go /usr/local/go

# The toolchains of the steps: git, Python with pip, make and a C/C++
# compiler (build-base), bash for the scripts; openssh-client and GNU tar
# for the hosts; tini as PID 1, which reaps what a step's processes leave
# when they are stopped. A user and a group for each slot of EXEC_WORKERS (at
# most 8), who runs the steps: exec1 to exec8, 10101 to 10108 (the agent plugins have 10001 up: the
# count of processes goes by user ID across the host). The cache of
# the projects' dependencies (cache: project) is a volume.
RUN apk add --no-cache bash tini git openssh-client tar python3 py3-pip make build-base \
 && for i in 1 2 3 4 5 6 7 8; do addgroup -g 1010$i exec$i && adduser -D -H -u 1010$i -G exec$i -s /sbin/nologin exec$i; done \
 && mkdir -p /var/cache/gosidian-exec && chmod 711 /var/cache/gosidian-exec

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
# The code the plugins share (agent-kit/ of the repository), as the build
# context kit: docker build --build-context kit=agent-kit exec/.
COPY --from=kit *.ts ./src/kit/
COPY THIRD_PARTY_NOTICES.md /licenses/

ARG VERSION=dev
ARG REVISION=
ENV PLUGIN_VERSION=${VERSION} NODE_ENV=production EXEC_IMAGE=ghcr.io/daniele-chiappa/gosidian-exec:${VERSION}
LABEL org.opencontainers.image.title="gosidian-exec" \
      org.opencontainers.image.description="A gosidian plugin whose node runs a script or a command in its sandbox (git, Node, Go, Python), or on a host of its preset over SSH" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/exec" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

VOLUME /var/cache/gosidian-exec

# The server runs as root with only the SETUID and SETGID capabilities (see
# the README): it runs each step as the user of its slot (exec1 to exec8,
# from EXEC_UID), who reads neither the hosts' keys nor the server's
# environment, and cannot enter another slot's folder.
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/src/server.ts", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/src/server.ts"]
