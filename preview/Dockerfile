# gosidian-preview: a gosidian plugin that serves the static build of a
# branch at an address that expires, each preview in an opaque origin of its
# own, and tries it with a Playwright server. Node runs the TypeScript
# sources as they are (type stripping): there is no build step. No browser
# in the image: the check node drives a Playwright server of the preset's.
FROM node:24-alpine

# tini as PID 1. The previews live in a volume, the user node's (1000): the
# plugin runs no code of a zip and needs no privilege.
RUN apk add --no-cache tini \
 && mkdir -p /var/lib/gosidian-preview /etc/gosidian-preview \
 && chown node:node /var/lib/gosidian-preview && chmod 750 /var/lib/gosidian-preview

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
COPY THIRD_PARTY_NOTICES.md /licenses/

ARG VERSION=dev
ARG REVISION=
ENV PLUGIN_VERSION=${VERSION} NODE_ENV=production
LABEL org.opencontainers.image.title="gosidian-preview" \
      org.opencontainers.image.description="A gosidian plugin that serves the static build of a branch at an address that expires, isolated in an opaque origin, and tries it with a Playwright server" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/preview" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

VOLUME /var/lib/gosidian-preview
USER node
# 8000: MCP for gosidian (/mcp, /health). 8080: the previews, for the
# browsers (/p/<id>/, /health).
EXPOSE 8000 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/src/server.ts", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/src/server.ts"]
