#!/bin/sh
set -eu

mkdir -p "$CODEX_HOME"
cp /codex-auth/auth.json "$CODEX_HOME/auth.json"
chmod 0600 "$CODEX_HOME/auth.json"
exec codex "$@"
