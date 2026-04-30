---
'@adcp/sdk': minor
'@adcp/client': minor
---

feat: implement AdCP 3.1 release-precision version envelope (spec PR adcontextprotocol/adcp#3493)

Adds the buyer-side and server-side plumbing for AdCP 3.1's `adcp_version` (string, release-precision) envelope field, alongside continued support for the deprecated integer `adcp_major_version`. Activates automatically when a 3.1+ schema bundle ships and the client/server is pinned to it; 3.0-pinned callers see no behavior change.

**Buyer-side wire emission.** New `buildVersionEnvelope` helper (in `protocols/index.ts`) builds the per-call wire envelope based on the caller's pin:
- 3.0 pins → `{ adcp_major_version: 3 }` (matches 3.0 spec exactly; the string field doesn't exist in 3.0)
- 3.1+ pins → `{ adcp_major_version: 3, adcp_version: '3.1' }` (or `'3.1.0-beta.1'` for prereleases — release-precision = bundle key, prereleases stay verbatim per spec rule 8)

All four wire-injection sites (`ProtocolClient.callTool` in-process MCP, HTTP path, A2A path, plus `createMCPClient` / `createA2AClient` factories) use the helper. The gate is exported as `bundleSupportsAdcpVersionField(bundleKey)` for callers who need to make the same decision.

**Capability parsing.** `AdcpCapabilities` gains optional `supportedVersions: string[]` (release-precision) and `buildVersion: string` (full semver) fields, populated when the seller advertises `adcp.supported_versions` and `adcp.build_version` per the new spec. `requireSupportedMajor` reads `supportedVersions` preferentially when present, matching by `resolveBundleKey(pin)`. Falls back to the deprecated `majorVersions` integer array for legacy 3.0 sellers — 3.x backward compat per the spec's SHOULD-only migration cadence. Pre-release pins match exactly per spec rule 8: `'3.1.0-beta.1'` matches only against an identical string in the seller's list, never `'3.1'` GA.

**Server-side honor + echo.** `createAdcpServer` now:
- **Detects field-disagreement** per spec rule 7 (must-reject when both fields present and majors disagree). Catches buyer drift before the request reaches the handler — returns `VERSION_UNSUPPORTED` immediately. Skipped when only one field is present.
- **Echoes `adcp_version` on responses** when the seller pins to 3.1+. The new `injectVersionIntoResponse` helper writes both `structuredContent.adcp_version` and the L2 text-fallback JSON, mirroring `injectContextIntoResponse`'s dual-write pattern. The echoed value is the seller's `resolveBundleKey(adcpVersion)`. Note: this PR doesn't yet implement the spec's "release served" downshift (a 3.1 seller serving a 3.0 buyer at 3.0 echoes `'3.0'`); we always echo the seller's own pin. Single-version sellers are correct; multi-version downshift lands separately once the negotiation surface is designed.

**`VERSION_UNSUPPORTED.error.data` parsing.** New `extractVersionUnsupportedDetails(input)` helper (exported from `@adcp/sdk`) reads the structured details a 3.1 seller carries on a `VERSION_UNSUPPORTED` rejection per `error-details/version-unsupported.json`:

```ts
import { extractVersionUnsupportedDetails } from '@adcp/sdk';

try {
  await client.createMediaBuy(...);
} catch (err) {
  const details = extractVersionUnsupportedDetails(err.adcpError);
  if (details?.supported_versions) {
    // Pick a compatible version and retry with a downgraded pin
    const downgraded = details.supported_versions.find(v => v.startsWith('3.'));
    // ... reconstruct client with adcpVersion: downgraded
  }
}
```

Tolerates four wrapper shapes (raw `data`, `error.data`, `error.details`, `adcp_error.data`) since transport boundaries surface the structured payload at different nesting depths. Returns `undefined` when the envelope is missing or empty — callers should treat absence as "seller didn't tell me" and fall back to a fixed strategy.

**What this PR does NOT yet do** — and why:

- **Schema sync.** The new schemas live on `adcontextprotocol/adcp` main but no spec-repo release tag has been cut yet that includes the merged change. `npm run sync-schemas` will pull them when the tag exists; `dist/lib/schemas-data/3.1.0-beta.X/` ships with that build. Until then, 3.1 pins still throw `ConfigurationError` (no bundle) at construction. The wire/parse logic this PR adds works against fixture data and unit-tests; the end-to-end matrix activates the day the bundle ships.
- **Multi-version "release served" downshift.** A 3.1 seller serving a 3.0 buyer at 3.0 should echo `'3.0'` per spec, not `'3.1'`. Today this PR always echoes the seller's own pin. Adding downshift requires deciding how the seller declares "I can serve at 3.0 too" (probably via `supported_versions: ['3.0', '3.1']` on capabilities) and threading that through the dispatch path. Tracked as a follow-up; today's emit is correct for single-version sellers and harmless overstatement for any 3.1+ seller serving its own pin.
- **Buyer-side response-echo introspection.** The seller's `adcp_version` echo is in the response body but the SDK doesn't yet surface it as a typed signal on `TaskResult` for downgrade-detection instrumentation. Callers can read it directly from `result.data.adcp_version` for now.

**What developers see:**
- Default-version users: nothing changes. SDK pins to 3.0.1, no `adcp_version` emitted.
- Forward-compat adopters (when 3.1 bundle ships): bump SDK, change `adcpVersion: '3.1.0-beta.1'`. `adcp_version` automatically emits on every call. `requireSupportedMajor` matches by release-precision against the seller's `supported_versions`. Field-disagreement protection catches buyer config drift.
- Server adopters (sellers): same — pin to 3.1 in `createAdcpServer({ adcpVersion: '3.1...' })` and the echo + field-disagreement check activate automatically.

**Spec migration alignment:**
- 3.1 (this surface ships): SHOULD on both sides per spec migration table.
- 3.2: AdCP compliance grader makes echo + `supported_versions` blocking.
- 4.0: MUST on both sides; integer `adcp_major_version` removed; SDK ships a major bump that drops the integer.

This SDK PR fully covers the "JS — `@adcp/client`" entry referenced in spec PR #3493's downstream conformance checklist. End-to-end tests against real 3.1 schemas land separately when the bundle is cut.
