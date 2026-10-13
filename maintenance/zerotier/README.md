# Dedicated ZeroTier controller and migration templates

This directory contains the controller migration logic, dedicated systemd service,
TCP API firewall, local authorization helper and health timer. It intentionally
contains no controller identities, tokens, member lists, private addresses or backups.

`*.example` files are migration/installation **templates, not ready-to-run scripts**.
Replace the zero-filled IDs, reserved `192.0.2.x` addresses, example user and paths
with private site configuration. Review every phase before running as root. Node
helpers require a modern Node.js executable; adjust its path on both machines.

Before using the admin helper, create root-owned mode-0600
`/etc/codex-zerotier-controller.json`, outside Git:

```json
{"networkId":"YOUR_16_HEX_NETWORK_ID","home":"/var/lib/zerotier-codex-controller"}
```

The migration preserves the network identity and members. Test the copied controller
offline in a private network namespace first; stop the old controller before starting
the replacement. Arm rollback before cutover and cancel it only after network,
member, original client, web and WebSocket checks pass. Never run duplicate controller
identities online. The current application runtime must not be restarted by this flow.

The installer template references a temporary sudoers grant used for coordinated
rollback; this grant is intentionally not provided. An administrator must establish
and validate a narrowly scoped stop-only grant for their own orchestration account,
then remove it after successful migration. Do not grant general passwordless root.

Local API TCP port 19993 is blocked on non-loopback interfaces; overlay UDP remains
unchanged. The watchdog restarts only this dedicated controller after three local
API failures, with a five-minute cooldown. Web account provisioning is independent:
`maintenance/create-local-member.mjs` reads the new password from stdin and refuses
to reset existing members. Never copy web identities to the former controller host.
