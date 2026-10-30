# Codex UI account pool

## Latest source synchronization (2026-10-20)

This update includes the complete frontend and backend source, not only TypeScript:

- Historical/latest prompt editing with attachment restoration, explicit suffix
  withdrawal consent, recoverable pre-edit backups, stale-view protection and
  failed-send draft retention. Editing does not undo filesystem changes.
- Safe validated Codex runtime adoption, busy-reason reporting, startup rollback
  and capability checks; existing account credentials remain private.
- Batched streaming updates, Fast service-tier propagation, bounded failure
  retries, actionable recovery notices and free-text tool questions.
- HTML previews open rendered by default, with a formatted, bounded source editor;
  conversation-scoped transfer state and sidebar visibility fixes.
- Mobile table sizing, conversation/composer layout, CSS transitions and preview
  zoom improvements. Latin-word apostrophes use narrow western glyphs in prose
  and inline highlights, and monospace glyphs in fenced code; Chinese text and
  copy/source characters are preserved.

The runtime, build, editing and typography regression tests are included. Browser
checks use isolated mock APIs; no production account or thread is required.
To run optional native rollback fixtures, set `CODEX_ROLLBACK_TEST_BIN` to an
installed compatible CLI binary. No Codex binary or model weights are bundled.

### Earlier synchronization

Includes recent frontend/backend updates: Feishu OAuth and confirmation workflows,
voice dictation, pets, free-text tool questions, composer prediction, model-context
defaults, archived tool outputs for large branches, browser recovery, resource guards,
WebSocket/network recovery, and the quota-popover compositing seam fix.

`maintenance/zerotier/` contains reusable controller management and migration
templates, with private network identities and members excluded. See its README
before deployment. Site-specific migrations, live acceptance outputs and credentials
are intentionally not shipped. Public configuration uses neutral, environment-driven
defaults; production configuration is unchanged by publishing this repository.

Feishu credentials are configured once on the server using
`scripts/configure-feishu.cjs`; users authorize independently. Keep the resulting
private configuration outside Git. Speech GPU workers use `scripts/speech-worker.py`
with private model/credential directories; no recordings or weights are shipped.

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

Codex accounts with a service-owned `CODEX_HOME` use Codex's native online model
discovery and native cache, inheriting the service's proxy environment. Startup
backs up the private configuration before removing its old `model_catalog_json`
pin, and uses the explicit project cwd as the configuration root. Existing model
files, UI/extra model lists, third-party providers, credentials and databases are
retained. Build, serve and deployment commands stay the same. Set
`CODEX_WEB_CODEX_MODEL_DISCOVERY=legacy` to retain the previous catalog behavior.
If the private configuration was already migrated, its original content is in
`config.toml.before-native-model-discovery.*.bak` for an explicit configuration rollback.
Default-mode questions are enabled for these native runtimes; set
`CODEX_WEB_DEFAULT_MODE_REQUEST_USER_INPUT=false` to retain Plan-only questions.
The isolated native regression can be run with
`CODEX_NATIVE_TEST_BIN=/path/to/codex node --import tsx/esm tests/nativeModelDiscovery.native.mjs`.

Never commit a real pool file, Codex home, token, browser/session cookie, SSH key, SQLite database, or exported user archive. Before publishing a fork, review `git status` and scan staged files for secrets.

Document compilation/conversion requires local tools configured through `DOCUMENT_*` environment variables. The optional Linux installer is `scripts/setup-document-tools.sh`; `DOCUMENT_TOOLS_ROOT` controls its isolated installation directory. Install the authoring skill into your own configured runtimes with `CODEX_WEB_ACCOUNT_POOL_FILE=/private/pool.json node scripts/install-document-authoring-skill.mjs`.

Browser checks use Playwright (`npx playwright install chromium`). Live QA scripts require an explicitly authorized QA user/workspace/thread through their `DOCUMENT_QA_*` or `SUBAGENT_*` variables; they contain no production login or session identifiers.

The unified right workspace contains independently opened file previews, diffs, terminal sessions, subagent history, a multi-tab browser and conversation-owned scheduled tasks. Browser automation uses isolated per-user/conversation contexts, guarded network access, and approval for model-controlled mutations. Schedules are saved by the backend and enqueue turns in their original conversations without requiring an open webpage.

Remote directories require Linux FUSE/SSHFS, existing SSH key authorization and trusted host keys. Install the SFTP dependency with `python3 -m pip install --target .remote-folder-deps -r remote-folder-requirements.txt`. Set the same `CODEX_WEB_USER_WORKSPACE_ROOT` on the backend and UI proxy; both default to `$CODEX_WEB_DATA_DIR/users`. Opening the webpage does not connect SSH or open the remote panel; manual Refresh/Retry restores only saved directories in the current conversation, preserving their access mode. Private registries and mount contents remain outside this repository.
