---
'@adcp/client': minor
---

Storyboard cross-step invariants are now default-on. Bundled assertions (`status.monotonic`, `idempotency.conflict_no_payload_leak`, `context.no_secret_echo`, `governance.denial_blocks_mutation`) apply to every run unless a storyboard opts out — forks and new specialisms no longer ship with zero cross-step gating silently.

- `Storyboard.invariants` now accepts an object form `{ disable?: string[]; enable?: string[] }`. `disable` is the escape hatch that removes a specific default; `enable` adds a consumer-registered (non-default) assertion on top of the baseline. The legacy `invariants: [id, ...]` array form still works and is treated as additive on top of the defaults.
- **Behavior change for direct-API callers**: `resolveAssertions(['id'])` now returns `[...defaults, ...named]` instead of exactly the named ids. Callers that relied on the array-only return shape (e.g., snapshotting `resolveAssertions([...]).length`) should switch to `resolveAssertions({ enable: [...], disable: listDefaultAssertions() })` to reproduce the old semantics.
- `AssertionSpec` gained an optional `default?: boolean` flag. Consumers registering custom assertions via `registerAssertion(...)` can opt their own specs into the default-on path.
- `resolveAssertions(...)` fails fast on unknown ids in `enable` / the legacy array, and on `disable` ids that aren't registered as defaults (typo guard — a silent no-op would mask coverage gaps). Errors name the registered set and emit a `Did you mean "..."?` suggestion when one of the unknown ids is within Levenshtein distance 2 of a known id.
- Unknown top-level keys on the object form (e.g. `invariants: { disabled: [...] }` — trailing `d` typo) throw instead of silently normalising to an empty disable set.
- New export `listDefaultAssertions()` (re-exported from `@adcp/client/testing`) enumerates the default-on set for tooling / diagnostics.

`status.monotonic` failure messages now include the legal next states from the anchor status and a link to the canonical enum schema, e.g.
`media_buy mb-1: active → pending_creatives (step "create" → step "regress") is not in the lifecycle graph. Legal next states from "active": "canceled", "completed", "paused". See https://adcontextprotocol.org/schemas/latest/enums/media-buy-status.json for the canonical lifecycle.`
Terminal states render as `(none — terminal state)` so the message is unambiguous.
