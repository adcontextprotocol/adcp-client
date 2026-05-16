---
'@adcp/sdk': patch
---

fix(bridge): emit `logger.debug` when sandbox-gate rejects a sandbox-flagged request

When an adopter sets `account.sandbox: true` (or `context.sandbox: true`) on a request but the resolved `ctx.account` is explicitly `sandbox: false`, the dispatcher's `TestControllerBridge` gate rejects the merge silently. Adopters chasing "why aren't my fixtures showing in storyboards" had no diagnostic surface — the request looked sandbox-shaped but no fixtures appeared and no logs explained the gap. That was the #1 adopter support question after #1753 shipped.

Adds a single `logger.debug` line inside `src/lib/server/create-adcp-server.ts` covering all 13 dispatcher branches in one shot — the diagnostic fires after the request-sandbox check passes but before the resolved-account check. Production traffic (no sandbox marker on request) fails the first gate and never reaches this branch, so the log surface is dev-only.

Three regression tests verify: gate-mismatch fires `debug`; production traffic does not fire `debug`; gate-pass does not fire `debug` and merge proceeds normally.

Product-review-driven during the post-merge review of (now-closed) #1754.
