# gosidian-pi: a gosidian plugin whose node runs a pi agent (pi.dev) on the
# files a pipeline hands it. Node runs the TypeScript sources as they are
# (type stripping): there is no build step.
FROM node:25-alpine

# ripgrep and fd for pi's grep and find tools (else pi would download them),
# bash for a preset that allows the bash tool; a user for each slot of
# PI_WORKERS (at most 8), who runs pi; tini as PID 1, which reaps what a
# step's processes leave when they are stopped.
RUN apk add --no-cache ripgrep fd bash tini \
 && addgroup -g 10001 agent \
 && for i in 1 2 3 4 5 6 7 8; do adduser -D -H -u 1000$i -G agent -s /sbin/nologin agent$i; done

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
COPY THIRD_PARTY_NOTICES.md /licenses/

ARG VERSION=dev
ARG REVISION=
ENV PLUGIN_VERSION=${VERSION} NODE_ENV=production
LABEL org.opencontainers.image.title="gosidian-pi" \
      org.opencontainers.image.description="A gosidian plugin whose node runs a pi agent (pi.dev) on the files a pipeline hands it" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/pi" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# The server runs as root with only the SETUID and SETGID capabilities (see
# the README): it runs pi as the user of its slot (agent1 to agent8, from
# PI_UID), who reads neither the endpoint's key nor the server's environment.
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/src/server.ts", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/src/server.ts"]
