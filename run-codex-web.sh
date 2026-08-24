#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/ls/.local/bin:/home/ls/miniconda3/bin:$PATH"
export HOME="/home/ls"
CONFIG_ROOT="/home/ls/codex_zerotier_remote/config"
DATA_ROOT="/home/ls/codex_zerotier_remote/data/codex-web"
USERS_ROOT="/home/ls/codex_zerotier_remote/users"
CODEX_RUNTIME_HOME="/home/ls/codex_zerotier_remote/runtime/codex-home"
mkdir -p "$CONFIG_ROOT" "$DATA_ROOT" "$USERS_ROOT" "$CODEX_RUNTIME_HOME"
if [[ -f "/home/ls/.codex/auth.json" && ! -f "$CODEX_RUNTIME_HOME/auth.json" ]]; then
  cp "/home/ls/.codex/auth.json" "$CODEX_RUNTIME_HOME/auth.json"
fi
if [[ -f "/home/ls/.codex/config.toml" && ! -f "$CODEX_RUNTIME_HOME/config.toml" ]]; then
  cp "/home/ls/.codex/config.toml" "$CODEX_RUNTIME_HOME/config.toml"
fi
if [[ -f "$CONFIG_ROOT/basic-auth.env" ]]; then
  source "$CONFIG_ROOT/basic-auth.env"
fi
export CODEX_HOME="$CODEX_RUNTIME_HOME"
export CODEX_WEB_AUTH_USERS_FILE="/home/ls/codex_zerotier_remote/config/member-passwords.json"
export HTTP_PROXY="http://127.0.0.1:7897"
export HTTPS_PROXY="http://127.0.0.1:7897"
export ALL_PROXY="socks5://127.0.0.1:7897"
export NO_PROXY="127.0.0.1,localhost,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12"
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export all_proxy="$ALL_PROXY"
export no_proxy="$NO_PROXY"
export NODE_USE_ENV_PROXY=1
export CODEX_WEB_HOST="0.0.0.0"
export CODEX_WEB_PORT="4573"
export CODEX_WEB_SESSION_COOKIE_NAME="codex_remote_session_4574"
export CODEX_WEB_LEADERBOARD_PEERS="http://192.168.250.36:4573"
export CODEX_WEB_LEADERBOARD_PEER_TOKEN="codex-web-leaderboard-260707-20260803"
export CODEX_WEB_LEADERBOARD_ACCOUNT_LABEL="260803"
export CODEX_WEB_LEADERBOARD_PEER_LABELS="260707"
export CODEX_WEB_PROJECT_ROOT="/home/ls"
export CODEX_WEB_ALLOW_OUTSIDE_PROJECT_ROOT="true"
export CODEX_WEB_DATA_DIR="/home/ls/codex_zerotier_remote/data/codex-web"
export CODEX_WEB_CODEX_BIN="${CODEX_WEB_CODEX_BIN:-$(command -v codex)}"
export CODEX_WEB_HANDOFF_SOURCE_HOST="10.244.0.10"
export CODEX_WEB_HANDOFF_SOURCE_USER="ls"
export CODEX_WEB_HANDOFF_SOURCE_APP_DIR="/home/ls/codex_zerotier_remote/app"
export CODEX_WEB_HANDOFF_SOURCE_LABEL="codex1"
cd "/home/ls/codex_zerotier_remote/app"
exec node --require /home/ls/codex_zerotier_remote/app/node_modules/tsx/dist/preflight.cjs --import file:///home/ls/codex_zerotier_remote/app/node_modules/tsx/dist/loader.mjs server/index.ts
