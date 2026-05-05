#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

bun install --frozen-lockfile

if [ ! -f wrangler.api.toml ]; then
  cp wrangler.api.example.toml wrangler.api.toml
fi
