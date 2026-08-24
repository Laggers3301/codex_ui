#!/usr/bin/env bash
set -euo pipefail

test_root="/home/ls/codex_zerotier_remote/users/gyj/account-pool-4575"
runtime_root="/home/ls/codex_zerotier_remote/runtime"
latest_pointer="$test_root/data/latest-migration-backup-path"
check_only=false
if [[ "${1:-}" == "--check" ]]; then
  check_only=true
  shift
fi
backup_dir="${1:-}"

if [[ -z "$backup_dir" ]]; then
  [[ -f "$latest_pointer" ]] || { echo "Missing migration backup pointer: $latest_pointer" >&2; exit 2; }
  backup_dir="$(<"$latest_pointer")"
fi

case "$backup_dir" in
  "$runtime_root"/account-pool-backups/260707-migration-*) ;;
  *) echo "Refusing unexpected backup path: $backup_dir" >&2; exit 3 ;;
esac

[[ -d "$backup_dir/account-home-260707" ]] || { echo "Missing account-home backup" >&2; exit 4; }
[[ -d "$backup_dir/backend-data" ]] || { echo "Missing backend-data backup" >&2; exit 4; }
[[ -f "$backup_dir/account-pool-state.json" ]] || { echo "Missing account-pool state backup" >&2; exit 4; }

if [[ "$check_only" == true ]]; then
  echo "Rollback backup is complete: $backup_dir"
  exit 0
fi

rollback_stamp="$(date +%Y%m%d_%H%M%S)"
rollback_capture="$runtime_root/account-pool-backups/rollback-capture-$rollback_stamp"
mkdir -p "$rollback_capture"
chmod 700 "$rollback_capture"

# A later 260803 mirror may be active against the same backend database. Stop
# it first so the rollback snapshot cannot be modified between mv/cp steps.
systemctl --user disable --now codex-260803-live-sync.timer >/dev/null 2>&1 || true
systemctl --user stop codex-260803-live-sync.service >/dev/null 2>&1 || true
systemctl --user stop codex-account-pool-4576.service

current_account_home="$runtime_root/account-pool/260707"
current_backend_data="$test_root/data/backend"
mv "$current_account_home" "$rollback_capture/account-home-260707"
mv "$current_backend_data" "$rollback_capture/backend-data"
cp -a "$backup_dir/account-home-260707" "$current_account_home"
cp -a "$backup_dir/backend-data" "$current_backend_data"
cp -a "$backup_dir/account-pool-state.json" "$test_root/data/account-pool-state.json"

systemctl --user start codex-account-pool-4576.service
systemctl --user is-active codex-account-pool-4576.service
echo "Rollback restored from: $backup_dir"
echo "Pre-rollback state preserved at: $rollback_capture"
