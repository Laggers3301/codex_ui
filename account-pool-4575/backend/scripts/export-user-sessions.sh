#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/home/ls/codex_zerotier_remote/app"
export HOME="/home/ls"
export PATH="/home/ls/tools/node-v25.6.1-linux-x64/bin:/home/ls/.local/bin:$PATH"
export CODEX_HOME="/home/ls/codex_zerotier_remote/runtime/codex-home"
export CODEX_WEB_DATA_DIR="/home/ls/codex_zerotier_remote/data/codex-web"
export CODEX_WEB_INSTANCE_LABEL="little-right"

cd "$APP_ROOT"
exec node \
  --require "$APP_ROOT/node_modules/tsx/dist/preflight.cjs" \
  --import "file://$APP_ROOT/node_modules/tsx/dist/loader.mjs" \
  scripts/export-user-sessions.ts "$@"
