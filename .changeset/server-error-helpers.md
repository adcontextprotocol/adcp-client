---
'@adcp/client': minor
---

**Server-side error helpers: `normalizeErrors` + `pickSafeDetails`** (`@adcp/client/server`).

Two general-purpose helpers every server adopter needs, exposed at the top-level `@adcp/client/server` subpath (not just `@adcp/client/server/decisioning`) so v5 handler-style adopters and v6 platform adopters both benefit.

**`normalizeErrors(input) / normalizeError(input)`** — wire-shape coercer for the AdCP `Error` row used in tool responses carrying per-row failures (`sync_creatives`, `sync_audiences`, `sync_accounts`, `report_usage`, `acquire_rights` error arm). Adopters return errors in whichever shape their codebase already speaks: bare strings, native `Error` instances, plain `{ code, message }` objects, `AdcpError` instances, upstream-platform error objects with vendor-specific fields. The helper coerces all of those into the canonical wire `Error` shape (`code`, `message`, optional `field` / `suggestion` / `retry_after` / `details` / `recovery`) so the response validator accepts the projected envelope without forcing every adopter to hand-shape the wire response. Coercion rules: string → `{ code: 'GENERIC_ERROR', message, recovery: 'terminal' }`; `Error` instance → same with `err.message`; `AdcpError`-shaped object → field-whitelisted to wire shape (vendor-specific fields dropped — use `details` for vendor extensions); `null`/`undefined` → `{ code: 'GENERIC_ERROR', message: 'Unknown error', recovery: 'terminal' }`. Clamps `retry_after` to `[1, 3600]` per spec. Drops invalid `recovery` values silently. Falls back `message` to `code` when message is missing or empty.

**Applied at the v6 framework wire-projection seam.** `createAdcpServerFromPlatform` now calls `normalizeErrors` on every `sync_creatives` row (sales + creative dispatch) before the wire response validator runs. Adopter code that returns `errors: ['format unsupported']` (string array) now passes strict response validation — the framework coerces to the canonical wire shape. v5 handler-style adopters can call `normalizeErrors` directly when they construct their `sync_creatives` responses.

**`pickSafeDetails(input, allowlist, opts?)`** — security primitive for the `details` field on `AdcpError` and the `Error` wire row. Adopters fronting upstream platforms (GAM, Snap, retail-media APIs, internal billing systems) often want to surface upstream error context to buyers — but raw upstream errors carry credentials, PII, internal stack traces, request IDs that leak tenant identity, and other liability surfaces that MUST NOT cross the wire boundary. `pickSafeDetails` is an explicit-allowlist sanitizer: only keys in the allowlist survive, with default caps on depth (`maxDepth: 2`, top + 1 nested object level) and serialized size (`maxSizeBytes: 2048`). Returns `undefined` (not `{}`) when the result is empty or exceeds the size cap so callers can spread the value into an optional `details` field without polluting it.

Adopter pattern:

```ts
import { pickSafeDetails } from '@adcp/client/server';

try {
  await gamClient.createOrder(req);
} catch (upstreamErr) {
  throw new AdcpError('UPSTREAM_REJECTED', {
    recovery: 'transient',
    message: 'Ad server rejected the order',
    details: pickSafeDetails(upstreamErr, [
      'http_status',
      'request_id',
      'gam_error_code',
    ]),
  });
}
```

What gets dropped silently: any key not in the allowlist; functions / Symbols / Date / RegExp / Map / Set / class instances (use string allowlist of primitive fields, or pre-shape the input); nested objects beyond `maxDepth`; results exceeding `maxSizeBytes`. Arrays don't count as a depth level (only plain objects do) — so an array-of-objects gets the same nesting budget as a bare object would.

**Tests.** 33 unit tests covering the full coercion / sanitization matrix (strings, Error instances, AdcpError-shaped objects, vendor-specific fields, retry_after clamping, recovery validation, depth cap, size cap, arrays of primitives + objects, common upstream-API sanitization pattern). 4 framework-integration tests pin that `normalizeErrors` is actually applied at the `sync_creatives` projection seam — strict response validation passes when adopters return string/Error/partial-object errors.

**SKILL.** New "Sanitizing error details" + "Wire-shape normalizer for `errors[]`" subsections under "Error code vocabulary" walking adopters through the two helpers with realistic GAM-rejection / partial-batch-failure examples.
