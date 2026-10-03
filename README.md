# Codex UI account pool

React/Vite frontend and Fastify backend for a multi-user Codex app-server pool. This repository mirrors the application source; it does **not** contain any live accounts, credentials, sessions, uploads, databases, or deployment state.

## Source layout

- `src/`, `public/`, `index.html`: chat UI, editor, tool timeline, search, file/image previews, review/diff panel, worktrees, terminal, hooks, themes, notifications, goal/subagent panels, and the LaTeX/Word writing workbench.
- `server/`: authenticated API/WebSocket backend, account routing, persistence, quotas, session indexing, Git worktrees, hooks, terminal bridge, and tests.
- `tests/`: browser fixtures and scroll checks.
- `scripts/`: build/vendor preparation, runtime supervision, document-tool installation, skill installation, schema, database-inspection, and export helpers.
- `skills/latex-word-authoring/`: selection-aware LaTeX/Word authoring and conversion workflows.
- `skills/remote-folders/`, `remote-folder-*`, `remote-folders.mjs`: conversation-scoped remote directory selection, mounting, browsing and explicit reconnection.
- `maintenance/pool-watchdog.mjs`: local backend/tunnel health and cgroup memory-pressure monitoring; deployment-specific accounts and maintenance snapshots are not shipped.
- `account-pool.example.json`: placeholder-only pool format. Keep the real config outside Git.

## Build and run

Requires a recent Node.js release with `node:sqlite`, plus the Codex CLI's app-server capability. The build prepares a pinned, lazy-loaded SuperDoc bundle; only the AGPL-3.0 packages are used, not the proprietary DOCX engine. Its licenses and dependency notices are shipped in `public/vendor/superdoc-1.30.0/`.

```bash
npm ci
npm run build
```

Run the backend with `npm run serve`; it defaults to port `4576`. The static UI proxy is `node v2-server.mjs`, defaults to port `4575`, and forwards API/WebSocket traffic to the backend. The ports are configurable with `CODEX_WEB_PORT`, `CODEX_V2_PORT`, and `CODEX_V2_UPSTREAM_PORT`.

Set `CODEX_WEB_ACCOUNT_POOL_FILE` to a private copy of `account-pool.example.json` with your own account homes. Set authentication and project/data roots through the `CODEX_WEB_*` environment variables. In particular, supply a strong `CODEX_WEB_DEFAULT_PASSWORD` or an authentication user file before exposing the service. The published defaults intentionally do not grant any named user a dedicated account; configure `CODEX_WEB_TRACKED_QUOTA_USER` and `CODEX_WEB_TRACKED_QUOTA_ALLOWED_ACCOUNT_ID` only if that policy is needed.

Never commit a real pool file, Codex home, token, browser/session cookie, SSH key, SQLite database, or exported user archive. Before publishing a fork, review `git status` and scan staged files for secrets.

Document compilation/conversion requires local tools configured through `DOCUMENT_*` environment variables. The optional Linux installer is `scripts/setup-document-tools.sh`; `DOCUMENT_TOOLS_ROOT` controls its isolated installation directory. Install the authoring skill into your own configured runtimes with `CODEX_WEB_ACCOUNT_POOL_FILE=/private/pool.json node scripts/install-document-authoring-skill.mjs`.

Browser checks use Playwright (`npx playwright install chromium`). Live QA scripts require an explicitly authorized QA user/workspace/thread through their `DOCUMENT_QA_*` or `SUBAGENT_*` variables; they contain no production login or session identifiers.

The unified right workspace contains independently opened file previews, diffs, terminal sessions, subagent history, a multi-tab browser and conversation-owned scheduled tasks. Browser automation uses isolated per-user/conversation contexts, guarded network access, and approval for model-controlled mutations. Schedules are saved by the backend and enqueue turns in their original conversations without requiring an open webpage.

Remote directories require Linux FUSE/SSHFS, existing SSH key authorization and trusted host keys. Install the SFTP dependency with `python3 -m pip install --target .remote-folder-deps -r remote-folder-requirements.txt`. Set the same `CODEX_WEB_USER_WORKSPACE_ROOT` on the backend and UI proxy; both default to `$CODEX_WEB_DATA_DIR/users`. Opening the webpage does not connect SSH or open the remote panel; manual Refresh/Retry restores only saved directories in the current conversation, preserving their access mode. Private registries and mount contents remain outside this repository.
