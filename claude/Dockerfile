# gosidian-claude: a gosidian plugin whose nodes run Claude Code headless on
# the files a pipeline hands it. Claude Code is not in the image (its license
# is not open): the server installs it from npm into the volume
# /var/lib/gosidian-claude at the first start, and again on the update node.
# Node runs the TypeScript sources as they are (type stripping): there is no
# build step.
FROM node:24-alpine

# bash for a preset that allows the Bash tool; a user for each slot of
# CLAUDE_WORKERS (at most 8), who runs Claude Code; tini as PID 1, which reaps
# what a step's processes leave when they are stopped.
RUN apk add --no-cache bash tini \
 && addgroup -g 10001 agent \
 && for i in 1 2 3 4 5 6 7 8; do adduser -D -H -u 1000$i -G agent -s /sbin/nologin agent$i; done \
 && mkdir -p /var/lib/gosidian-claude

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
COPY THIRD_PARTY_NOTICES.md /licenses/

ARG VERSION=dev
ARG REVISION=
ENV PLUGIN_VERSION=${VERSION} NODE_ENV=production
LABEL org.opencontainers.image.title="gosidian-claude" \
      org.opencontainers.image.description="A gosidian plugin whose nodes run Claude Code headless on the files a pipeline hands it (Claude Code is installed at runtime, not shipped)" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/claude" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# The versions of Claude Code, and which one is in use.
VOLUME /var/lib/gosidian-claude

# The server runs as root with only the SETUID and SETGID capabilities (see
# the README): it runs Claude Code as the user of its slot (agent1 to agent8,
# from CLAUDE_UID), who reads neither the credential nor the server's
# environment.
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/src/server.ts", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/src/server.ts"]
