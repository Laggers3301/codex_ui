# Codex UI 260810

A Codex-style V2 web UI for an existing Codex Web backend. It provides the dark Codex-inspired workspace tree, real-time tool timeline, compact tool previews, file uploads, image previews, quota popover, leaderboard, settings, workspace directory picker, and a port `4574` static UI/proxy.

## What this repository contains

- React/Vite V2 UI source in `src/`.
- Sidebar and DOM bridge shell in `index.html`.
- Port `4574` static server and proxy in `v2-server.mjs`.
- Backend performance patch in `patches/codex-remote-routes.patch`.

It intentionally excludes user sessions, uploaded files, browser storage, build output, credentials, and `node_modules`.

## Prerequisites

An existing Codex Web backend must already be available locally at `127.0.0.1:4573`. The V2 server serves compiled UI files on `4574` and proxies API/WebSocket requests to that backend.

## Deploy on another host

```bash
git clone <your-private-repository-url> codex-web-v2
cd codex-web-v2
npm ci
npm run build
systemd-run --user --unit=codex-ui-v2 --property=Restart=always --property=RestartSec=1s /path/to/node /absolute/path/to/codex-web-v2/v2-server.mjs
```

Open `http://<host>:4574/`.

`v2-server.mjs` currently uses port `4574` and proxies to port `4573`. Change only these constants when the target host uses different ports:

```js
const port = 4574;
const upstreamPort = 4573;
```

## Backend performance patch

Apply `patches/codex-remote-routes.patch` to the existing backend's `app/server/routes.ts`, then restart that backend. The patch adds the fast state-database thread-list path and uses a 60-second leaderboard cache. The UI works without it, but initial list loading and leaderboard refresh will be slower.

## Updating the UI

```bash
npm run build
```

The proxy reads `dist/` directly, so static UI changes do not require restarting the `codex-ui-v2` process.

