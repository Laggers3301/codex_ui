#!/usr/bin/env bash
set -euo pipefail
[[ $# == 0 ]] || exit 2
systemctl stop codex-zerotier-controller.service
[[ "$(systemctl show codex-zerotier-controller.service -p MainPID --value)" == 0 ]]
