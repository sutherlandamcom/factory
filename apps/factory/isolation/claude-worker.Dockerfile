FROM node:22-bookworm-slim

ARG CLAUDE_VERSION=2.1.150

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && npm install --global "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

COPY claude-entrypoint.sh /usr/local/bin/factory-claude-entrypoint
RUN chmod 0555 /usr/local/bin/factory-claude-entrypoint

LABEL org.factory.worker="claude" \
  org.factory.claude.version="${CLAUDE_VERSION}" \
  org.factory.worker.revision="1"

USER node
ENTRYPOINT ["factory-claude-entrypoint"]
