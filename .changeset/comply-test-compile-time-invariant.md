---
"@adcp/sdk": minor
---

feat(server): compile-time invariant for complyTest / compliance_testing pairing

Adds two mechanisms that catch the cap/adapter mismatch earlier than runtime:

- `RequiredOptsFor<P>` — conditional type on `createAdcpServerFromPlatform`'s
  `opts` parameter. When `P` carries a non-optional `compliance_testing` block
  (e.g. from `definePlatformWithCompliance`), `complyTest` becomes required in
  opts at compile time. Previously both directions were runtime-only
  `PlatformConfigError` throws that were invisible to the harness.

- `definePlatformWithCompliance<TConfig, TCtxMeta>()` — identity helper (same
  pattern as `defineSalesPlatform` etc.) that enforces `capabilities.compliance_testing`
  non-optional at the platform definition site. Pairing it with
  `createAdcpServerFromPlatform` gives full bidirectional enforcement without
  any API changes to existing call sites.

The runtime check (`PlatformConfigError`) is preserved as defense-in-depth for
untyped callers.

Closes #1261
