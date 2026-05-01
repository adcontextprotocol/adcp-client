---
'@adcp/sdk': patch
---

Adds an adapter-conformance test suite that pins the v3→v2 wire adapters against the cached v2.5 schema bundle. CI signal for "the v2 wire adapters produce v2.5-conformant output."

Each canonical v3 fixture runs through `adaptRequestForServerVersion`; the adapted output must validate against `schemas/cache/v2.5/`. Tools with known drift have explicit `expected_failures` entries pointing at the tracking issue and pinning the failure-mode pointers — so a fix that closes the gap surfaces as an unexpected pass and prompts the entry to be removed. A "every v2-adapted tool has a fixture" guard test ensures new adapters can't ship without conformance coverage.

Initial state: `get_products` and `update_media_buy` conform clean. `create_media_buy` has known drift on `/buyer_ref` (top-level + per-package), tracked at adcontextprotocol/adcp-client#1115. `sync_creatives` has known drift on `/creatives/0/assets/video` (v3 manifest shape vs v2.5 single-asset-payload `oneOf`), tracked at adcontextprotocol/adcp-client#1116.

No source changes. Test-only — but a changeset because the suite is the binding contract for v2 wire conformance going forward.
