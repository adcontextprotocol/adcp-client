---
'@adcp/sdk': minor
'@adcp/client': minor
---

feat: wire `adcpVersion` per-instance through validators + protocol layer (Stage 3 Phase B + C)

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
