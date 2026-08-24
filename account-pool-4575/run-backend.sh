#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/ls/tools/node-v25.6.1-linux-x64/bin:/home/ls/.local/bin:$PATH"
export HOME="/home/ls"
source "/home/ls/codex_zerotier_remote/config/basic-auth.env"

export HTTP_PROXY="http://127.0.0.1:7897"
export HTTPS_PROXY="http://127.0.0.1:7897"
export ALL_PROXY="socks5://127.0.0.1:7897"
export NO_PROXY="127.0.0.1,localhost,::1,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,100.64.0.0/10,.ts.net,.tail6856d9.ts.net"
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export all_proxy="$ALL_PROXY"
export no_proxy="$NO_PROXY"
export NODE_USE_ENV_PROXY=1

export CODEX_HOME="/home/ls/codex_zerotier_remote/runtime/account-pool/260803"
export CODEX_WEB_CODEX_SESSION_ROOTS="/home/ls/codex_zerotier_remote/runtime/account-pool/260803/sessions:/home/ls/codex_zerotier_remote/runtime/account-pool/260707/sessions"
export CODEX_WEB_ACCOUNT_POOL_FILE="/home/ls/codex_zerotier_remote/users/gyj/account-pool-4575/account-pool.json"
export CODEX_WEB_HOST="127.0.0.1"
export CODEX_WEB_PORT="4576"
export CODEX_WEB_SESSION_COOKIE_NAME="codex_remote_session_4575"
export CODEX_WEB_PROJECT_ROOT="/home/ls"
export CODEX_WEB_ALLOW_OUTSIDE_PROJECT_ROOT="true"
export CODEX_WEB_DATA_DIR="/home/ls/codex_zerotier_remote/users/gyj/account-pool-4575/data/backend"
export CODEX_WEB_CODEX_BIN="/home/ls/.local/bin/codex"
auth_seed_source="/home/ls/codex_zerotier_remote/config/member-passwords.json"
auth_member_file="/home/ls/codex_zerotier_remote/users/gyj/account-pool-4575/data/auth/member-passwords.json"
/home/ls/tools/node-v25.6.1-linux-x64/bin/node \
  /home/ls/codex_zerotier_remote/users/gyj/account-pool-4575/scripts/seed-auth-allowlist.mjs \
  "$auth_seed_source" \
  /home/ls/codex_zerotier_remote/users/gyj/account-pool-4575/data/backend/codex-web.sqlite \
  "$auth_member_file"
export CODEX_WEB_AUTH_USERS_FILE="$auth_member_file"
export CODEX_WEB_LEADERBOARD_ACCOUNT_LABEL="账号池"
export CODEX_WEB_LEADERBOARD_PEERS=""

cd "/home/ls/codex_zerotier_remote/users/gyj/account-pool-4575/backend"
exec /home/ls/tools/node-v25.6.1-linux-x64/bin/node \
  --max-old-space-size=384 \
  --require /home/ls/codex_zerotier_remote/app/node_modules/tsx/dist/preflight.cjs \
  --import file:///home/ls/codex_zerotier_remote/app/node_modules/tsx/dist/loader.mjs \
  server/index.ts
