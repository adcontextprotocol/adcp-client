# @adcp/client

## 5.24.0

### Minor Changes

- 81ac755: feat: wire `adcpVersion` per-instance through validators + protocol layer (Stage 3 Phase B + C)

  The per-instance `adcpVersion` constructor option now actually drives runtime behavior. Phase A built the per-version schema bundles; this PR plumbs `getAdcpVersion()` from the four constructor surfaces to every place version-keyed code runs:
  - **Validators** — `validateRequest` / `validateResponse` / `validateOutgoingRequest` / `validateIncomingResponse` accept the per-instance version. `SingleAgentClient` passes `resolvedAdcpVersion` to `TaskExecutor`, which forwards it to the validator hooks. `createAdcpServer` passes its `adcpVersion` to its server-side validation calls. A client pinned to `'3.0'` validates against `dist/lib/schemas-data/3.0/`; a future `'3.1.0-beta.1'` pin (once that bundle ships) validates against its own schemas.
  - **Wire-level `adcp_major_version`** — `ProtocolClient.callTool` derives the major per-call from a caller-supplied `adcpVersion` via `parseAdcpMajorVersion`. All four wire-injection sites (in-process MCP, HTTP MCP, A2A factory, MCP factory) use the per-instance major instead of the SDK-pinned `ADCP_MAJOR_VERSION` constant. Default fallback to the constant preserves behavior for callers that don't yet pass a version.
  - **`ProtocolClient.callTool` signature → options object.** Replaces the prior 9-positional-argument tail (`debugLogs?, webhookUrl?, webhookSecret?, webhookToken?, serverVersion?, session?`) with a single `CallToolOptions` object: `callTool(agent, toolName, args, { debugLogs?, webhookUrl?, webhookSecret?, webhookToken?, serverVersion?, session?, adcpVersion? })`. The 3-arg form is unchanged. Reviewers consistently flagged the positional sprawl as a readability cliff after this PR added the 10th slot; the migration lands here so adding any future call-level flag (signing context, governance binding, etc.) doesn't compound the problem. Internal call sites (`TaskExecutor`, `GovernanceMiddleware`, `GovernanceAdapter`, capability-priming recursion, the legacy `Agent` class) are updated alongside; external callers using only the 3-arg form are unaffected.
  - **`requireV3ForMutations`** — generalized from "seller advertises major 3" to "seller advertises the major matching the client's `getAdcpVersion()`". Function name is grandfathered. A 3.x client still expects major 3; a 4.x client (once supported) expects major 4.

  **Phase C — fence lifted.** `resolveAdcpVersion` no longer rejects cross-major pins. The new gate is "schema bundle exists for this version's resolved key" via the new `hasSchemaBundle(version)` helper exported from `@adcp/sdk`. Pinning a value with no shipped bundle (`'4.0.0'` today, `'3.1.0-beta.1'` before the spec repo ships that tag) throws `ConfigurationError` at construction with a clear pointer at `npm run sync-schemas` + `npm run build:lib`. The SDK default `ADCP_VERSION` short-circuits the bundle check (its bundle ships by construction), so no fs cost on the common path.

  Once a future SDK release adds a 3.1 beta or 4.x bundle, those pins start working with no code change here.

  This completes Stage 3's runtime-honest contract: `getAdcpVersion()` is now the single source of truth for both validator selection and wire-level major. Stage 3 Phase D (cross-version test harness — 3.0 client speaking to 3.1 server in one process, once 3.1 ships) lands separately.

  **Governance forwarding now works.** `GovernanceMiddleware` accepts the buyer's `adcpVersion` as a third constructor argument and forwards it to its `check_governance` / `report_plan_outcome` calls — `TaskExecutor` threads `config.adcpVersion` through. `GovernanceAdapter` (server-side) gains an optional `adcpVersion` field on `GovernanceAdapterConfig` that sellers should set to match their `createAdcpServer({ adcpVersion })` value. (Earlier framing was that governance is a separate endpoint with its own pin, so the buyer's pin shouldn't carry; reviewers correctly pushed back — `config.agent` carries no pin of its own, so silent fallback to the SDK constant was the same drift Stage 2 was designed to eliminate.)

  **Legacy `Agent` class now warns at construction.** Adds `@deprecated` JSDoc + a one-time `process.emitWarning` directing users to `SingleAgentClient` / `AgentClient` / `ADCPMultiAgentClient`. Agent does not honor per-instance pins and would silently drift on the wire — surfacing the deprecation rather than letting consumers stumble onto it. Codegen template (`scripts/generate-types.ts`) updated alongside the regenerated `src/lib/agents/index.generated.ts`.

  **`requireV3` renamed to `requireSupportedMajor`.** The function generalized in this PR to check the client's pinned major (3 today, 4 once that's bundled), and the v3-suffixed name is the temporal-context anti-pattern CLAUDE.md calls out. New name is the canonical method on both `SingleAgentClient` and `AgentClient`; the original `requireV3` stays as a `@deprecated` alias delegating to the new name (non-breaking). The config option `requireV3ForMutations` keeps its name — it's a public-config string consumers may persist in env files or config schemas.

  **Polish addressed in this PR:**
  - `resolveWireMajor` (the wire-major helper in `protocols/index.ts`) now throws `ConfigurationError` instead of plain `Error` so direct-call misuse surfaces with the same error class as the construction-time fence.
  - `resolveAdcpVersion`'s short-circuit compares bundle keys, not literal strings — `'3.0'`, `'3.0.0'`, `'3.0.1'` all skip the fs check when they resolve to the same bundle as `ADCP_VERSION`.
  - Imports reordered in `protocols/index.ts` (signing imports above the helper, not below).

  **Wider context:** AdCP spec PR `adcontextprotocol/adcp#3493` proposes a top-level `adcp_version` string field (release-precision, e.g. `'3.0'` / `'3.1'`) on every request and response, alongside the existing integer `adcp_major_version`. RECOMMENDED in 3.1, MUST in 4.0. This SDK PR doesn't yet emit the new field — the integer is sufficient for routing today, and dual-emit is one line once the spec PR merges. Tracking for a follow-up.

