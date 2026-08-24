#!/usr/bin/env bash
set -euo pipefail

test_root="/home/ls/codex_zerotier_remote/users/gyj/account-pool-4575"
lock_file="$test_root/data/260803-live-sync.lock"

exec 9>"$lock_file"
flock -n 9 || exit 0

export CODEX_260803_SYNC_SKIP_POOL_STATE=true
exec nice -n 10 ionice -c 2 -n 7 \
  /home/ls/tools/node-v25.6.1-linux-x64/bin/node \
  "$test_root/scripts/sync-current-260803.mjs" \
  /home/ls/codex_zerotier_remote/runtime/codex-home \
  /home/ls/codex_zerotier_remote/runtime/account-pool/260803 \
  /home/ls/codex_zerotier_remote/data/codex-web/codex-web.sqlite \
  "$test_root/data/backend/codex-web.sqlite" \
  "$test_root/data/account-pool-state.json"
