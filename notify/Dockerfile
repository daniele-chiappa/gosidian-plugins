# gosidian-notify: a gosidian plugin that notifies the people and rooms of
# its preset on Telegram, ntfy and email, and takes their answer to a
# question back to the run. Node runs the TypeScript sources as they are
# (type stripping): there is no build step. Nothing is added to the base
# image but tini: Telegram and ntfy are plain HTTPS, email is nodemailer.
FROM node:24-alpine

# tini as PID 1. The state (held messages, open questions, the topics the
# bot made) lives in a volume, the user node's (1000); the plugin needs no
# privilege.
RUN apk add --no-cache tini \
 && mkdir -p /var/lib/gosidian-notify /etc/gosidian-notify \
 && chown node:node /var/lib/gosidian-notify && chmod 700 /var/lib/gosidian-notify

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
COPY THIRD_PARTY_NOTICES.md /licenses/

ARG VERSION=dev
ARG REVISION=
ENV PLUGIN_VERSION=${VERSION} NODE_ENV=production
LABEL org.opencontainers.image.title="gosidian-notify" \
      org.opencontainers.image.description="A gosidian plugin that notifies the people and rooms of its preset on Telegram, ntfy and email, and takes their answer to a question back to the run" \
      org.opencontainers.image.source="https://github.com/daniele-chiappa/gosidian-plugins" \
      org.opencontainers.image.url="https://github.com/daniele-chiappa/gosidian-plugins/tree/main/notify" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

VOLUME /var/lib/gosidian-notify
USER node
# 8000: MCP for gosidian (/mcp, /health). 8080: the reply page, for the
# people's browsers (/r/<token>, /health).
EXPOSE 8000 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/src/server.ts", "healthcheck"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/src/server.ts"]
