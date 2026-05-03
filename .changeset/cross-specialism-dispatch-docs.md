---
"@adcp/sdk": patch
---

Documentation: cross-specialism dispatch on `DecisioningPlatform`. JSDoc on the platform interface and an expanded `skills/build-holdco-agent/SKILL.md § Cross-specialism dispatch` section now make explicit that there is no `ctx.platform.<specialism>` accessor — the canonical patterns are class instance + `this` (used by `examples/hello_seller_adapter_multi_tenant.ts`) or closure capture (for adopters using `define<X>Platform({...})` factories standalone). Both forward the same `RequestContext` so the resolved account / agent / authInfo carry through, and both bypass wire-side validation + idempotency dedup (correct for in-process calls but worth knowing). One of the items tracked in #1387.
