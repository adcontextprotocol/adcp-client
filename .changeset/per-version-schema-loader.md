---
'@adcp/sdk': minor
'@adcp/client': minor
---

feat: per-AdCP-version schema loader (Stage 3 Phase A foundation)

The bundled-schema validator now keeps state per AdCP version instead of a single module-global. The same SDK process can hold compiled validators for `3.0.0`, `3.0.1`, `3.1.0-beta.1`, and any future version side by side, picking the right bundle by the `version` argument that `getValidator` / `validateRequest` / `validateResponse` / `schemaAllowsTopLevelField` / `listValidatorKeys` now accept. All version arguments default to the SDK-pinned `ADCP_VERSION`, so existing call sites keep working unchanged — no runtime behavior changes for callers that don't yet pass a version.

**Stable releases ship under MAJOR.MINOR keys, prereleases stay exact.** The build copies `schemas/cache/3.0.1/` (or whatever the highest 3.0 patch is) to `dist/lib/schemas-data/3.0/`. Consumer pins of `'3.0.0'`, `'3.0.1'`, or `'3.0'` all resolve to the same bundle via the new `resolveBundleKey` helper — patches are spec-promised non-breaking, so distinct exact-version directories holding the same wire shape would be misleading. Prereleases (`3.1.0-beta.1`, `3.1.0-rc.2`, …) keep full-version directories because pinning a beta is intentional and bit-fidelity matters for cross-version interop tests. The cache itself stays exact-version-named (mirrors the spec repo tag we synced from); only the dist layout collapses. The `latest` symlink and `*.previous` snapshots are skipped.

Resolution rule (`resolveBundleKey`): stable `MAJOR.MINOR.PATCH` → `MAJOR.MINOR`, bare `MAJOR.MINOR` → unchanged, prerelease semver → unchanged, legacy `vN` → unchanged. Loader state is keyed by the resolved bundle, so `getValidator('foo', 'request', '3.0.0')` and `getValidator('foo', 'request', '3.0.1')` share a single compiled AJV instance — no double-compile cost when callers pass different patch pins for the same minor.

Source-tree fallback (when `npm run build:lib` hasn't run) finds the highest-patch sibling in the requested minor, matching dist's collapse behavior.

Sets up Stage 3 Phase B (wire-level plumbing where `SingleAgentClient` / `createAdcpServer` pass their per-instance `getAdcpVersion()` to the validators) and Phase C (lift the cross-major construction-time fence so a 3.0 client can speak to a 3.1 server in one process). No call sites adopted the per-version path yet — that lands in the follow-up. The current `adcpVersion` constructor option still rejects cross-major pins via `resolveAdcpVersion`'s fence; same Stage 2 contract.

Asking for an unbundled version surfaces a clear `AdCP schema data for version "X" not found … run sync-schemas + build` error rather than silently falling back to the pinned default. New `_resetValidationLoader(version?)` test hook clears one version (or all if no argument).
