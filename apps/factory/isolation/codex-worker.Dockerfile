FROM node:22-bookworm-slim

ARG CODEX_VERSION=0.150.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY codex-entrypoint.sh /usr/local/bin/factory-codex-entrypoint
RUN chmod 0555 /usr/local/bin/factory-codex-entrypoint

LABEL org.factory.worker="codex" \
  org.factory.codex.version="0.150.1" \
  org.factory.worker.revision="2"

USER node
ENTRYPOINT ["factory-codex-entrypoint"]
