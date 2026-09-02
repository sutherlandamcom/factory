#!/bin/sh
# Factory Claude Code worker entrypoint.
# Materializes the Factory-supplied ephemeral settings.json into
# CLAUDE_CONFIG_DIR, reads the task prompt from stdin, and executes one
# non-interactive Claude Code run. Credentials arrive only via the
# ANTHROPIC_AUTH_TOKEN container environment (never on disk).
set -eu

mkdir -p "${CLAUDE_CONFIG_DIR:?}"
cp /claude-config/settings.json "${CLAUDE_CONFIG_DIR}/settings.json"
chmod 0600 "${CLAUDE_CONFIG_DIR}/settings.json"

prompt="$(cat)"

# Factory always passes --output-format json via CMD for provenance.
exec claude -p "$prompt" "$@"
