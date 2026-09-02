#!/bin/sh
# Factory Kimi Code worker entrypoint.
# Materializes the Factory-supplied ephemeral config (with the per-run
# OpenRouter credential) into KIMI_CODE_HOME, reads the task prompt from
# stdin, and executes one non-interactive Kimi Code run.
set -eu

mkdir -p "${KIMI_CODE_HOME:?}"
cp /kimi-config/config.toml "${KIMI_CODE_HOME}/config.toml"
chmod 0600 "${KIMI_CODE_HOME}/config.toml"

prompt="$(cat)"

# Factory always passes --output-format stream-json via CMD for provenance.
exec kimi --prompt "$prompt" "$@"
