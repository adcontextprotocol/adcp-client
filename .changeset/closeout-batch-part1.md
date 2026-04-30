---
'@adcp/sdk': minor
---

Close-out batch part 1: deprecate v5 response builders, type idempotency principal params, ship principal-fallback footgun warn, slim skill polish.

**Deprecate v5 response builders.** All 29 response-builder functions in `src/lib/server/responses.ts` (`productsResponse`, `mediaBuyResponse`, etc.) marked `@deprecated`. They're for v5 raw-handler adopters mid-migration; v6 adopters using `createAdcpServerFromPlatform` never touch them. IDE strikethrough + LLM scaffolding signal. Same lightweight intervention as `createAdcpServer` itself.

**`IdempotencyPrincipalParams` typed (TA1).** Replaces `params: Record<string, unknown>` with a typed shape that surfaces `account?: AccountReference` and `brand?: BrandReference` — the most-common scoping fields. Adopters scoping by `params.account?.account_id` or `params.brand?.domain` get autocomplete + type narrowing without `as { account?: ... }`. Tool-specific scoping retains the open `Record<string, unknown>` index signature for everything else.

**Construction-time warn for principal fallback (multi-tenant safety).** When `opts.resolveIdempotencyPrincipal` is not explicitly wired, the default falls through `authInfo.clientId → sessionKey → account.id → undefined`. The `account.id` fallback collapses unauthenticated buyers into one shared idempotency namespace per account — fine for single-tenant deployments where every buyer authenticates, dangerous for multi-tenant hosts serving unauthenticated traffic over a shared `account_id`. Framework now warns at construction (NODE_ENV-allowlist gated, ack via `ADCP_DECISIONING_ALLOW_ACCOUNT_ID_PRINCIPAL=1`). Same shape as the unsigned-emitter / private-webhook-URL footgun guards.

**Slim skill polish:**
- New "Imports cheat sheet" section: 95% of sales agents need ~10 imports. Listed at the top so LLMs scaffolding the skill see the canonical subset before encountering the 100+ namespace exports.
- New "When you need..." trigger index: HITL → `advanced/HITL.md`, multi-tenant → `advanced/MULTI-TENANT.md`, etc. 11 triggers covering the full advanced/ surface plus the Postgres ops guide.
- Auto-hydration contract documented on `createMediaBuy` example: `pkg.product` undefined means SDK store has no record, NOT authoritative "doesn't exist." Decision tree shown for own-DB vs pure-SDK adopters.
- `getMediaBuys` empty-array pattern documented: write-only adopters return `{ media_buys: [] }`. Never lie; empty array is truthful "no buys to enumerate."

221 tests passing on focused suite.