- 18ac48a: feat: per-AdCP-version schema loader (Stage 3 Phase A foundation)

  The bundled-schema validator now keeps state per AdCP version instead of a single module-global. The same SDK process can hold compiled validators for `3.0.0`, `3.0.1`, `3.1.0-beta.1`, and any future version side by side, picking the right bundle by the `version` argument that `getValidator` / `validateRequest` / `validateResponse` / `schemaAllowsTopLevelField` / `listValidatorKeys` now accept. All version arguments default to the SDK-pinned `ADCP_VERSION`, so existing call sites keep working unchanged — no runtime behavior changes for callers that don't yet pass a version.

  **Stable releases ship under MAJOR.MINOR keys, prereleases stay exact.** The build copies `schemas/cache/3.0.1/` (or whatever the highest 3.0 patch is) to `dist/lib/schemas-data/3.0/`. Consumer pins of `'3.0.0'`, `'3.0.1'`, or `'3.0'` all resolve to the same bundle via the new `resolveBundleKey` helper — patches are spec-promised non-breaking, so distinct exact-version directories holding the same wire shape would be misleading. Prereleases (`3.1.0-beta.1`, `3.1.0-rc.2`, …) keep full-version directories because pinning a beta is intentional and bit-fidelity matters for cross-version interop tests. The cache itself stays exact-version-named (mirrors the spec repo tag we synced from); only the dist layout collapses. The `latest` symlink and `*.previous` snapshots are skipped.

  Resolution rule (`resolveBundleKey`): stable `MAJOR.MINOR.PATCH` → `MAJOR.MINOR`, bare `MAJOR.MINOR` → unchanged, prerelease semver → unchanged, legacy `vN` → unchanged. Loader state is keyed by the resolved bundle, so `getValidator('foo', 'request', '3.0.0')` and `getValidator('foo', 'request', '3.0.1')` share a single compiled AJV instance — no double-compile cost when callers pass different patch pins for the same minor.

  Source-tree fallback (when `npm run build:lib` hasn't run) finds the highest-patch sibling in the requested minor, matching dist's collapse behavior.

  Sets up Stage 3 Phase B (wire-level plumbing where `SingleAgentClient` / `createAdcpServer` pass their per-instance `getAdcpVersion()` to the validators) and Phase C (lift the cross-major construction-time fence so a 3.0 client can speak to a 3.1 server in one process). No call sites adopted the per-version path yet — that lands in the follow-up. The current `adcpVersion` constructor option still rejects cross-major pins via `resolveAdcpVersion`'s fence; same Stage 2 contract.

  Asking for an unbundled version surfaces a clear `AdCP schema data for version "X" not found … run sync-schemas + build` error rather than silently falling back to the pinned default. New `_resetValidationLoader(version?)` test hook clears one version (or all if no argument).

### Patch Changes

- Updated dependencies [81ac755]
- Updated dependencies [18ac48a]
  - @adcp/sdk@5.24.0

## 5.23.0

### Minor Changes

- 88e3b02: feat: add `adcpVersion` constructor option on client + server surfaces

  `SingleAgentClient`, `AgentClient`, `ADCPMultiAgentClient`, and `createAdcpServer` now accept an `adcpVersion?: AdcpVersion | (string & {})` option that surfaces via a new `getAdcpVersion()` instance method. Typed as a union of `COMPATIBLE_ADCP_VERSIONS` literals plus an open-string escape hatch so editors autocomplete canonical values without forcing a closed enum.

  Defaults to the SDK's pinned `ADCP_VERSION` (currently `'3.0.1'`) when omitted. Pin to an older stable (`'3.0.0'`) or opt into a beta channel (`'3.1.0-beta.1'`) once the corresponding registry ships.

  Validated at construction time via `resolveAdcpVersion`: pins whose derived major differs from `ADCP_MAJOR_VERSION` throw `ConfigurationError` with a roadmap-aware message pointing at Stage 3. This fence keeps Stage 2's wire emission honest while the global `ADCP_MAJOR_VERSION` constant still drives the `adcp_major_version` request field — within major 3, every accepted pin agrees with the wire.

  Plumbing surface only — Stage 2 of the multi-version refactor. The configured value is exposed and propagated, but validators and schema selection still key off the global `ADCP_VERSION` constant. Stage 3 wires per-instance schema loading off this getter so cross-version testing (a 3.0 client speaking to a 3.1 server in the same process) works without npm aliases.

  `AdcpServerConfig.adcpVersion` is independent of `AdcpServerConfig.version`; the latter is the publisher's app version, the former is the AdCP protocol version on the wire.

- 88e3b02: feat: rename `@adcp/client` to `@adcp/sdk` + add `/client` and `/compliance` subpath umbrellas

  The library is now published as `@adcp/sdk` to reflect the three surfaces it ships — buyer-side client, server builder, and compliance harness. `@adcp/client` continues to publish from `packages/client-shim/` as a thin re-export of `@adcp/sdk` (including a CLI delegator so `npx @adcp/client@latest …` keeps working), so existing installs keep functioning without code changes. Replace `@adcp/client` with `@adcp/sdk` in your imports when convenient — APIs are identical.

  New subpath exports group the surfaces so `@adcp/sdk/client`, `@adcp/sdk/server`, and `@adcp/sdk/compliance` resolve to the right slice for each use case. The root export (`@adcp/sdk`) continues to re-export the client surface verbatim, so `import { AdcpClient } from '@adcp/sdk'` and `import { AdcpClient } from '@adcp/sdk/client'` are equivalent. The new `@adcp/sdk/compliance` umbrella re-exports `testing` + `conformance` + `compliance-fixtures` + `signing/testing` for compliance harnesses that want one import path; the individual subpaths still resolve directly so callers who only need fuzzing don't pay the bundle cost of test agents.

  Repo restructure: top-level `package.json` now declares an npm workspace covering `.` plus `packages/*`. The two packages stay version-linked via `.changeset/config.json` so they always release at the same number; the shim's `dependencies."@adcp/sdk"` covers the published range (`^5.22.0`) so npm dedupes consumers' trees that pull both names. (We tried `peerDependencies` first; changesets treats every minor bump on a peer as a major bump for the dependent, which would force `@adcp/client` to 6.0.0 every time `@adcp/sdk` released a feature.)

  Post-release maintainer task: run `npm deprecate '@adcp/client@5.23.0' 'Renamed to @adcp/sdk. Replace @adcp/client with @adcp/sdk in your imports — APIs are identical. https://www.npmjs.com/package/@adcp/sdk'` so the rename pointer surfaces at install time. Auto-deprecation in the release workflow is on the follow-up list — OIDC trusted-publishing tokens are package-scoped, so the token issued for `@adcp/sdk`'s publish can't deprecate `@adcp/client`. Lands back in `release.yml` once a maintainer-scoped `NPM_TOKEN` secret with deprecate rights on `@adcp/client` is provisioned.

### Patch Changes

- Updated dependencies [88e3b02]
- Updated dependencies [88e3b02]
  - @adcp/sdk@5.23.0

## 6.0.0

### Minor Changes

- 9de471e: feat: add `adcpVersion` constructor option on client + server surfaces

  `SingleAgentClient`, `AgentClient`, `ADCPMultiAgentClient`, and `createAdcpServer` now accept an `adcpVersion?: string` option that surfaces via a new `getAdcpVersion()` instance method. Defaults to the SDK's pinned `ADCP_VERSION` (currently `'3.0.0'`) when omitted. Pin to an older stable (`'3.0.0'`) or opt into a beta channel (`'3.1.0-beta.1'`) once the corresponding registry ships.

  Plumbing surface only — Stage 2 of the multi-version refactor. The configured value is exposed and propagated, but validators and schema selection still key off the global `ADCP_VERSION` constant. Stage 3 wires per-instance schema loading off this getter so cross-version testing (a 3.0 client speaking to a 3.1 server in the same process) works without npm aliases.

  `AdcpServerConfig.adcpVersion` is independent of `AdcpServerConfig.version`; the latter is the publisher's app version, the former is the AdCP protocol version on the wire.

- 9de471e: feat: rename `@adcp/client` to `@adcp/sdk` + add `/client` and `/compliance` subpath umbrellas

  The library is now published as `@adcp/sdk` to reflect the three surfaces it ships — buyer-side client, server builder, and compliance harness. `@adcp/client` continues to publish from `packages/client-shim/` as a thin re-export of `@adcp/sdk` (including a CLI delegator so `npx @adcp/client@latest …` keeps working), so existing installs keep functioning without code changes. Replace `@adcp/client` with `@adcp/sdk` in your imports when convenient — APIs are identical.

  New subpath exports group the surfaces so `@adcp/sdk/client`, `@adcp/sdk/server`, and `@adcp/sdk/compliance` resolve to the right slice for each use case. The root export (`@adcp/sdk`) continues to re-export the client surface verbatim, so `import { AdcpClient } from '@adcp/sdk'` and `import { AdcpClient } from '@adcp/sdk/client'` are equivalent. The new `@adcp/sdk/compliance` umbrella re-exports `testing` + `conformance` + `compliance-fixtures` + `signing/testing` for compliance harnesses that want one import path; the individual subpaths still resolve directly so callers who only need fuzzing don't pay the bundle cost of test agents.

  Repo restructure: top-level `package.json` now declares an npm workspace covering `.` plus `packages/*`. The two packages stay version-linked via `.changeset/config.json` so they always release at the same number; the shim's `dependencies."@adcp/sdk"` bumps automatically with each release.

### Patch Changes

- 5fb6729: fix(testing): signals governance advisory block now fires correctly

  The governance advisory check in `testSignalsFlow` was silently a no-op: it
  re-parsed `signalsStep.response_preview` (a pre-formatted summary string) looking
  for `.signals`/`.all_signals` keys that never exist in that format, so
  `withRestrictedAttrs` and `withPolicyCategories` were always empty arrays.

  `discoverSignals` now returns the raw `GetSignalsResponse.signals` array alongside
  the digested `AgentProfile.supported_signals` array. The advisory block uses the
  raw array directly and also evaluates signals discovered via the fallback-brief
  loop, so agents whose first `get_signals` call returns empty are still graded.
  The advisory hint now points operators at the spec-correct surface for declaring
  `restricted_attributes`/`policy_categories` (the `signal_catalog` in
  `adagents.json`).

- Updated dependencies [14623ee]
- Updated dependencies [9de471e]
- Updated dependencies [71df387]
- Updated dependencies [36d3c81]
- Updated dependencies [9de471e]
  - @adcp/sdk@6.0.0
