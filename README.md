# Codex UI account pool

React/Vite frontend and Fastify backend for a multi-user Codex app-server pool. This repository mirrors the application source; it does **not** contain any live accounts, credentials, sessions, uploads, databases, or deployment state.

## Source layout

- `src/`, `public/`, `index.html`: chat UI, editor, tool timeline, search, image viewer, review/diff panel, worktrees, terminal, hooks, themes, and notification client.
- `server/`: authenticated API/WebSocket backend, account routing, persistence, quotas, session indexing, Git worktrees, hooks, terminal bridge, and tests.
- `tests/`: browser fixtures and scroll checks.
- `scripts/`: generic schema, database-inspection, and export helpers.
- `account-pool.example.json`: placeholder-only pool format. Keep the real config outside Git.

## Build and run

Requires a recent Node.js release with `node:sqlite`, plus the Codex CLI's app-server capability.

```bash
npm ci
npm run build
```

Run the backend with `npm run serve`; it defaults to port `4576`. The static UI proxy is `node v2-server.mjs`, defaults to port `4575`, and forwards API/WebSocket traffic to the backend. The ports are configurable with `CODEX_WEB_PORT`, `CODEX_V2_PORT`, and `CODEX_V2_UPSTREAM_PORT`.

Set `CODEX_WEB_ACCOUNT_POOL_FILE` to a private copy of `account-pool.example.json` with your own account homes. Set authentication and project/data roots through the `CODEX_WEB_*` environment variables. In particular, supply a strong `CODEX_WEB_DEFAULT_PASSWORD` or an authentication user file before exposing the service. The published defaults intentionally do not grant any named user a dedicated account; configure `CODEX_WEB_TRACKED_QUOTA_USER` and `CODEX_WEB_TRACKED_QUOTA_ALLOWED_ACCOUNT_ID` only if that policy is needed.

Never commit a real pool file, Codex home, token, browser/session cookie, SSH key, SQLite database, or exported user archive. Before publishing a fork, review `git status` and scan staged files for secrets.
