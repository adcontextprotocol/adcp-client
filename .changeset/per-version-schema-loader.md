---
'@adcp/sdk': minor
'@adcp/client': minor
---

feat: per-AdCP-version schema loader (Stage 3 Phase A foundation)

The bundled-schema validator now keeps state per AdCP version instead of a single module-global. The same SDK process can hold compiled validators for `3.0.0`, `3.0.1`, `3.1.0-beta.1`, and any future version side by side, picking the right bundle by the `version` argument that `getValidator` / `validateRequest` / `validateResponse` / `schemaAllowsTopLevelField` / `listValidatorKeys` now accept. All version arguments default to the SDK-pinned `ADCP_VERSION`, so existing call sites keep working unchanged — no runtime behavior changes for callers that don't yet pass a version.

The build copies the **latest patch per stable minor** plus **every prerelease** from `schemas/cache/<ver>/` into `dist/lib/schemas-data/<ver>/`. Per AdCP spec convention patch releases don't change wire shape, so collapsing `3.0.0` + `3.0.1` to just `3.0.1` is functionally equivalent for any validator consumer — keeps the bundle from growing linearly with patch releases. Prereleases (`3.1.0-beta.1`, `3.1.0-rc.2`, …) are intentionally **never collapsed**: pinning a beta is intentional and bit-fidelity matters for cross-version interop tests. The `latest` symlink and `*.previous` snapshots are skipped.

Sets up Stage 3 Phase B (wire-level plumbing where `SingleAgentClient` / `createAdcpServer` pass their per-instance `getAdcpVersion()` to the validators) and Phase C (lift the cross-major construction-time fence so a 3.0 client can speak to a 3.1 server in one process). No call sites adopted the per-version path yet — that lands in the follow-up. The current `adcpVersion` constructor option still rejects cross-major pins via `resolveAdcpVersion`'s fence; same Stage 2 contract.

Asking for an unbundled version surfaces a clear `AdCP schema data for version "X" not found … run sync-schemas + build` error rather than silently falling back to the pinned default. New `_resetValidationLoader(version?)` test hook clears one version (or all if no argument).
