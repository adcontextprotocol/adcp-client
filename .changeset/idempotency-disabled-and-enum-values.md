---
'@adcp/client': minor
---

**Add `idempotency: 'disabled'` mode and standalone enum value arrays.**

Two additive surfaces aimed at consumers who currently duplicate spec data or have to UUID-inject every test payload to satisfy AdCP 3.0's `idempotency_key` requirement.

**1. `idempotency: 'disabled'` for `createAdcpServer`.** The `idempotency` option on `AdcpServerConfig` now accepts the literal `'disabled'` in addition to an `IdempotencyStore`. When set:

- **`get_adcp_capabilities` flips to the spec's `IdempotencyUnsupported` branch** — the response advertises `adcp.idempotency: { supported: false }` with `replay_ttl_seconds` omitted, matching the `oneOf` discriminator in `get-adcp-capabilities-response.json`. Buyers reading capabilities can fall back to natural-key dedup before retrying spend-committing operations. (Earlier drafts of this change kept `supported: true`; that's a money-flow footgun and was caught in expert review.)
- The mutating-tool middleware (`INVALID_REQUEST` / `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_EXPIRED`) is skipped.
- Schema validation (`validation.requests: 'strict'`) tolerates a missing `idempotency_key` on mutating tools — every other required field still produces `VALIDATION_ERROR`. The filter is surgical: only the `keyword: 'required', pointer: '/idempotency_key'` issue is dropped (top-level `instancePath`-based; nested fields would not match).
- A pre-middleware shape gate enforces `IDEMPOTENCY_KEY_PATTERN` (`^[A-Za-z0-9_.:-]{16,255}$`) whenever a key IS supplied, **regardless of disabled mode** — defense-in-depth so a malformed key never reaches handler logs even when validation is `'off'` and the replay middleware is skipped.
- The "mutating handlers without an idempotency store" startup error log is suppressed.
- **`createAdcpServer` throws at construction under `NODE_ENV=production`.** Disabled mode in production silently double-executes mutating handlers on retry, which is a money-flow incident waiting to happen — refusing to start turns a config typo into a startup crash. Outside production a `logger.warn` fires so the choice stays visible.

Production servers must still wire a real store via `createIdempotencyStore({ backend, ttlSeconds })` — `'disabled'` is for non-production test fleets that don't model replay behavior. The existing `idempotency: store` and `idempotency: undefined` paths are unchanged.

**Storyboard interaction.** The universal `compliance/.../universal/idempotency.yaml` storyboard explicitly states that sellers declaring `supported: false` MUST skip it. Auto-skip wiring in the runner is a follow-up; today, running this storyboard against a disabled-mode agent will fail (correctly, since the agent has no replay window to test).

**2. Standalone enum value arrays.** A new generated file `src/lib/types/enums.generated.ts` exports a `${TypeName}Values` const array for every named string-literal union in the AdCP TypeScript types — `MediaChannelValues`, `PacingValues`, `MediaBuyStatusValues`, `DeliveryTypeValues`, `AssetContentTypeValues`, etc. (122 enums total). Adapters can now import the spec's literal sets directly instead of duplicating them or re-deriving from Zod:

```ts
import { MediaChannelValues } from '@adcp/client/types';
const channels = new Set<string>(MediaChannelValues);
if (!channels.has(input)) throw new Error('unknown channel');
```

Codegen is wired into the existing pipeline (`generate-types` now also runs `generate-enum-arrays`), so `ci:schema-check` catches drift the same way it catches type drift. The new test `test/lib/enum-arrays.test.js` cross-validates that every `Values` array round-trips against its matching `Schema` Zod validator — if either side drifts, the test fails fast.

**Inline anonymous unions (e.g., `formats?: ('jpg' | 'jpeg' | ...)[]` inside `ImageAssetRequirements`) are out of scope** — they don't have a stable name in the generated TypeScript. Use the Zod schema's introspection if you need them. A follow-up may extract specific high-value inline enums to named exports.
