FROM node:22-bookworm-slim

ARG KIMI_VERSION=0.39.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep curl jq \
  && curl -fsSL https://code.kimi.com/kimi-code/install.sh \
      | env KIMI_VERSION="${KIMI_VERSION}" KIMI_INSTALL_DIR=/usr/local bash \
  && kimi --version \
  && rm -rf /var/lib/apt/lists/*

COPY kimi-entrypoint.sh /usr/local/bin/factory-kimi-entrypoint
RUN chmod 0555 /usr/local/bin/factory-kimi-entrypoint

LABEL org.factory.worker="kimi" \
  org.factory.kimi.version="${KIMI_VERSION}" \
  org.factory.worker.revision="1"

USER node
ENTRYPOINT ["factory-kimi-entrypoint"]
