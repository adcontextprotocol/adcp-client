---
'@adcp/sdk': minor
---

feat(errors): forward-compat overlay for AdCP 3.1 error codes + `AUTH_REQUIRED` split

Adopters using `@adcp/sdk` against forward-rolled (3.1+) sellers now get typed handling for codes the SDK pre-emptively recognizes ahead of its primary `ADCP_VERSION` pin (currently 3.0.12 GA). Two new typed-error classes ship in this release:

- **`AuthMissingError`** (code `AUTH_MISSING`) — no credentials presented. Recovery: correctable.
- **`AuthInvalidError`** (code `AUTH_INVALID`) — credentials presented but rejected. Recovery: **terminal** — auto-retry against an SSO endpoint on a revoked token is the retry-storm pattern [adcp#3730](https://github.com/adcontextprotocol/adcp/issues/3730) split the code to prevent.

Both replace the missing/revoked branches that `AUTH_REQUIRED` conflated. `AuthRequiredError` is now `@deprecated` but retained for sellers still emitting the unsplit code during the 3.x deprecation window — `AUTH_REQUIRED` continues to escalate as `auth` in the default `BuyerRetryPolicy`.

## What changes in `BuyerRetryPolicy`

The default per-code policy table gains two entries:

- `AUTH_MISSING` → `escalate(auth)` — the agent typically can't re-handshake without an operator-supplied refresh path. Adopters with a refresh-token resolver wire `AUTH_MISSING` to `mutate-and-retry` via the override hook.
- `AUTH_INVALID` → `escalate(terminal)` — credentials were rejected; do NOT auto-retry. Adopters with an OAuth 2.1 refresh grant can override to a one-shot refresh-and-retry per the spec exception.

## What changes server-side

The mid-request token refresh hook in `from-platform.ts` (`runWithTokenRefresh`) now triggers on `AUTH_MISSING` in addition to `AUTH_REQUIRED`. It deliberately does **not** trigger on `AUTH_INVALID` — refreshing a credential the seller just rejected is the exact SSO retry-storm pattern this split exists to prevent.

The legacy `AdcpError('AUTH_REQUIRED', …)` emission sites inside the SDK (e.g. `derived-account-store.ts`) are unchanged for backward compatibility with 3.0-pinned consumers; they migrate to `AUTH_MISSING` when the primary `ADCP_VERSION` pin advances.

## Architecture: the forward-compat overlay

The `error.code` field is wire-typed as open `string` by the AdCP spec; the canonical `enums/error-code.json` is documentary. Receivers MUST handle unknown codes via the `recovery` fallback. In a dual-mode line (primary pin at 3.0.x while 3.1 ships as opt-in types under `src/lib/types/v3-1-beta/`), buyer agents receive 3.1-introduced codes from forward-rolled sellers before the SDK's primary pin moves.

`src/lib/types/forward-compat-error-codes.ts` names those codes so the SDK has a defined retry policy and typed-error class for each, regardless of which wire version the peer speaks:

- `STANDARD_ERROR_CODES` runtime table = manifest-derived ∪ overlay.
- `StandardErrorCode` union widens to include overlay codes.
- `BuyerRetryPolicy.DEFAULT_CODE_POLICY: Record<ErrorCode, …>` gets entries for the overlay so the table stays provably total.
- Drift-guard test asserts manifest ∩ overlay = ∅ — when the primary pin advances to include a code, the overlay entry is deleted in the same PR.

This is the foundation for adopting other 3.1 codes (`AGENT_SUSPENDED`, `AGENT_BLOCKED`, the new billing codes from adcp#3831) as separate follow-up PRs.

## Closes

- [adcp-client#1193](https://github.com/adcontextprotocol/adcp-client/issues/1193) — Adopt `AUTH_MISSING` / `AUTH_INVALID` once adcp#3730 lands.

## Refs

- [adcontextprotocol/adcp#3730](https://github.com/adcontextprotocol/adcp/issues/3730) — Split `AUTH_REQUIRED` into `AUTH_MISSING` (correctable) + `AUTH_INVALID` (terminal). Shipped in AdCP 3.1.0-beta.0.
