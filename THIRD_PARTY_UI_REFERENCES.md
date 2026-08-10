# Third-party UI references

This isolated V2 frontend was informed by the interaction patterns documented
in the following independent open-source projects. No OpenAI private frontend
assets or source code are included.

- `JaminZhou/codex-ui-kit` (MIT): agent activity disclosure, streaming status,
  tool-call presentation, reduced-motion behavior, and overlay transitions.
- `yunhaoli24/codex-gateway` (MIT): server-owned conversation timeline and
  reconnect-safe browser architecture.
- `seo-rii/codex-webui` (MIT): progressive long-history hydration and lazy
  tool-detail loading architecture.

The current implementation remains a fork of the local Codex Web frontend and
uses its existing backend protocol and data model.
