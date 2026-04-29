---
'@adcp/sdk': minor
'@adcp/client': minor
---

feat: wire `adcpVersion` per-instance through validators + protocol layer (Stage 3 Phase B + C)

The per-instance `adcpVersion` constructor option now actually drives runtime behavior. Phase A built the per-version schema bundles; this PR plumbs `getAdcpVersion()` from the four constructor surfaces to every place version-keyed code runs:

- **Validators** — `validateRequest` / `validateResponse` / `validateOutgoingRequest` / `validateIncomingResponse` accept the per-instance version. `SingleAgentClient` passes `resolvedAdcpVersion` to `TaskExecutor`, which forwards it to the validator hooks. `createAdcpServer` passes its `adcpVersion` to its server-side validation calls. A client pinned to `'3.0'` validates against `dist/lib/schemas-data/3.0/`; a future `'3.1.0-beta.1'` pin (once that bundle ships) validates against its own schemas.
- **Wire-level `adcp_major_version`** — `ProtocolClient.callTool` accepts an optional `adcpVersion` parameter and derives the major from it via `parseAdcpMajorVersion`. All four wire-injection sites (in-process MCP, HTTP MCP, A2A factory, MCP factory) use the per-instance major instead of the SDK-pinned `ADCP_MAJOR_VERSION` constant. Default fallback to the constant preserves behavior for callers that don't yet pass a version.
- **`requireV3ForMutations`** — generalized from "seller advertises major 3" to "seller advertises the major matching the client's `getAdcpVersion()`". Function name is grandfathered. A 3.x client still expects major 3; a 4.x client (once supported) expects major 4.

**Phase C — fence lifted.** `resolveAdcpVersion` no longer rejects cross-major pins. The new gate is "schema bundle exists for this version's resolved key" via the new `hasSchemaBundle(version)` helper exported from `@adcp/sdk`. Pinning a value with no shipped bundle (`'4.0.0'` today, `'3.1.0-beta.1'` before the spec repo ships that tag) throws `ConfigurationError` at construction with a clear pointer at `npm run sync-schemas` + `npm run build:lib`. The SDK default `ADCP_VERSION` short-circuits the bundle check (its bundle ships by construction), so no fs cost on the common path.

Once a future SDK release adds a 3.1 beta or 4.x bundle, those pins start working with no code change here.

This completes Stage 3's runtime-honest contract: `getAdcpVersion()` is now the single source of truth for both validator selection and wire-level major. Stage 3 Phase D (cross-version test harness — 3.0 client speaking to 3.1 server in one process, once 3.1 ships) lands separately.

**Intentionally not plumbed:**
- Governance call-out paths (`GovernanceMiddleware`, `governance-adapter.ts`) — the governance agent is a separate AdCP endpoint with its own version pin, so the buyer-side `adcpVersion` shouldn't carry over.
- The legacy `Agent` class generated in `agents/index.generated.ts` — uses the SDK default. Picked up when `Agent` is rewritten to thread the per-instance pin.

**Wider context:** AdCP spec PR `adcontextprotocol/adcp#3493` proposes a top-level `adcp_version` string field (release-precision, e.g. `'3.0'` / `'3.1'`) on every request and response, alongside the existing integer `adcp_major_version`. RECOMMENDED in 3.1, MUST in 4.0. This SDK PR doesn't yet emit the new field — the integer is sufficient for routing today, and dual-emit is one line once the spec PR merges. Tracking for a follow-up.
